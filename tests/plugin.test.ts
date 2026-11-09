import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPluginTools,
  executeSlashCommand,
  createSlashCommandDefinition,
  formatSessionStatus,
} from "../src/tools.js";
import {
  createContextEvictorPlugin,
  contextEvictorPlugin,
  ContextEvictorPlugin,
  setup,
  server,
  SYSTEM_INSTRUCTION,
  createRejectionRegistry,
  createLogger,
  DEFAULT_CONFIG,
  type LogEntry,
  type PluginContext,
  type SessionCompactionEvent,
  type SessionContextEvent,
  type ToolDefinition,
  type V1Hooks,
  type V1MessageWithParts,
  type V2Message,
} from "../src/index.js";

test("createPluginTools: context_evict rejects loaded skill and file, handles errors safely, and is idempotent on duplicate calls", async () => {
  const logEntries: LogEntry[] = [];
  const config = { enabled: true, debug: true, preserveMarkers: true };
  const logger = createLogger(config, logEntries);
  const workspaceRoot = "D:/Projects/demo-app";
  const registry = createRejectionRegistry({ workspaceRoot, logger });

  const sessionID = "ses-tools-1";
  // Pre-record a skill tool execution and a file read tool execution
  registry.recordToolExecution(
    sessionID,
    "call-skill-1",
    "skill",
    { id: "database-optimization" },
    workspaceRoot
  );
  registry.recordToolExecution(
    sessionID,
    "call-read-1",
    "read",
    { filePath: "D:\\Projects\\demo-app\\src\\config\\database.ts" },
    workspaceRoot
  );

  const tools = createPluginTools({
    registry,
    config,
    logger,
    workspaceRoot,
  });

  assert.ok(tools.context_evict);
  assert.ok(tools.context_restore);
  assert.ok(tools.context_evict_status);
  assert.ok(tools.context_status);
  assert.ok(tools.context_reset);

  // Verify JSON schema parameters & inputSchema are exposed
  assert.equal(tools.context_evict.parameters?.type, "object");
  assert.equal(tools.context_evict.inputSchema?.type, "object");
  assert.ok(
    tools.context_evict.description.includes("irrelevant") &&
      tools.context_evict.description.includes("context_evict")
  );

  // 1. Valid skill rejection
  const resSkill = String(
    await tools.context_evict.execute(
      {
        source_id: "skill:database-optimization",
        reason: "Current task is CSS styling only",
      },
      { sessionID }
    )
  );
  assert.ok(resSkill.includes("skill:database-optimization"));
  assert.ok(resSkill.includes("Evicted"));
  assert.equal(registry.isRejected(sessionID, "skill:database-optimization"), true);

  // 2. Duplicate skill rejection is idempotent
  const resDup = String(
    await tools.context_evict.execute(
      {
        source_id: "skill:database-optimization",
        reason: "Duplicate reason",
      },
      { sessionID }
    )
  );
  assert.ok(resDup.toLowerCase().includes("already"));
  assert.equal(
    registry.getRejectionRecord(sessionID, "skill:database-optimization")?.reason,
    "Current task is CSS styling only"
  );

  // 3. Valid file rejection (normalizes Windows path)
  const resFile = String(
    await tools.context_evict.execute(
      {
        source_id: "file:.\\src\\config\\database.ts",
        reason: "No database config changes needed",
      },
      { sessionID }
    )
  );
  assert.ok(resFile.includes("file:src/config/database.ts"));
  assert.equal(
    registry.isRejected(sessionID, "file:src/config/database.ts"),
    true
  );

  // 4. Safe failure on INVALID_SOURCE_ID
  const resInvalidId = String(
    await tools.context_evict.execute(
      {
        source_id: "invalid_format_without_prefix",
        reason: "Bad id",
      },
      { sessionID }
    )
  );
  assert.ok(resInvalidId.includes("Failed to evict") || resInvalidId.includes("Invalid"));
  assert.equal(registry.getStatus(sessionID).activeCount, 2);

  // 5. Safe failure on INVALID_REASON
  const resEmptyReason = String(
    await tools.context_evict.execute(
      {
        source_id: "skill:database-optimization",
        reason: "   ",
      },
      { sessionID }
    )
  );
  assert.ok(
    resEmptyReason.includes("Failed to evict") ||
      resEmptyReason.includes("reason")
  );

  // 6. Safe failure on UNKNOWN_SOURCE (never loaded in session)
  const resUnknown = String(
    await tools.context_evict.execute(
      {
        source_id: "skill:nonexistent-skill",
        reason: "Never loaded",
      },
      { sessionID }
    )
  );
  assert.ok(resUnknown.includes("not found or loaded"));
  assert.equal(registry.isRejected(sessionID, "skill:nonexistent-skill"), false);

  // Verify privacy-safe telemetry logged all rejection events (including failures)
  assert.ok(logEntries.length >= 5);
  const failedEntry = logEntries.find(
    (e) => e.sourceId === "skill:nonexistent-skill"
  );
  assert.ok(failedEntry);
  assert.equal(failedEntry.evictionSucceeded, false);
  assert.equal(failedEntry.identificationFailed, true);
});

