'use strict';

const { createAgent, tool, contextEditingMiddleware } = require('langchain');
const { AIMessage, HumanMessage } = require('@langchain/core/messages');
const { jsonSchemaToZod } = require('./schema');
const { TOOL_RESULT_TYPE, toPosixPath } = require('./registry');

// Keeps a conversation inside a fixed number of messages per session.
//
// LangGraph checkpoints every message of a thread, so the history grows without limit. LangChain
// 1.x exposes context editing middleware, which prunes the message list the model receives (the
// checkpoint on disk is untouched) through `ContextEdit` strategies.
//
// The cut must leave a conversation the provider accepts, so it works on whole turns instead of
// individual messages. A turn is everything from a human message up to the next human message:
//
//   human -> ai(tool_calls) -> tool -> ai(answer)
//
// Cutting inside that block would leave a `tool` message without the `ai` message that requested
// it, and every provider rejects that with
// "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'".
class WindowEdit {
  constructor(window) {
    this.window = Math.max(1, Math.floor(window));
  }

  apply({ messages }) {
    const length = messages.length;
    if (length <= this.window) {
      dropOrphanToolMessages(messages);
      return;
    }
    // Turns are [start, end) slices: a turn starts at a human message and ends where the next one
    // starts. A leading block without a human message (a thread that begins mid-tool-step) is its
    // own turn, so it is dropped as a whole instead of splitting it.
    const turns = [];
    let start = 0;
    for (let index = 1; index < length; index += 1) {
      if (HumanMessage.isInstance(messages[index])) {
        turns.push([start, index]);
        start = index;
      }
    }
    turns.push([start, length]);

    // Keep the newest turns that fit. A single message is worth much less than a complete
    // exchange, so the newest turn is always kept whole even when it is longer than the window:
    // a partial turn is exactly what the provider rejects.
    let kept = 0;
    let firstKept = turns.length - 1;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const [from, to] = turns[index];
      const size = to - from;
      if (kept > 0 && kept + size > this.window) {
        break;
      }
      kept += size;
      firstKept = index;
      if (kept >= this.window) {
        break;
      }
    }

    const keepFrom = turns[firstKept][0];
    messages.splice(0, keepFrom);
    dropOrphanToolMessages(messages);
  }
}

// A `tool` message is only valid right after the `ai` message that requested it. This drops any
// that lost their request (a thread saved by an older version, for example), so the provider never
// receives a conversation it rejects.
function dropOrphanToolMessages(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message._getType() !== 'tool') {
      continue;
    }
    const owner = precedingToolCall(messages, index, message.tool_call_id);
    if (!owner) {
      messages.splice(index, 1);
    }
  }
}

function precedingToolCall(messages, index, toolCallId) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = messages[cursor];
    if (candidate._getType() === 'human') {
      return false;
    }
    if (candidate._getType() !== 'ai') {
      continue;
    }
    const calls = candidate.tool_calls || [];
    if (calls.some((call) => (toolCallId ? call.id === toolCallId : true))) {
      return true;
    }
  }
  return false;
}

function contextWindowMiddleware(window) {
  const limit = Number(window);
  if (!Number.isFinite(limit) || limit <= 0) {
    return null;
  }
  // The middleware runs the strategy on every model call, so the window applies to whatever the
  // checkpointer restored and the size stored per session stays bounded.
  return contextEditingMiddleware({ edits: [new WindowEdit(limit)], tokenCountMethod: 'approx' });
}

class ToolCallTimeoutError extends Error {
  constructor(name, timeout) {
    super(`Tool "${name}" did not return a result within ${timeout} ms`);
    this.name = 'ToolCallTimeoutError';
  }
}

function textFromContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  return content == null ? '' : String(content);
}

function lastAssistantText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!AIMessage.isInstance(message) || message.tool_calls?.length) {
      continue;
    }
    const text = textFromContent(message.content);
    if (text.trim()) {
      return text;
    }
  }
  return '';
}

// Tool call messages start from the agent's input message (so custom properties and the
// working path flow through), but never carry its payload: that is the user's text.
function toolTemplate(inputMessage) {
  const { _user, _msgid, payload, ...rest } = inputMessage || {};
  void _user;
  void _msgid;
  void payload;
  return { ...rest, path: rest.path || toPosixPath(process.cwd()) };
}

