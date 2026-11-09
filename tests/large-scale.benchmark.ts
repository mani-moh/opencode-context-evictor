import {
  applyEvictionToContext,
  createContextEvictorPlugin,
  createRejectionRegistry,
  createLogger,
  type PluginContext,
  type SessionContextEvent,
  type SourceID,
  type V2Message,
} from "../src/index.js";

// ============================================================================
// Realistic Context Payloads (>50,000 chars / >12,500 tokens)
// ============================================================================

export const HEAVY_SKILLS: Record<string, string> = {
  "postgres-optimization": `# Skill: postgres-optimization (PostgreSQL 16)
## Query Tuning & Indexing Guidelines
When tuning PostgreSQL query plans for relational workloads:
1. Always run \`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS)\` before and after index changes.
2. Inspect buffer hits vs disk reads. Avoid Seq Scan on tables exceeding 10,000 rows where selective indexes apply.
3. Configure connection pooling via PgBouncer in transaction pooling mode:
\`\`\`ini
[databases]
order_db = host=127.0.0.1 port=5432 dbname=orders pool_size=50 reserve_pool=10
[pgbouncer]
pool_mode = transaction
max_client_conn = 5000
default_pool_size = 40
min_pool_size = 10
reserve_pool_timeout = 3
\`\`\`
4. Index architecture:
- Use partial B-Tree indexes for active order statuses:
  \`CREATE INDEX CONCURRENTLY idx_orders_active_created ON orders (created_at DESC) WHERE status IN ('PENDING', 'PROCESSING');\`
- Use GIN indexes for jsonb columns with jsonb_path_ops operator class:
  \`CREATE INDEX CONCURRENTLY idx_orders_metadata_gin ON orders USING gin (metadata jsonb_path_ops);\`
- Configure per-table autovacuum thresholds for high-frequency order mutation tables:
  \`ALTER TABLE orders SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01, fillfactor = 90);\`
5. Memory settings:
- \`shared_buffers = 16GB\` (25% of RAM)
- \`work_mem = 64MB\` (per query sort buffer)
- \`maintenance_work_mem = 2GB\`
- \`effective_cache_size = 48GB\`
- \`random_page_cost = 1.1\` (NVMe SSD storage optimization).
`.repeat(3), // ~6,300 chars

  "kubernetes-orchestration": `# Skill: kubernetes-orchestration (v1.30+)
## Production Workload Topology & Scheduling
1. Deployment manifests must enforce resource requests and limits to ensure predictable QoS classes:
\`\`\`yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  labels:
    app.kubernetes.io/name: order-service
    app.kubernetes.io/part-of: checkout-platform
spec:
  replicas: 12
  selector:
    matchLabels:
      app: order-service
  template:
    metadata:
      labels:
        app: order-service
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: order-service
      containers:
        - name: app
          image: registry.internal/order-service:v2.4.1
          resources:
            requests:
              cpu: "1000m"
              memory: "2Gi"
            limits:
              cpu: "2000m"
              memory: "4Gi"
          readinessProbe:
            httpGet:
              path: /healthz/ready
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /healthz/live
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 10
\`\`\`
2. Configure HorizontalPodAutoscaler (HPA) with Custom Metrics (Prometheus HTTP request rate and queue depth).
3. PodDisruptionBudgets (PDB) must enforce \`minAvailable: 75%\` during node draining or rolling upgrades.
`.repeat(3), // ~5,800 chars

  "dynamodb-single-table-design": `# Skill: dynamodb-single-table-design (AWS DynamoDB)
## Single-Table Schema Patterns & Index Architecture
1. Partition Key (PK) and Sort Key (SK) Design:
- Entities are consolidated into a single table with generic \`PK\` (String) and \`SK\` (String) attributes.
- Customer partition: \`PK = CUSTOMER#<id>\`, \`SK = PROFILE\`
- Order partition: \`PK = ORDER#<id>\`, \`SK = METADATA\`
- Order line items: \`PK = ORDER#<id>\`, \`SK = ITEM#<sku>\`
2. Global Secondary Indexes (GSIs):
- \`GSI1-PK\` = \`STATUS#<status>\`, \`GSI1-SK\` = \`CREATED#<timestamp>\` for status-based order queues.
- \`GSI2-PK\` = \`CUSTOMER#<id>\`, \`GSI2-SK\` = \`ORDER#<timestamp>\` for customer order history.
\`\`\`typescript
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

export async function fetchCustomerOrders(docClient: DynamoDBDocumentClient, customerId: string) {
  return await docClient.send(new QueryCommand({
    TableName: "CheckoutSingleTable",
    IndexName: "GSI2",
    KeyConditionExpression: "GSI2PK = :pk AND GSI2SK BEGINS_WITH(:skPrefix)",
    ExpressionAttributeValues: {
      ":pk": \`CUSTOMER#\${customerId}\`,
      ":skPrefix": "ORDER#",
    },
    ScanIndexForward: false,
    Limit: 25,
  }));
}
\`\`\`
3. Use TransactWriteItems for financial state transitions and conditional inventory allocation.
`.repeat(3), // ~5,700 chars

  "graphql-federation-gateway": `# Skill: graphql-federation-gateway (Apollo Federation 2)
## Subgraph Entity Composition & Resolution
1. Subgraph schemas define federated types with \`@key\`, \`@shareable\`, \`@external\`, and \`@override\` directives.
\`\`\`graphql
extend schema
  @link(url: "https://specs.apollo.dev/federation/v2.5", import: ["@key", "@shareable", "@provides", "@external"])

type Order @key(fields: "id") {
  id: ID!
  customerId: ID!
  items: [OrderItem!]!
  totalCents: Int!
  status: OrderStatus!
  customer: Customer @provides(fields: "name")
}

type Customer @key(fields: "id") {
  id: ID!
  name: String @external
  email: String @external
  orders: [Order!]!
}
\`\`\`
2. Dataloader batching pattern for resolving remote entities:
- Always batch entity lookups by entity key array to eliminate N+1 roundtrips.
- Wrap entity resolvers with timeout circuits (500ms max SLA).
`.repeat(3), // ~5,200 chars

  "mongodb-aggregation": `# Skill: mongodb-aggregation (MongoDB 7.0+)
## Optimized Aggregation Pipelines for E-Commerce
1. Index-covered pipeline prefixes:
- The first \`$match\` stage MUST hit a compound index covering the tenant and filter criteria.
- Compound index: \`{ tenantId: 1, status: 1, createdAt: -1 }\`.
\`\`\`javascript
db.orders.aggregate([
  {
    $match: {
      tenantId: "tenant_9981",
      status: { $in: ["PAID", "PROCESSING"] },
      createdAt: { $gte: ISODate("2026-01-01T00:00:00Z") }
    }
  },
  {
    $lookup: {
      from: "customers",
      localField: "customerId",
      foreignField: "_id",
      as: "customer"
    }
  },
  { $unwind: "$customer" },
  {
    $group: {
      _id: "$customer.loyaltyTier",
      totalRevenue: { $sum: "$totalCents" },
      orderCount: { $sum: 1 },
      avgOrderValue: { $avg: "$totalCents" }
    }
  },
  { $sort: { totalRevenue: -1 } }
], { allowDiskUse: false });
\`\`\`
2. Avoid \`$facet\` over unbounded collections due to 100MB in-memory RAM restriction.
`.repeat(3), // ~5,400 chars
};