test("createPluginTools: context_restore, context_evict_status, context_status, and context_reset lifecycle", async () => {
  const workspaceRoot = "/repo";
  const registry = createRejectionRegistry({ workspaceRoot });
  const config = { ...DEFAULT_CONFIG, debug: true };
  const logger = createLogger(config);
  const sessionID = "ses-tools-2";

  registry.recordKnownSource(sessionID, "skill:alpha", workspaceRoot);
  registry.recordKnownSource(sessionID, "file:src/beta.ts", workspaceRoot);

  const tools = createPluginTools({ registry, config, logger, workspaceRoot });

  await tools.context_evict.execute(
    { source_id: "skill:alpha", reason: "Irrelevant alpha" },
    { sessionID }
  );
  await tools.context_evict.execute(
    { source_id: "file:src/beta.ts", reason: "Irrelevant beta" },
    { sessionID }
  );

  // Status check via context_evict_status and alias context_status
  const statusText = String(
    await tools.context_evict_status.execute({ action: "status" }, { sessionID })
  );
  assert.ok(statusText.includes("Active evicted sources: 2"));
  assert.ok(statusText.includes("skill:alpha"));
  assert.ok(statusText.includes("file:src/beta.ts"));

  const aliasStatusText = String(
    await tools.context_status.execute({}, { sessionID })
  );
  assert.equal(aliasStatusText, statusText);

  // Restore one source via context_restore
  const restoreRes = String(
    await tools.context_restore.execute(
      { source_id: "skill:alpha" },
      { sessionID }
    )
  );
  assert.ok(restoreRes.includes("Restored"));
  assert.equal(registry.isRejected(sessionID, "skill:alpha"), false);
  assert.equal(registry.isRejected(sessionID, "file:src/beta.ts"), true);

  // Restoring already-restored source is safe
  const restoreAgainRes = String(
    await tools.context_restore.execute(
      { source_id: "skill:alpha" },
      { sessionID }
    )
  );
  assert.ok(restoreAgainRes.includes("not currently evicted"));

  // Reset via context_evict_status({ action: "reset" })
  const resetViaStatus = String(
    await tools.context_evict_status.execute({ action: "reset" }, { sessionID })
  );
  assert.ok(resetViaStatus.includes("1"));
  assert.equal(registry.getStatus(sessionID).activeCount, 0);

  // Re-evict and reset via context_reset
  await tools.context_evict.execute(
    { source_id: "skill:alpha", reason: "Reject again" },
    { sessionID }
  );
  assert.equal(registry.getStatus(sessionID).activeCount, 1);

  const resetDirect = String(await tools.context_reset.execute({}, { sessionID }));
  assert.ok(resetDirect.includes("1"));
  assert.equal(registry.getStatus(sessionID).activeCount, 0);
});

