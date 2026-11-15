'use strict';

// Reads a variable from Node-RED's own environment: `env` in settings.js, plus flow, group and
// global variables. This is what a typedInput of type `env` resolves to in a core node and what
// `RED.util.evaluateEnvProperty` looks up. The server's process.env is not consulted on purpose:
// the nodes offer Node-RED environment variables, not deployment secrets.
// Source: https://nodered.org/docs/user-guide/environment-variables
function readNodeRedEnv(node, name) {
  const variable = String(name || '').trim();
  if (!variable) {
    return '';
  }
  let value;
  if (node && node._flow && typeof node._flow.getSetting === 'function') {
    // Covers group settings, flow settings and the global/settings.js environment.
    value = node._flow.getSetting(variable);
  } else {
    const util = node && node._RED && node._RED.util;
    if (util && typeof util.getSetting === 'function') {
      value = util.getSetting(node, variable);
    } else {
      const context = node && typeof node.context === 'function' ? node.context() : null;
      const envApi = context && context.flow && context.flow.env;
      value = envApi && typeof envApi.get === 'function' ? envApi.get(variable) : undefined;
    }
  }
  return value === undefined || value === null ? '' : String(value);
}

module.exports = { readNodeRedEnv };
