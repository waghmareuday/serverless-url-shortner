import { getUrlWithCache } from "../services/cache.js";
import { enqueueClickEvent } from "../services/sqs.js";
import { mightExist } from "../services/bloomFilter.js";

const REDIRECT_STATUS = parseInt(process.env.REDIRECT_STATUS_CODE || "301", 10);

export const handler = async (event) => {
  const id = event.pathParameters?.id;

  // ── 1. Validate ID format 
  if (!id || !/^[\w-]{1,32}$/.test(id)) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid short URL format." }),
    };
  }

    
  try {
    // ── 1.5. Bloom Filter Gate ──────────────────────────────────────────────
    const probablyExists = await mightExist(id);

    if (!probablyExists) {
    return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Short URL not found. (Blocked by Bloom Filter)" }),
    };
    }
    // ── 2. Cache-first lookup 
    const { url, cacheStatus } = await getUrlWithCache(id);

    if (!url) {
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Short URL not found." }),
      };
    }

    // ── 3. Fire Asynchronous Analytics to SQS 
    // We capture basic request data. In a real system, you'd hash the IP for GDPR.
    const ip = event.requestContext?.http?.sourceIp || "unknown";
    const userAgent = event.headers?.["user-agent"] || "unknown";
    
    await enqueueClickEvent({
      id,
      ip,
      userAgent,
      timestamp: Date.now()
    });

    // ── 4. Redirect the User 
    return {
      statusCode: REDIRECT_STATUS,
      headers: {
        Location: url,
        "X-Cache": cacheStatus, 
        ...(REDIRECT_STATUS === 302 && { "Cache-Control": "no-store" }),
      },
      body: "",
    };
  } catch (err) {
    console.error("[redirect] Unhandled error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal Server Error" }),
    };
  }
};