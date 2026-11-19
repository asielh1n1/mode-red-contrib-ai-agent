'use strict';

const modelFactory = require('./model-factory');
const { catalog } = modelFactory;
const { DEFAULTS, parseNumber } = require('./config');
const { invalidConfig } = require('./errors');
const { instanceOf } = require('./registry');
const { readNodeRedEnv } = require('./node-env');

function modelConfigFrom(agentNode, RED, settings = {}, overrides = {}) {
  const modelId = agentNode?.modelNodeId || agentNode?.model;
  const modelNode = agentNode && RED ? RED.nodes.getNode(modelId) : null;
  if (!modelNode) {
    throw invalidConfig('The Agent node has no model configured');
  }
  const instance = instanceOf(agentNode);
  const provider = modelNode.provider || settings.aiAgentsProvider || '';
  const entry = catalog[provider];
  if (!entry) {
    throw invalidConfig(
      provider ? `Unsupported model provider "${provider}"` : 'The model configuration has no provider selected',
    );
  }
  const fromEnv = modelNode.apiKeyValueType === 'env' || modelNode.apiKeyType === 'env';
  const envName = fromEnv
    ? String(modelNode.apiKeyValue || modelNode.apiKeyEnv || '').trim()
    : '';
  const temperature =
    overrides.temperature !== undefined
      ? overrides.temperature
      : modelNode.temperature === undefined || modelNode.temperature === ''
        ? DEFAULTS.temperature
        : parseNumber(modelNode.temperature, undefined, { min: 0, max: 2, label: 'Model temperature' });
  const maxTokens =
    overrides.maxTokens !== undefined
      ? overrides.maxTokens
      : modelNode.maxTokens === undefined || modelNode.maxTokens === ''
        ? DEFAULTS.maxTokens
        : parseNumber(modelNode.maxTokens, undefined, { min: 1, max: 131072, integer: true, label: 'Max tokens' });
  return {
    provider,
    entry,
    fromEnv,
    apiKeyEnv: envName,
    apiKey: fromEnv ? readNodeRedEnv(modelNode, envName) : modelNode.credentials?.apiKey || modelNode.apiKey || '',
    model: String(modelNode.model || '').trim(),
    baseUrl: String(modelNode.baseUrl || '').trim() || entry.defaults.baseUrl,
    temperature,
    maxTokens,
    timeout: Number(modelNode.timeout) > 0 ? Number(modelNode.timeout) : DEFAULTS.timeout,
    reasoningEffort: String(modelNode.reasoningEffort || '').trim(),
  };
}

// No model list is shipped any more, so the capability is assumed and a model that cannot call
// tools simply answers with the provider error instead of a guessed restriction.
function supportsToolCalling() {
  return true;
}

function createAgentModel(agentNode, RED, settings, overrides) {
  const config = modelConfigFrom(agentNode, RED, settings, overrides);
  if (!config.apiKey) {
    throw invalidConfig(
      config.fromEnv
        ? `${config.entry.label} API key is missing: set the Node-RED environment variable ${config.apiKeyEnv || '(name not set)'} or store a key in the model configuration`
        : `${config.entry.label} API key is not configured`,
    );
  }
  const model = modelFactory.createModel({
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    timeout: config.timeout,
    reasoningEffort: config.reasoningEffort,
  });
  return {
    model,
    modelName: config.model,
    provider: config.provider,
    entry: config.entry,
    baseUrl: config.baseUrl,
    supportsToolCalling: supportsToolCalling(config),
  };
}

module.exports = { modelConfigFrom, createAgentModel };



