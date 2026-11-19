'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeModel, toolCall, toolNode, agentConfig } = require('./fake-model');
const modelFactory = require('../lib/model-factory');

// The agent builds its model through the factory; swap in the scripted model so tests
// never touch the network while exercising the real LangChain agent loop.
let scriptedModel = null;
modelFactory.createModel.factory = (config) => {
  if (!scriptedModel) {
    throw new Error('test setup: harness() must create the scripted model first');
  }
  return scriptedModel;
};

const registerAgent = require('../lib/agent');
const registerTool = require('../lib/tool');
const registerToolReturn = require('../lib/tool-return');
const registerSubagent = require('../lib/subagent');
const registerMemory = require('../lib/memory');
const registerMcpClientTool = require('../lib/mcp-client-tool');
const registerModel = require('../lib/model');
const { registry, TOOL_RESULT_TYPE } = require('../lib/registry');
const { resolveTools } = require('../lib/agent-input');
const { getCheckpointer } = require('../lib/checkpoint');

function harness({ tools = [toolNode()], memory, script = ['unused'], ...agentOverrides } = {}) {
  scriptedModel = fakeModel(script);
  const nodes = new Map();
  const flowContext = new Map();
  // Node-RED environment variables (`env` in settings.js plus flow variables), never process.env.
  const nodeRedEnv = new Map();
  const http = { get: [], post: [] };
  const RED = {
    nodes: {
      createNode(node, config) {
        Object.assign(node, config);
        const contextData = { flow: flowContext, global: new Map() };
        node.context = () => ({
          flow: { get: (key) => contextData.flow.get(key), set: (key, value) => contextData.flow.set(key, value) },
          global: { get: (key) => contextData.global.get(key), set: (key, value) => contextData.global.set(key, value) },
        });
        node._flow = {
          getSetting: (name) => nodeRedEnv.get(name),
        };
        // Status is visual feedback; the tests read the last one to check the badge lifecycle.
        node.status = (status) => {
          node.statusHistory = node.statusHistory || [];
          node.statusHistory.push(status);
        };
        node.warning = node.warn = (message) => {
          node.warnings = node.warnings || [];
          node.warnings.push(message);
        };
        node.error = () => {};
        node.debug = () => {};
        node.log = () => {};
        const handlers = {};
        node.on = (event, handler) => {
          (handlers[event] = handlers[event] || []).push(handler);
        };
        node.emit = (event, ...args) => (handlers[event] || []).forEach((handler) => handler(...args));
        node.send = (message) => {
          node.sent = node.sent || [];
          node.sent.push(message);
        };
        nodes.set(node.id, node);
      },
      getNode: (id) => nodes.get(id) || null,
      eachNode: (callback) => nodes.forEach(callback),
      registerType(type, constructor, options) {
        nodes.set(`ctor:${type}`, { constructor, options });
      },
    },
    auth: { needsPermission: () => (req, res, next) => next() },
    util: {
      // Same contract as Node-RED's evaluator; the tests only need msg/str/env/flows.
      evaluateNodeProperty(value, type, node, msg, callback) {
        let result;
        if (type === 'msg') {
          result = String(value).split('.').reduce((current, part) => (current == null ? undefined : current[part]), msg);
        } else if (type === 'flow' || type === 'global') {
          result = node.context()[type].get(value);
        } else if (type === 'env') {
          // Node-RED resolves `env` against the environment of the node being evaluated.
          const flow = node && node._flow;
          result = flow && typeof flow.getSetting === 'function' ? flow.getSetting(value) : undefined;
        } else {
          result = value;
        }
        if (typeof callback === 'function') {
          callback(null, result);
          return undefined;
        }
        return result;
      },
    },
    httpAdmin: {
      get: (route, ...rest) => http.get.push({ route, rest }),
      post: (route, ...rest) => http.post.push({ route, rest }),
    },
    settings: {},
  };
  registerAgent(RED);
  registerTool(RED);
  registerToolReturn(RED);
  registerSubagent(RED);
  registerMemory(RED);
  registerMcpClientTool(RED);
  registerModel(RED);

  const modelNode = {
    id: 'model-1',
    provider: 'deepseek',
    model: 'deepseek-chat',
    baseUrl: '',
    apiKeyValueType: 'str',
    credentials: { apiKey: 'sk-test' },
    on: () => {},
    _flow: { getSetting: (name) => nodeRedEnv.get(name) },
  };
  nodes.set('model-1', modelNode);
  if (memory) {
    nodes.set('memory-1', { id: 'memory-1', memoryKind: 'ram', ...memory, on: () => {} });
  }
  // A flow variable makes the typed session id testable the same way as in Node-RED.
  flowContext.set('conv', 'from-flow');
  for (const config of tools) {
    // Node-RED sets node.z to the flow tab id; tests declare it on the fixture. The config
    // passed to the constructor must be the node's own config, not the registry entry.
    const node = { id: config.id, z: config.z, on: () => {} };
    node.type = config.type || 'ai-tool';
    nodes.get(`ctor:${node.type}`).constructor.call(node, { ...config, id: config.id, z: config.z });
    // Assigned after construction: RED.nodes.createNode copies the config over the object, so a
    // send given before would be replaced. A Tool call is recorded, and onForward drives the flow.
    node.send = (message) => {
      node.sent = node.sent || [];
      node.sent.push(message);
      const outputs = Array.isArray(message) ? message.filter(Boolean) : [message];
      for (const entry of outputs) {
        if (entry && entry[TOOL_RESULT_TYPE] && node.onForward) {
          node.onForward(entry);
        }
      }
    };
    // A subagent has one output, so its tools are wired to wires[0].
    if (node.type === 'ai-subagent') {
      node.wires = [config.toolWires || []];
      // Stands in for the wire: a tool call leaves the subagent output and enters the Tool
      // input of the wired Tool nodes, which is what Node-RED does.
      node.send = (message) => {
        node.sent = node.sent || [];
        node.sent.push(message);
        const outputs = Array.isArray(message) ? message.filter(Boolean) : [message];
        for (const entry of outputs) {
          for (const targetId of config.toolWires || []) {
            const target = nodes.get(targetId);
            if (target && entry[TOOL_RESULT_TYPE]) {
              target.emit('input', entry, () => {}, () => {});
            }
          }
        }
      };
    }
  }

  const AgentCtor = nodes.get('ctor:ai-agent').constructor;
  const agent = { id: 'agent-1', z: 'flow-1', on: () => {} };
  agent.type = 'ai-agent';
  const agentWires = tools.map((tool) => tool.id);
  AgentCtor.call(agent, {
    id: 'agent-1',
    model: 'model-1',
    ...(memory ? { modelMemory: 'memory-1' } : {}),
    wires: [['debug-answer'], agentWires],
    ...agentConfig(agentOverrides),
  });
  return {
    RED,
    nodes,
    agent,
    http,
    setEnv: (name, value) => nodeRedEnv.set(name, value),
  };
}

