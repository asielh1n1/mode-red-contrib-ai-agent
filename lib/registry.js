'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const TOOL_RESULT_TYPE = 'ai-agents/tool-result';

const instance = new WeakMap();
const executionContext = new AsyncLocalStorage();

function toPosixPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function normalizeToolName(value) {
  return String(value || '').trim().toLowerCase();
}

// Providers only accept tool names made of letters, digits and underscores, starting with a
// letter, so the editor stores a technical name next to the human one. Accents are folded
// ("Revisión" -> "revision") instead of dropped, and the result is snake_case.
const MAX_TOOL_NAME = 64;

function snakeCase(value) {
  // Accents are folded first, because the word separator below would split on the accented
  // letter itself. Folding keeps the case ("Revisión" -> "Revision"), so the camelCase rule
  // still works and no word boundary is invented.
  const folded = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const words = folded
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return words.join('_').toLowerCase();
}

// A human name becomes a valid tool name: "Buscar gastos" -> "buscar_gastos". When the result
// is empty or does not start with a letter it is prefixed, and the length the API accepts is
// enforced, so the model never receives a name it would reject.
function toolNameFrom(humanName, fallback = 'tool') {
  let name = snakeCase(humanName);
  if (name && !/^[a-z]/.test(name)) {
    name = `${fallback}_${name}`.replace(/[^a-z0-9_]/g, '');
  }
  name = name.slice(0, MAX_TOOL_NAME);
  return name || fallback;
}

function isInsideSubflow(node) {
  return Boolean(node?.z && String(node.z).startsWith('subflow:'));
}

function workflowName(node) {
  if (!node || !node.z) {
    return '';
  }
  const tab = instance.get(node)?.RED?.nodes?.getWorkspace?.(node.z);
  return tab?.label || tab?.name || node.z;
}

function declaredEntry(toolNode) {
  return {
    id: toolNode.id,
    type: 'ai-tool',
    name: String(toolNode.name || '').trim(),
    toolName: toolNode.toolName || toolNameFrom(toolNode.name, 'tool'),
    description: String(toolNode.description || '').trim(),
    parameters: toolNode.parameters || { type: 'object', properties: {} },
    flowId: toolNode.z || '',
  };
}