// Bridges LangChain tool calls to Node-RED wires and back: each call is pending under
// its Tool node id until the matching Tool Return resolves it exactly once.
function createEngine({ inputMessage, send, timeoutMs, maxToolCalls, adapters = {} }) {
  const pendingCalls = new Map();
  const controllers = new Set();
  const createAgentFn = adapters.createAgent || ((options) => createAgent(options));
  let toolCallCount = 0;
  let closed = false;

  function settle(callId, fn) {
    const call = pendingCalls.get(callId);
    if (!call) {
      return false;
    }
    pendingCalls.delete(callId);
    fn(call);
    return true;
  }

  function runTool(toolNode, input) {
    if (closed) {
      return Promise.reject(new Error(`Tool "${toolNode.name}" is no longer available`));
    }
    if (toolCallCount >= maxToolCalls) {
      return Promise.reject(new Error(`Tool call limit (${maxToolCalls}) reached`));
    }
    toolCallCount += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        settle(toolNode.id, (call) => call.reject(new ToolCallTimeoutError(toolNode.name, timeoutMs)));
      }, timeoutMs);
      pendingCalls.set(toolNode.id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        send({
          ...toolTemplate(inputMessage),
          payload: input,
          [TOOL_RESULT_TYPE]: {
            nodeId: toolNode.id,
            name: toolNode.name,
            args: input,
            redEngine: api,
          },
        });
      } catch (error) {
        settle(toolNode.id, (call) => call.reject(error));
      }
    });
  }

  const api = {
    // Tools wired to the Agent are executed in two ways: a Tool node runs its Node-RED flow
    // (the result comes back through the Tool Return or the Tool input), and a node that owns
    // the call itself (an MCP client) runs it in place through `owner._execute`.
    langChainTools(toolNodes) {
      return toolNodes.map((toolNode) => {
        const owner = toolNode.owner || toolNode;
        const executor = typeof owner._execute === 'function' ? owner : null;
        return tool((input) =>
          executor
            ? executor._execute(toolNode.mcpTool || toolNode.name, input)
            : runTool(toolNode, input), {
          name: toolNode.name,
          description: toolNode.description,
          schema: jsonSchemaToZod(toolNode.parameters),
        });
      });
    },
    resolveById(toolNodeId, value) {
      return settle(toolNodeId, (call) => call.resolve(value));
    },
    rejectById(toolNodeId, error) {
      return settle(toolNodeId, (call) => call.reject(error));
    },
    createAgent({ model, tools, checkpointer, systemPrompt, provider, contextWindow }) {
      const options = { model, tools };
      if (checkpointer) {
        options.checkpointer = checkpointer;
      }
      if (systemPrompt) {
        options.systemPrompt = systemPrompt;
      }
      // DeepSeek model names are not in LangChain's inference table; the provider comes
      // from the catalog, so pass it explicitly instead of relying on guessing.
      if (provider) {
        options.modelProvider = provider;
      }
      const middleware = contextWindowMiddleware(contextWindow);
      if (middleware) {
        options.middleware = [middleware];
      }
      return createAgentFn(options);
    },
    run(agent, text, { threadId, recursionLimit, timeout }) {
      const controller = new AbortController();
      controllers.add(controller);
      const invoke = agent.invoke(
        { messages: [new HumanMessage(text)] },
        { configurable: { thread_id: threadId }, recursionLimit, signal: controller.signal },
      );
      let timer;
      const timed = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          for (const callId of [...pendingCalls.keys()]) {
            settle(callId, (call) => call.reject(new Error('The agent run timed out')));
          }
          reject(new Error(`The agent did not finish within ${timeout} ms`));
        }, timeout);
        invoke.then(resolve, reject);
      });
      return timed.finally(() => {
        clearTimeout(timer);
        controllers.delete(controller);
      });
    },
    resetCallCount() {
      toolCallCount = 0;
    },
    cancel(reason) {
      for (const controller of controllers) {
        controller.abort();
      }
      controllers.clear();
      for (const callId of [...pendingCalls.keys()]) {
        settle(callId, (call) => call.reject(new Error(reason)));
      }
    },
    // Kept for callers that prefer explicit lifecycle methods over cancel().
    close() {
      this.cancel('Agent closed');
    },
    get pendingCount() {
      return pendingCalls.size;
    },
  };
  return api;
}

module.exports = { createEngine, lastAssistantText, textFromContent, ToolCallTimeoutError, WindowEdit };


























