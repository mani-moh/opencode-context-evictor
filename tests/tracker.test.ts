import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFilePath,
  formatSourceId,
  parseSourceId,
  parseAndValidateSourceId,
  isValidSourceId,
  extractSourceFromToolCall,
  locateSourceInMessages,
  collectKnownSourcesFromMessages,
} from "../src/tracker.js";
import type { V1MessageWithParts, V2Message, SourceID } from "../src/types.js";

test("normalizeFilePath normalizes slashes, strips leading ./, collapses duplicate slashes, and strips workspaceRoot", () => {
  assert.equal(
    normalizeFilePath("src\\config\\database.ts"),
    "src/config/database.ts"
  );
  assert.equal(
    normalizeFilePath("./src//config///database.ts"),
    "src/config/database.ts"
  );
  assert.equal(
    normalizeFilePath(
      "d:\\Projects\\app\\src\\config\\database.ts",
      "d:\\Projects\\app"
    ),
    "src/config/database.ts"
  );
  assert.equal(
    normalizeFilePath(
      "D:/Projects/app/src/config/database.ts",
      "d:\\Projects\\app\\"
    ),
    "src/config/database.ts"
  );
  assert.equal(
    normalizeFilePath("/workspace/repo/src/index.ts", "/workspace/repo"),
    "src/index.ts"
  );
  assert.equal(normalizeFilePath("   "), "");
  assert.equal(normalizeFilePath("./"), "");
});

test("parseSourceId and parseAndValidateSourceId validate skill:<id> and file:<path> formats", () => {
  const validSkill = parseAndValidateSourceId("skill:database-optimization");
  assert.equal(validSkill.valid, true);
  if (validSkill.valid) {
    assert.deepEqual(validSkill.parsed, {
      kind: "skill",
      target: "database-optimization",
      normalizedTarget: "database-optimization",
      raw: "skill:database-optimization",
    });
  }

  const validSkill2 = parseSourceId("  skill:frontend_design.v2  ");
  assert.deepEqual(validSkill2, {
    kind: "skill",
    target: "frontend_design.v2",
    normalizedTarget: "frontend_design.v2",
    raw: "skill:frontend_design.v2",
  });

  const validFile = parseAndValidateSourceId(
    "file:.\\src\\config\\\\database.ts"
  );
  assert.equal(validFile.valid, true);
  if (validFile.valid) {
    assert.deepEqual(validFile.parsed, {
      kind: "file",
      target: "src/config/database.ts",
      normalizedTarget: "src/config/database.ts",
      raw: "file:src/config/database.ts",
    });
  }

  const validFileWithRoot = parseSourceId(
    "file:d:\\Projects\\app\\src\\config\\database.ts",
    "d:\\Projects\\app"
  );
  assert.deepEqual(validFileWithRoot, {
    kind: "file",
    target: "src/config/database.ts",
    normalizedTarget: "src/config/database.ts",
    raw: "file:src/config/database.ts",
  });

  assert.equal(
    formatSourceId("skill", "database-optimization"),
    "skill:database-optimization"
  );
  assert.equal(
    formatSourceId("file", ".\\src\\utils\\helper.ts"),
    "file:src/utils/helper.ts"
  );

  // Reject invalid / unknown / empty IDs
  const invalidCases: unknown[] = [
    "",
    "   ",
    "skill:",
    "skill:   ",
    "file:",
    "file:   ",
    "file:./",
    "url:https://example.com",
    "unknown:foo",
    "database-optimization",
    ":missing-kind",
    null,
    undefined,
    123,
  ];

  for (const invalid of invalidCases) {
    assert.equal(
      parseSourceId(invalid as string),
      null,
      `Expected null for ${String(invalid)}`
    );
    const res = parseAndValidateSourceId(invalid as string);
    assert.equal(
      res.valid,
      false,
      `Expected valid=false for ${String(invalid)}`
    );
    if (!res.valid) {
      assert.ok(res.error.length > 0);
    }
    assert.equal(isValidSourceId(invalid as string), false);
  }

  assert.equal(isValidSourceId("skill:react-performance"), true);
  assert.equal(isValidSourceId("file:src/index.ts"), true);
});

