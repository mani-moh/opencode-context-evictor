import {
  SKILL_XML_ENVELOPE_REGEX,
  isTombstoneText,
  isV1Message,
  locateSourceInMessages,
  MINIMAL_TOMBSTONE,
  parseSourceId,
} from "./tracker.js";
import type { PrivacySafeLogger } from "./logger.js";
import type { RejectionRegistry } from "./registry.js";
import type {
  ContextEvictorConfig,
  EvictionStats,
  ParsedSource,
  SessionCompactionEvent,
  SessionContextEvent,
  SourceID,
  SourceKind,
  SystemPart,
  TrackedSourceOccurrence,
  V1MessageWithParts,
  V1Part,
  V2Message,
  V2Part,
} from "./types.js";

/**
 * Exact system instruction required by Specification Section 8.
 * Appended deterministically from Turn 1 so the system prompt prefix never shifts
 * when the first eviction occurs.
 */
export const SYSTEM_INSTRUCTION =
  "When you inspect a loaded context source and determine that it is irrelevant to the current task, use context_evict to remove it from subsequent model requests. Do not evict information merely because you have not used it yet. Do not evict uncertain or potentially useful information.";

/**
 * Checks whether a system prompt string or `SystemPart` array already contains
 * `SYSTEM_INSTRUCTION`.
 */
