'use strict';

class AiAgentsError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AiAgentsError';
    this.code = code;
    this.details = options.details;
    this.cause = options.cause;
  }
}

function invalidConfig(message) {
  return new AiAgentsError('AI_AGENTS_INVALID_CONFIG', message);
}

function invalidMessage(message) {
  return new AiAgentsError('AI_AGENTS_INVALID_MESSAGE', message);
}

function wrapModelError(error) {
  const message = error?.message || String(error);
  return new AiAgentsError('AI_AGENTS_MODEL_ERROR', `Model request failed: ${message}`, { cause: error });
}

function wrapCheckpointerError(error) {
  if (error instanceof AiAgentsError) {
    return error;
  }
  let detail = error?.code ? `${error.code}${error.message ? ` (${error.message})` : ''}` : error?.message || String(error);
  if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOTFOUND') {
    detail = `${error.code}: the database is unreachable`;
  }
  return new AiAgentsError(
    'AI_AGENTS_CHECKPOINTER_ERROR',
    `Conversation memory is unavailable: ${detail}. Check the PostgreSQL memory configuration.`,
    { cause: error },
  );
}

module.exports = {
  AiAgentsError,
  invalidConfig,
  invalidMessage,
  wrapModelError,
  wrapCheckpointerError,
};