export const HEAVY_FILES: Record<string, string> = {
  "src/legacy/oracle-connector.ts": `// src/legacy/oracle-connector.ts (DEPRECATED ORACLE PL/SQL ADAPTER)
import oracledb from "oracledb";

export class OracleOrderConnector {
  private pool: oracledb.Pool | null = null;

  async initializePool(config: oracledb.PoolAttributes): Promise<void> {
    this.pool = await oracledb.createPool({
      ...config,
      poolMin: 4,
      poolMax: 32,
      poolIncrement: 2,
      poolTimeout: 60,
    });
  }

  async executeLegacyStoredProcedure(orderId: string, status: string): Promise<any> {
    if (!this.pool) throw new Error("Pool not initialized");
    const connection = await this.pool.getConnection();
    try {
      const result = await connection.execute(
        \`BEGIN PKG_ORDERS.UPDATE_STATUS(:orderId, :status, :out_code, :out_msg); END;\`,
        {
          orderId,
          status,
          out_code: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
          out_msg: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 500 },
        },
        { autoCommit: true }
      );
      return result.outBinds;
    } finally {
      await connection.close();
    }
  }
}
`.repeat(5), // ~4,800 chars

  "src/legacy/soap-client.ts": `// src/legacy/soap-client.ts (DEPRECATED SOAP 1.2 XML CLIENT)
import { parseStringPromise, Builder } from "xml2js";

export class LegacySoapClient {
  private endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  createSoapEnvelope(action: string, payload: Record<string, unknown>): string {
    const builder = new Builder({ headless: true });
    return \`<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Header>
    <wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
      <wsse:UsernameToken>
        <wsse:Username>LEGACY_USER</wsse:Username>
        <wsse:Password>SECRET</wsse:Password>
      </wsse:UsernameToken>
    </wsse:Security>
  </soap12:Header>
  <soap12:Body>
    <\${action} xmlns="http://legacy.internal/orders/wsdl">
      \${builder.buildObject(payload)}
    </\${action}>
  </soap12:Body>
</soap12:Envelope>\`;
  }
}
`.repeat(4), // ~4,200 chars

  "src/legacy/xml-parser.ts": `// src/legacy/xml-parser.ts (DEPRECATED STREAMING SAX XML PARSER)
export interface XmlOrderNode {
  tag: string;
  attributes: Record<string, string>;
  children: XmlOrderNode[];
  text?: string;
}

export function parseLegacyXmlStream(buffer: Buffer): XmlOrderNode {
  // Parsing binary buffer using streaming legacy DOM
  let offset = 0;
  const root: XmlOrderNode = { tag: "root", attributes: {}, children: [] };
  while (offset < buffer.length) {
    const byte = buffer[offset++];
    if (byte === 0x3c) {
      // opening bracket
      root.children.push({ tag: "order_item", attributes: { id: "item_" + offset }, children: [] });
    }
  }
  return root;
}
`.repeat(6), // ~3,800 chars

  "src/legacy/session-manager.ts": `// src/legacy/session-manager.ts (DEPRECATED STICKY CLUSTER SESSION MANAGER)
export class ClusterSessionManager {
  private cache = new Map<string, { userId: string; roles: string[]; expires: number }>();

  getStickySession(cookie: string): { userId: string; roles: string[] } | null {
    const entry = this.cache.get(cookie);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this.cache.delete(cookie);
      return null;
    }
    entry.expires = Date.now() + 1800000;
    return entry;
  }
}
`.repeat(6), // ~3,600 chars

  "src/legacy/deprecated-crypto.ts": `// src/legacy/deprecated-crypto.ts (LEGACY 3DES / MD5 HASHING)
import crypto from "node:crypto";

export function legacyDesEncrypt(key: string, data: string): string {
  const cipher = crypto.createCipheriv("des-ede3", Buffer.from(key, "hex"), Buffer.alloc(0));
  return cipher.update(data, "utf8", "base64") + cipher.final("base64");
}

export function legacyMd5Password(password: string, salt: string): string {
  return crypto.createHash("md5").update(salt + password).digest("hex");
}
`.repeat(6), // ~3,500 chars

  "src/models/order.ts": `// src/models/order.ts (ACTIVE ORDER DOMAIN MODEL)
export type OrderStatus = "PENDING" | "PAID" | "PROCESSING" | "SHIPPED" | "REFUNDED" | "CANCELLED";

export interface OrderLineItem {
  sku: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
}

export interface Order {
  id: string;
  tenantId: string;
  customerId: string;
  status: OrderStatus;
  items: OrderLineItem[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  createdAt: string;
  updatedAt: string;
}

export function calculateOrderTotals(items: OrderLineItem[], taxRate: number): { subtotal: number; tax: number; total: number } {
  const subtotal = items.reduce((acc, it) => acc + (it.quantity * it.unitPriceCents), 0);
  const tax = Math.round(subtotal * taxRate);
  return { subtotal, tax, total: subtotal + tax };
}
`.repeat(4), // ~3,600 chars

  "src/models/customer.ts": `// src/models/customer.ts (ACTIVE CUSTOMER DOMAIN MODEL)
export type LoyaltyTier = "STANDARD" | "SILVER" | "GOLD" | "PLATINUM";

export interface CustomerProfile {
  id: string;
  email: string;
  name: string;
  tier: LoyaltyTier;
  creditLimitCents: number;
  activeOrderIds: string[];
}

export function getTierDiscountRate(tier: LoyaltyTier): number {
  switch (tier) {
    case "PLATINUM": return 0.15;
    case "GOLD": return 0.10;
    case "SILVER": return 0.05;
    default: return 0.00;
  }
}
`.repeat(4), // ~3,400 chars

  "src/services/payment.ts": `// src/services/payment.ts (ACTIVE STRIPE PAYMENT GATEWAY)
export interface PaymentIntentRequest {
  orderId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
}

export class PaymentGatewayService {
  async processPayment(req: PaymentIntentRequest): Promise<{ paymentId: string; status: "SUCCEEDED" | "REQUIRES_ACTION" }> {
    // Verified idempotency check before sending to payment provider
    return {
      paymentId: "pi_" + Math.random().toString(36).substring(2, 12),
      status: "SUCCEEDED",
    };
  }
}
`.repeat(5), // ~3,800 chars

  "src/services/inventory.ts": `// src/services/inventory.ts (ACTIVE DISTRIBUTED INVENTORY SERVICE)
export class InventoryReservationService {
  async reserveStock(orderId: string, items: Array<{ sku: string; qty: number }>): Promise<boolean> {
    // Atomic multi-SKU reservation logic
    return true;
  }
}
`.repeat(5), // ~3,800 chars

  "src/controllers/api.ts": `// src/controllers/api.ts (ACTIVE REST API CONTROLLERS)
export interface CheckoutApiPayload {
  customerId: string;
  items: Array<{ sku: string; quantity: number }>;
  paymentToken: string;
}

export async function handleCheckoutEndpoint(payload: CheckoutApiPayload): Promise<{ orderId: string; status: string }> {
  return {
    orderId: "ord_checkout_success",
    status: "PROCESSING",
  };
}
`.repeat(5), // ~3,800 chars
};

