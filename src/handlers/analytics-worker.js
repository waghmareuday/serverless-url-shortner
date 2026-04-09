import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import dynamo, { TABLE } from "../config/dynamo-schema.js";
import crypto from "crypto";
import { hashIp } from "../utils/ip-hash.js";

/**
 * SQS Consumer Lambda
 * Triggered by AWS SQS in batches (e.g., 10 messages at a time).
 * * Flow
 * ────
 * 1. Parse the batch of SQS messages.
 * 2. For each message, do 2 things:
 * a) Insert a new CLICK item (for deep analytics).
 * b) Increment the global clickCount on the META item.
 * 3. Use Promise.allSettled to handle partial batch failures smoothly.
 */
export const handler = async (event) => {
  const records = event.Records || [];
  
  if (records.length === 0) {
    return { batchItemFailures: [] };
  }

  const processMessage = async (record) => {
    const data = JSON.parse(record.body);
    const { id, ip, ipHash, userAgent, timestamp } = data;
    const resolvedIpHash = ipHash || hashIp(ip);

    // Generate a short nonce to guarantee the Sort Key is unique
    const nonce = crypto.randomBytes(2).toString("hex");

    // Task A: Insert the individual click record
    const putClick = dynamo.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `URL#${id}`,
          SK: `CLICK#${timestamp}#${nonce}`,
          ipHash: resolvedIpHash,
          userAgent,
          createdAt: timestamp,
          // TTL: Purge clicks automatically after 1 year to save storage costs
          expiresAt: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60)
        },
      })
    );

    // Task B: Atomically increment the total click counter on the metadata record
    const incrementCounter = dynamo.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: {
          PK: `URL#${id}`,
          SK: "META",
        },
        UpdateExpression: "ADD clickCount :inc",
        ExpressionAttributeValues: {
          ":inc": 1,
        },
      })
    );

    await Promise.all([putClick, incrementCounter]);
  };

  // Process the entire batch concurrently and report failed message IDs only.
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
        error: result.reason?.message || String(result.reason),
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