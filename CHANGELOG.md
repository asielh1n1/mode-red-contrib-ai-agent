# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **guardrails** node: checks a message before the agent with deterministic rules (max length,
  blocked words, blocked patterns) and an optional model verdict, and branches to `pass` or
  `blocked`. Every failure blocks (fail-closed). On the blocked output the rejected text can be
  replaced by a short message and kept apart in `msg['ai-agents/blocked-payload']`.
- **subagent** node: runs a whole agent (its own model, system prompt and tools) as a tool of
  another agent. It answers the call in place, so it needs no Tool Return, and its tools keep using
  their own Tool Return nodes. *Isolated* mode passes only the delegated task; *fork* also passes
  the text of the parent message.
- **Name** on the **tool** node accepts natural language: "Get weather" becomes `get_weather`. The
  technical name is shown (and editable) in the new **Tool name** field, and existing flows keep
  working because it is derived from the name they already had.

### Fixed

- Tool calls receive a copy of the message that entered the Agent, so properties such as
  `msg.user` (and any other custom property) are available inside the Tool flow. Before, only
  `path` reached the tool. Each call gets its own object, so one tool cannot change the data read
  by another tool of the same turn or the answer.
- A session whose history ends with a tool call without a result (an agent timeout, a cancel or a
  redeploy during a tool flow) no longer fails every following message with *"An assistant message
  with 'tool_calls' must be followed by tool messages"*. The missing calls are closed in the saved
  state when the session is used again, and the Agent shows a warning.
- Pending tool calls are answered with a "cancelled" result before the run is aborted, so a run that
  ends on a tool step keeps a valid conversation.
- **guardrails**: a custom **System prompt** no longer breaks the node. The text is now the
  *policy* and the node appends the JSON contract to it, so writing a rule in natural language
  ("no permitas faltas de respeto") no longer makes every message fail with *"The guardrail model
  did not answer with JSON"*.
- **guardrails**: the answer budget is 1024 tokens instead of 128. A thinking model such as
  `deepseek-flash` spent the whole budget on hidden reasoning and returned empty content, which
  was also reported as *"did not answer with JSON"*. The error now names the real cause and shows
  the text the model actually sent.

### Added

- **Tool timeout** on the agent: a tool flow that stops answering is closed with a "cancelled"
  result the model can read, instead of holding the run until the whole run times out.

### Documentation

- The **tool** node help and the README describe the best practice of catching errors in the tool
  flow and returning a message to the model through the **tool return**.

## [1.0.0]

First stable release.

### Nodes

- **agent**: runs a LangChain.js agent (`createAgent`) with Node-RED flows as tools. Two outputs:
  the answer and the tool calls.
- **tool**: defines a tool with a parameter table (name, type, required, description) and starts its
  flow when the model calls it.
- **tool return**: ends a tool flow and resolves the tool call.
- **model** (config): OpenAI, Anthropic, Google Gemini, OpenRouter and DeepSeek, with typed API key,
  reasoning effort, temperature, max tokens and timeout.
- **memory** (config): conversation memory in Node-RED, PostgreSQL or Redis, selectable per agent.
- **mcp client** (config) and **mcp tool**: expose the tools of an external MCP server, selected per
  connection.

### Features

- Model names are typed by hand, with a **List models** button that asks the provider's own API, so
  no model list ships in the package and nothing goes stale.
- Typed inputs everywhere it matters: the API key accepts a string or a Node-RED environment
  variable, and memory URLs and session ids accept `string`, `msg`, `flow`, `global` and `env`.
- The API key typed as a string is stored as a credential and is never exported with the flow.
  Environment variables are read from Node-RED's own environment (`env` in `settings.js`, plus flow,
  group and global variables), never from the server's `process.env`.
- Reasoning effort is mapped to each provider: `reasoning.effort` (OpenAI, OpenRouter),
  `outputConfig.effort` (Anthropic) and `thinkingConfig` (Gemini).
- **Context window length** on the memory node caps how many messages a session keeps, applied with
  LangChain's `contextEditingMiddleware` on every model call, so it works the same for all storages.
- `msg.system_prompt` overrides the dialog prompt per message, for prompts built by another node.
- MCP tool failures are returned to the model as the tool result (with a warning on the node), so the
  agent can retry or answer instead of the flow failing.
- Status badges are transient: the agent shows *thinking* and then *done*, tools show *running* and
  then *returned*, and every badge is removed when the run finishes.
- Errors are reported with `node.error`, so **catch** nodes keep working.

### Notes

- Requires Node-RED 5.0 and Node.js 22.9 or later.
- The Redis memory needs the RediSearch module (Redis Stack or a managed Redis that includes it).
- Conversation memory in Node-RED survives a deploy, including a Full deploy, but not a restart of
  the process; use Postgres or Redis to keep conversations across restarts.

[1.0.0]: https://github.com/asielh1n1/mode-red-contrib-ai-agent/releases/tag/v1.0.0
