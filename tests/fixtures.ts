import {
  createContextEvictorPlugin,
  type CommandDefinition,
  type ContextEvictorConfig,
  type PluginContext,
  type SessionCompactionEvent,
  type SessionContextEvent,
  type StorageAdapter,
  type ToolDefinition,
  type V1Hooks,
  type V1MessageWithParts,
  type V2Message,
} from "../src/index.js";

export const WORKSPACE_ROOT = "D:/Projects/mongo-order-service";

export const POSTGRES_SKILL_ID = "skill:database-optimization" as const;
export const MONGODB_SKILL_ID = "skill:mongodb-indexing" as const;
export const DATABASE_CONFIG_FILE_ID = "file:src/config/database.ts" as const;
export const USER_MODEL_FILE_ID = "file:src/models/user.ts" as const;

export const POSTGRES_SKILL_TOMBSTONE =
  "[Context Evicted: skill database-optimization was inspected and rejected for this task.]";
export const MONGODB_SKILL_TOMBSTONE =
  "[Context Evicted: skill mongodb-indexing was inspected and rejected for this task.]";
export const DATABASE_CONFIG_FILE_TOMBSTONE =
  "[Context Evicted: file src/config/database.ts was inspected and rejected for this task.]";
export const USER_MODEL_FILE_TOMBSTONE =
  "[Context Evicted: file src/models/user.ts was inspected and rejected for this task.]";

/**
 * Realistic multi-paragraph PostgreSQL skill payload (`skill:database-optimization`).
 */
export const POSTGRES_SKILL_BODY = `# Skill: database-optimization (PostgreSQL 16+)

## Overview
This skill provides production PostgreSQL query tuning, index selection, vacuum configuration, and connection pooling guidelines for relational SQL workloads.

## 1. Query Plan Inspection
Always run \`EXPLAIN (ANALYZE, BUFFERS, VERBOSE)\` before modifying PostgreSQL indexes:
\`\`\`sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT o.id, o.customer_id, o.total_cents
FROM orders o
WHERE o.status = 'PENDING' AND o.created_at >= NOW() - INTERVAL '7 days'
ORDER BY o.created_at DESC
LIMIT 100;
\`\`\`

## 2. Index Architecture (B-Tree, GIN, GiST, BRIN)
- Use partial B-Tree indexes for high-selectivity status filters:
  \`CREATE INDEX CONCURRENTLY idx_orders_pending_created ON orders (created_at DESC) WHERE status = 'PENDING';\`
- Use GIN indexes with \`jsonb_path_ops\` for relational JSONB columns.
- Tune \`random_page_cost = 1.1\` and \`effective_cache_size = 24GB\` on NVMe instances.

## 3. Autovacuum & Bloat Prevention
Configure per-table autovacuum thresholds on high-churn PostgreSQL tables:
\`\`\`sql
ALTER TABLE orders SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  fillfactor = 90
);
\`\`\`
Monitor dead tuples via \`pg_stat_user_tables\` and slow statements via \`pg_stat_statements\`.`;

/**
 * Realistic multi-paragraph MongoDB skill payload (`skill:mongodb-indexing`).
 */
export const MONGODB_SKILL_BODY = `# Skill: mongodb-indexing (MongoDB 7.0+)

## Overview
This skill covers MongoDB compound index design, the ESR (Equality, Sort, Range) rule, covered queries, and aggregation pipeline indexing.

## 1. The ESR (Equality, Sort, Range) Rule
Order fields in compound MongoDB indexes strictly as:
1. **Equality** predicates (\`{ status: "PROCESSING" }\`)
2. **Sort** fields (\`{ createdAt: -1 }\`)
3. **Range** filters (\`{ totalCents: { $gte: 5000 } }\`)

\`\`\`javascript
db.orders.createIndex(
  { tenantId: 1, status: 1, createdAt: -1, totalCents: 1 },
  { name: "idx_orders_esr_tenant_status_created", background: true }
);
\`\`\`

## 2. Execution Stats Verification
Verify index selectivity and zero \`COLLSCAN\` stages using \`explain("executionStats")\`:
- Ensure \`totalDocsExamined\` closely matches \`nReturned\`.
- Avoid in-memory \`SORT\` stages by aligning sort direction with compound index keys.`;

/**
 * Realistic file read payload for `src/config/database.ts`.
 */
