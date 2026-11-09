import test from "node:test";
import assert from "node:assert/strict";
import {
  SYSTEM_INSTRUCTION,
  evictRejectedFromMessages,
  type V2Message,
} from "../src/index.js";
import {
  BASE_SYSTEM_PROMPT,
  DATABASE_CONFIG_FILE_CONTENT,
  DATABASE_CONFIG_FILE_ID,
  DATABASE_CONFIG_FILE_TOMBSTONE,
  MONGODB_SKILL_BODY,
  MONGODB_SKILL_ID,
  POSTGRES_SKILL_BODY,
  POSTGRES_SKILL_ID,
  POSTGRES_SKILL_TOMBSTONE,
  USER_MODEL_FILE_CONTENT,
  USER_MODEL_FILE_ID,
  WORKSPACE_ROOT,
  createV1MultiTurnTranscript,
  createV1TestHarness,
  createV2CombinedXmlSkillMessage,
  createV2MultiTurnTranscript,
  createV2TestHarness,
  deepClone,
} from "./fixtures.js";

// ============================================================================
// Test A — Single Rejected Skill Eviction
// ============================================================================
test("Test A — Single Rejected Skill Eviction: replaces rejected PostgreSQL skill with deterministic tombstone on next model request", async () => {
  const harness = await createV2TestHarness();
  const sessionID = "session-test-a";
  const persisted = createV2MultiTurnTranscript();

  // Turn 1: Initial model request before any rejection
  const turn1 = await harness.runContextTurn(sessionID, persisted);
  assert.equal(
    turn1.messages[2].parts![0].output,
    POSTGRES_SKILL_BODY,
    "Turn 1 should include full PostgreSQL skill instructions before eviction"
  );

  // Agent inspects skill:database-optimization and rejects it
  const evictResponse = String(
    await harness.tools.context_evict.execute(
      {
        source_id: POSTGRES_SKILL_ID,
        reason: "The skill targets PostgreSQL, but this task uses MongoDB.",
      },
      { sessionID }
    )
  );
  assert.ok(evictResponse.includes("Evicted"));
  assert.ok(evictResponse.includes(POSTGRES_SKILL_ID));

  // Turn 2: Next model request in the same session
  const turn2 = await harness.runContextTurn(sessionID, persisted, turn1.system);

  // Verify full PostgreSQL skill instructions are removed and replaced by deterministic tombstone
  const serializedTurn2 = JSON.stringify(turn2.messages);
  assert.equal(
    serializedTurn2.includes(POSTGRES_SKILL_BODY),
    false,
    "Outgoing model request must not contain full PostgreSQL skill instructions"
  );
  assert.equal(
    turn2.messages[2].parts![0].output,
    POSTGRES_SKILL_TOMBSTONE,
    "Rejected skill must be replaced by exact deterministic tombstone"
  );

  // Verify all other conversation messages and system instructions remain intact
  assert.equal(
    turn2.system,
    `${BASE_SYSTEM_PROMPT}\n\n${SYSTEM_INSTRUCTION}`
  );
  assert.equal(turn2.messages[0].content, persisted[0].content);
  assert.equal(turn2.messages[1].parts![0].text, persisted[1].parts![0].text);
  assert.equal(turn2.messages[3].parts![0].output, MONGODB_SKILL_BODY);
  assert.equal(turn2.messages[4].parts![0].output, DATABASE_CONFIG_FILE_CONTENT);
  assert.equal(turn2.messages[4].parts![1].output, USER_MODEL_FILE_CONTENT);
  assert.equal(turn2.messages[5].content, persisted[5].content);
  assert.equal(turn2.messages[6].content, persisted[6].content);
});

