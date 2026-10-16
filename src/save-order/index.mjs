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
 * Consumes order messages from the intake SQS queue and persists each one.
 *
 * The API Gateway → SQS integration enqueues the raw request body, so each
 * SQS record body is the order JSON containing at least:
 *   - orderId (string)  partition key
 *   - itemId  (string)  sort key
 *
 * Uses partial batch failure reporting so only failed records are retried;
 * records that fail repeatedly end up in the intake dead-letter queue.
 */
export const handler = async (event) => {
  const batchItemFailures = [];

  for (const record of event.Records ?? []) {
    try {
      const order = JSON.parse(record.body);

      if (!order || !order.orderId || !order.itemId) {
        // Malformed message: log and skip (do not retry — it will never succeed).
        console.warn("Skipping invalid order message:", record.messageId);
        continue;
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

      console.log("Saved order:", item.orderId);
    } catch (err) {
      // Report this record as failed so SQS redelivers only it.
      console.error("Failed to process record", record.messageId, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
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
