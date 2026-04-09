import { GetCommand } from '@aws-sdk/lib-dynamodb';
import dynamo, { TABLE } from '../config/dynamo-schema.js';
import redis from './redis.js';
import { LRUCache } from 'lru-cache';

const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '86400', 10);

const localCache = new LRUCache({
  max: 10000,
  ttl: CACHE_TTL_SECONDS * 1000,
});

export async function fetchFromDynamo(id) {
  const { Item } = await dynamo.send(
    new GetCommand({
      TableName: TABLE,
      Key: {
        PK: `URL#${id}`,
        SK: 'META'
      },
      ProjectionExpression: 'originalUrl',
    })
  );
  return Item?.originalUrl ?? null;
}

export async function getUrlWithCache(id) {
  const l1Hit = localCache.get(id);
  if (l1Hit) return { url: l1Hit, cacheStatus: 'L1_HIT' };

  try {
    const cached = await redis.get(`url:${id}`);
    if (cached) {
      redis.expire(`url:${id}`, CACHE_TTL_SECONDS).catch(() => {});
      localCache.set(id, cached);
      return { url: cached, cacheStatus: 'HIT' };
    }
  } catch (cacheErr) {
    console.warn("[cache] Redis error, falling back to DynamoDB:", cacheErr?.message || cacheErr);
  }

  const url = await fetchFromDynamo(id);
  if (!url) return { url: null, cacheStatus: 'MISS' };

  localCache.set(id, url);
  redis.setex(`url:${id}`, CACHE_TTL_SECONDS, url).catch(() => {});

  return { url, cacheStatus: 'MISS' };
}

export async function warmCache(id, url) {
  localCache.set(id, url);
  return redis.setex(`url:${id}`, CACHE_TTL_SECONDS, url);
}

