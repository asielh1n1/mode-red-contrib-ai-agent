'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AIMessage } = require('@langchain/core/messages');
const { MemorySaver } = require('@langchain/langgraph');
const { createEngine, lastAssistantText, textFromContent } = require('../lib/engine');
const { fakeModel, toolCall, toolNode } = require('./fake-model');

function makeEngine({ script, onSend, timeoutMs = 2000, maxToolCalls = 8, createAgent }) {
  const sent = [];
  const engine = createEngine({
    send(message) {
      sent.push(message);
      if (onSend) {
        onSend(message, sent.length, engine);
      }
    },
    timeoutMs,
    maxToolCalls,
    adapters: createAgent ? { createAgent } : {},
  });
  const tools = engine.langChainTools([toolNode()]);
  const model = fakeModel(script);
  const agent = engine.createAgent({ model, tools, checkpointer: new MemorySaver() });
  return { engine, sent, agent, model };
}

function run(engine, agent, text = 'weather in Madrid?', threadId = 'thread-1') {
  return engine.run(agent, text, { threadId, recursionLimit: 10, timeout: 5000 });
}

test('a tool call is sent to Node-RED, resolved once, and the model continues', async () => {
  const { engine, sent, agent } = makeEngine({
    script: [toolCall('call-1', 'get_weather', { city: 'Madrid' }), (messages) => {
      const toolMessage = messages.at(-1);
      return new AIMessage(`weather: ${toolMessage.content}`);
    }],
    onSend(message, count, activeEngine) {
      setTimeout(() => {
        assert.equal(activeEngine.resolveById('tool-1', 'sunny'), true);
        assert.equal(activeEngine.resolveById('tool-1', 'duplicate'), false);
      }, 5);
      void message;
      void count;
    },
  });

  const result = await run(engine, agent);

  assert.equal(lastAssistantText(result.messages), 'weather: sunny');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].payload, { city: 'Madrid' });
  assert.equal(sent[0]['ai-agents/tool-result'].nodeId, 'tool-1');
  assert.equal(sent[0]['ai-agents/tool-result'].name, 'get_weather');
});

test('tool input is validated against the Tool JSON Schema', async () => {
  const { engine, sent, agent } = makeEngine({
    script: [toolCall('call-1', 'get_weather', { city: 42 }), 'recovered'],
    onSend(_message, _count, activeEngine) {
      setTimeout(() => activeEngine.resolveById('tool-1', 'sunny'), 5);
    },
  });

  const result = await run(engine, agent);

  assert.equal(sent.length, 0, 'invalid arguments must not reach the flow');
  assert.equal(lastAssistantText(result.messages), 'recovered');
});

test('a tool that never returns is reported as an error to the model', async () => {
  const { sent, agent, engine } = makeEngine({
    script: [toolCall('call-1', 'get_weather', { city: 'Madrid' }), (messages) => new AIMessage(`saw: ${messages.at(-1).status}`)],
    timeoutMs: 30,
  });

  const result = await run(engine, agent);

  assert.equal(sent.length, 1);
  assert.equal(lastAssistantText(result.messages), 'saw: error');
});

test('the tool call limit stops runaway reasoning', async () => {
  const { sent, agent, engine } = makeEngine({
    script: [toolCall('call-1', 'get_weather', { city: 'Madrid' }), 'after'],
    maxToolCalls: 0,
  });

  const result = await run(engine, agent);

  assert.equal(sent.length, 0);
  assert.equal(lastAssistantText(result.messages), 'after');
});

test('the agent run timeout rejects and clears pending calls', async () => {
  const { agent, engine } = makeEngine({ script: [toolCall('call-1', 'get_weather', { city: 'Madrid' })], timeoutMs: 10000 });

  await assert.rejects(
    () => engine.run(agent, 'weather', { threadId: 'thread-1', recursionLimit: 10, timeout: 40 }),
    /did not finish within 40 ms/,
  );
});

test('cancel rejects pending calls and surfaces to the caller', async () => {
  const { agent, engine } = makeEngine({ script: [toolCall('call-1', 'get_weather', { city: 'Madrid' })], timeoutMs: 10000 });
  const pending = run(engine, agent);
  await new Promise((resolve) => setTimeout(resolve, 40));
  engine.cancel('Agent closed');

  // LangChain surfaces the aborted signal as AbortError; the important part is that the
  // run settles instead of hanging on the unresolved tool call.
  await assert.rejects(
    () => Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('call still pending')), 500))]),
    (error) => error.name === 'AbortError' || /Agent closed/.test(error.message),
  );
  assert.equal(engine.resolveById('tool-1', 'late'), false);
});

test('lastAssistantText ignores tool calls and supports content blocks', () => {
  const text = textFromContent([
    { type: 'text', text: 'Hello ' },
    { type: 'text', text: 'world' },
  ]);
  assert.equal(text, 'Hello world');
  assert.equal(lastAssistantText([new AIMessage({ content: '', tool_calls: [{ id: '1', name: 'x', args: {} }] })]), '');
});