export const DATABASE_CONFIG_FILE_CONTENT = `// src/config/database.ts
export interface LegacyPostgresConfig {
  host: string;
  port: number;
  database: string;
  maxPoolSize: number;
  sslMode: "disable" | "require" | "verify-full";
}

export const legacyPgConfig: LegacyPostgresConfig = {
  host: process.env.PG_HOST ?? "127.0.0.1",
  port: Number(process.env.PG_PORT ?? 5432),
  database: process.env.PG_DATABASE ?? "legacy_billing",
  maxPoolSize: 25,
  sslMode: "require",
};
`;

/**
 * Realistic file read payload for `src/models/user.ts`.
 */
export const USER_MODEL_FILE_CONTENT = `// src/models/user.ts
export interface UserDocument {
  _id: string;
  tenantId: string;
  email: string;
  roles: string[];
  createdAt: Date;
  lastLoginAt?: Date;
}

export const USER_COLLECTION = "users";

export function buildUserTenantIndexSpec() {
  return { key: { tenantId: 1, email: 1 }, unique: true };
}
`;

export const BASE_SYSTEM_PROMPT =
  "You are OpenCode, an autonomous software engineering agent assisting with backend service development.";

/**
 * Deeply clones a JSON-serializable value so test fixtures can maintain an immutable
 * snapshot of persisted database history and verify zero in-place mutation.
 */
export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Creates a realistic multi-turn OpenCode V2 conversation transcript with:
 * - Turn 1: User request to optimize MongoDB queries
 * - Turn 1 Assistant: Tool calls for `skill:database-optimization`, `skill:mongodb-indexing`,
 *   `file:src/config/database.ts`, and `file:src/models/user.ts`
 * - Turn 1 Tool Results: Loaded payloads for each tool call
 * - Turn 2 Assistant / User follow-up messages
 */
export function createV2MultiTurnTranscript(): V2Message[] {
  return [
    {
      id: "msg-user-1",
      role: "user",
      content:
        "We need to optimize slow MongoDB order lookup queries by tenantId and createdAt in our order service.",
    },
    {
      id: "msg-asst-1",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Let me load the database optimization skills and inspect the database configuration and user model files.",
        },
        {
          type: "tool-call",
          callID: "call-skill-pg",
          toolCallId: "call-skill-pg",
          toolName: "skill",
          args: { id: "database-optimization" },
        },
        {
          type: "tool-call",
          callID: "call-skill-mongo",
          toolCallId: "call-skill-mongo",
          toolName: "skill",
          args: { id: "mongodb-indexing" },
        },
        {
          type: "tool-call",
          callID: "call-read-db-cfg",
          toolCallId: "call-read-db-cfg",
          toolName: "read",
          args: { filePath: `${WORKSPACE_ROOT}/src/config/database.ts` },
        },
        {
          type: "tool-call",
          callID: "call-read-user-model",
          toolCallId: "call-read-user-model",
          toolName: "read",
          args: { filePath: "src/models/user.ts" },
        },
      ],
    },
    {
      id: "msg-tool-pg",
      role: "tool",
      callID: "call-skill-pg",
      toolCallId: "call-skill-pg",
      toolName: "skill",
      parts: [
        {
          type: "tool-result",
          callID: "call-skill-pg",
          toolCallId: "call-skill-pg",
          toolName: "skill",
          output: POSTGRES_SKILL_BODY,
        },
      ],
    },
    {
      id: "msg-tool-mongo",
      role: "tool",
      callID: "call-skill-mongo",
      toolCallId: "call-skill-mongo",
      toolName: "skill",
      parts: [
        {
          type: "tool-result",
          callID: "call-skill-mongo",
          toolCallId: "call-skill-mongo",
          toolName: "skill",
          output: MONGODB_SKILL_BODY,
        },
      ],
    },
    {
      id: "msg-tool-files",
      role: "tool",
      parts: [
        {
          type: "tool-result",
          callID: "call-read-db-cfg",
          toolCallId: "call-read-db-cfg",
          toolName: "read",
          output: DATABASE_CONFIG_FILE_CONTENT,
        },
        {
          type: "tool-result",
          callID: "call-read-user-model",
          toolCallId: "call-read-user-model",
          toolName: "read",
          output: USER_MODEL_FILE_CONTENT,
        },
      ],
    },
    {
      id: "msg-asst-2",
      role: "assistant",
      content:
        "I have inspected the loaded skills and files. `skill:database-optimization` targets PostgreSQL rather than MongoDB, so I will evict it and proceed with `skill:mongodb-indexing`.",
    },
    {
      id: "msg-user-2",
      role: "user",
      content:
        "Great, please design the compound index for the orders collection using the ESR rule.",
    },
  ];
}

