import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

// --- Initialization (runs once per cold start, reused on warm invokes) ---
// Clients and config are created at module scope, OUTSIDE the handler, so
// the connection setup and SDK bootstrap are not repeated on every request.
const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    // Drop undefined attributes instead of erroring, and don't write empty values.
    removeUndefinedValues: true,
    convertClassInstanceToMap: false,
  },
});

const eventBridge = new EventBridgeClient({});

const TABLE_NAME = process.env.ORDERS_TABLE;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME;
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

    // Publish the OrderCreated event only after the write succeeds.
    await publishOrderCreated(item);

    return response(201, { message: "Order saved.", order: item });
  } catch (err) {
    console.error("Failed to save order:", err);
    return response(500, { message: "Failed to save order." });
  }
};

/**
 * Publishes an OrderCreated event to the custom EventBridge bus.
 * A publish failure is logged but does not fail the request, since the
 * order has already been persisted successfully.
 */
async function publishOrderCreated(order) {
  if (!EVENT_BUS_NAME) {
    console.warn("EVENT_BUS_NAME not set; skipping OrderCreated event.");
    return;
  }

  try {
    await eventBridge.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: EVENT_BUS_NAME,
            Source: "orders.service",
            DetailType: "OrderCreated",
            Detail: JSON.stringify(order),
          },
        ],
      })
    );
  } catch (err) {
    console.error("Order saved but failed to publish OrderCreated event:", err);
  }
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
