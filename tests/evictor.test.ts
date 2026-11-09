import test from "node:test";
import assert from "node:assert/strict";
import {
  SYSTEM_INSTRUCTION,
  ensureSystemInstruction,
  injectIntoV1SystemArray,
  buildTombstone,
  evictRejectedFromMessages,
  evictInPlaceForV1,
  applyEvictionToContext,
  evictForCompaction,
} from "../src/evictor.js";
import { parseSourceId } from "../src/tracker.js";
import { createRejectionRegistry } from "../src/registry.js";
import { createLogger, type LogEntry } from "../src/logger.js";
import type {
  SessionCompactionEvent,
  SessionContextEvent,
  SourceID,
  SystemPart,
  V1MessageWithParts,
  V2Message,
} from "../src/types.js";

test("buildTombstone returns deterministic marker strings for skill:<id> and file:<path> with preserveMarkers true and false", () => {
  const skillTombstone = buildTombstone("skill:database-optimization", true);
  assert.equal(
    skillTombstone,
    "[Context Evicted: skill database-optimization was inspected and rejected for this task.]"
  );

  // Default preserveMarkers is true
  assert.equal(
    buildTombstone("skill:database-optimization"),
    "[Context Evicted: skill database-optimization was inspected and rejected for this task.]"
  );

  const fileTombstone = buildTombstone(
    "file:.\\src\\config\\database.ts",
    true
  );
  assert.equal(
    fileTombstone,
    "[Context Evicted: file src/config/database.ts was inspected and rejected for this task.]"
  );

  // Works with ParsedSource object directly
  const parsed = parseSourceId("skill:react-performance");
  assert.ok(parsed);
  assert.equal(
    buildTombstone(parsed, true),
    "[Context Evicted: skill react-performance was inspected and rejected for this task.]"
  );

  // preserveMarkers: false returns minimal non-empty placeholder
  assert.equal(
    buildTombstone("skill:database-optimization", false),
    "[Context Evicted]"
  );
  assert.equal(
    buildTombstone("file:src/config/database.ts", false),
    "[Context Evicted]"
  );
});

test("ensureSystemInstruction and injectIntoV1SystemArray append SYSTEM_INSTRUCTION at the end from Turn 1 and deduplicate with === reference identity", () => {
  assert.equal(
    SYSTEM_INSTRUCTION,
    "When you inspect a loaded context source and determine that it is irrelevant to the current task, use context_evict to remove it from subsequent model requests. Do not evict information merely because you have not used it yet. Do not evict uncertain or potentially useful information."
  );

  // 1. undefined or empty string -> SYSTEM_INSTRUCTION
  assert.equal(ensureSystemInstruction(undefined), SYSTEM_INSTRUCTION);
  assert.equal(ensureSystemInstruction(""), SYSTEM_INSTRUCTION);

  // 2. Non-empty string -> appends at end and is idempotent on repeat
  const basePrompt = "You are a helpful coding assistant.";
  const withInstruction = ensureSystemInstruction(basePrompt);
  assert.equal(
    withInstruction,
    `${basePrompt}\n\n${SYSTEM_INSTRUCTION}`
  );
  // Deduplication preserves exact reference
  const deduplicatedString = ensureSystemInstruction(withInstruction);
  assert.equal(deduplicatedString, withInstruction);

  // 3. string[] -> appends string at end and preserves === on repeat
  const strArray: string[] = ["System prompt part 1", "System prompt part 2"];
  const updatedStrArray = ensureSystemInstruction(strArray) as string[];
  assert.notEqual(updatedStrArray, strArray);
  assert.equal(updatedStrArray.length, 3);
  assert.equal(updatedStrArray[0], "System prompt part 1");
  assert.equal(updatedStrArray[1], "System prompt part 2");
  assert.equal(updatedStrArray[2], SYSTEM_INSTRUCTION);

  const deduplicatedStrArray = ensureSystemInstruction(updatedStrArray);
  assert.equal(deduplicatedStrArray, updatedStrArray);

  // 4. SystemPart[] -> appends { type: "text", text: SYSTEM_INSTRUCTION } at end and preserves === on repeat
  const part0: SystemPart = { type: "text", text: "Core system rules" };
  const part1: SystemPart = { type: "text", text: "Workspace instructions" };
  const partArray: SystemPart[] = [part0, part1];

  const updatedPartArray = ensureSystemInstruction(partArray) as SystemPart[];
  assert.notEqual(updatedPartArray, partArray);
  assert.equal(updatedPartArray.length, 3);
  assert.equal(updatedPartArray[0], part0);
  assert.equal(updatedPartArray[1], part1);
  assert.deepEqual(updatedPartArray[2], {
    type: "text",
    text: SYSTEM_INSTRUCTION,
  });

  const deduplicatedPartArray = ensureSystemInstruction(updatedPartArray);
  assert.equal(deduplicatedPartArray, updatedPartArray);

  // 5. injectIntoV1SystemArray mutates V1 output.system in place without duplicating
  const v1System = ["Base V1 system prompt"];
  injectIntoV1SystemArray(v1System);
  assert.equal(v1System.length, 2);
  assert.equal(v1System[1], SYSTEM_INSTRUCTION);
  injectIntoV1SystemArray(v1System);
  assert.equal(v1System.length, 2);
});

