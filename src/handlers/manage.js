import { QueryCommand, GetCommand, UpdateCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import dynamo, { TABLE } from "../config/dynamo-schema.js";
import { verifyAuth } from "../services/auth.js";
import { invalidateCache, warmCache } from "../services/cache.js";
import { parse as parseDomain } from "tldts";

const GSI2_NAME = "GSI2-UserLinks";
const ID_RE     = /^[\w-]{1,32}$/;
const MAX_EXPIRY_DAYS = 365;

function clampInt(raw, fallback, min, max) {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const PAGE_SIZE = clampInt(process.env.USER_LINKS_PAGE_SIZE, 100, 25, 200);
const STATS_SAMPLE_LIMIT = clampInt(process.env.STATS_SAMPLE_LIMIT, 200, 50, 500);

async function batchGetMetaItems(keys) {
  if (!keys.length) return [];

  const collected = [];
  let pendingKeys = keys;

  // Retry unprocessed keys to maximize freshness under burst traffic.
  for (let attempt = 0; pendingKeys.length > 0 && attempt < 4; attempt++) {
    const out = await dynamo.send(
      new BatchGetCommand({
        RequestItems: {
          [TABLE]: {
            Keys: pendingKeys,
            ConsistentRead: true,
            ProjectionExpression: "PK, SK, id, originalUrl, clickCount, isActive, createdAt, expiresAt, tier",
          },
        },
      })
    );

    const got = out.Responses?.[TABLE] || [];
    if (got.length) collected.push(...got);

    pendingKeys = out.UnprocessedKeys?.[TABLE]?.Keys || [];
  }

  return collected;
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      Vary: "Authorization",
    },
    body: JSON.stringify(body),
  };
}

// ── URL Validation (same logic as shorten.js) ────────────────────────────────
function isValidUrl(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname || hostname === "localhost" || hostname.endsWith(".")) return false;
    const domainInfo = parseDomain(hostname, { allowPrivateDomains: true });
    if (domainInfo.isIp || !domainInfo.domain || !domainInfo.publicSuffix) return false;
    return domainInfo.isIcann || domainInfo.isPrivate;
  } catch {
    return false;
  }
}

// ── GET /user/links ──────────────────────────────────────────────────────────
async function handleGetLinks(event, userId) {
  const nextTokenRaw = event.queryStringParameters?.nextToken;
  let exclusiveStartKey = null;

  if (nextTokenRaw) {
    try {
      exclusiveStartKey = JSON.parse(
        Buffer.from(nextTokenRaw, "base64url").toString("utf-8")
      );
    } catch {
      return response(400, { error: "Invalid pagination token." });
    }
  }

  const queryParams = {
    TableName: TABLE,
    IndexName: GSI2_NAME,
    KeyConditionExpression: "userId = :uid",
    ExpressionAttributeValues: { ":uid": userId },
    // Read all attributes projected on GSI2. Requesting non-projected attrs here
    // causes DynamoDB ValidationException and bubbles up as 500.
    ScanIndexForward: false,
    Limit: PAGE_SIZE,
  };

  if (exclusiveStartKey) {
    queryParams.ExclusiveStartKey = exclusiveStartKey;
  }

  const result = await dynamo.send(new QueryCommand(queryParams));

  const seedItems = result.Items || [];
  const metaKeys = seedItems
    .map((item) => {
      const id = item.id || item.PK?.replace("URL#", "");
      return id ? { PK: `URL#${id}`, SK: "META" } : null;
    })
    .filter(Boolean);

  const freshItems = await batchGetMetaItems(metaKeys);
  const byPk = new Map(freshItems.map((item) => [item.PK, item]));

  const links = seedItems.map((seed) => {
    const id = seed.id || seed.PK?.replace("URL#", "");
    const pk = id ? `URL#${id}` : seed.PK;
    const item = byPk.get(pk) || seed;

    return {
      id:          item.id || item.PK?.replace("URL#", ""),
      originalUrl: item.originalUrl,
      clickCount:  item.clickCount ?? 0,
      isActive:    item.isActive ?? true,
      createdAt:   item.createdAt,
      expiresAt:   item.expiresAt || null,
      tier:        item.tier || "PREMIUM",
    };
  });

  const responseBody = { links };

  if (result.LastEvaluatedKey) {
    responseBody.nextToken = Buffer.from(
      JSON.stringify(result.LastEvaluatedKey)
    ).toString("base64url");
  }

  return response(200, responseBody);
}

