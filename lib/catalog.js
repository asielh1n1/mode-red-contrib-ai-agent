'use strict';

// Provider presets. Adding a provider means adding an entry here plus its runtime package in
// package.json; the Agent node itself stays provider-neutral.
//
// No model names are listed on purpose: providers add and retire models constantly, so the
// user types the exact name (or asks the provider API for its catalog) and the error from the
// provider is the only validation. What stays here is the mechanics: package, class, endpoint
// and how a reasoning effort is expressed. Nothing here names a default provider, model or
// environment variable: the flow decides those.

// How a provider maps a generic effort level onto its own option. `apply(options, level)` adds
// the provider-specific fields to the LangChain constructor options.
const effort = {
  // OpenAI: `reasoning.effort` ("minimal" | "low" | "medium" | "high"). It replaces the older
  // `reasoningEffort` option, which LangChain marks as deprecated.
  openai: {
    levels: ['none', 'low', 'medium', 'high'],
    apply(options, level) {
      // OpenAI has no "none": the lowest setting is "minimal".
      options.reasoning = { ...(options.reasoning || {}), effort: level === 'none' ? 'minimal' : level };
    },
  },
  // Anthropic: `outputConfig.effort` ("low" | "medium" | "high" | "xhigh" | "max").
  anthropic: {
    levels: ['low', 'medium', 'high', 'max'],
    apply(options, level) {
      options.outputConfig = { ...(options.outputConfig || {}), effort: level };
    },
  },
  // Gemini: `thinkingConfig.thinkingLevel` ("low" | "medium" | "high"); 0 tokens disables it.
  google: {
    levels: ['none', 'low', 'medium', 'high'],
    apply(options, level) {
      options.thinkingConfig =
        level === 'none'
          ? { thinkingBudget: 0 }
          : { thinkingLevel: level.toUpperCase(), includeThoughts: false };
    },
  },
  // DeepSeek reasoning models think on their own: there is no effort knob to forward.
  deepseek: {
    levels: ['auto'],
    apply() {},
  },
};

const deepseek = {
  id: 'deepseek',
  label: 'DeepSeek',
  packageName: '@langchain/deepseek',
  classExport: 'ChatDeepSeek',
  effort: effort.deepseek,
  defaults: { baseUrl: 'https://api.deepseek.com' },
  // Used to list the catalog from the editor: an OpenAI-compatible endpoint.
  models: { kind: 'openai', path: '/models' },
};

const openai = {
  id: 'openai',
  label: 'OpenAI',
  packageName: '@langchain/openai',
  classExport: 'ChatOpenAI',
  effort: effort.openai,
  defaults: { baseUrl: 'https://api.openai.com/v1' },
  models: { kind: 'openai', path: '/models' },
};

const anthropic = {
  id: 'anthropic',
  label: 'Anthropic',
  packageName: '@langchain/anthropic',
  classExport: 'ChatAnthropic',
  effort: effort.anthropic,
  defaults: { baseUrl: 'https://api.anthropic.com' },
  models: { kind: 'anthropic', path: '/v1/models' },
};

const google = {
  id: 'google',
  label: 'Google Gemini',
  packageName: '@langchain/google-genai',
  classExport: 'ChatGoogleGenerativeAI',
  effort: effort.google,
  defaults: { baseUrl: 'https://generativelanguage.googleapis.com' },
  models: { kind: 'google', path: '/v1beta/models' },
};

// OpenRouter speaks the OpenAI protocol, so it reuses the OpenAI client with another endpoint.
const openrouter = {
  id: 'openrouter',
  label: 'OpenRouter',
  packageName: '@langchain/openai',
  classExport: 'ChatOpenAI',
  effort: effort.openai,
  defaults: { baseUrl: 'https://openrouter.ai/api/v1' },
  models: { kind: 'openai', path: '/models' },
};

module.exports = { deepseek, openai, anthropic, google, openrouter };

// Providers in the order the editor lists them; the first one is preselected for a brand-new
// model node. None of them is special to the runtime.
const PROVIDER_ORDER = ['deepseek', 'openai', 'anthropic', 'google', 'openrouter'];

module.exports.PROVIDER_ORDER = PROVIDER_ORDER;
module.exports.defaultProvider = function defaultProvider() {
  return PROVIDER_ORDER[0];
};