// ============================================================================
// Test B — Non-Rejected Context Preservation
// ============================================================================
test("Test B — Non-Rejected Context Preservation: preserves non-rejected skills and file reads 100% intact", async () => {
  const harness = await createV2TestHarness();
  const sessionID = "session-test-b";
  const persisted = createV2MultiTurnTranscript();
  const snapshot = deepClone(persisted);

  // Case 1: Nothing rejected in session
  const turn1 = await harness.runContextTurn(sessionID, persisted);
  assert.deepEqual(
    turn1.messages,
    snapshot,
    "When 0 sources are rejected, all loaded skills and files must remain 100% intact"
  );
  assert.equal(turn1.messages[2].parts![0].output, POSTGRES_SKILL_BODY);
  assert.equal(turn1.messages[3].parts![0].output, MONGODB_SKILL_BODY);
  assert.equal(turn1.messages[4].parts![0].output, DATABASE_CONFIG_FILE_CONTENT);
  assert.equal(turn1.messages[4].parts![1].output, USER_MODEL_FILE_CONTENT);

  // Case 2: Reject only skill:database-optimization; verify skill:mongodb-indexing and file:src/models/user.ts remain 100% intact
  await harness.tools.context_evict.execute(
    {
      source_id: POSTGRES_SKILL_ID,
      reason: "PostgreSQL optimization is irrelevant to MongoDB indexing.",
    },
    { sessionID }
  );

  const turn2 = await harness.runContextTurn(sessionID, persisted);
  assert.equal(turn2.messages[2].parts![0].output, POSTGRES_SKILL_TOMBSTONE);
  assert.equal(
    turn2.messages[3].parts![0].output,
    MONGODB_SKILL_BODY,
    "Non-rejected skill:mongodb-indexing must remain 100% intact"
  );
  assert.equal(
    turn2.messages[4].parts![0].output,
    DATABASE_CONFIG_FILE_CONTENT,
    "Non-rejected file:src/config/database.ts must remain 100% intact"
  );
  assert.equal(
    turn2.messages[4].parts![1].output,
    USER_MODEL_FILE_CONTENT,
    "Non-rejected file:src/models/user.ts must remain 100% intact"
  );
});

// ============================================================================
// Test C — Multiple Skills Loaded, One Rejected
// ============================================================================
test("Test C — Multiple Skills Loaded, One Rejected: redacts only rejected skill across both standalone tool results and combined <skill_content> XML blocks", async () => {
  const harness = await createV2TestHarness();
  const sessionID = "session-test-c";
  const persisted = [
    ...createV2MultiTurnTranscript(),
    createV2CombinedXmlSkillMessage("msg-combined-xml"),
  ];

  // Prime session with initial turn so both skills are known
  await harness.runContextTurn(sessionID, persisted);

  // Reject only skill:database-optimization
  await harness.tools.context_evict.execute(
    {
      source_id: POSTGRES_SKILL_ID,
      reason: "Using MongoDB, not PostgreSQL.",
    },
    { sessionID }
  );

  const nextTurn = await harness.runContextTurn(sessionID, persisted);

  // 1. Standalone tool results: PostgreSQL skill is evicted, MongoDB skill is untouched
  assert.equal(nextTurn.messages[2].parts![0].output, POSTGRES_SKILL_TOMBSTONE);
  assert.equal(nextTurn.messages[3].parts![0].output, MONGODB_SKILL_BODY);

  // 2. Combined <skill_content> XML part: PostgreSQL XML block is replaced by tombstone while sibling MongoDB XML block remains intact
  const combinedXmlMsg = nextTurn.messages[nextTurn.messages.length - 1];
  const combinedText = combinedXmlMsg.parts![0].text!;
  assert.ok(
    combinedText.includes(POSTGRES_SKILL_TOMBSTONE),
    "Combined XML message must contain tombstone for rejected PostgreSQL skill"
  );
  assert.equal(
    combinedText.includes(POSTGRES_SKILL_BODY),
    false,
    "Combined XML message must not contain raw PostgreSQL skill body"
  );
  assert.ok(
    combinedText.includes(
      `<skill_content name="mongodb-indexing">\n${MONGODB_SKILL_BODY}\n</skill_content>`
    ),
    "Sibling <skill_content name=\"mongodb-indexing\"> block must remain completely intact"
  );
  assert.ok(combinedText.includes("Loaded skill context blocks:"));
  assert.ok(combinedText.includes("End of loaded skill blocks."));
});

