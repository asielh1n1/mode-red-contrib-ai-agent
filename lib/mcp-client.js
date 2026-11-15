'use strict';

const { MCPAdapter } = require('@langchain/mcp-adapters');
const { evaluateTyped } = require('./typed-value');
const { readNodeRedEnv } = require('./node-env');

const DEFAULT_TIMEOUT = 60000;

// One connection per config node: the adapter keeps the MCP session open while the flow runs,
// so tool calls do not pay for a handshake every time.
const adapters = new WeakMap();

// `$VAR` keeps tokens out of the flow file: the value is read from Node-RED's own environment
// (`env` in settings.js, or a flow/group/global variable), never from the server's process.env.
function parseHeaders(input, lookup = () => undefined) {
  if (!input) {
    return undefined;
  }
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      throw new Error('Headers must be a JSON object, for example {"Authorization":"Bearer ..."}');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Headers must be a JSON object');
  }
  const headers = {};
  for (const [key, entry] of Object.entries(value)) {
    const text = String(entry).replace(/\$(\w+)/g, (match, name) => {
      const resolved = lookup(name);
      return resolved === undefined || resolved === null || resolved === '' ? match : String(resolved);
    });
    headers[key] = text;
  }
  return Object.keys(headers).length ? headers : undefined;
}

// Remote servers use the URL, local ones a command (stdio). Both are typed values so the URL
// can come from msg, flow, global or an environment variable, like in the other nodes.
//
// The server is registered under an empty name so the adapter keeps the tool names exactly as
// the server publishes them: the node's own name is only a label.
function serverConfig(config, url, headers) {
  const transport = config.transport === 'stdio' ? 'stdio' : 'http';
  if (transport === 'stdio') {
    const command = String(config.command || '').trim();
    if (!command) {
      throw new Error('A local MCP server needs a command to run');
    }
    const args = String(config.args || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return { transport: 'stdio', command, args };
  }
  if (!url) {
    throw new Error('The MCP server URL is empty');
  }
  const entry = { transport: 'http', url };
  if (headers) {
    entry.headers = headers;
  }
  return entry;
}

async function connectAdapter(config, url, headers) {
  const adapter = new MCPAdapter({
    servers: { server: serverConfig(config, url, headers) },
    // The Agent already sees each node separately, so the tool keeps the name the server
    // publishes instead of a "server_tool" prefix.
    prefixToolNameWithServerName: false,
    onConnectionError: 'throw',
  });
  try {
    const tools = await adapter.listTools();
    return { adapter, tools };
  } catch (error) {
    await adapter.close().catch(() => {});
    throw error;
  }
}

function timeoutOf(config) {
  const value = Number(config.timeout);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT;
}

module.exports = function registerMcpClient(RED) {
  function McpClientNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.transport = config.transport === 'stdio' ? 'stdio' : 'http';
    node.url = config.url || '';
    node.urlType = config.urlType || 'str';
    node.command = config.command || '';
    node.args = config.args || '';
    node.headers = config.headers || '';
    node.tools = config.tools || '';
    node.timeout = timeoutOf(config);

    node.setStatus = function setStatus(fill, shape, text) {
      node.status(fill ? { fill, shape, text } : {});
    };

    node.setStatus('grey', 'ring', 'connecting');

    // The catalog is remembered so the editor can list it and so the tool node can expose a
    // stable list even when the server is unreachable at deploy time.
    node.catalog = [];

    function rememberCatalog(tools) {
      node.catalog = tools.map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        parameters: tool.schema || { type: 'object', properties: {} },
      }));
      return node.catalog;
    }

    node.discover = async function discover(msg) {
      const { url, headers } = await node.resolve(msg);
      const connected = await connectAdapter(node, url, headers);
      try {
        return rememberCatalog(connected.tools);
      } finally {
        await connected.adapter.close().catch(() => {});
      }
    };

    // The URL is evaluated per message, so it can come from msg/flow/global/env. Everything
    // else is static and can be prepared without a message.
    node.resolve = async function resolve(msg) {
      const url = await evaluateTyped(RED, node, node.url, node.urlType, msg);
      const headers = parseHeaders(node.headers, (name) => readNodeRedEnv(node, name));
      serverConfig(node, url, headers);
      return { url, headers };
    };

    node.getAdapter = async function getAdapter(msg) {
      const { url, headers } = await node.resolve(msg);
      const key = `${url}|${JSON.stringify(headers || {})}`;
      let cached = adapters.get(node);
      if (cached && cached.key === key) {
        return cached;
      }
      if (cached) {
        adapters.delete(node);
        await cached.adapter.close().catch(() => {});
      }
      const connected = await connectAdapter(node, url, headers);
      cached = { key, adapter: connected.adapter, tools: connected.tools };
      rememberCatalog(connected.tools);
      node.setStatus('green', 'dot', `${node.catalog.length} tool(s)`);
      adapters.set(node, cached);
      return cached;
    };

    node.close = async function close() {
      const cached = adapters.get(node);
      adapters.delete(node);
      if (cached) {
        await cached.adapter.close().catch(() => {});
      }
    };

    node.on('close', function onClose(removed, done) {
      node
        .close()
        .catch(() => {})
        .finally(() => done());
    });
  }

  RED.nodes.registerType('mcp-client', McpClientNode);

  // The editor asks for the catalog before saving, so the user can pick the tools to expose.
  RED.httpAdmin.post('/ai-agents/mcp/discover', RED.auth.needsPermission('flows.read'), async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const config = {
      name: body.name,
      transport: body.transport,
      url: body.url,
      urlType: body.urlType,
      command: body.command,
      args: body.args,
      headers: body.headers,
    };
    try {
      const url = body.urlType === 'str' ? String(body.url || '') : '';
      if (body.urlType && body.urlType !== 'str') {
        res.status(400).json({ error: 'Save and deploy the flow to discover tools from a dynamic URL' });
        return;
      }
      const headers = parseHeaders(config.headers);
      const connected = await connectAdapter(config, url, headers);
      const tools = connected.tools.map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        parameters: tool.schema || { type: 'object', properties: {} },
      }));
      await connected.adapter.close().catch(() => {});
      res.json({ ok: true, tools });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message || String(error) });
    }
  });
};

module.exports.parseHeaders = parseHeaders;
module.exports.serverConfig = serverConfig;
