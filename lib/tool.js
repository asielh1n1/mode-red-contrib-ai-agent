'use strict';

const { registry, bindInstance, TOOL_RESULT_TYPE } = require('./registry');
const { parseToolParameters } = require('./config');

// Status badges are feedback, not state: they are shown for a moment and then completely
// removed, so a finished node does not keep a label that would only add noise to the flow.
const STATUS_HOLD_MS = 1500;

// Tools waiting for an agent call, keyed by the call object. A tool flow can end in two ways:
// the message comes back into the Tool, or it reaches a Tool Return node, which resolves the
// call and sends nothing here. This registry lets the Tool Return clear the Tool badge too.
const waitingCalls = new Map();

function notifyToolReturn(call) {
  const tool = waitingCalls.get(call);
  if (tool) {
    waitingCalls.delete(call);
    tool.markReturned();
  }
}

function readProperty(msg, property) {
  const path = String(property || 'payload').trim();
  if (!path) {
    return undefined;
  }
  if (path === 'payload') {
    return msg.payload;
  }
  return path.split('.').reduce((current, part) => (current == null ? undefined : current[part]), msg);
}

// Names are compared case-insensitively because some providers rewrite tool names.
function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

module.exports = function registerTool(RED) {
  function ToolNode(config) {
    RED.nodes.createNode(this, config);
    bindInstance(this, RED);
    const node = this;

    node.name = String(config.name || '').trim();
    node.description = String(config.description || '').trim();
    try {
      node.parameters = parseToolParameters(config.parameters).schema;
    } catch (error) {
      node.parameters = { type: 'object', properties: {} };
      node.warn(error.message);
    }

    if (!node.name) {
      node.warn('Tool has no name: the Agent cannot expose it to the model');
    } else if (!registry.nameIsValid(node.name)) {
      node.warn(`Tool name "${node.name}" should use snake_case: letters, digits and underscores, starting with a letter`);
    }
    if (!node.description) {
      node.warn('Tool has no description: the model will not know when to use it');
    }
    registry.register(node);

    let statusTimer = null;
    let pendingCall = null;

    function setStatus(fill, shape, text) {
      node.status({ fill, shape, text });
    }

    function idleStatus() {
      // Clearing the status removes the badge entirely; there is no permanent label.
      node.status({});
    }

    idleStatus();

    // A new badge replaces the previous one and restarts the hold window, so a call during the
    // window is not cleared early by the timer of the previous status.
    function flashStatus(fill, shape, text) {
      if (statusTimer) {
        clearTimeout(statusTimer);
      }
      setStatus(fill, shape, text);
      statusTimer = setTimeout(() => {
        statusTimer = null;
        idleStatus();
      }, STATUS_HOLD_MS);
    }

    // Node-RED calls the 'input' listener with its own send function, but a test or an embedder
    // may replace node.send afterwards, so the current function is read when a message is sent.
    function forward(msg) {
      node.send(msg);
    }

    function complete() {
      pendingCall = null;
      flashStatus('green', 'dot', 'returned');
    }

    // Called by a Tool Return node that resolved this call: the flow ended there, so the badge
    // must reflect the same thing it would if the message had come back into the Tool.
    node.markReturned = complete;

    function finishCall(msg) {
      const call = pendingCall;
      pendingCall = null;
      if (call) {
        waitingCalls.delete(call);
      }
      const engine = node._engineRef;
      node._engineRef = null;
      const result = readProperty(msg, 'payload');
      if (engine) {
        // With a Tool Return this is a no-op: that node already answered the agent.
        engine.resolveById(node.id, result === undefined ? null : result);
      }
      flashStatus('green', 'dot', 'returned');
    }

    // Node-RED only calls the first registered 'input' listener, so the start of a call and the
    // end of the tool flow are both handled here:
    //   - a call for this Tool starts its flow;
    //   - a call for another Tool is ignored (every Tool receives the same message);
    //   - a call that arrives while one is pending is ignored too, which is what used to leave
    //     the badge on "running" and log a warning on every run;
    //   - a message without a call is the result coming back from the tool flow.
    node.on('input', function onInput(msg, send, done) {
      const call = msg && msg[TOOL_RESULT_TYPE];
      if (!call) {
        if (pendingCall) {
          finishCall(msg);
        } else {
          // Running the flow by hand is how a Tool is tried out while designing.
          flashStatus('green', 'dot', 'test run');
          forward(msg);
        }
        if (typeof done === 'function') {
          done();
        }
        return;
      }
      if (normalizeName(call.name) !== normalizeName(node.name) || pendingCall) {
        if (typeof done === 'function') {
          done();
        }
        return;
      }
      node._engineRef = call.redEngine;
      node._callName = call.name;
      pendingCall = call;
      waitingCalls.set(call, node);
      flashStatus('blue', 'dot', 'running');
      forward(msg);
      if (typeof done === 'function') {
        done();
      }
    });

    node.on('close', function onClose(removed, done) {
      if (pendingCall) {
        waitingCalls.delete(pendingCall);
      }
      pendingCall = null;
      node._engineRef = null;
      if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }
      idleStatus();
      if (removed) {
        registry.unregister(node.id);
      }
      done();
    });
  }

  RED.nodes.registerType('ai-tool', ToolNode);

  RED.httpAdmin.get('/ai-agents/tools', RED.auth.needsPermission('flows.read'), (req, res) => {
    const agentNode = req.query.node ? RED.nodes.getNode(req.query.node) : null;
    res.json({ tools: registry.listForAgent(agentNode) });
  });
};

module.exports.notifyToolReturn = notifyToolReturn;