// ============================================================================
// Test D — Multi-Turn Persistence Within a Session
// ============================================================================
test("Test D — Multi-Turn Persistence Within a Session: rejected skill remains evicted across Turns 3, 4, and 5 and across storage hydration", async () => {
  const sharedStorageMap = new Map<string, unknown>();
  const harness = await createV2TestHarness({ sharedStorageMap });
  const sessionID = "session-test-d";
  const persisted = createV2MultiTurnTranscript();

  // Turn 1: Load context
  await harness.runContextTurn(sessionID, persisted);

  // Turn 2: Reject skill:database-optimization once
  await harness.tools.context_evict.execute(
    {
      source_id: POSTGRES_SKILL_ID,
      reason: "Rejected on Turn 2 for the remainder of the session.",
    },
    { sessionID }
  );

  const turn2 = await harness.runContextTurn(sessionID, persisted);
  assert.equal(turn2.messages[2].parts![0].output, POSTGRES_SKILL_TOMBSTONE);

  // Turn 3: Append new assistant + user turn to persisted transcript without calling context_evict again
  persisted.push(
    {
      id: "msg-asst-turn3",
      role: "assistant",
      content: "Here is the compound index specification following ESR.",
    },
    {
      id: "msg-user-turn3",
      role: "user",
      content: "Now add a partial index filter for active orders.",
    }
  );
  const turn3 = await harness.runContextTurn(sessionID, persisted);
  assert.equal(
    turn3.messages[2].parts![0].output,
    POSTGRES_SKILL_TOMBSTONE,
    "Turn 3 must keep skill:database-optimization evicted"
  );

  // Turn 4: Another follow-up turn
  persisted.push(
    {
      id: "msg-asst-turn4",
      role: "assistant",
      content: "Added partialFilterExpression to the MongoDB index.",
    },
    {
      id: "msg-user-turn4",
      role: "user",
      content: "Verify the explain plan output.",
    }
  );
  const turn4 = await harness.runContextTurn(sessionID, persisted);
  assert.equal(
    turn4.messages[2].parts![0].output,
    POSTGRES_SKILL_TOMBSTONE,
    "Turn 4 must keep skill:database-optimization evicted"
  );

  // Turn 5: Simulate fresh plugin instance hydrating from ctx.storage for the same session
  const reloadedHarness = await createV2TestHarness({ sharedStorageMap });
  const turn5 = await reloadedHarness.runContextTurn(sessionID, persisted);
  assert.equal(
    turn5.messages[2].parts![0].output,
    POSTGRES_SKILL_TOMBSTONE,
    "Turn 5 (after storage hydration) must keep skill:database-optimization evicted"
  );
  assert.equal(
    turn5.messages[3].parts![0].output,
    MONGODB_SKILL_BODY,
    "Non-rejected MongoDB skill must still be intact on Turn 5"
  );
});

// ============================================================================
// Test E — Cross-Session Isolation
// ============================================================================
test("Test E — Cross-Session Isolation: evicting a skill in session-A never affects session-B", async () => {
  const harness = await createV2TestHarness();
  const sessionA = "session-A";
  const sessionB = "session-B";

  const transcriptA = createV2MultiTurnTranscript();
  const transcriptB = createV2MultiTurnTranscript();

  // Turn 1 in both sessions
  await harness.runContextTurn(sessionA, transcriptA);
  await harness.runContextTurn(sessionB, transcriptB);

  // Reject skill:database-optimization ONLY in session-A
  const resA = String(
    await harness.tools.context_evict.execute(
      {
        source_id: POSTGRES_SKILL_ID,
        reason: "Session A uses MongoDB only.",
      },
      { sessionID: sessionA }
    )
  );
  assert.ok(resA.includes("Evicted"));

  // Next model request in session-A -> evicted
  const nextA = await harness.runContextTurn(sessionA, transcriptA);
  assert.equal(
    nextA.messages[2].parts![0].output,
    POSTGRES_SKILL_TOMBSTONE,
    "session-A must evict skill:database-optimization"
  );

  // Next model request in session-B -> 100% intact and un-evicted
  const nextB = await harness.runContextTurn(sessionB, transcriptB);
  assert.equal(
    nextB.messages[2].parts![0].output,
    POSTGRES_SKILL_BODY,
    "session-B must retain full PostgreSQL skill instructions untouched"
  );
  assert.equal(
    nextB.messages,
    transcriptB,
    "session-B has 0 rejections so its message array reference must be untouched"
  );
});