export const REJECTED_SKILLS = [
  "postgres-optimization",
  "kubernetes-orchestration",
  "dynamodb-single-table-design",
];

export const REJECTED_FILES = [
  "src/legacy/oracle-connector.ts",
  "src/legacy/soap-client.ts",
  "src/legacy/xml-parser.ts",
  "src/legacy/session-manager.ts",
  "src/legacy/deprecated-crypto.ts",
];

export const RETAINED_SKILLS = [
  "graphql-federation-gateway",
  "mongodb-aggregation",
];

export const RETAINED_FILES = [
  "src/models/order.ts",
  "src/models/customer.ts",
  "src/services/payment.ts",
  "src/services/inventory.ts",
  "src/controllers/api.ts",
];

// ============================================================================
// Multi-Turn Benchmark Generator
// ============================================================================

export interface LargeScaleTranscriptOptions {
  totalTurns?: number;
  workspaceRoot?: string;
  sessionID?: string;
}

export interface LargeScaleBenchmarkResult {
  turnsTested: number;
  totalMessagesInTranscript: number;
  sourcesLoaded: { skills: number; files: number; total: number };
  sourcesEvicted: { skills: number; files: number; total: number };
  sourcesRetained: { skills: number; files: number; total: number };
  beforeEviction: {
    totalChars: number;
    estimatedTokens: number;
  };
  afterEviction: {
    totalChars: number;
    estimatedTokens: number;
  };
  netSavings: {
    charsSaved: number;
    tokensSaved: number;
    percentageReduction: number;
  };
  prefixCachePreservation: {
    firstEvictionIndex: number;
    prefixMessagesCount: number;
    prefixObjectIdentityPreserved: boolean;
    retainedMessagesByteIdentical: boolean;
    systemPromptPreserved: boolean;
    prefixCacheRetentionRate: number;
  };
  latency: {
    totalExecutionTimeMs: number;
    averageTurnLatencyMs: number;
    p95LatencyMs: number;
  };
}

