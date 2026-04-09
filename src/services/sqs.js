import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

// Initialize the SQS Client
const sqs = new SQSClient({ region: process.env.AWS_REGION || "ap-south-1" });
const QUEUE_URL = process.env.ANALYTICS_QUEUE_URL;
const URL_SAFETY_QUEUE_URL = process.env.URL_SAFETY_QUEUE_URL;

/**
 * Fires a message into the SQS Queue.
 * Fails OPEN — if SQS goes down, we lose an analytics click, 
 * but the user still gets redirected successfully.
 */
export async function enqueueClickEvent(clickData) {
  if (!QUEUE_URL) {
    console.warn("[sqs] ANALYTICS_QUEUE_URL not set. Skipping analytics.");
    return;
  }

  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify(clickData),
      })
    );
  } catch (err) {
    console.error("[sqs] Failed to enqueue click event (non-fatal):", err.message);
  }
}

export async function enqueueUrlSafetyCheck(payload) {
  if (!URL_SAFETY_QUEUE_URL) {
    console.warn("[sqs] URL_SAFETY_QUEUE_URL not set. Skipping safety check enqueue.");
    return;
  }

  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: URL_SAFETY_QUEUE_URL,
        MessageBody: JSON.stringify(payload),
      })
    );
  } catch (err) {
    console.error("[sqs] Failed to enqueue URL safety check (non-fatal):", err.message);
  }
}