// ============================================================================
// Test F — Unknown or Invalid Source ID Fails Safely
// ============================================================================
test("Test F — Unknown or Invalid Source ID Fails Safely: rejects malformed IDs, unloaded sources, and empty reasons without throwing or mutating context", async () => {
  const harness = await createV2TestHarness();
  const sessionID = "session-test-f";
  const persisted = createV2MultiTurnTranscript();
  const snapshot = deepClone(persisted);

  // Prime session with known sources from transcript
  await harness.runContextTurn(sessionID, persisted);

  // 1. Malformed source IDs
  const malformedIds = [
    "database-optimization",
    "unknown:foo",
    "skill:",
    "file:",
    "skill:invalid whitespace id",
    "",
    "   ",
  ];
  for (const badId of malformedIds) {
    const out = String(
      await harness.tools.context_evict.execute(
        {
          source_id: badId,
          reason: "Attempting eviction with malformed source_id",
        },
        { sessionID }
      )
    );
    assert.ok(
      out.includes("Failed to evict"),
      `Expected safe failure message for malformed ID "${badId}", got: ${out}`
    );
  }

  // 2. Validly formatted but unloaded/unknown source IDs in this session
  const unknownIds = [
    "skill:non-existent-skill",
    "file:src/never-read.ts",
  ];
  for (const unknownId of unknownIds) {
    const out = String(
      await harness.tools.context_evict.execute(
        {
          source_id: unknownId,
          reason: "Attempting to evict a source that was never loaded",
        },
        { sessionID }
      )
    );
    assert.ok(
      out.includes("Failed to evict") &&
        out.includes("not found or loaded in the current session"),
      `Expected safe failure for unloaded source "${unknownId}", got: ${out}`
    );
  }

  // 3. Empty or whitespace-only reasons
  for (const emptyReason of ["", "   "]) {
    const out = String(
      await harness.tools.context_evict.execute(
        {
          source_id: POSTGRES_SKILL_ID,
          reason: emptyReason,
        },
        { sessionID }
      )
    );
    assert.ok(
      out.includes("Failed to evict") && out.includes("reason"),
      `Expected safe failure for empty reason, got: ${out}`
    );
  }

  // Verify no bogus rejections were recorded
  const statusOut = String(
    await harness.tools.context_evict_status.execute({}, { sessionID })
  );
  assert.ok(statusOut.includes("Active evicted sources: 0"));

  // Verify outgoing model context is completely unchanged
  const afterTurn = await harness.runContextTurn(sessionID, persisted);
  assert.equal(afterTurn.messages, persisted);
  assert.deepEqual(afterTurn.messages, snapshot);
});

// ============================================================================
// Test G — Duplicate Eviction Is Idempotent
// ============================================================================
test("Test G — Duplicate Eviction Is Idempotent: repeated context_evict calls and repeated context hook runs are idempotent", async () => {
  const harness = await createV2TestHarness();
  const sessionID = "session-test-g";
  const persisted = createV2MultiTurnTranscript();

  await harness.runContextTurn(sessionID, persisted);

  // First eviction call
  const firstOut = String(
    await harness.tools.context_evict.execute(
      {
        source_id: POSTGRES_SKILL_ID,
        reason: "Original rejection reason",
      },
      { sessionID }
    )
  );
  assert.ok(firstOut.includes("Evicted"));

  // Second and third eviction calls with different reasons
  const secondOut = String(
    await harness.tools.context_evict.execute(
      {
        source_id: POSTGRES_SKILL_ID,
        reason: "Second different reason that should not overwrite original",
      },
      { sessionID }
    )
  );
  assert.ok(secondOut.toLowerCase().includes("already"));

  const thirdOut = String(
    await harness.tools.context_evict.execute(
      {
        source_id: POSTGRES_SKILL_ID,
        reason: "Third different reason",
      },
      { sessionID }
    )
  );
  assert.ok(thirdOut.toLowerCase().includes("already"));

  // Verify status shows exactly 1 active evicted source and preserves the original reason
  const statusText = String(
    await harness.tools.context_evict_status.execute({}, { sessionID })
  );
  assert.ok(statusText.includes("Active evicted sources: 1"));
  assert.ok(statusText.includes('reason: "Original rejection reason"'));
  assert.equal(statusText.includes("Second different reason"), false);

  // Run context hook on persisted transcript
  const pass1 = await harness.runContextTurn(sessionID, persisted);
  assert.equal(pass1.messages[2].parts![0].output, POSTGRES_SKILL_TOMBSTONE);

  // Run context hook again on the ALREADY-evicted message list (`pass1.messages`)
  // Verify it is a no-op (no double-tombstoning, no extra cloning)
  const pass2 = await harness.runContextTurn(
    sessionID,
    pass1.messages,
    pass1.system
  );
  assert.equal(
    pass2.messages,
    pass1.messages,
    "Running context hook on already-tombstoned messages must be a zero-clone no-op"
  );
  assert.equal(pass2.messages[2].parts![0].output, POSTGRES_SKILL_TOMBSTONE);
});