test("extractSourceFromToolCall extracts normalized SourceID from skill and read tools and ignores others", () => {
  // Skill tools
  assert.equal(
    extractSourceFromToolCall("skill", { id: "database-optimization" }),
    "skill:database-optimization"
  );
  assert.equal(
    extractSourceFromToolCall("load_skill", { name: "react-performance" }),
    "skill:react-performance"
  );
  assert.equal(
    extractSourceFromToolCall("use_skill", { skill: "frontend-design" }),
    "skill:frontend-design"
  );
  assert.equal(
    extractSourceFromToolCall("skill", { skillId: "skill:already-prefixed" }),
    "skill:already-prefixed"
  );

  // Read tools
  assert.equal(
    extractSourceFromToolCall("read", { filePath: ".\\src\\config\\db.ts" }),
    "file:src/config/db.ts"
  );
  assert.equal(
    extractSourceFromToolCall(
      "read_file",
      { path: "d:\\repo\\src\\app.ts" },
      "d:\\repo"
    ),
    "file:src/app.ts"
  );
  assert.equal(
    extractSourceFromToolCall("file_read", { file: "README.md" }),
    "file:README.md"
  );
  assert.equal(
    extractSourceFromToolCall("view_file", { target: "package.json" }),
    "file:package.json"
  );

  // Non-matching tools or malformed args
  assert.equal(
    extractSourceFromToolCall("bash", { command: "cat src/config/db.ts" }),
    null
  );
  assert.equal(
    extractSourceFromToolCall("write", { filePath: "src/config/db.ts" }),
    null
  );
  assert.equal(extractSourceFromToolCall("skill", {}), null);
  assert.equal(extractSourceFromToolCall("read", null), null);
  assert.equal(extractSourceFromToolCall("read", "not-an-object"), null);
});

test("locateSourceInMessages locates V2 assistant tool-call + tool-result messages for skills and files", () => {
  const messages: V2Message[] = [
    {
      role: "user",
      content: "Check the database setup and optimize queries.",
    },
    {
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          toolCallId: "call-skill-1",
          toolName: "skill",
          args: { name: "database-optimization" },
        },
        {
          type: "tool-call",
          toolCallId: "call-read-1",
          toolName: "read",
          args: { filePath: "d:\\workspace\\src\\config\\database.ts" },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "call-skill-1",
      content: "Full database-optimization skill instructions (4000 chars)...",
    },
    {
      role: "tool",
      parts: [
        {
          type: "tool-result",
          toolCallId: "call-read-1",
          output: "export const dbConfig = { host: 'localhost', port: 5432 };",
        },
      ],
    },
  ];

  const allOccurrences = locateSourceInMessages(
    messages,
    undefined,
    undefined,
    "d:\\workspace"
  );
  assert.equal(allOccurrences.length, 2);

  assert.equal(allOccurrences[0].messageIndex, 2);
  assert.equal(allOccurrences[0].sourceId, "skill:database-optimization");
  assert.equal(allOccurrences[0].kind, "skill");
  assert.equal(allOccurrences[0].target, "database-optimization");
  assert.equal(allOccurrences[0].callID, "call-skill-1");
  assert.equal(allOccurrences[0].alreadyEvicted, false);
  assert.ok(allOccurrences[0].currentLength > 20);

  assert.equal(allOccurrences[1].messageIndex, 3);
  assert.equal(allOccurrences[1].partIndex, 0);
  assert.equal(allOccurrences[1].sourceId, "file:src/config/database.ts");
  assert.equal(allOccurrences[1].kind, "file");
  assert.equal(allOccurrences[1].target, "src/config/database.ts");
  assert.equal(allOccurrences[1].callID, "call-read-1");
  assert.equal(allOccurrences[1].alreadyEvicted, false);

  // Filter for specific target sourceId
  const fileOnly = locateSourceInMessages(
    messages,
    "file:src/config/database.ts",
    undefined,
    "d:\\workspace"
  );
  assert.equal(fileOnly.length, 1);
  assert.equal(fileOnly[0].sourceId, "file:src/config/database.ts");
});

