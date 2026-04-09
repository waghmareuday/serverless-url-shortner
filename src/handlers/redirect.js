import { checkL1, getUrlWithCache } from "../services/cache.js";
import { enqueueClickEvent } from "../services/sqs.js";
import { mightExist } from "../services/bloomFilter.js";
import { hashIp } from "../utils/ip-hash.js";
import crypto from "crypto";

// ── Config (resolved once at cold-start, not per-request) ────────────────────
const ALLOWED_STATUS_CODES = new Set([301, 302]);
const _rawCode = parseInt(process.env.REDIRECT_STATUS_CODE || "302", 10);

// BUG FIX: validate the status code; default to 302 if invalid
const REDIRECT_STATUS = ALLOWED_STATUS_CODES.has(_rawCode) ? _rawCode : 302;
if (!ALLOWED_STATUS_CODES.has(_rawCode)) {
  console.warn(`[redirect] Invalid REDIRECT_STATUS_CODE "${_rawCode}", defaulting to 302`);
}

// BUG FIX: always add no-cache headers — 301s must not be permanently cached
// because safetyStatus can change and URLs can be removed after the fact.
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
    // BUG FIX: check L1 BEFORE the bloom filter so cache hits never pay the
    // cost of a Redis round trip — the biggest hot-path gain at 5M+ req/day.
    const l1Item = checkL1(id);
    if (l1Item) {
      if (l1Item.safetyStatus === "UNSAFE") {
        return jsonReply(451, { error: "This URL has been flagged as unsafe." });
      }
      fireAnalytics(event, id);
      return buildRedirect(l1Item.url, "L1_HIT");
    }

    // ── 2. Bloom filter gate (only on cache miss) ─────────────────────────────
    let probablyExists = true;
    try {
      probablyExists = await mightExist(id);
    } catch (err) {
      // Bloom filter is an optimisation only; fail open.
      console.error("[redirect] Bloom filter unavailable, continuing:", err.message);
    }

    if (!probablyExists) {
      return jsonReply(404, { error: "Short URL not found." });
    }

    // ── 3. Full cache lookup: L2 Redis → DynamoDB ────────────────────────────
    const { url, safetyStatus, cacheStatus } = await getUrlWithCache(id);

    if (!url) {
      return jsonReply(404, { error: "Short URL not found." });
    }

    // ── 4. Safety gate ────────────────────────────────────────────────────────
    // BUG FIX: actually enforce the safety check result written by url-safety-worker.
    if (safetyStatus === "UNSAFE") {
      return jsonReply(451, { error: "This URL has been flagged as unsafe." });
    }

    // ── 5. Async analytics (fire-and-forget, non-blocking) ───────────────────
    fireAnalytics(event, id);

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

function fireAnalytics(event, id) {
  // BUG FIX: generate the nonce HERE (at click time) so the same nonce is
  // included in the SQS message body.  analytics-worker will use it as the
  // DynamoDB sort-key suffix, making the PutItem idempotent across SQS retries.
  const nonce     = crypto.randomBytes(2).toString("hex");
  const ip        = event.requestContext?.http?.sourceIp || "unknown";
  const userAgent = event.headers?.["user-agent"] || "unknown";

  enqueueClickEvent({
    id,
    ipHash: hashIp(ip),
    userAgent,
    timestamp: Date.now(),
    nonce,
  }).catch((err) => console.error("[redirect] SQS enqueue error:", err.message));
}
