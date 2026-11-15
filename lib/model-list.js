'use strict';

const catalog = require('./catalog');

// Asks each provider for the models it currently offers, so the node does not ship a list that
// goes stale. Every call is a plain HTTP request with the user's own key: no extra dependency
// and the same endpoint the provider documents.

const TIMEOUT = 15000;

async function request(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!response.ok) {
      const message = body?.error?.message || body?.error || body?.message || `HTTP ${response.status}`;
      throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
    }
    return body;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('The provider did not answer in time');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}${path}`;
}

// OpenAI-style (`{data:[{id}]}`). OpenRouter and DeepSeek use the same shape; OpenRouter also
// includes the modality, which is worth showing so a text model is easy to spot.
function openAiList(body) {
  const list = Array.isArray(body?.data) ? body.data : [];
  return list
    .map((entry) => (entry && entry.id ? String(entry.id) : null))
    .filter(Boolean);
}

// Anthropic (`{data:[{id,display_name}]}`).
function anthropicList(body) {
  const list = Array.isArray(body?.data) ? body.data : [];
  return list.map((entry) => (entry && entry.id ? String(entry.id) : null)).filter(Boolean);
}

// Gemini (`{models:[{name:"models/x", supportedGenerationMethods:[...]}]}`).
function googleList(body) {
  const list = Array.isArray(body?.models) ? body.models : [];
  return list
    .filter((entry) => {
      if (!entry || !entry.name) {
        return false;
      }
      const methods = entry.supportedGenerationMethods;
      return !Array.isArray(methods) || methods.includes('generateContent');
    })
    .map((entry) => String(entry.name).replace(/^models\//, ''))
    .filter(Boolean);
}

const PARSERS = { openai: openAiList, anthropic: anthropicList, google: googleList };

// Calls the listing endpoint of a provider and returns the model names, sorted.
async function listModels({ provider, baseUrl, apiKey }) {
  const entry = catalog[provider];
  if (!entry) {
    throw new Error(`Unsupported model provider "${provider}"`);
  }
  if (!entry.models) {
    throw new Error(`${entry.label} does not publish a model catalog`);
  }
  if (!apiKey) {
    throw new Error(`${entry.label} API key is missing, so the catalog cannot be listed`);
  }
  const url = joinUrl(baseUrl || entry.defaults.baseUrl, entry.models.path);
  const headers = { accept: 'application/json' };
  if (entry.models.kind === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (entry.models.kind === 'google') {
    headers['x-goog-api-key'] = apiKey;
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const body = await request(url, headers);
  const parse = PARSERS[entry.models.kind] || openAiList;
  return [...new Set(parse(body))].sort((a, b) => a.localeCompare(b));
}

module.exports = { listModels };