// ============================================================================
// Test H — Compaction Respects Evictions
// ============================================================================
test("Test H — Compaction Respects Evictions: both OpenCode V2 and V1 compaction hooks redact rejected skills and files before summarization", async () => {
  // 1. OpenCode V2 compaction hook verification
  const v2Harness = await createV2TestHarness();
  const v2Session = "session-test-h-v2";
  const v2Transcript = createV2MultiTurnTranscript();

  await v2Harness.runContextTurn(v2Session, v2Transcript);
  await v2Harness.tools.context_evict.execute(
    {
      source_id: POSTGRES_SKILL_ID,
      reason: "PostgreSQL skill is irrelevant.",
    },
    { sessionID: v2Session }
  );
  await v2Harness.tools.context_evict.execute(
    {
      source_id: DATABASE_CONFIG_FILE_ID,
      reason: "Legacy PostgreSQL config file is irrelevant.",
    },
    { sessionID: v2Session }
  );

  const compactionEvent = await v2Harness.runCompaction(v2Session, {
    messages: v2Transcript,
    transcript: createV2MultiTurnTranscript(),
    context: [
      `Session Skill Context:\n<skill_content name="database-optimization">\n${POSTGRES_SKILL_BODY}\n</skill_content>\n<skill_content name="mongodb-indexing">\n${MONGODB_SKILL_BODY}\n</skill_content>`,
    ],
  });

  // Verify rejected skill and rejected file are replaced with tombstones in compaction.messages & compaction.transcript
  assert.equal(
    compactionEvent.messages![2].parts![0].output,
    POSTGRES_SKILL_TOMBSTONE
  );
  assert.equal(
    compactionEvent.messages![4].parts![0].output,
    DATABASE_CONFIG_FILE_TOMBSTONE
  );
  assert.equal(
    compactionEvent.transcript![2].parts![0].output,
    POSTGRES_SKILL_TOMBSTONE
  );
  assert.equal(
    compactionEvent.transcript![4].parts![0].output,
    DATABASE_CONFIG_FILE_TOMBSTONE
  );

  // Verify non-rejected skill and file remain intact during compaction
  assert.equal(
    compactionEvent.messages![3].parts![0].output,
    MONGODB_SKILL_BODY
  );
  assert.equal(
    compactionEvent.messages![4].parts![1].output,
    USER_MODEL_FILE_CONTENT
  );

  // Verify compaction context string array redacts rejected XML block while keeping non-rejected XML block
  assert.ok(compactionEvent.context![0].includes(POSTGRES_SKILL_TOMBSTONE));
  assert.equal(
    compactionEvent.context![0].includes(POSTGRES_SKILL_BODY),
    false
  );
  assert.ok(compactionEvent.context![0].includes(MONGODB_SKILL_BODY));

  // 2. OpenCode V1 experimental.session.compacting hook verification
  const v1Harness = await createV1TestHarness();
  const v1Session = "session-test-h-v1";
  const v1Messages = createV1MultiTurnTranscript(v1Session);

  await v1Harness.hooks["experimental.chat.messages.transform"]!(
    { sessionID: v1Session },
    { messages: v1Messages.slice() }
  );
  await v1Harness.hooks.tool!.context_evict.execute(
    {
      source_id: POSTGRES_SKILL_ID,
      reason: "PostgreSQL skill is not needed in V1 session.",
    },
    { sessionID: v1Session }
  );
  await v1Harness.hooks.tool!.context_evict.execute(
    {
      source_id: DATABASE_CONFIG_FILE_ID,
      reason: "Legacy DB config is not needed in V1 session.",
    },
    { sessionID: v1Session }
  );

  const v1CompactionOutput = {
    context: [
      `<skill_content name="database-optimization">${POSTGRES_SKILL_BODY}</skill_content>`,
    ],
    messages: createV1MultiTurnTranscript(v1Session),
  };
  await v1Harness.hooks["experimental.session.compacting"]!(
    { sessionID: v1Session },
    v1CompactionOutput
  );

  assert.equal(
    v1CompactionOutput.messages[1].parts[0].state?.output,
    POSTGRES_SKILL_TOMBSTONE
  );
  assert.equal(
    v1CompactionOutput.messages[1].parts[1].state?.output,
    MONGODB_SKILL_BODY
  );
  assert.equal(
    v1CompactionOutput.messages[1].parts[2].state?.output,
    DATABASE_CONFIG_FILE_TOMBSTONE
  );
  assert.equal(
    v1CompactionOutput.messages[1].parts[3].state?.output,
    USER_MODEL_FILE_CONTENT
  );
  assert.equal(v1CompactionOutput.context[0], POSTGRES_SKILL_TOMBSTONE);
});

