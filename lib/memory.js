'use strict';

const { closeCheckpointer, checkConnection, contextWindowOf, memoryKindOf } = require('./checkpoint');
const { evaluateTyped } = require('./typed-value');

const DEFAULT_SCHEMA = 'public';

// Storage kinds that keep a connection string. The in-process one needs nothing.
const STORAGE_KINDS = ['postgres', 'redis'];

// The config value stays "ram"/"postgres"/"redis" so existing flows keep working; only the
// wording shown to the user is kept free of jargon.
function memoryLabel(node) {
  if (node.memoryKind === 'postgres') {
    return 'Postgres';
  }
  if (node.memoryKind === 'redis') {
    return 'Redis';
  }
  return 'conversation memory';
}

function statusOf(node) {
  const storage = STORAGE_KINDS.includes(node.memoryKind);
  return {
    kind: node.memoryKind,
    configured: storage ? Boolean(node.databaseUrl) : true,
    urlType: storage ? node.databaseUrlType : null,
    schema: node.memoryKind === 'postgres' ? node.memorySchema : null,
    contextWindow: contextWindowOf(node),
  };
}

module.exports = function registerMemory(RED) {
  function MemoryNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.memoryKind = memoryKindOf(config);
    node.memorySchema = String(config.memorySchema || '').trim() || DEFAULT_SCHEMA;
    node.databaseUrl = config.databaseUrl || '';
    node.databaseUrlType = config.databaseUrlType || 'str';
    node.databasePassword = node.credentials?.databasePassword || '';
    node.contextWindow = config.contextWindow;

    node.status({
      fill: STORAGE_KINDS.includes(node.memoryKind) ? 'blue' : 'grey',
      shape: 'dot',
      text: memoryLabel(node),
    });

    node.on('close', function onClose(removed, done) {
      if (!removed) {
        // A redeploy only stops and recreates the nodes: the in-process conversations are
        // kept for the next instance (see checkpoint.js), so nothing is released here.
        done();
        return;
      }
      closeCheckpointer(node)
        .catch(() => {})
        .finally(() => done());
    });
  }

  RED.nodes.registerType('ai-agent-memory', MemoryNode, {
    credentials: {
      databasePassword: { type: 'password' },
    },
  });

  RED.httpAdmin.get('/ai-agents/memory/status/:id', RED.auth.needsPermission('flows.read'), (req, res) => {
    const memoryNode = RED.nodes.getNode(req.params.id);
    if (!memoryNode) {
      res.status(404).json({ error: 'Memory node not found' });
      return;
    }
    res.json(statusOf(memoryNode));
  });

  // Values typed in the dialog, before the flow is deployed. A missing node id is not an error:
  // the editor posts what is on screen so the test works with unsaved changes.
  function candidateFrom(body) {
    return {
      memoryKind: memoryKindOf(body),
      databaseUrl: body.databaseUrl,
      databaseUrlType: body.databaseUrlType,
      memorySchema: body.memorySchema,
      databasePassword: body.databasePassword || '',
    };
  }

  // Opens its own connection and closes it, so a misconfigured database or Redis shows up in
  // the editor instead of on the first user message, and the pool of the deployed node is not
  // disturbed.
  RED.httpAdmin.post('/ai-agents/memory/check/:id?', RED.auth.needsPermission('flows.read'), async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const id = req.params && req.params.id ? req.params.id : null;
    const deployed = id ? RED.nodes.getNode(id) : null;
    if (id && !deployed) {
      res.status(404).json({ error: 'Memory node not found' });
      return;
    }
    // A deployed node supplies what is not sent (like the stored password), while the dialog
    // values win, so an unsaved edit is what gets tested.
    const candidate = deployed
      ? {
          ...candidateFrom(deployed),
          memoryKind: body.memoryKind ? memoryKindOf(body) : deployed.memoryKind,
          databaseUrl: body.databaseUrl || deployed.databaseUrl,
          databaseUrlType: body.databaseUrlType || deployed.databaseUrlType,
          memorySchema: body.memorySchema || deployed.memorySchema,
          databasePassword: body.databasePassword || deployed.databasePassword || '',
        }
      : candidateFrom(body);
    if (!STORAGE_KINDS.includes(candidate.memoryKind)) {
      res.json({ ok: true, kind: candidate.memoryKind });
      return;
    }
    try {
      candidate.resolvedDatabaseUrl = await evaluateTyped(
        RED,
        candidate,
        candidate.databaseUrl,
        candidate.databaseUrlType || 'str',
        {},
      );
      if (!candidate.resolvedDatabaseUrl) {
        res.status(400).json({ ok: false, error: 'The connection URL is empty' });
        return;
      }
      await checkConnection(candidate);
      res.json({ ok: true, kind: candidate.memoryKind });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message || error.code || 'Connection failed' });
    }
  });
};
