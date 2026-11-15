'use strict';

const { catalog } = require('./model-factory');
const { listModels } = require('./model-list');
const { DEFAULT_TIMEOUT } = require('./config');
const { readNodeRedEnv } = require('./node-env');

// Reads a variable from Node-RED's own environment (settings, flow, global, group), never from
// the server's process.env.
function readEnv(node, name) {
  return readNodeRedEnv(node, name);
}

function validate(modelNode) {
  if (!modelNode || typeof modelNode !== 'object') {
    throw new Error('Model configuration is required');
  }
  const model = String(modelNode.model || '').trim();
  if (!model) {
    throw new Error('Model name is required');
  }
  const baseUrl = String(modelNode.baseUrl || '').trim();
  if (baseUrl) {
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error('Base URL must be a valid URL');
    }
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      throw new Error('Base URL must use http or https');
    }
  }
}

module.exports = function registerModel(RED) {
  function ModelNode(config) {
    RED.nodes.createNode(this, config);
    const providerId = catalog[config.provider] ? config.provider : '';
    const entry = catalog[providerId];
    this.provider = providerId;
    this.model = String(config.model || '').trim();
    this.baseUrl = String(config.baseUrl || '').trim() || (entry ? entry.defaults.baseUrl : '');
    // The key is a typed value: `str` types a literal stored as a credential, `env` names a
    // variable in Node-RED's environment.
    this.apiKeyValue = String(config.apiKeyValue ?? '').trim();
    this.apiKeyValueType = config.apiKeyValueType === 'env' ? 'env' : 'str';
    // Earlier versions split the key into a source selector and an environment variable name;
    // read those only when the newer field is absent so old flows keep their credential.
    if (config.apiKeyValueType === undefined && config.apiKeyType === 'env') {
      this.apiKeyValueType = 'env';
      this.apiKeyValue = String(config.apiKeyEnv || '').trim();
    }
    this.apiKeyEnv = this.apiKeyValueType === 'env' ? this.apiKeyValue : '';
    this.reasoningEffort =
      String(config.reasoningEffort || '').trim() || (entry?.effort ? entry.effort.levels[0] : 'auto');
    this.temperature = config.temperature;
    this.maxTokens = config.maxTokens;
    this.timeout = Number(config.timeout) > 0 ? Number(config.timeout) : DEFAULT_TIMEOUT;
    this.label = this.model;

    try {
      validate(this);
    } catch (error) {
      this.warn(error.message);
    }
  }

  RED.nodes.registerType('ai-agent-model', ModelNode, {
    credentials: {
      apiKey: { type: 'password' },
    },
  });

  // The literal key stored for a node, or '' when the key comes from the environment or has not
  // been entered yet.
  function storedKey(modelNode) {
    const node = modelNode || {};
    const literal = node.credentials?.apiKey || node.apiKey || '';
    if (literal) {
      return String(literal);
    }
    return '';
  }

  // Resolves the key the same way the agent does, so the editor can report what would happen.
  function keyInfo(modelNode) {
    const providerId = catalog[modelNode.provider] ? modelNode.provider : '';
    const type = modelNode.apiKeyValueType === 'env' || modelNode.apiKeyType === 'env' ? 'env' : 'str';
    const name =
      type === 'env'
        ? String(modelNode.apiKeyValue || modelNode.apiKeyEnv || '').trim()
        : '';
    if (type === 'env') {
      return {
        provider: providerId,
        apiKeyType: type,
        apiKeyEnv: name,
        configured: Boolean(readEnv(envNodeFor(modelNode.id, modelNode), name)),
      };
    }
    return { provider: providerId, apiKeyType: type, apiKeyEnv: name, configured: Boolean(storedKey(modelNode)) };
  }

  // The editor sends the typed value; if nothing is typed, the stored credential is used, so a
  // dialog that was reopened without touching the key still lists models and validates.
  function apiKeyFrom(body) {
    return keyFromBody(body, { z: body.flowId });
  }

  // Whether the key of the values typed in the dialog is available: a literal from the field, a
  // stored credential when the field is empty, or a Node-RED environment variable.
  function modelKeyConfigured(body, draft) {
    return Boolean(keyFromBody(body, draft));
  }

  function keyFromBody(body, draft) {
    if (body.apiKeyType === 'env') {
      return envValueFor(body.id, draft, body.apiKeyEnv, body.flowEnv);
    }
    if (body.apiKey) {
      return String(body.apiKey).trim();
    }
    const modelNode = body.id ? RED.nodes.getNode(body.id) : null;
    return modelNode ? storedKey(modelNode) : '';
  }

  // Resolves an environment variable exactly as a typed value of type `env` does: Node-RED looks
  // it up in the environment that belongs to the node being evaluated (settings.js `env`, plus
  // flow, group and global variables). For a node that is not deployed yet, the dialog sends the
  // variables of its flow tab, so the value shown matches what the node will use once deployed.
  function envValueFor(id, config, name, tabEnv) {
    const variable = String(name || '').trim();
    if (!variable) {
      return '';
    }
    const node = envNodeFor(id, config);
    if (node && typeof RED.util.evaluateNodeProperty === 'function') {
      const value = RED.util.evaluateNodeProperty(variable, 'env', node);
      if (value !== undefined && value !== null && value !== '') {
        return String(value);
      }
    }
    const fromNode = readEnv(node, variable);
    if (fromNode) {
      return fromNode;
    }
    return valueFromFlowEnv(tabEnv, variable, node);
  }

  // Mirrors the `str` and `env` cases of a typed value against a flow tab's variable list.
  function valueFromFlowEnv(entries, variable, node) {
    if (!Array.isArray(entries)) {
      return '';
    }
    const entry = entries.find((item) => item && item.name === variable);
    if (!entry) {
      return '';
    }
    const type = entry.type || 'str';
    if (type === 'str') {
      return String(entry.value ?? '');
    }
    if (typeof RED.util.evaluateNodeProperty === 'function') {
      const value = RED.util.evaluateNodeProperty(entry.value, type, node);
      return value === undefined || value === null ? '' : String(value);
    }
    return String(entry.value ?? '');
  }

  // The node used to read a Node-RED environment variable. Config nodes carry their own `_flow`,
  // which is an empty scope, so the lookup prefers any node of the same flow tab (`z`): that node
  // holds the Flow object with the tab's variables, which is what an `env` typed value reads.
  function envNodeFor(id, config) {
    const deployed = id ? RED.nodes.getNode(id) : null;
    const z = (deployed && deployed.z) || (config && config.z);
    if (z) {
      let sameFlow = null;
      RED.nodes.eachNode((node) => {
        if (!sameFlow && node.z === z && node._flow && typeof node._flow.getSetting === 'function') {
          sameFlow = node;
        }
      });
      if (sameFlow) {
        return sameFlow;
      }
    }
    return deployed;
  }

  // Validates the settings of an existing config node without contacting the provider,
  // so a saved model can be checked from the editor.
  RED.httpAdmin.get('/ai-agents/model/status/:id', RED.auth.needsPermission('flows.read'), (req, res) => {
    const modelNode = RED.nodes.getNode(req.params.id);
    if (!modelNode) {
      res.status(404).json({ error: 'Model node not found' });
      return;
    }
    status(res, modelNode);
  });

  // Same validation for the values currently typed in the edit dialog, before the flow
  // is deployed (the node has no id yet, so it cannot be looked up by id).
  // The editor builds its provider and effort lists from this catalog, so it never drifts from
  // what the runtime can call. Model names are not included: they come from the provider API.
  RED.httpAdmin.get('/ai-agents/model/catalog', RED.auth.needsPermission('flows.read'), (req, res) => {
    const result = {};
    for (const id of catalog.PROVIDER_ORDER) {
      const entry = catalog[id];
      result[id] = {
        id,
        label: entry.label,
        defaults: entry.defaults,
        canListModels: Boolean(entry.models),
        effort: entry.effort ? { levels: entry.effort.levels } : { levels: ['auto'] },
      };
    }
    res.json(result);
  });

  // Node-RED never sends a stored password back to the editor, so the node exposes its own key
  // to the dialog that edits it. Same permission as the rest of the admin API: whoever can open
  // the flow editor can already read the flow's configuration.
  RED.httpAdmin.get('/ai-agents/model/key/:id', RED.auth.needsPermission('flows.read'), (req, res) => {
    const modelNode = RED.nodes.getNode(req.params.id);
    if (!modelNode) {
      res.status(404).json({ error: 'Model node not found' });
      return;
    }
    const info = keyInfo(modelNode);
    res.json({ key: info.apiKeyType === 'str' ? storedKey(modelNode) : '', apiKeyType: info.apiKeyType, apiKeyEnv: info.apiKeyEnv });
  });

  // Lists the models the provider currently offers, with the key typed in the dialog or the
  // one already stored on a deployed node.
  RED.httpAdmin.post('/ai-agents/model/list', RED.auth.needsPermission('flows.read'), async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const provider = catalog[body.provider] ? body.provider : '';
    if (!provider) {
      res.status(400).json({ ok: false, error: 'Pick a provider first' });
      return;
    }
    const apiKey = apiKeyFrom(body);
    try {
      const models = await listModels({ provider, baseUrl: body.baseUrl, apiKey });
      res.json({ ok: true, provider, models });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message || String(error) });
    }
  });

  // Validates values typed in the edit dialog, before the flow is deployed, so the node may not
  // exist yet: the environment is read from the flow tab the dialog belongs to.
  RED.httpAdmin.post('/ai-agents/model/validate', RED.auth.needsPermission('flows.read'), (req, res) => {
    const payload = req.body || {};
    const isEnv = payload.apiKeyType === 'env';
    const draft = {
      z: payload.flowId,
      provider: payload.provider,
      model: payload.model,
      baseUrl: payload.baseUrl,
      reasoningEffort: payload.reasoningEffort,
      apiKeyType: isEnv ? 'env' : 'str',
      apiKeyEnv: isEnv ? String(payload.apiKeyEnv || '').trim() : '',
    };
    status(res, draft, modelKeyConfigured(payload, draft));
  });

  function status(res, modelNode, configured) {
    let error;
    try {
      validate(modelNode);
    } catch (validationError) {
      error = validationError.message;
    }
    const key = keyInfo(modelNode);
    const entry = catalog[key.provider] || { label: '', effort: null };
    const apiKeyType = modelNode.apiKeyType || key.apiKeyType;
    res.json({
      // `configured` is passed when there is no deployed node to inspect the key from.
      configured: configured === undefined ? key.configured : configured,
      apiKeyType,
      apiKeyEnv: modelNode.apiKeyEnv || key.apiKeyEnv,
      provider: key.provider,
      providerLabel: entry.label,
      model: String(modelNode.model || '').trim(),
      baseUrl: String(modelNode.baseUrl || '').trim(),
      reasoningEffort: String(modelNode.reasoningEffort || '').trim(),
      reasoningLevels: entry.effort ? entry.effort.levels : [],
      error,
    });
  }
};