test("createPluginTools: returns disabled message when config.enabled is false", async () => {
  const registry = createRejectionRegistry();
  const config = { enabled: false, debug: false, preserveMarkers: true };
  const tools = createPluginTools({ registry, config });

  registry.recordKnownSource("ses-disabled", "skill:test");
  const out = String(
    await tools.context_evict.execute(
      { source_id: "skill:test", reason: "Disabled test" },
      { sessionID: "ses-disabled" }
    )
  );
  assert.ok(out.toLowerCase().includes("disabled"));
  assert.equal(registry.isRejected("ses-disabled", "skill:test"), false);
});

test("executeSlashCommand: supports status, restore, reset, evict, and help output", async () => {
  const workspaceRoot = "/workspace";
  const registry = createRejectionRegistry({ workspaceRoot });
  const config = { ...DEFAULT_CONFIG };
  const sessionID = "ses-slash";

  registry.recordKnownSource(sessionID, "skill:k8s-deploy", workspaceRoot);
  registry.recordKnownSource(sessionID, "file:src/main.ts", workspaceRoot);

  // 1. Default / status when empty
  const emptyStatus = await executeSlashCommand("", {
    registry,
    config,
    sessionID,
    workspaceRoot,
  });
  assert.ok(emptyStatus.includes("Active evicted sources: 0"));
  assert.ok(emptyStatus.includes("skill:k8s-deploy"));

  // 2. Manual evict via slash command
  const evictOut = await executeSlashCommand(
    "evict skill:k8s-deploy Not deploying to Kubernetes",
    {
      registry,
      config,
      sessionID,
      workspaceRoot,
    }
  );
  assert.ok(evictOut.includes("Evicted"));
  assert.equal(registry.isRejected(sessionID, "skill:k8s-deploy"), true);

  // 3. Status with active rejection
  const activeStatus = await executeSlashCommand("status", {
    registry,
    config,
    sessionID,
    workspaceRoot,
  });
  assert.ok(activeStatus.includes("Active evicted sources: 1"));
  assert.ok(activeStatus.includes("skill:k8s-deploy"));
  assert.ok(activeStatus.includes("Not deploying to Kubernetes"));

  // 4. Restore via slash command
  const restoreOut = await executeSlashCommand("restore skill:k8s-deploy", {
    registry,
    config,
    sessionID,
    workspaceRoot,
  });
  assert.ok(restoreOut.includes("Restored"));
  assert.equal(registry.isRejected(sessionID, "skill:k8s-deploy"), false);

  // 5. Evict again and reset via slash command
  await executeSlashCommand("evict file:src/main.ts Unused entry", {
    registry,
    config,
    sessionID,
    workspaceRoot,
  });
  assert.equal(registry.getStatus(sessionID).activeCount, 1);

  const resetOut = await executeSlashCommand("reset", {
    registry,
    config,
    sessionID,
    workspaceRoot,
  });
  assert.ok(resetOut.includes("Cleared 1"));
  assert.equal(registry.getStatus(sessionID).activeCount, 0);

  // 6. Unknown subcommand returns help usage
  const helpOut = await executeSlashCommand("unknown-subcommand", {
    registry,
    config,
    sessionID,
    workspaceRoot,
  });
  assert.ok(
    helpOut.includes(
      "Usage: /context-evictor [status | restore <source_id> | reset | evict <source_id> [reason]]"
    )
  );

  // Verify CommandDefinition wrapper works with array and object arguments
  const cmdDef = createSlashCommandDefinition({
    registry,
    config,
    workspaceRoot,
  });
  assert.equal(cmdDef.name, "context-evictor");
  const fromArray = String(
    await cmdDef.execute(["status"], { sessionID })
  );
  assert.ok(fromArray.includes("Active evicted sources: 0"));
  assert.ok(formatSessionStatus(registry.getStatus(sessionID)).includes("Active evicted sources: 0"));
});

