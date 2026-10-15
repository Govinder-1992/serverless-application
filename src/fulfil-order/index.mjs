import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

// --- Initialization (runs once per cold start, reused on warm invokes) ---
const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertClassInstanceToMap: false,
  },
});

const FULFILMENT_TABLE = process.env.FULFILMENT_TABLE;
// --- End initialization ---

/**
 * Consumes OrderCreated messages delivered via EventBridge -> SQS and records
 * a fulfilment entry for each order.
 *
 * Each SQS record body is the EventBridge event envelope; the original order
 * is in the event's `detail` field. Uses partial batch failure reporting so
 * only the records that fail are retried.
 */
export const handler = async (event) => {
  const batchItemFailures = [];

  for (const record of event.Records ?? []) {
    try {
      const envelope = JSON.parse(record.body);
      // EventBridge-to-SQS puts the published payload in `detail`.
      const order = envelope.detail ?? envelope;

      if (!order?.orderId) {
        console.warn("Skipping record without orderId:", record.messageId);
        continue;
      }

      await docClient.send(
        new PutCommand({
          TableName: FULFILMENT_TABLE,
          Item: {
            orderId: String(order.orderId),
            itemId: order.itemId ? String(order.itemId) : undefined,
            status: "FULFILLED",
            fulfilledAt: new Date().toISOString(),
            source: envelope["detail-type"] ?? "OrderCreated",
          },
        })
      );

      console.log("Fulfilled order:", order.orderId);
    } catch (err) {
      // Report this record as failed so SQS redelivers only it.
      console.error("Failed to process record", record.messageId, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
