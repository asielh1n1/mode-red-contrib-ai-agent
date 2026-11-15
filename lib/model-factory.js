'use strict';

const path = require('node:path');

const MODULE_ROOT = path.join(__dirname, '..');
const catalog = require('./catalog');

// Provider-neutral entry point. Adding a provider means adding its catalog entry and
// one case here; the Agent node and the model config node keep their contracts.
// Tests may set module.exports.createModel.factory to script model turns offline.
// The default implementation is actory(require(pkg), options), which keeps the
// provider package lazily loaded.
function createModel(config) {
  if (typeof createModel.factory === 'function') {
    return createModel.factory(config);
  }
  const provider = config?.provider || '';
  const entry = catalog[provider];
  if (!entry) {
    throw new Error(provider ? `Unsupported model provider: ${provider}` : 'No model provider selected');
  }
  if (!config.apiKey) {
    throw new Error(`${entry.label} API key is not configured`);
  }
  const model = String(config.model || '').trim();
  if (!model) {
    throw new Error(`${entry.label} model name is not configured`);
  }
  const options = {
    model,
    apiKey: config.apiKey,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    timeout: config.timeout,
  };
  if (config.baseUrl) {
    options.configuration = { baseURL: config.baseUrl };
  }
  // The effort level is provider-specific; the catalog owns that mapping.
  if (config.reasoningEffort && typeof entry.effort?.apply === 'function') {
    entry.effort.apply(options, config.reasoningEffort);
  }
  // Resolved lazily so Node-RED starts, and unrelated flows keep working, even when the
  // LLM stack cannot load.
  const packagePath = require.resolve(entry.packageName, { paths: [MODULE_ROOT] });
  return new (require(packagePath)[entry.classExport])(options);
}


module.exports = { createModel, catalog };