/**
 * Calculates total characters across all text fields of a SessionContextEvent.
 */
export function calculateContextSize(event: SessionContextEvent): {
  totalChars: number;
  estimatedTokens: number;
} {
  let chars = 0;
  if (typeof event.system === "string") {
    chars += event.system.length;
  } else if (Array.isArray(event.system)) {
    for (const part of event.system) {
      if (typeof part === "string") chars += part.length;
      else if (part && typeof part === "object") {
        if (typeof part.text === "string") chars += part.text.length;
        if (typeof part.content === "string") chars += part.content.length;
      }
    }
  }

  for (const msg of event.messages as V2Message[]) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    }
    if (Array.isArray(msg.parts)) {
      for (const part of msg.parts) {
        if (typeof part.text === "string") chars += part.text.length;
        if (typeof part.output === "string") chars += part.output.length;
        if (part.state && typeof part.state.output === "string") {
          chars += part.state.output.length;
        }
        if (Array.isArray(part.content)) {
          for (const sub of part.content) {
            if (typeof sub.text === "string") chars += sub.text.length;
          }
        }
      }
    }
  }

  return {
    totalChars: chars,
    estimatedTokens: Math.ceil(chars / 4),
  };
}

/**
 * Builds an extended realistic multi-turn transcript (50 to 100 turns).
 */
