import { getUrlWithCache } from "../services/cache.js";

function response(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  const id = event.pathParameters?.id;

  if (!id || !/^[\w-]{1,32}$/.test(id)) {
    return response(400, { error: "Invalid short URL format." });
  }

  try {
    const { url, cacheStatus } = await getUrlWithCache(id);

    if (!url) {
      return response(404, { error: "Short URL not found." });
    }

    return response(200, {
      id,
      cacheStatus,
    }, { "X-Cache": cacheStatus });
  } catch (err) {
    console.error("[cache-status] Unhandled error:", err);
    return response(500, { error: "Internal Server Error" });
  }
};
