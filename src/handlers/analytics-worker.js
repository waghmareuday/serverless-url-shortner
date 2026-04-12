import { PutCommand } from "@aws-sdk/lib-dynamodb";
import dynamo, { TABLE } from "../config/dynamo-schema.js";
import { hashIp } from "../utils/ip-hash.js";
import { parseUserAgent } from "../utils/ua-parser.js";

// ── Geo-IP lookup (best-effort, non-blocking) ────────────────────────────────
// Uses ip-api.com free tier. Falls back gracefully on failure/timeout.
// Batch support: up to 100 IPs per request — we batch the entire SQS batch.
const GEO_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.ANALYTICS_GEO_TIMEOUT_MS || "900", 10);
  if (!Number.isFinite(raw)) return 900;
  return Math.min(2000, Math.max(300, raw));
})();

async function batchGeoLookup(ips) {
  const geoMap = new Map();
  if (!ips || ips.length === 0) return geoMap;

  // Filter out unknowns and private IPs
  const validIps = ips.filter(
    (ip) => ip && ip !== "unknown" && !ip.startsWith("10.") && !ip.startsWith("192.168.") && !ip.startsWith("127.")
  );
  if (validIps.length === 0) return geoMap;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);

    const res = await fetch("http://ip-api.com/batch?fields=query,status,country,countryCode,regionName,city", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validIps.map((ip) => ({ query: ip }))),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn("[analytics-worker] Geo batch API returned", res.status);
      return geoMap;
    }

    const results = await res.json();
    for (const r of results) {
      if (r.status === "success") {
        geoMap.set(r.query, {
          country:     r.country || "Unknown",
          countryCode: r.countryCode || "XX",
          region:      r.regionName || "",
          city:        r.city || "",
        });
      }
    }
  } catch (err) {
    // Timeout or network failure — geo data is best-effort
    if (err.name !== "AbortError") {
      console.warn("[analytics-worker] Geo lookup failed (non-fatal):", err.message);
    }
  }
  return geoMap;
}

// ── Referer domain extraction ────────────────────────────────────────────────
function extractRefererDomain(referer) {
  if (!referer) return "Direct";
  try {
    const { hostname } = new URL(referer);
    // Strip www. prefix for cleaner aggregation
    return hostname.replace(/^www\./, "") || "Direct";
  } catch {
    return "Direct";
  }
}

/**
 * SQS Consumer — processes click events in batches of up to 10.
 *
 * Enriches each click with:
 *  - Geo-location (country, countryCode, region, city)
 *  - Parsed User-Agent (browser, OS, device)
 *  - Referer domain
 *
 * Notes:
 *  - Redirect path now updates clickCount synchronously for freshness.
 *  - Worker remains responsible for detailed click record enrichment only.
 */
export const handler = async (event) => {
  const records = event.Records || [];
  if (records.length === 0) return { batchItemFailures: [] };

  // ── 1. Parse all messages and collect unique IPs for batch geo-lookup ─────
  const parsed = records.map((record) => {
    try {
      return { record, data: JSON.parse(record.body), error: null };
    } catch (err) {
      return { record, data: null, error: err };
    }
  });

  const uniqueIps = [
    ...new Set(
      parsed
        .filter((p) => p.data?.ip)
        .map((p) => p.data.ip)
    ),
  ];

  // ── 2. Batch geo-lookup (single HTTP call for up to 10 IPs) ───────────────
  const geoMap = await batchGeoLookup(uniqueIps);

  // ── 3. Process each message ───────────────────────────────────────────────
  const processMessage = async ({ record, data, error }) => {
    if (error || !data) {
      throw error || new Error("Empty message body");
    }

    const { id, ip, ipHash, userAgent, referer, timestamp, nonce } = data;

    // Resolve IP hash — prefer pre-computed, fall back to hashing raw IP
    const resolvedIpHash = ipHash || hashIp(ip || "unknown");

    // Resolve nonce — fall back to messageId if somehow absent (legacy)
    const resolvedNonce = nonce || record.messageId.slice(0, 4);

    // Enrich: UA parsing
    const ua = parseUserAgent(userAgent);

    // Enrich: Geo-location
    const geo = geoMap.get(ip) || {
      country: "Unknown", countryCode: "XX", region: "", city: "",
    };

    // Enrich: Referer domain
    const refererDomain = extractRefererDomain(referer);

    // ── Insert click record (idempotent via ConditionExpression) ─────────────
    try {
      await dynamo.send(
        new PutCommand({
          TableName: TABLE,
          Item: {
            PK:            `URL#${id}`,
            SK:            `CLICK#${timestamp}#${resolvedNonce}`,
            ipHash:        resolvedIpHash,
            userAgent,
            referer:       referer || "",
            refererDomain,
            // Geo-location
            country:       geo.country,
            countryCode:   geo.countryCode,
            region:        geo.region,
            city:          geo.city,
            // Parsed UA
            browser:       ua.browser,
            browserVersion: ua.browserVersion,
            os:            ua.os,
            device:        ua.device,
            // Timestamps
            createdAt:     timestamp,
            expiresAt:     Math.floor(Date.now() / 1000) + 365 * 86400,
          },
          ConditionExpression: "attribute_not_exists(SK)",
        })
      );
    } catch (err) {
      // Retry detected — click already recorded. Skip silently.
      if (err.name === "ConditionalCheckFailedException") return;
      throw err;
    }
  };

  // ── 4. Execute all in parallel with per-message error isolation ────────────
  const results = await Promise.allSettled(parsed.map(processMessage));
  const batchItemFailures = [];

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const failedRecord = records[index];
      if (failedRecord?.messageId) {
        batchItemFailures.push({ itemIdentifier: failedRecord.messageId });
      }
      console.error("[analytics-worker] Failed message:", {
        messageId: failedRecord?.messageId,
        error:     result.reason?.message || String(result.reason),
      });
    }
  });

  if (batchItemFailures.length > 0) {
    console.error(
      `[analytics-worker] ${batchItemFailures.length}/${records.length} messages failed and will be retried.`
    );
  }

  return { batchItemFailures };
};
