import { GetCommand } from "@aws-sdk/lib-dynamodb";
import dynamo, { TABLE } from "../config/dynamo-schema.js";

function response(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  const id = event.pathParameters?.id;

  if (!id || !/^[\w-]{1,32}$/.test(id)) {
    return response(400, { error: "Invalid short URL format." });
  }

  try {
    const { Item } = await dynamo.send(
      new GetCommand({
        TableName: TABLE,
        Key: {
          PK: `URL#${id}`,
          SK: "META",
        },
        ProjectionExpression: "id, clickCount",
      })
    );

    if (!Item) {
      return response(404, { error: "Short URL not found." });
    }

    return response(200, {
      id,
      clickCount: Number(Item.clickCount || 0),
    });
  } catch (err) {
    console.error("[stats] Unhandled error:", err);
    return response(500, { error: "Internal Server Error" });
  }
};
