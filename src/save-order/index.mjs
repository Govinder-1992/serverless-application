import { DynamoDBClient, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
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

      const result = await processOrderIdempotently(order);

      if (result.alreadyProcessed) {
        // Duplicate: order already exists. Return the stored result and do NOT
        // re-trigger side effects (no duplicate OrderCreated event).
        console.log("Order already processed, skipping duplicate:", result.item.orderId);
      } else {
        // First time this orderId was seen: publish the side-effect event.
        await publishOrderCreated(result.item);
        console.log("Saved order:", result.item.orderId);
      }
    } catch (err) {
      // Report this record as failed so SQS redelivers only it.
      console.error("Failed to process record", record.messageId, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};

/**
 * Creates the order idempotently using a DynamoDB conditional write.
 *
 * The orderId (partition key) is the idempotency key. The conditional
 * expression `attribute_not_exists(orderId)` ensures only the first write for a
 * given order succeeds — this is atomic in DynamoDB, so even if the same event
 * is processed concurrently, exactly one writer wins and the others see
 * ConditionalCheckFailedException.
 *
 * Returns:
 *   { alreadyProcessed: false, item }  when this call created the order
 *   { alreadyProcessed: true,  item }  when the order already existed
 */
async function processOrderIdempotently(order) {
  const item = {
    ...order,
    orderId: String(order.orderId),
    itemId: String(order.itemId),
    createdAt: new Date().toISOString(),
    // Explicit processing state stored alongside the order result.
    processingState: "COMPLETED",
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
        // Only write if no item with this orderId already exists.
        ConditionExpression: "attribute_not_exists(orderId)",
      })
    );
    return { alreadyProcessed: false, item };
  } catch (err) {
    if (
      err instanceof ConditionalCheckFailedException ||
      err?.name === "ConditionalCheckFailedException"
    ) {
      // Order already processed. Fetch and return the stored result so repeated
      // requests with the same orderId yield the same outcome.
      const existing = await docClient.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { orderId: item.orderId, itemId: item.itemId },
        })
      );
      return { alreadyProcessed: true, item: existing.Item ?? item };
    }
    // Any other error is transient/unexpected — rethrow so the record is retried.
    throw err;
  }
}

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