test("locateSourceInMessages locates V2 role: 'skill' messages, type: 'skill' parts, and <skill_content> XML envelopes", () => {
  const messages: V2Message[] = [
    {
      role: "skill",
      name: "frontend-design",
      content: "Frontend design system rules and typography guidelines...",
    },
    {
      role: "user",
      parts: [
        {
          type: "skill",
          skillId: "a11y-debugging",
          text: "WCAG 2.2 accessibility checklist and ARIA patterns...",
        },
        {
          type: "text",
          text: 'Here is the loaded skill:\n<skill_content name="database-optimization">\nUse composite indexes on high-cardinality columns.\n</skill_content>',
        },
      ],
    },
  ];

  const occurrences = locateSourceInMessages(messages);
  assert.equal(occurrences.length, 3);

  assert.equal(occurrences[0].messageIndex, 0);
  assert.equal(occurrences[0].sourceId, "skill:frontend-design");

  assert.equal(occurrences[1].messageIndex, 1);
  assert.equal(occurrences[1].partIndex, 0);
  assert.equal(occurrences[1].sourceId, "skill:a11y-debugging");

  assert.equal(occurrences[2].messageIndex, 1);
  assert.equal(occurrences[2].partIndex, 1);
  assert.equal(occurrences[2].sourceId, "skill:database-optimization");
});

test("locateSourceInMessages locates V1 V1MessageWithParts tool parts and external callIdToSource mappings", () => {
  const v1Messages: V1MessageWithParts[] = [
    {
      info: { id: "msg-1", sessionID: "ses-1", role: "user" },
      parts: [{ type: "text", text: "Please inspect the schema." }],
    },
    {
      info: { id: "msg-2", sessionID: "ses-1", role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: "read",
          callID: "v1-call-1",
          state: {
            status: "completed",
            input: { filePath: "src/schema.ts" },
            output: "export interface User { id: string; }",
          },
        },
      ],
    },
  ];

  const v1Occurrences = locateSourceInMessages(v1Messages);
  assert.equal(v1Occurrences.length, 1);
  assert.equal(v1Occurrences[0].messageIndex, 1);
  assert.equal(v1Occurrences[0].partIndex, 0);
  assert.equal(v1Occurrences[0].sourceId, "file:src/schema.ts");
  assert.equal(v1Occurrences[0].callID, "v1-call-1");
  assert.equal(
    v1Occurrences[0].currentLength,
    "export interface User { id: string; }".length
  );

  // External callIdToSource lookup when tool-call message is not present
  const externalMap = new Map<string, SourceID>([
    ["external-call-99", "skill:react-performance"],
  ]);
  const orphanToolMessages: V2Message[] = [
    {
      role: "tool",
      toolCallId: "external-call-99",
      content: "React memoization and suspense waterfall guidance...",
    },
  ];

  const mappedOccurrences = locateSourceInMessages(
    orphanToolMessages,
    undefined,
    externalMap
  );
  assert.equal(mappedOccurrences.length, 1);
  assert.equal(mappedOccurrences[0].sourceId, "skill:react-performance");
  assert.equal(mappedOccurrences[0].callID, "external-call-99");
});

test("NEGATIVE REQUIREMENT: locateSourceInMessages NEVER matches plain user/assistant conversation mentioning skill names or file paths", () => {
  const messages: V2Message[] = [
    {
      role: "user",
      content:
        "Should we use database-optimization or skill:database-optimization on src/config/database.ts and file:src/config/database.ts?",
    },
    {
      role: "assistant",
      content:
        "I checked whether database-optimization applies to src/config/database.ts, and we don't need it for this CSS tweak.",
    },
    {
      role: "user",
      parts: [
        {
          type: "text",
          text: "Okay, do not touch src/config/database.ts or database-optimization.",
        },
      ],
    },
  ];

  const occurrences = locateSourceInMessages(messages);
  assert.equal(occurrences.length, 0);

  const known = collectKnownSourcesFromMessages(messages);
  assert.equal(known.size, 0);
});

test("collectKnownSourcesFromMessages returns all unique SourceIDs present in transcript and callIdToSource", () => {
  const messages: V2Message[] = [
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
      content: "Skill payload",
    },
    {
      role: "skill",
      skillId: "frontend-design",
      content: "Design payload",
    },
  ];

  const callMap = new Map<string, SourceID>([
    ["c2", "file:src/config/database.ts"],
  ]);

  const known = collectKnownSourcesFromMessages(messages, callMap);
  assert.equal(known.has("skill:database-optimization"), true);
  assert.equal(known.has("skill:frontend-design"), true);
  assert.equal(known.has("file:src/config/database.ts"), true);
  assert.equal(known.size, 3);
});
