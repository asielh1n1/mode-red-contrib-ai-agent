# Contributing

Thanks for taking the time to improve this package.

## Getting started

```bash
git clone https://github.com/asielh1n1/mode-red-contrib-ai-agent.git
cd mode-red-contrib-ai-agent
npm install
npm test
```

The test suite uses a scripted chat model (`test/fake-model.js`), so it needs no network access and
no API key.

To load the nodes in a real Node-RED, install the folder into a Node-RED user directory:

```bash
cd ~/.node-red
npm install /absolute/path/to/mode-red-contrib-ai-agent
```

Restart Node-RED and the nodes appear under **ai agents**. After changing a `.html` file, restart
Node-RED and reload the editor with `Ctrl + F5`: the editor caches node definitions.

## What to keep in mind

- **Node-RED conventions first.** Typed inputs, credentials, `node.error`, `node.status`, and one
  `input` listener per node (Node-RED only calls the first one).
- **No hard-coded providers or model names.** A provider lives in `lib/catalog.js`; nothing else
  should branch on a provider name.
- **No `process.env`.** Environment variables are read from Node-RED's own environment, see
  `lib/node-env.js`.
- **Errors vs tool results.** A problem in the tool's own work goes back to the model as the tool
  result; a problem that makes the run impossible is thrown with `node.error`.

## Project layout

```text
index.js            entry point: lists the files Node-RED must load
lib/*.js            node runtime
lib/*.html          editor definition (registerType) and help text
lib/checkpoint.js   conversation storages (Node-RED, Postgres, Redis)
lib/catalog.js      model providers: package, class, endpoint, effort mapping
lib/engine.js       LangGraph/LangChain bridge: tools, context window, run
test/               node:test suite
examples/           importable flows
icons/              node icons (SVG, 40x60, white on transparent)
```

## Adding a model provider

1. Add its runtime package to `dependencies` in `package.json`.
2. Add an entry to `lib/catalog.js`: `id`, `label`, `packageName`, `classExport`, `effort`,
   `defaults.baseUrl` and `models` (the endpoint that lists models, if the provider has one).
3. Add the id to `PROVIDER_ORDER`.
4. If it lists models differently from OpenAI, handle it in `lib/model-list.js`.

The editor builds its provider list from `/ai-agents/model/catalog`, so no HTML change is needed.

## Commit messages

Use a short imperative subject (`Add Redis memory`, `Fix tool badge cleanup`) and explain the
reasoning in the body when it is not obvious. Reference an issue when there is one.

## Pull requests

- Run `npm test`; CI runs the same command.
- Keep behaviour changes and refactors in separate commits when possible.
- Update `README.md` and the node's help text when you change a field or a message contract.
- Add a `CHANGELOG.md` entry under the unreleased section.
