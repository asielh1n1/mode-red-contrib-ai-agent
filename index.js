'use strict';

// Node-RED loads the files listed under `node-red.nodes`; this entry point only exists so
// the package can also be required normally.
module.exports = {
  nodes: ['ai-agent', 'ai-agent-model', 'ai-agent-memory', 'ai-tool', 'ai-tool-return', 'ai-subagent', 'ai-guardrails', 'mcp-client', 'mcp-client-tool'],
};
