import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { generateId } from "../utils/id-generator.js";
import dynamo, { TABLE } from "../config/dynamo-schema.js";
import { checkRateLimit } from "../services/rateLimiter.js";
import { warmCache } from "../services/cache.js";
import { addToBloomFilter } from "../services/bloomFilter.js";
import { enqueueUrlSafetyCheck } from "../services/sqs.js";
import { parse as parseDomain } from "tldts";

const DEFAULT_URL_TTL_DAYS = 90;
const URL_TTL_DAYS = Number.parseInt(process.env.URL_TTL_DAYS || `${DEFAULT_URL_TTL_DAYS}`, 10);
const URL_TTL_SECONDS = (Number.isFinite(URL_TTL_DAYS) && URL_TTL_DAYS > 0 ? URL_TTL_DAYS : DEFAULT_URL_TTL_DAYS) * 86400;

function hasMalformedWwwPrefix(hostname) {
  const firstLabel = hostname.split(".")[0]?.toLowerCase() || "";
  return firstLabel.startsWith("www") && firstLabel !== "www";
}

function isValidUrl(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();
    if (!hostname || hostname === "localhost" || hostname.endsWith(".")) {
      return false;
    }

    if (hasMalformedWwwPrefix(hostname)) {
      return false;
    }

    // Structural-only validation: no synchronous reachability check.
    const domainInfo = parseDomain(hostname, { allowPrivateDomains: true });
    if (domainInfo.isIp || !domainInfo.domain || !domainInfo.publicSuffix) {
      return false;
    }

    return domainInfo.isIcann || domainInfo.isPrivate;
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
    event.requestContext?.http?.sourceIp ||
    event.requestContext?.identity?.sourceIp ||
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
      { error: "Invalid URL. Must be an absolute http:// or https:// URL with a public domain." },
      rlHeaders
    );
  }

  try {
    const id = generateId();
    const createdAt = Date.now();
    const expiresAt = Math.floor(createdAt / 1000) + URL_TTL_SECONDS;

    const record = {
      PK: `URL#${id}`,
      SK: "META",
      id,
      originalUrl: trimmedUrl,
      createdAt,
      expiresAt,
      safetyStatus: "PENDING",
      clickCount: 0
    };

    await dynamo.send(
      new PutCommand({
        TableName: TABLE,
        Item: record,
        ConditionExpression: "attribute_not_exists(PK)",
      })
    );

    void Promise.resolve()
      .then(() => addToBloomFilter(id))
      .catch((e) => console.error("Bloom Error:", e));

    void Promise.resolve()
      .then(() => warmCache(id, trimmedUrl))
      .catch((e) => console.error("Cache Warmer Error:", e));

    void Promise.resolve()
      .then(() => enqueueUrlSafetyCheck({ id, url: trimmedUrl, createdAt }))
      .catch((e) => console.error("URL Safety Enqueue Error:", e));

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