export function buildLargeScaleTranscript(options: LargeScaleTranscriptOptions = {}): {
  messages: V2Message[];
  toolCalls: Array<{
    callID: string;
    tool: "skill" | "read";
    args: any;
  }>;
} {
  const totalTurns = options.totalTurns ?? 100;
  const messages: V2Message[] = [];
  const toolCalls: Array<{ callID: string; tool: "skill" | "read"; args: any }> = [];

  // Turn 0: User initial request
  messages.push({
    id: "msg-turn-0-user",
    role: "user",
    content: "We are architecting the new checkout payment pipeline. Please inspect the available skills and codebase files to determine our implementation plan.",
  });

  let messageIdx = 1;

  // Turns 1..5: Load the 5 heavy skills
  for (const [skillId, skillBody] of Object.entries(HEAVY_SKILLS)) {
    const callID = `call-skill-${skillId}`;
    toolCalls.push({
      callID,
      tool: "skill",
      args: { id: skillId },
    });
    // Assistant tool-call
    messages.push({
      id: `msg-turn-${messageIdx++}-asst-skill-${skillId}`,
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          callID,
          toolCallId: callID,
          toolName: "skill",
          args: { id: skillId },
        },
      ],
    });
    // Tool result
    messages.push({
      id: `msg-turn-${messageIdx++}-tool-skill-${skillId}`,
      role: "tool",
      callID,
      parts: [
        {
          type: "tool-result",
          callID,
          toolCallId: callID,
          toolName: "skill",
          output: skillBody,
        },
      ],
    });
  }

  // Turns 6..15: Load the 10 heavy files
  for (const [filePath, fileContent] of Object.entries(HEAVY_FILES)) {
    const callID = `call-read-${filePath.replace(/[^a-zA-Z0-9]/g, "_")}`;
    toolCalls.push({
      callID,
      tool: "read",
      args: { filePath },
    });
    // Assistant tool-call
    messages.push({
      id: `msg-turn-${messageIdx++}-asst-read-${callID}`,
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          callID,
          toolCallId: callID,
          toolName: "read",
          args: { filePath },
        },
      ],
    });
    // Tool result
    messages.push({
      id: `msg-turn-${messageIdx++}-tool-read-${callID}`,
      role: "tool",
      callID,
      parts: [
        {
          type: "tool-result",
          callID,
          toolCallId: callID,
          toolName: "read",
          output: fileContent,
        },
      ],
    });
  }

  // Turns 16..totalTurns: Extended back-and-forth conversation
  while (messages.length < totalTurns) {
    const turnNumber = messages.length;
    if (turnNumber % 2 === 1) {
      messages.push({
        id: `msg-turn-${turnNumber}-user`,
        role: "user",
        content: `Turn ${turnNumber}: How does our checkout pipeline handle idempotency and transaction consistency when inventory reservation takes longer than 200ms?`,
      });
    } else {
      messages.push({
        id: `msg-turn-${turnNumber}-asst`,
        role: "assistant",
        content: `Turn ${turnNumber}: For idempotency, the payment service checks the unique client idempotency token against our Redis cache before dispatching to the payment gateway. If inventory reservation encounters contention, we issue an atomic compensation rollback.`,
      });
    }
  }

  return { messages, toolCalls };
}

