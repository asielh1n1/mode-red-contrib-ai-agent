# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