test("OpenCode V2 lifecycle (setup): tool hooks, Turn-1 system prompt, zero-clone fast-path, Turn-2 copy-on-write redaction, and compaction", async () => {
  const sessionHooks = new Map<string, (payload: any) => Promise<void> | void>();
  const toolHooks = new Map<string, (payload: any) => Promise<void> | void>();
  const registeredTools: Record<string, ToolDefinition> = {};
  const registeredCommands: Record<string, any> = {};
  const persistedStorage = new Map<string, unknown>();

  const ctx: PluginContext = {
    cwd: "D:/Projects/v2-workspace",
    options: { enabled: true, debug: true, preserveMarkers: true },
    storage: {
      get: (key) => persistedStorage.get(key) as any,
      set: (key, val) => {
        persistedStorage.set(key, val);
      },
    },
    session: {
      hook: (event, handler) => {
        sessionHooks.set(event, handler);
      },
    },
    tool: {
      hook: (event, handler) => {
        toolHooks.set(event, handler);
      },
      register: (nameOrDef, maybeDef) => {
        if (typeof nameOrDef === "string" && maybeDef) {
          registeredTools[nameOrDef] = maybeDef;
        } else if (typeof nameOrDef === "object" && nameOrDef.name) {
          registeredTools[nameOrDef.name] = nameOrDef;
        }
      },
      transform: (handler) => {
        handler(registeredTools);
      },
    },
    command: {
      register: (nameOrDef, maybeDef) => {
        if (typeof nameOrDef === "string" && maybeDef) {
          registeredCommands[nameOrDef] = maybeDef;
        } else if (typeof nameOrDef === "object" && nameOrDef.name) {
          registeredCommands[nameOrDef.name] = nameOrDef;
        }
      },
    },
  };

  const plugin = createContextEvictorPlugin();
  assert.equal(plugin.id, "context-evictor");
  await plugin.setup(ctx);

  // Verify hooks, tools, and slash command were registered
  assert.ok(sessionHooks.has("context"));
  assert.ok(sessionHooks.has("compaction"));
  assert.ok(toolHooks.has("execute.before"));
  assert.ok(toolHooks.has("execute.after"));
  assert.ok(registeredTools.context_evict);
  assert.ok(registeredTools.context_restore);
  assert.ok(registeredTools.context_evict_status);
  assert.ok(registeredTools.context_status);
  assert.ok(registeredTools.context_reset);
  assert.ok(registeredCommands["context-evictor"]);

  const sessionID = "ses-v2-e2e";

  // Simulate tool execution hook recording skill and file read calls
  await toolHooks.get("execute.before")!({
    sessionID,
    tool: "skill",
    callID: "call-skill-db",
    args: { id: "database-optimization" },
  });
  await toolHooks.get("execute.after")!({
    sessionID,
    tool: "read",
    callID: "call-read-db",
    args: { filePath: "D:/Projects/v2-workspace/src/config/database.ts" },
  });

  const msg0: V2Message = {
    id: "m0",
    role: "user",
    content: "Fix the button padding in Header.tsx",
  };
  const msg1: V2Message = {
    id: "m1",
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        callID: "call-skill-db",
        toolName: "skill",
        args: { id: "database-optimization" },
      },
      {
        type: "tool-call",
        callID: "call-read-db",
        toolName: "read",
        args: { filePath: "src/config/database.ts" },
      },
    ],
  };
  const originalSkillPayload =
    "LARGE_DATABASE_OPTIMIZATION_SKILL_GUIDE_WITH_INDEXING_RULES_".repeat(20);
  const originalFilePayload =
    "export const dbConfig = { poolSize: 50, ssl: true };\n".repeat(20);
  const msg2: V2Message = {
    id: "m2",
    role: "tool",
    parts: [
      {
        type: "tool-result",
        callID: "call-skill-db",
        toolName: "skill",
        output: originalSkillPayload,
      },
      {
        type: "tool-result",
        callID: "call-read-db",
        toolName: "read",
        output: originalFilePayload,
      },
    ],
  };
  const msg3: V2Message = {
    id: "m3",
    role: "user",
    content: "Please continue with the CSS fix.",
  };

  const turn1Messages = [msg0, msg1, msg2, msg3];
  const turn1Event: SessionContextEvent = {
    sessionID,
    system: "Base OpenCode System Prompt.",
    messages: turn1Messages,
  };

  // Turn 1: 0 rejected sources -> system instruction appended on Turn 1, messages array untouched (=== fast path)
  await sessionHooks.get("context")!(turn1Event);
  assert.equal(
    turn1Event.system,
    `Base OpenCode System Prompt.\n\n${SYSTEM_INSTRUCTION}`
  );
  assert.equal(turn1Event.messages, turn1Messages);
  assert.equal(turn1Event.messages[0], msg0);
  assert.equal(turn1Event.messages[2], msg2);

  // Agent invokes context_evict for skill:database-optimization
  const evictOut = String(
    await registeredTools.context_evict.execute(
      {
        source_id: "skill:database-optimization",
        reason: "Task is strictly frontend CSS padding",
      },
      { sessionID }
    )
  );
  assert.ok(evictOut.includes("Evicted"));

  // Turn 2: context hook runs again with the rejected skill
  const turn2Event: SessionContextEvent = {
    sessionID,
    system: turn1Event.system,
    messages: turn1Messages,
  };
  await sessionHooks.get("context")!(turn2Event);

  // System prompt reference is strictly preserved (no duplicate instruction appended)
  assert.equal(turn2Event.system, turn1Event.system);

  // Prefix messages msg0 and msg1 and suffix msg3 retain strict === reference identity
  assert.notEqual(turn2Event.messages, turn1Messages);
  assert.equal(turn2Event.messages[0], msg0);
  assert.equal(turn2Event.messages[1], msg1);
  assert.notEqual(turn2Event.messages[2], msg2);
  assert.equal(turn2Event.messages[3], msg3);

  // Inside msg2, part 0 (skill) is redacted to deterministic tombstone while part 1 (unrejected file) retains === identity
  const redactedMsg2 = turn2Event.messages[2];
  assert.equal(
    redactedMsg2.parts![0].output,
    "[Context Evicted: skill database-optimization was inspected and rejected for this task.]"
  );
  assert.equal(redactedMsg2.parts![0].callID, "call-skill-db");
  assert.equal(redactedMsg2.parts![1], msg2.parts![1]);

  // Original persisted transcript msg2 is completely unmutated
  assert.equal(msg2.parts![0].output, originalSkillPayload);

  // Compaction hook also redacts rejected content before session summarization
  const compactionEvent: SessionCompactionEvent = {
    sessionID,
    messages: [msg0, msg1, msg2, msg3],
    context: [
      `Header\n<skill_content name="database-optimization">${originalSkillPayload}</skill_content>\nFooter`,
    ],
  };
  await sessionHooks.get("compaction")!(compactionEvent);
  assert.equal(
    compactionEvent.messages![2].parts![0].output,
    "[Context Evicted: skill database-optimization was inspected and rejected for this task.]"
  );
  assert.ok(
    !compactionEvent.context![0].includes(originalSkillPayload) &&
      compactionEvent.context![0].includes(
        "[Context Evicted: skill database-optimization was inspected and rejected for this task.]"
      )
  );
});

