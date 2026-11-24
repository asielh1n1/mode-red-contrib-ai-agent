# node-red-contrib-ai-agents

[![npm version](https://img.shields.io/npm/v/node-red-contrib-ai-agents.svg)](https://www.npmjs.com/package/node-red-contrib-ai-agents)
[![npm downloads](https://img.shields.io/npm/dm/node-red-contrib-ai-agents.svg)](https://www.npmjs.com/package/node-red-contrib-ai-agents)
[![license](https://img.shields.io/npm/l/node-red-contrib-ai-agents.svg)](./LICENSE)
[![Node-RED](https://img.shields.io/badge/Node--RED-%3E%3D5.0-red)](https://nodered.org)

Visual AI agents for Node-RED. An **agent** node talks to a large language model, calls **tool**
nodes built with ordinary Node-RED flows, and answers. Powered by
[LangChain.js](https://docs.langchain.com/oss/javascript/langchain/overview) and
[LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview).

```text
inject ──► agent ──► answer
             │
             └──► tool (get_weather) ──► http request ──► tool return
```

No code in the model loop, no JSON to memorise for tools, and no new editor to learn: it is
Node-RED wiring all the way down.

## Features

- **Flow as a tool.** Each tool is a normal flow: HTTP Request, MQTT, PostgreSQL, Function, Home
  Assistant, anything. The agent calls it and continues reasoning with the result.
- **Five model providers.** OpenAI, Anthropic, Google Gemini, OpenRouter and DeepSeek, each through
  its official LangChain.js integration. Model names are typed by hand (or listed from the
  provider's own API), so nothing in the package goes stale.
- **Reasoning effort.** `none` / `low` / `medium` / `high` / `max`, forwarded in the shape each
  provider's API expects.
- **Conversation memory.** In Node-RED, PostgreSQL or Redis, with an optional **context window** that
  caps how many messages a session keeps.
- **MCP tools.** Connect an external [MCP server](https://modelcontextprotocol.io) and expose only the
  tools you choose to the agent.
- **Node-RED native.** Typed inputs (`msg`, `flow`, `global`, `env`, `string`), credentials for API
  keys, `node.error` for catch nodes, status badges that disappear when a run ends.

## Requirements

- Node-RED 5.0 or later
- Node.js 22.9 or later (the Node-RED 5 minimum)
- A tool-capable model from one of the supported providers, and an API key for it

## Install

From the Node-RED editor:

1. Open the menu, then **Manage palette** → **Install**.
2. Search for `node-red-contrib-ai-agents` and install it.

Or from the command line, in your Node-RED user directory (usually `~/.node-red`):

```bash
npm install node-red-contrib-ai-agents
```

Restart Node-RED. The nodes appear in the **ai agents** category.

### Quick start

1. Import [`examples/weather-agent.json`](./examples/weather-agent.json)
   (menu → **Import** → **Clipboard**).
2. Open the **model** configuration node and paste your API key.
3. Deploy and press the inject button.

The example asks for the weather in Madrid: the model calls the `get_weather` tool, whose flow
contains a Function and a **tool return** node.

## Nodes

| Node | Purpose |
| --- | --- |
| **agent** | Runs the model/tool loop. Output 1 is the answer, output 2 emits tool calls. |
| **tool** | Defines a capability (name, description, parameters) and starts its flow when the model calls it. |
| **tool return** | Ends a tool flow and hands the result back to the agent. |
| **subagent** | Runs a whole agent (its own model, prompt and tools) as a tool of another agent. |
| **guardrails** | Checks a message before the agent and sends it to a `pass` or `blocked` output. |
| **model** (config) | Provider, model, API key and reasoning effort shared by the agents. |
| **memory** (config) | Conversation memory: kept in Node-RED, in PostgreSQL or in Redis, with an optional context window. |
| **mcp client** (config) | Connection to an external MCP server: URL or command, headers, timeout and the tools to expose. |
| **mcp tool** | Exposes the selected tools of an MCP server to the agent. Wire it to the agent's tool-calls output; it needs no Tool Return. |

## Configuration

### Model

Create a **model** configuration node and pick the provider: **DeepSeek**, **OpenAI**, **Anthropic**,
**Google Gemini** or **OpenRouter**.

The **Model** is typed by hand: providers add and retire models constantly, so nothing is
hard-coded. Type the exact name the provider documents, or press **List models** to ask the
provider's own API for the names it currently offers and pick one. If the name does not exist the
provider returns its error, which is reported by the Agent.

The **API key** has two sources:

- **Typed key**: stored as a credential, so it is never exported with the flow. Leaving the field
  empty when editing keeps the stored key.
- **Environment variable**: name a Node-RED environment variable (defined under `env` in
  `settings.js`, or as a flow, group or global variable) and its value is used at run time. The
  server's own `process.env` is not consulted. No provider ships a default variable name.

Credentials are stored separately from the flow and are not exported with it.

**Reasoning effort** is forwarded in the shape each API expects:

| Provider | Option sent | Levels |
| --- | --- | --- |
| OpenAI | `reasoning.effort` | none (sent as `minimal`), low, medium, high |
| Anthropic | `outputConfig.effort` | low, medium, high, max |
| Gemini | `thinkingConfig` | none (budget 0), low, medium, high |
| OpenRouter | `reasoning.effort` | none, low, medium, high |
| DeepSeek | `reasoning.effort` | none, low, medium, high |

Model options can also be provided through `settings.js`, following the
`<nodeType><Property>` convention:

```js
module.exports = {
    // Provider used when a model configuration node has none selected. None is preset by the
    // package: every provider is opt-in.
    aiAgentsProvider: 'openai'
};
```

### Agent

| Field | Meaning |
| --- | --- |
| **Model** | The model configuration node to use. Required. |
| **Memory** | Optional memory configuration node. Without it every message is an independent call. |
| **Session id** | Typed value that identifies the conversation. `msg` + `session_id` by default. |
| **System prompt** | Base instruction. A non-blank `msg.system_prompt` on the incoming message wins. |
| **Reasoning steps** | LangGraph `recursionLimit`: how many model/tool steps a message may take. |
| **Tool calls** | Maximum tool invocations per message. |
| **Tool timeout** | How long a tool flow may take before the model receives a "cancelled" result. Keep it below **Timeout**. |
| **Timeout** | Upper bound for the whole run, in milliseconds. |

### Tool

| Field | Meaning |
| --- | --- |
| **Name** | Tool name the model sees, written naturally ("Get weather" becomes `get_weather`). |
| **Tool name** | The technical snake_case name announced to the model; follows **Name** unless edited. |
| **Description** | What the tool does. This is the only thing the model uses to decide when to call it. |
| **Parameters** | Built with a table: name, type, required, description. The node produces the JSON Schema. |

The parameter table has **Add parameter** and a delete button per row, so you never write JSON by
hand.

**Catch errors before the Tool Return.** A tool flow that fails and never answers (an HTTP error,
a missing database row, a node wired to nothing) leaves the tool call without a result in the
conversation memory, and the provider then rejects every new message of that session with
*"An assistant message with 'tool_calls' must be followed by tool messages"*. The agent repairs such
a session on the next message (the missing calls are closed with a "cancelled" result and the node
shows a warning), but the model still gets no useful answer. The best practice is to add a **Catch**
node to the tool flow and wire it to the **Tool Return**, returning a property like
`error.message`: the model then reads the failure as the tool result and can explain it or retry
instead of the flow failing.

### Memory

Add a **memory** configuration node and select it on the Agent. The connection **URL** is also a typed
value (`string`, `msg`, `flow`, `global` or `env`), so it can be a literal or read from an environment
variable or a message property.

- **Conversation memory**: per-thread state kept in Node-RED; survives a deploy (including a Full
  deploy) but is lost when Node-RED restarts.
- **Postgres**: LangGraph checkpointer, shared and persistent. Tables are created on first use or
  with *Test connection* in the edit dialog (in the configured schema).
- **Redis**: LangGraph checkpointer backed by Redis. It needs the RediSearch module, included in
  Redis Stack and in most managed Redis services. *Test connection* lists the existing threads, so
  it proves both the connection and the module.

**Context window length** caps how many messages of a session are kept: with `10`, the model only
sees the last 10 messages of that session id and older exchanges are dropped, so the agent forgets
the beginning of a long conversation instead of growing without limit. `0` keeps everything, which
is the default for flows saved before this option existed. The limit is applied with LangChain's
`contextEditingMiddleware` on every model call, so it behaves the same for all three storages.

Conversations are separated by the agent's **Session id**, configured with a typed value (like the
core nodes): pick `msg`, `flow`, `global` or `env` and write the property name, or pick
`string` for a fixed id shared by every message. Memory is optional: without it every message is an
independent model call.

Two things make the agent look like it "does not remember":

- **Node-RED was restarted.** The in-process conversations are held by the Memory node itself, so
  they end with the process; use **Postgres** or **Redis** to keep them across restarts.
- **The session id is not the same on every message.** With the default `msg` type and the property
  name `session_id`, each incoming message needs `msg.session_id`. Set a fixed `string` id if your
  flow injects messages without it; the Agent fails with *The session id is empty* otherwise.

## Message contract

### Agent input

| Property | Meaning |
| --- | --- |
| `payload` | User text. Strings and buffers are used directly; objects use `text`/`content` when present, otherwise JSON. |
| (session) | The session id is taken from the *Session id* property, not from a fixed message field. |
| `system_prompt` | Optional. When the message carries it (and it is not blank), it replaces the *System prompt* typed in the dialog. Useful for long prompts built by another node. |

The input message is preserved and reused for the answer, as recommended by the Node-RED
guide for nodes that send in response to receiving.

### Agent output 1 - answer

The input message with `payload` replaced by the final assistant text and `session_id` set. It is
the same object that entered the node, so everything else it carried is still there.

### Agent output 2 - tool calls

One message per call. `payload` holds the arguments chosen by the model and validated against the
Tool schema; `msg['ai-agents/tool-result']` carries `{ nodeId, name, args }` for the Tool flow.

Every call is a **copy of the message that entered the Agent** (custom properties such as
`msg.user`, `msg.token` or anything else a flow added, plus `_msgid`, `_user` and `session_id`), with
`payload` replaced by the arguments of that call. A tool can read the data of the incoming message
and add its own properties without affecting the other tools of the same turn or the answer: each
call carries its own object. The copy is shallow, so writing *inside* a nested object (`msg.user.id`)
does change the object the Agent message shares; replace the property instead of mutating it if that
matters.

Wire this output to every **tool** node the model may call. Any Node-RED node can sit in the tool
flow (HTTP Request, MQTT, PostgreSQL, Function, Home Assistant...). Close the flow either by wiring it
back to the same **tool** node (it returns `msg.payload`) or to a **tool return** node, and the agent
continues reasoning.

**The wiring is the tool list.** Every Tool connected to that output is announced to the model;
remove the wire to hide it. Tools must live in the same flow (or inside a connected subflow). Since
the Agent sends all calls through a single output, each Tool accepts only the call whose name
matches and ignores the others, so one wire can feed any number of tools.

Each Tool shows its state as a short badge: *running* while its flow executes, then *returned*
once the result reached the Agent. Both are removed a moment later, and *test run* (a flow started
by hand) behaves the same way, so no node keeps a permanent label. A Tool that stays on *running*
means its flow never finished: wire its last node back into the Tool input, or end the flow in a
**Tool Return**.

A tool flow should end in a result whatever happens: add a **Catch** node to it and wire it to the
**Tool Return**, so a failing HTTP request or database query reaches the model as the tool result
instead of leaving the run hanging. As a safety net, the agent's **Tool timeout** answers a flow
that stops responding so the model can still continue.

The result can be any value: a string reaches the model unchanged, and anything else (an array of
rows, an object, a number) is sent as JSON. A session that saved a tool result from an older
release with another type is repaired when its next message arrives, so it does not have to be
cleared.

If a run is cancelled while a tool is still pending (agent timeout or *Timeout*, redeploy), the
agent closes that call the next time the session is used: the missing answers are written to the
memory with a "cancelled" result and the node shows a warning. That keeps the conversation valid
instead of the provider rejecting it with *"An assistant message with 'tool_calls' must be followed
by tool messages"*.

Errors raised by the agent are reported with `node.error`, so **catch** nodes work as usual. The
Agent shows *thinking* while it works, *done* when it answers and *model error* when it fails; the
badges are removed once the run finishes.

## Subagents

A **subagent** is a complete agent used as a tool of another agent. It has its own **Model**, its
own **System prompt** and its own tools, and it answers the call in place: there is no answer output
and no Tool Return for the subagent itself, so the parent can never be left waiting for it.

```text
inject ──► agent ──► answer
             │
             └──► subagent (research_topics) ──► tool ──► tool return
```

Wire it to the parent's tool-calls output like any other tool; wire the tools the subagent may use
to **its** output, and end those flows in a **Tool Return**.

| Field | Meaning |
| --- | --- |
| **Name** / **Tool name** | How the parent model sees the subagent ("Research topics" becomes `research_topics`). |
| **Description** | What it does. The parent model uses it to decide when to delegate. |
| **Model** | Its own model; it does not have to be the parent's. |
| **System prompt** | Its own instructions. It does not inherit the parent's prompt. |
| **Context** | *Isolated* only gives it the delegated task (recommended, keeps the parent context clean). *Fork* also adds the text of the message that started the parent run. |
| **Reasoning steps**, **Tool calls**, **Tool timeouts**, **Timeout** | Same meaning as on the agent, for the subagent's own loop. |

Every call runs isolated: the subagent starts from the task it receives and keeps no conversation
between calls. The properties of the message that reached the parent (`msg.user`, a token...) are
available to its tools, exactly like in a Tool. Timeouts are **reported as a tool error** to the
parent, which can then explain the problem or retry.

## Guardrails

The **guardrails** node checks a message before it reaches the agent and decides with two outputs:

```text
inject ──► guardrails ──► pass ──► agent
                     └──► blocked ──► reply / debug
```

| Field | Meaning |
| --- | --- |
| **Model** | The guardrail's own model. It is always called with temperature 0 and a 128-token answer. |
| **Max length** | Messages longer than this are blocked by a rule, without any model call. |
| **Flag from length** | Longer messages still go to the model, but their verdict is tagged `suspicious_length`. |
| **Blocked words** | One per line, whole words, case-insensitive. Lines starting with `#` are comments. |
| **Blocked patterns** | One JavaScript regular expression per line. An invalid pattern is reported when the node starts. |
| **Use the model** | Unchecked: only the rules run. |
| **System prompt** | The guardrail's instructions. Empty uses a built-in prompt that asks for a JSON verdict. |
| **Timeout** | Short timeout for the guardrail model call (8 s by default). |
| **Output Message** | Text sent as `payload` on the blocked output, replacing the rejected one. |

The text to check always arrives in **`msg.payload`**; the node reads no other property.

The rules run first: they are free and deterministic. Then the model is asked for
`{"allowed": true|false, "category": "...", "reason": "..."}`.

**Every problem blocks.** No model, a reply that is not JSON, a timeout or a network error send the
message to `blocked` (fail-closed). A guardrail that lets traffic through when it cannot decide
protects nothing.

Both outputs carry the original message plus `msg['ai-agents/guardrail']`
(`{ allowed, source, rule, reason, categories }`). On the blocked output, if a **Message** is set,
`msg.payload` is replaced by it and the rejected text is kept in `msg['ai-agents/blocked-payload']`,
so the malicious input does not reach the agent, its tools or a careless debug.

**Scope:** it checks the message that enters it. Tool results (an HTTP response, a document) and the
agent's answer are not checked; indirect prompt injection travels through tool results.

## MCP tools

The **mcp tool** node exposes the tools of an external [MCP server](https://modelcontextprotocol.io)
to the agent:

```text
inject ──► agent ──► answer
             │
             └──► mcp tool  (no Tool Return needed)
```

1. Create an **mcp client** configuration node: pick the transport (HTTP with a URL, or a command
   for a local server) and add the headers the server needs, one row each.
2. Type or paste the URL and the catalog is discovered as soon as the field is left (or press
   **Discover tools** at any time).
3. Tick the tools you want to expose: nothing is selected by default, so only what you choose is
   announced to the model and a large catalog never floods the prompt.
4. Wire the **mcp tool** node to the agent's *tool calls* output, like any other tool.

The node has no flow of its own: the MCP server produces the answer, so the node hands the result
straight back to the agent and **no Tool Return is needed**. Tool results (text, images, structured
data) are converted to text the model can read.

When the server says a call could not be completed (a document missing from its index, a bad
query, a rate limit), the reason is passed to the model as the tool result so the agent can retry
or answer; only a connection problem stops the run.

Headers can reference an environment variable with `$NAME` (for example
`Authorization: Bearer $MCP_TOKEN`), so tokens stay out of the exported flow.

The URL accepts a typed value, and the connection keeps one session open while the flow runs.

## Behaviour and limits

- `Reasoning steps` maps to LangGraph's `recursionLimit`; `Tool calls` caps how many tools a single
  message may invoke; `Timeout` bounds the whole run.
- Tool arguments are validated before the flow runs. Invalid arguments are returned to the model as
  a tool error so it can retry.
- Tool calls are serialized per Agent node, and duplicate tool names are rejected: LangChain binds
  tools by name. An MCP server usually prefixes its tool names (`server_tool`); if two servers
  expose the same name, keep the prefix or expose only one of them.
- Tools inside subflows are discovered per subflow instance.

## Development

```bash
git clone https://github.com/asielh1n1/mode-red-contrib-ai-agent.git
cd mode-red-contrib-ai-agent
npm install
npm test
```

The tests use a scripted chat model, so no network access or API key is required.

To try the package inside a Node-RED installation, link it into the user directory:

```bash
cd ~/.node-red
npm install /absolute/path/to/mode-red-contrib-ai-agent
```

## Contributing

Issues and pull requests are welcome at
<https://github.com/asielh1n1/mode-red-contrib-ai-agent/issues>. Please run `npm test` before
opening a pull request.

## Sources

- Node-RED node creation: <https://nodered.org/docs/creating-nodes/>
- Node-RED packaging: <https://nodered.org/docs/creating-nodes/packaging>
- LangChain.js `createAgent`: <https://docs.langchain.com/oss/javascript/langchain/agents>
- LangChain.js tools: <https://docs.langchain.com/oss/javascript/langchain/tools>
- LangGraph checkpointers: <https://docs.langchain.com/oss/javascript/langgraph/checkpointers>
- LangGraph Redis checkpointer: <https://www.npmjs.com/package/@langchain/langgraph-checkpoint-redis>
- Redis Stack (RediSearch): <https://redis.io/docs/latest/operate/oss_and_stack/install/install-stack/>
- Model Context Protocol: <https://modelcontextprotocol.io>

## License

[Apache-2.0](./LICENSE)
