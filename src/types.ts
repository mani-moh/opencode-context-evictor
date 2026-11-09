/**
 * Supported context source kinds that can be inspected and evicted.
 */
export type SourceKind = "skill" | "file";

/**
 * Canonical source identifier format (`skill:<id>` or `file:<path>`).
 */
export type SourceID = `skill:${string}` | `file:${string}`;

/**
 * Parsed and normalized source identifier.
 */
export interface ParsedSource {
  kind: SourceKind;
  target: string;
  raw: SourceID;
  normalizedTarget: string;
}

/**
 * Configuration options for the Context Evictor plugin.
 */
export interface ContextEvictorConfig {
  /** Enable or disable the plugin globally (default: true). */
  enabled: boolean;
  /** Enable privacy-safe debug telemetry logging (default: false). */
  debug: boolean;
  /** Keep compact tombstone markers in place of evicted content (default: true). */
  preserveMarkers: boolean;
  /** Optional path to append structured JSONL debug logs when debug is true. */
  logFile?: string;
}

/**
 * Session-scoped rejection record for an evicted source.
 */
export interface RejectionRecord {
  sourceId: SourceID;
  kind: SourceKind;
  target: string;
  reason: string;
  rejectedAt: number;
  evictionCount: number;
  evictedCount: number;
  lastCharsSaved: number;
  lastCharsRemoved: number;
}

/**
 * Structural occurrence of a tracked source located inside a message transcript.
 */
export interface TrackedSourceOccurrence {
  messageIndex: number;
  partIndex?: number;
  sourceId: SourceID;
  kind: SourceKind;
  target: string;
  callID?: string;
  currentLength: number;
  alreadyEvicted: boolean;
}

/**
 * Per-pass eviction statistics returned by the eviction engine.
 */
export interface EvictionStats {
  messagesInspected: number;
  messagesCloned: number;
  occurrencesEvicted: number;
  charsRemoved: number;
  prefixPreservedUntilIndex: number;
}

/**
 * Diagnostic summary of a session's eviction state.
 */
export interface SessionEvictionStatus {
  sessionID: string;
  activeCount: number;
  rejectedSources: RejectionRecord[];
  knownSources: SourceID[];
  totalCharsSavedLastPass: number;
  totalCharsRemoved: number;
}

/**
 * Structured telemetry entry for Spec Section 13 debug logging.
 */
export interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  sessionID?: string;
  sourceId?: string;
  reason?: string;
  evictionSucceeded?: boolean;
  charsRemoved?: number;
  alreadyRejected?: boolean;
  identificationFailed?: boolean;
  activeRejectedCount?: number;
  details?: Record<string, unknown>;
}

// ============================================================================
// OpenCode V2 Host Interfaces (@opencode/plugin >= 2.0.0)
// ============================================================================

export interface StorageAdapter {
  get<T = unknown>(key: string): Promise<T | undefined> | T | undefined;
  set<T = unknown>(key: string, value: T): Promise<void> | void;
  delete?(key: string): Promise<void> | void;
}

export type SystemPart =
  | string
  | {
      type?: string;
      text?: string;
      content?: string;
      [key: string]: unknown;
    };

