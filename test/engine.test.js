'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AIMessage } = require('@langchain/core/messages');
const { HumanMessage, ToolMessage } = require('@langchain/core/messages');
const { MemorySaver } = require('@langchain/langgraph');
const { createEngine, lastAssistantText, textFromContent, pendingToolCalls, closeToolCalls } = require('../lib/engine');
const { fakeModel, toolCall, toolNode } = require('./fake-model');

function makeEngine({
  script,
  onSend,
  timeoutMs = 2000,
  maxToolCalls = 8,
  createAgent,
  messageTimeout,
  checkpointer = new MemorySaver(),
}) {
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
    messageTimeout,
    adapters: createAgent ? { createAgent } : {},
  });
  const tools = engine.langChainTools([toolNode()]);
  const model = fakeModel(script);
  const agent = engine.createAgent({ model, tools, checkpointer });
  return { engine, sent, agent, model };
}

function run(engine, agent, text = 'weather in Madrid?', threadId = 'thread-1', inputMessage) {
  return engine.run(agent, text, { threadId, recursionLimit: 10, timeout: 5000, inputMessage });
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

test('a tool cut short by the message timeout is answered early in the conversation', async () => {
  const { sent, agent, engine } = makeEngine({
    script: [toolCall('call-1', 'get_weather', { city: 'Madrid' }), (messages) => new AIMessage(`saw: ${messages.at(-1).status}`)],
    timeoutMs: 5000,
    messageTimeout: 40,
  });

  const result = await run(engine, agent);

  // The scripted model answers again once the tool is settled: the provider never sees a tool
  // call without a result, even when the flow is slower than the configured cut.
  assert.equal(sent.length, 1);
  assert.equal(lastAssistantText(result.messages), 'saw: success');
  const toolMessage = result.messages.find((message) => message._getType() === 'tool');
  assert.match(toolMessage.content, /cancelled/);
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

test('a tool call carries the properties of the agent input message', async () => {
  const inputMessage = {
    _msgid: 'msg-1',
    _user: { id: 'u1' },
    user: { id: 'u1', role: 'admin' },
    user2: 'extra',
    payload: 'the user text',
    path: 'C:\\flows\\tool',
  };
  const { sent, agent, engine } = makeEngine({
    script: [toolCall('call-1', 'get_weather', { city: 'Madrid' }), 'done'],
    onSend(message, _count, activeEngine) {
      setTimeout(() => activeEngine.resolveById('tool-1', 'sunny'), 5);
      void message;
    },
  });

  await run(engine, agent, 'weather', 'thread-props', inputMessage);

  const call = sent[0];
  assert.deepEqual(call.payload, { city: 'Madrid' }, 'payload carries the tool arguments');
  assert.equal(call._msgid, 'msg-1', 'the original message id travels with the call');
  assert.deepEqual(call._user, { id: 'u1' });
  assert.equal(call.user2, 'extra', 'custom properties need no special handling');
  assert.equal(call.user.role, 'admin');
  assert.equal(call.path, 'C:\\flows\\tool', 'an existing path is not rewritten');
});

test('each tool call is its own copy of the message', async () => {
  const inputMessage = { user: 'root', payload: 'text' };
  const { sent, agent, engine } = makeEngine({
    script: [toolCall('call-1', 'get_weather', { city: 'Madrid' }), 'done'],
    onSend(message, _count, activeEngine) {
      setTimeout(() => activeEngine.resolveById('tool-1', 'sunny'), 5);
      void message;
    },
  });

  await run(engine, agent, 'weather', 'thread-copy', inputMessage);

  assert.notEqual(sent[0], inputMessage, 'the tool gets a new object, not the agent message');
  assert.equal(sent[0].user, 'root');
  assert.equal(inputMessage.payload, 'text', 'the agent message keeps its own payload');
  assert.equal(inputMessage['ai-agents/tool-result'], undefined, 'the call metadata does not leak into it');
});

test('a tool that writes a property does not change the agent message', async () => {
  const inputMessage = { user: 'root' };
  const { sent, agent, engine } = makeEngine({
    script: [toolCall('call-1', 'get_weather', { city: 'Madrid' }), 'done'],
    onSend(message, _count, activeEngine) {
      // Stands in for a Tool flow that adds data to its message before answering.
      message.name = 'added by the tool';
      setTimeout(() => activeEngine.resolveById('tool-1', 'sunny'), 5);
    },
  });

  await run(engine, agent, 'weather', 'thread-write', inputMessage);

  assert.equal(sent[0].name, 'added by the tool');
  assert.equal(inputMessage.name, undefined, 'the Agent message is not modified by the tool');
});

test('lastAssistantText ignores tool calls and supports content blocks', () => {  const text = textFromContent([
    { type: 'text', text: 'Hello ' },
    { type: 'text', text: 'world' },
  ]);
  assert.equal(text, 'Hello world');
  assert.equal(lastAssistantText([new AIMessage({ content: '', tool_calls: [{ id: '1', name: 'x', args: {} }] })]), '');
});

test('unfinished tool calls are found and closed with an error result', () => {
const pending = [
  new HumanMessage('weather?'),
  new AIMessage({
    content: '',
    tool_calls: [
      { id: 'c1', name: 'get_weather', args: {} },
      { id: 'c2', name: 'get_time', args: {} },
    ],
  }),
  new ToolMessage({ content: 'sunny', tool_call_id: 'c1' }),
];

const missing = pendingToolCalls(pending);
assert.deepEqual(missing.map((call) => call.id), ['c2'], 'the answered call is not repeated');

const answers = closeToolCalls(pending);
assert.equal(answers.length, 1);
assert.equal(answers[0].tool_call_id, 'c2');
assert.equal(answers[0].status, 'error');
assert.match(answers[0].content, /cancelled/);
});

test('a complete conversation has no unfinished tool calls', () => {
const complete = [
  new HumanMessage('weather?'),
  new AIMessage({ content: '', tool_calls: [{ id: 'c1', name: 'get_weather', args: {} }] }),
  new ToolMessage({ content: 'sunny', tool_call_id: 'c1' }),
  new AIMessage('It is sunny'),
];
assert.deepEqual(pendingToolCalls(complete), []);
assert.deepEqual(closeToolCalls(complete), []);
assert.deepEqual(pendingToolCalls(undefined), []);
});