test("evictRejectedFromMessages fast-path no-op preserves exact messages array reference (===) when rejectedIds is empty, messages is empty, or enabled is false", () => {
  const messages: V2Message[] = [
    { role: "user", content: "Hello" },
    {
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "skill",
          args: { id: "database-optimization" },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "c1",
      content: "Heavy database optimization skill payload...",
    },
  ];

  // Empty Set
  const resEmptySet = evictRejectedFromMessages(messages, {
    rejectedIds: new Set<SourceID>(),
  });
  assert.equal(resEmptySet.messages, messages);
  assert.equal(resEmptySet.stats.messagesModified, 0);
  assert.equal(resEmptySet.stats.partsRedacted, 0);
  assert.equal(resEmptySet.stats.charsRemoved, 0);
  assert.equal(resEmptySet.stats.prefixPreservedUntilIndex, messages.length);
  assert.deepEqual(resEmptySet.stats.evictedSources, []);

  // Empty Array
  const resEmptyArr = evictRejectedFromMessages(messages, {
    rejectedIds: [],
  });
  assert.equal(resEmptyArr.messages, messages);

  // Disabled in config
  const resDisabled = evictRejectedFromMessages(messages, {
    rejectedIds: new Set<SourceID>(["skill:database-optimization"]),
    config: { enabled: false, preserveMarkers: true, debug: false },
  });
  assert.equal(resDisabled.messages, messages);
  assert.equal(resDisabled.stats.messagesModified, 0);
  assert.equal(resDisabled.stats.charsRemoved, 0);

  // Rejected source not present in transcript -> no-op with === reference preserved
  const resUnmatched = evictRejectedFromMessages(messages, {
    rejectedIds: new Set<SourceID>(["skill:non-existent-skill"]),
  });
  assert.equal(resUnmatched.messages, messages);
  assert.equal(resUnmatched.stats.messagesModified, 0);
  assert.equal(resUnmatched.stats.prefixPreservedUntilIndex, messages.length);
});