// Text of a message, for assertions over model content.
function textOf(message) {
  if (!message) {
    return '';
  }
  const { content } = message;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function input(agent, msg) {
  return new Promise((resolve, reject) => {
    agent.emit('input', msg, () => {}, (error) => (error ? reject(error) : resolve()));
  });
}

function simulateToolFlow(agent, { reply = 'sunny 24C', replies = {} } = {}) {
  const outgoing = [];
  const originalSend = agent.send;
  agent.send = (message) => {
    outgoing.push(message);
    if (message[1] && message[1]['ai-agents/tool-result']) {
      const call = message[1]['ai-agents/tool-result'];
      // Stands in for the Tool flow (HTTP/function nodes) ending in a Tool Return node.
      setTimeout(() => {
        const settled = agent._engine.resolveById(call.nodeId, replies[call.name] ?? reply);
        assert.equal(settled, true, 'the tool call must still be pending');
      }, 5);
    }
    originalSend(message);
  };
  return outgoing;
}

test('agent runs a Tool flow through output 2 and answers on output 1', async () => {
  const { agent } = harness({
    script: [toolCall('c1', 'get_weather', { city: 'Madrid' }), (messages) => `Weather: ${messages.at(-1).content}`],
  });
  const outgoing = simulateToolFlow(agent);

  const msg = { payload: 'How is the weather?', session_id: 'session-a', keep: true };
  await input(agent, msg);

  // Node-RED sends an array for every multi-output port; only output 1 carries answers
  // and only output 2 carries tool calls.
  const batches = agent.sent.flat();
  const answered = batches
    .filter((message) => message && typeof message.payload === 'string')
    .pop();
  const toolCallMessage = batches.find((message) => message && message['ai-agents/tool-result']);
  assert.equal(answered.payload, 'Weather: sunny 24C');
  assert.equal(answered.keep, true, 'the input message is preserved');
  assert.deepEqual(toolCallMessage.payload, { city: 'Madrid' }, 'tool receives the model arguments');
  assert.equal(toolCallMessage['ai-agents/tool-result'].name, 'get_weather');
  assert.ok(outgoing.length >= 1);
});

test('a subagent runs its own agent and answers the parent as a tool result', async () => {
  // The parent delegates, the subagent calls its own tool and answers, and the parent finishes
  // with the text the subagent returned. Both agents use the same model config here, so the
  // scripted model is told apart by the conversation: the subagent's task is its first message.
  const subTool = toolNode({ id: 'sub-tool', name: 'lookup', description: 'Looks up a fact', parameters: { type: 'object', properties: {} } });
  const subagentNode = {
    id: 'sub-1',
    type: 'ai-subagent',
    name: 'Research topics',
    toolName: 'research_topics',
    description: 'Researches a topic and returns a summary',
    model: 'model-1',
    systemPrompt: 'You are a researcher',
    contextMode: 'isolated',
    recursionLimit: 6,
    maxToolCalls: 4,
    toolTimeout: 60000,
    agentTimeout: 5000,
    toolWires: ['sub-tool'],
  };
  const { agent, nodes } = harness({
    tools: [subagentNode, subTool],
    // The parent model only delegates and then reports. The subagent has its own model below.
    script: [toolCall('p1', 'research_topics', { task: 'tell me the weather in Madrid' }), (messages) => `Parent got: ${textOf(messages.at(-1))}`],
  });
  agent.wires = [['debug-answer'], ['sub-1']];

  // The subagent's own tool answers through the engine that started the call. With the harness
  // wire in place, the Tool node receives the call and its flow answers through this hook.
  nodes.get('sub-tool').onForward = (message) => {
    const call = message && message[TOOL_RESULT_TYPE];
    if (call) {
      setTimeout(() => agent._engine.resolveById('sub-tool', 'lookup result', call.callId), 5);
    }
  };

  const msg = { payload: 'weather please', session_id: 'sub-session' };
  // The subagent sees its own tool when the engine asks for it, not only when the test lists it.
  const sub = nodes.get('sub-1');
  assert.deepEqual(registry.connectedTo(sub).map((entry) => entry.toolName), ['lookup'], 'subagent tools');

  // The subagent gets its own model: it calls the tool and answers with its result.
  const subagentModel = fakeModel([
    toolCall('s1', 'lookup', {}),
    (messages) => {
      const last = messages.at(-1);
      const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
      return content.includes('lookup result') ? 'sunny 24C' : content;
    },
  ]);
  const factory = modelFactory.createModel.factory;
  let subagentActive = false;
  modelFactory.createModel.factory = () => (subagentActive ? subagentModel : scriptedModel);
  const subExecute = sub._execute;
  sub._execute = (toolName, input) => {
    subagentActive = true;
    return subExecute(toolName, input).finally(() => {
      subagentActive = false;
    });
  };

  try {
    await input(agent, msg);
  } finally {
    modelFactory.createModel.factory = factory;
    sub._execute = subExecute;
  }
  assert.equal(msg.payload, 'Parent got: sunny 24C', 'the subagent answer reaches the parent model');
});

test('a subagent resolves the tools wired to its single output', () => {  const subTool = toolNode({ id: 'sub-tool', name: 'Get task', toolName: 'get_task', description: 'Tasks' });
  const subagentNode = {
    id: 'sub-wired',
    type: 'ai-subagent',
    name: 'Task Resolve',
    toolName: 'Lista Task',
    description: 'Resolves tasks',
    model: 'model-1',
    contextMode: 'isolated',
    recursionLimit: 4,
    maxToolCalls: 2,
    toolTimeout: 60000,
    agentTimeout: 5000,
    toolWires: ['sub-tool'],
  };
  const { agent, nodes } = harness({ tools: [subagentNode, subTool], script: ['ready'] });
  agent.wires = [['debug-answer'], ['sub-wired']];

  const sub = nodes.get('sub-wired');
  assert.deepEqual(sub.wires, [['sub-tool']], 'a subagent has one output, so its tool is in wires[0]');
  assert.equal(sub.toolName, 'lista_task', 'a human value saved as the tool name is normalised');
  assert.deepEqual(resolveTools(sub).map((entry) => entry.toolName), ['get_task']);
  const exposed = registry.connectedTo(agent);
  assert.equal(exposed[0].toolName, 'lista_task', 'the parent sees the subagent as a tool');
  assert.equal(exposed[0].description, 'Resolves tasks');
});

test('a human tool name becomes a valid technical name', () => {
  const { toolNameFrom } = require('../lib/registry');
  assert.equal(toolNameFrom('Get weather'), 'get_weather');
  assert.equal(toolNameFrom('Mis Gastos'), 'mis_gastos');
  assert.equal(toolNameFrom('Revisión de gastos'), 'revision_de_gastos');
  assert.equal(toolNameFrom('Buscar  facturas 2026'), 'buscar_facturas_2026');
  assert.equal(toolNameFrom('getWeather'), 'get_weather');
  assert.equal(toolNameFrom('2026 report'), 'tool_2026_report', 'a name must start with a letter');
  assert.equal(toolNameFrom('---'), 'tool', 'an empty result falls back to the fallback');
  assert.equal(toolNameFrom(''), 'tool');
  assert.equal(toolNameFrom('x'.repeat(120)).length, 64, 'the API limit is enforced');
  assert.equal(toolNameFrom('Málaga: tiempo'), 'malaga_tiempo');
});

test('agent rejects a message without session id', async () => {
  const { agent } = harness();
  await assert.rejects(() => input(agent, { payload: 'hello' }), /session id/);
});

test('agent answers without tools', async () => {
  const { agent } = harness({ script: ['plain answer'] });
  await input(agent, { payload: 'hello', session_id: 's' });
  assert.equal(agent.sent[0][0].payload, 'plain answer');
});

test('agent reports model errors through done()', async () => {
  const { agent } = harness({
    script: [
      () => {
        throw new Error('401 Unauthorized');
      },
    ],
  });
  await assert.rejects(() => input(agent, { payload: 'hello', session_id: 's' }), /401 Unauthorized/);
});

test('tools are discovered from the wires of the tool output', () => {
  const { agent } = harness();
  assert.deepEqual(registry.connectedTo(agent).map((tool) => tool.id), ['tool-1']);
  // The registry is shared by the process, and other tests register tools in the same flow id.
  const listed = registry.listForAgent(agent).filter((entry) => entry.id === 'tool-1');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].sameFlow, true);
});