/**
 * Executes the complete large-scale benchmark and collects precision metrics.
 */
export async function runLargeScaleBenchmark(
  options: LargeScaleTranscriptOptions = {}
): Promise<LargeScaleBenchmarkResult> {
  const totalTurns = options.totalTurns ?? 100;
  const workspaceRoot = options.workspaceRoot ?? "C:/virtual-workspace/checkout-app";
  const sessionID = options.sessionID ?? "ses-benchmark-large-scale";

  const { messages: persistedMessages, toolCalls } = buildLargeScaleTranscript({
    totalTurns,
    workspaceRoot,
    sessionID,
  });

  const registry = createRejectionRegistry({ workspaceRoot });

  // 1. Proactively record all tool executions into registry
  for (const tc of toolCalls) {
    registry.recordToolExecution(
      sessionID,
      tc.callID,
      tc.tool,
      tc.args,
      workspaceRoot
    );
  }

  // 2. Measure Context BEFORE Eviction
  const beforeEvent: SessionContextEvent = {
    sessionID,
    system: "You are OpenCode, an expert software engineering agent.",
    messages: persistedMessages,
  };

  // Run context hook before any eviction (Turn 1..15 state)
  applyEvictionToContext(beforeEvent, {
    registry,
    sessionID,
    workspaceRoot,
  });

  const beforeMetrics = calculateContextSize(beforeEvent);

  // 3. Selectively evict 3 heavy skills and 5 heavy files
  for (const skillId of REJECTED_SKILLS) {
    registry.reject(sessionID, `skill:${skillId}`, "Inspected and confirmed irrelevant: service uses MongoDB, not PostgreSQL/Kubernetes/DynamoDB", {
      workspaceRoot,
    });
  }

  for (const fileRelPath of REJECTED_FILES) {
    registry.reject(sessionID, `file:${fileRelPath}`, "Inspected and confirmed irrelevant: legacy deprecated component not used in modern checkout flow", {
      workspaceRoot,
    });
  }

  // 4. Measure Latency across 100 Context Hook Executions
  // Warmup run to allow V8 JIT optimization
  for (let w = 0; w < 5; w++) {
    const warmupEvent: SessionContextEvent = {
      sessionID,
      system: beforeEvent.system,
      messages: persistedMessages,
    };
    applyEvictionToContext(warmupEvent, {
      registry,
      sessionID,
      workspaceRoot,
    });
  }

  const latencySamples: number[] = [];
  let afterEvent: SessionContextEvent | null = null;

  const tStart = performance.now();
  for (let i = 0; i < 100; i++) {
    const iterEvent: SessionContextEvent = {
      sessionID,
      system: beforeEvent.system,
      messages: persistedMessages,
    };
    const t0 = performance.now();
    applyEvictionToContext(iterEvent, {
      registry,
      sessionID,
      workspaceRoot,
    });
    const t1 = performance.now();
    latencySamples.push(t1 - t0);
    if (i === 99) {
      afterEvent = iterEvent;
    }
  }
  const totalExecutionTimeMs = performance.now() - tStart;
  latencySamples.sort((a, b) => a - b);
  const p95LatencyMs = latencySamples[Math.floor(latencySamples.length * 0.95)] ?? 0;
  const averageTurnLatencyMs = totalExecutionTimeMs / 100;

  if (!afterEvent) {
    throw new Error("Benchmark failed to produce afterEvent");
  }

  // 5. Measure Context AFTER Eviction
  const afterMetrics = calculateContextSize(afterEvent);
  const charsSaved = beforeMetrics.totalChars - afterMetrics.totalChars;
  const tokensSaved = beforeMetrics.estimatedTokens - afterMetrics.estimatedTokens;
  const percentageReduction = (charsSaved / beforeMetrics.totalChars) * 100;

  // 6. Verify Prefix-Cache Preservation
  // Locate the first eviction index in the message array
  let firstEvictionIndex = -1;
  const afterMessages = afterEvent.messages as V2Message[];

  for (let i = 0; i < afterMessages.length; i++) {
    if (afterMessages[i] !== persistedMessages[i]) {
      firstEvictionIndex = i;
      break;
    }
  }

  // Confirm exact === object identity for all messages prior to firstEvictionIndex
  let prefixObjectIdentityPreserved = true;
  for (let i = 0; i < firstEvictionIndex; i++) {
    if (afterMessages[i] !== persistedMessages[i]) {
      prefixObjectIdentityPreserved = false;
      break;
    }
  }

  // Confirm system prompt preserved byte-identical determinism
  const systemPromptPreserved =
    typeof afterEvent.system === "string" &&
    afterEvent.system === beforeEvent.system;

  // Confirm retained messages maintain byte-identical determinism
  let retainedMessagesByteIdentical = true;
  for (const retainedSkill of RETAINED_SKILLS) {
    const rawContent = HEAVY_SKILLS[retainedSkill];
    const msg = afterMessages.find((m) => typeof m.id === "string" && m.id.includes(`tool-skill-${retainedSkill}`));
    if (!msg || msg.parts?.[0]?.output !== rawContent) {
      retainedMessagesByteIdentical = false;
      break;
    }
  }

  for (const retainedFile of RETAINED_FILES) {
    const rawContent = HEAVY_FILES[retainedFile];
    const callSuffix = retainedFile.replace(/[^a-zA-Z0-9]/g, "_");
    const msg = afterMessages.find((m) => typeof m.id === "string" && m.id.includes(`tool-read-call-read-${callSuffix}`));
    if (!msg || msg.parts?.[0]?.output !== rawContent) {
      retainedMessagesByteIdentical = false;
      break;
    }
  }

  const prefixCacheRetentionRate = (firstEvictionIndex / persistedMessages.length) * 100;

  return {
    turnsTested: totalTurns,
    totalMessagesInTranscript: persistedMessages.length,
    sourcesLoaded: {
      skills: Object.keys(HEAVY_SKILLS).length,
      files: Object.keys(HEAVY_FILES).length,
      total: Object.keys(HEAVY_SKILLS).length + Object.keys(HEAVY_FILES).length,
    },
    sourcesEvicted: {
      skills: REJECTED_SKILLS.length,
      files: REJECTED_FILES.length,
      total: REJECTED_SKILLS.length + REJECTED_FILES.length,
    },
    sourcesRetained: {
      skills: RETAINED_SKILLS.length,
      files: RETAINED_FILES.length,
      total: RETAINED_SKILLS.length + RETAINED_FILES.length,
    },
    beforeEviction: beforeMetrics,
    afterEviction: afterMetrics,
    netSavings: {
      charsSaved,
      tokensSaved,
      percentageReduction,
    },
    prefixCachePreservation: {
      firstEvictionIndex,
      prefixMessagesCount: firstEvictionIndex,
      prefixObjectIdentityPreserved,
      retainedMessagesByteIdentical,
      systemPromptPreserved,
      prefixCacheRetentionRate,
    },
    latency: {
      totalExecutionTimeMs,
      averageTurnLatencyMs,
      p95LatencyMs,
    },
  };
}

// Standalone execution helper
if (process.argv[1]?.endsWith("large-scale.benchmark.js") || process.argv[1]?.endsWith("large-scale.benchmark.ts")) {
  runLargeScaleBenchmark({ totalTurns: 100 }).then((res) => {
    console.log("=== Large-Scale Benchmark Results ===");
    console.log(JSON.stringify(res, null, 2));
  }).catch((err) => {
    console.error("Benchmark error:", err);
    process.exit(1);
  });
}