// ============================================================================
// Test I — Conversation Structure & Persisted History Remain Valid
// ============================================================================
test("Test I — Conversation Structure & Persisted History Remain Valid: preserves roles, IDs, ordering, tool-call/result pairings, and never mutates persisted history", async () => {
  const harness = await createV2TestHarness();
  const sessionID = "session-test-i";
  const persistedTranscript = createV2MultiTurnTranscript();
  const immutableSnapshot = deepClone(persistedTranscript);

  await harness.runContextTurn(sessionID, persistedTranscript);

  // Evict both a skill and a file
  await harness.tools.context_evict.execute(
    {
      source_id: POSTGRES_SKILL_ID,
      reason: "Irrelevant PostgreSQL skill",
    },
    { sessionID }
  );
  await harness.tools.context_evict.execute(
    {
      source_id: DATABASE_CONFIG_FILE_ID,
      reason: "Irrelevant PostgreSQL config file",
    },
    { sessionID }
  );

  const evictedEvent = await harness.runContextTurn(
    sessionID,
    persistedTranscript
  );
  const outMessages = evictedEvent.messages;

  // 1. Message count, ordering, IDs, and roles are 100% preserved
  assert.equal(outMessages.length, persistedTranscript.length);
  for (let i = 0; i < outMessages.length; i++) {
    assert.equal(outMessages[i].id, persistedTranscript[i].id);
    assert.equal(outMessages[i].role, persistedTranscript[i].role);
  }

  // 2. All tool-call (assistant) and tool-result (tool) pairings (callID / toolCallId) remain intact and balanced
  const assistantToolCalls = outMessages[1].parts!.filter(
    (p) => p.type === "tool-call"
  );
  assert.equal(assistantToolCalls.length, 4);
  const expectedCallIds = [
    "call-skill-pg",
    "call-skill-mongo",
    "call-read-db-cfg",
    "call-read-user-model",
  ];
  assert.deepEqual(
    assistantToolCalls.map((p) => p.callID),
    expectedCallIds
  );

  const toolResultCallIds = [
    outMessages[2].parts![0].callID,
    outMessages[3].parts![0].callID,
    outMessages[4].parts![0].callID,
    outMessages[4].parts![1].callID,
  ];
  assert.deepEqual(toolResultCallIds, expectedCallIds);
  assert.equal(outMessages[2].callID, "call-skill-pg");
  assert.equal(outMessages[2].toolCallId, "call-skill-pg");
  assert.equal(outMessages[2].parts![0].toolCallId, "call-skill-pg");
  assert.equal(outMessages[4].parts![0].callID, "call-read-db-cfg");
  assert.equal(outMessages[4].parts![0].toolCallId, "call-read-db-cfg");

  // 3. Persisted conversation history outside the outgoing request copy is NEVER mutated in-place
  assert.deepEqual(
    persistedTranscript,
    immutableSnapshot,
    "Persisted conversation history must remain byte-for-byte identical to the original snapshot"
  );
  assert.equal(
    persistedTranscript[2].parts![0].output,
    POSTGRES_SKILL_BODY,
    "Persisted transcript must still hold the full original PostgreSQL skill body"
  );
  assert.equal(
    persistedTranscript[4].parts![0].output,
    DATABASE_CONFIG_FILE_CONTENT,
    "Persisted transcript must still hold the full original database.ts content"
  );
});