test('an unwired tool is listed for the flow but not offered to the model', () => {
  const { agent, nodes } = harness({ tools: [toolNode()] });
  const toolTwo = { id: 'tool-2', type: 'ai-tool', z: 'flow-1', on: () => {} };
  nodes.get('ctor:ai-tool').constructor.call(toolTwo, {
    id: 'tool-2',
    type: 'ai-tool',
    z: 'flow-1',
    name: 'get_time',
    description: 'Gets the time',
    parameters: { type: 'object', properties: {} },
  });
  assert.deepEqual(registry.connectedTo(agent).map((tool) => tool.id), ['tool-1']);
  assert.ok(registry.listForAgent(agent).some((tool) => tool.id === 'tool-2'));
});

test('two wired tools both receive the call and each one resolves its own', async () => {
  const toolTwo = toolNode({
    id: 'tool-2',
    name: 'get_time',
    description: 'Gets the time',
    parameters: { type: 'object', properties: { zone: { type: 'string' } }, required: ['zone'] },
  });
  const { agent, nodes } = harness({
    tools: [toolNode(), toolTwo],
    script: [
      toolCall('c2', 'get_time', { zone: 'Europe/Madrid' }),
      (messages) => `Time: ${messages.at(-1).content}`,
    ],
  });
  const outgoing = simulateToolFlow(agent, { reply: '12:30' });

  await input(agent, { payload: 'What time is it?', session_id: 's' });

  const calls = outgoing.filter((message) => message[1] && message[1]['ai-agents/tool-result']);
  // A single output means every Tool sees the same call; the name is what selects the runner.
  const called = calls.map((message) => message[1]['ai-agents/tool-result'].name);
  assert.deepEqual(called, ['get_time']);
  const answered = agent.sent.flat().filter((message) => message && message.payload).pop();
  assert.equal(answered.payload, 'Time: 12:30');
  // The other Tool must ignore the call instead of starting its own flow: that is what
  // left it showing "running" while the matching Tool already answered.
  const toolOne = nodes.get('tool-1');
  let forwarded = 0;
  toolOne.send = () => {
    forwarded += 1;
  };
  toolOne.emit('input', calls[0][1], () => {}, () => {});
  assert.equal(forwarded, 0, 'the non-matching tool must not start its flow');
  assert.equal(toolOne._expectReturn, undefined, 'the non-matching tool stays idle');
});

test('memory keeps conversation history per session id', async () => {
  const turns = [];
  // One model instance for the test, like the real ChatDeepSeek: the script is consumed
  // across both agent runs.
  const { agent } = harness({ memory: { memoryKind: 'ram' } });
  scriptedModel = fakeModel([
    (messages) => {
      turns.push(messages.map((message) => message._getType()).join(','));
      return 'first';
    },
    (messages) => {
      turns.push(messages.map((message) => message._getType()).join(','));
      return 'second';
    },
  ]);
  await input(agent, { payload: 'hi', session_id: 'same' });
  await input(agent, { payload: 'again', session_id: 'same' });
  // LangGraph checkpoints the thread between runs: the second model call receives the
  // saved conversation plus the new input instead of starting from scratch.
  assert.equal(turns[0], 'system,human');
  assert.equal(turns[1], 'system,human,ai,human', 'the second turn sees the saved conversation');
});

test('a second call for the same Tool runs its own flow and is answered by its own id', () => {
  const { agent, nodes } = harness({ script: ['unused'] });
  const tool = nodes.get('tool-1');
  let started = 0;
  tool.send = () => {
    started += 1;
  };
  const callMessage = (callId) => ({
    'ai-agents/tool-result': { nodeId: 'tool-1', callId, name: 'get_weather', redEngine: agent._engine },
  });

  tool.emit('input', callMessage('tool-1#1'), () => {}, () => {});
  assert.equal(started, 1, 'the matching call starts the tool flow');
  assert.equal(tool.statusHistory.at(-1).text, 'running');

  // A parent agent and a subagent can call the same Tool at once: the second call must run its
  // own flow instead of being dropped, and each one is answered through its own call id.
  tool.emit('input', callMessage('tool-1#2'), () => {}, () => {});
  assert.equal(started, 2, 'a second pending call runs its own flow');
});

