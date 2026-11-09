import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  DEFAULT_CONFIG,
  validateConfig,
  loadConfig,
  stripJsoncComments,
} from "../src/config.js";
import { createLogger, type LogEntry } from "../src/logger.js";

test("DEFAULT_CONFIG has expected spec default values", () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    enabled: true,
    debug: false,
    preserveMarkers: true,
  });
});

test("validateConfig returns defaults for null, undefined, or non-object inputs", () => {
  for (const input of [undefined, null, "invalid", 123, true, ["array"]]) {
    const { config, warnings } = validateConfig(input);
    assert.deepEqual(config, DEFAULT_CONFIG);
    if (input !== undefined && input !== null) {
      assert.ok(warnings.length > 0, `Expected warning for input: ${JSON.stringify(input)}`);
    }
  }
});

test("validateConfig accepts valid overrides and falls back with warnings on invalid fields", () => {
  const { config: validConfig, warnings: noWarnings } = validateConfig({
    enabled: false,
    debug: true,
    preserveMarkers: false,
    logFile: "/tmp/context-evictor.log",
  });
  assert.equal(noWarnings.length, 0);
  assert.deepEqual(validConfig, {
    enabled: false,
    debug: true,
    preserveMarkers: false,
    logFile: "/tmp/context-evictor.log",
  });

  const { config: partialInvalid, warnings } = validateConfig({
    enabled: "yes",
    debug: true,
    preserveMarkers: 123,
    logFile: "",
  });
  assert.equal(partialInvalid.enabled, true);
  assert.equal(partialInvalid.debug, true);
  assert.equal(partialInvalid.preserveMarkers, true);
  assert.equal(partialInvalid.logFile, undefined);
  assert.ok(warnings.length >= 3);
});

test("stripJsoncComments removes line and block comments while preserving strings", () => {
  const jsonc = `{
    // Single line comment with https://example.com
    "context-evictor": {
      /* Multi-line
         block comment */
      "enabled": true,
      "debug": true, // trailing comment
      "logFile": "C:/logs/evictor/*not-a-comment*/file//path.log",
    },
  }`;
  const stripped = stripJsoncComments(jsonc);
  const parsed = JSON.parse(stripped);
  assert.equal(parsed["context-evictor"].enabled, true);
  assert.equal(parsed["context-evictor"].debug, true);
  assert.equal(
    parsed["context-evictor"].logFile,
    "C:/logs/evictor/*not-a-comment*/file//path.log"
  );
});