// ============================================================================
// Test J — Prefix-Cache Preservation Stability
// ============================================================================
test("Test J — Prefix-Cache Preservation Stability: Turn-1 system prompt stability, zero-clone fast path, strict === prefix reference identity, and deterministic tombstones", async () => {
  const harness = await createV2TestHarness();
  const sessionID = "session-test-j";
  const persisted = createV2MultiTurnTranscript();

  // 1. Turn 1 (0 rejections): SYSTEM_INSTRUCTION is already appended on Turn 1, and messages use zero-clone fast path
  const turn1 = await harness.runContextTurn(
    sessionID,
    persisted,
    BASE_SYSTEM_PROMPT
  );
  const expectedSystem = `${BASE_SYSTEM_PROMPT}\n\n${SYSTEM_INSTRUCTION}`;
  assert.equal(turn1.system, expectedSystem);
  assert.equal(
    turn1.messages,
    persisted,
    "When 0 sources are rejected, event.messages array reference must be strictly ==="
  );
  for (let i = 0; i < persisted.length; i++) {
    assert.equal(turn1.messages[i], persisted[i]);
  }

  // 2. Evict source loaded at message index k = 2 (msg-tool-pg)
  await harness.tools.context_evict.execute(
    {
      source_id: POSTGRES_SKILL_ID,
      reason: "Reason 1 at timestamp T1",
    },
    { sessionID }
  );

  // Turn 2: First turn after eviction
  const turn2 = await harness.runContextTurn(
    sessionID,
    persisted,
    turn1.system
  );

  // System prompt does NOT shift when first eviction occurs
  assert.equal(
    turn2.system,
    expectedSystem,
    "event.system must remain byte-for-byte identical after first eviction"
  );

  // All messages before index k=2 (indices 0 and 1) and all unaffected messages after index k=2 (indices 3, 4, 5, 6)
  // retain strict === object reference identity
  assert.equal(
    turn2.messages[0],
    persisted[0],
    "Prefix message 0 must retain strict === reference identity"
  );
  assert.equal(
    turn2.messages[1],
    persisted[1],
    "Prefix message 1 must retain strict === reference identity"
  );
  assert.notEqual(
    turn2.messages[2],
    persisted[2],
    "Mutated message at index k=2 must be copy-on-write cloned"
  );
  assert.equal(
    turn2.messages[3],
    persisted[3],
    "Unaffected message 3 must retain strict === reference identity"
  );
  assert.equal(
    turn2.messages[4],
    persisted[4],
    "Unaffected message 4 must retain strict === reference identity"
  );
  assert.equal(
    turn2.messages[5],
    persisted[5],
    "Unaffected message 5 must retain strict === reference identity"
  );
  assert.equal(
    turn2.messages[6],
    persisted[6],
    "Unaffected message 6 must retain strict === reference identity"
  );

  // Verify direct stats from evictRejectedFromMessages report prefixPreservedUntilIndex === 2 and messagesCloned === 1
  const directEvict = evictRejectedFromMessages(persisted, {
    rejectedIds: [POSTGRES_SKILL_ID],
    workspaceRoot: WORKSPACE_ROOT,
  });
  assert.equal(directEvict.stats.prefixPreservedUntilIndex, 2);
  assert.equal(directEvict.stats.messagesCloned, 1);

  // 3. Deterministic tombstone stability across turns: tombstone never embeds timestamps or mutable reasons
  const turn3 = await harness.runContextTurn(
    sessionID,
    persisted,
    turn2.system
  );
  assert.equal(
    JSON.stringify(turn2.messages),
    JSON.stringify(turn3.messages),
    "Serialized messages with tombstones must be 100% byte-identical across subsequent turns"
  );
});

