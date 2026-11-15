'use strict';

const { agentOptions, payloadText, resolveTools, sessionIdFrom } = require('./agent-input');
const { createAgentModel } = require('./agent-config');
const { getCheckpointer, contextWindowOf } = require('./checkpoint');
const { createEngine, lastAssistantText } = require('./engine');
const { AiAgentsError, invalidConfig, wrapCheckpointerError } = require('./errors');
const { bindInstance, executionContext, registry, TOOL_RESULT_TYPE } = require('./registry');
const { evaluateConnectionUrl } = require('./typed-value');

// Result badges are shown for a moment and then removed, so a finished node looks clean.
const STATUS_HOLD_MS = 1500;

// `msg.system_prompt` wins when it is not blank, so a flow can build the prompt per message.
// The text saved in the dialog is the base instruction and the fallback.
function systemPromptFrom(node, msg) {
  const value = msg ? msg[node.systemPromptProperty] : undefined;
  if (value !== undefined && value !== null && String(value).trim()) {
    return String(value);
  }
  return node.systemPrompt;
}

module.exports = function registerAgent(RED) {
  // The engine lives on the Agent node as _engine; Tool nodes and the internal call
  // nodes reach it through this lookup after a redeploy too.
  function AgentNode(config) {
    RED.nodes.createNode(this, config);
    bindInstance(this, RED);
    const node = this;

    // Node-RED only copies defaults declared in the editor definition, so read plain
    // config values here. `memory` is reserved by the runtime: the memory node reference
    // is `modelMemory`.
    node.sessionId = config.sessionId === undefined ? 'session_id' : config.sessionId;
    node.sessionIdType = config.sessionIdType || 'msg';
    node.systemPrompt = String(config.systemPrompt || '');
    // A message can carry the prompt: `msg.system_prompt` wins over the dialog value, which is
    // handy for long prompts built by another node. A blank value falls back.
    node.systemPromptProperty = 'system_prompt';
    node.systemPromptType = 'msg';
    node.recursionLimit = config.recursionLimit;
    node.maxToolCalls = config.maxToolCalls;
    node.agentTimeout = config.agentTimeout;
    node.modelMemory = config.modelMemory;
    // Node-RED's runtime overrides its own reserved model field after construction, so
    // keep the configured model node id under a non-reserved name.
    node.modelNodeId = config.model;
    const options = agentOptions(config);
    const engine = createEngine({
      send: (message) => node.send([null, message]), // second output: tool calls
      timeoutMs: options.timeout,
      maxToolCalls: options.maxToolCalls,
      registry,
    });
    node._engine = engine;

    const queue = [];
    let busy = false;
    let current = null;

    // The badge is feedback while the node works; when it is done it is cleared completely,
    // because a permanent text (idle/ready) only adds noise to the flow.
    function setStatus(fill, shape, text) {
      if (!fill) {
        node.status({});
        return;
      }
      node.status({ fill, shape, text });
    }

    let statusTimer = null;

    function clearStatus() {
      if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }
      setStatus();
    }

    // Shows the result for a moment and then removes the badge.
    function flashStatus(fill, shape, text) {
      if (statusTimer) {
        clearTimeout(statusTimer);
      }
      setStatus(fill, shape, text);
      statusTimer = setTimeout(clearStatus, STATUS_HOLD_MS);
    }

    function fail(msg, error, done) {
      const wrapped =
        error instanceof AiAgentsError
          ? error
          : new AiAgentsError('AI_AGENTS_ERROR', error?.message || String(error), { cause: error });
      setStatus('red', 'ring', wrapped.code === 'AI_AGENTS_MODEL_ERROR' ? 'model error' : 'error');
      node.error(wrapped, msg);
      if (typeof done === 'function') {
        done(wrapped);
      }
    }

    async function run(msg, done) {
      const text = payloadText(msg.payload).trim();
      if (!text) {
        fail(msg, invalidConfig('The input message has no text for the agent'), done);
        return;
      }
      let modelInfo;
      let toolNodes;
      let threadId;
      try {
        threadId = await sessionIdFrom(RED, node, msg);
        modelInfo = createAgentModel(node, RED, RED.settings);
        toolNodes = resolveTools(node);
      } catch (error) {
        fail(msg, error, done);
        return;
      }
      if (!modelInfo.supportsToolCalling && toolNodes.length) {
        fail(
          msg,
          invalidConfig(
            `The model "${modelInfo.modelName}" does not support tool calling. Choose a tool-capable model or remove the tools.`,
          ),
          done,
        );
        return;
      }

      let checkpointer = null;
      let contextWindow = 0;
      const memoryNode = node.modelMemory ? RED.nodes.getNode(node.modelMemory) : null;
      if (memoryNode) {
        try {
          // The URL can come from msg/flow/global/env and is resolved per message, so
          // the memory node sees the evaluated value before its checkpointer is built.
          memoryNode.resolvedDatabaseUrl = await evaluateConnectionUrl(RED, memoryNode, msg);
          checkpointer = await getCheckpointer(memoryNode);
          contextWindow = contextWindowOf(memoryNode);
        } catch (error) {
          fail(msg, wrapCheckpointerError(error), done);
          return;
        }
      }

      msg.session_id = threadId;
      // createAgent is cheap (it only compiles the graph) and rebuilding it per message
      // avoids keeping node references alive after a redeploy.
      node._agent = engine.createAgent({
        model: modelInfo.model,
        tools: engine.langChainTools(toolNodes),
        checkpointer,
        contextWindow,
        systemPrompt: systemPromptFrom(node, msg),
        provider: modelInfo.provider,
      });

      engine.resetCallCount();
      current = { msg, agent: node._agent };
      setStatus('blue', 'dot', 'thinking');
      try {
        const result = await executionContext.run(current, () =>
          engine.run(node._agent, text, {
            threadId,
            recursionLimit: options.recursionLimit,
            timeout: options.timeout,
          }),
        );
        msg.payload = lastAssistantText(result.messages || []);
        node.send([msg, null]);
        flashStatus('green', 'dot', 'done');
        if (typeof done === 'function') {
          done();
        }
      } catch (error) {
        fail(msg, error, done);
      } finally {
        current = null;
      }
    }

    function drain() {
      if (busy) {
        return;
      }
      const next = queue.shift();
      if (!next) {
        setStatus();
        return;
      }
      busy = true;
      run(next.msg, next.done || (() => {})).finally(() => {
        busy = false;
        drain();
      });
    }

    // Output 2 carries tool calls. A Tool Return wired back here is only an
    // acknowledgement: the call is already resolved in place by the Tool Return node.
    node.on('input', function onInput(msg, send, done) {
      if (msg && msg[TOOL_RESULT_TYPE]) {
        // A tool result wired back to the Agent is only an acknowledgement.
        if (typeof done === 'function') {
          done();
        }
        return;
      }
      queue.push({ msg, done });
      drain();
    });

    node.on('close', function onClose(removed, done) {
      engine.cancel('Agent closed');
      node._agent = null;
      queue.length = 0;
      clearStatus();
      done();
    });

    // Nothing is running yet, so the node starts without a badge.
    clearStatus();
  }

  RED.nodes.registerType('ai-agent', AgentNode);
};