/**
 * Creates a V2 message containing both `<skill_content name="database-optimization">`
 * and `<skill_content name="mongodb-indexing">` XML envelopes inside the same part.
 */
export function createV2CombinedXmlSkillMessage(
  id = "msg-xml-skills"
): V2Message {
  return {
    id,
    role: "user",
    parts: [
      {
        type: "text",
        text: [
          "Loaded skill context blocks:",
          `<skill_content name="database-optimization">\n${POSTGRES_SKILL_BODY}\n</skill_content>`,
          `<skill_content name="mongodb-indexing">\n${MONGODB_SKILL_BODY}\n</skill_content>`,
          "End of loaded skill blocks.",
        ].join("\n\n"),
      },
    ],
  };
}

/**
 * Creates a realistic multi-turn OpenCode V1 transcript (`V1MessageWithParts[]`).
 */
export function createV1MultiTurnTranscript(
  sessionID = "session-v1"
): V1MessageWithParts[] {
  return [
    {
      info: { id: "v1-msg-1", sessionID, role: "user" },
      parts: [
        {
          id: "v1-part-1",
          sessionID,
          messageID: "v1-msg-1",
          type: "text",
          text: "Optimize our MongoDB order queries and check the models.",
        },
      ],
    },
    {
      info: { id: "v1-msg-2", sessionID, role: "assistant" },
      parts: [
        {
          id: "v1-part-2a",
          sessionID,
          messageID: "v1-msg-2",
          type: "tool",
          tool: "skill",
          callID: "v1-call-pg",
          state: {
            status: "completed",
            input: { id: "database-optimization" },
            output: POSTGRES_SKILL_BODY,
          },
        },
        {
          id: "v1-part-2b",
          sessionID,
          messageID: "v1-msg-2",
          type: "tool",
          tool: "skill",
          callID: "v1-call-mongo",
          state: {
            status: "completed",
            input: { id: "mongodb-indexing" },
            output: MONGODB_SKILL_BODY,
          },
        },
        {
          id: "v1-part-2c",
          sessionID,
          messageID: "v1-msg-2",
          type: "tool",
          tool: "read",
          callID: "v1-call-db-cfg",
          state: {
            status: "completed",
            input: { filePath: "src/config/database.ts" },
            output: DATABASE_CONFIG_FILE_CONTENT,
          },
        },
        {
          id: "v1-part-2d",
          sessionID,
          messageID: "v1-msg-2",
          type: "tool",
          tool: "read",
          callID: "v1-call-user-model",
          state: {
            status: "completed",
            input: { filePath: "src/models/user.ts" },
            output: USER_MODEL_FILE_CONTENT,
          },
        },
      ],
    },
    {
      info: { id: "v1-msg-3", sessionID, role: "user" },
      parts: [
        {
          id: "v1-part-3",
          sessionID,
          messageID: "v1-msg-3",
          type: "text",
          text: "Proceed with the MongoDB index creation.",
        },
      ],
    },
  ];
}

export interface InMemoryStorageHarness {
  adapter: StorageAdapter;
  data: Map<string, unknown>;
}

export function createInMemoryStorage(
  initialData?: Map<string, unknown>
): InMemoryStorageHarness {
  const data = initialData ?? new Map<string, unknown>();
  const adapter: StorageAdapter = {
    get<T = unknown>(key: string): T | undefined {
      const val = data.get(key);
      return val !== undefined ? (deepClone(val) as T) : undefined;
    },
    set<T = unknown>(key: string, value: T): void {
      data.set(key, deepClone(value));
    },
    delete(key: string): void {
      data.delete(key);
    },
  };
  return { adapter, data };
}

export interface V2TestHarness {
  ctx: PluginContext;
  storageMap: Map<string, unknown>;
  tools: Record<string, ToolDefinition>;
  commands: Record<string, CommandDefinition>;
  persistedTranscripts: Map<string, V2Message[]>;
  recordToolCall: (
    sessionID: string,
    callID: string,
    tool: string,
    args: Record<string, unknown>
  ) => Promise<void>;
  runContextTurn: (
    sessionID: string,
    messages?: V2Message[],
    system?: SessionContextEvent["system"]
  ) => Promise<SessionContextEvent>;
  runCompaction: (
    sessionID: string,
    event: Partial<SessionCompactionEvent>
  ) => Promise<SessionCompactionEvent>;
}

/**
 * Creates a complete mock OpenCode V2 `PluginContext` harness with simulated
 * persisted transcript storage and hooks.
 */
