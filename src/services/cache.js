import { GetCommand } from '@aws-sdk/lib-dynamodb';
import dynamo, { TABLE } from '../config/dynamo-schema.js';
import redis from './redis.js';
import { LRUCache } from 'lru-cache';

const CACHE_TTL_SECONDS         = parseInt(process.env.CACHE_TTL_SECONDS   || '86400', 10);
const PENDING_CACHE_TTL_SECONDS = parseInt(process.env.PENDING_CACHE_TTL_S || '30',    10);

// Increased to 50k for 5M+ req/day — popular URLs stay hot in every instance.
const localCache = new LRUCache({
  max: 50_000,
  ttl: CACHE_TTL_SECONDS * 1000,
});

function shouldUseLocalCache(itemOrTier) {
  const tier = typeof itemOrTier === "string"
    ? itemOrTier
    : itemOrTier?.tier;

  // Premium links can be paused/rerouted at runtime.
  // Keep them out of per-instance memory cache to avoid stale redirects.
  return tier !== "PREMIUM";
}

/**
 * Parse a Redis value that may be:
 *  - Current format : JSON  { url, safetyStatus, tier }
 *  - Legacy format  : JSON  { url, safetyStatus }       (tier defaults to UNKNOWN)
 *  - Ancient format : plain URL string                   (backward-compatible; SAFE + UNKNOWN)
 *
 * UNKNOWN tiers are revalidated against DynamoDB in getUrlWithCache so
 * legacy cache entries are upgraded without waiting for TTL expiry.
 */
function parseItem(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.url === 'string') {
      return {
        url:          parsed.url,
        safetyStatus: parsed.safetyStatus || 'SAFE',
        tier:         parsed.tier || 'UNKNOWN',
      };
    }
  } catch {
    if (typeof raw === 'string') {
      return { url: raw, safetyStatus: 'SAFE', tier: 'UNKNOWN' };
    }
  }
  return null;
}

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Synchronous L1-only peek — used by redirect.js to skip the bloom filter
 * and Redis entirely on an in-process cache hit.
 * Returns { url, safetyStatus, tier } or null.
 */
export function checkL1(id) {
  const item = localCache.get(id) ?? null;
  if (!item) return null;

  if (!shouldUseLocalCache(item)) {
    localCache.delete(id);
    return null;
  }

  return item;
}

/**
 * Fetch from DynamoDB only (no cache). Returns { url, safetyStatus, tier } or null.
 */
export async function fetchFromDynamo(id) {
  const { Item } = await dynamo.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: `URL#${id}`, SK: 'META' },
      ProjectionExpression: 'originalUrl, safetyStatus, tier, userId, isActive',
    })
  );
  if (!Item?.originalUrl) return null;

  // Respect the isActive flag — deactivated links return null
  if (Item.isActive === false) return null;

  return {
    url:          Item.originalUrl,
    safetyStatus: Item.safetyStatus || 'SAFE',
    tier:         Item.tier || (Item.userId ? 'PREMIUM' : 'ANONYMOUS'),
  };
}

/**
 * Full cache-first lookup: L1 → L2 Redis → DynamoDB.
 * Returns { url, safetyStatus, tier, cacheStatus }.
 */
export async function getUrlWithCache(id) {
  // ── L1: in-process LRU ────────────────────────────────────────────────────
  const l1Hit = checkL1(id);
  if (l1Hit) return { ...l1Hit, cacheStatus: 'L1_HIT' };

  // ── L2: Redis ─────────────────────────────────────────────────────────────
  try {
    const cached = await redis.get(`url:${id}`);
    if (cached) {
      let item = parseItem(cached);

      if (item?.tier === 'UNKNOWN') {
        const resolved = await fetchFromDynamo(id);

        if (!resolved) {
          redis.del(`url:${id}`).catch(() => {});
          return { url: null, safetyStatus: null, tier: null, cacheStatus: 'MISS' };
        }

        item = resolved;
        const ttl = item.safetyStatus === 'PENDING' ? PENDING_CACHE_TTL_SECONDS : CACHE_TTL_SECONDS;
        redis.setex(`url:${id}`, ttl, JSON.stringify(item)).catch(() => {});
      }

      if (item) {
        // Refresh TTL for settled items; let PENDING expire naturally (short TTL).
        if (item.safetyStatus !== 'PENDING') {
          redis.expire(`url:${id}`, CACHE_TTL_SECONDS).catch(() => {});
          if (shouldUseLocalCache(item)) {
            localCache.set(id, item);
          }
        }
        return { ...item, cacheStatus: 'HIT' };
      }
    }
  } catch (cacheErr) {
    console.warn('[cache] Redis error, falling back to DynamoDB:', cacheErr?.message || cacheErr);
  }

  // ── L3: DynamoDB ──────────────────────────────────────────────────────────
  const item = await fetchFromDynamo(id);
  if (!item) return { url: null, safetyStatus: null, tier: null, cacheStatus: 'MISS' };

  if (shouldUseLocalCache(item)) {
    localCache.set(id, item);
  }
  const ttl = item.safetyStatus === 'PENDING' ? PENDING_CACHE_TTL_SECONDS : CACHE_TTL_SECONDS;
  redis.setex(`url:${id}`, ttl, JSON.stringify(item)).catch(() => {});

  return { ...item, cacheStatus: 'MISS' };
}

/**
 * Warm both L1 and L2 caches immediately after URL creation or safety update.
 * Uses a short TTL for PENDING so the safety-check result propagates quickly.
 */
export async function warmCache(id, url, safetyStatus = 'PENDING', tier = 'ANONYMOUS') {
  const item = { url, safetyStatus, tier };
  if (shouldUseLocalCache(tier)) {
    localCache.set(id, item);
  }
  const ttl = safetyStatus === 'PENDING' ? PENDING_CACHE_TTL_SECONDS : CACHE_TTL_SECONDS;
  return redis.setex(`url:${id}`, ttl, JSON.stringify(item));
}

/**
 * Evict a URL from both cache layers.
 * Call this whenever safetyStatus changes, a URL is deleted, or
 * a premium user updates their link.
 */
export async function invalidateCache(id) {
  localCache.delete(id);
  return redis.del(`url:${id}`).catch(() => {});
}
