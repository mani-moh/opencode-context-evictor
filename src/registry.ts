import {
  collectKnownSourcesFromMessages,
  extractSourceFromToolCall,
  parseAndValidateSourceId,
  parseSourceId,
} from "./tracker.js";
import type { Logger } from "./logger.js";
import type {
  RejectionRecord,
  SessionEvictionStatus,
  SourceID,
  StorageAdapter,
  V1MessageWithParts,
  V2Message,
} from "./types.js";

/**
 * Fallback session identifier used only if a host hook omits `sessionID`.
 */
export const DEFAULT_SESSION_ID = "default";

/**
 * Storage key prefix for session-scoped eviction metadata.
 */
export const STORAGE_KEY_PREFIX = "context-evictor:session:";

/**
 * Normalizes a session identifier, falling back to `"default"` if empty/undefined.
 */
export function normalizeSessionId(sessionID?: string): string {
  if (typeof sessionID !== "string") {
    return DEFAULT_SESSION_ID;
  }
  const trimmed = sessionID.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_SESSION_ID;
}

/**
 * Formats the storage key for a given `sessionID`.
 */
export function getSessionStorageKey(sessionID?: string): string {
  return `${STORAGE_KEY_PREFIX}${normalizeSessionId(sessionID)}`;
}

/**
 * In-memory per-session state.
 */
export interface SessionEvictionState {
  sessionID: string;
  rejected: Map<SourceID, RejectionRecord>;
  knownSources: Set<SourceID>;
  callIdToSource: Map<string, SourceID>;
  hydrated: boolean;
}

/**
 * Minimal serializable session metadata persisted via `StorageAdapter`.
 * NEVER contains raw context content.
 */
export interface PersistedSessionState {
  version: 1;
  sessionID: string;
  rejected: Array<{
    sourceId: SourceID;
    kind: "skill" | "file";
    target: string;
    reason: string;
    rejectedAt: number;
    evictionCount: number;
    lastCharsSaved: number;
  }>;
  knownSources: SourceID[];
  callIdToSource: Array<[string, SourceID]>;
}

export type RejectFailureCode =
  | "INVALID_SOURCE_ID"
  | "INVALID_REASON"
  | "UNKNOWN_SOURCE";

export interface RejectOptions {
  /**
   * When true (default), requires the source to have been loaded or seen in the current session.
   */
  requireKnown?: boolean;
  /**
   * Optional transcript messages to inspect when verifying provenance.
   */
  messages?: readonly unknown[];
  /**
   * Optional workspace root for normalizing file paths.
   */
  workspaceRoot?: string;
  /**
   * Optional timestamp override (mainly for deterministic testing).
   */
  now?: number;
}

export type RejectResult =
  | {
      ok: true;
      record: RejectionRecord;
      alreadyRejected: boolean;
    }
  | {
      ok: false;
      error: string;
      code: RejectFailureCode;
    };

export interface RestoreResult {
  restored: boolean;
  sourceId?: SourceID;
  record?: RejectionRecord;
  error?: string;
}

export interface RejectionRegistryOptions {
  storage?: StorageAdapter;
  workspaceRoot?: string;
  logger?: Logger;
}

function isStorageAdapter(
  value: RejectionRegistryOptions | StorageAdapter | undefined
): value is StorageAdapter {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as StorageAdapter).get === "function" &&
    typeof (value as StorageAdapter).set === "function"
  );
}

/**
 * Session-scoped registry managing rejected sources and provenance tracking.
 */
export class RejectionRegistry {
  private readonly sessions = new Map<string, SessionEvictionState>();
  private readonly storage?: StorageAdapter;
  private readonly defaultWorkspaceRoot?: string;
  private readonly logger?: Logger;

  constructor(
    optionsOrStorage?: RejectionRegistryOptions | StorageAdapter,
    workspaceRoot?: string
  ) {
    if (isStorageAdapter(optionsOrStorage)) {
      this.storage = optionsOrStorage;
      this.defaultWorkspaceRoot = workspaceRoot;
    } else if (optionsOrStorage && typeof optionsOrStorage === "object") {
      this.storage = optionsOrStorage.storage;
      this.defaultWorkspaceRoot =
        optionsOrStorage.workspaceRoot ?? workspaceRoot;
      this.logger = optionsOrStorage.logger;
    } else {
      this.defaultWorkspaceRoot = workspaceRoot;
    }
  }

