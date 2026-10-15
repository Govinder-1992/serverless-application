# Orders Serverless Application

A multi-region, serverless order-management backend on AWS, defined entirely as
infrastructure-as-code with AWS SAM and deployed automatically via GitHub Actions.

## Architecture

![AWS Architecture Diagram](aws-architecture.png)

> An editable version using the official draw.io AWS icon library is available at
> [`aws-architecture.drawio`](aws-architecture.drawio) — open it at
> [app.diagrams.net](https://app.diagrams.net) or with the draw.io VS Code extension.

<details>
<summary>Simplified flow view</summary>

![Architecture Diagram](architecture.png)

</details>

### Components

| Layer | Resource | Purpose |
|-------|----------|---------|
| Edge | **AWS WAF** | Rate-based rule blocks any IP exceeding 1000 requests per 5-minute window. |
| Auth | **Cognito User Pool** | JWT authorizer; every API method requires a valid token. |
| API | **API Gateway REST API** (`OrdersApi`, `prod` stage) | Public entry point with stage-level caching (300s TTL). |
| Compute | **Lambda `SaveOrder`** (Node.js 24.x) | Validates and writes orders, then publishes an `OrderCreated` event. X-Ray tracing enabled; clients initialized outside the handler. |
| Data | **DynamoDB Global Table** (`Orders`) | `orderId` (PK) + `itemId` (SK), on-demand capacity, streams-based replication to a second region. |
| Events | **EventBridge custom bus** (`OrdersEventBus`) | Carries domain events; an `OrderCreated` rule routes matching events to SQS. |
| Queue | **SQS** (`OrderFulfilmentQueue` + DLQ) | Buffers `OrderCreated` events for async processing; failed messages go to a dead-letter queue after 5 attempts. |
| Async compute | **Lambda `FulfilOrder`** (Node.js 24.x) | Consumes the queue and records fulfilment, with partial batch failure reporting. |
| Async data | **DynamoDB table** (`OrderFulfilments`) | Stores fulfilment records keyed by `orderId`. |
| Observability | **CloudWatch Dashboard** + **X-Ray** | API and Lambda metrics plus distributed traces. |
| CI/CD | **GitHub Actions** | Builds and deploys on every push to `main`. |

## Endpoints

| Method | Path | Integration | Notes |
|--------|------|-------------|-------|
| `POST` | `/orders` | Lambda proxy | Creates an order via the `SaveOrder` function. |
| `GET` | `/orders/{orderId}` | Direct AWS service integration | Queries DynamoDB directly through an IAM role and mapping templates — no Lambda in the path. |

Both endpoints sit behind WAF, require a Cognito JWT, and are fronted by the 300s stage cache.

## Request flow

![Request Sequence Diagram](request-sequence.png)

**Create (`POST /orders`):** WAF rate check → Cognito JWT validation → Lambda
validates the payload → `PutItem` to DynamoDB → write replicates to the secondary
region via streams → an `OrderCreated` event is published to EventBridge →
`201 Created`. The event publish is non-blocking: if it fails, the order is still
persisted and the request still succeeds.

**Read (`GET /orders/{orderId}`):** WAF → Cognito → if the response is cached
(within the 300s TTL) it returns immediately with no backend call; otherwise
API Gateway queries DynamoDB directly, reshapes the result via a response mapping
template, caches it, and returns `200`.

## Asynchronous fulfilment pipeline

After an order is saved, processing continues asynchronously so the API responds
immediately while fulfilment happens in the background:

```
SaveOrder → EventBridge (OrdersEventBus) → OrderCreated rule → SQS → FulfilOrder → OrderFulfilments table
                                                                 │
                                                                 └─(after 5 failures)→ Dead-letter queue
```

1. `SaveOrder` publishes an `OrderCreated` event (`source: orders.service`,
   `detail-type: OrderCreated`) to the custom bus.
2. The `OrderCreated` rule matches that pattern and routes the event to
   `OrderFulfilmentQueue` (SQS).
3. `FulfilOrder` is triggered by the queue (batch size 10), unwraps the event,
   and writes a fulfilment record to the `OrderFulfilments` table.
4. Messages that fail processing five times are moved to the dead-letter queue
   for inspection, so a single bad message never blocks the pipeline.

This decouples the two functions: `SaveOrder` stays fast and user-facing, while
`FulfilOrder` processes work reliably off the queue.

## Data layer — Global Table

The `Orders` table is a DynamoDB **Global Table** with:

- **Primary region:** `us-east-1`
- **Replica region:** `us-west-2` (disaster recovery / multi-region availability)
- **Streams:** `NEW_AND_OLD_IMAGES` (required for replication)
- **Point-in-time recovery** and **encryption at rest** enabled on both replicas

Writes to either region replicate automatically, so data survives a regional outage.

## Project layout

```
serverless/
├── template.yaml              # SAM template (all AWS resources)
├── samconfig.toml             # SAM deploy settings
├── src/save-order/            # SaveOrder Lambda (API-facing, publishes events)
│   ├── index.mjs
│   └── package.json           # Runtime-only SDK (no bundled deps)
├── src/fulfil-order/          # FulfilOrder Lambda (SQS consumer)
│   ├── index.mjs
│   └── package.json
├── .github/workflows/
│   └── deploy.yml             # CI/CD pipeline
└── docs/
    ├── README.md              # This file
    ├── aws-architecture.drawio    # Editable diagram (official AWS icons)
    ├── aws-architecture.svg/.png  # AWS-icon architecture diagram
    ├── architecture.mmd/.png      # Simplified architecture diagram
    └── request-sequence.mmd/.png  # Sequence diagram
```

## Deployment

Deployment runs automatically on every push to `main` through GitHub Actions,
using AWS credentials stored as repository secrets (`AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`).

To deploy manually from a workstation with the SAM CLI installed:

```bash
sam validate --lint
sam deploy
```

## Regenerating the diagrams

The diagrams are authored in Mermaid (`.mmd`) and rendered to PNG with the
Mermaid CLI:

```bash
npx @mermaid-js/mermaid-cli -i docs/architecture.mmd -o docs/architecture.png -b white --scale 2
npx @mermaid-js/mermaid-cli -i docs/request-sequence.mmd -o docs/request-sequence.png -b white --scale 2
```
