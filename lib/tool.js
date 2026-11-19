'use strict';

const { registry, bindInstance, toolNameFrom, TOOL_RESULT_TYPE } = require('./registry');
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
    // The model receives a technical name; the editor keeps the one the user wrote. Flows saved
    // before this field existed derive it from the name, which was already a valid identifier.
    node.toolName = toolNameFrom(String(config.toolName || config.name || '').trim(), 'tool');
    node.description = String(config.description || '').trim();
    try {
      node.parameters = parseToolParameters(config.parameters).schema;
    } catch (error) {
      node.parameters = { type: 'object', properties: {} };
      node.warn(error.message);
    }

    if (!node.name) {
      node.warn('Tool has no name: the Agent cannot expose it to the model');
    } else if (!registry.nameIsValid(node.toolName)) {
      node.warn(`Tool name "${node.name}" cannot be exposed to the model: "${node.toolName}" is not a valid name`);
    }
    if (!node.description) {
      node.warn('Tool has no description: the model will not know when to use it');
    }
    registry.register(node);

    let statusTimer = null;
    // Pending calls by call id: a parent agent and a subagent can share this Tool node.
    const pendingCalls = new Map();

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

    function complete(call) {
      if (call) {
        waitingCalls.delete(call);
      }
      flashStatus('green', 'dot', 'returned');
    }

    // Called by a Tool Return node that resolved this call: the flow ended there, so the badge
    // must reflect the same thing it would if the message had come back into the Tool.
    node.markReturned = complete;

    function finishCall(msg) {
      const result = readProperty(msg, 'payload');
      const call = msg && msg[TOOL_RESULT_TYPE];
      const callId = call && call.callId;
      // A Tool node can answer a parent call and a subagent call at the same time, so the call
      // is found by id. A flow that dropped the metadata answers its single pending call.
      let key = callId && pendingCalls.has(callId) ? callId : null;
      if (!key && pendingCalls.size === 1) {
        key = [...pendingCalls.keys()][0];
      }
      const entry = key ? pendingCalls.get(key) : null;
      if (!entry) {
        flashStatus('yellow', 'ring', 'late result');
        return;
      }
      pendingCalls.delete(key);
      waitingCalls.delete(entry.call);
      if (entry.engine.resolveById(node.id, result === undefined ? null : result, key)) {
        flashStatus('green', 'dot', 'returned');
      } else {
        flashStatus('yellow', 'ring', 'late result');
      }
    }

    // Node-RED only calls the first registered 'input' listener, so the start of a call and the
    // end of the tool flow are both handled here:
    //   - a call for this Tool starts its flow;
    //   - a call for another Tool is ignored (every Tool receives the same message);
    //   - a message without a call is the result coming back from the tool flow.
    // Several calls may be pending at once, because a subagent and its parent can both use it.
    node.on('input', function onInput(msg, send, done) {
      const call = msg && msg[TOOL_RESULT_TYPE];
      if (!call) {
        if (pendingCalls.size) {
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
      const callName = call.toolName || call.name;
      if (normalizeName(callName) !== normalizeName(node.toolName)) {
        if (typeof done === 'function') {
          done();
        }
        return;
      }
      // The same Tool node can serve a parent call and a subagent call at the same time: each
      // one is kept under its own id and answered through the engine that started it.
      const key = call.callId || `${node.id}#local-${(node._callSeq = (node._callSeq || 0) + 1)}`;
      pendingCalls.set(key, { call, engine: call.redEngine });
      node._callName = call.name;
      waitingCalls.set(call, node);
      flashStatus('blue', 'dot', 'running');
      forward(msg);
      if (typeof done === 'function') {
        done();
      }
    });

    node.on('close', function onClose(removed, done) {
      for (const entry of pendingCalls.values()) {
        waitingCalls.delete(entry.call);
      }
      pendingCalls.clear();
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