export interface V2Part {
  type: string;
  text?: string;
  content?:
    | string
    | Array<{
        type: string;
        text?: string;
        [key: string]: unknown;
      }>;
  toolCallId?: string;
  toolCallID?: string;
  callID?: string;
  tool_use_id?: string;
  toolName?: string;
  tool?: string;
  name?: string;
  id?: string;
  skillId?: string;
  args?: Record<string, unknown>;
  input?: Record<string, unknown>;
  result?: unknown;
  output?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface V2Message {
  id?: string;
  role: "system" | "user" | "assistant" | "tool" | "skill" | string;
  content?: string | V2Part[];
  parts?: V2Part[];
  name?: string;
  id_skill?: string;
  skillId?: string;
  toolCallId?: string;
  toolCallID?: string;
  callID?: string;
  tool_use_id?: string;
  toolName?: string;
  [key: string]: unknown;
}

export interface SessionContextEvent {
  sessionID?: string;
  sessionId?: string;
  system?: SystemPart[] | string;
  messages: V2Message[];
  [key: string]: unknown;
}

export interface SessionCompactionEvent {
  sessionID?: string;
  sessionId?: string;
  messages?: V2Message[];
  transcript?: V2Message[];
  context?: string[];
  [key: string]: unknown;
}

export interface ToolExecuteBeforeEvent {
  sessionID?: string;
  sessionId?: string;
  tool: string;
  callID?: string;
  toolCallID?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  input?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ToolExecuteAfterEvent {
  sessionID?: string;
  sessionId?: string;
  tool: string;
  callID?: string;
  toolCallID?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  input?: Record<string, unknown>;
  output?: unknown;
  result?: unknown;
  [key: string]: unknown;
}

export interface ToolExecutionContext {
  sessionID?: string;
  sessionId?: string;
  callID?: string;
  messages?: V2Message[];
  [key: string]: unknown;
}

export interface ToolDefinition {
  name?: string;
  description: string;
  parameters?: Record<string, unknown>;
  args?: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ) => Promise<unknown> | unknown;
}

export interface CommandDefinition {
  name?: string;
  description: string;
  execute: (
    args: string | string[] | Record<string, unknown>,
    context?: ToolExecutionContext
  ) => Promise<unknown> | unknown;
}

export interface PluginContext {
  cwd?: string;
  configDir?: string;
  options?: Record<string, unknown>;
  config?: Record<string, unknown>;
  storage?: StorageAdapter;
  session?: {
    hook: (
      event: "context" | "compaction" | string,
      handler: (payload: any) => Promise<void> | void
    ) => void;
    [key: string]: unknown;
  };
  tool?:
    | {
        register?: (
          nameOrDef: string | ToolDefinition,
          def?: ToolDefinition
        ) => void;
        hook?: (
          event: "execute.before" | "execute.after" | string,
          handler: (payload: any) => Promise<void> | void
        ) => void;
        [key: string]: unknown;
      }
    | ((nameOrDef: string | ToolDefinition, def?: ToolDefinition) => void);
  command?:
    | {
        register?: (
          nameOrDef: string | CommandDefinition,
          def?: CommandDefinition
        ) => void;
        [key: string]: unknown;
      }
    | ((nameOrDef: string | CommandDefinition, def?: CommandDefinition) => void);
  [key: string]: unknown;
}

// ============================================================================
// OpenCode V1 Host Interfaces (@opencode-ai/plugin >= 1.0.0)
// ============================================================================

export interface V1Part {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type: "text" | "tool" | "skill" | string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface V1MessageWithParts {
  info: {
    id: string;
    sessionID: string;
    role: "user" | "assistant" | "system" | "tool" | string;
    [key: string]: unknown;
  };
  parts: V1Part[];
}

export interface V1PluginInput {
  directory?: string;
  worktree?: string;
  project?: Record<string, unknown>;
  client?: Record<string, unknown>;
  options?: Record<string, unknown>;
  storage?: StorageAdapter;
  [key: string]: unknown;
}

export interface V1Hooks {
  tool?: Record<string, ToolDefinition>;
  command?: Record<string, CommandDefinition>;
  "tool.execute.before"?: (
    input: {
      tool: string;
      sessionID: string;
      callID: string;
      args?: Record<string, unknown>;
    },
    output: { args: Record<string, unknown> }
  ) => Promise<void> | void;
  "tool.execute.after"?: (
    input: {
      tool: string;
      sessionID: string;
      callID: string;
      args?: Record<string, unknown>;
    },
    output: {
      title?: string;
      output: string;
      metadata?: Record<string, unknown>;
    }
  ) => Promise<void> | void;
  "experimental.chat.system.transform"?: (
    input: { sessionID?: string },
    output: { system: string[] }
  ) => Promise<void> | void;
  "experimental.chat.messages.transform"?: (
    input: { sessionID?: string },
    output: { messages: V1MessageWithParts[] }
  ) => Promise<void> | void;
  "experimental.session.compacting"?: (
    input: { sessionID: string },
    output: {
      context: string[];
      prompt?: string;
      messages?: V1MessageWithParts[];
    }
  ) => Promise<void> | void;
  [key: string]: unknown;
}