// ── PUT /user/links/{id} ─────────────────────────────────────────────────────
// Supports: originalUrl, isActive, expiresInDays
async function handleUpdateLink(event, userId) {
  const id = event.pathParameters?.id;

  if (!id || !ID_RE.test(id)) {
    return response(400, { error: "Invalid short URL format." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return response(400, { error: "Request body must be valid JSON." });
  }

  // ── 1. Ownership verification ────────────────────────────────────────────
  const { Item } = await dynamo.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: `URL#${id}`, SK: "META" },
      ProjectionExpression: "userId, originalUrl, isActive, tier, safetyStatus, clickCount, expiresAt",
    })
  );

  if (!Item) {
    return response(404, { error: "Short URL not found." });
  }

  if (Item.userId !== userId) {
    return response(403, { error: "You do not own this link." });
  }

  // ── 2. Build update expression ───────────────────────────────────────────
  const updates    = [];
  const exprNames  = {};
  const exprValues = {};
  const removes    = [];

  // Reroute — change the long URL
  if (typeof body.originalUrl === "string" && body.originalUrl.trim()) {
    const newUrl = body.originalUrl.trim();
    if (!isValidUrl(newUrl)) {
      return response(400, { error: "Invalid URL format for rerouting." });
    }
    updates.push("#ou = :ou");
    exprNames["#ou"]  = "originalUrl";
    exprValues[":ou"] = newUrl;
  }

  // Toggle active/inactive
  if (typeof body.isActive === "boolean") {
    updates.push("#ia = :ia");
    exprNames["#ia"]  = "isActive";
    exprValues[":ia"] = body.isActive;
  }

  // Optional expiration (premium links)
  if (typeof body.expiresInDays === "number" && body.expiresInDays > 0) {
    if (body.expiresInDays > MAX_EXPIRY_DAYS) {
      return response(400, { error: `Expiration cannot exceed ${MAX_EXPIRY_DAYS} days.` });
    }
    updates.push("#exp = :exp");
    exprNames["#exp"]  = "expiresAt";
    exprValues[":exp"] = Math.floor(Date.now() / 1000) + body.expiresInDays * 86400;
  } else if (body.expiresInDays === 0 || body.expiresInDays === null) {
    // Remove expiration — make link permanent again
    removes.push("#exp");
    exprNames["#exp"] = "expiresAt";
  }

  if (updates.length === 0 && removes.length === 0) {
    return response(400, {
      error: "Nothing to update. Provide 'originalUrl', 'isActive', and/or 'expiresInDays'.",
    });
  }

  updates.push("updatedAt = :now");
  exprValues[":now"] = Date.now();

  let updateExpression = `SET ${updates.join(", ")}`;
  if (removes.length > 0) {
    updateExpression += ` REMOVE ${removes.join(", ")}`;
  }

  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `URL#${id}`, SK: "META" },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames:  Object.keys(exprNames).length  ? exprNames  : undefined,
      ExpressionAttributeValues: Object.keys(exprValues).length ? exprValues : undefined,
      ConditionExpression: "attribute_exists(PK)",
    })
  );

  // ── 3. Cache invalidation ────────────────────────────────────────────────
  await invalidateCache(id);

  const newUrl      = exprValues[":ou"] || Item.originalUrl;
  const newIsActive = typeof body.isActive === "boolean" ? body.isActive : (Item.isActive ?? true);

  if (newIsActive) {
    await warmCache(id, newUrl, Item.safetyStatus || "SAFE", Item.tier || "PREMIUM")
      .catch((e) => console.error("[manage] Cache warm error:", e));
  }

  return response(200, {
    id,
    originalUrl: newUrl,
    isActive:    newIsActive,
    clickCount:  Item.clickCount ?? 0,
    expiresAt:   exprValues[":exp"] || (removes.includes("#exp") ? null : Item.expiresAt || null),
    message:     "Link updated successfully.",
  });
}