test("loadConfig loads from opencode.jsonc, .opencode/context-evictor.json, global configDir, and direct options with proper precedence", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evictor-cfg-"));
  const cwd = path.join(tmpRoot, "workspace");
  const globalDir = path.join(tmpRoot, "global-opencode");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });

  try {
    // 1. No files -> defaults
    assert.deepEqual(loadConfig(undefined, cwd, globalDir), DEFAULT_CONFIG);

    // 2. Global config file (~/.config/opencode/context-evictor.json)
    fs.writeFileSync(
      path.join(globalDir, "context-evictor.json"),
      JSON.stringify({ enabled: false, debug: true, preserveMarkers: false }),
      "utf8"
    );
    assert.deepEqual(loadConfig(undefined, cwd, globalDir), {
      enabled: false,
      debug: true,
      preserveMarkers: false,
    });

    // 3. Workspace opencode.jsonc overrides global config
    fs.writeFileSync(
      path.join(cwd, "opencode.jsonc"),
      `{
        // Workspace OpenCode configuration
        "context-evictor": {
          "enabled": true,
          "debug": true,
          "preserveMarkers": true
        }
      }`,
      "utf8"
    );
    assert.deepEqual(loadConfig(undefined, cwd, globalDir), {
      enabled: true,
      debug: true,
      preserveMarkers: true,
    });

    // 4. Workspace .opencode/context-evictor.json overrides opencode.jsonc
    fs.mkdirSync(path.join(cwd, ".opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".opencode", "context-evictor.json"),
      JSON.stringify({ preserveMarkers: false }),
      "utf8"
    );
    assert.deepEqual(loadConfig(undefined, cwd, globalDir), {
      enabled: true,
      debug: true,
      preserveMarkers: false,
    });

    // 5. Direct runtime options override file configs
    assert.deepEqual(loadConfig({ debug: false }, cwd, globalDir), {
      enabled: true,
      debug: false,
      preserveMarkers: false,
    });

    // 6. Malformed JSON falls back safely without throwing
    fs.writeFileSync(
      path.join(cwd, ".opencode", "context-evictor.json"),
      "{ malformed json ",
      "utf8"
    );
    const fallbackCfg = loadConfig(undefined, cwd, globalDir);
    assert.equal(fallbackCfg.enabled, true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("createLogger records all required Section 13 telemetry fields when debug: true and suppresses when debug: false", () => {
  const sinkDisabled: LogEntry[] = [];
  const disabledLogger = createLogger(
    { enabled: true, debug: false, preserveMarkers: true },
    sinkDisabled
  );

  disabledLogger.logEvictionEvent({
    sessionID: "ses-1",
    sourceId: "skill:react-performance",
    reason: "Backend task only",
    evictionSucceeded: true,
    charsRemoved: 4200,
    alreadyRejected: false,
    identificationFailed: false,
    activeRejectedCount: 1,
  });
  assert.equal(sinkDisabled.length, 0);

  const sinkEnabled: LogEntry[] = [];
  const enabledLogger = createLogger(
    { enabled: true, debug: true, preserveMarkers: true },
    sinkEnabled
  );

  enabledLogger.logEvictionEvent({
    sessionID: "ses-1",
    sourceId: "skill:react-performance",
    reason: "Backend task only",
    evictionSucceeded: true,
    charsRemoved: 4200,
    alreadyRejected: false,
    identificationFailed: false,
    activeRejectedCount: 1,
  });

  enabledLogger.logEvictionEvent({
    sessionID: "ses-1",
    sourceId: "file:src/unknown.ts",
    reason: "Not found",
    evictionSucceeded: false,
    charsRemoved: 0,
    alreadyRejected: false,
    identificationFailed: true,
    activeRejectedCount: 1,
  });

  assert.equal(sinkEnabled.length, 2);

  const first = sinkEnabled[0];
  assert.equal(first.sourceId, "skill:react-performance");
  assert.equal(first.reason, "Backend task only");
  assert.equal(first.evictionSucceeded, true);
  assert.equal(first.charsRemoved, 4200);
  assert.equal(first.alreadyRejected, false);
  assert.equal(first.identificationFailed, false);
  assert.equal(first.activeRejectedCount, 1);

  const second = sinkEnabled[1];
  assert.equal(second.sourceId, "file:src/unknown.ts");
  assert.equal(second.evictionSucceeded, false);
  assert.equal(second.identificationFailed, true);
  assert.equal(second.activeRejectedCount, 1);
});

test("createLogger enforces strict privacy guard and never logs raw rejected content", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evictor-log-"));
  const logFile = path.join(tmpDir, "evictor.log");
  const sink: LogEntry[] = [];

  try {
    const logger = createLogger(
      { enabled: true, debug: true, preserveMarkers: true, logFile },
      sink
    );

    const secretSkillContent =
      "SUPER_SECRET_SKILL_BODY_THAT_MUST_NEVER_APPEAR_IN_LOGS_12345";
    const secretFileContent =
      "PRIVATE_FILE_SOURCE_CODE_PAYLOAD_NEVER_LOG_ME_67890";

    // Pass extra forbidden fields via untyped object to verify sanitization
    logger.logEvictionEvent({
      sessionID: "ses-privacy",
      sourceId: "skill:secret-skill",
      reason: "Irrelevant to task",
      evictionSucceeded: true,
      charsRemoved: secretSkillContent.length,
      alreadyRejected: false,
      identificationFailed: false,
      activeRejectedCount: 1,
      ...({
        content: secretSkillContent,
        rawContent: secretSkillContent,
        rejectedContent: secretFileContent,
        fullContent: secretFileContent,
        output: secretSkillContent,
        body: secretFileContent,
      } as Record<string, unknown>),
    });

    logger.debug("Evicted source metadata", {
      sourceId: "file:secrets.env",
      charsRemoved: 120,
      content: secretFileContent,
      rawContent: secretSkillContent,
    });

    assert.equal(sink.length, 2);
    const serializedSink = JSON.stringify(sink);
    assert.ok(!serializedSink.includes(secretSkillContent));
    assert.ok(!serializedSink.includes(secretFileContent));
    assert.equal("content" in sink[0], false);
    assert.equal("rawContent" in sink[0], false);

    const fileContents = fs.readFileSync(logFile, "utf8");
    assert.ok(!fileContents.includes(secretSkillContent));
    assert.ok(!fileContents.includes(secretFileContent));
    assert.ok(fileContents.includes("skill:secret-skill"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
