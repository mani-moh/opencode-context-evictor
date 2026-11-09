import test from "node:test";
import assert from "node:assert/strict";
import {
  createRejectionRegistry,
  RejectionRegistry,
  getSessionStorageKey,
} from "../src/registry.js";
import type { StorageAdapter, V2Message, V1MessageWithParts } from "../src/types.js";

test("session isolation: rejecting, restoring, or resetting in session-1 never affects session-2", () => {
  const registry = createRejectionRegistry();

  registry.recordKnownSource("session-1", "skill:database-optimization");
  registry.recordKnownSource("session-2", "skill:database-optimization");
  registry.recordKnownSource("session-2", "file:src/index.ts");

  const r1 = registry.reject(
    "session-1",
    "skill:database-optimization",
    "Not a DB task"
  );
  assert.equal(r1.ok, true);
  assert.equal(registry.isRejected("session-1", "skill:database-optimization"), true);
  assert.equal(registry.isRejected("session-2", "skill:database-optimization"), false);

  const r2 = registry.reject("session-2", "file:src/index.ts", "Entrypoint not needed");
  assert.equal(r2.ok, true);
  assert.equal(registry.isRejected("session-1", "file:src/index.ts"), false);
  assert.equal(registry.isRejected("session-2", "file:src/index.ts"), true);

  assert.equal(registry.getRejected("session-1").length, 1);
  assert.equal(registry.getRejected("session-2").length, 1);

  // Resetting session-1 does not clear session-2
  const resetRes = registry.reset("session-1");
  assert.equal(resetRes.clearedCount, 1);
  assert.equal(registry.getRejected("session-1").length, 0);
  assert.equal(registry.getRejected("session-2").length, 1);
  assert.equal(registry.isRejected("session-2", "file:src/index.ts"), true);
});

test("recordToolExecution proactively tracks skill and read tool calls, callID mapping, and workspace-relative paths", () => {
  const registry = createRejectionRegistry({ workspaceRoot: "d:\\workspace" });

  const skillSource = registry.recordToolExecution(
    "ses-tools",
    "call-101",
    "skill",
    { id: "react-performance" }
  );
  assert.equal(skillSource, "skill:react-performance");
  assert.equal(registry.isSourceKnown("ses-tools", "skill:react-performance"), true);
  assert.equal(
    registry.getCallIdMap("ses-tools").get("call-101"),
    "skill:react-performance"
  );

  const fileSource = registry.recordToolExecution(
    "ses-tools",
    "call-102",
    "read",
    { filePath: "d:\\workspace\\src\\components\\Button.tsx" }
  );
  assert.equal(fileSource, "file:src/components/Button.tsx");
  assert.equal(
    registry.isSourceKnown("ses-tools", "file:src/components/Button.tsx"),
    true
  );
  assert.equal(
    registry.isSourceKnown(
      "ses-tools",
      "file:d:\\workspace\\src\\components\\Button.tsx"
    ),
    true
  );
  assert.equal(
    registry.getCallIdMap("ses-tools").get("call-102"),
    "file:src/components/Button.tsx"
  );

  // Unrelated tools return null and do not pollute knownSources
  const bashSource = registry.recordToolExecution(
    "ses-tools",
    "call-103",
    "bash",
    { command: "npm test" }
  );
  assert.equal(bashSource, null);
  assert.equal(registry.getCallIdMap("ses-tools").has("call-103"), false);
});

test("syncKnownSourcesFromMessages and isSourceKnown discover sources from V2 and V1 transcripts", () => {
  const registry = createRejectionRegistry();

  const v2Messages: V2Message[] = [
    {
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          toolCallId: "tc-1",
          toolName: "skill",
          args: { name: "frontend-design" },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "tc-1",
      content: "Frontend design skill instructions...",
    },
  ];

  // Before syncing, isSourceKnown can inspect passed messages directly
  assert.equal(
    registry.isSourceKnown("ses-msg", "skill:frontend-design", v2Messages),
    true
  );

  // Explicit sync merges from V1 messages as well
  const v1Messages: V1MessageWithParts[] = [
    {
      info: { id: "m1", sessionID: "ses-msg", role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: "read",
          callID: "v1-c1",
          state: {
            input: { filePath: "src/db/schema.ts" },
            output: "export const schema = {};",
          },
        },
      ],
    },
  ];

  const synced = registry.syncKnownSourcesFromMessages("ses-msg", v1Messages);
  assert.equal(synced.has("file:src/db/schema.ts"), true);
  assert.equal(registry.isSourceKnown("ses-msg", "file:src/db/schema.ts"), true);
});