test('a message for another tool leaves the badge untouched', () => {
  const { agent, nodes } = harness({ script: ['unused'] });
  const tool = nodes.get('tool-1');
  let started = 0;
  tool.send = () => {
    started += 1;
  };
  tool.emit('input', { 'ai-agents/tool-result': { nodeId: 'tool-2', name: 'get_time', redEngine: agent._engine } }, () => {}, () => {});
  assert.equal(started, 0, 'a tool only starts its own calls');
  assert.equal(tool.statusHistory.length, 1, 'and it does not flash a badge');
});

test('a Tool Return in the same flow still lets the Tool badge show the result', async () => {
  const { agent, nodes } = harness({ script: ['unused'] });
  const tool = nodes.get('tool-1');
  let resolved = null;
  const engine = { resolveById: (_id, value) => { resolved = value; return true; } };
  tool.send = () => {};
  const call = { nodeId: 'tool-1', name: 'get_weather', redEngine: engine };
  tool.emit('input', { 'ai-agents/tool-result': call }, () => {}, () => {});
  assert.equal(tool.statusHistory.at(-1).text, 'running');

  // The Tool Return comes first in the flow and resolves the call; then the message reaches
  // the Tool. This is the normal wiring, so the Tool must confirm it rather than report late.
  assert.equal(engine.resolveById('tool-1', { temperature: 24 }), true);
  call.resolvedBy = 'tool-return';
  tool.emit('input', { payload: { temperature: 24 } }, () => {}, () => {});
  assert.equal(resolved.temperature, 24);
  assert.equal(tool.statusHistory.at(-1).text, 'returned');
  assert.equal(tool.warnings, undefined, 'the Tool Return route is not logged as a warning');
});

test('the Tool badge is removed after the confirmation', async () => {
  const { agent, nodes } = harness({ script: ['unused'] });
  const tool = nodes.get('tool-1');
  tool.send = () => {};
  // Stand-in for the Agent engine: the Tool only needs resolveById to hand the result back.
  const engine = { resolveById: () => true };
  tool.emit('input', { 'ai-agents/tool-result': { nodeId: 'tool-1', name: 'get_weather', redEngine: engine } }, () => {}, () => {});
  assert.equal(tool.statusHistory.at(-1).text, 'running');

  tool.emit('input', { payload: 'sunny' }, () => {}, () => {});
  assert.equal(tool.statusHistory.at(-1).text, 'returned');

  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.deepEqual(tool.statusHistory.at(-1), {}, 'the badge is removed completely');
  void agent;
});

test('a second result after the flow finished runs the tool by hand instead of warning', async () => {
  const { nodes } = harness({ script: ['unused'] });
  const tool = nodes.get('tool-1');
  let calls = 0;
  const engine = { resolveById: () => { calls += 1; return calls === 1; } };
  const forwarded = [];
  tool.send = (message) => forwarded.push(message);
  tool.emit('input', { 'ai-agents/tool-result': { nodeId: 'tool-1', name: 'get_weather', redEngine: engine } }, () => {}, () => {});
  tool.emit('input', { payload: 'sunny' }, () => {}, () => {});
  assert.equal(tool.statusHistory.at(-1).text, 'returned');
  assert.equal(forwarded.length, 1, 'the call started the flow once');

  // A second message after the call ended is a manual run: no warning, no agent call.
  tool.emit('input', { payload: 'sunny again' }, () => {}, () => {});
  assert.equal(tool.statusHistory.at(-1).text, 'test run');
  assert.equal(calls, 1, 'the agent is not called again');
  assert.equal(tool.warnings, undefined, 'nothing is logged as a warning');
});

test('a Tool Return at the end of the tool flow clears the Tool badge', async () => {
  const { agent, nodes } = harness({ script: ['unused'] });
  const tool = nodes.get('tool-1');
  const toolReturn = { id: 'return-1', on: () => {}, send: () => {} };
  nodes.get('ctor:ai-tool-return').constructor.call(toolReturn, { id: 'return-1', returnProperty: 'payload' });
  tool.send = () => {};

  // The model asks for the tool: the badge says running and the call is pending.
  const call = { nodeId: 'tool-1', name: 'get_weather', redEngine: { resolveById: () => true } };
  tool.emit('input', { 'ai-agents/tool-result': call }, () => {}, () => {});
  assert.equal(tool.statusHistory.at(-1).text, 'running');

  // The flow ends in a Tool Return, which never sends the message back to the Tool. The Tool
  // must still show the confirmation instead of staying on "running" forever.
  toolReturn.emit('input', { 'ai-agents/tool-result': call, payload: { temperature: 24 } }, () => {}, () => {});
  assert.equal(tool.statusHistory.at(-1).text, 'returned');
  assert.equal(toolReturn.statusHistory.at(-1).text, 'returned');

  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.deepEqual(tool.statusHistory.at(-1), {}, 'the Tool badge is removed completely');
  void agent;
});

test('the Agent shows its work and then removes the badge', async () => {
  const { agent } = harness({ script: ['an answer'] });
  await input(agent, { payload: 'hello', session_id: 's' });
  const texts = agent.statusHistory.map((status) => status.text);
  assert.ok(texts.includes('thinking'), 'it reports that it is working');
  assert.equal(texts.at(-1), 'done', 'then it confirms the run');
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.deepEqual(agent.statusHistory.at(-1), {}, 'and the badge is removed');
});

