'use strict';

const { createAgentModel } = require('./agent-config');
const { AiAgentsError } = require('./errors');
const { checkRules, compilePatterns, parseVerdict, textOf, buildPrompt } = require('./guardrails-rules');
const { bindInstance } = require('./registry');

const STATUS_HOLD_MS = 1500;
const DEFAULT_TIMEOUT = 8000;

// The answer is a dozen tokens, but a thinking model bills its hidden reasoning to the same
// budget: with 128 it spent all of them reasoning and returned empty content.
const ANSWER_TOKENS = 1024;

// The verdict is written here, next to the original payload: a blocked branch must be able to
// explain the decision without the text that was rejected.
const VERDICT = 'ai-agents/guardrail';

// The rejected text, kept apart when a replacement message is configured. It never goes to the
// pass output, so the agent and its tools cannot see it by accident.
const BLOCKED_PAYLOAD = 'ai-agents/blocked-payload';

module.exports = function registerGuardrails(RED) {
  function GuardrailsNode(config) {
    RED.nodes.createNode(this, config);
    bindInstance(this, RED);
    const node = this;

    node.name = String(config.name || '').trim();
    node.modelNodeId = config.model;
    node.systemPrompt = String(config.systemPrompt || '').trim();
    node.blockedMessage = String(config.blockedMessage || '').trim();
    node.useModel = config.useModel !== false;
    node.maxLength = config.maxLength;
    node.maxPromptLength = config.maxPromptLength;
    node.blockedWords = String(config.blockedWords || '');
    node.blockedPatterns = String(config.blockedPatterns || '');
    node.guardrailTimeout = Number(config.guardrailTimeout) > 0 ? Number(config.guardrailTimeout) : DEFAULT_TIMEOUT;

    // A pattern the user wrote that cannot compile would be silently ignored, so it is reported
    // when the node starts instead of when a message arrives.
    const invalidPatterns = compilePatterns(node.blockedPatterns).invalid;
    if (invalidPatterns.length) {
      node.warn(
        `Ignored ${invalidPatterns.length} invalid pattern(s): ${invalidPatterns.map((entry) => entry.source).join(', ')}`,
      );
    }
    if (node.useModel && !node.modelNodeId) {
      node.warn('Guardrails has no model configured: every message will be blocked (fail-closed)');
    }

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
        setStatus();
      }, STATUS_HOLD_MS);
    }

    // The contract of this node: the text to check always arrives in msg.payload.
    function readText(msg) {
      return textOf(msg.payload);
    }

    // Fail-closed: anything that goes wrong while asking the model blocks the message. A
    // guardrail that lets traffic through when its own model is down protects nothing.
    async function askModel(text) {
      const modelInfo = createAgentModel(node, RED, RED.settings, {
        // The model is the node's own, but the guardrail forces the sampling it needs: a
        // deterministic verdict in a very short answer, never a conversation.
        temperature: 0,
        maxTokens: ANSWER_TOKENS,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), node.guardrailTimeout);
      try {
        const response = await modelInfo.model.invoke(
          [
            // The policy is the user's; the JSON contract is appended by the node so a custom
            // policy cannot leave the answer unparseable.
            { role: 'system', content: buildPrompt(node.systemPrompt) },
            { role: 'user', content: text },
          ],
          { signal: controller.signal },
        );
        return parseVerdict(response.content);
      } finally {
        clearTimeout(timer);
      }
    }

    node.on('input', async function onInput(msg, send, done) {
      const text = readText(msg);
      const emit = (allowed, verdict) => {
        msg[VERDICT] = { allowed, ...verdict };
        if (!allowed && node.blockedMessage) {
          // A short message instead of the rejected text, so the malicious input does not travel
          // down the flow to logs, tools or the agent.
          msg.payload = node.blockedMessage;
          msg[BLOCKED_PAYLOAD] = text;
        }
        send([allowed ? msg : null, allowed ? null : msg]);
      };

      // Rules first: they are free, deterministic, and catch the obvious cases even when no
      // model is configured.
      const rules = checkRules(text, node);
      if (!rules.allowed) {
        flashStatus('red', 'dot', 'blocked');
        emit(false, { source: 'rules', rule: rules.rule, reason: rules.detail, categories: rules.categories });
        if (typeof done === 'function') {
          done();
        }
        return;
      }

      if (!node.useModel) {
        flashStatus('green', 'dot', 'passed');
        emit(true, { source: 'rules', rule: null, reason: '', categories: rules.categories });
        if (typeof done === 'function') {
          done();
        }
        return;
      }

      setStatus('blue', 'dot', 'checking');
      try {
        const verdict = await askModel(text);
        flashStatus(verdict.allowed ? 'green' : 'red', 'dot', verdict.allowed ? 'passed' : 'blocked');
        emit(verdict.allowed, {
          source: 'model',
          rule: null,
          reason: verdict.reason,
          categories: verdict.categories,
        });
        if (typeof done === 'function') {
          done();
        }
      } catch (error) {
        // Every failure blocks: no model, bad JSON, timeout, network. The reason is kept for the
        // blocked branch, never as plain text sent to the agent.
        flashStatus('red', 'dot', 'blocked');
        const wrapped = error instanceof AiAgentsError ? error : new AiAgentsError('AI_AGENTS_GUARDRAIL_ERROR', error?.message || String(error), { cause: error });
        node.warn(wrapped.message);
        emit(false, {
          source: 'model',
          rule: null,
          reason: wrapped.message,
          categories: ['guardrail_error', ...rules.categories],
        });
        if (typeof done === 'function') {
          done();
        }
      }
    });

    node.on('close', function onClose(removed, done) {
      if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }
      setStatus();
      done();
    });

    setStatus();
  }

  RED.nodes.registerType('ai-guardrails', GuardrailsNode);
};