test("V2 skill & file eviction: replaces rejected payloads with deterministic tombstones while preserving unrelated sources, tool-call pairings, and === prefix references", () => {
  const msg0User: V2Message = {
    id: "m0",
    role: "user",
    content: "Optimize the React frontend and check database config.",
  };
  const msg1AssistantCalls: V2Message = {
    id: "m1",
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        toolCallId: "call-skill-db",
        toolName: "skill",
        args: { name: "database-optimization" },
      },
      {
        type: "tool-call",
        toolCallId: "call-skill-react",
        toolName: "skill",
        args: { name: "react-performance" },
      },
      {
        type: "tool-call",
        toolCallId: "call-read-db",
        toolName: "read",
        args: { filePath: "src/config/database.ts" },
      },
      {
        type: "tool-call",
        toolCallId: "call-read-app",
        toolName: "read",
        args: { filePath: "src/App.tsx" },
      },
    ],
  };
  const dbSkillPayload =
    "DETAILED_DATABASE_OPTIMIZATION_SKILL_CONTENT_".repeat(50);
  const reactSkillPayload =
    "DETAILED_REACT_PERFORMANCE_SKILL_CONTENT_".repeat(40);
  const dbFilePayload =
    "export const dbPool = { maxConnections: 50, ssl: true };\n".repeat(30);
  const appFilePayload =
    "export function App() { return <div>Hello World</div>; }\n".repeat(20);

  const msg2ToolDbSkill: V2Message = {
    id: "m2",
    role: "tool",
    toolCallId: "call-skill-db",
    toolName: "skill",
    content: dbSkillPayload,
  };
  const msg3ToolReactSkill: V2Message = {
    id: "m3",
    role: "tool",
    toolCallId: "call-skill-react",
    toolName: "skill",
    content: reactSkillPayload,
  };
  const unrelatedPart: V2Message["parts"] = [
    {
      type: "text",
      text: "Unmodified sibling text part inside multipart tool message",
    },
    {
      type: "tool-result",
      toolCallId: "call-read-db",
      toolName: "read",
      args: { filePath: "src/config/database.ts" },
      output: dbFilePayload,
    },
    {
      type: "tool-result",
      toolCallId: "call-read-app",
      toolName: "read",
      args: { filePath: "src/App.tsx" },
      output: appFilePayload,
    },
  ];
  const msg4MultipartToolReads: V2Message = {
    id: "m4",
    role: "tool",
    parts: unrelatedPart,
  };
  const msg5FollowupUser: V2Message = {
    id: "m5",
    role: "user",
    content: "Focus only on App.tsx and react-performance.",
  };

  const originalMessages: V2Message[] = [
    msg0User,
    msg1AssistantCalls,
    msg2ToolDbSkill,
    msg3ToolReactSkill,
    msg4MultipartToolReads,
    msg5FollowupUser,
  ];

  const rejectedIds = new Set<SourceID>([
    "skill:database-optimization",
    "file:src/config/database.ts",
  ]);

  const { messages: nextMessages, stats } = evictRejectedFromMessages(
    originalMessages,
    { rejectedIds }
  );

  // Outer array is cloned
  assert.notEqual(nextMessages, originalMessages);
  assert.equal(nextMessages.length, originalMessages.length);

  // Prefix-cache preservation: messages 0 and 1 (before index 2) retain exact === reference identity
  assert.equal(stats.prefixPreservedUntilIndex, 2);
  assert.equal(nextMessages[0], msg0User);
  assert.equal(nextMessages[1], msg1AssistantCalls);

  // Unaffected messages after index 2 (m3 and m5) ALSO retain exact === reference identity
  assert.equal(nextMessages[3], msg3ToolReactSkill);
  assert.equal(nextMessages[5], msg5FollowupUser);

  // Original messages are never mutated in place (copy-on-write)
  assert.equal(msg2ToolDbSkill.content, dbSkillPayload);
  assert.equal(msg4MultipartToolReads.parts![1].output, dbFilePayload);

  // Mutated message 2: content replaced with exact tombstone, toolCallId & role preserved
  assert.notEqual(nextMessages[2], msg2ToolDbSkill);
  assert.equal(nextMessages[2].id, "m2");
  assert.equal(nextMessages[2].role, "tool");
  assert.equal(nextMessages[2].toolCallId, "call-skill-db");
  assert.equal(nextMessages[2].toolName, "skill");
  assert.equal(
    nextMessages[2].content,
    "[Context Evicted: skill database-optimization was inspected and rejected for this task.]"
  );

  // Mutated message 4: only part[1] is cloned and redacted; sibling parts[0] and parts[2] retain === identity!
  assert.notEqual(nextMessages[4], msg4MultipartToolReads);
  assert.notEqual(nextMessages[4].parts, msg4MultipartToolReads.parts);
  assert.equal(nextMessages[4].parts![0], msg4MultipartToolReads.parts![0]);
  assert.notEqual(nextMessages[4].parts![1], msg4MultipartToolReads.parts![1]);
  assert.equal(nextMessages[4].parts![2], msg4MultipartToolReads.parts![2]);

  // Verify tool-result pairing metadata on mutated part[1] is preserved
  const redactedPart = nextMessages[4].parts![1];
  assert.equal(redactedPart.type, "tool-result");
  assert.equal(redactedPart.toolCallId, "call-read-db");
  assert.equal(redactedPart.toolName, "read");
  assert.deepEqual(redactedPart.args, { filePath: "src/config/database.ts" });
  assert.equal(
    redactedPart.output,
    "[Context Evicted: file src/config/database.ts was inspected and rejected for this task.]"
  );

  // Verify stats
  assert.equal(stats.messagesModified, 2);
  assert.equal(stats.messagesCloned, 2);
  assert.equal(stats.partsRedacted, 2);
  assert.equal(stats.occurrencesEvicted, 2);
  assert.deepEqual(stats.evictedSources, [
    "skill:database-optimization",
    "file:src/config/database.ts",
  ]);
  const expectedCharsRemoved =
    dbSkillPayload.length -
    "[Context Evicted: skill database-optimization was inspected and rejected for this task.]"
      .length +
    (dbFilePayload.length -
      "[Context Evicted: file src/config/database.ts was inspected and rejected for this task.]"
        .length);
  assert.equal(stats.charsRemoved, expectedCharsRemoved);
});

