'use strict';

const { registry, bindInstance } = require('./registry');

// The tools an MCP client node offers to the agent. They are plain descriptions; the call
// itself is executed by the connection node, which owns the MCP session.
const STATUS_HOLD_MS = 1500;

// MCP answers with content blocks (`{type:'text',text:…}`, images, resources). The model needs
// text, so the blocks are flattened; anything structured is kept as JSON so nothing is lost.
function resultText(value) {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(resultText).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') {
      return value.text;
    }
    if (Array.isArray(value.content)) {
      return resultText(value.content);
    }
    if (value.data !== undefined && typeof value.mimeType === 'string') {
      return `[${value.type || 'content'} ${value.mimeType}]`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function parseExposed(input) {
  if (!input) {
    return [];
  }
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      throw new Error('The exposed tools must be a JSON list');
    }
  }
  if (!Array.isArray(value)) {
    throw new Error('The exposed tools must be a JSON list');
  }
  return value
    .filter((entry) => entry && entry.name)
    .map((entry) => ({
      tool: String(entry.tool || entry.name),
      name: String(entry.name),
      description: String(entry.description || ''),
      parameters: entry.parameters || { type: 'object', properties: {} },
    }));
}

module.exports = function registerMcpClientTool(RED) {
  function McpClientToolNode(config) {
    RED.nodes.createNode(this, config);
    bindInstance(this, RED);
    const node = this;

    node.name = String(config.name || '').trim();
    node.connection = config.connection || '';

    let statusTimer = null;

    function setStatus(fill, shape, text) {
      node.status(fill ? { fill, shape, text } : {});
    }

    function flashStatus(fill, shape, text) {
      if (statusTimer) {
        clearTimeout(statusTimer);
      }
      setStatus(fill, shape, text);
      statusTimer = setTimeout(() => {
        statusTimer = null;
        // While idle the node shows how many tools it exposes, so the flow is readable.
        setStatus('grey', 'dot', `${count()} tool(s)`);
      }, STATUS_HOLD_MS);
    }

    // The connection owns the catalog: the tools are selected there, once, and this node only
    // publishes them to the Agent.
    function connectionNode() {
      return node.connection ? RED.nodes.getNode(node.connection) : null;
    }

    function exposedTools() {
      const connection = connectionNode();
      if (!connection) {
        return [];
      }
      try {
        const parsed = typeof connection.tools === 'string' ? JSON.parse(connection.tools || '[]') : connection.tools;
        return Array.isArray(parsed) ? parsed.filter((entry) => entry && entry.name) : [];
      } catch {
        return [];
      }
    }

    function count() {
      return exposedTools().length;
    }

    // Registration publishes one entry per exposed tool so the Agent can announce them all.
    // It runs again whenever the connection changes, because the catalog lives there.
    node.exposedTools = exposedTools();
    registry.register(node);
    setStatus('grey', 'dot', `${node.exposedTools.length} tool(s)`);

    // Called by the engine for every exposed tool: there is no flow to run, the result comes
    // straight from the MCP server, so the node resolves the call itself.
    node._execute = async function execute(toolName, input) {
      const connection = connectionNode();
      if (!connection) {
        throw new Error('The MCP client tool has no connection configured');
      }
      flashStatus('blue', 'dot', toolName || 'calling');
      let tools;
      try {
        // Connecting or listing the catalog is a configuration problem, so it does stop the run.
        ({ tools } = await connection.getAdapter());
      } catch (error) {
        setStatus('red', 'ring', 'error');
        node.error(error);
        throw error;
      }
      const tool = tools.find((candidate) => candidate.name === toolName);
      if (!tool) {
        const error = new Error(`The MCP server does not offer "${toolName}" any more: refresh the connection`);
        setStatus('red', 'ring', 'error');
        node.error(error);
        throw error;
      }
      try {
        const result = await tool.invoke(input);
        flashStatus('green', 'dot', 'returned');
        return resultText(result);
      } catch (error) {
        // A tool that fails is part of the conversation, not a crash: the server said the call
        // could not be completed (a missing document, a bad query, a rate limit). The reason
        // goes back to the model as the tool result, so the agent can retry or answer, exactly
        // like a Tool node does with invalid arguments.
        setStatus('yellow', 'ring', 'tool error');
        node.warn(`${toolName}: ${error.message}`);
        return `Tool "${toolName}" failed: ${error.message}`;
      }
    };

    // The catalog may change in the connection (Discover tools and save): refresh the
    // registration so the Agent sees the new list without touching this node.
    node.refresh = function refresh() {
      node.exposedTools = exposedTools();
      registry.register(node);
      setStatus('grey', 'dot', `${node.exposedTools.length} tool(s)`);
    };

    node.on('input', function onInput(msg, send, done) {
      // Tool calls are executed through _execute by the engine; a message arriving here means
      // the node was wired but never registered, so report it instead of failing silently.
      // node.warn('This node only works wired to the Agent tool-calls output; no call was executed');
      if (typeof done === 'function') {
        done();
      }
    });

    node.on('close', function onClose(removed, done) {
      if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }
      setStatus();
      if (removed) {
        registry.unregister(node.id);
      }
      done();
    });
  }

  RED.nodes.registerType('mcp-client-tool', McpClientToolNode);
};

module.exports.parseExposed = parseExposed;
module.exports.resultText = resultText;
