'use strict';

const { TOOL_RESULT_TYPE } = require('./registry');
const { notifyToolReturn } = require('./tool');

// The status badge confirms what happened for a moment and is then removed completely.
const STATUS_HOLD_MS = 1500;

module.exports = function registerToolReturn(RED) {
  function ToolReturnNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Same idea as the Tool node: the badge is a short confirmation, not a state. Clearing it
    // removes the badge entirely, so a finished node shows nothing.
    let statusTimer = null;

    function clearStatus() {
      if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }
      node.status({});
    }

    function flashStatus(fill, shape, text) {
      if (statusTimer) {
        clearTimeout(statusTimer);
      }
      node.status({ fill, shape, text });
      statusTimer = setTimeout(clearStatus, STATUS_HOLD_MS);
    }

    node.on('input', function onInput(msg, send, done) {
      const call = msg && msg[TOOL_RESULT_TYPE];
      const engine = call && call.redEngine;
      if (!call || !engine) {
        node.warn('Tool Return received a message outside an agent tool call');
        if (typeof done === 'function') done();
        return;
      }
      // The contract of this node: the result is always msg.payload.
      const result = msg.payload;
      if (engine.resolveById(call.nodeId, result === undefined ? null : result, call.callId)) {
        // The Tool node is not on this path (the flow ends here), so tell it that its call is
        // done and let it show the same short confirmation it shows on the other wiring.
        notifyToolReturn(call);
        flashStatus('green', 'dot', 'returned');
      } else {
        // A duplicate or late message is normal while a flow is being rebuilt; the model has
        // already moved on, so this does not deserve a warning on every run.
        flashStatus('yellow', 'ring', 'late result');
      }
      if (typeof done === 'function') done();
    });

    node.on('close', function onClose(removed, done) {
      clearStatus();
      done();
    });
  }

  RED.nodes.registerType('ai-tool-return', ToolReturnNode);
};
