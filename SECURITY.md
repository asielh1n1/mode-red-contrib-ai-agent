# Security policy

## Supported versions

The latest published version receives fixes. Please try the newest release before reporting a
problem.

## Reporting a vulnerability

Do not open a public issue for a security problem. Use GitHub's private reporting:

<https://github.com/asielh1n1/mode-red-contrib-ai-agent/security/advisories/new>

Include the version, the Node-RED and Node.js versions, what you did, and what happened. You will get
an answer as soon as possible, and the fix will be released together with an advisory when it is
appropriate.

## What this package does with secrets

- **API keys** typed in the model node are stored in Node-RED's own credential store, not in the flow,
  and are never exported with it.
- **API keys from an environment variable** are read from Node-RED's environment (`env` in
  `settings.js`, plus flow, group and global variables). The server's `process.env` is not consulted.
- **MCP headers** may reference environment variables with `$NAME`, so tokens do not have to be
  written into the flow.
- **Database passwords** use Node-RED credentials when configured through the memory node.

Flows and their credentials are only as protected as the Node-RED instance they run on: keep the
editor behind authentication and do not export flows that contain literal secrets.