test('an MCP client node exposes the tools selected on its connection', () => {
  const catalog = [
    { tool: 'search', name: 'search', description: 'Searches', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
    { tool: 'fetch', name: 'fetch', description: 'Fetches', parameters: { type: 'object', properties: {} } },
    { tool: 'write', name: 'write', description: 'Not exposed', parameters: { type: 'object', properties: {} } },
  ];
  const { agent, nodes } = harness({ script: ['unused'] });
  // The connection owns the catalog; the tool node only publishes what the connection selected.
  nodes.set('conn-1', { id: 'conn-1', type: 'mcp-client', tools: JSON.stringify(catalog.slice(0, 2)) });
  const mcpNode = { id: 'mcp-1', z: 'flow-1', on: () => {} };
  mcpNode.type = 'mcp-client-tool';
  nodes.get('ctor:mcp-client-tool').constructor.call(mcpNode, { id: 'mcp-1', name: 'docs', connection: 'conn-1' });
  agent.wires = [['debug-answer'], ['mcp-1']];

  const connected = registry.connectedTo(agent);
  assert.deepEqual(connected.map((tool) => tool.name).sort(), ['fetch', 'search'], 'only the selected tools are announced');
  assert.ok(connected.every((tool) => tool.owner === mcpNode), 'both belong to the MCP node');
});

test('an MCP tool runs in place and returns its own result', async () => {
  const { agent, nodes } = harness({ script: ['unused'] });
  nodes.set('conn-1', {
    id: 'conn-1',
    type: 'mcp-client',
    tools: JSON.stringify([{ tool: 'search', name: 'search', description: 'Searches', parameters: { type: 'object', properties: {} } }]),
  });
  const mcpNode = { id: 'mcp-1', z: 'flow-1', on: () => {} };
  mcpNode.type = 'mcp-client-tool';
  nodes.get('ctor:mcp-client-tool').constructor.call(mcpNode, { id: 'mcp-1', name: 'docs', connection: 'conn-1' });
  // Stand-in for the MCP connection: the node only needs getAdapter() for the call.
  const calls = [];
  nodes.get('conn-1').getAdapter = async () => ({
    tools: [{
      name: 'search',
      invoke: async (input) => {
        calls.push(input);
        return [{ type: 'text', text: 'result for search' }];
      },
    }],
  });
  agent.wires = [['debug-answer'], ['mcp-1']];

  const [tool] = agent._engine.langChainTools(registry.connectedTo(agent));
  const answer = await tool.invoke({});
  assert.equal(answer, 'result for search', 'the MCP result is flattened to text');
  assert.equal(calls.length, 1, 'the server tool is called once');
  assert.equal(agent._engine.pendingCount, 0, 'nothing is left waiting for a Tool Return');
});

test('an MCP tool that fails reaches the model as a tool result, not as a crash', async () => {
  const { agent, nodes } = harness({ script: ['unused'] });
  nodes.set('conn-1', {
    id: 'conn-1',
    type: 'mcp-client',
    tools: JSON.stringify([{ tool: 'get_context', name: 'get_context', description: 'Reads a URL', parameters: { type: 'object', properties: {} } }]),
    getAdapter: async () => ({
      tools: [{
        name: 'get_context',
        invoke: async () => {
          const error = new Error("MCP tool 'get_context' on server 'server' returned an error: The index could not retrieve this document.");
          error.name = 'ToolException';
          throw error;
        },
      }],
    }),
  });
  const mcpNode = { id: 'mcp-1', z: 'flow-1', on: () => {} };
  mcpNode.type = 'mcp-client-tool';
  nodes.get('ctor:mcp-client-tool').constructor.call(mcpNode, { id: 'mcp-1', name: 'docs', connection: 'conn-1' });
  agent.wires = [['debug-answer'], ['mcp-1']];

  const [tool] = agent._engine.langChainTools(registry.connectedTo(agent));
  const answer = await tool.invoke({});
  assert.match(answer, /failed/, 'the failure is returned as the tool result');
  assert.match(answer, /could not retrieve this document/, 'the reason from the server is kept');
  assert.equal(mcpNode.statusHistory.at(-1).text, 'tool error', 'the node shows it without turning red');
});

test('msg.system_prompt wins over the dialog prompt, and an empty one falls back', async () => {
  const prompts = [];
  const promptOf = (messages) => {
    const content = messages.find((m) => m._getType() === 'system').content;
    return Array.isArray(content) ? content.map((part) => part.text || '').join('') : content;
  };
  const { agent, nodes } = harness({ systemPrompt: 'dialog prompt' });
  scriptedModel = fakeModel([
    (messages) => {
      prompts.push(promptOf(messages));
      return 'ok';
    },
    (messages) => {
      prompts.push(promptOf(messages));
      return 'ok';
    },
    (messages) => {
      prompts.push(promptOf(messages));
      return 'ok';
    },
  ]);

  await input(agent, { payload: 'a', session_id: 'one', system_prompt: 'from the message' });
  assert.equal(prompts[0], 'from the message', 'the message wins when it carries the property');

  await input(agent, { payload: 'b', session_id: 'two' });
  assert.equal(prompts[1], 'dialog prompt', 'the dialog value is the fallback');

  await input(agent, { payload: 'c', session_id: 'three', system_prompt: '   ' });
  assert.equal(prompts[2], 'dialog prompt', 'a blank property does not replace the dialog value');
});

test('the model API key can be a literal or a Node-RED environment variable name', () => {
  const { modelConfigFrom } = require('../lib/agent-config');
  const { RED, setEnv } = harness({ script: ['unused'] });
  const agent = { modelNodeId: 'model-1' };
  const model = RED.nodes.getNode('model-1');

  model.apiKeyValueType = 'str';
  model.credentials = { apiKey: 'sk-literal' };
  assert.equal(modelConfigFrom(agent, RED, {}).apiKey, 'sk-literal');

  setEnv('CUSTOM_MODEL_KEY', 'sk-env');
  model.apiKeyValueType = 'env';
  model.apiKeyValue = 'CUSTOM_MODEL_KEY';
  const fromEnv = modelConfigFrom(agent, RED, {});
  assert.equal(fromEnv.apiKey, 'sk-env', 'the key is read from Node-RED environment variables');
  assert.equal(fromEnv.apiKeyEnv, 'CUSTOM_MODEL_KEY', 'the configured variable name is the one used');

  process.env.CUSTOM_MODEL_KEY = 'sk-process-env';
  assert.equal(
    modelConfigFrom(agent, RED, {}).apiKey,
    'sk-env',
    'the server process.env is never used for an env-typed key',
  );
  delete process.env.CUSTOM_MODEL_KEY;
});

test('an env-typed key that only exists in the server process.env is reported as missing', () => {
  const { modelConfigFrom } = require('../lib/agent-config');
  const { RED } = harness({ script: ['unused'] });
  const model = RED.nodes.getNode('model-1');
  model.apiKeyValueType = 'env';
  model.apiKeyValue = 'ONLY_IN_PROCESS_ENV';
  process.env.ONLY_IN_PROCESS_ENV = 'sk-process-env';
  try {
    assert.equal(
      modelConfigFrom({ modelNodeId: 'model-1' }, RED, {}).apiKey,
      '',
      'Node-RED environment variables are the only source for an env-typed key',
    );
  } finally {
    delete process.env.ONLY_IN_PROCESS_ENV;
  }
});

test('the model editor resolves an env-typed key from the variables of its flow tab', () => {
  const { RED, http } = harness({ script: ['unused'] });
  const route = http.post.find((entry) => entry.route === '/ai-agents/model/validate');
  assert.ok(route, 'the validate endpoint is registered');

  function validate(body) {
    const handler = route.rest[route.rest.length - 1];
    return new Promise((resolve) => {
      handler({ body }, { json: resolve, status: () => ({ json: resolve }) });
    });
  }

  const body = {
    provider: 'openai',
    model: 'any-model',
    apiKeyType: 'env',
    apiKeyEnv: 'FROM_THE_TAB',
    flowId: 'flow-1',
    flowEnv: [{ name: 'FROM_THE_TAB', value: 'sk-tab', type: 'str' }],
  };
  return validate(body).then((info) => {
    assert.equal(info.configured, true, 'the dialog value comes from the flow tab variables');
    assert.equal(info.apiKeyType, 'env');
  });
});

test('an env-typed key that Node-RED does not define is reported as missing', () => {
  const { modelConfigFrom } = require('../lib/agent-config');
  const { RED } = harness({ script: ['unused'] });
  const model = RED.nodes.getNode('model-1');
  model.apiKeyValueType = 'env';
  model.apiKeyValue = 'NOT_DEFINED_ANYWHERE';
  assert.equal(modelConfigFrom({ modelNodeId: 'model-1' }, RED, {}).apiKey, '');
});

test('every provider builds its LangChain model and maps the effort level', () => {
  const catalog = require('../lib/catalog');
  // The harness swaps in a scripted model; this test needs the real factory.
  const savedFactory = modelFactory.createModel.factory;
  delete modelFactory.createModel.factory;
  const { createModel } = require('../lib/model-factory');
  try {
    for (const id of catalog.PROVIDER_ORDER) {
      const entry = catalog[id];
      const model = createModel({
        provider: entry.id,
        model: 'some-model-name',
        baseUrl: entry.defaults.baseUrl,
        apiKey: 'sk-test',
        temperature: 0.7,
        maxTokens: 64,
        timeout: 1000,
        reasoningEffort: '',
      });
      assert.ok(model, `${entry.id} builds a model from the typed name`);
    }

    const openai = createModel({ provider: 'openai', model: 'gpt-5', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', temperature: 0.7, maxTokens: 64, timeout: 1000, reasoningEffort: 'high' });
    assert.deepEqual(openai.modelKwargs, { reasoning_effort: 'high' }, 'OpenAI uses reasoning_effort in the request body');
    const minimal = createModel({ provider: 'openai', model: 'gpt-5', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', temperature: 0.7, maxTokens: 64, timeout: 1000, reasoningEffort: 'none' });
    assert.deepEqual(minimal.modelKwargs, { reasoning_effort: 'minimal' }, 'none maps to the lowest OpenAI level');

    const anthropic = createModel({ provider: 'anthropic', model: 'claude-sonnet-4-5', baseUrl: 'https://api.anthropic.com', apiKey: 'k', temperature: 0.7, maxTokens: 64, timeout: 1000, reasoningEffort: 'max' });
    assert.deepEqual(anthropic.outputConfig, { effort: 'max' }, 'Anthropic uses outputConfig.effort');

    const google = createModel({ provider: 'google', model: 'gemini-2.5-pro', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'k', temperature: 0.7, maxTokens: 64, timeout: 1000, reasoningEffort: 'low' });
    assert.deepEqual(google.thinkingConfig, { thinkingLevel: 'LOW', includeThoughts: false }, 'Gemini uses thinkingLevel');
    const off = createModel({ provider: 'google', model: 'gemini-2.5-pro', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'k', temperature: 0.7, maxTokens: 64, timeout: 1000, reasoningEffort: 'none' });
    assert.deepEqual(off.thinkingConfig, { thinkingBudget: 0 }, 'none disables Gemini thinking');

    const deepseek = createModel({ provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', apiKey: 'k', temperature: 0.7, maxTokens: 64, timeout: 1000, reasoningEffort: 'low' });
    assert.deepEqual(deepseek.modelKwargs, { reasoning_effort: 'low' }, 'DeepSeek uses reasoning_effort in the request body');
  } finally {
    modelFactory.createModel.factory = savedFactory;
  }
});

test('the catalog ships no model names, only what each provider needs', () => {
  const catalog = require('../lib/catalog');
  for (const id of catalog.PROVIDER_ORDER) {
    const entry = catalog[id];
    assert.ok(entry, `${id} is in the provider order`);
    assert.equal(entry.models.list, undefined, 'no model names are stored in the catalog');
    assert.equal(entry.defaults.model, undefined, `${entry.id} does not default to a hard-coded model`);
    assert.equal(
      Object.prototype.hasOwnProperty.call(entry, 'apiKeyEnv'),
      false,
      `${entry.id} does not ship a default environment variable`,
    );
    assert.ok(entry.defaults.baseUrl, `${entry.id} has a base URL`);
    assert.ok(entry.models.path, `${entry.id} knows the endpoint that lists models`);
  }
});

test('no provider is hard-coded as the default one', () => {
  const catalog = require('../lib/catalog');
  const modelFactory = require('../lib/model-factory');
  // The harness swaps in a scripted model; this test needs the real factory.
  const savedFactory = modelFactory.createModel.factory;
  delete modelFactory.createModel.factory;
  try {
    const { createModel } = require('../lib/model-factory');
    assert.throws(() => createModel({ model: 'x', apiKey: 'k' }), /No model provider selected/);
    assert.throws(() => createModel({ provider: 'nope', model: 'x', apiKey: 'k' }), /Unsupported model provider/);
  } finally {
    modelFactory.createModel.factory = savedFactory;
  }
  assert.equal(typeof catalog.defaultProvider, 'function', 'the editor asks for the first provider explicitly');
});

test('the effort levels offered by each provider match its API', () => {
  const catalog = require('../lib/catalog');
  assert.deepEqual(catalog.openai.effort.levels, ['none', 'low', 'medium', 'high']);
  assert.ok(catalog.anthropic.effort.levels.includes('max'));
  assert.deepEqual(catalog.google.effort.levels, ['none', 'low', 'medium', 'high']);
  // DeepSeek documents none | low | high | max: "minimal" is mapped to "low" and "medium"
  // to "high", and there is no "auto" level.
  assert.deepEqual(catalog.deepseek.effort.levels, ['none', 'low', 'high', 'max']);
  assert.equal(catalog.openrouter.packageName, '@langchain/openai', 'OpenRouter speaks the OpenAI protocol');
});

test('the effort level reaches the request body instead of being dropped', () => {
  // The bug this covers: the effort was set as a top-level `reasoning` option, which the
  // chat-completions client ignores, so the editor field did nothing.
  const catalog = require('../lib/catalog');
  for (const provider of ['openai', 'deepseek']) {
    const options = { apiKey: 'k', model: 'm' };
    catalog[provider].effort.apply(options, 'high');
    assert.equal(options.reasoning, undefined, `${provider} must not use the ignored option`);
    assert.equal(options.modelKwargs.reasoning_effort, provider === 'openai' ? 'high' : 'high');
  }
  const none = { apiKey: 'k', model: 'm' };
  catalog.deepseek.effort.apply(none, 'none');
  assert.equal(none.modelKwargs.reasoning_effort, 'none', 'none disables thinking mode on DeepSeek');
});

test('the provider catalog is read from its own API shape', async () => {
  const { listModels } = require('../lib/model-list');
  // No network in the tests: the parsers are exercised through a stubbed fetch.
  const realFetch = global.fetch;
  const reply = (body) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  });
  try {
    global.fetch = async () => reply({ data: [{ id: 'zeta' }, { id: 'alpha' }] });
    assert.deepEqual(await listModels({ provider: 'openai', baseUrl: 'https://x/v1', apiKey: 'k' }), ['alpha', 'zeta'], 'OpenAI style is sorted');

    global.fetch = async () => reply({ data: [{ id: 'claude-x' }] });
    assert.deepEqual(await listModels({ provider: 'anthropic', baseUrl: 'https://x', apiKey: 'k' }), ['claude-x']);

    global.fetch = async () => reply({
      models: [
        { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embedding-b', supportedGenerationMethods: ['embedContent'] },
      ],
    });
    assert.deepEqual(await listModels({ provider: 'google', baseUrl: 'https://x', apiKey: 'k' }), ['gemini-a'], 'only generation models');
  } finally {
    global.fetch = realFetch;
  }
  await assert.rejects(() => listModels({ provider: 'openai', baseUrl: 'https://x', apiKey: '' }), /API key is missing/);
});

test('a Full deploy rebuilds the nodes and the conversation survives it', async () => {  const turns = [];
  const messageTypes = (messages) => messages.map((message) => message._getType()).join(',');
  // A Full deploy creates brand new node instances for the whole flow, with the same ids. This
  // test uses its own memory id so other tests cannot share the in-process store.
  const beforeDeploy = harness({ memory: { id: 'memory-deploy', memoryKind: 'ram' } });
  scriptedModel = fakeModel([(messages) => {
    turns.push(messageTypes(messages));
    return 'first';
  }]);
  await input(beforeDeploy.agent, { payload: 'my colour is blue', session_id: 'same' });

  const afterDeploy = harness({ memory: { id: 'memory-deploy', memoryKind: 'ram' } });
  scriptedModel = fakeModel([(messages) => {
    turns.push(messageTypes(messages));
    return 'blue';
  }]);
  await input(afterDeploy.agent, { payload: 'which colour did I say?', session_id: 'same' });

  assert.equal(turns[1], 'system,human,ai,human', 'the new node instance still sees the conversation');
});







































test('a Tool Return node wired back to the agent resolves the call and returns its payload', async () => {
  const { agent, nodes } = harness({
    script: [toolCall('c1', 'get_weather', { city: 'Madrid' }), (messages) => `Weather: ${messages.at(-1).content}`],
  });
  const toolReturn = { id: 'return-1', type: 'ai-tool-return', on: () => {}, send: () => {} };
  toolReturn.type = 'ai-tool-return';
  nodes.get('ctor:ai-tool-return').constructor.call(toolReturn, { id: 'return-1', returnProperty: 'payload' });

  const originalSend = agent.send;
  agent.send = (message) => {
    if (message[1] && message[1]['ai-agents/tool-result']) {
      // The tool flow ends in a Tool Return node, which resolves the pending call.
      setTimeout(() => toolReturn.emit('input', { ...message[1], payload: { temperature: 24 } }, () => {}, () => {}), 5);
    }
    originalSend(message);
  };

  await input(agent, { payload: 'How warm is Madrid?', session_id: 'session-b' });
  const answered = agent.sent.flat().filter((message) => message && typeof message.payload === 'string').pop();
  assert.equal(answered.payload, 'Weather: {"temperature":24}');
});

test('a redeployed memory node keeps its conversations', async () => {
  const first = { id: 'memory-1', memoryKind: 'ram' };
  const reloaded = { id: 'memory-1', memoryKind: 'ram' };
  assert.equal(await getCheckpointer(first), await getCheckpointer(first), 'one checkpointer per memory node');

  // A Full deploy stops every flow and builds new node instances; a deploy of a single node
  // reuses the old one. Both must keep the threads of an in-process memory.
  const kept = await getCheckpointer(reloaded);
  assert.equal(kept, await getCheckpointer(first), 'a redeployed memory node reuses the store');

  const other = { id: 'memory-2', memoryKind: 'ram' };
  assert.notEqual(await getCheckpointer(other), kept, 'different memory nodes stay isolated');
});

test('the context window keeps the newest complete turns of a session', async () => {
  const { WindowEdit } = require('../lib/engine');
  const { HumanMessage, AIMessage } = require('@langchain/core/messages');
  const edit = new WindowEdit(4);
  const messages = [];
  for (let turn = 0; turn < 5; turn += 1) {
    messages.push(new HumanMessage(`q${turn}`), new AIMessage(`a${turn}`));
  }

  await edit.apply({ messages, countTokens: () => 0 });
  assert.equal(messages.length, 4, 'the window is an upper bound on the messages seen by the model');
  assert.equal(messages[0].content, 'q3', 'the oldest exchanges are dropped');
  assert.equal(messages.at(-1).content, 'a4', 'the newest message is always kept');

  // A history shorter than the window is untouched.
  const short = [new HumanMessage('only')];
  await edit.apply({ messages: short, countTokens: () => 0 });
  assert.equal(short.length, 1);
});

test('a small window never splits a tool call from its result', async () => {
  const { WindowEdit } = require('../lib/engine');
  const { HumanMessage, AIMessage, ToolMessage } = require('@langchain/core/messages');
  const types = (messages) => messages.map((message) => message._getType()).join(',');
  // human, ai(tool_calls), tool, ai is one indivisible turn: cutting inside it makes the provider
  // reject the request with "Messages with role 'tool' must be a response to a preceding message
  // with 'tool_calls'".
  const build = () => [
    new HumanMessage('q'),
    new AIMessage({ content: '', tool_calls: [{ id: 'call_1', name: 'get_weather', args: {} }] }),
    new ToolMessage({ content: '24C', tool_call_id: 'call_1' }),
  ];

  for (const window of [1, 2, 3]) {
    const messages = build();
    await new WindowEdit(window).apply({ messages, countTokens: () => 0 });
    assert.equal(
      types(messages),
      'human,ai,tool',
      `window ${window} keeps the whole tool turn instead of leaving an orphan tool message`,
    );
  }
});

test('a trimmed window never starts with an assistant message', async () => {
  const { WindowEdit } = require('../lib/engine');
  const { HumanMessage, AIMessage } = require('@langchain/core/messages');
  const edit = new WindowEdit(3);
  const messages = [
    new HumanMessage('q1'),
    new AIMessage('a1'),
    new HumanMessage('q2'),
    new AIMessage('a2'),
    new AIMessage('tool step'),
  ];
  await edit.apply({ messages, countTokens: () => 0 });
  assert.equal(messages[0]._getType(), 'human', 'a dangling answer would confuse the model');
});

test('a tool message that lost its request is dropped from the history', async () => {
  const { WindowEdit } = require('../lib/engine');
  const { HumanMessage, AIMessage, ToolMessage } = require('@langchain/core/messages');
  // A thread saved when the window cut the ai message: the tool result has no owner any more.
  const messages = [
    new HumanMessage('q'),
    new ToolMessage({ content: 'orphan', tool_call_id: 'gone' }),
    new AIMessage('a'),
  ];
  await new WindowEdit(10).apply({ messages, countTokens: () => 0 });
  assert.equal(messages.map((message) => message._getType()).join(','), 'human,ai');
});

test('the context window of 1 still sends a valid conversation', async () => {
  const { WindowEdit } = require('../lib/engine');
  const { HumanMessage, AIMessage, ToolMessage } = require('@langchain/core/messages');
  const messages = [
    new HumanMessage('first'),
    new AIMessage('answer'),
    new HumanMessage('second'),
    new AIMessage({ content: '', tool_calls: [{ id: 'c1', name: 't', args: {} }] }),
    new ToolMessage({ content: 'r', tool_call_id: 'c1' }),
    new AIMessage('final'),
  ];
  await new WindowEdit(1).apply({ messages, countTokens: () => 0 });
  assert.equal(messages.map((message) => message._getType()).join(','), 'human,ai,tool,ai');
});

test('the agent applies the context window of its memory node', async () => {
  const seen = [];
  // The harness installs one scripted model; this script observes what the model receives.
  const { agent } = harness({
    script: [
      (messages) => {
        seen.push(messages.map((message) => message._getType()).join(','));
        return 'first';
      },
      (messages) => {
        seen.push(messages.map((message) => message._getType()).join(','));
        return 'second';
      },
    ],
    memory: { memoryKind: 'ram', contextWindow: 4 },
  });
  await input(agent, { payload: 'hi', session_id: 'window' });
  await input(agent, { payload: 'again', session_id: 'window' });
  const last = seen.at(-1);
  assert.ok(last, 'the model was called');
  assert.ok(last.split(',').length <= 4, `the memory window limits the model input, got "${last}"`);
});

test('a memory node without a context window keeps the whole conversation', async () => {
  const { contextWindowOf } = require('../lib/checkpoint');
  assert.equal(contextWindowOf({ contextWindow: 0 }), 0);
  assert.equal(contextWindowOf({ contextWindow: '' }), 0);
  assert.equal(contextWindowOf({ contextWindow: 'abc' }), 0);
  assert.equal(contextWindowOf({ contextWindow: -3 }), 0);
  assert.equal(contextWindowOf({ contextWindow: '10' }), 10);
  assert.equal(contextWindowOf({ contextWindow: 7.9 }), 7);
});

test('the memory node accepts Redis as a storage', async () => {
  const { memoryKindOf } = require('../lib/checkpoint');
  assert.equal(memoryKindOf({ memoryKind: 'redis' }), 'redis');
  assert.equal(memoryKindOf({ memoryKind: 'postgres' }), 'postgres');
  assert.equal(memoryKindOf({ memoryKind: 'ram' }), 'ram');
  assert.equal(memoryKindOf({ memoryKind: 'nope' }), 'ram', 'an unknown storage falls back to the default');
  assert.equal(memoryKindOf({}), 'ram');
});

test('a Redis memory reports a missing or invalid URL instead of connecting', async () => {
  const { getCheckpointer } = require('../lib/checkpoint');
  await assert.rejects(
    () => getCheckpointer({ id: 'memory-redis', memoryKind: 'redis' }),
    /Redis connection URL is not configured/,
  );
  await assert.rejects(
    () =>
      getCheckpointer({
        id: 'memory-redis',
        memoryKind: 'redis',
        resolvedDatabaseUrl: 'http://nope',
      }),
    /redis:\/\//,
  );
});



test('session id accepts a fixed string, a msg property, flow and env', async () => {
  const cases = [
    { config: { sessionId: 'fixed-session', sessionIdType: 'str' }, msg: { payload: 'x' }, expected: 'fixed-session' },
    { config: { sessionId: 'chat.id', sessionIdType: 'msg' }, msg: { payload: 'x', chat: { id: 4321 } }, expected: '4321' },
    { config: { sessionId: 'session_id', sessionIdType: 'msg' }, msg: { payload: 'x', session_id: 'dynamic' }, expected: 'dynamic' },
    { config: { sessionId: 'conv', sessionIdType: 'flow' }, msg: { payload: 'x' }, expected: 'from-flow' },
    { config: { sessionId: 'AI_AGENTS_TEST_SESSION', sessionIdType: 'env' }, msg: { payload: 'x' }, expected: 'from-env' },
  ];
  for (const testCase of cases) {
    const { agent, setEnv } = harness({ script: ['ok'], ...testCase.config });
    setEnv('AI_AGENTS_TEST_SESSION', 'from-env');
    await input(agent, { ...testCase.msg });
    assert.equal(agent.sent[0][0].session_id, testCase.expected, testCase.config.sessionIdType);
  }
});

