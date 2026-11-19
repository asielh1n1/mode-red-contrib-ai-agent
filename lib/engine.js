'use strict';

const { createAgent, tool, contextEditingMiddleware } = require('langchain');
const { AIMessage, HumanMessage, ToolMessage } = require('@langchain/core/messages');
const { jsonSchemaToZod } = require('./schema');
const { TOOL_RESULT_TYPE } = require('./registry');

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

// A tool call is saved the moment the model asks for it, before the tool runs. When the run is
// aborted while a tool is still pending (agent timeout, cancel, redeploy) the checkpoint keeps
// the `ai` message with its `tool_calls` and no `tool` answer, and every provider rejects the
// next request with "An assistant message with 'tool_calls' must be followed by tool messages
// responding to each 'tool_call_id'". The two helpers below close those unfinished calls, either
// by answering them in the saved state or by writing the answers first in the conversation.

// The state only commits an `ai` message without tool calls when the run ends on a final
// answer, so the unfinished call is the last one of the thread.
function pendingToolCalls(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (!AIMessage.isInstance(message) || !message.tool_calls?.length) {
      continue;
    }
    const answered = new Set();
    for (let cursor = index + 1; cursor < list.length; cursor += 1) {
      if (ToolMessage.isInstance(list[cursor]) && list[cursor].tool_call_id) {
        answered.add(list[cursor].tool_call_id);
      }
    }
    return message.tool_calls.filter((call) => !answered.has(call.id));
  }
  return [];
}

const CANCELLED_TOOL_RESULT =
  'The tool call was cancelled before it produced a result. Do not assume it ran: ask again or continue without it.';

function cancelledToolResult(reason) {
  return reason ? `${CANCELLED_TOOL_RESULT} (${reason})` : CANCELLED_TOOL_RESULT;
}

function closeToolCalls(messages) {
  return pendingToolCalls(messages).map(
    (call) =>
      new ToolMessage({
        content: CANCELLED_TOOL_RESULT,
        tool_call_id: call.id,
        name: call.name,
        status: 'error',
      }),
  );
}