test("OpenCode V1 lifecycle (server): tool hooks, system transform, messages transform, compacting, and command hook", async () => {
  const hooks: V1Hooks = await server({
    directory: "D:/Projects/v1-workspace",
    options: { enabled: true, debug: false, preserveMarkers: true },
  });

  assert.ok(hooks.tool?.context_evict);
  assert.ok(hooks.tool?.context_restore);
  assert.ok(hooks.tool?.context_evict_status);
  assert.ok(hooks.tool?.context_status);
  assert.ok(hooks.tool?.context_reset);
  assert.ok(hooks["tool.execute.before"]);
  assert.ok(hooks["tool.execute.after"]);
  assert.ok(hooks["experimental.chat.system.transform"]);
  assert.ok(hooks["experimental.chat.messages.transform"]);
  assert.ok(hooks["experimental.session.compacting"]);

  const sessionID = "ses-v1-e2e";

  // 1. System transform appends instruction once
  const sysOut = { system: ["V1 Base System"] };
  await hooks["experimental.chat.system.transform"]!({ sessionID }, sysOut);
  assert.equal(sysOut.system.length, 2);
  assert.equal(sysOut.system[1], SYSTEM_INSTRUCTION);
  await hooks["experimental.chat.system.transform"]!({ sessionID }, sysOut);
  assert.equal(sysOut.system.length, 2);

  // 2. Record tool execution via V1 tool.execute.before
  const argsObj = { filePath: "D:/Projects/v1-workspace/src/legacy.ts" };
  await hooks["tool.execute.before"]!(
    {
      tool: "read",
      sessionID,
      callID: "v1-call-1",
      args: argsObj,
    },
    { args: argsObj }
  );

  // 3. Evict the loaded file using V1 hooks.tool.context_evict
  const evictRes = String(
    await hooks.tool!.context_evict.execute(
      {
        source_id: "file:src/legacy.ts",
        reason: "Legacy module is not part of v2 migration",
      },
      { sessionID }
    )
  );
  assert.ok(evictRes.includes("Evicted"));

  // 4. Transform V1 messages
  const v1Msg0: V1MessageWithParts = {
    info: { id: "v1-m0", sessionID, role: "user" },
    parts: [{ type: "text", text: "Migrate user service" }],
  };
  const v1Msg1: V1MessageWithParts = {
    info: { id: "v1-m1", sessionID, role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: "read",
        callID: "v1-call-1",
        state: {
          status: "completed",
          input: { filePath: "src/legacy.ts" },
          output: "export function oldLegacyCode() { return 42; }",
        },
      },
    ],
  };

  const msgOut = { messages: [v1Msg0, v1Msg1] };
  await hooks["experimental.chat.messages.transform"]!({ sessionID }, msgOut);

  assert.equal(msgOut.messages[0], v1Msg0);
  assert.notEqual(msgOut.messages[1], v1Msg1);
  assert.equal(
    msgOut.messages[1].parts[0].state?.output,
    "[Context Evicted: file src/legacy.ts was inspected and rejected for this task.]"
  );
  assert.equal(
    v1Msg1.parts[0].state?.output,
    "export function oldLegacyCode() { return 42; }"
  );

  // 5. V1 compacting hook redacts messages and context
  const compactOut = {
    context: ["Summary context"],
    messages: [v1Msg0, v1Msg1],
  };
  await hooks["experimental.session.compacting"]!({ sessionID }, compactOut);
  assert.equal(
    compactOut.messages[1].parts[0].state?.output,
    "[Context Evicted: file src/legacy.ts was inspected and rejected for this task.]"
  );

  // 6. V1 command.execute.before hook handles /context-evictor
  const cmdHook = hooks["command.execute.before"] as (
    input: { command?: string; args?: string; sessionID?: string },
    output: { output?: string; handled?: boolean }
  ) => Promise<void>;
  assert.equal(typeof cmdHook, "function");
  const cmdOut: { output?: string; handled?: boolean } = {};
  await cmdHook(
    { command: "/context-evictor", args: "status", sessionID },
    cmdOut
  );
  assert.equal(cmdOut.handled, true);
  assert.ok(cmdOut.output?.includes("file:src/legacy.ts"));
});

test("Root index.js and callable plugin factory work in all OpenCode loader modes", async () => {
  // Direct callable plugin in V1 mode
  const v1Hooks = (await contextEvictorPlugin({
    directory: "/tmp/test",
  })) as V1Hooks;
  assert.ok(v1Hooks.tool?.context_evict);

  // Direct callable plugin in V2 mode
  let v2Registered = false;
  await ContextEvictorPlugin({
    cwd: "/tmp/test",
    session: {
      hook: () => {
        v2Registered = true;
      },
    },
  });
  assert.equal(v2Registered, true);
  assert.equal(typeof setup, "function");

  // Dynamic import of root index.js (requires build output in dist/src/index.js)
  const rootIndexUrl = pathToFileURL(
    path.resolve(process.cwd(), "index.js")
  ).href;
  const rootModule = (await import(rootIndexUrl)) as Record<string, any>;
  assert.ok(rootModule.default);
  assert.ok(rootModule.ContextEvictorPlugin);
  assert.equal(rootModule.default.id, "context-evictor");
});
