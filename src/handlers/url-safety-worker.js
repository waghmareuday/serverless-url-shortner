import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import dynamo, { TABLE } from "../config/dynamo-schema.js";
import { warmCache, invalidateCache } from "../services/cache.js";

const SAFE_BROWSING_API_KEY  = process.env.SAFE_BROWSING_API_KEY;
const SAFE_BROWSING_ENDPOINT = "https://safebrowsing.googleapis.com/v4/threatMatches:find";

async function checkUrlSafety(url) {
  if (!SAFE_BROWSING_API_KEY) {
    throw new Error("SAFE_BROWSING_API_KEY env var is required");
  }

  const response = await fetch(
    `${SAFE_BROWSING_ENDPOINT}?key=${encodeURIComponent(SAFE_BROWSING_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: { clientId: "vjti-url-shortener", clientVersion: "1.0.0" },
        threatInfo: {
          threatTypes: [
            "MALWARE",
            "SOCIAL_ENGINEERING",
            "UNWANTED_SOFTWARE",
            "POTENTIALLY_HARMFUL_APPLICATION",
          ],
          platformTypes:    ["ANY_PLATFORM"],
          threatEntryTypes: ["URL"],
          threatEntries:    [{ url }],
        },
      }),
    }
  );

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(`Safe Browsing request failed (${response.status}): ${bodyText}`);
  }

  const payload    = await response.json().catch(() => ({}));
  const matches    = Array.isArray(payload.matches) ? payload.matches : [];
  const threatTypes = [...new Set(matches.map((m) => m.threatType).filter(Boolean))];

  return { isUnsafe: matches.length > 0, threatTypes };
}

async function processMessage(record) {
  const data = JSON.parse(record.body || "{}");
  const { id, url } = data;

  if (!id || typeof url !== "string" || !url.trim()) {
    throw new Error("Invalid safety-check message payload");
  }

  const { isUnsafe, threatTypes } = await checkUrlSafety(url.trim());
  const safetyStatus = isUnsafe ? "UNSAFE" : "SAFE";
  const checkedAt    = Date.now();

  // Persist the result to DynamoDB and retrieve the tier for cache warming.
  const updateResult = await dynamo.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `URL#${id}`, SK: "META" },
      UpdateExpression:
        "SET safetyStatus = :status, safetyCheckedAt = :checkedAt, threatTypes = :threatTypes",
      ExpressionAttributeValues: {
        ":status":      safetyStatus,
        ":checkedAt":   checkedAt,
        ":threatTypes": threatTypes,
      },
      ConditionExpression: "attribute_exists(PK)",
      ReturnValues: "ALL_NEW",
    })
  );

  const tier = updateResult.Attributes?.tier || "ANONYMOUS";

  // Update both cache layers so redirect.js immediately enforces the new status.
  // For UNSAFE: evict so the next request reads fresh from DynamoDB.
  // For SAFE: warm with settled status and full TTL for fast L2 hits.
  if (isUnsafe) {
    await invalidateCache(id).catch((e) =>
      console.error("[url-safety-worker] Cache invalidation failed (non-fatal):", e.message)
    );
    console.warn("[url-safety-worker] Unsafe URL flagged and evicted from cache", { id, threatTypes });
  } else {
    await warmCache(id, url.trim(), "SAFE", tier).catch((e) =>
      console.error("[url-safety-worker] Cache warm failed (non-fatal):", e.message)
    );
  }
}

export const handler = async (event) => {
  const records = event.Records || [];
  if (records.length === 0) return { batchItemFailures: [] };

  const results = await Promise.allSettled(records.map(processMessage));
  const batchItemFailures = [];

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const failedRecord = records[index];
      if (failedRecord?.messageId) {
        batchItemFailures.push({ itemIdentifier: failedRecord.messageId });
      }
      console.error("[url-safety-worker] Failed message:", {
        messageId: failedRecord?.messageId,
        error:     result.reason?.message || String(result.reason),
      });
    }
  });

  if (batchItemFailures.length > 0) {
    console.error(
      `[url-safety-worker] ${batchItemFailures.length}/${records.length} messages failed and will be retried.`
    );
  }

  return { batchItemFailures };
};
