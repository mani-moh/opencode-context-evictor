import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ContextEvictorConfig } from "./types.js";

/**
 * Default configuration values per OpenCode Context Evictor specification.
 */
export const DEFAULT_CONFIG: ContextEvictorConfig = Object.freeze({
  enabled: true,
  debug: false,
  preserveMarkers: true,
});

/**
 * Safely strips single-line (`//`) and multi-line (`/* ... *\/`) comments
 * as well as trailing commas from JSONC strings without altering string literals.
 */
export function stripJsoncComments(input: string): string {
  let result = "";
  let inString = false;
  let stringEscaped = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (inString) {
      result += ch;
      if (stringEscaped) {
        stringEscaped = false;
      } else if (ch === "\\") {
        stringEscaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      i += 1;
      continue;
    }

    // Single-line comment
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n" && input[i] !== "\r") {
        i += 1;
      }
      continue;
    }

    // Multi-line comment
    if (ch === "/" && next === "*") {
      i += 2;
      while (
        i < input.length &&
        !(input[i] === "*" && input[i + 1] === "/")
      ) {
        i += 1;
      }
      i += 2;
      continue;
    }

    result += ch;
    i += 1;
  }

  // Also strip trailing commas before `}` or `]` outside of strings
  return stripTrailingCommas(result);
}

function stripTrailingCommas(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) {
        j++;
      }
      if (j < input.length && (input[j] === "}" || input[j] === "]")) {
        continue;
      }
    }

    out += ch;
  }

  return out;
}

/**
 * Validates raw configuration input and returns a normalized `ContextEvictorConfig`
 * along with any validation warnings.
 */
export function validateConfig(raw: unknown): {
  config: ContextEvictorConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  const config: ContextEvictorConfig = { ...DEFAULT_CONFIG };

  if (raw === undefined || raw === null) {
    return { config, warnings };
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(
      `Invalid context-evictor config: expected an object, received ${Array.isArray(raw) ? "array" : typeof raw}. Using default configuration.`
    );
    return { config, warnings };
  }

  const record = raw as Record<string, unknown>;

  if ("enabled" in record && record.enabled !== undefined) {
    if (typeof record.enabled === "boolean") {
      config.enabled = record.enabled;
    } else {
      warnings.push(
        `Invalid "enabled" value (${JSON.stringify(record.enabled)}): expected boolean. Defaulting to ${DEFAULT_CONFIG.enabled}.`
      );
    }
  }

  if ("debug" in record && record.debug !== undefined) {
    if (typeof record.debug === "boolean") {
      config.debug = record.debug;
    } else {
      warnings.push(
        `Invalid "debug" value (${JSON.stringify(record.debug)}): expected boolean. Defaulting to ${DEFAULT_CONFIG.debug}.`
      );
    }
  }

  if ("preserveMarkers" in record && record.preserveMarkers !== undefined) {
    if (typeof record.preserveMarkers === "boolean") {
      config.preserveMarkers = record.preserveMarkers;
    } else {
      warnings.push(
        `Invalid "preserveMarkers" value (${JSON.stringify(record.preserveMarkers)}): expected boolean. Defaulting to ${DEFAULT_CONFIG.preserveMarkers}.`
      );
    }
  }

  if ("logFile" in record && record.logFile !== undefined) {
    if (typeof record.logFile === "string" && record.logFile.trim().length > 0) {
      config.logFile = record.logFile.trim();
    } else {
      warnings.push(
        `Invalid "logFile" value (${JSON.stringify(record.logFile)}): expected non-empty string.`
      );
    }
  }

  return { config, warnings };
}

function tryReadJsonFile(filePath: string): Record<string, unknown> | undefined {
  try {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    const rawText = fs.readFileSync(filePath, "utf8");
    const stripped = stripJsoncComments(rawText);
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fail safely on unreadable or malformed config files
  }
  return undefined;
}

function extractPluginConfigFromOpenCodeDoc(
  doc: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!doc) {
    return undefined;
  }

  if (
    doc["context-evictor"] &&
    typeof doc["context-evictor"] === "object" &&
    !Array.isArray(doc["context-evictor"])
  ) {
    return doc["context-evictor"] as Record<string, unknown>;
  }

  if (
    doc["opencode-context-evictor"] &&
    typeof doc["opencode-context-evictor"] === "object" &&
    !Array.isArray(doc["opencode-context-evictor"])
  ) {
    return doc["opencode-context-evictor"] as Record<string, unknown>;
  }

  if (
    doc.plugins &&
    typeof doc.plugins === "object" &&
    !Array.isArray(doc.plugins)
  ) {
    const pluginsObj = doc.plugins as Record<string, unknown>;
    const nested =
      pluginsObj["context-evictor"] ?? pluginsObj["opencode-context-evictor"];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
  }

  return undefined;
}

/**
 * Loads Context Evictor configuration by merging:
 * 1. `DEFAULT_CONFIG`
 * 2. Global config (`~/.config/opencode/context-evictor.json` or `configDir/context-evictor.json`)
 * 3. Workspace `opencode.json` / `opencode.jsonc` (`"context-evictor"` key)
 * 4. Workspace `.opencode/context-evictor.json`
 * 5. Direct runtime `options` passed to the plugin setup/server hook
 */
export function loadConfig(
  options?: Record<string, unknown>,
  cwd: string = process.cwd(),
  configDir: string = path.join(os.homedir(), ".config", "opencode")
): ContextEvictorConfig {
  const mergedRaw: Record<string, unknown> = {};

  // 1. Global configDir files
  if (configDir) {
    const globalOpenCodeJson =
      tryReadJsonFile(path.join(configDir, "opencode.jsonc")) ??
      tryReadJsonFile(path.join(configDir, "opencode.json"));
    const globalEmbedded = extractPluginConfigFromOpenCodeDoc(globalOpenCodeJson);
    if (globalEmbedded) {
      Object.assign(mergedRaw, globalEmbedded);
    }

    const globalDedicated = tryReadJsonFile(
      path.join(configDir, "context-evictor.json")
    );
    if (globalDedicated) {
      Object.assign(
        mergedRaw,
        extractPluginConfigFromOpenCodeDoc(globalDedicated) ?? globalDedicated
      );
    }
  }

  // 2. Workspace opencode.json / opencode.jsonc
  if (cwd) {
    const workspaceOpenCodeJson =
      tryReadJsonFile(path.join(cwd, "opencode.json")) ??
      tryReadJsonFile(path.join(cwd, "opencode.jsonc"));
    const workspaceEmbedded = extractPluginConfigFromOpenCodeDoc(
      workspaceOpenCodeJson
    );
    if (workspaceEmbedded) {
      Object.assign(mergedRaw, workspaceEmbedded);
    }

    // 3. Workspace .opencode/context-evictor.json
    const workspaceDedicated = tryReadJsonFile(
      path.join(cwd, ".opencode", "context-evictor.json")
    );
    if (workspaceDedicated) {
      Object.assign(
        mergedRaw,
        extractPluginConfigFromOpenCodeDoc(workspaceDedicated) ??
          workspaceDedicated
      );
    }
  }

  // 4. Direct runtime options
  if (options && typeof options === "object" && !Array.isArray(options)) {
    const unwrapped = extractPluginConfigFromOpenCodeDoc(options) ?? options;
    Object.assign(mergedRaw, unwrapped);
  }

  return validateConfig(mergedRaw).config;
}
