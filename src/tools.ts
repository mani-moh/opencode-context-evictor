import { DEFAULT_SESSION_ID, normalizeSessionId, type RejectionRegistry } from "./registry.js";
import type { Logger } from "./logger.js";
import type {
  CommandDefinition,
  ContextEvictorConfig,
  SessionEvictionStatus,
  ToolDefinition,
  ToolExecutionContext,
  V1MessageWithParts,
  V2Message,
} from "./types.js";

export interface PluginToolsOptions {
  registry: RejectionRegistry;
  config: ContextEvictorConfig;
  logger?: Logger;
  workspaceRoot?: string;
  getLastSeenMessages?: (
    sessionID: string
  ) => ReadonlyArray<V2Message | V1MessageWithParts> | undefined;
}

export interface PluginToolsMap {
  context_evict: ToolDefinition;
  context_restore: ToolDefinition;
  context_evict_status: ToolDefinition;
  context_status: ToolDefinition;
  context_reset: ToolDefinition;
  [key: string]: ToolDefinition;
}

function resolveSessionID(
  toolCtx?: ToolExecutionContext,
  args?: Record<string, unknown>
): string {
  const candidate =
    toolCtx?.sessionID ??
    toolCtx?.sessionId ??
    (typeof args?.sessionID === "string" ? args.sessionID : undefined) ??
    (typeof args?.sessionId === "string" ? args.sessionId : undefined) ??
    DEFAULT_SESSION_ID;
  return normalizeSessionId(candidate);
}

/**
 * Formats a human-readable diagnostic status summary for the given session.
 */
export function formatSessionStatus(
  status: SessionEvictionStatus,
  config?: Pick<ContextEvictorConfig, "enabled" | "preserveMarkers">
): string {
  const lines: string[] = [];
  const enabledFlag = config?.enabled !== false ? "enabled" : "disabled";

  lines.push(
    `[Context Evictor Status — session: ${status.sessionID} (${enabledFlag})]`
  );
  lines.push(`Active evicted sources: ${status.activeCount}`);
  lines.push(
    `Total chars saved (last pass): ${status.totalCharsSavedLastPass}`
  );

  if (status.rejectedSources.length > 0) {
    lines.push("Evicted sources:");
    for (const rec of status.rejectedSources) {
      lines.push(
        `  - ${rec.sourceId} (reason: "${rec.reason}", passes: ${rec.evictionCount}, chars saved: ${rec.lastCharsSaved})`
      );
    }
  } else {
    lines.push("Evicted sources: (none)");
  }

  if (status.knownSources.length > 0) {
    lines.push(`Known loaded sources (${status.knownSources.length}):`);
    for (const src of status.knownSources) {
      const marker = status.rejectedSources.some((r) => r.sourceId === src)
        ? " [evicted]"
        : " [active]";
      lines.push(`  - ${src}${marker}`);
    }
  } else {
    lines.push("Known loaded sources: (none)");
  }

  return lines.join("\n");
}

const CONTEXT_EVICT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    source_id: {
      type: "string",
      description:
        'Canonical identifier of the loaded context source to evict, in the form "skill:<id>" (e.g. "skill:database-optimization") or "file:<path>" (e.g. "file:src/config/database.ts").',
    },
    reason: {
      type: "string",
      description:
        "Brief explanation of why this inspected context source is irrelevant to the current task.",
    },
  },
  required: ["source_id", "reason"],
  additionalProperties: false,
};

const CONTEXT_RESTORE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    source_id: {
      type: "string",
      description:
        'Canonical identifier of the previously evicted context source to restore ("skill:<id>" or "file:<path>").',
    },
  },
  required: ["source_id"],
  additionalProperties: false,
};

const CONTEXT_STATUS_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["status", "reset"],
      description:
        'Optional action: "status" (default) to inspect evicted sources, or "reset" to clear all evictions and restore all sources in the current session.',
    },
  },
  additionalProperties: false,
};

const CONTEXT_RESET_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/**
 * Constructs the model-callable tools for Context Evictor, compatible with
 * both OpenCode V2 (`ctx.tool.transform` / `ctx.tool.register`) and OpenCode V1 (`hooks.tool`).
 */
