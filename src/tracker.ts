import type {
  ParsedSource,
  SourceID,
  SourceKind,
  TrackedSourceOccurrence,
  V1MessageWithParts,
  V1Part,
  V2Message,
  V2Part,
} from "./types.js";

/**
 * Valid skill identifier pattern: non-empty string without whitespace or control chars.
 */
const VALID_SKILL_ID_PATTERN = /^[A-Za-z0-9_./:@+-]+$/;

/**
 * Prefix marker used by Context Evictor tombstones so already-evicted entries
 * can be recognized structurally without re-evicting.
 */
export const TOMBSTONE_PREFIX = "[Context Evicted:";

/**
 * Regex matching structured `<skill_content name="...">...</skill_content>` or
 * `<skill name="...">...</skill>` XML blocks injected by OpenCode skill loaders.
 */
export const SKILL_XML_ENVELOPE_REGEX =
  /<(skill_content|skill)\s+[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/\1>/gi;

/**
 * Normalizes a raw file path to a canonical workspace-relative forward-slash format:
 * - Converts Windows backslashes `\` to `/`
 * - Strips leading `./`
 * - If `workspaceRoot` is provided and `rawPath` starts with `workspaceRoot`,
 *   strips the workspace root prefix and leading slash
 * - Collapses duplicate slashes `//` -> `/`
 * - Strips trailing slashes (unless root)
 */
export function normalizeFilePath(
  rawPath: string,
  workspaceRoot?: string
): string {
  if (typeof rawPath !== "string") {
    return "";
  }

  let normalized = rawPath.trim();
  if (!normalized) {
    return "";
  }

  // Convert backslashes to forward slashes and collapse duplicate slashes
  normalized = normalized.replace(/\\/g, "/").replace(/\/+/g, "/");

  if (typeof workspaceRoot === "string" && workspaceRoot.trim().length > 0) {
    const cleanRoot = workspaceRoot
      .trim()
      .replace(/\\/g, "/")
      .replace(/\/+/g, "/")
      .replace(/\/+$/, "");

    if (cleanRoot.length > 0) {
      // Case-insensitive drive letter comparison on Windows paths (e.g., D:/ vs d:/)
      const isWinDrivePath =
        /^[A-Za-z]:\//.test(cleanRoot) && /^[A-Za-z]:\//.test(normalized);
      const rootComparable = isWinDrivePath
        ? cleanRoot.toLowerCase()
        : cleanRoot;
      const pathComparable = isWinDrivePath
        ? normalized.toLowerCase()
        : normalized;

      if (pathComparable === rootComparable) {
        return "";
      }
      if (pathComparable.startsWith(`${rootComparable}/`)) {
        normalized = normalized.slice(cleanRoot.length + 1);
      }
    }
  }

  // Strip leading ./ segments repeatedly
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  // Collapse duplicate slashes again if any remained
  normalized = normalized.replace(/\/+/g, "/");

  // Strip trailing slashes
  normalized = normalized.replace(/\/+$/, "");

  if (normalized === "." || normalized.length === 0) {
    return "";
  }

  return normalized;
}

/**
 * Formats a `SourceKind` and target string into a canonical `SourceID`.
 */
export function formatSourceId(
  kind: SourceKind,
  target: string,
  workspaceRoot?: string
): SourceID {
  if (kind === "skill") {
    const trimmed = target.trim().replace(/^skill:/i, "").trim();
    return `skill:${trimmed}`;
  }
  const normalizedPath = normalizeFilePath(
    target.trim().replace(/^file:/i, ""),
    workspaceRoot
  );
  return `file:${normalizedPath}`;
}

/**
 * Validates and parses a raw `source_id` string (`skill:<id>` or `file:<path>`).
 * Returns a discriminated union with either `{ valid: true, parsed }` or `{ valid: false, error }`.
 */
export function parseAndValidateSourceId(
  rawInput: unknown,
  workspaceRoot?: string
): { valid: true; parsed: ParsedSource } | { valid: false; error: string } {
  if (typeof rawInput !== "string") {
    return {
      valid: false,
      error: "source_id must be a non-empty string in format 'skill:<id>' or 'file:<path>'.",
    };
  }

  const trimmed = rawInput.trim();
  if (!trimmed) {
    return {
      valid: false,
      error: "source_id cannot be empty. Expected 'skill:<id>' or 'file:<path>'.",
    };
  }

  const colonIndex = trimmed.indexOf(":");
  if (colonIndex <= 0) {
    return {
      valid: false,
      error: `Invalid source_id '${trimmed}': missing kind prefix. Expected 'skill:<id>' or 'file:<path>'.`,
    };
  }

  const rawKind = trimmed.slice(0, colonIndex).trim();
  const rawTarget = trimmed.slice(colonIndex + 1).trim();

  if (rawKind !== "skill" && rawKind !== "file") {
    return {
      valid: false,
      error: `Unsupported source kind '${rawKind}'. Only 'skill:<id>' and 'file:<path>' are supported.`,
    };
  }

  if (!rawTarget) {
    return {
      valid: false,
      error: `Invalid source_id '${trimmed}': target after '${rawKind}:' cannot be empty.`,
    };
  }

  if (rawKind === "skill") {
    if (!VALID_SKILL_ID_PATTERN.test(rawTarget)) {
      return {
        valid: false,
        error: `Invalid skill identifier '${rawTarget}'. Skill IDs cannot contain whitespace or control characters.`,
      };
    }

    const canonical: SourceID = `skill:${rawTarget}`;
    return {
      valid: true,
      parsed: {
        kind: "skill",
        target: rawTarget,
        normalizedTarget: rawTarget,
        raw: canonical,
      },
    };
  }

  // rawKind === "file"
  const normalizedPath = normalizeFilePath(rawTarget, workspaceRoot);
  if (!normalizedPath) {
    return {
      valid: false,
      error: `Invalid file path in '${trimmed}': normalized path cannot be empty.`,
    };
  }

  const canonical: SourceID = `file:${normalizedPath}`;
  return {
    valid: true,
    parsed: {
      kind: "file",
      target: normalizedPath,
      normalizedTarget: normalizedPath,
      raw: canonical,
    },
  };
}

/**
 * Parses and normalizes a `source_id` string into a `ParsedSource` object,
 * or returns `null` if the input is malformed or uses an unsupported prefix.
 */
export function parseSourceId(
  rawInput: unknown,
  workspaceRoot?: string
): ParsedSource | null {
  const result = parseAndValidateSourceId(rawInput, workspaceRoot);
  return result.valid ? result.parsed : null;
}

/**
 * Type guard / boolean validator checking whether `rawInput` is a valid `SourceID`.
 */
export function isValidSourceId(
  rawInput: unknown,
  workspaceRoot?: string
): rawInput is SourceID {
  return parseAndValidateSourceId(rawInput, workspaceRoot).valid;
}

const SKILL_TOOL_NAMES = new Set(["skill", "load_skill", "use_skill"]);
const READ_TOOL_NAMES = new Set(["read", "read_file", "file_read", "view_file"]);

/**
 * Extracts a canonical `SourceID` from a tool invocation's name and input arguments.
 * Returns `null` if the tool is not a recognized skill or file-read tool, or if
 * the required argument is missing or invalid.
 */
export function extractSourceFromToolCall(
  toolName: string,
  args: unknown,
  workspaceRoot?: string
): SourceID | null {
  if (typeof toolName !== "string" || !toolName.trim()) {
    return null;
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }

  const normalizedTool = toolName.trim().toLowerCase();
  const record = args as Record<string, unknown>;

  if (SKILL_TOOL_NAMES.has(normalizedTool)) {
    const candidate =
      record.id ?? record.name ?? record.skill ?? record.skillId;
    if (typeof candidate !== "string" || !candidate.trim()) {
      return null;
    }
    const rawSkillId = candidate.trim().replace(/^skill:/i, "").trim();
    const parsed = parseSourceId(`skill:${rawSkillId}`, workspaceRoot);
    return parsed ? parsed.raw : null;
  }

  if (READ_TOOL_NAMES.has(normalizedTool)) {
    const candidate =
      record.filePath ?? record.path ?? record.file ?? record.target;
    if (typeof candidate !== "string" || !candidate.trim()) {
      return null;
    }
    const rawFilePath = candidate.trim().replace(/^file:/i, "").trim();
    const parsed = parseSourceId(`file:${rawFilePath}`, workspaceRoot);
    return parsed ? parsed.raw : null;
  }

  return null;
}

/**
 * Checks whether a message is an OpenCode V1 `V1MessageWithParts` envelope (`{ info, parts }`).
 */
export function isV1Message(
  msg: V2Message | V1MessageWithParts
): msg is V1MessageWithParts {
  return (
    Boolean(msg) &&
    typeof msg === "object" &&
    "info" in msg &&
    Boolean((msg as V1MessageWithParts).info) &&
    Array.isArray((msg as V1MessageWithParts).parts)
  );
}

function getCallIdFromObject(obj: Record<string, unknown>): string | undefined {
  const candidate =
    obj.toolCallId ?? obj.toolCallID ?? obj.callID ?? obj.tool_use_id ?? obj.id;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}

function getPartTextLength(part: V2Part | V1Part): {
  length: number;
  alreadyEvicted: boolean;
} {
  if (typeof part.state?.output === "string") {
    const out = part.state.output;
    return {
      length: out.length,
      alreadyEvicted: out.startsWith(TOMBSTONE_PREFIX),
    };
  }
  if (typeof (part as V2Part).output === "string") {
    const out = (part as V2Part).output as string;
    return {
      length: out.length,
      alreadyEvicted: out.startsWith(TOMBSTONE_PREFIX),
    };
  }
  if (typeof (part as V2Part).result === "string") {
    const res = (part as V2Part).result as string;
    return {
      length: res.length,
      alreadyEvicted: res.startsWith(TOMBSTONE_PREFIX),
    };
  }
  if (typeof part.text === "string") {
    return {
      length: part.text.length,
      alreadyEvicted: part.text.startsWith(TOMBSTONE_PREFIX),
    };
  }
  const content = (part as V2Part).content;
  if (typeof content === "string") {
    return {
      length: content.length,
      alreadyEvicted: content.startsWith(TOMBSTONE_PREFIX),
    };
  }
  if (Array.isArray(content)) {
    let total = 0;
    let allEvicted = content.length > 0;
    for (const sub of content) {
      if (sub && typeof sub.text === "string") {
        total += sub.text.length;
        if (!sub.text.startsWith(TOMBSTONE_PREFIX)) {
          allEvicted = false;
        }
      }
    }
    return { length: total, alreadyEvicted: allEvicted };
  }
  return { length: 0, alreadyEvicted: false };
}

function getMessageTextLength(msg: V2Message): {
  length: number;
  alreadyEvicted: boolean;
} {
  if (typeof msg.content === "string") {
    return {
      length: msg.content.length,
      alreadyEvicted: msg.content.startsWith(TOMBSTONE_PREFIX),
    };
  }
  const parts = Array.isArray(msg.parts)
    ? msg.parts
    : Array.isArray(msg.content)
      ? msg.content
      : undefined;
  if (parts) {
    let total = 0;
    let allEvicted = parts.length > 0;
    for (const part of parts) {
      const info = getPartTextLength(part);
      total += info.length;
      if (!info.alreadyEvicted) {
        allEvicted = false;
      }
    }
    return { length: total, alreadyEvicted: allEvicted };
  }
  return { length: 0, alreadyEvicted: false };
}

function extractSkillEnvelopeMatches(
  text: string,
  workspaceRoot?: string
): Array<{
  parsed: ParsedSource;
  innerLength: number;
  alreadyEvicted: boolean;
}> {
  const results: Array<{
    parsed: ParsedSource;
    innerLength: number;
    alreadyEvicted: boolean;
  }> = [];

  if (!text || !text.includes("<skill")) {
    return results;
  }

  const regex = new RegExp(SKILL_XML_ENVELOPE_REGEX.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const rawSkillName = match[2]?.trim();
    const innerBody = match[3] ?? "";
    if (!rawSkillName) {
      continue;
    }
    const parsed = parseSourceId(`skill:${rawSkillName}`, workspaceRoot);
    if (parsed) {
      const trimmedInner = innerBody.trim();
      results.push({
        parsed,
        innerLength: innerBody.length,
        alreadyEvicted: trimmedInner.startsWith(TOMBSTONE_PREFIX),
      });
    }
  }

  return results;
}

/**
 * Scans an outgoing `messages` array (supporting both OpenCode V2 `V2Message[]`
 * and OpenCode V1 `V1MessageWithParts[]`) and returns all structural occurrences
 * of tracked sources (or only those matching `targetSourceId` if specified).
 *
 * CRITICAL GUARANTEE:
 * Never performs arbitrary substring matching on user/assistant prose.
 * Only matches structured tool-call/result pairs, dedicated skill blocks/parts,
 * and structured `<skill_content name="...">...</skill_content>` envelopes.
 */
export function locateSourceInMessages(
  messages: ReadonlyArray<V2Message | V1MessageWithParts>,
  targetSourceId?: SourceID | string,
  callIdToSource?: ReadonlyMap<string, SourceID>,
  workspaceRoot?: string
): TrackedSourceOccurrence[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  const normalizedFilter = targetSourceId
    ? parseSourceId(targetSourceId, workspaceRoot)?.raw ?? null
    : undefined;
  if (targetSourceId !== undefined && normalizedFilter === null) {
    return [];
  }

  // Step 1: Build effective callID -> SourceID correlation map
  const effectiveCallMap = new Map<string, SourceID>();
  if (callIdToSource) {
    for (const [callId, srcId] of callIdToSource.entries()) {
      const normalized = parseSourceId(srcId, workspaceRoot);
      if (normalized) {
        effectiveCallMap.set(callId, normalized.raw);
      }
    }
  }

  // First pass: collect tool-call definitions from assistant messages / tool_calls arrays / parts
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      continue;
    }

    if (isV1Message(msg)) {
      for (const part of msg.parts) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "tool" && typeof part.tool === "string") {
          const input = part.state?.input ?? (part.input as Record<string, unknown> | undefined);
          const extracted = extractSourceFromToolCall(
            part.tool,
            input,
            workspaceRoot
          );
          if (extracted && typeof part.callID === "string" && part.callID) {
            effectiveCallMap.set(part.callID, extracted);
          }
        }
      }
      continue;
    }

    // V2 Message: check OpenAI-style `tool_calls` array if present
    const toolCallsArray = (msg as Record<string, unknown>).tool_calls;
    if (Array.isArray(toolCallsArray)) {
      for (const tc of toolCallsArray) {
        if (!tc || typeof tc !== "object") continue;
        const tcObj = tc as Record<string, unknown>;
        const callId = getCallIdFromObject(tcObj);
        const fn = tcObj.function as Record<string, unknown> | undefined;
        const toolName =
          (typeof tcObj.toolName === "string" ? tcObj.toolName : undefined) ??
          (typeof tcObj.name === "string" ? tcObj.name : undefined) ??
          (fn && typeof fn.name === "string" ? fn.name : undefined);
        let rawArgs: unknown = tcObj.args ?? tcObj.input ?? fn?.arguments;
        if (typeof rawArgs === "string") {
          try {
            rawArgs = JSON.parse(rawArgs);
          } catch {
            // Ignore unparseable JSON string arguments
          }
        }
        if (callId && toolName) {
          const extracted = extractSourceFromToolCall(
            toolName,
            rawArgs,
            workspaceRoot
          );
          if (extracted) {
            effectiveCallMap.set(callId, extracted);
          }
        }
      }
    }

    // V2 Message parts (`msg.parts` or `Array.isArray(msg.content)`)
    const parts: V2Part[] = Array.isArray(msg.parts)
      ? msg.parts
      : Array.isArray(msg.content)
        ? msg.content
        : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      if (
        part.type === "tool-call" ||
        part.type === "tool_use" ||
        part.type === "tool"
      ) {
        const callId = getCallIdFromObject(part as Record<string, unknown>);
        const toolName = part.toolName ?? part.tool ?? part.name;
        const rawArgs = part.args ?? part.input ?? part.state?.input;
        if (callId && typeof toolName === "string") {
          const extracted = extractSourceFromToolCall(
            toolName,
            rawArgs,
            workspaceRoot
          );
          if (extracted) {
            effectiveCallMap.set(callId, extracted);
          }
        }
      }
    }
  }

  // Step 2: Second pass to locate actual loaded source payload occurrences
  const occurrences: TrackedSourceOccurrence[] = [];

  function pushOccurrence(occ: TrackedSourceOccurrence): void {
    if (normalizedFilter && occ.sourceId !== normalizedFilter) {
      return;
    }
    occurrences.push(occ);
  }

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const msg = messages[messageIndex];
    if (!msg || typeof msg !== "object") {
      continue;
    }

    // Handle V1MessageWithParts
    if (isV1Message(msg)) {
      for (let partIndex = 0; partIndex < msg.parts.length; partIndex++) {
        const part = msg.parts[partIndex];
        if (!part || typeof part !== "object") continue;

        if (part.type === "tool") {
          const callID =
            typeof part.callID === "string" ? part.callID : undefined;
          const fromCall =
            callID && effectiveCallMap.has(callID)
              ? effectiveCallMap.get(callID)!
              : typeof part.tool === "string"
                ? extractSourceFromToolCall(
                    part.tool,
                    part.state?.input,
                    workspaceRoot
                  )
                : null;

          if (fromCall && typeof part.state?.output === "string") {
            const parsed = parseSourceId(fromCall, workspaceRoot);
            if (parsed) {
              const { length, alreadyEvicted } = getPartTextLength(part);
              pushOccurrence({
                messageIndex,
                partIndex,
                sourceId: parsed.raw,
                kind: parsed.kind,
                target: parsed.target,
                callID,
                currentLength: length,
                alreadyEvicted,
              });
            }
          }
          continue;
        }

        if (part.type === "skill") {
          const skillName =
            (typeof part.skillId === "string" ? part.skillId : undefined) ??
            (typeof part.name === "string" ? part.name : undefined) ??
            (typeof part.id === "string" ? part.id : undefined);
          if (skillName) {
            const parsed = parseSourceId(`skill:${skillName}`, workspaceRoot);
            if (parsed) {
              const { length, alreadyEvicted } = getPartTextLength(part);
              pushOccurrence({
                messageIndex,
                partIndex,
                sourceId: parsed.raw,
                kind: parsed.kind,
                target: parsed.target,
                currentLength: length,
                alreadyEvicted,
              });
            }
          }
          continue;
        }

        // Check structured <skill_content name="..."> envelope inside text part
        if (typeof part.text === "string" && part.text.includes("<skill")) {
          const envelopes = extractSkillEnvelopeMatches(
            part.text,
            workspaceRoot
          );
          for (const env of envelopes) {
            pushOccurrence({
              messageIndex,
              partIndex,
              sourceId: env.parsed.raw,
              kind: env.parsed.kind,
              target: env.parsed.target,
              currentLength: env.innerLength,
              alreadyEvicted: env.alreadyEvicted,
            });
          }
        }
      }
      continue;
    }

    // Handle V2Message
    // Case A: Dedicated `role: "skill"` message
    if (msg.role === "skill") {
      const skillName =
        msg.skillId ?? msg.id_skill ?? msg.name ?? msg.id;
      if (typeof skillName === "string" && skillName.trim().length > 0) {
        const parsed = parseSourceId(`skill:${skillName}`, workspaceRoot);
        if (parsed) {
          const { length, alreadyEvicted } = getMessageTextLength(msg);
          pushOccurrence({
            messageIndex,
            sourceId: parsed.raw,
            kind: parsed.kind,
            target: parsed.target,
            currentLength: length,
            alreadyEvicted,
          });
          continue;
        }
      }
    }

    // Case B: Dedicated `role: "tool"` message with message-level callID and string content
    const msgCallId = getCallIdFromObject(msg as Record<string, unknown>);
    const hasPartsArray =
      Array.isArray(msg.parts) || Array.isArray(msg.content);

    if (msg.role === "tool" && !hasPartsArray) {
      const directSource =
        (msgCallId ? effectiveCallMap.get(msgCallId) : undefined) ??
        (typeof msg.toolName === "string"
          ? extractSourceFromToolCall(
              msg.toolName,
              (msg as Record<string, unknown>).args ??
                (msg as Record<string, unknown>).input,
              workspaceRoot
            )
          : null);

      if (directSource) {
        const parsed = parseSourceId(directSource, workspaceRoot);
        if (parsed) {
          const { length, alreadyEvicted } = getMessageTextLength(msg);
          pushOccurrence({
            messageIndex,
            sourceId: parsed.raw,
            kind: parsed.kind,
            target: parsed.target,
            callID: msgCallId,
            currentLength: length,
            alreadyEvicted,
          });
          continue;
        }
      }
    }

    // Case C: Inspect message parts (`msg.parts` or `Array.isArray(msg.content)`)
    const v2Parts: V2Part[] | undefined = Array.isArray(msg.parts)
      ? msg.parts
      : Array.isArray(msg.content)
        ? msg.content
        : undefined;

    if (v2Parts) {
      let matchedPartInToolMessage = false;

      for (let partIndex = 0; partIndex < v2Parts.length; partIndex++) {
        const part = v2Parts[partIndex];
        if (!part || typeof part !== "object") continue;

        // 1. Tool result part (`tool-result` / `tool_result`) or `tool` part with output
        if (
          part.type === "tool-result" ||
          part.type === "tool_result" ||
          (part.type === "tool" &&
            (typeof part.output === "string" ||
              typeof part.result === "string" ||
              typeof part.state?.output === "string"))
        ) {
          const callId =
            getCallIdFromObject(part as Record<string, unknown>) ?? msgCallId;
          const toolName = part.toolName ?? part.tool ?? part.name ?? msg.toolName;
          const rawInput = part.args ?? part.input ?? part.state?.input;
          const sourceId =
            (callId ? effectiveCallMap.get(callId) : undefined) ??
            (typeof toolName === "string"
              ? extractSourceFromToolCall(toolName, rawInput, workspaceRoot)
              : null);

          if (sourceId) {
            const parsed = parseSourceId(sourceId, workspaceRoot);
            if (parsed) {
              const { length, alreadyEvicted } = getPartTextLength(part);
              pushOccurrence({
                messageIndex,
                partIndex,
                sourceId: parsed.raw,
                kind: parsed.kind,
                target: parsed.target,
                callID: callId,
                currentLength: length,
                alreadyEvicted,
              });
              matchedPartInToolMessage = true;
              continue;
            }
          }
        }

        // 2. Dedicated `type: "skill"` part
        if (part.type === "skill") {
          const skillName = part.skillId ?? part.name ?? part.id;
          if (typeof skillName === "string" && skillName.trim().length > 0) {
            const parsed = parseSourceId(`skill:${skillName}`, workspaceRoot);
            if (parsed) {
              const { length, alreadyEvicted } = getPartTextLength(part);
              pushOccurrence({
                messageIndex,
                partIndex,
                sourceId: parsed.raw,
                kind: parsed.kind,
                target: parsed.target,
                currentLength: length,
                alreadyEvicted,
              });
              matchedPartInToolMessage = true;
              continue;
            }
          }
        }

        // 3. Structured `<skill_content name="...">` envelope in text/content
        const textCandidate =
          typeof part.text === "string"
            ? part.text
            : typeof part.content === "string"
              ? part.content
              : typeof part.output === "string"
                ? part.output
                : undefined;

        if (textCandidate && textCandidate.includes("<skill")) {
          const envelopes = extractSkillEnvelopeMatches(
            textCandidate,
            workspaceRoot
          );
          for (const env of envelopes) {
            pushOccurrence({
              messageIndex,
              partIndex,
              sourceId: env.parsed.raw,
              kind: env.parsed.kind,
              target: env.parsed.target,
              currentLength: env.innerLength,
              alreadyEvicted: env.alreadyEvicted,
            });
            matchedPartInToolMessage = true;
          }
        }
      }

      // If `role: "tool"` message had a message-level callID and generic text parts
      if (
        msg.role === "tool" &&
        !matchedPartInToolMessage &&
        msgCallId &&
        effectiveCallMap.has(msgCallId)
      ) {
        const parsed = parseSourceId(
          effectiveCallMap.get(msgCallId)!,
          workspaceRoot
        );
        if (parsed) {
          const { length, alreadyEvicted } = getMessageTextLength(msg);
          pushOccurrence({
            messageIndex,
            sourceId: parsed.raw,
            kind: parsed.kind,
            target: parsed.target,
            callID: msgCallId,
            currentLength: length,
            alreadyEvicted,
          });
        }
      }

      continue;
    }

    // Case D: String `msg.content` containing a structured `<skill_content name="...">` XML envelope
    if (typeof msg.content === "string" && msg.content.includes("<skill")) {
      const envelopes = extractSkillEnvelopeMatches(
        msg.content,
        workspaceRoot
      );
      for (const env of envelopes) {
        pushOccurrence({
          messageIndex,
          sourceId: env.parsed.raw,
          kind: env.parsed.kind,
          target: env.parsed.target,
          currentLength: env.innerLength,
          alreadyEvicted: env.alreadyEvicted,
        });
      }
    }
  }

  return occurrences;
}

/**
 * Collects the set of all valid `SourceID`s structurally present in `messages`
 * or recorded in `callIdToSource`.
 */
export function collectKnownSourcesFromMessages(
  messages: ReadonlyArray<V2Message | V1MessageWithParts>,
  callIdToSource?: ReadonlyMap<string, SourceID>,
  workspaceRoot?: string
): Set<SourceID> {
  const known = new Set<SourceID>();

  if (callIdToSource) {
    for (const srcId of callIdToSource.values()) {
      const parsed = parseSourceId(srcId, workspaceRoot);
      if (parsed) {
        known.add(parsed.raw);
      }
    }
  }

  const occurrences = locateSourceInMessages(
    messages,
    undefined,
    callIdToSource,
    workspaceRoot
  );
  for (const occ of occurrences) {
    known.add(occ.sourceId);
  }

  return known;
}
