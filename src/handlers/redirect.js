import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { checkL1, getUrlWithCache } from "../services/cache.js";
import { enqueueClickEvent } from "../services/sqs.js";
import { mightExist } from "../services/bloomFilter.js";
import { hashIp } from "../utils/ip-hash.js";
import dynamo, { TABLE } from "../config/dynamo-schema.js";
import crypto from "crypto";

// ── Config (resolved once at cold-start, not per-request) ────────────────────
const ALLOWED_STATUS_CODES = new Set([301, 302]);
const _rawCode = parseInt(process.env.REDIRECT_STATUS_CODE || "302", 10);

const REDIRECT_STATUS = ALLOWED_STATUS_CODES.has(_rawCode) ? _rawCode : 302;
if (!ALLOWED_STATUS_CODES.has(_rawCode)) {
  console.warn(`[redirect] Invalid REDIRECT_STATUS_CODE "${_rawCode}", defaulting to 302`);
}

const REDIRECT_EXTRA_HEADERS = {
  "Cache-Control": "no-store, no-cache",
  Pragma: "no-cache",
};

const ID_RE = /^[\w-]{1,32}$/;

const JSON_HEADERS = { "Content-Type": "application/json" };

function jsonReply(statusCode, body) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  const id = event.pathParameters?.id;

  if (!id || !ID_RE.test(id)) {
    return jsonReply(400, { error: "Invalid short URL format." });
  }

  try {
    // ── 1. L1 fast path (sync, zero network I/O) ─────────────────────────────
    const l1Item = checkL1(id);
    if (l1Item) {
      if (l1Item.safetyStatus === "UNSAFE") {
        return jsonReply(451, { error: "This URL has been flagged as unsafe." });
      }
      // Fire analytics based on tier
      await dispatchAnalytics(event, id, l1Item.tier);
      return buildRedirect(l1Item.url, "L1_HIT");
    }

    // ── 2. Bloom filter gate (only on cache miss) ─────────────────────────────
    let probablyExists = true;
    try {
      probablyExists = await mightExist(id);
    } catch (err) {
      console.error("[redirect] Bloom filter unavailable, continuing:", err.message);
    }

    if (!probablyExists) {
      return jsonReply(404, { error: "Short URL not found." });
    }

    // ── 3. Full cache lookup: L2 Redis → DynamoDB ────────────────────────────
    const { url, safetyStatus, tier, cacheStatus } = await getUrlWithCache(id);

    if (!url) {
      return jsonReply(404, { error: "Short URL not found." });
    }

    // ── 4. Safety gate ────────────────────────────────────────────────────────
    if (safetyStatus === "UNSAFE") {
      return jsonReply(451, { error: "This URL has been flagged as unsafe." });
    }

    // ── 5. Analytics dispatch (tier-aware) ────────────────────────────────────
    await dispatchAnalytics(event, id, tier);

    // ── 6. Redirect ───────────────────────────────────────────────────────────
    return buildRedirect(url, cacheStatus);

  } catch (err) {
    console.error("[redirect] Unhandled error:", err);
    return jsonReply(500, { error: "Internal Server Error" });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildRedirect(url, cacheStatus) {
  return {
    statusCode: REDIRECT_STATUS,
    headers: {
      Location: url,
      "X-Cache": cacheStatus,
      ...REDIRECT_EXTRA_HEADERS,
    },
    body: "",
  };
}

async function incrementClickCount(id) {
  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `URL#${id}`, SK: "META" },
      UpdateExpression: "ADD clickCount :inc",
      ExpressionAttributeValues: { ":inc": 1 },
      ConditionExpression: "attribute_exists(PK)",
    })
  );
}

/**
 * Tier-aware analytics dispatch:
 *
 * PREMIUM:   Full analytics via SQS (click records + counter + UA/geo enrichment)
 *            → Sends raw IP (not hashed) for geo-location lookup in analytics-worker
 *
 * ANONYMOUS: Lightweight direct DynamoDB counter increment only (no SQS, no click records)
 *            → Costs $0.00000125 per click vs $0.0000057 for SQS+Lambda+DynamoDB
 */
async function dispatchAnalytics(event, id, tier) {
  const ip        = event.requestContext?.http?.sourceIp || "unknown";
  const userAgent = event.headers?.["user-agent"] || "unknown";
  const referer   = event.headers?.referer || event.headers?.Referer || "";

  try {
    // Keep dashboard count fresh immediately after each redirect.
    await incrementClickCount(id);
  } catch (err) {
    console.error("[redirect] Counter increment error:", err.message);
  }

  if (tier === "PREMIUM") {
    // Full analytics payload is still processed asynchronously for enrichment.
    const nonce = crypto.randomBytes(2).toString("hex");
    enqueueClickEvent({
      id,
      ip,                      // Raw IP for geo-lookup → hashed in analytics-worker
      ipHash: hashIp(ip),      // Pre-computed hash as fallback
      userAgent,
      referer,
      timestamp: Date.now(),
      nonce,
    }).catch((err) => console.error("[redirect] SQS enqueue error:", err.message));
  }
}
