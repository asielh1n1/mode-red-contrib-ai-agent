'use strict';

const DEFAULTS = Object.freeze({
  systemPrompt: '',
  temperature: 0.7,
  maxTokens: 2048,
  recursionLimit: 25,
  timeout: 120000,
  messageTimeout: 60000,
  maxToolCalls: 8,
});

const DEFAULT_TIMEOUT = 60000;

const MAX_TIMEOUT = 2147483647;

function parseJsonSchema(text, label) {
  const source = String(text || '').trim();
  if (!source) {
    return { type: 'object', properties: {} };
  }
  let schema;
  try {
    schema = JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return schema;
}

function parseNumber(value, fallback, { min, max, integer = false, label }) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${label} must be a number`);
  }
  if (integer && !Number.isInteger(number)) {
    throw new Error(`${label} must be an integer`);
  }
  if (min !== undefined && number < min) {
    throw new Error(`${label} must be at least ${min}`);
  }
  if (max !== undefined && number > max) {
    throw new Error(`${label} must be at most ${max}`);
  }
  return number;
}

function parseToolParameters(input) {
  if (input === undefined || input === null) {
    return { schema: { type: 'object', properties: {} }, hasParameters: false };
  }
  if (typeof input === 'object' && !Array.isArray(input)) {
    if (!Object.keys(input).length) {
      return { schema: { type: 'object', properties: {} }, hasParameters: false };
    }
    return { schema: input, hasParameters: true };
  }
  const text = String(input).trim();
  if (!text) {
    return { schema: { type: 'object', properties: {} }, hasParameters: false };
  }
  return { schema: parseJsonSchema(text, 'Tool parameters'), hasParameters: true };
}

function renderTemplate(template, variables) {
  return String(template || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
    const value = key.split('.').reduce((current, part) => (current == null ? undefined : current[part]), variables);
    return value === undefined || value === null ? match : String(value);
  });
}

function configFromEnv(env = process.env) {
  return {
    memoryDatabaseUrl: env.AI_AGENTS_MEMORY_DB || env.DATABASE_URL || '',
    memorySchema: 'public',
  };
}

module.exports = {
  DEFAULTS,
  DEFAULT_TIMEOUT,
  MAX_TIMEOUT,
  parseJsonSchema,
  parseNumber,
  parseToolParameters,
  renderTemplate,
  configFromEnv,
};

