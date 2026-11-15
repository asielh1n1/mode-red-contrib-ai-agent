'use strict';

const { MemorySaver } = require('@langchain/langgraph');
const { PostgresSaver } = require('@langchain/langgraph-checkpoint-postgres');

const checkpointers = new WeakMap();

// Memory kinds, in the order the editor lists them. "ram" is kept for flows saved before the
// storage selector had other options.
const MEMORY_KINDS = ['ram', 'postgres', 'redis'];

function memoryKindOf(memoryNode) {
  const kind = memoryNode && memoryNode.memoryKind;
  return MEMORY_KINDS.includes(kind) ? kind : 'ram';
}

// How many messages of a session are kept. 0 (or an empty/invalid value) means "no limit", so
// flows saved before this option existed keep their behaviour.
function contextWindowOf(memoryNode) {
  const value = Number(memoryNode && memoryNode.contextWindow);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function databaseUrl(memoryNode) {
  const url = String(memoryNode.resolvedDatabaseUrl || memoryNode.databaseUrl || '').trim();
  if (!url) {
    throw new Error('PostgreSQL connection string is not configured');
  }
  if (!memoryNode.databasePassword) {
    return url;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('The PostgreSQL connection string is not a valid URL');
  }
  if (parsed.password) {
    return url;
  }
  parsed.password = memoryNode.databasePassword;
  return parsed.toString();
}

// The URL is a typed value, so the Agent evaluates it per message and leaves it here. `url` is
// the field the Agent resolves for every memory node, whatever the storage.
function redisUrl(memoryNode) {
  const url = String(memoryNode.resolvedDatabaseUrl || memoryNode.url || '').trim();
  if (!url) {
    throw new Error('Redis connection URL is not configured');
  }
  if (!/^rediss?:\/\//i.test(url)) {
    throw new Error('The Redis URL must start with redis:// or rediss://');
  }
  return url;
}

// One checkpointer per Memory config node. Postgres setup() is memoised so concurrent
// Agent invocations do not race while creating the checkpoint tables.
//
// A Full deploy stops every flow and creates brand new node instances, so keying only on the
// instance would throw away the in-process conversations. The entry is also remembered by the
// config node id, which survives the redeploy: that is the only way an "in Node-RED" memory can
// keep its threads when the whole flow is redeployed.
const byId = new Map();

function keyOf(memoryNode) {
  return memoryNode && memoryNode.id ? String(memoryNode.id) : null;
}

function adopt(memoryNode, entry) {
  checkpointers.set(memoryNode, entry);
  const key = keyOf(memoryNode);
  if (key) {
    byId.set(key, entry);
  }
  return entry;
}

// Builds the saver for a storage kind. `ready` resolves once the storage can be used: Postgres
// creates its tables and Redis connects and validates the RediSearch module.
function createSaver(kind, url, memoryNode) {
  if (kind === 'postgres') {
    const saver = PostgresSaver.fromConnString(url);
    const schema = memoryNode.memorySchema || 'public';
    return {
      saver,
      ready: Promise.resolve().then(() => (schema === 'public' ? saver.setup() : saver.setup({ schema }))),
    };
  }
  if (kind === 'redis') {
    return { saver: null, ready: require('@langchain/langgraph-checkpoint-redis').RedisSaver.fromUrl(url) };
  }
  return { saver: new MemorySaver(), ready: Promise.resolve() };
}

function getCheckpointer(memoryNode, { keepAcrossDeploy = true } = {}) {
  if (!memoryNode) {
    return Promise.resolve(null);
  }
  const kind = memoryKindOf(memoryNode);
  let url = '';
  try {
    if (kind === 'postgres') {
      url = databaseUrl(memoryNode);
    } else if (kind === 'redis') {
      url = redisUrl(memoryNode);
    }
  } catch (error) {
    // A misconfigured connection is reported to the Agent like any other checkpointer failure.
    return Promise.reject(error);
  }
  const key = keepAcrossDeploy ? keyOf(memoryNode) : null;
  let entry = checkpointers.get(memoryNode) || (key ? byId.get(key) : null);
  // A changed connection (typed values can be dynamic) rebuilds the checkpointer.
  const stale = entry && (entry.kind !== kind || ((kind === 'postgres' || kind === 'redis') && entry.url !== url));
  if (stale) {
    // The replaced entry may own a socket (Redis) or a pool (Postgres): release it.
    releaseSaver(entry);
    entry = null;
  }
  if (!entry) {
    const built = createSaver(kind, url, memoryNode);
    entry = { kind, url, saver: built.saver, ready: null };
    entry.ready =
      built.saver === null
        ? // Redis resolves its client asynchronously: keep the saver on the entry for close().
          built.ready.then((saver) => {
            entry.saver = saver;
            return saver;
          })
        : built.ready.then(() => entry.saver);
    adopt(memoryNode, entry);
    entry.ready.catch(() => {
      if (checkpointers.get(memoryNode) === entry) {
        checkpointers.delete(memoryNode);
      }
      if (key && byId.get(key) === entry) {
        byId.delete(key);
      }
    });
  } else {
    checkpointers.set(memoryNode, entry);
  }
  return entry.ready;
}

function releaseSaver(entry) {
  if (!entry) {
    return;
  }
  Promise.resolve()
    .then(() => entry.ready)
    .catch(() => {})
    .then(() => {
      const saver = entry.saver;
      // Postgres and Redis expose end(); the in-process saver has nothing to release.
      if (saver && typeof saver.end === 'function') {
        return saver.end();
      }
      return undefined;
    })
    .catch(() => {});
}

async function closeCheckpointer(memoryNode) {
  const entry = checkpointers.get(memoryNode);
  if (!entry) {
    return;
  }
  checkpointers.delete(memoryNode);
  const key = keyOf(memoryNode);
  if (key && byId.get(key) === entry) {
    byId.delete(key);
  }
  const saver = await entry.ready.catch(() => null);
  if (saver && typeof saver.end === 'function') {
    await saver.end();
  }
}

// Opens a throwaway checkpointer, makes sure the storage is usable and closes it. Used by the
// editor test button: it never touches the connection of the deployed node and needs no node id.
async function checkConnection(memoryNode) {
  const kind = memoryKindOf(memoryNode);
  if (kind === 'ram') {
    return true;
  }
  if (kind === 'postgres') {
    const saver = PostgresSaver.fromConnString(databaseUrl(memoryNode));
    const schema = memoryNode.memorySchema || 'public';
    try {
      await (schema === 'public' ? saver.setup() : saver.setup({ schema }));
    } finally {
      if (typeof saver.end === 'function') {
        await saver.end().catch(() => {});
      }
    }
    return true;
  }
  const { RedisSaver } = require('@langchain/langgraph-checkpoint-redis');
  const saver = await RedisSaver.fromUrl(redisUrl(memoryNode));
  try {
    // Indexes and the RediSearch module are validated on the first write/read; listing the
    // threads is enough to prove the connection and the module are both usable.
    for await (const _ of saver.list(null, { limit: 1 })) {
      break;
    }
  } finally {
    await saver.end().catch(() => {});
  }
  return true;
}

module.exports = {
  MEMORY_KINDS,
  memoryKindOf,
  contextWindowOf,
  getCheckpointer,
  closeCheckpointer,
  checkConnection,
};
