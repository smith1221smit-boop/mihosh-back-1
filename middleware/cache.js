const { Redis } = require('@upstash/redis');
const { encodeMsgpack } = require('../utils/msgpackCodec');

let getCache, setCache, deleteCache, invalidateScope, invalidateKeysByPrefix, cacheMiddleware, msgpackCacheMiddleware, invalidateCacheMiddleware;

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.warn('⚠️  Missing Redis env vars - using memory cache only');

  const memoryCache = new Map();
  const memoryScopeIndex = new Map(); // scope -> Set(keys)

  getCache = async (key) => memoryCache.get(key) ?? null;

  setCache = async (key, value, ttlSeconds = 300, scope = 'anon') => {
    memoryCache.set(key, value);
    if (!memoryScopeIndex.has(scope)) memoryScopeIndex.set(scope, new Set());
    memoryScopeIndex.get(scope).add(key);
    setTimeout(() => {
      memoryCache.delete(key);
      memoryScopeIndex.get(scope)?.delete(key);
    }, ttlSeconds * 1000);
  };

  deleteCache = async (key) => memoryCache.delete(key);

  invalidateScope = async (scope) => {
    const keys = memoryScopeIndex.get(scope);
    if (keys) {
      for (const k of keys) memoryCache.delete(k);
      memoryScopeIndex.delete(scope);
    }
  };

  invalidateKeysByPrefix = async () => {};

  cacheMiddleware = () => (req, res, next) => next();
  msgpackCacheMiddleware = () => (req, res, next) => next();
  invalidateCacheMiddleware = () => (req, res, next) => next();

  module.exports = { getCache, setCache, deleteCache, invalidateScope, invalidateKeysByPrefix, cacheMiddleware, msgpackCacheMiddleware, invalidateCacheMiddleware };
  return;
}

const redisClient = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

(async () => {
  try {
    await redisClient.ping();
    console.log('✅ Upstash Redis connected');
  } catch (err) {
    console.error('❌ Upstash Redis connection failed:', err.message);
    process.exit(1);
  }
})();

// In-process fallback used only if a Redis call fails at runtime
const memoryCache = new Map();
const memoryScopeIndex = new Map(); // scope -> Set(keys)

const trackMemoryKey = (scope, key, ttlSeconds) => {
  if (!memoryScopeIndex.has(scope)) memoryScopeIndex.set(scope, new Set());
  memoryScopeIndex.get(scope).add(key);
  setTimeout(() => {
    memoryCache.delete(key);
    memoryScopeIndex.get(scope)?.delete(key);
  }, ttlSeconds * 1000);
};

getCache = async (key) => {
  try {
    const value = await redisClient.get(key);
    return value ?? null;
  } catch (error) {
    console.warn('Cache get error, using memory:', error.message);
    return memoryCache.get(key) ?? null;
  }
};

setCache = async (key, value, ttlSeconds = 300, scope = 'anon') => {
  try {
    await redisClient.set(key, value, { ex: ttlSeconds });
    await redisClient.sadd(`cache:keys:${scope}`, key);
    await redisClient.expire(`cache:keys:${scope}`, ttlSeconds + 60);
  } catch (error) {
    console.warn('Cache set error, falling back to memory:', error.message);
    memoryCache.set(key, value);
    trackMemoryKey(scope, key, ttlSeconds);
  }
};

deleteCache = async (key) => {
  console.log('Deleting:', key);
  try {
    await redisClient.del(key);
  } catch (error) {
    console.warn('Cache delete error:', error.message);
  }
  memoryCache.delete(key); // clear memory copy too, regardless of Redis outcome
};

invalidateScope = async (scope) => {
  try {
    const keys = await redisClient.smembers(`cache:keys:${scope}`);
    if (keys.length) await redisClient.del(...keys);
    await redisClient.del(`cache:keys:${scope}`);
  } catch (error) {
    console.warn('Cache scope invalidation error:', error.message);
  }
  // Always clear the memory-fallback copy for this scope too,
  // in case some entries were only ever written to memory.
  const memKeys = memoryScopeIndex.get(scope);
  if (memKeys) {
    for (const k of memKeys) memoryCache.delete(k);
    memoryScopeIndex.delete(scope);
  }
};

