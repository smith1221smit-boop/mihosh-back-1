// One-off maintenance script: removes response-cache entries poisoned by the
// res.json-caches-error-bodies bug (fixed in middleware/cache.js). Only
// deletes entries whose cached value looks like an error body (a plain
// object with an `error` field, not the array shape every real
// rounds/matches/etc. response actually has) — everything else is left
// untouched. Safe to delete after running.
require('dotenv').config();
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const looksPoisoned = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof value.error === 'string';
};

(async () => {
  const keys = await redis.keys('cache:*');
  console.log(`Scanning ${keys.length} cache key(s)...`);

  if (keys.length === 0) {
    console.log('Nothing cached — nothing to do.');
    return;
  }

  const values = await redis.mget(...keys);
  const poisoned = keys.filter((_, i) => looksPoisoned(values[i]));

  console.log(`Found ${poisoned.length} poisoned entr${poisoned.length === 1 ? 'y' : 'ies'}.`);
  poisoned.forEach((k, i) => console.log(' -', k, JSON.stringify(values[keys.indexOf(k)])));

  if (poisoned.length > 0) {
    await redis.del(...poisoned);
    console.log(`Deleted ${poisoned.length} poisoned entr${poisoned.length === 1 ? 'y' : 'ies'}.`);
  }
})().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