test("XML envelope partial replacement: replaces only the rejected <skill_content> block while preserving surrounding text and other <skill_content> blocks in the same part", () => {
  const dbXmlBlock =
    '<skill_content name="database-optimization">\nUse B-tree indexes and EXPLAIN ANALYZE for slow SQL queries.\n</skill_content>';
  const mongoXmlBlock =
    '<skill_content name="mongodb-indexing">\nUse compound indexes matching ESR (Equality, Sort, Range) rule.\n</skill_content>';
  const combinedText = `Loaded workspace skills:\n${dbXmlBlock}\n---\n${mongoXmlBlock}\nEnd of loaded skills.`;

  const SiblingTextPart = { type: "text", text: "Keep this sibling part" };
  const messages: V2Message[] = [
    { role: "user", content: "Please check indexing." },
    {
      role: "user",
      parts: [
        SiblingTextPart,
        {
          type: "text",
          text: combinedText,
        },
      ],
    },
  ];

  const { messages: nextMessages, stats } = evictRejectedFromMessages(
    messages,
    {
      rejectedIds: ["skill:database-optimization"],
    }
  );

  assert.equal(stats.messagesModified, 1);
  assert.equal(stats.partsRedacted, 1);
  assert.equal(stats.prefixPreservedUntilIndex, 1);
  assert.equal(nextMessages[0], messages[0]);
  assert.equal(nextMessages[1].parts![0], SiblingTextPart);

  const expectedTombstone =
    "[Context Evicted: skill database-optimization was inspected and rejected for this task.]";
  const updatedText = nextMessages[1].parts![1].text!;

  assert.equal(
    updatedText,
    `Loaded workspace skills:\n${expectedTombstone}\n---\n${mongoXmlBlock}\nEnd of loaded skills.`
  );
  // Surrounding text and mongodb-indexing skill remain intact
  assert.ok(updatedText.includes("Loaded workspace skills:"));
  assert.ok(updatedText.includes(mongoXmlBlock));
  assert.ok(updatedText.includes("End of loaded skills."));
  assert.ok(!updatedText.includes("EXPLAIN ANALYZE"));
  assert.equal(
    stats.charsRemoved,
    dbXmlBlock.length - expectedTombstone.length
  );
});

