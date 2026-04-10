import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { generateId } from "../utils/id-generator.js";
import dynamo, { TABLE } from "../config/dynamo-schema.js";
import { checkRateLimit } from "../services/rateLimiter.js";
import { warmCache } from "../services/cache.js";
import { addToBloomFilter } from "../services/bloomFilter.js";
import { enqueueUrlSafetyCheck } from "../services/sqs.js";
import { verifyAuth } from "../services/auth.js";
import { parse as parseDomain } from "tldts";

// ── Cost-Tiering TTL ────────────────────────────────────────────────────────
// Anonymous links expire in 30 days to keep DynamoDB lean.
// Premium links live forever (no expiresAt attribute).
const ANON_TTL_DAYS    = 30;
const ANON_TTL_SECONDS = ANON_TTL_DAYS * 86400;
const WINDOW_MS        = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10);

function hasMalformedWwwPrefix(hostname) {
  const firstLabel = hostname.split(".")[0]?.toLowerCase() || "";
  return firstLabel.startsWith("www") && firstLabel !== "www";
}

function isValidUrl(raw) {
  try {
    const parsed   = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

    const hostname = parsed.hostname.toLowerCase();
    if (!hostname || hostname === "localhost" || hostname.endsWith(".")) return false;
    if (hasMalformedWwwPrefix(hostname)) return false;

    const domainInfo = parseDomain(hostname, { allowPrivateDomains: true });
    if (domainInfo.isIp || !domainInfo.domain || !domainInfo.publicSuffix) return false;

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
  const ip = event.requestContext?.http?.sourceIp ||
             event.requestContext?.identity?.sourceIp ||
             "unknown";

  const rl = await checkRateLimit(ip);

  const now          = Date.now();
  const windowReset  = Math.ceil(now / WINDOW_MS) * WINDOW_MS;

  const rlHeaders = {
    "X-RateLimit-Limit":     rl.limit,
    "X-RateLimit-Remaining": rl.remaining,
    "X-RateLimit-Reset":     Math.floor(windowReset / 1000),
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

  const { url, expiresInDays } = body;
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

  // Validate optional expiration
  if (expiresInDays !== undefined && (typeof expiresInDays !== "number" || expiresInDays < 1 || expiresInDays > 365)) {
    return response(400, { error: "expiresInDays must be a number between 1 and 365." }, rlHeaders);
  }

  try {
    // ── 1. Authenticate (optional — fails open to ANONYMOUS) ──────────────
    const { userId, tier } = await verifyAuth(event);

    const id        = generateId();
    const createdAt = Date.now();

    // ── 2. Build the DynamoDB record based on tier ────────────────────────
    const record = {
      PK:           `URL#${id}`,
      SK:           "META",
      id,
      originalUrl:  trimmedUrl,
      createdAt,
      tier,
      safetyStatus: "PENDING",
    };

    if (tier === "PREMIUM") {
      // Premium: attach user, initialize analytics
      record.userId     = userId;
      record.clickCount = 0;
      record.isActive   = true;
      // Optional expiration for premium links (default: permanent)
      if (expiresInDays) {
        record.expiresAt = Math.floor(createdAt / 1000) + expiresInDays * 86400;
      }
    } else {
      // Anonymous: 30-day TTL, initialize clickCount for direct counter increment
      record.expiresAt  = Math.floor(createdAt / 1000) + ANON_TTL_SECONDS;
      record.clickCount = 0;
    }

    await dynamo.send(
      new PutCommand({
        TableName: TABLE,
        Item: record,
        ConditionExpression: "attribute_not_exists(PK)",
      })
    );

    // ── 3. Fire-and-forget side effects ──────────────────────────────────
    addToBloomFilter(id)
      .catch((e) => console.error("[shorten] Bloom error:", e));

    warmCache(id, trimmedUrl, "PENDING", tier)
      .catch((e) => console.error("[shorten] Cache warm error:", e));

    enqueueUrlSafetyCheck({ id, url: trimmedUrl, createdAt })
      .catch((e) => console.error("[shorten] URL safety enqueue error:", e));

    const domain  = event.requestContext?.domainName;
    const baseUrl = domain
      ? `https://${domain}`
      : (process.env.BASE_URL || "https://sho.rt");

    return response(
      201,
      {
        id,
        shortUrl:    `${baseUrl}/${id}`,
        originalUrl: trimmedUrl,
        createdAt:   record.createdAt,
        tier,
        ...(userId ? { userId } : {}),
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
