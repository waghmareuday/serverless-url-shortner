import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { generateId } from "../utils/id-generator.js";
import dynamo, { TABLE } from "../config/dynamo-schema.js";
import { checkRateLimit } from "../services/rateLimiter.js";
import { warmCache } from "../services/cache.js";
import { addToBloomFilter } from "../services/bloomFilter.js";

const REDIRECT_STATUS = parseInt(process.env.REDIRECT_STATUS_CODE || "301", 10);

function isValidUrl(raw) {
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function response(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  const ip =
    event.headers?.["x-test-ip"] || 
    event.requestContext?.http?.sourceIp ||
    event.requestContext?.identity?.sourceIp ||
    event.headers?.["x-forwarded-for"]?.split(",")[0].trim() ||
    "unknown";

  const rl = await checkRateLimit(ip);

  const rlHeaders = {
    "X-RateLimit-Limit":     rl.limit,
    "X-RateLimit-Remaining": rl.remaining,
    "X-RateLimit-Reset":     Math.ceil((Date.now() + parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000")) / 1000),
  };

  if (!rl.allowed) {
    return response(
      429,
      {
        error: "Too Many Requests",
        message: `Limit of ${rl.limit} requests per minute exceeded.`,
        retryAfterSeconds: rl.retryAfterSeconds,
      },
      { ...rlHeaders, "Retry-After": rl.retryAfterSeconds }
    );
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return response(400, { error: "Request body must be valid JSON." }, rlHeaders);
  }

  const { url } = body;

  if (!url || typeof url !== "string") {
    return response(400, { error: "Body must contain a 'url' string field." }, rlHeaders);
  }

  const trimmedUrl = url.trim();

  if (!isValidUrl(trimmedUrl)) {
    return response(
      400,
      { error: "Invalid URL. Must be an absolute http:// or https:// URL." },
      rlHeaders
    );
  }

  try {
    const id = generateId(); 

    const record = {
      PK: `URL#${id}`,       
      SK: "META",            
      id,
      originalUrl: trimmedUrl,
      createdAt: Date.now(),
      clickCount: 0          
    };

    await dynamo.send(
      new PutCommand({
        TableName: TABLE,
        Item: record,
        ConditionExpression: "attribute_not_exists(PK)",
      })
    );

    await Promise.all([
      addToBloomFilter(id).catch(e => console.error("Bloom Error:", e)),
      warmCache(id, trimmedUrl).catch(e => console.error("Cache Warmer Error:", e))
    ]);

    const domain = event.requestContext?.domainName;
    const baseUrl = domain 
      ? `https://${domain}` 
      : (process.env.BASE_URL || "https://sho.rt");

    return response(
      201,
      {
        id,
        shortUrl: `${baseUrl}/${id}`,
        originalUrl: trimmedUrl,
        createdAt: record.createdAt,
      },
      rlHeaders
    );

  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return response(409, { error: "ID collision — please retry." }, rlHeaders);
    }
    console.error("[shorten] Unhandled error:", err);
    return response(500, { error: "Internal Server Error" }, rlHeaders);
  }
};
