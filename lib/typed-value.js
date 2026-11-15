'use strict';

// Nodes store typed values as a value + type pair and evaluate them with Node-RED's own
// utility, so `str`, `msg`, `flow`, `global` and `env` behave like core nodes.
// Source: https://nodered.org/docs/api/ui/typedInput#runtime-handling-of-typed-values
function evaluateTyped(RED, node, value, type, msg) {
  const kind = type || 'str';
  if (kind === 'str') {
    return value === undefined || value === null ? '' : String(value);
  }
  if (typeof RED.util.evaluateNodeProperty !== 'function') {
    return '';
  }
  if (kind === 'flow' || kind === 'global') {
    return new Promise((resolve) => {
      RED.util.evaluateNodeProperty(value, kind, node, msg, (error, result) => resolve(error ? '' : result));
    });
  }
  return RED.util.evaluateNodeProperty(value, kind, node, msg);
}

function evaluateConnectionUrl(RED, memoryNode, msg) {
  return Promise.resolve(evaluateTyped(RED, memoryNode, memoryNode.databaseUrl, memoryNode.databaseUrlType, msg));
}

module.exports = { evaluateTyped, evaluateConnectionUrl };

