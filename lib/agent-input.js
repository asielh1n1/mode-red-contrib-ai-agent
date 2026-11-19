'use strict';

const { DEFAULTS, parseNumber } = require('./config');
const { invalidConfig, invalidMessage } = require('./errors');
const { registry, normalizeToolName } = require('./registry');

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

// Reads the typed session id with Node-RED's own evaluator, so `msg`, `flow`, `global`,
// `env` and `str` behave like in any core node.
// Source: https://nodered.org/docs/api/ui/typedInput#runtime-handling-of-typed-values
function evaluateSessionId(RED, node, msg) {
  const type = node.sessionIdType || 'msg';
  if (type === 'str') {
    return node.sessionId === undefined || node.sessionId === null ? '' : String(node.sessionId);
  }
  if (!RED || !RED.util || typeof RED.util.evaluateNodeProperty !== 'function') {
    throw invalidConfig('This Node-RED version cannot evaluate typed properties (requires Node-RED 1.0 or later)');
  }
  if (type === 'flow' || type === 'global') {
    return new Promise((resolve, reject) => {
      try {
        RED.util.evaluateNodeProperty(node.sessionId, type, node, msg, (error, value) => {
          if (error) {
            reject(error);
          } else {
            resolve(value);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }
  return RED.util.evaluateNodeProperty(node.sessionId, type, node, msg);
}

async function sessionIdFrom(RED, node, msg) {
  const value = await evaluateSessionId(RED, node, msg);
  if (!hasValue(value)) {
    throw invalidMessage('The session id is empty: check the Session id property of the agent');
  }
  const sessionId = String(value).trim();
  if (!sessionId) {
    throw invalidMessage('The session id is empty: check the Session id property of the agent');
  }
  // PostgresSaver stores thread ids in a bounded column.
  if (sessionId.length > 255) {
    throw invalidMessage('The session id must be 255 characters or fewer');
  }
  return sessionId;
}
function payloadText(payload) {
  if (typeof payload === 'string') {
    return payload;
  }
  if (Buffer.isBuffer(payload)) {
    return payload.toString('utf8');
  }
  if (payload === undefined || payload === null) {
    return '';
  }
  if (typeof payload === 'object') {
    if (typeof payload.text === 'string') {
      return payload.text;
    }
    if (typeof payload.content === 'string') {
      return payload.content;
    }
    return JSON.stringify(payload);
  }
  return String(payload);
}

const SETTINGS = {
  recursionLimit: { fallback: DEFAULTS.recursionLimit, min: 1, max: 200, integer: true, label: 'Reasoning step limit' },
  maxToolCalls: { fallback: DEFAULTS.maxToolCalls, min: 1, max: 100, integer: true, label: 'Max tool calls' },
  messageTimeout: {
    fallback: DEFAULTS.messageTimeout,
    min: 1000,
    max: 2147483647,
    integer: true,
    label: 'Tool timeout (ms)',
  },
  timeout: { fallback: DEFAULTS.timeout, min: 1000, max: 2147483647, integer: true, label: 'Agent timeout (ms)' },
};


function agentOptions(agentNode) {
  const options = {};
  for (const [key, rule] of Object.entries(SETTINGS)) {
    const raw = agentNode[key];
    options[key] = hasValue(raw) ? parseNumber(raw, rule.fallback, rule) : rule.fallback;
  }
  return options;
}

// The Agent exposes the tools wired to its tool-call output. The wiring is the single source
// of truth. A Tool node provides one tool; an MCP client node provides one tool per exposed
// entry of its server, all backing onto the same node.
function resolveTools(agentNode) {
  const selected = registry.connectedTo(agentNode);
  const byName = new Map();
  const result = [];
  for (const entry of selected) {
    if (!entry.name || !entry.description) {
      throw invalidConfig(`Tool "${entry.name || entry.id}" needs a name and a description`);
    }
    // The model receives the technical name; the human name is only for the editor.
    const toolName = entry.toolName || normalizeToolName(entry.name);
    if (!registry.nameIsValid(toolName)) {
      throw invalidConfig(`Tool "${entry.name}" cannot be exposed: "${toolName}" is not a valid tool name`);
    }
    const key = normalizeToolName(toolName);
    if (byName.has(key)) {
      throw invalidConfig(`Tool names must be unique. "${entry.name}" is used by more than one Tool node.`);
    }
    byName.set(key, entry);
    result.push({ ...entry, toolName });
  }
  return result;
}

module.exports = { sessionIdFrom, payloadText, resolveTools, agentOptions };






