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
    node.toolTimeout = config.toolTimeout;
    node.agentTimeout = config.agentTimeout;
    node.modelMemory = config.modelMemory;
    // Node-RED's runtime overrides its own reserved model field after construction, so
    // keep the configured model node id under a non-reserved name.
    node.modelNodeId = config.model;
    const options = agentOptions(config);
    const engine = createEngine({
      send: (message) => node.send([null, message]), // second output: tool calls
      timeoutMs: options.timeout,
      // Closes a tool flow that stops answering before the run timeout, so the conversation
      // never keeps a tool call without a result.
      messageTimeout: options.messageTimeout,
      maxToolCalls: options.maxToolCalls,
      registry,
    });
    node._engine = engine;

    const queue = [];
    let busy = false;
    let current = null;
    // Set by close(): the node stops listening, but a cancelled run still needs the thread it
    // interrupted repaired, and that write is only possible while the node closes.
    let closing = false;
    let closeDone = null;

    function drainClose() {
      if (!closing || !closeDone) {
        return;
      }
      const finish = closeDone;
      closeDone = null;
      finish();
    }

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
      current = { msg, agent: node._agent, engine };
      // A run that ends while a tool call is still pending (timeout or close) leaves the thread
      // mid-tool-step, and the abort discards that tool result.
      const toolCallIds = engine.pendingCallIds();
      setStatus('blue', 'dot', 'thinking');
      try {
        // A thread left mid-tool-step is repaired here, before the model sees it. Without this
        // the provider rejects the request with "An assistant message with 'tool_calls' must be
        // followed by tool messages" and the session stays unusable.
        const repaired = await engine.repairThread(node._agent, threadId);
        if (repaired.length) {
          node.warn(
            `Session "${threadId}" had ${repaired.length} tool call(s) without a result; they were closed so the conversation can continue`,
          );
        }
        const converted = await engine.repairToolResults(node._agent, threadId);
        if (converted.length) {
          node.warn(
            `Session "${threadId}" had ${converted.length} tool result(s) that were not text; they were converted so the conversation can continue`,
          );
        }
        const result = await executionContext.run(current, () =>
          engine.run(node._agent, text, {
            threadId,
            recursionLimit: options.recursionLimit,
            timeout: options.timeout,
            inputMessage: msg,
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
        // The abort discards the tool result, so the saved tool step is left without an answer.
        // Closing it here keeps the session usable (when the node is closing, drainClose waits
        // for this write). The model was not asked again: the current node object is only
        // rebuilt when a message arrives, and the test model keeps its script anyway.
        if (!(await isToolStepCommitted(node._agent, threadId, toolCallIds))) {
          await closeInterruptedSession(node._agent, threadId);
        }
        current = null;
      }
    }

    async function closeInterruptedSession(agent, threadId) {
      const repaired = await engine.repairThread(agent, threadId).catch(() => []);
      if (repaired.length) {
        node.warn(
          `Session "${threadId}" had ${repaired.length} tool call(s) without a result; they were closed so the conversation can continue`,
        );
      }
    }

    // Whether the saved state already holds a `tool` answer for the calls the run left open.
    // A run that ends before its tool step commits saved no answer, and gets one here.
    async function isToolStepCommitted(agent, threadId, callIds) {
      if (!callIds.length || !agent || typeof agent.getState !== 'function') {
        return true;
      }
      try {
        const state = await agent.getState({ configurable: { thread_id: threadId } });
        const messages = (state && state.values && state.values.messages) || [];
        return callIds.every((id) =>
          messages.some((message) => message._getType() === 'tool' && message.tool_call_id === id),
        );
      } catch {
        return true;
      }
    }


    function drain() {
      if (busy) {
        return;
      }
      const next = queue.shift();
      if (!next) {
        setStatus();
        drainClose();
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
      if (closing) {
        if (typeof done === 'function') {
          done();
        }
        return;
      }
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
      // The cancelled run repairs its thread while the node is closing, so the close waits for
      // it. With nothing running there is nothing to wait for.
      closing = true;
      if (!busy) {
        queue.length = 0;
      }
      closeDone = done;
      engine.cancel('Agent closed');
      clearStatus();
      drainClose();
    });

    // Nothing is running yet, so the node starts without a badge.
    clearStatus();
  }

  RED.nodes.registerType('ai-agent', AgentNode);
};