function hasSystemInstruction(
  systemInput: string | ReadonlyArray<string | SystemPart>
): boolean {
  if (typeof systemInput === "string") {
    return systemInput.includes(SYSTEM_INSTRUCTION);
  }
  for (const item of systemInput) {
    if (typeof item === "string") {
      if (item.includes(SYSTEM_INSTRUCTION)) {
        return true;
      }
    } else if (item && typeof item === "object") {
      if (
        (typeof item.text === "string" &&
          item.text.includes(SYSTEM_INSTRUCTION)) ||
        (typeof item.content === "string" &&
          item.content.includes(SYSTEM_INSTRUCTION))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Appends `SYSTEM_INSTRUCTION` deterministically at the end of `systemInput`
 * without duplicating it on subsequent turns.
 *
 * When `SYSTEM_INSTRUCTION` is already present, returns `systemInput` untouched
 * (`===` reference identity preserved).
 */
export function ensureSystemInstruction(
  systemInput: string | Array<string | SystemPart> | undefined
): string | Array<string | SystemPart> {
  if (systemInput === undefined) {
    return SYSTEM_INSTRUCTION;
  }

  if (typeof systemInput === "string") {
    if (systemInput.trim().length === 0) {
      return SYSTEM_INSTRUCTION;
    }
    if (hasSystemInstruction(systemInput)) {
      return systemInput;
    }
    return `${systemInput}\n\n${SYSTEM_INSTRUCTION}`;
  }

  if (Array.isArray(systemInput)) {
    if (hasSystemInstruction(systemInput)) {
      return systemInput;
    }

    const allStrings =
      systemInput.length > 0 &&
      systemInput.every((item) => typeof item === "string");

    if (allStrings) {
      return [...systemInput, SYSTEM_INSTRUCTION];
    }

    return [
      ...systemInput,
      {
        type: "text",
        text: SYSTEM_INSTRUCTION,
      },
    ];
  }

  return SYSTEM_INSTRUCTION;
}

/**
 * Mutates an OpenCode V1 `output.system` string array in-place by appending
 * `SYSTEM_INSTRUCTION` at the end if not already present.
 */
export function injectIntoV1SystemArray(system: string[]): void {
  if (!Array.isArray(system)) {
    return;
  }
  if (hasSystemInstruction(system)) {
    return;
  }
  system.push(SYSTEM_INSTRUCTION);
}

/**
 * Builds a deterministic tombstone marker for an evicted context source.
 *
 * - When `preserveMarkers` is `true` (default):
 *   `[Context Evicted: ${kind} ${target} was inspected and rejected for this task.]`
 * - When `preserveMarkers` is `false`:
 *   `[Context Evicted]`
 *
 * Never includes timestamps, random IDs, or mutable user-supplied reasons so
 * prompt token representations remain 100% deterministic for prefix-cache stability.
 */
export function buildTombstone(
  sourceIdOrParsed: SourceID | ParsedSource | string,
  preserveMarkers = true,
  workspaceRoot?: string
): string {
  if (!preserveMarkers) {
    return MINIMAL_TOMBSTONE;
  }

  let kind: SourceKind | string = "skill";
  let target = "";

  if (sourceIdOrParsed && typeof sourceIdOrParsed === "object") {
    kind = sourceIdOrParsed.kind;
    target = sourceIdOrParsed.target;
  } else if (typeof sourceIdOrParsed === "string") {
    const parsed = parseSourceId(sourceIdOrParsed, workspaceRoot);
    if (parsed) {
      kind = parsed.kind;
      target = parsed.target;
    } else {
      const trimmed = sourceIdOrParsed.trim();
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx > 0) {
        kind = trimmed.slice(0, colonIdx).trim();
        target = trimmed.slice(colonIdx + 1).trim();
      } else {
        target = trimmed;
      }
    }
  }

  return `[Context Evicted: ${kind} ${target} was inspected and rejected for this task.]`;
}

export interface EvictMessagesOptions {
  rejectedIds?:
    | ReadonlySet<SourceID>
    | readonly SourceID[]
    | ReadonlySet<string>
    | readonly string[];
  callIdToSource?: ReadonlyMap<string, SourceID>;
  config?: Partial<
    Pick<ContextEvictorConfig, "enabled" | "preserveMarkers" | "debug">
  >;
  preserveMarkers?: boolean;
  workspaceRoot?: string;
  registry?: RejectionRegistry;
  sessionID?: string;
  logger?: PrivacySafeLogger;
}

function createEmptyStats(messageCount: number): EvictionStats {
  return {
    evictedSources: [],
    messagesModified: 0,
    partsRedacted: 0,
    messagesInspected: messageCount,
    messagesCloned: 0,
    occurrencesEvicted: 0,
    charsRemoved: 0,
    prefixPreservedUntilIndex: messageCount,
  };
}

function resolveRejectedSet(
  options?: EvictMessagesOptions
): Set<SourceID> {
  const result = new Set<SourceID>();
  const workspaceRoot = options?.workspaceRoot;

  if (options?.rejectedIds !== undefined) {
    for (const rawId of options.rejectedIds) {
      const parsed = parseSourceId(rawId, workspaceRoot);
      if (parsed) {
        result.add(parsed.raw);
      }
    }
    return result;
  }

  if (options?.registry && options?.sessionID) {
    return options.registry.getRejectedIds(options.sessionID);
  }

  return result;
}

/**
 * Replaces `<skill_content name="...">...</skill_content>` or `<skill name="...">...</skill>`
 * XML envelopes matching `targetSourceId` with `tombstone`, preserving all surrounding text
 * and any other `<skill_content>` blocks in the same string.
 */
export function redactSkillXmlForTarget(
  text: string,
  targetSourceId: SourceID,
  tombstone: string,
  workspaceRoot?: string
): {
  text: string;
  redactedCount: number;
  charsRemoved: number;
} {
  if (typeof text !== "string" || !text.includes("<skill")) {
    return { text, redactedCount: 0, charsRemoved: 0 };
  }

  let redactedCount = 0;
  let charsRemoved = 0;
  const regex = new RegExp(SKILL_XML_ENVELOPE_REGEX.source, "gi");

  const nextText = text.replace(
    regex,
    (fullMatch, _tagName: string, rawSkillName: string, innerBody: string) => {
      if (!rawSkillName) {
        return fullMatch;
      }
      const parsed = parseSourceId(`skill:${rawSkillName.trim()}`, workspaceRoot);
      if (!parsed || parsed.raw !== targetSourceId) {
        return fullMatch;
      }
      if (isTombstoneText(innerBody ?? "") || isTombstoneText(fullMatch)) {
        return fullMatch;
      }
      redactedCount += 1;
      charsRemoved += Math.max(0, fullMatch.length - tombstone.length);
      return tombstone;
    }
  );

  return {
    text: nextText,
    redactedCount,
    charsRemoved,
  };
}

function redactPayloadString(
  original: string,
  occ: TrackedSourceOccurrence,
  tombstone: string,
  workspaceRoot?: string
): {
  next: string;
  changed: boolean;
  charsRemoved: number;
} {
  if (original === tombstone || isTombstoneText(original)) {
    return { next: original, changed: false, charsRemoved: 0 };
  }

  // If this is a skill occurrence and the string contains a <skill_content> / <skill> XML envelope
  if (occ.kind === "skill" && original.includes("<skill")) {
    const xmlRes = redactSkillXmlForTarget(
      original,
      occ.sourceId,
      tombstone,
      workspaceRoot
    );
    if (xmlRes.redactedCount > 0) {
      return {
        next: xmlRes.text,
        changed: xmlRes.text !== original,
        charsRemoved: xmlRes.charsRemoved,
      };
    }
  }

  const charsRemoved = Math.max(0, original.length - tombstone.length);
  return {
    next: tombstone,
    changed: true,
    charsRemoved,
  };
}

function redactV1Part(
  part: V1Part,
  occ: TrackedSourceOccurrence,
  tombstone: string,
  workspaceRoot?: string
): {
  part: V1Part;
  changed: boolean;
  charsRemoved: number;
} {
  // 1. V1 tool part: state.output holds the tool output
  if (part.type === "tool" && typeof part.state?.output === "string") {
    const res = redactPayloadString(
      part.state.output,
      occ,
      tombstone,
      workspaceRoot
    );
    if (!res.changed) {
      return { part, changed: false, charsRemoved: 0 };
    }
    return {
      part: {
        ...part,
        state: {
          ...part.state,
          output: res.next,
        },
      },
      changed: true,
      charsRemoved: res.charsRemoved,
    };
  }

  // 2. V1 text or skill part with text
  if (typeof part.text === "string") {
    const res = redactPayloadString(part.text, occ, tombstone, workspaceRoot);
    if (!res.changed) {
      return { part, changed: false, charsRemoved: 0 };
    }
    return {
      part: {
        ...part,
        text: res.next,
      },
      changed: true,
      charsRemoved: res.charsRemoved,
    };
  }

  // 3. Fallback if state.output is used on non-tool V1 part
  if (typeof part.state?.output === "string") {
    const res = redactPayloadString(
      part.state.output,
      occ,
      tombstone,
      workspaceRoot
    );
    if (!res.changed) {
      return { part, changed: false, charsRemoved: 0 };
    }
    return {
      part: {
        ...part,
        state: {
          ...part.state,
          output: res.next,
        },
      },
      changed: true,
      charsRemoved: res.charsRemoved,
    };
  }

  return { part, changed: false, charsRemoved: 0 };
}

function redactV2Part(
  part: V2Part,
  occ: TrackedSourceOccurrence,
  tombstone: string,
  workspaceRoot?: string
): {
  part: V2Part;
  changed: boolean;
  charsRemoved: number;
} {
  let changed = false;
  let charsRemoved = 0;
  let clonedPart: V2Part | null = null;

  function ensureClone(): V2Part {
    if (!clonedPart) {
      clonedPart = { ...part };
    }
    return clonedPart;
  }

  if (typeof part.state?.output === "string") {
    const res = redactPayloadString(
      part.state.output,
      occ,
      tombstone,
      workspaceRoot
    );
    if (res.changed) {
      const target = ensureClone();
      target.state = {
        ...part.state,
        output: res.next,
      };
      changed = true;
      charsRemoved = Math.max(charsRemoved, res.charsRemoved);
    }
  }

  if (typeof part.output === "string") {
    const res = redactPayloadString(part.output, occ, tombstone, workspaceRoot);
    if (res.changed) {
      const target = ensureClone();
      target.output = res.next;
      changed = true;
      charsRemoved = Math.max(charsRemoved, res.charsRemoved);
    }
  }

  if (typeof part.result === "string") {
    const res = redactPayloadString(part.result, occ, tombstone, workspaceRoot);
    if (res.changed) {
      const target = ensureClone();
      target.result = res.next;
      changed = true;
      charsRemoved = Math.max(charsRemoved, res.charsRemoved);
    }
  }

  if (typeof part.text === "string") {
    const res = redactPayloadString(part.text, occ, tombstone, workspaceRoot);
    if (res.changed) {
      const target = ensureClone();
      target.text = res.next;
      changed = true;
      charsRemoved = Math.max(charsRemoved, res.charsRemoved);
    }
  }

  if (typeof part.content === "string") {
    const res = redactPayloadString(part.content, occ, tombstone, workspaceRoot);
    if (res.changed) {
      const target = ensureClone();
      target.content = res.next;
      changed = true;
      charsRemoved = Math.max(charsRemoved, res.charsRemoved);
    }
  } else if (Array.isArray(part.content)) {
    let subArrayCloned: Array<{
      type: string;
      text?: string;
      [key: string]: unknown;
    }> | null = null;
    let subCharsRemoved = 0;

    for (let i = 0; i < part.content.length; i++) {
      const sub = part.content[i];
      if (sub && typeof sub.text === "string") {
        const res = redactPayloadString(
          sub.text,
          occ,
          tombstone,
          workspaceRoot
        );
        if (res.changed) {
          if (!subArrayCloned) {
            subArrayCloned = part.content.slice();
          }
          subArrayCloned[i] = { ...sub, text: res.next };
          subCharsRemoved += res.charsRemoved;
        }
      }
    }

    if (subArrayCloned) {
      const target = ensureClone();
      target.content = subArrayCloned;
      changed = true;
      charsRemoved = Math.max(charsRemoved, subCharsRemoved);
    }
  }

  return {
    part: clonedPart ?? part,
    changed,
    charsRemoved,
  };
}

function redactV2MessageLevel(
  msg: V2Message,
  occ: TrackedSourceOccurrence,
  tombstone: string,
  workspaceRoot?: string
): {
  msg: V2Message;
  changed: boolean;
  charsRemoved: number;
} {
  if (typeof msg.content === "string") {
    const res = redactPayloadString(msg.content, occ, tombstone, workspaceRoot);
    if (!res.changed) {
      return { msg, changed: false, charsRemoved: 0 };
    }
    return {
      msg: {
        ...msg,
        content: res.next,
      },
      changed: true,
      charsRemoved: res.charsRemoved,
    };
  }

  // Message-level occurrence where content/parts is an array of generic text parts
  const arrayKey: "parts" | "content" | null = Array.isArray(msg.parts)
    ? "parts"
    : Array.isArray(msg.content)
      ? "content"
      : null;

  if (arrayKey) {
    const origParts = msg[arrayKey] as V2Part[];
    let nextParts: V2Part[] | null = null;
    let totalRemoved = 0;

    for (let i = 0; i < origParts.length; i++) {
      const p = origParts[i];
      if (!p || typeof p !== "object") continue;
      const partRes = redactV2Part(p, occ, tombstone, workspaceRoot);
      if (partRes.changed) {
        if (!nextParts) {
          nextParts = origParts.slice();
        }
        nextParts[i] = partRes.part;
        totalRemoved += partRes.charsRemoved;
      }
    }

    if (nextParts) {
      return {
        msg: {
          ...msg,
          [arrayKey]: nextParts,
        },
        changed: true,
        charsRemoved: totalRemoved,
      };
    }
  }

  return { msg, changed: false, charsRemoved: 0 };
}

/**
 * Prefix-preserving copy-on-write context eviction engine.
 *
 * - Fast-path no-op when `config.enabled === false`, `messages` is empty, or `rejectedIds` is empty:
 *   returns `messages` with exact object reference identity (`result.messages === messages`).
 * - When redacting rejected occurrences:
 *   clones ONLY the outer `messages` array and the specific message/part spine that changes.
 *   All unaffected messages (especially the prefix before `prefixPreservedUntilIndex`) and all
 *   unaffected sibling parts inside modified messages retain strict `===` reference identity.
 * - Preserves tool-call / tool-result pairing metadata (`role`, `id`, `toolCallId`, `callID`,
 *   `toolName`, `args`/`input`).
 */
export function evictRejectedFromMessages<
  T extends V2Message | V1MessageWithParts = V2Message,
>(
  messages: readonly T[],
  options?: EvictMessagesOptions
): {
  messages: T[];
  stats: EvictionStats;
} {
  const messageCount = Array.isArray(messages) ? messages.length : 0;
  const enabled = options?.config?.enabled ?? true;

  if (!enabled || !Array.isArray(messages) || messageCount === 0) {
    return {
      messages: messages as T[],
      stats: createEmptyStats(messageCount),
    };
  }

  const preserveMarkers =
    options?.preserveMarkers ?? options?.config?.preserveMarkers ?? true;
  const workspaceRoot = options?.workspaceRoot;
  const registry = options?.registry;
  const sessionID = options?.sessionID;
  const logger = options?.logger;

  // Sync known sources from transcript into registry before any redaction
  if (registry && sessionID) {
    registry.syncKnownSourcesFromMessages(sessionID, messages, workspaceRoot);
  }

  const rejectedSet = resolveRejectedSet(options);
  if (rejectedSet.size === 0) {
    return {
      messages: messages as T[],
      stats: createEmptyStats(messageCount),
    };
  }

  const callIdToSource =
    options?.callIdToSource ??
    (registry && sessionID ? registry.getCallIdMap(sessionID) : undefined);

  const allOccurrences = locateSourceInMessages(
    messages,
    undefined,
    callIdToSource,
    workspaceRoot
  );

  const targetOccurrences = allOccurrences.filter(
    (occ) => rejectedSet.has(occ.sourceId) && !occ.alreadyEvicted
  );

  if (targetOccurrences.length === 0) {
    return {
      messages: messages as T[],
      stats: createEmptyStats(messageCount),
    };
  }

  let nextMessages: T[] | null = null;
  const modifiedMessageIndices = new Set<number>();
  const evictedSourcesOrder: SourceID[] = [];
  const evictedSourcesSet = new Set<SourceID>();
  const charsBySource = new Map<SourceID, number>();
  let partsRedacted = 0;
  let totalCharsRemoved = 0;
  let firstMutatedIndex = messageCount;

  // Group occurrences by messageIndex so we only clone each modified message once
  const occurrencesByMsg = new Map<number, TrackedSourceOccurrence[]>();
  for (const occ of targetOccurrences) {
    let list = occurrencesByMsg.get(occ.messageIndex);
    if (!list) {
      list = [];
      occurrencesByMsg.set(occ.messageIndex, list);
    }
    list.push(occ);
  }

  for (const [msgIdx, msgOccurrences] of occurrencesByMsg.entries()) {
    const origMsg = messages[msgIdx];
    if (!origMsg || typeof origMsg !== "object") {
      continue;
    }

    if (isV1Message(origMsg)) {
      let currentMsg: V1MessageWithParts = origMsg;
      let nextParts: V1Part[] | null = null;
      let msgChanged = false;

      for (const occ of msgOccurrences) {
        if (occ.partIndex === undefined) continue;
        const currentParts = nextParts ?? currentMsg.parts;
        const origPart = currentParts[occ.partIndex];
        if (!origPart || typeof origPart !== "object") continue;

        const tombstone = buildTombstone(
          occ.sourceId,
          preserveMarkers,
          workspaceRoot
        );
        const partRes = redactV1Part(
          origPart,
          occ,
          tombstone,
          workspaceRoot
        );

        if (partRes.changed) {
          if (!nextParts) {
            nextParts = currentMsg.parts.slice();
          }
          nextParts[occ.partIndex] = partRes.part;
          msgChanged = true;
          partsRedacted += 1;
          totalCharsRemoved += partRes.charsRemoved;
          charsBySource.set(
            occ.sourceId,
            (charsBySource.get(occ.sourceId) ?? 0) + partRes.charsRemoved
          );
          if (!evictedSourcesSet.has(occ.sourceId)) {
            evictedSourcesSet.add(occ.sourceId);
            evictedSourcesOrder.push(occ.sourceId);
          }
        }
      }

      if (msgChanged && nextParts) {
        if (!nextMessages) {
          nextMessages = messages.slice();
        }
        currentMsg = {
          ...origMsg,
          parts: nextParts,
        };
        nextMessages[msgIdx] = currentMsg as T;
        modifiedMessageIndices.add(msgIdx);
        if (msgIdx < firstMutatedIndex) {
          firstMutatedIndex = msgIdx;
        }
      }
      continue;
    }

    // V2Message
    let currentV2Msg: V2Message = origMsg as V2Message;
    let nextPartsArray: V2Part[] | null = null;
    const partsProperty: "parts" | "content" | null = Array.isArray(
      currentV2Msg.parts
    )
      ? "parts"
      : Array.isArray(currentV2Msg.content)
        ? "content"
        : null;
    let v2MsgChanged = false;

    for (const occ of msgOccurrences) {
      const tombstone = buildTombstone(
        occ.sourceId,
        preserveMarkers,
        workspaceRoot
      );

      if (occ.partIndex !== undefined && partsProperty) {
        const activeParts =
          nextPartsArray ?? (currentV2Msg[partsProperty] as V2Part[]);
        const targetPart = activeParts[occ.partIndex];
        if (!targetPart || typeof targetPart !== "object") {
          continue;
        }

        const partRes = redactV2Part(
          targetPart,
          occ,
          tombstone,
          workspaceRoot
        );
        if (partRes.changed) {
          if (!nextPartsArray) {
            nextPartsArray = (currentV2Msg[partsProperty] as V2Part[]).slice();
          }
          nextPartsArray[occ.partIndex] = partRes.part;
          v2MsgChanged = true;
          partsRedacted += 1;
          totalCharsRemoved += partRes.charsRemoved;
          charsBySource.set(
            occ.sourceId,
            (charsBySource.get(occ.sourceId) ?? 0) + partRes.charsRemoved
          );
          if (!evictedSourcesSet.has(occ.sourceId)) {
            evictedSourcesSet.add(occ.sourceId);
            evictedSourcesOrder.push(occ.sourceId);
          }
        }
      } else {
        // Message-level redaction
        const workingMsg =
          v2MsgChanged && nextPartsArray && partsProperty
            ? { ...currentV2Msg, [partsProperty]: nextPartsArray }
            : currentV2Msg;

        const msgRes = redactV2MessageLevel(
          workingMsg,
          occ,
          tombstone,
          workspaceRoot
        );
        if (msgRes.changed) {
          currentV2Msg = msgRes.msg;
          if (partsProperty && Array.isArray(currentV2Msg[partsProperty])) {
            nextPartsArray = currentV2Msg[partsProperty] as V2Part[];
          }
          v2MsgChanged = true;
          partsRedacted += 1;
          totalCharsRemoved += msgRes.charsRemoved;
          charsBySource.set(
            occ.sourceId,
            (charsBySource.get(occ.sourceId) ?? 0) + msgRes.charsRemoved
          );
          if (!evictedSourcesSet.has(occ.sourceId)) {
            evictedSourcesSet.add(occ.sourceId);
            evictedSourcesOrder.push(occ.sourceId);
          }
        }
      }
    }

    if (v2MsgChanged) {
      if (!nextMessages) {
        nextMessages = messages.slice();
      }
      const clonedV2: V2Message =
        nextPartsArray && partsProperty
          ? {
              ...currentV2Msg,
              [partsProperty]: nextPartsArray,
            }
          : currentV2Msg === origMsg
            ? { ...currentV2Msg }
            : currentV2Msg;

      nextMessages[msgIdx] = clonedV2 as T;
      modifiedMessageIndices.add(msgIdx);
      if (msgIdx < firstMutatedIndex) {
        firstMutatedIndex = msgIdx;
      }
    }
  }

  if (!nextMessages || modifiedMessageIndices.size === 0) {
    return {
      messages: messages as T[],
      stats: createEmptyStats(messageCount),
    };
  }

  // Update registry stats & emit privacy-safe telemetry logs
  if (registry && sessionID) {
    for (const [sourceId, charsSaved] of charsBySource.entries()) {
      registry.recordEvictionStats(
        sessionID,
        sourceId,
        charsSaved,
        workspaceRoot
      );
    }
  }

  if (logger && evictedSourcesOrder.length > 0) {
    const activeCount =
      registry && sessionID
        ? registry.getRejected(sessionID).length
        : rejectedSet.size;

    for (const sourceId of evictedSourcesOrder) {
      const charsSaved = charsBySource.get(sourceId) ?? 0;
      const rec =
        registry && sessionID
          ? registry.getRejectionRecord(sessionID, sourceId, workspaceRoot)
          : undefined;

      const eventPayload = {
        sessionID,
        sourceId,
        reason: rec?.reason,
        evictionSucceeded: true,
        charsRemoved: charsSaved,
        alreadyRejected: false,
        identificationFailed: false,
        activeRejectedCount: activeCount,
      };

      if (typeof logger.logEviction === "function") {
        logger.logEviction(eventPayload);
      } else if (typeof logger.logEvictionEvent === "function") {
        logger.logEvictionEvent(eventPayload);
      }
    }
  }

  const stats: EvictionStats = {
    evictedSources: evictedSourcesOrder,
    messagesModified: modifiedMessageIndices.size,
    partsRedacted,
    messagesInspected: messageCount,
    messagesCloned: modifiedMessageIndices.size,
    occurrencesEvicted: partsRedacted,
    charsRemoved: totalCharsRemoved,
    prefixPreservedUntilIndex: firstMutatedIndex,
  };

  return {
    messages: nextMessages,
    stats,
  };
}

/**
 * Applies prefix-preserving eviction to an OpenCode V1 `output` wrapper
 * (`{ messages: V1MessageWithParts[] }`) or `V1MessageWithParts[]` array in place.
 */
export function evictInPlaceForV1(
  target:
    | { messages: V1MessageWithParts[]; context?: string[] }
    | V1MessageWithParts[],
  options?: EvictMessagesOptions
): EvictionStats {
  if (Array.isArray(target)) {
    const { messages: nextMessages, stats } = evictRejectedFromMessages(
      target,
      options
    );
    if (nextMessages !== target) {
      for (let i = 0; i < nextMessages.length; i++) {
        if (target[i] !== nextMessages[i]) {
          target[i] = nextMessages[i];
        }
      }
    }
    return stats;
  }

  if (target && Array.isArray(target.messages)) {
    const { messages: nextMessages, stats } = evictRejectedFromMessages(
      target.messages,
      options
    );
    target.messages = nextMessages;
    return stats;
  }

  return createEmptyStats(0);
}

/**
 * Applies Turn-1 system instruction injection and prefix-preserving context
 * eviction to an OpenCode V2 `SessionContextEvent`.
 */
export function applyEvictionToContext(
  event: SessionContextEvent,
  options?: EvictMessagesOptions
): EvictionStats {
  const enabled = options?.config?.enabled ?? true;
  const msgCount = Array.isArray(event?.messages) ? event.messages.length : 0;

  if (!enabled || !event) {
    return createEmptyStats(msgCount);
  }

  // 1. Always ensure SYSTEM_INSTRUCTION is present at the end of event.system from Turn 1
  event.system = ensureSystemInstruction(
    event.system as string | Array<string | SystemPart> | undefined
  ) as SystemPart[] | string;

  // 2. Filter rejected sources from outgoing messages using copy-on-write
  if (!Array.isArray(event.messages) || event.messages.length === 0) {
    return createEmptyStats(0);
  }

  const effectiveSessionID =
    options?.sessionID ?? event.sessionID ?? event.sessionId;
  const { messages: nextMessages, stats } = evictRejectedFromMessages(
    event.messages,
    {
      ...options,
      sessionID: effectiveSessionID,
    }
  );

  event.messages = nextMessages;
  return stats;
}

/**
 * Redacts rejected sources from compaction payloads (`SessionCompactionEvent`,
 * V1 compaction output, or raw message arrays) so rejected content is never
 * summarized into compacted session history.
 */
export function evictForCompaction<
  T extends V2Message | V1MessageWithParts = V2Message,
>(
  eventOrMessages:
    | SessionCompactionEvent
    | {
        sessionID?: string;
        sessionId?: string;
        messages?: T[];
        transcript?: V2Message[];
        context?: string[];
      }
    | readonly T[],
  options?: EvictMessagesOptions
): {
  messages: T[];
  stats: EvictionStats;
} {
  if (Array.isArray(eventOrMessages)) {
    return evictRejectedFromMessages(eventOrMessages, options);
  }

  const event = eventOrMessages as {
    sessionID?: string;
    sessionId?: string;
    messages?: T[];
    transcript?: V2Message[];
    context?: string[];
  };
  const enabled = options?.config?.enabled ?? true;
  if (!enabled || !event) {
    return {
      messages: (event?.messages ?? []) as T[],
      stats: createEmptyStats(0),
    };
  }

  const effectiveSessionID =
    options?.sessionID ?? event.sessionID ?? event.sessionId;
  const effectiveOptions: EvictMessagesOptions = {
    ...options,
    sessionID: effectiveSessionID,
  };

  let primaryStats = createEmptyStats(0);
  let resultMessages: T[] = [];

  if (Array.isArray(event.messages)) {
    const res = evictRejectedFromMessages(event.messages, effectiveOptions);
    event.messages = res.messages;
    resultMessages = res.messages;
    primaryStats = res.stats;
  }

  if (Array.isArray(event.transcript)) {
    const res = evictRejectedFromMessages(event.transcript, effectiveOptions);
    event.transcript = res.messages;
    if (resultMessages.length === 0) {
      resultMessages = res.messages as unknown as T[];
      primaryStats = res.stats;
    }
  }

  // Also redact any <skill_content name="..."> envelopes inside string[] context arrays
  if (Array.isArray(event.context) && event.context.length > 0) {
    const rejectedSet = resolveRejectedSet(effectiveOptions);
    const preserveMarkers =
      effectiveOptions.preserveMarkers ??
      effectiveOptions.config?.preserveMarkers ??
      true;
    const workspaceRoot = effectiveOptions.workspaceRoot;

    if (rejectedSet.size > 0) {
      for (let i = 0; i < event.context.length; i++) {
        let entry = event.context[i];
        if (typeof entry !== "string" || !entry.includes("<skill")) {
          continue;
        }
        for (const sourceId of rejectedSet) {
          if (!sourceId.startsWith("skill:")) continue;
          const tombstone = buildTombstone(
            sourceId,
            preserveMarkers,
            workspaceRoot
          );
          const xmlRes = redactSkillXmlForTarget(
            entry,
            sourceId,
            tombstone,
            workspaceRoot
          );
          if (xmlRes.redactedCount > 0) {
            entry = xmlRes.text;
            event.context[i] = entry;
          }
        }
      }
    }
  }

  return {
    messages: resultMessages,
    stats: primaryStats,
  };
}