// An MCP client node represents a whole server: it exposes one tool per entry in
// `toolNode.exposedTools` (name, description and JSON Schema discovered from the server).
function exposedEntries(toolNode) {
  const exposed = Array.isArray(toolNode.exposedTools) ? toolNode.exposedTools : [];
  return exposed
    .filter((entry) => entry && entry.name)
    .map((entry) => ({
      id: toolNode.id,
      type: 'ai-tool',
      name: String(entry.name).trim(),
      description: String(entry.description || '').trim(),
      parameters: entry.parameters || { type: 'object', properties: {} },
      flowId: toolNode.z || '',
      mcp: true,
      mcpTool: entry.tool,
    }));
}

  // An MCP client node represents a whole server: it exposes one tool per entry in
  // `toolNode.exposedTools` (name, description and JSON Schema discovered from the server).
  function exposedEntries(toolNode) {
    const exposed = Array.isArray(toolNode.exposedTools) ? toolNode.exposedTools : [];
    return exposed
      .filter((entry) => entry && entry.name)
      .map((entry) => ({
        id: toolNode.id,
        type: isMcpClient(toolNode) ? 'mcp-client-tool' : 'ai-tool',
        name: String(entry.name).trim(),
        description: String(entry.description || '').trim(),
        parameters: entry.parameters || { type: 'object', properties: {} },
        flowId: toolNode.z || '',
        mcp: isMcpClient(toolNode),
        mcpTool: entry.tool,
      }));
  }

  function isMcpClient(node) {
    return Boolean(node) && node.type === 'mcp-client-tool';
  }

  function isSubagent(node) {
    return Boolean(node) && node.type === 'ai-subagent';
  }

  function isExposedToolNode(node) {
    return Boolean(node) && (node.type === 'ai-tool' || isMcpClient(node) || isSubagent(node));
  }

  function createToolRegistry() {
    const tools = new Map();
    const declared = new Map();

    function entriesOf(node) {
      if (!node) {
        return [];
      }
      if (isMcpClient(node)) {
        return exposedEntries(node).map((entry) => ({ ...entry, owner: node }));
      }
      if (node.type === 'ai-tool') {
        return [{ ...declaredEntry(node), owner: node }];
      }
      if (isSubagent(node)) {
        // A subagent is one tool for its parent; its own tools are wired to its output.
        return [{ ...declaredEntry(node), owner: node, subagent: true }];
      }
      return [];
    }

    function register(node) {
      if (!node || !node.id || !isExposedToolNode(node)) {
        return null;
      }
      const entries = entriesOf(node);
      const list = entries.length ? entries : [{ ...declaredEntry(node), owner: node }];
      tools.set(node.id, list);
      declared.set(node.id, list);
      return list;
    }

    function nameIsValid(name) {
      return TOOL_NAME_PATTERN.test(String(name || ''));
    }

    function unregister(nodeId) {
      tools.delete(nodeId);
      declared.delete(nodeId);
    }

    function registerDeclared(toolNode) {
      if (isExposedToolNode(toolNode) && toolNode.id) {
        const entries = entriesOf(toolNode);
        declared.set(toolNode.id, entries.length ? entries : [{ ...declaredEntry(toolNode), owner: toolNode }]);
      }
    }

    function unregisterDeclared(toolNodeId) {
      declared.delete(toolNodeId);
    }

  function nodeById(agentNode, nodeId) {
    const RED = instance.get(agentNode)?.RED;
    if (!RED || !nodeId) {
      return null;
    }
    return RED.nodes.getNode(nodeId) || null;
  }

  function isToolLike(candidate) {
    if (!candidate) {
      return false;
    }
    return isExposedToolNode(candidate) || candidate.type === 'subflow';
  }

  // The output that carries tool calls: the second one on an Agent, the only one on a subagent.
  function toolOutputOf(node) {
    const wires = Array.isArray(node && node.wires) ? node.wires : [];
    const index = node && node.type === 'ai-subagent' ? 0 : 1;
    return wires[index] || [];
  }

  // Tools are the ones wired to the Agent's tool-call output, following wires through
  // switches, link nodes and subflows. The wiring is the only source of truth.
  function connectedTo(agentNode) {
    const RED = instance.get(agentNode)?.RED;
    if (!agentNode || !RED) {
      return [];
    }
    const visited = new Set();
    const found = new Map();
    const queue = [agentNode];
    visited.add(agentNode.id);
    while (queue.length) {
      const current = queue.shift();
      const output = toolOutputOf(current);
      for (const nodeId of output) {
        const candidate = nodeById(agentNode, nodeId);
        if (!candidate || visited.has(candidate.id)) {
          continue;
        }
        visited.add(candidate.id);
        if (isToolLike(candidate)) {
          addTool(agentNode, candidate, found);
          continue;
        }
        if (candidate.type === 'link out') {
          // Link out forwards to the link in nodes with the same name in this flow.
          for (const target of linkTargets(agentNode, candidate)) {
            queue.push(target);
          }
          continue;
        }
        queue.push(candidate);
      }
    }
    return [...found.values()].flat();
  }

  function linkTargets(agentNode, linkOut) {
    const RED = instance.get(agentNode)?.RED;
    const flowId = linkOut.z;
    const name = linkOut.links || linkOut.name;
    const targets = [];
    if (typeof RED.nodes.eachNode !== 'function') {
      return targets;
    }
    RED.nodes.eachNode((candidate) => {
      if (candidate.type === 'link in' && candidate.z === flowId && (candidate.links || candidate.name) === name) {
        targets.push(candidate);
      }
    });
    return targets;
  }

  function addTool(agentNode, candidate, found) {
    if (isExposedToolNode(candidate)) {
      if (!tools.has(candidate.id)) {
        return;
      }
      if (tools.get(candidate.id).length > 1) {
        // A node that publishes one tool per entry (an MCP client) is keyed by node, as before.
        found.set(candidate.id, tools.get(candidate.id));
        return;
      }
      for (const entry of tools.get(candidate.id)) {
        found.set(`${candidate.id}:${entry.toolName || entry.name}`, entry);
      }
      return;
    }
    for (const instanceNode of subflowTools(agentNode, candidate)) {
      found.set(instanceNode.id, instanceNode);
    }
  }

  // A subflow connected to the Agent runs its internal Tool nodes once per placement.
  function subflowTools(agentNode, subflowNode) {
    const RED = instance.get(agentNode)?.RED;
    const found = [];
    if (typeof RED?.nodes.eachNode !== 'function') {
      return found;
    }
    const workspace = RED.nodes.getWorkspace(subflowNode.id);
    for (const candidate of Object.values(workspace?.nodes || {})) {
      if (candidate && isExposedToolNode(candidate) && tools.has(candidate.id)) {
        found.push(...tools.get(candidate.id));
      }
    }
    return found;
  }

  function describe(entry, agentNode) {
    const owner = entry.owner || {};
    const RED = instance.get(agentNode)?.RED;
    return {
      id: entry.id,
      name: entry.name,
      toolName: entry.toolName || '',
      description: entry.description,
      mcp: Boolean(entry.mcp),
      subagent: Boolean(entry.subagent),
      ownerName: owner.name || '',
      sameFlow: Boolean(agentNode && (owner.z === agentNode.z || String(owner.z || '').startsWith('subflow:'))),
      flowName: owner.z ? (RED?.nodes.getWorkspace?.(owner.z)?.label || owner.z) : '',
    };
  }

  // Editor payload: the tools the Agent can call plus, when an Agent is given, the other
  // tools of its flow, so the dialog can point out missing wires.
  function listForAgent(agentNode) {
    const ids = new Set(connectedTo(agentNode).map((entry) => entry.id));
    const result = [];
    for (const entries of tools.values()) {
      for (const entry of entries) {
        const sameFlow = Boolean(agentNode && entry.owner?.z === agentNode.z);
        if (ids.has(entry.id) || sameFlow) {
          result.push({ ...describe(entry, agentNode), connected: ids.has(entry.id) });
        }
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  return {
    register,
    unregister,
    registerDeclared,
    unregisterDeclared,
    connectedTo,
    listForAgent,
    nameIsValid,
  };
}
const registry = createToolRegistry();

function bindInstance(node, RED) {
  if (node) {
    instance.set(node, { RED });
  }
}

function instanceOf(node) {
  return instance.get(node) || {};
}

module.exports = {
  TOOL_NAME_PATTERN,
  TOOL_RESULT_TYPE,
  registry,
  bindInstance,
  instanceOf,
  workflowName,
  normalizeToolName,
  toolNameFrom,
  snakeCase,
  isInsideSubflow,
  executionContext,
  toPosixPath,
};