// ============================================================================
// Test K — Restoration & Session Reset (context_restore, context_reset, /context-evictor)
// ============================================================================
test("Test K — Restoration & Session Reset: context_restore selectively restores a single source and context_reset / /context-evictor restores all sources", async () => {
  const harness = await createV2TestHarness();
  const sessionID = "session-test-k";
  const persisted = createV2MultiTurnTranscript();

  // Turn 1: Initial load
  await harness.runContextTurn(sessionID, persisted);

  // Reject both skill:database-optimization and file:src/config/database.ts
  await harness.tools.context_evict.execute(
    {
      source_id: POSTGRES_SKILL_ID,
      reason: "Initially thought we only needed MongoDB",
    },
    { sessionID }
  );
  await harness.tools.context_evict.execute(
    {
      source_id: DATABASE_CONFIG_FILE_ID,
      reason: "Initially thought legacy DB config was unused",
    },
    { sessionID }
  );

  // Turn 2: Verify both are evicted
  const turn2 = await harness.runContextTurn(sessionID, persisted);
  assert.equal(turn2.messages[2].parts![0].output, POSTGRES_SKILL_TOMBSTONE);
  assert.equal(
    turn2.messages[4].parts![0].output,
    DATABASE_CONFIG_FILE_TOMBSTONE
  );

  // Restore skill:database-optimization via context_restore tool
  const restoreOut = String(
    await harness.tools.context_restore.execute(
      { source_id: POSTGRES_SKILL_ID },
      { sessionID }
    )
  );
  assert.ok(restoreOut.includes("Restored"));
  assert.ok(restoreOut.includes(POSTGRES_SKILL_ID));

  // Turn 3: Verify skill:database-optimization is back in full while file:src/config/database.ts remains evicted
  const turn3 = await harness.runContextTurn(sessionID, persisted);
  assert.equal(
    turn3.messages[2].parts![0].output,
    POSTGRES_SKILL_BODY,
    "Restored skill:database-optimization must be back in full on the next model request"
  );
  assert.equal(
    turn3.messages[4].parts![0].output,
    DATABASE_CONFIG_FILE_TOMBSTONE,
    "Unrestored file:src/config/database.ts must remain evicted"
  );

  // Also test restoring via `/context-evictor restore` and re-evicting via `/context-evictor evict`
  const slashRestoreFile = String(
    await harness.commands["context-evictor"].execute(
      `restore ${DATABASE_CONFIG_FILE_ID}`,
      { sessionID }
    )
  );
  assert.ok(slashRestoreFile.includes("Restored"));

  const turn4 = await harness.runContextTurn(sessionID, persisted);
  assert.equal(
    turn4.messages[4].parts![0].output,
    DATABASE_CONFIG_FILE_CONTENT,
    "File restored via /context-evictor restore must be back in full"
  );

  // Re-evict both and then reset the session via context_reset
  await harness.tools.context_evict.execute(
    { source_id: POSTGRES_SKILL_ID, reason: "Evict again before reset" },
    { sessionID }
  );
  await harness.tools.context_evict.execute(
    { source_id: DATABASE_CONFIG_FILE_ID, reason: "Evict again before reset" },
    { sessionID }
  );
  const resetOut = String(
    await harness.tools.context_reset.execute({}, { sessionID })
  );
  assert.ok(resetOut.includes("Cleared 2"));

  // Turn 5: Verify all sources are restored and fast-path === reference identity is resumed
  const turn5 = await harness.runContextTurn(sessionID, persisted);
  assert.equal(turn5.messages, persisted);
  assert.equal(turn5.messages[2].parts![0].output, POSTGRES_SKILL_BODY);
  assert.equal(
    turn5.messages[4].parts![0].output,
    DATABASE_CONFIG_FILE_CONTENT
  );
});
