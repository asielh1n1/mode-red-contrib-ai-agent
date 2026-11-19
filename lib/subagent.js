'use strict';

const { agentOptions, payloadText, resolveTools } = require('./agent-input');
const { createAgentModel } = require('./agent-config');
const { lastAssistantText } = require('./engine');
const { AiAgentsError } = require('./errors');
const { registry, bindInstance, executionContext, toolNameFrom } = require('./registry');

const STATUS_HOLD_MS = 1500;

// A subagent is a tool of its parent agent that runs a whole agent of its own: it has its own
// model, system prompt and tools, and it answers the call in place (there is no Tool Return).
// It is registered like any other tool, so the parent only sees a name and a description.
function subagentParameters() {
  return {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The task to delegate, with every detail the subagent needs to complete it.',
      },
    },
    required: ['task'],
  };
}

function systemPromptFrom(node, msg) {
  const value = msg ? msg[node.systemPromptProperty] : undefined;
  if (value !== undefined && value !== null && String(value).trim()) {
    return String(value);
  }
  return node.systemPrompt;
}

// "fork" hands the parent's conversation to the subagent so it can continue the work; "isolated"
// only gives it the delegated task. The parent's text is the last human message of its run.
function taskFrom(node, input, msg) {
  const task = payloadText(input && input.task).trim();
  if (node.contextMode !== 'fork') {
    return task;
  }
  const parentText = payloadText(msg && msg.payload).trim();
  if (!parentText || parentText === task) {
    return task;
  }
  return `Conversation so far (context of the parent agent):\n${parentText}\n\nTask:\n${task}`;
}

// Each agent node is bound to its own module instance, so the tool needs nothing from the
// parent to find its subagent: the call carries the node that owns it (the registry entry).
module.exports = function registerSubagent(RED) {
  function SubagentNode(config) {
    RED.nodes.createNode(this, config);
    bindInstance(this, RED);
    const node = this;

    node.name = String(config.name || '').trim();
    node.toolName = toolNameFrom(String(config.toolName || config.name || '').trim(), 'subagent');
    node.description = String(config.description || '').trim();
    node.systemPrompt = String(config.systemPrompt || '');
    node.systemPromptProperty = 'system_prompt';
    node.modelNodeId = config.model;
    node.contextMode = config.contextMode === 'fork' ? 'fork' : 'isolated';
    node.recursionLimit = config.recursionLimit;
    node.maxToolCalls = config.maxToolCalls;
    node.toolTimeout = config.toolTimeout;
    node.agentTimeout = config.agentTimeout;

    const options = agentOptions(config);

    node.parameters = subagentParameters();
    if (!node.name) {
      node.warn('Subagent has no name: the parent agent cannot expose it as a tool');
    }
    if (!node.description) {
      node.warn('Subagent has no description: the parent model will not know when to delegate to it');
    }
    registry.register(node);

    let statusTimer = null;

    function setStatus(fill, shape, text) {
      node.status(fill ? { fill, shape, text } : {});
    }

    function flashStatus(fill, shape, text) {
      if (statusTimer) {
        clearTimeout(statusTimer);
      }
      setStatus(fill, shape, text);
      statusTimer = setTimeout(() => {
        statusTimer = null;
        setStatus();
      }, STATUS_HOLD_MS);
    }

    // Runs one delegated task and returns the text the parent receives as the tool result.
    //
    // The parent engine is reused on purpose: a Tool node keeps one pending call at a time, so
    // a second engine asking the same Tool node would leave one call hanging forever. The tools
    // wired to this node still answer here, because the engine resolves them by their node id.
    node._execute = async function execute(_toolName, input) {
      const parent = executionContext.getStore() || {};
      const msg = parent.msg || {};
      const engine = parent.engine;
      const task = taskFrom(node, input, msg);
      if (!task) {
        throw new Error(`Subagent "${node.name}" received an empty task`);
      }
      if (!engine) {
        throw new Error(`Subagent "${node.name}" was called outside an agent run`);
      }
      let modelInfo;
      let toolNodes;
      try {
        modelInfo = createAgentModel(node, RED, RED.settings);
        toolNodes = resolveTools(node);
      } catch (error) {
        flashStatus('red', 'ring', 'error');
        throw error;
      }
      if (!toolNodes.length) {
        node.warn('Subagent has no tools wired to its tool-calls output');
      }

      // Without a memory node every call is isolated; that is the documented default, because a
      // subagent is meant to start from the task it receives.
      const agent = engine.createAgent({
        model: modelInfo.model,
        tools: engine.langChainTools(toolNodes),
        systemPrompt: systemPromptFrom(node, msg),
        provider: modelInfo.provider,
      });      flashStatus('blue', 'dot', 'thinking');
      try {
        const result = await executionContext.run(
          { ...parent, msg, agent, subagent: node },
          () =>
            engine.run(agent, task, {
              threadId: `${msg.session_id || 'subagent'}:${node.toolName}`,
              recursionLimit: options.recursionLimit,
              timeout: options.timeout,
              inputMessage: msg,
              // The tools of the subagent are wired to its own output.
              send: (message) => node.send(message),
            }),
        );
        const answer = lastAssistantText(result.messages || []);
        flashStatus('green', 'dot', 'done');
        return answer;
      } catch (error) {
        flashStatus('red', 'ring', 'error');
        const wrapped =
          error instanceof AiAgentsError ? error : new AiAgentsError('AI_AGENTS_SUBAGENT_ERROR', error?.message || String(error), { cause: error });
        throw wrapped;
      }
    };

    node.on('input', function onInput(msg, send, done) {
      // The subagent is called by the parent agent in place; a message here means it was wired
      // by hand, which has nothing to do.
      void send;
      if (typeof done === 'function') {
        done();
      }
    });

    node.on('close', function onClose(removed, done) {
      if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }
      setStatus();
      if (removed) {
        registry.unregister(node.id);
      }
      done();
    });

    setStatus();
  }

  RED.nodes.registerType('ai-subagent', SubagentNode);
};