test("reject fails safely on invalid source_id, empty reason, or unknown/unloaded source", () => {
  const registry = createRejectionRegistry();
  registry.recordKnownSource("ses-safe", "skill:known-skill");

  // 1. Invalid source_id format
  const invalidId = registry.reject(
    "ses-safe",
    "invalid-prefix:foo",
    "Not needed"
  );
  assert.equal(invalidId.ok, false);
  if (!invalidId.ok) {
    assert.equal(invalidId.code, "INVALID_SOURCE_ID");
    assert.ok(invalidId.error.length > 0);
  }

  // 2. Empty or whitespace-only reason
  const emptyReason = registry.reject("ses-safe", "skill:known-skill", "   ");
  assert.equal(emptyReason.ok, false);
  if (!emptyReason.ok) {
    assert.equal(emptyReason.code, "INVALID_REASON");
    assert.ok(emptyReason.error.length > 0);
  }
  assert.equal(registry.isRejected("ses-safe", "skill:known-skill"), false);

  // 3. Unknown / unloaded source when requireKnown is true (default)
  const unknownSource = registry.reject(
    "ses-safe",
    "skill:never-loaded-skill",
    "Trying to evict something not in session"
  );
  assert.equal(unknownSource.ok, false);
  if (!unknownSource.ok) {
    assert.equal(unknownSource.code, "UNKNOWN_SOURCE");
    assert.ok(unknownSource.error.includes("skill:never-loaded-skill"));
  }
  assert.equal(registry.isRejected("ses-safe", "skill:never-loaded-skill"), false);
  assert.equal(registry.getRejected("ses-safe").length, 0);
});

test("reject is idempotent: duplicate rejection preserves original rejectedAt, reason, and eviction stats", () => {
  const registry = createRejectionRegistry();
  registry.recordKnownSource("ses-idem", "skill:database-optimization");

  const first = registry.reject(
    "ses-idem",
    "skill:database-optimization",
    "First rejection reason",
    { now: 1700000000000 }
  );
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.alreadyRejected, false);
    assert.equal(first.record.sourceId, "skill:database-optimization");
    assert.equal(first.record.kind, "skill");
    assert.equal(first.record.target, "database-optimization");
    assert.equal(first.record.reason, "First rejection reason");
    assert.equal(first.record.rejectedAt, 1700000000000);
    assert.equal(first.record.evictionCount, 0);
    assert.equal(first.record.lastCharsSaved, 0);
  }

  // Update eviction metrics before duplicate rejection
  registry.recordEvictionStats("ses-idem", "skill:database-optimization", 3850);

  // Second rejection with different reason and timestamp
  const second = registry.reject(
    "ses-idem",
    "skill:database-optimization",
    "Second different reason",
    { now: 1700000099999 }
  );
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.alreadyRejected, true);
    assert.equal(second.record.reason, "First rejection reason");
    assert.equal(second.record.rejectedAt, 1700000000000);
    assert.equal(second.record.evictionCount, 1);
    assert.equal(second.record.lastCharsSaved, 3850);
  }

  assert.equal(registry.getRejected("ses-idem").length, 1);
});

test("restore removes source from active rejections while preserving known provenance so it can be re-rejected later", () => {
  const registry = createRejectionRegistry();
  registry.recordKnownSource("ses-restore", "file:src/legacy/adapter.ts");

  const rejected = registry.reject(
    "ses-restore",
    "file:./src/legacy/adapter.ts",
    "Thought it was unused",
    { now: 1000 }
  );
  assert.equal(rejected.ok, true);
  assert.equal(
    registry.isRejected("ses-restore", "file:src/legacy/adapter.ts"),
    true
  );

  // Restore the source
  const restoreRes = registry.restore(
    "ses-restore",
    "file:src\\legacy\\adapter.ts"
  );
  assert.equal(restoreRes.restored, true);
  assert.equal(restoreRes.sourceId, "file:src/legacy/adapter.ts");
  assert.equal(restoreRes.record?.reason, "Thought it was unused");

  assert.equal(
    registry.isRejected("ses-restore", "file:src/legacy/adapter.ts"),
    false
  );
  assert.equal(
    registry.isSourceKnown("ses-restore", "file:src/legacy/adapter.ts"),
    true
  );

  // Restoring again when not rejected returns restored: false
  const secondRestore = registry.restore(
    "ses-restore",
    "file:src/legacy/adapter.ts"
  );
  assert.equal(secondRestore.restored, false);
  assert.equal(secondRestore.sourceId, "file:src/legacy/adapter.ts");

  // Because it remains known, it can be rejected again later with new reason & timestamp
  const reRejected = registry.reject(
    "ses-restore",
    "file:src/legacy/adapter.ts",
    "Confirmed unused after checking imports",
    { now: 2000 }
  );
  assert.equal(reRejected.ok, true);
  if (reRejected.ok) {
    assert.equal(reRejected.alreadyRejected, false);
    assert.equal(
      reRejected.record.reason,
      "Confirmed unused after checking imports"
    );
    assert.equal(reRejected.record.rejectedAt, 2000);
  }
});