export async function createV2TestHarness(options?: {
  config?: Partial<ContextEvictorConfig>;
  workspaceRoot?: string;
  sharedStorageMap?: Map<string, unknown>;
}): Promise<V2TestHarness> {
  const workspaceRoot = options?.workspaceRoot ?? WORKSPACE_ROOT;
  const { adapter: storage, data: storageMap } = createInMemoryStorage(
    options?.sharedStorageMap
  );

  const sessionHooks = new Map<
    string,
    (payload: any) => Promise<void> | void
  >();
  const toolHooks = new Map<string, (payload: any) => Promise<void> | void>();
  const tools: Record<string, ToolDefinition> = {};
  const commands: Record<string, CommandDefinition> = {};
  const persistedTranscripts = new Map<string, V2Message[]>();

  const ctx: PluginContext = {
    cwd: workspaceRoot,
    directory: workspaceRoot,
    options: {
      enabled: true,
      debug: false,
      preserveMarkers: true,
      ...(options?.config ?? {}),
    },
    storage,
    session: {
      hook(event, handler) {
        sessionHooks.set(event, handler);
      },
    },
    tool: {
      hook(event, handler) {
        toolHooks.set(event, handler);
      },
      register(nameOrDef, maybeDef) {
        if (typeof nameOrDef === "string" && maybeDef) {
          tools[nameOrDef] = maybeDef;
        } else if (typeof nameOrDef === "object" && nameOrDef.name) {
          tools[nameOrDef.name] = nameOrDef;
        }
      },
      transform(handler) {
        handler(tools);
      },
    },
    command: {
      register(nameOrDef, maybeDef) {
        if (typeof nameOrDef === "string" && maybeDef) {
          commands[nameOrDef] = maybeDef;
        } else if (typeof nameOrDef === "object" && nameOrDef.name) {
          commands[nameOrDef.name] = nameOrDef;
        }
      },
    },
  };

  const plugin = createContextEvictorPlugin(options?.config);
  await plugin.setup(ctx);

  return {
    ctx,
    storageMap,
    tools,
    commands,
    persistedTranscripts,
    async recordToolCall(sessionID, callID, tool, args) {
      const beforeHook = toolHooks.get("execute.before");
      if (beforeHook) {
        await beforeHook({ sessionID, callID, tool, args });
      }
      const afterHook = toolHooks.get("execute.after");
      if (afterHook) {
        await afterHook({ sessionID, callID, tool, args });
      }
    },
    async runContextTurn(
      sessionID,
      messages,
      system = BASE_SYSTEM_PROMPT
    ): Promise<SessionContextEvent> {
      let sessionMessages = messages;
      if (!sessionMessages) {
        if (!persistedTranscripts.has(sessionID)) {
          persistedTranscripts.set(sessionID, createV2MultiTurnTranscript());
        }
        // Pass the persisted transcript array reference into the event (just like OpenCode V2)
        // so tests can verify copy-on-write behavior vs fast-path === reference identity.
        sessionMessages = persistedTranscripts.get(sessionID)!;
      } else if (!persistedTranscripts.has(sessionID)) {
        persistedTranscripts.set(sessionID, sessionMessages);
      }

      const event: SessionContextEvent = {
        sessionID,
        system,
        messages: sessionMessages,
      };
      const contextHook = sessionHooks.get("context");
      if (contextHook) {
        await contextHook(event);
      }
      return event;
    },
    async runCompaction(sessionID, partialEvent) {
      const event: SessionCompactionEvent = {
        sessionID,
        ...partialEvent,
      };
      const compactionHook = sessionHooks.get("compaction");
      if (compactionHook) {
        await compactionHook(event);
      }
      return event;
    },
  };
}

export interface V1TestHarness {
  hooks: V1Hooks;
  storageMap: Map<string, unknown>;
}

/**
 * Creates a complete mock OpenCode V1 `V1Hooks` harness.
 */
export async function createV1TestHarness(options?: {
  config?: Partial<ContextEvictorConfig>;
  workspaceRoot?: string;
  sharedStorageMap?: Map<string, unknown>;
}): Promise<V1TestHarness> {
  const workspaceRoot = options?.workspaceRoot ?? WORKSPACE_ROOT;
  const { adapter: storage, data: storageMap } = createInMemoryStorage(
    options?.sharedStorageMap
  );
  const plugin = createContextEvictorPlugin(options?.config);
  const hooks = await plugin.server({
    directory: workspaceRoot,
    worktree: workspaceRoot,
    options: {
      enabled: true,
      debug: false,
      preserveMarkers: true,
      ...(options?.config ?? {}),
    },
    storage,
  });

  return {
    hooks,
    storageMap,
  };
}
