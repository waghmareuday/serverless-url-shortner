import redis from "./redis.js";

const LIMIT      = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "50",    10);
const WINDOW_MS  = parseInt(process.env.RATE_LIMIT_WINDOW_MS    || "60000", 10);

/**
 * Fixed Window rate limiter backed by Upstash Redis.
 * This approach reduces Redis HTTP commands from 4 down to 1 pipeline,
 * drastically improving throughput for high-scale environments.
 */
export async function checkRateLimit(ip) {
  const now        = Date.now();
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const key        = `rate:${ip}:${windowStart}`;
  
  try {
    const pipeline = redis.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, Math.ceil(WINDOW_MS / 1000) * 2);

    const results = await pipeline.exec();
    const count = results[0]; // INCR result

    if (count > LIMIT) {
      const retryAfterMs = WINDOW_MS - (now - windowStart);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        limit: LIMIT,
      };
    }

    return {
      allowed: true,
      remaining: LIMIT - count,
      retryAfterSeconds: 0,
      limit: LIMIT,
    };
  } catch (err) {
    console.error("[rateLimiter] Redis error — failing open:", err.message);
    return { allowed: true, remaining: -1, retryAfterSeconds: 0, limit: LIMIT };
  }
}