test("V1 V1MessageWithParts eviction and evictInPlaceForV1: replaces part.state.output with tombstone while preserving callID, tool, and state.input", () => {
  const v1Msg0: V1MessageWithParts = {
    info: { id: "msg-0", sessionID: "ses-v1", role: "user" },
    parts: [{ id: "p-0", type: "text", text: "Inspect schema and skills." }],
  };
  const v1TextPart = {
    id: "p-1a",
    type: "text",
    text: "I will read src/schema.ts and src/keep.ts now.",
  };
  const v1RejectedToolPart = {
    id: "p-1b",
    type: "tool",
    tool: "read",
    callID: "v1-call-schema",
    state: {
      status: "completed",
      input: { filePath: "src/schema.ts" },
      output: "export interface Order { id: string; total: number; }\n".repeat(
        20
      ),
      title: "Read src/schema.ts",
    },
  };
  const v1KeptToolPart = {
    id: "p-1c",
    type: "tool",
    tool: "read",
    callID: "v1-call-keep",
    state: {
      status: "completed",
      input: { filePath: "src/keep.ts" },
      output: "export const KEEP_ME = true;",
    },
  };
  const v1Msg1: V1MessageWithParts = {
    info: { id: "msg-1", sessionID: "ses-v1", role: "assistant" },
    parts: [v1TextPart, v1RejectedToolPart, v1KeptToolPart],
  };

  const v1Messages: V1MessageWithParts[] = [v1Msg0, v1Msg1];

  const { messages: evictedV1, stats } = evictRejectedFromMessages(v1Messages, {
    rejectedIds: new Set<SourceID>(["file:src/schema.ts"]),
  });

  assert.equal(stats.messagesModified, 1);
  assert.equal(stats.partsRedacted, 1);
  assert.equal(stats.prefixPreservedUntilIndex, 1);

  // Prefix message 0 and sibling parts 0 and 2 retain === reference identity
  assert.equal(evictedV1[0], v1Msg0);
  assert.notEqual(evictedV1[1], v1Msg1);
  assert.equal(evictedV1[1].info, v1Msg1.info);
  assert.equal(evictedV1[1].parts[0], v1TextPart);
  assert.notEqual(evictedV1[1].parts[1], v1RejectedToolPart);
  assert.equal(evictedV1[1].parts[2], v1KeptToolPart);

  // Verify V1 tool part metadata preserved and state.output replaced with tombstone
  const mutatedPart = evictedV1[1].parts[1];
  assert.equal(mutatedPart.id, "p-1b");
  assert.equal(mutatedPart.type, "tool");
  assert.equal(mutatedPart.tool, "read");
  assert.equal(mutatedPart.callID, "v1-call-schema");
  assert.equal(mutatedPart.state?.status, "completed");
  assert.deepEqual(mutatedPart.state?.input, { filePath: "src/schema.ts" });
  assert.equal(mutatedPart.state?.title, "Read src/schema.ts");
  assert.equal(
    mutatedPart.state?.output,
    "[Context Evicted: file src/schema.ts was inspected and rejected for this task.]"
  );

  // Also test evictInPlaceForV1 helper on { messages } output wrapper
  const v1OutputWrapper = { messages: [v1Msg0, v1Msg1] };
  const inPlaceStats = evictInPlaceForV1(v1OutputWrapper, {
    rejectedIds: new Set<SourceID>(["file:src/schema.ts"]),
  });
  assert.equal(inPlaceStats.messagesModified, 1);
  assert.equal(v1OutputWrapper.messages[0], v1Msg0);
  assert.equal(
    v1OutputWrapper.messages[1].parts[1].state?.output,
    "[Context Evicted: file src/schema.ts was inspected and rejected for this task.]"
  );
});

test("Idempotency: re-running evictRejectedFromMessages on already-evicted messages performs zero mutations and preserves === references", () => {
  const messages: V2Message[] = [
    { role: "user", content: "Check skills and files" },
    {
      role: "skill",
      name: "database-optimization",
      content:
        "Heavy skill content to be evicted once and then tested for idempotency. ".repeat(
          5
        ),
    },
    {
      role: "user",
      parts: [
        {
          type: "text",
          text: `Before\n<skill_content name="a11y-debugging">\n${"ARIA rules and WCAG 2.2 checklist guidelines. ".repeat(5)}\n</skill_content>\nAfter`,
        },
      ],
    },
  ];

  const rejectedIds = new Set<SourceID>([
    "skill:database-optimization",
    "skill:a11y-debugging",
  ]);

  // First pass
  const pass1 = evictRejectedFromMessages(messages, { rejectedIds });
  assert.equal(pass1.stats.messagesModified, 2);
  assert.equal(pass1.stats.partsRedacted, 2);
  assert.ok(pass1.stats.charsRemoved > 0);

  // Second pass on already-redacted messages
  const pass2 = evictRejectedFromMessages(pass1.messages, { rejectedIds });
  assert.equal(pass2.messages, pass1.messages);
  assert.equal(pass2.messages[0], pass1.messages[0]);
  assert.equal(pass2.messages[1], pass1.messages[1]);
  assert.equal(pass2.messages[2], pass1.messages[2]);
  assert.equal(pass2.stats.messagesModified, 0);
  assert.equal(pass2.stats.partsRedacted, 0);
  assert.equal(pass2.stats.charsRemoved, 0);
  assert.equal(pass2.stats.prefixPreservedUntilIndex, pass1.messages.length);

  // Also test idempotency when preserveMarkers: false
  const passMinimal1 = evictRejectedFromMessages(messages, {
    rejectedIds,
    config: { enabled: true, preserveMarkers: false, debug: false },
  });
  assert.equal(passMinimal1.messages[1].content, "[Context Evicted]");
  const passMinimal2 = evictRejectedFromMessages(passMinimal1.messages, {
    rejectedIds,
    config: { enabled: true, preserveMarkers: false, debug: false },
  });
  assert.equal(passMinimal2.messages, passMinimal1.messages);
  assert.equal(passMinimal2.stats.messagesModified, 0);
  assert.equal(passMinimal2.stats.charsRemoved, 0);
});