  private resolveWorkspaceRoot(override?: string): string | undefined {
    return override ?? this.defaultWorkspaceRoot;
  }

  private getOrCreateSession(sessionID?: string): SessionEvictionState {
    const id = normalizeSessionId(sessionID);
    let state = this.sessions.get(id);
    if (!state) {
      state = {
        sessionID: id,
        rejected: new Map<SourceID, RejectionRecord>(),
        knownSources: new Set<SourceID>(),
        callIdToSource: new Map<string, SourceID>(),
        hydrated: false,
      };
      this.sessions.set(id, state);
    }
    return state;
  }

  /**
   * Safely persists minimal session metadata to `this.storage` without throwing
   * or ever writing raw context content.
   */
  private persistSession(state: SessionEvictionState): void {
    if (!this.storage) {
      return;
    }

    const payload: PersistedSessionState = {
      version: 1,
      sessionID: state.sessionID,
      rejected: Array.from(state.rejected.values()).map((rec) => ({
        sourceId: rec.sourceId,
        kind: rec.kind,
        target: rec.target,
        reason: rec.reason,
        rejectedAt: rec.rejectedAt,
        evictionCount: rec.evictionCount,
        lastCharsSaved: rec.lastCharsSaved,
      })),
      knownSources: Array.from(state.knownSources),
      callIdToSource: Array.from(state.callIdToSource.entries()),
    };

    const key = getSessionStorageKey(state.sessionID);
    try {
      const result = this.storage.set(key, payload);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err: unknown) => {
          this.logger?.warn("storage_persist_failed", {
            sessionID: state.sessionID,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      this.logger?.warn("storage_persist_failed", {
        sessionID: state.sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Hydrates session metadata from `StorageAdapter` if configured.
   * Safe against storage read errors or malformed persisted data.
   */
  async hydrateSession(sessionID: string): Promise<void> {
    const state = this.getOrCreateSession(sessionID);
    if (state.hydrated || !this.storage) {
      state.hydrated = true;
      return;
    }

    const key = getSessionStorageKey(state.sessionID);
    try {
      const raw = await this.storage.get<PersistedSessionState>(key);
      state.hydrated = true;
      if (!raw || typeof raw !== "object") {
        return;
      }

      if (Array.isArray(raw.knownSources)) {
        for (const src of raw.knownSources) {
          const parsed = parseSourceId(src, this.defaultWorkspaceRoot);
          if (parsed) {
            state.knownSources.add(parsed.raw);
          }
        }
      }

      if (Array.isArray(raw.callIdToSource)) {
        for (const entry of raw.callIdToSource) {
          if (
            Array.isArray(entry) &&
            typeof entry[0] === "string" &&
            entry[0].trim().length > 0 &&
            typeof entry[1] === "string"
          ) {
            const parsed = parseSourceId(entry[1], this.defaultWorkspaceRoot);
            if (parsed && !state.callIdToSource.has(entry[0])) {
              state.callIdToSource.set(entry[0], parsed.raw);
              state.knownSources.add(parsed.raw);
            }
          }
        }
      }

      if (Array.isArray(raw.rejected)) {
        for (const item of raw.rejected) {
          if (!item || typeof item !== "object") continue;
          const parsed = parseSourceId(item.sourceId, this.defaultWorkspaceRoot);
          if (!parsed) continue;

          state.knownSources.add(parsed.raw);
          if (!state.rejected.has(parsed.raw)) {
            const rawCount =
              typeof item.evictionCount === "number" &&
              Number.isFinite(item.evictionCount)
                ? Math.max(0, Math.floor(item.evictionCount))
                : 0;
            const rawSaved =
              typeof item.lastCharsSaved === "number" &&
              Number.isFinite(item.lastCharsSaved)
                ? Math.max(0, Math.floor(item.lastCharsSaved))
                : 0;

            state.rejected.set(parsed.raw, {
              sourceId: parsed.raw,
              kind: parsed.kind,
              target: parsed.target,
              reason:
                typeof item.reason === "string" && item.reason.trim().length > 0
                  ? item.reason.trim()
                  : "Rejected in session",
              rejectedAt:
                typeof item.rejectedAt === "number" &&
                Number.isFinite(item.rejectedAt)
                  ? item.rejectedAt
                  : Date.now(),
              evictionCount: rawCount,
              evictedCount: rawCount,
              lastCharsSaved: rawSaved,
              lastCharsRemoved: rawSaved,
            });
          }
        }
      }
    } catch (err) {
      state.hydrated = true;
      this.logger?.warn("storage_hydrate_failed", {
        sessionID: state.sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Proactively records a tool execution (`skill` or `read`) and maps `callID -> sourceId`.
   */
  recordToolExecution(
    sessionID: string,
    callID: string | undefined,
    toolName: string,
    args: unknown,
    workspaceRoot?: string
  ): SourceID | null {
    const root = this.resolveWorkspaceRoot(workspaceRoot);
    const extracted = extractSourceFromToolCall(toolName, args, root);
    if (!extracted) {
      return null;
    }

    const state = this.getOrCreateSession(sessionID);
    state.knownSources.add(extracted);
    if (typeof callID === "string" && callID.trim().length > 0) {
      state.callIdToSource.set(callID.trim(), extracted);
    }

    this.persistSession(state);
    return extracted;
  }

  /**
   * Directly marks a `SourceID` as known in the specified session.
   */
  recordKnownSource(
    sessionID: string,
    sourceId: SourceID | string,
    workspaceRoot?: string
  ): void {
    const root = this.resolveWorkspaceRoot(workspaceRoot);
    const parsed = parseSourceId(sourceId, root);
    if (!parsed) {
      return;
    }

    const state = this.getOrCreateSession(sessionID);
    if (!state.knownSources.has(parsed.raw)) {
      state.knownSources.add(parsed.raw);
      this.persistSession(state);
    }
  }

  /**
   * Scans `messages` for structural source occurrences and merges them into the
   * session's `knownSources` set.
   */
  syncKnownSourcesFromMessages(
    sessionID: string,
    messages: readonly unknown[],
    workspaceRoot?: string
  ): Set<SourceID> {
    const root = this.resolveWorkspaceRoot(workspaceRoot);
    const state = this.getOrCreateSession(sessionID);
    const discovered = collectKnownSourcesFromMessages(
      (Array.isArray(messages) ? messages : []) as ReadonlyArray<
        V2Message | V1MessageWithParts
      >,
      state.callIdToSource,
      root
    );

    let added = false;
    for (const srcId of discovered) {
      if (!state.knownSources.has(srcId)) {
        state.knownSources.add(srcId);
        added = true;
      }
    }

    if (added) {
      this.persistSession(state);
    }

    return new Set(state.knownSources);
  }

  /**
   * Checks whether `rawOrNormalizedSourceId` has been seen or loaded in `sessionID`.
   */
  isSourceKnown(
    sessionID: string,
    rawOrNormalizedSourceId: string,
    messages?: readonly unknown[],
    workspaceRoot?: string
  ): boolean {
    const root = this.resolveWorkspaceRoot(workspaceRoot);
    const parsed = parseSourceId(rawOrNormalizedSourceId, root);
    if (!parsed) {
      return false;
    }

    const state = this.getOrCreateSession(sessionID);
    if (
      state.knownSources.has(parsed.raw) ||
      state.rejected.has(parsed.raw)
    ) {
      return true;
    }

    for (const mapped of state.callIdToSource.values()) {
      if (mapped === parsed.raw) {
        state.knownSources.add(parsed.raw);
        return true;
      }
    }

    if (Array.isArray(messages) && messages.length > 0) {
      const discovered = collectKnownSourcesFromMessages(
        messages as ReadonlyArray<V2Message | V1MessageWithParts>,
        state.callIdToSource,
        root
      );
      if (discovered.size > 0) {
        let added = false;
        for (const src of discovered) {
          if (!state.knownSources.has(src)) {
            state.knownSources.add(src);
            added = true;
          }
        }
        if (added) {
          this.persistSession(state);
        }
      }
      if (discovered.has(parsed.raw)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Returns a read-only view of the session's `callID -> SourceID` map.
   */
  getCallIdMap(sessionID: string): ReadonlyMap<string, SourceID> {
    const state = this.getOrCreateSession(sessionID);
    return state.callIdToSource;
  }

  /**
   * Explicitly rejects a source in `sessionID`.
   *
   * - Validates `rawSourceId` (`skill:<id>` or `file:<path>`) and non-empty `reason`.
   * - Verifies provenance in `sessionID` (unless `options?.requireKnown === false`),
   *   failing safely with `UNKNOWN_SOURCE` if not found in the session.
   * - Idempotent on duplicate calls: preserves original `rejectedAt`, `reason`, and stats.
   */
  reject(
    sessionID: string,
    rawSourceId: string,
    reason: string,
    options?: RejectOptions
  ): RejectResult {
    const root = this.resolveWorkspaceRoot(options?.workspaceRoot);
    const validation = parseAndValidateSourceId(rawSourceId, root);
    if (!validation.valid) {
      return {
        ok: false,
        error: validation.error,
        code: "INVALID_SOURCE_ID",
      };
    }

    if (typeof reason !== "string" || reason.trim().length === 0) {
      return {
        ok: false,
        error: "Rejection reason must be a non-empty string.",
        code: "INVALID_REASON",
      };
    }

    const { parsed } = validation;
    const state = this.getOrCreateSession(sessionID);

    // Check idempotency first if already rejected in this session
    const existing = state.rejected.get(parsed.raw);
    if (existing) {
      return {
        ok: true,
        record: { ...existing },
        alreadyRejected: true,
      };
    }

    // Verify source is known in the current session when requireKnown !== false
    const requireKnown = options?.requireKnown !== false;
    if (
      requireKnown &&
      !this.isSourceKnown(sessionID, parsed.raw, options?.messages, root)
    ) {
      return {
        ok: false,
        error: `Cannot evict '${parsed.raw}': source was not found or loaded in the current session.`,
        code: "UNKNOWN_SOURCE",
      };
    }

    const record: RejectionRecord = {
      sourceId: parsed.raw,
      kind: parsed.kind,
      target: parsed.target,
      reason: reason.trim(),
      rejectedAt:
        typeof options?.now === "number" && Number.isFinite(options.now)
          ? options.now
          : Date.now(),
      evictionCount: 0,
      evictedCount: 0,
      lastCharsSaved: 0,
      lastCharsRemoved: 0,
    };

    state.knownSources.add(parsed.raw);
    state.rejected.set(parsed.raw, record);
    this.persistSession(state);

    return {
      ok: true,
      record: { ...record },
      alreadyRejected: false,
    };
  }

  /**
   * Updates eviction statistics for a rejected source after an eviction pass.
   */
  recordEvictionStats(
    sessionID: string,
    sourceId: SourceID | string,
    charsSaved: number,
    workspaceRoot?: string
  ): void {
    const root = this.resolveWorkspaceRoot(workspaceRoot);
    const parsed = parseSourceId(sourceId, root);
    if (!parsed) {
      return;
    }

    const state = this.getOrCreateSession(sessionID);
    const record = state.rejected.get(parsed.raw);
    if (!record) {
      return;
    }

    const safeChars =
      typeof charsSaved === "number" && Number.isFinite(charsSaved)
        ? Math.max(0, Math.floor(charsSaved))
        : 0;

    record.evictionCount += 1;
    record.evictedCount = record.evictionCount;
    record.lastCharsSaved = safeChars;
    record.lastCharsRemoved = safeChars;

    this.persistSession(state);
  }

  /**
   * Restores a previously rejected source in `sessionID` so future model turns
   * receive its full content again. Keeps the source in `knownSources`.
   */
  restore(
    sessionID: string,
    rawSourceId: string,
    workspaceRoot?: string
  ): RestoreResult {
    const root = this.resolveWorkspaceRoot(workspaceRoot);
    const validation = parseAndValidateSourceId(rawSourceId, root);
    if (!validation.valid) {
      return {
        restored: false,
        error: validation.error,
      };
    }

    const { parsed } = validation;
    const state = this.getOrCreateSession(sessionID);
    const existing = state.rejected.get(parsed.raw);
    if (!existing) {
      return {
        restored: false,
        sourceId: parsed.raw,
      };
    }

    state.rejected.delete(parsed.raw);
    state.knownSources.add(parsed.raw);
    this.persistSession(state);

    return {
      restored: true,
      sourceId: parsed.raw,
      record: { ...existing },
    };
  }

  /**
   * Clears all active rejections in `sessionID` while preserving `knownSources`
   * and `callIdToSource` provenance.
   */
  reset(sessionID: string): { clearedCount: number } {
    const state = this.getOrCreateSession(sessionID);
    const clearedCount = state.rejected.size;
    if (clearedCount > 0) {
      state.rejected.clear();
      this.persistSession(state);
    }
    return { clearedCount };
  }

  /**
   * Returns all active `RejectionRecord` entries for `sessionID`.
   */
  getRejected(sessionID: string): RejectionRecord[] {
    const state = this.getOrCreateSession(sessionID);
    return Array.from(state.rejected.values(), (rec) => ({ ...rec }));
  }

  /**
   * Returns a `Set<SourceID>` of all currently rejected source IDs in `sessionID`.
   */
  getRejectedIds(sessionID: string): Set<SourceID> {
    const state = this.getOrCreateSession(sessionID);
    return new Set(state.rejected.keys());
  }

  /**
   * Returns a read-only map of rejected sources for fast lookup during eviction passes.
   */
  getRejectedMap(sessionID: string): ReadonlyMap<SourceID, RejectionRecord> {
    const state = this.getOrCreateSession(sessionID);
    return state.rejected;
  }

  /**
   * Checks whether `rawOrNormalizedSourceId` is currently rejected in `sessionID`.
   */
  isRejected(
    sessionID: string,
    rawOrNormalizedSourceId: string,
    workspaceRoot?: string
  ): boolean {
    const root = this.resolveWorkspaceRoot(workspaceRoot);
    const parsed = parseSourceId(rawOrNormalizedSourceId, root);
    if (!parsed) {
      return false;
    }
    const state = this.getOrCreateSession(sessionID);
    return state.rejected.has(parsed.raw);
  }

  /**
   * Returns the `RejectionRecord` for a source if it is currently rejected in `sessionID`.
   */
  getRejectionRecord(
    sessionID: string,
    rawOrNormalizedSourceId: string,
    workspaceRoot?: string
  ): RejectionRecord | undefined {
    const root = this.resolveWorkspaceRoot(workspaceRoot);
    const parsed = parseSourceId(rawOrNormalizedSourceId, root);
    if (!parsed) {
      return undefined;
    }
    const state = this.getOrCreateSession(sessionID);
    const rec = state.rejected.get(parsed.raw);
    return rec ? { ...rec } : undefined;
  }

  /**
   * Returns a diagnostic summary of the session's eviction state.
   */
  getStatus(sessionID: string): SessionEvictionStatus {
    const state = this.getOrCreateSession(sessionID);
    const rejectedSources = Array.from(state.rejected.values(), (rec) => ({
      ...rec,
    }));
    const totalChars = rejectedSources.reduce(
      (sum, rec) => sum + rec.lastCharsSaved,
      0
    );

    return {
      sessionID: state.sessionID,
      activeCount: rejectedSources.length,
      rejectedSources,
      knownSources: Array.from(state.knownSources),
      totalCharsSavedLastPass: totalChars,
      totalCharsRemoved: totalChars,
    };
  }
}

/**
 * Factory function creating a new `RejectionRegistry`.
 */
export function createRejectionRegistry(
  optionsOrStorage?: RejectionRegistryOptions | StorageAdapter,
  workspaceRoot?: string
): RejectionRegistry {
  return new RejectionRegistry(optionsOrStorage, workspaceRoot);
}