// ── GET /user/links/{id}/stats ───────────────────────────────────────────────
// Returns detailed analytics: click history, geo/referer/UA breakdowns.
async function handleGetLinkStats(event, userId) {
  const id = event.pathParameters?.id;

  if (!id || !ID_RE.test(id)) {
    return response(400, { error: "Invalid short URL format." });
  }

  // Verify ownership
  const { Item } = await dynamo.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: `URL#${id}`, SK: "META" },
      ProjectionExpression: "userId, clickCount, originalUrl, isActive, createdAt, tier, expiresAt",
    })
  );

  if (!Item)                     return response(404, { error: "Short URL not found." });
  if (Item.userId !== userId)    return response(403, { error: "You do not own this link." });

  // Fetch last 500 click records for aggregation
  const clickResult = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ConsistentRead: true,
      ExpressionAttributeValues: {
        ":pk":     `URL#${id}`,
        ":prefix": "CLICK#",
      },
      ProjectionExpression: "createdAt, country, countryCode, refererDomain, browser, os, device, city",
      ScanIndexForward: false,
      Limit: STATS_SAMPLE_LIMIT,
    })
  );

  const clicks = clickResult.Items || [];

  // ── Aggregate breakdowns ─────────────────────────────────────────────────
  const geo       = {};   // countryCode → { country, count }
  const referers  = {};   // refererDomain → count
  const browsers  = {};   // browser → count
  const oses      = {};   // os → count
  const devices   = {};   // device → count
  const dailyClicks = {}; // "YYYY-MM-DD" → count

  for (const click of clicks) {
    // Geo
    const cc = click.countryCode || "XX";
    if (!geo[cc]) geo[cc] = { country: click.country || "Unknown", count: 0 };
    geo[cc].count++;

    // Referer
    const ref = click.refererDomain || "Direct";
    referers[ref] = (referers[ref] || 0) + 1;

    // Browser
    const br = click.browser || "Unknown";
    browsers[br] = (browsers[br] || 0) + 1;

    // OS
    const os = click.os || "Unknown";
    oses[os] = (oses[os] || 0) + 1;

    // Device
    const dev = click.device || "Unknown";
    devices[dev] = (devices[dev] || 0) + 1;

    // Daily clicks
    const ts = Number(click.createdAt);
    if (Number.isFinite(ts)) {
      const day = new Date(ts).toISOString().split("T")[0];
      dailyClicks[day] = (dailyClicks[day] || 0) + 1;
    }
  }

  // Sort breakdowns by count descending
  const sortMap = (obj) =>
    Object.entries(obj)
      .sort((a, b) => (typeof b[1] === "object" ? b[1].count : b[1]) - (typeof a[1] === "object" ? a[1].count : a[1]))
      .slice(0, 20);

  // Recent clicks (last 10)
  const recentClicks = clicks.slice(0, 10).map((c) => ({
    timestamp:     c.createdAt,
    country:       c.country || "Unknown",
    countryCode:   c.countryCode || "XX",
    city:          c.city || "",
    browser:       c.browser || "Unknown",
    os:            c.os || "Unknown",
    device:        c.device || "Unknown",
    refererDomain: c.refererDomain || "Direct",
  }));

  return response(200, {
    id,
    originalUrl:  Item.originalUrl,
    isActive:     Item.isActive ?? true,
    clickCount:   Item.clickCount ?? 0,
    createdAt:    Item.createdAt,
    expiresAt:    Item.expiresAt || null,
    tier:         Item.tier || "PREMIUM",
    analytics: {
      totalSampled: clicks.length,
      geo:          sortMap(geo).map(([code, d]) => ({ code, country: d.country, count: d.count })),
      referers:     sortMap(referers).map(([domain, count]) => ({ domain, count })),
      browsers:     sortMap(browsers).map(([name, count]) => ({ name, count })),
      oses:         sortMap(oses).map(([name, count]) => ({ name, count })),
      devices:      sortMap(devices).map(([name, count]) => ({ name, count })),
      dailyClicks:  Object.entries(dailyClicks).sort((a, b) => a[0].localeCompare(b[0])),
      recentClicks,
    },
  });
}

// ── Router ────────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  try {
    const { userId, tier } = await verifyAuth(event);

    if (!userId || tier !== "PREMIUM") {
      return response(401, { error: "Authentication required." });
    }

    const method = event.requestContext?.http?.method || event.httpMethod;
    const path   = event.rawPath || event.path || "";

    // GET /user/links
    if (method === "GET" && /^\/user\/links\/?$/.test(path)) {
      return await handleGetLinks(event, userId);
    }

    // GET /user/links/{id}/stats
    if (method === "GET" && /^\/user\/links\/[\w-]+\/stats$/.test(path)) {
      return await handleGetLinkStats(event, userId);
    }

    // PUT /user/links/{id}
    if (method === "PUT" && /^\/user\/links\/[\w-]+$/.test(path)) {
      return await handleUpdateLink(event, userId);
    }

    return response(404, { error: "Not found." });
  } catch (err) {
    console.error("[manage] Unhandled error:", err);
    return response(500, { error: "Internal Server Error" });
  }
};