// The saved state ends on an `ai(tool_calls)`: the run stopped before its tool step saved.
function hasUncommittedToolCall(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const last = list[list.length - 1];
  return Boolean(last && AIMessage.isInstance(last) && last.tool_calls?.length);
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

// Every tool call is a copy of the message that reached the Agent, so a tool sees the custom
// properties of its output (msg.user, permissions, and so on) and the tools of the same turn
// cannot change each other's data. `payload` is the only property replaced: it carries the
// arguments the model chose.
//
// The copy is shallow on purpose: nested objects are shared with the Agent's message, so a tool
// that writes inside `msg.user` changes the original. Copying the message deeply would have to
// walk buffers, streams and cyclic references, and would break values a flow expects to keep
// by reference (a connection, for example).
function toolTemplate(inputMessage) {
  const { payload, ...rest } = inputMessage || {};
  return { ...rest };
}

// Bridges LangChain tool calls to Node-RED wires and back: each call is pending under
// its Tool node id until the matching Tool Return resolves it exactly once.

// `createAgent` names the node that runs the tool calls `tools`, and updateState attributes the
// repaired answers to it.
const TOOLS_NODE = 'tools';
function createEngine({ send, timeoutMs, maxToolCalls, messageTimeout, adapters = {} }) {
  const pendingCalls = new Map();
  const controllers = new Set();
  const createAgentFn = adapters.createAgent || ((options) => createAgent(options));
  // Message of the run in progress: each tool call copies it. A run sets it when it starts and
  // clears it when it ends, so a queued message never leaks into the tools of another run.
  let activeMessage = null;
  // Output used to send a tool call. A subagent passes its own, because its tools are wired to
  // its output and the parent output reaches different Tool nodes.
  let activeSend = send;
  // A tool flow slower than this is answered with a "cancelled" result while the model can still
  // continue: a tool step saved with a pending tool task is what the provider rejects.
  const toolDeadline =
    Number.isFinite(Number(messageTimeout)) && Number(messageTimeout) > 0 ? Number(messageTimeout) : 0;
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

  // A Tool node keeps one pending call at a time, and two agents can share it: the parent and a
  // subagent that also exposes it. Each call is stored under its own key, so one call is never
  // answered with the result of the other.
  let callSequence = 0;

  // Resolves the call identified by `callId` when the flow carries one, and otherwise the first
  // call of that Tool node: flows saved before the call id existed still work.
  function settleCall(toolNodeId, callId, fn) {
    if (callId && pendingCalls.has(callId)) {
      return settle(callId, fn);
    }
    for (const [key, call] of pendingCalls) {
      if (call.nodeId === toolNodeId) {
        return settle(key, fn);
      }
    }
    return false;
  }

  function unblockCalls(reason) {
    const result = cancelledToolResult(reason);
    for (const callId of [...pendingCalls.keys()]) {
      settle(callId, (call) => call.resolve(result));
    }
  }

  function runTool(toolNode, input) {
    if (closed) {
      return Promise.reject(new Error(`Tool "${toolNode.name}" is no longer available`));
    }
    if (toolCallCount >= maxToolCalls) {
      return Promise.reject(new Error(`Tool call limit (${maxToolCalls}) reached`));
    }
    toolCallCount += 1;
    // A node that answers in place (an MCP client, a subagent) runs the call itself.
    const executor = typeof toolNode.owner?._execute === 'function' ? toolNode.owner : null;
    if (executor) {
      return executor._execute(toolNode.toolName, input);
    }
    return new Promise((resolve, reject) => {
      const callKey = `${toolNode.id}#${++callSequence}`;
      const timer = setTimeout(() => {
        settle(callKey, (call) => call.reject(new ToolCallTimeoutError(toolNode.name, timeoutMs)));
      }, timeoutMs);
      // A flow that stops answering (an error before the Tool Return, a node wired nowhere) would
      // otherwise hold the run until its timeout, and the saved tool step would then be left
      // without an answer. Answering here lets the model continue in the same run, exactly like a
      // tool that fails on purpose.
      const deadline = toolDeadline
        ? setTimeout(() => {
            // Only the still-pending call is answered; a late Tool Return is then ignored.
            const result = cancelledToolResult(`"${toolNode.name}" did not answer in time`);
            settle(callKey, (call) => call.resolve(result));
          }, toolDeadline)
        : null;
      if (deadline && typeof deadline.unref === 'function') {
        deadline.unref();
      }
      pendingCalls.set(callKey, {
        nodeId: toolNode.id,
        resolve(value) {
          clearTimeout(timer);
          if (deadline) {
            clearTimeout(deadline);
          }
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          if (deadline) {
            clearTimeout(deadline);
          }
          reject(error);
        },
      });
      try {
        activeSend({
          ...toolTemplate(activeMessage),
          payload: input,
          [TOOL_RESULT_TYPE]: {
            nodeId: toolNode.id,
            // Two pending calls of the same Tool node never share a slot.
            callId: callKey,
            name: toolNode.name,
            toolName: toolNode.toolName || toolNode.name,
            args: input,
            redEngine: api,
          },
        });
      } catch (error) {
        settle(callKey, (call) => call.reject(error));
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
            ? executor._execute(toolNode.mcpTool || toolNode.toolName || toolNode.name, input)
            : runTool(toolNode, input), {
          name: toolNode.toolName || toolNode.name,
          description: toolNode.description,
          schema: jsonSchemaToZod(toolNode.parameters),
        });
      });
    },
    resolveById(toolNodeId, value, callId) {
      return settleCall(toolNodeId, callId, (call) => call.resolve(value));
    },
    rejectById(toolNodeId, error, callId) {
      return settleCall(toolNodeId, callId, (call) => call.reject(error));
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
    run(agent, text, { threadId, recursionLimit, timeout, inputMessage, send: runSend }) {
      const controller = new AbortController();
      controllers.add(controller);
      // The message of this run travels with the invocation, so a queued message cannot be
      // copied into the tools of the run before it.
      const previousMessage = activeMessage;
      const previousSend = activeSend;
      activeMessage = inputMessage || null;
      if (runSend) {
        activeSend = runSend;
      }
      const invoke = agent.invoke(
        { messages: [new HumanMessage(text)] },
        { configurable: { thread_id: threadId }, recursionLimit, signal: controller.signal },
      );
      let timer;
      const timed = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          // Closing the calls comes first: the abort discards the tool tasks, and a call
          // answered before the signal is seen leaves a complete tool step in the history.
          unblockCalls('The agent run timed out');
          controller.abort();
          reject(new Error(`The agent did not finish within ${timeout} ms`));
        }, timeout);
        invoke.then(resolve, reject);
      });
      return timed.finally(() => {
        clearTimeout(timer);
        controllers.delete(controller);
        // A nested run (a subagent) restores the message and the output of the run it interrupted.
        activeMessage = previousMessage;
        activeSend = previousSend;
      });
    },
    // Self-healing: a thread saved before the calls were closed (an abort of an older release,
    // a crash between the checkpoint and the write) still has `ai(tool_calls)` without answers,
    // and the provider rejects it. The missing calls are answered once, in the saved state, so
    // the conversation can continue instead of failing until the session id changes.
    async repairThread(agent, threadId) {
      if (typeof agent.updateState !== 'function') {
        return [];
      }
      const config = { configurable: { thread_id: threadId } };
      let state;
      try {
        state = await agent.getState(config);
      } catch {
        // A missing thread or an unavailable storage is reported by the run itself.
        return [];
      }
      const messages = (state && state.values && state.values.messages) || [];
      const answers = closeToolCalls(messages);
      // Writing anything attributed to the tools node records a superstep that is over. When the
      // run was aborted before its tool step saved, the answer above completes it; when the step
      // was not saved at all, this empty write lets the next run start a clean superstep instead
      // of continuing the abandoned one and waiting for the tool again.
      if (!answers.length && !hasUncommittedToolCall(messages)) {
        return [];
      }
      try {
        await agent.updateState(config, { messages: answers }, TOOLS_NODE);
      } catch {
        // The conversation window also drops unfinished calls; the run reports anything worse.
        return [];
      }
      return answers;
    },
    resetCallCount() {
      toolCallCount = 0;
    },
    cancel(reason) {
      unblockCalls(reason);
      for (const controller of controllers) {
        controller.abort();
      }
      controllers.clear();
    },
    // Kept for callers that prefer explicit lifecycle methods over cancel().
    close() {
      this.cancel('Agent closed');
    },
    get pendingCount() {
      return pendingCalls.size;
    },
    pendingCallIds() {
      return [...pendingCalls.keys()];
    },
  };
  return api;
}

module.exports = {
  createEngine,
  lastAssistantText,
  textFromContent,
  ToolCallTimeoutError,
  WindowEdit,
  pendingToolCalls,
  closeToolCalls,
};


