test("getStatus and recordEvictionStats report accurate counts and character savings", () => {
  const registry = createRejectionRegistry();
  registry.recordKnownSource("ses-stats", "skill:skill-a");
  registry.recordKnownSource("ses-stats", "file:src/b.ts");
  registry.recordKnownSource("ses-stats", "file:src/c.ts");

  registry.reject("ses-stats", "skill:skill-a", "Irrelevant skill");
  registry.reject("ses-stats", "file:src/b.ts", "Irrelevant file");

  registry.recordEvictionStats("ses-stats", "skill:skill-a", 2400);
  registry.recordEvictionStats("ses-stats", "file:src/b.ts", 1100);
  registry.recordEvictionStats("ses-stats", "skill:skill-a", 2400);

  const status = registry.getStatus("ses-stats");
  assert.equal(status.sessionID, "ses-stats");
  assert.equal(status.activeCount, 2);
  assert.equal(status.knownSources.length, 3);
  assert.equal(status.totalCharsSavedLastPass, 3500);
  assert.equal(status.totalCharsRemoved, 3500);

  const skillRecord = status.rejectedSources.find(
    (r) => r.sourceId === "skill:skill-a"
  );
  assert.ok(skillRecord);
  assert.equal(skillRecord.evictionCount, 2);
  assert.equal(skillRecord.evictedCount, 2);
  assert.equal(skillRecord.lastCharsSaved, 2400);
  assert.equal(skillRecord.lastCharsRemoved, 2400);
});

test("StorageAdapter persistence and hydrateSession recover session metadata without ever storing raw content", async () => {
  const backingStore = new Map<string, unknown>();
  const storage: StorageAdapter = {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return backingStore.get(key) as T | undefined;
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      backingStore.set(key, JSON.parse(JSON.stringify(value)));
    },
  };

  const registry1 = createRejectionRegistry({ storage });
  const secretRawContent =
    "ULTRA_SENSITIVE_RAW_SKILL_DOCUMENTATION_CONTENT_DO_NOT_PERSIST";

  const messages: V2Message[] = [
    {
      role: "skill",
      name: "security-audit",
      content: secretRawContent,
    },
  ];

  registry1.recordToolExecution("ses-persist", "call-77", "read", {
    filePath: "src/auth.ts",
  });
  registry1.syncKnownSourcesFromMessages("ses-persist", messages);

  const rej = registry1.reject(
    "ses-persist",
    "skill:security-audit",
    "Task is docs-only",
    { now: 5000 }
  );
  assert.equal(rej.ok, true);
  registry1.recordEvictionStats("ses-persist", "skill:security-audit", 1800);

  const storageKey = getSessionStorageKey("ses-persist");
  assert.equal(storageKey, "context-evictor:session:ses-persist");
  assert.equal(backingStore.has(storageKey), true);

  // Verify raw content is NEVER written to storage
  const rawStoredJson = JSON.stringify(backingStore.get(storageKey));
  assert.equal(rawStoredJson.includes(secretRawContent), false);
  assert.equal(rawStoredJson.includes("skill:security-audit"), true);
  assert.equal(rawStoredJson.includes("file:src/auth.ts"), true);

  // Create a fresh registry instance backed by the same storage and hydrate
  const registry2 = new RejectionRegistry({ storage });
  await registry2.hydrateSession("ses-persist");

  assert.equal(
    registry2.isRejected("ses-persist", "skill:security-audit"),
    true
  );
  assert.equal(
    registry2.isSourceKnown("ses-persist", "file:src/auth.ts"),
    true
  );
  assert.equal(
    registry2.getCallIdMap("ses-persist").get("call-77"),
    "file:src/auth.ts"
  );

  const recoveredStatus = registry2.getStatus("ses-persist");
  assert.equal(recoveredStatus.activeCount, 1);
  assert.equal(recoveredStatus.rejectedSources[0].reason, "Task is docs-only");
  assert.equal(recoveredStatus.rejectedSources[0].rejectedAt, 5000);
  assert.equal(recoveredStatus.rejectedSources[0].evictionCount, 1);
  assert.equal(recoveredStatus.rejectedSources[0].lastCharsSaved, 1800);
});

test("StorageAdapter errors are caught gracefully and never crash registry operations", async () => {
  const brokenStorage: StorageAdapter = {
    get() {
      return Promise.reject(new Error("Storage read failure"));
    },
    set() {
      return Promise.reject(new Error("Disk quota exceeded"));
    },
  };

  const registry = createRejectionRegistry({ storage: brokenStorage });

  // Hydrate should not throw even when storage.get rejects
  await assert.doesNotReject(async () => {
    await registry.hydrateSession("ses-broken");
  });

  // Mutations should succeed in memory even when storage.set rejects
  const src = registry.recordToolExecution("ses-broken", "c-1", "skill", {
    id: "resilient-skill",
  });
  assert.equal(src, "skill:resilient-skill");

  const res = registry.reject(
    "ses-broken",
    "skill:resilient-skill",
    "Still works in memory"
  );
  assert.equal(res.ok, true);
  assert.equal(registry.isRejected("ses-broken", "skill:resilient-skill"), true);
});