// Surgical version of invalidateScope: only clears keys for this scope whose
// path (the part of the key after `cache:<scope>:`) starts with one of the
// given prefixes, instead of every cached GET the user has. Call sites pass
// prefixes like 'cache:/api/teams' (a leftover from an older, scope-less key
// format) — strip the leading 'cache:' back off so it matches today's real
// `cache:<scope>:<originalUrl>` keys.
invalidateKeysByPrefix = async (scope, prefixes) => {
  const paths = prefixes
    .map(p => (typeof p === 'string' && p.startsWith('cache:')) ? p.slice(6) : p)
    .filter(Boolean);
  if (!paths.length) return;

  try {
    const allKeys = await redisClient.smembers(`cache:keys:${scope}`);
    const toDelete = allKeys.filter(k => paths.some(p => k.startsWith(`cache:${scope}:${p}`)));
    if (toDelete.length) {
      await redisClient.del(...toDelete);
      await redisClient.srem(`cache:keys:${scope}`, ...toDelete);
    }
  } catch (error) {
    console.warn('Prefix cache invalidation error:', error.message);
  }

  const memKeys = memoryScopeIndex.get(scope);
  if (memKeys) {
    for (const k of [...memKeys]) {
      if (paths.some(p => k.startsWith(`cache:${scope}:${p}`))) {
        memoryCache.delete(k);
        memKeys.delete(k);
      }
    }
  }
};

// Must run AFTER session middleware in server.js, so req.session is populated.
// scopeFn(req), when given, replaces the default session-based scope — used
// by routes whose data is written outside the normal request/response cycle
// (e.g. the live PUBG-API pipeline writing straight to MongoDB), so the write
// path can invalidate by a resource id (matchId/roundId) instead of needing
// to know which user sessions happen to have it cached.
cacheMiddleware = (ttlSeconds = 300, scopeFn = null) => {
  return async (req, res, next) => {
    if (req.method !== 'GET') return next();

    const scope = scopeFn ? scopeFn(req) : (req.session?.userId?.toString() || req.sessionID || 'anon');
    const key = `cache:${scope}:${req.originalUrl}`;

    const cached = await getCache(key);
    if (cached) {
      console.log('CACHE HIT:', key);
      return res.json(cached);
    }

    const originalJson = res.json;
    res.json = function (data) {
      console.log('CACHE SAVE:', key);
      setCache(key, data, ttlSeconds, scope).catch(console.warn);
      originalJson.call(this, data);
    };

    next();
  };
};

// Same hit/miss/setCache behavior as cacheMiddleware above (cache still
// stores the plain JS object under the same key scheme, so bustCache/
// invalidateScope in comsock.js need no changes), but the response body is
// MessagePack-encoded instead of JSON on both the hit and miss paths.
msgpackCacheMiddleware = (ttlSeconds = 300, scopeFn = null) => {
  return async (req, res, next) => {
    if (req.method !== 'GET') return next();

    const scope = scopeFn ? scopeFn(req) : (req.session?.userId?.toString() || req.sessionID || 'anon');
    const key = `cache:${scope}:${req.originalUrl}`;

    const cached = await getCache(key);
    if (cached) {
      console.log('CACHE HIT:', key);
      res.set('Content-Type', 'application/msgpack');
      return res.send(encodeMsgpack(cached));
    }

    res.json = function (data) {
      console.log('CACHE SAVE:', key);
      setCache(key, data, ttlSeconds, scope).catch(console.warn);
      res.set('Content-Type', 'application/msgpack');
      res.send(encodeMsgpack(data));
    };

    next();
  };
};

// When a route passes a key-list (or a function returning one), only clear
// the matching cache entries. When it doesn't, fall back to clearing EVERY
// cached GET for the acting user in one shot, so no route can ever be
// "forgotten" and left stale — that fallback is the safety net this used to
// always do; the key-list path just makes it surgical when a call site
// bothers to specify what actually changed.
invalidateCacheMiddleware = (keysOrFn) => {
  return async (req, res, next) => {
    if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return next();

    const scope = req.session?.userId?.toString() || req.sessionID || 'anon';
    const keys = typeof keysOrFn === 'function' ? keysOrFn(req) : keysOrFn;

    if (Array.isArray(keys) && keys.length) {
      await invalidateKeysByPrefix(scope, keys);
    } else {
      await invalidateScope(scope);
    }
    next();
  };
};

module.exports = { getCache, setCache, deleteCache, invalidateScope, invalidateKeysByPrefix, cacheMiddleware, msgpackCacheMiddleware, invalidateCacheMiddleware };