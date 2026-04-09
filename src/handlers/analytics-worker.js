import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import dynamo, { TABLE } from "../config/dynamo-schema.js";
import { hashIp } from "../utils/ip-hash.js";

/**
 * SQS Consumer — processes click events in batches of up to 10.
 *
 * BUG FIX (idempotency): The click nonce is now generated in redirect.js at
 * click-capture time and included in the SQS message body.  Using a fixed
 * nonce makes the DynamoDB PutItem call idempotent across SQS retries — the
 * same message always produces the same SK, so retries are no-ops instead of
 * creating duplicate CLICK records and inflating clickCount.
 */
export const handler = async (event) => {
  const records = event.Records || [];
  if (records.length === 0) return { batchItemFailures: [] };

  const processMessage = async (record) => {
    const data = JSON.parse(record.body);
    const { id, ip, ipHash, userAgent, timestamp, nonce } = data;

    // Support messages that pre-date the nonce field (plain ip-hash or raw ip).
    const resolvedIpHash = ipHash || hashIp(ip || "unknown");

    // BUG FIX: use the nonce from the message, not a freshly-generated one.
    // Fallback to messageId if somehow nonce is absent (legacy messages).
    const resolvedNonce = nonce || record.messageId.slice(0, 4);

    // Task A: Insert the individual click record (idempotent — SK is stable)
    const putClick = dynamo.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK:        `URL#${id}`,
          SK:        `CLICK#${timestamp}#${resolvedNonce}`,
          ipHash:    resolvedIpHash,
          userAgent,
          createdAt: timestamp,
          expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
        },
        // Idempotency guard: if the item already exists (retry), skip silently.
        ConditionExpression: "attribute_not_exists(SK)",
      })
    );

    // Task B: Atomically increment clickCount (ADD is idempotent here only if
    // putClick succeeded; the ConditionExpression on putClick prevents double-counting).
    const incrementCounter = dynamo.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `URL#${id}`, SK: "META" },
        UpdateExpression: "ADD clickCount :inc",
        ExpressionAttributeValues: { ":inc": 1 },
      })
    );

    // Run sequentially: insert the click record FIRST, then increment the counter
    // ONLY if the insert succeeded.  This prevents two failure modes:
    //   1. putClick succeeds + incrementCounter fails → retry skips both (count stuck behind)
    //   2. putClick fails + incrementCounter succeeds → phantom count with no CLICK record
    try {
      await putClick;
    } catch (err) {
      // ConditionalCheckFailed means this exact click was already recorded (SQS retry).
      // The counter was already incremented on the original pass — skip silently.
      if (err.name === "ConditionalCheckFailedException") return;
      throw err;
    }

    // putClick succeeded → this is the first processing of this message.
    // Safe to increment the counter exactly once.
    await incrementCounter;
  };

  const results = await Promise.allSettled(records.map(processMessage));
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