test("Registry, telemetry logger, applyEvictionToContext, and evictForCompaction integration", () => {
  const registry = createRejectionRegistry();
  const logEntries: LogEntry[] = [];
  const logger = createLogger(
    { enabled: true, debug: true, preserveMarkers: true },
    logEntries
  );

  const secretSkillText =
    "CONFIDENTIAL_SKILL_BODY_NEVER_LOG_OR_SUMMARIZE_IN_COMPACTION_".repeat(15);

  const contextEvent: SessionContextEvent = {
    sessionID: "ses-int",
    system: "Initial system prompt.",
    messages: [
      { role: "user", content: "Start task" },
      {
        role: "skill",
        name: "legacy-migration",
        content: secretSkillText,
      },
    ],
  };

  // Turn 1 before any rejection: system instruction is appended, messages untouched (===)
  const originalMessagesRef = contextEvent.messages;
  const turn1Stats = applyEvictionToContext(contextEvent, {
    registry,
    sessionID: "ses-int",
    logger,
  });
  assert.equal(turn1Stats.messagesModified, 0);
  assert.equal(contextEvent.messages, originalMessagesRef);
  assert.equal(
    contextEvent.system,
    `Initial system prompt.\n\n${SYSTEM_INSTRUCTION}`
  );
  // Known source was automatically synced from transcript
  assert.equal(
    registry.isSourceKnown("ses-int", "skill:legacy-migration"),
    true
  );

  // Reject skill:legacy-migration
  const rej = registry.reject(
    "ses-int",
    "skill:legacy-migration",
    "Not migrating legacy DB"
  );
  assert.equal(rej.ok, true);

  // Turn 2: applyEvictionToContext redacts rejected skill, updates registry stats, and logs privacy-safe event
  const turn2Stats = applyEvictionToContext(contextEvent, {
    registry,
    sessionID: "ses-int",
    logger,
  });
  assert.equal(turn2Stats.messagesModified, 1);
  assert.equal(turn2Stats.partsRedacted, 1);
  assert.ok(turn2Stats.charsRemoved > 500);
  // System prompt remains identical to Turn 1 (no prefix shift!)
  assert.equal(
    contextEvent.system,
    `Initial system prompt.\n\n${SYSTEM_INSTRUCTION}`
  );
  assert.equal(
    contextEvent.messages[1].content,
    "[Context Evicted: skill legacy-migration was inspected and rejected for this task.]"
  );

  // Registry stats updated
  const status = registry.getStatus("ses-int");
  assert.equal(status.rejectedSources[0].evictionCount, 1);
  assert.equal(
    status.rejectedSources[0].lastCharsSaved,
    turn2Stats.charsRemoved
  );

  // Logger recorded telemetry without raw content
  assert.equal(logEntries.length, 1);
  assert.equal(logEntries[0].sourceId, "skill:legacy-migration");
  assert.equal(logEntries[0].reason, "Not migrating legacy DB");
  assert.equal(logEntries[0].evictionSucceeded, true);
  assert.equal(logEntries[0].charsRemoved, turn2Stats.charsRemoved);
  assert.equal(JSON.stringify(logEntries).includes(secretSkillText), false);

  // Compaction filtering: ensures rejected content is excluded from compaction messages and context
  const compactionEvent: SessionCompactionEvent = {
    sessionID: "ses-int",
    messages: [
      { role: "user", content: "Start task" },
      {
        role: "skill",
        name: "legacy-migration",
        content: secretSkillText,
      },
    ],
    context: [
      `Summary note with <skill_content name="legacy-migration">${secretSkillText}</skill_content>`,
    ],
  };

  const compactionResult = evictForCompaction(compactionEvent, {
    registry,
    sessionID: "ses-int",
  });
  assert.equal(compactionResult.stats.messagesModified, 1);
  assert.equal(
    compactionEvent.messages![1].content,
    "[Context Evicted: skill legacy-migration was inspected and rejected for this task.]"
  );
  assert.equal(
    compactionEvent.context![0].includes(secretSkillText),
    false
  );
  assert.equal(
    compactionEvent.context![0],
    "Summary note with [Context Evicted: skill legacy-migration was inspected and rejected for this task.]"
  );
});
