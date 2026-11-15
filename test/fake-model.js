'use strict';

const { BaseChatModel } = require('@langchain/core/language_models/chat_models');
const { AIMessage, AIMessageChunk } = require('@langchain/core/messages');

// Scripted ChatDeepSeek replacement for tests. It extends BaseChatModel so LangChain's
// real agent loop, tool binding and message handling run unchanged; only the provider
// call (_generate) is replaced, so nothing touches the network.
class FakeChatDeepSeek extends BaseChatModel {
  constructor(script = []) {
    super({});
    this.providerName = 'deepseek';
    this.model = 'deepseek-chat';
    this.script = script;
    this.turn = 0;
  }

  _llmType() {
    return 'deepseek';
  }

  get [Symbol.toStringTag]() {
    return 'ChatDeepSeek';
  }

  bindTools(tools = []) {
    this.boundTools = tools;
    return this;
  }

  withConfig() {
    return this;
  }

  async _generate(messages) {
    if (!this.script.length) {
      throw new Error('FakeChatDeepSeek: no script configured');
    }
    // A single script entry may answer several turns (e.g. consecutive plain answers).
    const step = this.script[Math.min(this.turn, this.script.length - 1)];
    if (global.__FAKE_LOG) {
      global.__FAKE_LOG.push({ turn: this.turn, types: messages.map((m) => m._getType()).join(',') });
    }
    const last = messages[messages.length - 1];
    this.turn += 1;
    if (step === undefined) {
      throw new Error('FakeChatDeepSeek: the script ran out of turns');
    }
    const reply =
      typeof step === 'function' ? step(messages, last) : step;
    const message = AIMessage.isInstance(reply) ? reply : new AIMessage(reply ?? '');
    return {
      generations: [{ text: typeof message.content === 'string' ? message.content : '', message }],
    };
  }
}

function fakeModel(script) {
  return new FakeChatDeepSeek(script);
}

function toolCall(id, name, args) {
  return new AIMessage({ content: '', tool_calls: [{ id, name, args }] });
}

function toolNode(overrides = {}) {
  // The editor stores the schema as a JSON string, which is what the runtime parses. Tools
  // with no arguments get an empty object, exactly like a Tool node with no parameters.
  const parameters = overrides.parameters === undefined
    ? { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
    : overrides.parameters;
  return {
    id: 'tool-1',
    type: 'ai-tool',
    z: 'flow-1',
    name: 'get_weather',
    description: 'Gets the weather',
    ...overrides,
    parameters,
  };
}

function agentConfig(overrides = {}) {
  return {
    toolsSource: 'flow',
    tools: [],
    sessionSource: 'msg.session_id',
    systemPrompt: 'test prompt',
    recursionLimit: 10,
    maxToolCalls: 8,
    timeout: 5000,
    ...overrides,
  };
}

module.exports = { fakeModel, FakeChatDeepSeek, toolCall, toolNode, agentConfig };
void AIMessageChunk;