export function createPluginTools(options: PluginToolsOptions): PluginToolsMap {
  const { registry, config, logger, workspaceRoot, getLastSeenMessages } =
    options;

  const contextEvictTool: ToolDefinition = {
    name: "context_evict",
    description:
      "Immediately evict an irrelevant loaded context source (skill:<id> or file:<path>) using context_evict so its full payload is replaced with a compact tombstone on subsequent model requests in this session. Call context_evict ONLY when you have inspected a loaded skill or file and determined that it is irrelevant to the current task. Do not evict information merely because you have not used it yet, and do not evict uncertain or potentially useful information.",
    parameters: CONTEXT_EVICT_SCHEMA,
    inputSchema: CONTEXT_EVICT_SCHEMA,
    args: {
      source_id: {
        type: "string",
        required: true,
        description:
          'Canonical source identifier to evict ("skill:<id>" or "file:<path>").',
      },
      reason: {
        type: "string",
        required: true,
        description:
          "Brief explanation of why the source is irrelevant to the current task.",
      },
    },
    async execute(
      args: Record<string, unknown>,
      toolCtx?: ToolExecutionContext
    ): Promise<string> {
      try {
        if (!config.enabled) {
          return "[context_evict] Context Evictor is currently disabled.";
        }

        const sessionID = resolveSessionID(toolCtx, args);
        await registry.hydrateSession(sessionID);

        const rawSourceId =
          typeof args?.source_id === "string"
            ? args.source_id
            : typeof args?.sourceId === "string"
              ? args.sourceId
              : "";
        const rawReason = typeof args?.reason === "string" ? args.reason : "";
        const messages =
          toolCtx?.messages ?? getLastSeenMessages?.(sessionID);

        const result = registry.reject(sessionID, rawSourceId, rawReason, {
          requireKnown: true,
          messages,
          workspaceRoot,
        });

        const activeRejectedCount = registry.getStatus(sessionID).activeCount;

        if (!result.ok) {
          logger?.logRejection({
            sessionID,
            sourceId: String(rawSourceId),
            reason: String(rawReason),
            evictionSucceeded: false,
            charsRemoved: 0,
            alreadyRejected: false,
            identificationFailed: true,
            activeRejectedCount,
            errorCode: result.code,
          });
          return `[context_evict] Failed to evict "${rawSourceId}": ${result.error}`;
        }

        logger?.logRejection({
          sessionID,
          sourceId: result.record.sourceId,
          reason: result.record.reason,
          evictionSucceeded: true,
          charsRemoved: result.record.lastCharsSaved,
          alreadyRejected: result.alreadyRejected,
          identificationFailed: false,
          activeRejectedCount,
        });

        if (result.alreadyRejected) {
          return `Source "${result.record.sourceId}" is already marked as evicted in this session.`;
        }

        return `Evicted "${result.record.sourceId}" from subsequent model requests in this session. Reason: ${result.record.reason}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `[context_evict] Failed to evict source safely: ${msg}`;
      }
    },
  };

  const contextRestoreTool: ToolDefinition = {
    name: "context_restore",
    description:
      "Restore a previously evicted context source (skill:<id> or file:<path>) in the current session so its original content is included again on subsequent model requests.",
    parameters: CONTEXT_RESTORE_SCHEMA,
    inputSchema: CONTEXT_RESTORE_SCHEMA,
    args: {
      source_id: {
        type: "string",
        required: true,
        description:
          'Canonical source identifier to restore ("skill:<id>" or "file:<path>").',
      },
    },
    async execute(
      args: Record<string, unknown>,
      toolCtx?: ToolExecutionContext
    ): Promise<string> {
      try {
        const sessionID = resolveSessionID(toolCtx, args);
        await registry.hydrateSession(sessionID);

        const rawSourceId =
          typeof args?.source_id === "string"
            ? args.source_id
            : typeof args?.sourceId === "string"
              ? args.sourceId
              : "";

        const res = registry.restore(sessionID, rawSourceId, workspaceRoot);
        const activeRejectedCount = registry.getStatus(sessionID).activeCount;

        logger?.logRestore({
          sessionID,
          sourceId: res.sourceId ?? String(rawSourceId),
          restored: res.restored,
          activeRejectedCount,
        });

        if (res.error) {
          return `[context_restore] Failed to restore "${rawSourceId}": ${res.error}`;
        }

        if (res.restored) {
          return `Restored "${res.sourceId}" for subsequent model requests in this session.`;
        }

        return `Source "${res.sourceId ?? rawSourceId}" is not currently evicted in this session.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `[context_restore] Failed to restore source safely: ${msg}`;
      }
    },
  };

  const executeStatusOrReset = async (
    args: Record<string, unknown>,
    toolCtx?: ToolExecutionContext
  ): Promise<string> => {
    try {
      const sessionID = resolveSessionID(toolCtx, args);
      await registry.hydrateSession(sessionID);

      if (args?.action === "reset") {
        const { clearedCount } = registry.reset(sessionID);
        logger?.logReset({ sessionID, clearedCount });
        return `Cleared ${clearedCount} evicted source(s) in session "${sessionID}". All rejected sources have been restored.`;
      }

      const status = registry.getStatus(sessionID);
      return formatSessionStatus(status, config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `[context_evict_status] Failed to read status safely: ${msg}`;
    }
  };

  const contextEvictStatusTool: ToolDefinition = {
    name: "context_evict_status",
    description:
      "Inspect or reset rejected context sources for the current session.",
    parameters: CONTEXT_STATUS_SCHEMA,
    inputSchema: CONTEXT_STATUS_SCHEMA,
    args: {
      action: {
        type: "string",
        required: false,
        description:
          'Optional action: "status" (default) or "reset" to restore all evicted sources.',
      },
    },
    execute: executeStatusOrReset,
  };

  const contextStatusAliasTool: ToolDefinition = {
    name: "context_status",
    description:
      "Inspect or reset rejected context sources for the current session.",
    parameters: CONTEXT_STATUS_SCHEMA,
    inputSchema: CONTEXT_STATUS_SCHEMA,
    args: {
      action: {
        type: "string",
        required: false,
        description:
          'Optional action: "status" (default) or "reset" to restore all evicted sources.',
      },
    },
    execute: executeStatusOrReset,
  };

  const contextResetTool: ToolDefinition = {
    name: "context_reset",
    description:
      "Clear all context evictions for the current session so all previously rejected sources are restored.",
    parameters: CONTEXT_RESET_SCHEMA,
    inputSchema: CONTEXT_RESET_SCHEMA,
    args: {},
    async execute(
      args: Record<string, unknown>,
      toolCtx?: ToolExecutionContext
    ): Promise<string> {
      try {
        const sessionID = resolveSessionID(toolCtx, args);
        await registry.hydrateSession(sessionID);

        const { clearedCount } = registry.reset(sessionID);
        logger?.logReset({ sessionID, clearedCount });
        return `Cleared ${clearedCount} evicted source(s) in session "${sessionID}". All rejected sources have been restored.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `[context_reset] Failed to reset session evictions safely: ${msg}`;
      }
    },
  };

  return {
    context_evict: contextEvictTool,
    context_restore: contextRestoreTool,
    context_evict_status: contextEvictStatusTool,
    context_status: contextStatusAliasTool,
    context_reset: contextResetTool,
  };
}

export interface SlashCommandExecutionOptions extends PluginToolsOptions {
  sessionID?: string;
  messages?: ReadonlyArray<V2Message | V1MessageWithParts>;
}

function normalizeCommandArgs(
  rawArgs: string | string[] | Record<string, unknown> | undefined
): string[] {
  if (typeof rawArgs === "string") {
    const cleaned = rawArgs
      .trim()
      .replace(/^\/?context-evictor\b/i, "")
      .trim();
    return cleaned.length > 0 ? cleaned.split(/\s+/) : [];
  }

  if (Array.isArray(rawArgs)) {
    const tokens = rawArgs
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
    if (tokens[0] && /^\/?context-evictor$/i.test(tokens[0])) {
      return tokens.slice(1);
    }
    return tokens;
  }

  if (rawArgs && typeof rawArgs === "object") {
    if (typeof rawArgs.command === "string" || typeof rawArgs.args === "string") {
      const str = String(rawArgs.args ?? rawArgs.command ?? "");
      return normalizeCommandArgs(str);
    }
    if (Array.isArray(rawArgs.args)) {
      return normalizeCommandArgs(rawArgs.args as string[]);
    }
    const action =
      typeof rawArgs.subcommand === "string"
        ? rawArgs.subcommand
        : typeof rawArgs.action === "string"
          ? rawArgs.action
          : undefined;
    const sourceId =
      typeof rawArgs.source_id === "string"
        ? rawArgs.source_id
        : typeof rawArgs.sourceId === "string"
          ? rawArgs.sourceId
          : undefined;
    const reason =
      typeof rawArgs.reason === "string" ? rawArgs.reason : undefined;
    const parts: string[] = [];
    if (action) parts.push(action);
    if (sourceId) parts.push(sourceId);
    if (reason) parts.push(reason);
    return parts;
  }

  return [];
}

/**
 * Executes the `/context-evictor` slash command (`status`, `restore <source_id>`,
 * `reset`, `evict <source_id> [reason...]`).
 */
export async function executeSlashCommand(
  rawArgs: string | string[] | Record<string, unknown> | undefined,
  options: SlashCommandExecutionOptions
): Promise<string> {
  const { registry, config, logger, workspaceRoot, getLastSeenMessages } =
    options;
  const sessionID = normalizeSessionId(options.sessionID);
  await registry.hydrateSession(sessionID);

  const tokens = normalizeCommandArgs(rawArgs);
  const subcommand = (tokens[0] ?? "status").toLowerCase();

  if (subcommand === "status") {
    return formatSessionStatus(registry.getStatus(sessionID), config);
  }

  if (subcommand === "reset") {
    const { clearedCount } = registry.reset(sessionID);
    logger?.logReset({ sessionID, clearedCount });
    return `Cleared ${clearedCount} evicted source(s) in session "${sessionID}". All rejected sources have been restored.`;
  }

  if (subcommand === "restore") {
    const targetSourceId = tokens[1] ?? "";
    if (!targetSourceId) {
      return "Usage: /context-evictor restore <source_id>";
    }

    const res = registry.restore(sessionID, targetSourceId, workspaceRoot);
    logger?.logRestore({
      sessionID,
      sourceId: res.sourceId ?? targetSourceId,
      restored: res.restored,
      activeRejectedCount: registry.getStatus(sessionID).activeCount,
    });

    if (res.error) {
      return `Failed to restore "${targetSourceId}": ${res.error}`;
    }
    if (res.restored) {
      return `Restored "${res.sourceId}" for subsequent model requests in session "${sessionID}".`;
    }
    return `Source "${res.sourceId ?? targetSourceId}" is not currently evicted in session "${sessionID}".`;
  }

  if (subcommand === "evict") {
    const targetSourceId = tokens[1] ?? "";
    if (!targetSourceId) {
      return "Usage: /context-evictor evict <source_id> [reason...]";
    }
    const reason =
      tokens.slice(2).join(" ").trim() ||
      "Manually evicted via /context-evictor command";
    const messages = options.messages ?? getLastSeenMessages?.(sessionID);
    const result = registry.reject(sessionID, targetSourceId, reason, {
      requireKnown: true,
      messages,
      workspaceRoot,
    });
    const activeRejectedCount = registry.getStatus(sessionID).activeCount;

    if (!result.ok) {
      logger?.logRejection({
        sessionID,
        sourceId: targetSourceId,
        reason,
        evictionSucceeded: false,
        charsRemoved: 0,
        alreadyRejected: false,
        identificationFailed: true,
        activeRejectedCount,
        errorCode: result.code,
      });
      return `Failed to evict "${targetSourceId}": ${result.error}`;
    }

    logger?.logRejection({
      sessionID,
      sourceId: result.record.sourceId,
      reason: result.record.reason,
      evictionSucceeded: true,
      charsRemoved: result.record.lastCharsSaved,
      alreadyRejected: result.alreadyRejected,
      identificationFailed: false,
      activeRejectedCount,
    });

    if (result.alreadyRejected) {
      return `Source "${result.record.sourceId}" is already marked as evicted in session "${sessionID}".`;
    }
    return `Evicted "${result.record.sourceId}" from subsequent model requests in session "${sessionID}". Reason: ${result.record.reason}`;
  }

  return "Usage: /context-evictor [status | restore <source_id> | reset]";
}

/**
 * Creates a `CommandDefinition` for registering `/context-evictor` in OpenCode hosts.
 */
export function createSlashCommandDefinition(
  options: PluginToolsOptions
): CommandDefinition {
  return {
    name: "context-evictor",
    description:
      "Inspect, restore, or reset evicted context sources in the current session (/context-evictor [status | restore <source_id> | reset]).",
    async execute(
      args: string | string[] | Record<string, unknown>,
      context?: ToolExecutionContext
    ): Promise<string> {
      const sessionID = resolveSessionID(
        context,
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : undefined
      );
      return executeSlashCommand(args, {
        ...options,
        sessionID,
        messages: context?.messages,
      });
    },
  };
}
