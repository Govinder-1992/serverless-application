import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import AmazonDaxClient from "amazon-dax-client";

// --- Initialization (runs once per cold start, reused on warm invokes) ---
// Clients and config are created at module scope, OUTSIDE the handler, so
// the connection setup and SDK bootstrap are not repeated on every request.
//
// When DAX_ENDPOINT is set, route DynamoDB operations through the DAX cluster
// (write-through caching for writes, in-memory acceleration for reads).
// Otherwise fall back to talking to DynamoDB directly.
const DAX_ENDPOINT = process.env.DAX_ENDPOINT;

const baseClient = DAX_ENDPOINT
  ? new AmazonDaxClient({ endpoints: [DAX_ENDPOINT], region: process.env.AWS_REGION })
  : new DynamoDBClient({});

const docClient = DynamoDBDocumentClient.from(baseClient, {
  marshallOptions: {
    // Drop undefined attributes instead of erroring, and don't write empty values.
    removeUndefinedValues: true,
    convertClassInstanceToMap: false,
  },
});

const TABLE_NAME = process.env.ORDERS_TABLE;
// --- End initialization ---

/**
 * Saves an order item to the Orders DynamoDB table.
 *
 * Expects an event body (JSON) containing at least:
 *   - orderId (string)  partition key
 *   - itemId  (string)  sort key
 * Any additional attributes are stored alongside the keys.
 */
export const handler = async (event) => {
  try {
    // Support both direct invocation (event is the order) and
    // API Gateway proxy invocation (order is in event.body).
    const order =
      typeof event?.body === "string" ? JSON.parse(event.body) : event?.body ?? event;

    if (!order || !order.orderId || !order.itemId) {
      return response(400, {
        message: "Request must include both 'orderId' and 'itemId'.",
      });
    }

    const item = {
      ...order,
      orderId: String(order.orderId),
      itemId: String(order.itemId),
      createdAt: new Date().toISOString(),
    };

    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
      })
    );

    return response(201, { message: "Order saved.", order: item });
  } catch (err) {
    console.error("Failed to save order:", err);
    return response(500, { message: "Failed to save order." });
  }
};

function response(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
