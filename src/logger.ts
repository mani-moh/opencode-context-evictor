import fs from "node:fs";
import path from "node:path";
import type { ContextEvictorConfig, LogEntry } from "./types.js";

export type { LogEntry } from "./types.js";

/**
 * Input payload for Spec Section 13 structured eviction debug events.
 */
export interface EvictionLogEvent {
  sessionID?: string;
  /** Source identifier rejected (`skill:<id>` or `file:<path>`). */
  sourceId: string;
  /** Rejection reason provided by the model or command. */
  reason?: string;
  /** Whether the eviction or rejection operation succeeded. */
  evictionSucceeded: boolean;
  /** Number of content characters removed from outgoing context. */
  charsRemoved: number;
  /** Whether the source was already rejected in the session. */
  alreadyRejected: boolean;
  /** Whether source identification in the current session failed. */
  identificationFailed: boolean;
  /** Number of sources currently rejected in the session. */
  activeRejectedCount: number;
  /** Optional extra diagnostic metadata (automatically scrubbed by privacy guard). */
  details?: Record<string, unknown>;
}

/**
 * Privacy-safe logger interface for the Context Evictor plugin.
 */
export interface Logger {
  /** Whether debug logging is enabled. */
  readonly isDebugEnabled: boolean;
  /** Record a structured Section 13 eviction telemetry event when debug is enabled. */
  logEvictionEvent(event: EvictionLogEvent): void;
  /** Record a general debug log message with privacy-scrubbed metadata. */
  debug(event: string, details?: Record<string, unknown>): void;
  /** Record a warning message with privacy-scrubbed metadata. */
  warn(event: string, details?: Record<string, unknown>): void;
  /** Return a shallow copy of recorded in-memory log entries. */
  getEntries(): LogEntry[];
}

/**
 * Keys that may hold raw file/skill/tool content and must NEVER be logged.
 */
const FORBIDDEN_CONTENT_KEYS = new Set([
  "content",
  "rawcontent",
  "rejectedcontent",
  "fullcontent",
  "skillcontent",
  "filecontent",
  "body",
  "output",
  "result",
  "text",
  "payload",
  "messages",
  "transcript",
]);

/**
 * Recursively scrubs any fields that might contain raw skill/file/message content.
 */
export function sanitizeMetadata(
  input: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_CONTENT_KEYS.has(key.toLowerCase())) {
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      sanitized[key] = sanitizeMetadata(value as Record<string, unknown>);
    } else if (typeof value === "string" && value.length > 256) {
      // Truncate overly long arbitrary strings as an extra defense-in-depth guard
      sanitized[key] = `${value.slice(0, 256)}...[truncated]`;
    } else {
      sanitized[key] = value;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

/**
 * Creates a privacy-safe logger configured for the Context Evictor plugin.
 *
 * Per Specification Section 13:
 * - Logs only when `config.debug === true`.
 * - Records source ID, rejection reason, eviction success, chars removed,
 *   already-rejected status, identification failure, and active rejected count.
 * - NEVER logs full rejected content.
 */
export function createLogger(
  config: ContextEvictorConfig,
  entriesSink?: LogEntry[]
): Logger {
  const internalEntries: LogEntry[] = entriesSink ?? [];

  function writeEntry(entry: LogEntry): void {
    if (!config.debug) {
      return;
    }

    internalEntries.push(entry);

    if (config.logFile) {
      try {
        const dir = path.dirname(config.logFile);
        if (dir && dir !== "." && !fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.appendFileSync(config.logFile, `${JSON.stringify(entry)}\n`, "utf8");
      } catch {
        // Never allow logging I/O errors to disrupt session execution
      }
    }
  }

  return {
    get isDebugEnabled(): boolean {
      return Boolean(config.debug);
    },

    logEvictionEvent(event: EvictionLogEvent): void {
      if (!config.debug) {
        return;
      }

      const safeReason =
        typeof event.reason === "string"
          ? event.reason.slice(0, 256)
          : undefined;

      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: "debug",
        event: "context_evict",
        sessionID:
          typeof event.sessionID === "string" ? event.sessionID : undefined,
        sourceId: String(event.sourceId),
        reason: safeReason,
        evictionSucceeded: Boolean(event.evictionSucceeded),
        charsRemoved:
          typeof event.charsRemoved === "number" &&
          Number.isFinite(event.charsRemoved)
            ? Math.max(0, Math.floor(event.charsRemoved))
            : 0,
        alreadyRejected: Boolean(event.alreadyRejected),
        identificationFailed: Boolean(event.identificationFailed),
        activeRejectedCount:
          typeof event.activeRejectedCount === "number" &&
          Number.isFinite(event.activeRejectedCount)
            ? Math.max(0, Math.floor(event.activeRejectedCount))
            : 0,
      };

      const scrubbedDetails = sanitizeMetadata(event.details);
      if (scrubbedDetails) {
        entry.details = scrubbedDetails;
      }

      writeEntry(entry);
    },

    debug(event: string, details?: Record<string, unknown>): void {
      if (!config.debug) {
        return;
      }

      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: "debug",
        event,
      };

      const scrubbed = sanitizeMetadata(details);
      if (scrubbed) {
        if (typeof scrubbed.sessionID === "string") {
          entry.sessionID = scrubbed.sessionID;
        }
        if (typeof scrubbed.sourceId === "string") {
          entry.sourceId = scrubbed.sourceId;
        }
        if (typeof scrubbed.charsRemoved === "number") {
          entry.charsRemoved = scrubbed.charsRemoved;
        }
        entry.details = scrubbed;
      }

      writeEntry(entry);
    },

    warn(event: string, details?: Record<string, unknown>): void {
      if (!config.debug) {
        return;
      }

      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: "warn",
        event,
      };

      const scrubbed = sanitizeMetadata(details);
      if (scrubbed) {
        entry.details = scrubbed;
      }

      writeEntry(entry);
    },

    getEntries(): LogEntry[] {
      return [...internalEntries];
    },
  };
}
