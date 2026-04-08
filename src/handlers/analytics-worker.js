import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import dynamo, { TABLE } from "../config/dynamo-schema.js";
import crypto from "crypto";

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
  
  if (records.length === 0) return;

  const processMessage = async (record) => {
    const data = JSON.parse(record.body);
    const { id, ip, userAgent, timestamp } = data;

    // Generate a short nonce to guarantee the Sort Key is unique
    const nonce = crypto.randomBytes(2).toString("hex");

    // Task A: Insert the individual click record
    const putClick = dynamo.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `URL#${id}`,
          SK: `CLICK#${timestamp}#${nonce}`,
          ip,
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

  // Process the entire batch concurrently
  const results = await Promise.allSettled(records.map(processMessage));

  // Check for any failures in the batch to trigger SQS retries
  const failedCount = results.filter(r => r.status === "rejected").length;
  if (failedCount > 0) {
    console.error(`[analytics-worker] ${failedCount}/${records.length} messages failed to process.`);
    // In a production app, you would use SQS Partial Batch Responses here
    // to return the specific failed message IDs back to the queue.
  }

  return { statusCode: 200 };
};