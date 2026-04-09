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

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a Redis value that may be:
 *  - New format  : JSON  { url, safetyStatus }
 *  - Legacy format: plain URL string (backward-compatible; treated as SAFE)
 */
function parseItem(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.url === 'string') return parsed;
  } catch {
    if (typeof raw === 'string') return { url: raw, safetyStatus: 'SAFE' };
  }
  return null;
}

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Synchronous L1-only peek — used by redirect.js to skip the bloom filter
 * and Redis entirely on an in-process cache hit.
 * Returns { url, safetyStatus } or null.
 */
export function checkL1(id) {
  return localCache.get(id) ?? null;
}

/**
 * Fetch from DynamoDB only (no cache). Returns { url, safetyStatus } or null.
 */
export async function fetchFromDynamo(id) {
  const { Item } = await dynamo.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: `URL#${id}`, SK: 'META' },
      ProjectionExpression: 'originalUrl, safetyStatus',
    })
  );
  if (!Item?.originalUrl) return null;
  return { url: Item.originalUrl, safetyStatus: Item.safetyStatus || 'SAFE' };
}

/**
 * Full cache-first lookup: L1 → L2 Redis → DynamoDB.
 * Returns { url, safetyStatus, cacheStatus }.
 *
 * NOTE: Bloom-filter gating is kept in redirect.js so that L1 hits skip
 * the bloom filter Redis call entirely — the single biggest hot-path
 * optimisation for 5M+ req/day.
 */
export async function getUrlWithCache(id) {
  // ── L1: in-process LRU ────────────────────────────────────────────────────
  const l1Hit = localCache.get(id);
  if (l1Hit) return { ...l1Hit, cacheStatus: 'L1_HIT' };

  // ── L2: Redis ─────────────────────────────────────────────────────────────
  try {
    const cached = await redis.get(`url:${id}`);
    if (cached) {
      const item = parseItem(cached);
      if (item) {
        // Refresh TTL for settled items; let PENDING expire naturally (short TTL).
        if (item.safetyStatus !== 'PENDING') {
          redis.expire(`url:${id}`, CACHE_TTL_SECONDS).catch(() => {});
          localCache.set(id, item);
        }
        return { ...item, cacheStatus: 'HIT' };
      }
    }
  } catch (cacheErr) {
    console.warn('[cache] Redis error, falling back to DynamoDB:', cacheErr?.message || cacheErr);
  }

  // ── L3: DynamoDB ──────────────────────────────────────────────────────────
  const item = await fetchFromDynamo(id);
  if (!item) return { url: null, safetyStatus: null, cacheStatus: 'MISS' };

  localCache.set(id, item);
  const ttl = item.safetyStatus === 'PENDING' ? PENDING_CACHE_TTL_SECONDS : CACHE_TTL_SECONDS;
  redis.setex(`url:${id}`, ttl, JSON.stringify(item)).catch(() => {});

  return { ...item, cacheStatus: 'MISS' };
}

/**
 * Warm both L1 and L2 caches immediately after URL creation or safety update.
 * Uses a short TTL for PENDING so the safety-check result propagates quickly.
 */
export async function warmCache(id, url, safetyStatus = 'PENDING') {
  const item = { url, safetyStatus };
  localCache.set(id, item);
  const ttl = safetyStatus === 'PENDING' ? PENDING_CACHE_TTL_SECONDS : CACHE_TTL_SECONDS;
  return redis.setex(`url:${id}`, ttl, JSON.stringify(item));
}

/**
 * Evict a URL from both cache layers.
 * Call this whenever safetyStatus changes or a URL is deleted.
 */
export async function invalidateCache(id) {
  localCache.delete(id);
  return redis.del(`url:${id}`).catch(() => {});
}
