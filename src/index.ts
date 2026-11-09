import { loadConfig } from "./config.js";
import {
  applyEvictionToContext,
  evictForCompaction,
  evictInPlaceForV1,
  injectIntoV1SystemArray,
} from "./evictor.js";
import { createLogger } from "./logger.js";
import {
  createRejectionRegistry,
  DEFAULT_SESSION_ID,
  normalizeSessionId,
} from "./registry.js";
import {
  createPluginTools,
  createSlashCommandDefinition,
  executeSlashCommand,
} from "./tools.js";
import type {
  CommandDefinition,
  ContextEvictorConfig,
  PluginContext,
  SessionCompactionEvent,
  SessionContextEvent,
  ToolDefinition,
  V1Hooks,
  V1MessageWithParts,
  V1PluginInput,
  V2Message,
} from "./types.js";

export * from "./types.js";
export * from "./config.js";
export * from "./logger.js";
export * from "./tracker.js";
export * from "./registry.js";
export * from "./evictor.js";
export * from "./tools.js";

export interface ContextEvictorPluginInstance {
  (
    ctxOrInput?: PluginContext | V1PluginInput
  ): Promise<V1Hooks | void> | V1Hooks | void;
  id: "context-evictor";
  name: "context-evictor";
  setup: (ctx: PluginContext) => Promise<void> | void;
  server: (input?: V1PluginInput) => Promise<V1Hooks> | V1Hooks;
}

function isV2PluginContext(
  ctxOrInput: unknown
): ctxOrInput is PluginContext {
  if (!ctxOrInput || typeof ctxOrInput !== "object") {
    return false;
  }
  const candidate = ctxOrInput as Record<string, unknown>;
  if (
    candidate.session &&
    typeof (candidate.session as Record<string, unknown>).hook === "function"
  ) {
    return true;
  }
  if (
    candidate.tool &&
    (typeof candidate.tool === "function" ||
      typeof (candidate.tool as Record<string, unknown>).hook === "function" ||
      typeof (candidate.tool as Record<string, unknown>).register ===
        "function" ||
      typeof (candidate.tool as Record<string, unknown>).transform ===
        "function")
  ) {
    return true;
  }
  return false;
}

function registerToolOnV2Host(
  toolHost: PluginContext["tool"],
  name: string,
  def: ToolDefinition
): void {
  if (!toolHost) {
    return;
  }
  const namedDef: ToolDefinition = { ...def, name };

  if (typeof toolHost === "function") {
    try {
      toolHost(name, namedDef);
    } catch {
      toolHost(namedDef);
    }
    return;
  }

  if (typeof toolHost === "object" && typeof toolHost.register === "function") {
    try {
      toolHost.register(name, namedDef);
    } catch {
      toolHost.register(namedDef);
    }
  }
}

function registerCommandOnV2Host(
  ctx: PluginContext,
  cmdDef: CommandDefinition
): void {
  const commandName = cmdDef.name ?? "context-evictor";
  const targets = [ctx.command, ctx.commands];

  for (const host of targets) {
    if (!host) continue;
    if (typeof host === "function") {
      try {
        host(commandName, cmdDef);
      } catch {
        host(cmdDef);
      }
      return;
    }
    if (typeof host === "object" && typeof host.register === "function") {
      try {
        host.register(commandName, cmdDef);
      } catch {
        host.register(cmdDef);
      }
      return;
    }
  }
}

/**
 * Factory creating a dual OpenCode V2 (`2.0.32`) and V1 (`1.18.29+`) Context Evictor plugin.
 */
export function createContextEvictorPlugin(
  runtimeOptions?: Partial<ContextEvictorConfig>
): ContextEvictorPluginInstance {
  const setup = async (ctx: PluginContext): Promise<void> => {
    const workspaceRoot =
      typeof ctx?.cwd === "string" && ctx.cwd.trim().length > 0
        ? ctx.cwd
        : typeof ctx?.directory === "string" && ctx.directory.trim().length > 0
          ? ctx.directory
          : typeof ctx?.worktree === "string" && ctx.worktree.trim().length > 0
            ? ctx.worktree
            : process.cwd();

    const mergedOptions: Record<string, unknown> = {
      ...(ctx?.config && typeof ctx.config === "object" ? ctx.config : {}),
      ...(ctx?.options && typeof ctx.options === "object" ? ctx.options : {}),
      ...(runtimeOptions && typeof runtimeOptions === "object"
        ? runtimeOptions
        : {}),
    };

    const config = loadConfig(mergedOptions, workspaceRoot, ctx?.configDir);
    const logger = createLogger(config);
    const registry = createRejectionRegistry({
      storage: ctx?.storage,
      workspaceRoot,
      logger,
    });

    const lastSeenMessages = new Map<
      string,
      ReadonlyArray<V2Message | V1MessageWithParts>
    >();

    const tools = createPluginTools({
      registry,
      config,
      logger,
      workspaceRoot,
      getLastSeenMessages: (sid) => lastSeenMessages.get(normalizeSessionId(sid)),
    });

    const slashCommand = createSlashCommandDefinition({
      registry,
      config,
      logger,
      workspaceRoot,
      getLastSeenMessages: (sid) => lastSeenMessages.get(normalizeSessionId(sid)),
    });

    // 1. Register tool execution provenance hooks (`execute.before` / `execute.after`)
    if (
      ctx?.tool &&
      typeof ctx.tool === "object" &&
      typeof ctx.tool.hook === "function"
    ) {
      const handleToolExecutionHook = async (
        event: Record<string, unknown>
      ): Promise<void> => {
        if (!event || typeof event !== "object") {
          return;
        }
        const sessionID = normalizeSessionId(
          (typeof event.sessionID === "string" ? event.sessionID : undefined) ??
            (typeof event.sessionId === "string" ? event.sessionId : undefined)
        );
        await registry.hydrateSession(sessionID);

        const callID =
          (typeof event.callID === "string" ? event.callID : undefined) ??
          (typeof event.toolCallID === "string"
            ? event.toolCallID
            : undefined) ??
          (typeof event.toolCallId === "string" ? event.toolCallId : undefined);
        const toolName =
          (typeof event.tool === "string" ? event.tool : undefined) ??
          (typeof event.toolName === "string" ? event.toolName : undefined) ??
          (typeof event.name === "string" ? event.name : undefined);
        const args = event.args ?? event.input;

        if (toolName) {
          registry.recordToolExecution(
            sessionID,
            callID,
            toolName,
            args,
            workspaceRoot
          );
        }
      };

      ctx.tool.hook("execute.before", handleToolExecutionHook);
      ctx.tool.hook("execute.after", handleToolExecutionHook);
    }

    // 2. Register session context & compaction hooks
    if (ctx?.session && typeof ctx.session.hook === "function") {
      ctx.session.hook("context", async (event: SessionContextEvent) => {
        if (!event || typeof event !== "object") {
          return;
        }
        const sessionID = normalizeSessionId(
          event.sessionID ?? event.sessionId
        );
        await registry.hydrateSession(sessionID);

        if (Array.isArray(event.messages)) {
          lastSeenMessages.set(sessionID, event.messages);
          registry.syncKnownSourcesFromMessages(
            sessionID,
            event.messages,
            workspaceRoot
          );
        }

        if (!config.enabled) {
          return;
        }

        applyEvictionToContext(event, {
          registry,
          sessionID,
          config,
          workspaceRoot,
          logger,
        });
      });

      ctx.session.hook("compaction", async (event: SessionCompactionEvent) => {
        if (!event || typeof event !== "object") {
          return;
        }
        const sessionID = normalizeSessionId(
          event.sessionID ?? event.sessionId
        );
        await registry.hydrateSession(sessionID);

        if (!config.enabled) {
          return;
        }

        evictForCompaction(event, {
          registry,
          sessionID,
          config,
          workspaceRoot,
          logger,
        });
      });
    }

    // 3. Register model-callable tools via `ctx.tool.register` and/or `ctx.tool.transform`
    for (const [name, def] of Object.entries(tools)) {
      registerToolOnV2Host(ctx?.tool, name, def);
    }

    if (
      ctx?.tool &&
      typeof ctx.tool === "object" &&
      typeof ctx.tool.transform === "function"
    ) {
      ctx.tool.transform((existingTools: Record<string, ToolDefinition>) => {
        const target =
          existingTools && typeof existingTools === "object"
            ? existingTools
            : {};
        for (const [name, def] of Object.entries(tools)) {
          target[name] = { ...def, name };
        }
        return target;
      });
    }

    // 4. Register `/context-evictor` slash command
    registerCommandOnV2Host(ctx, slashCommand);
  };

  const server = async (input?: V1PluginInput): Promise<V1Hooks> => {
    const workspaceRoot =
      typeof input?.directory === "string" && input.directory.trim().length > 0
        ? input.directory
        : typeof input?.worktree === "string" &&
            input.worktree.trim().length > 0
          ? input.worktree
          : process.cwd();

    const mergedOptions: Record<string, unknown> = {
      ...(input?.options && typeof input.options === "object"
        ? input.options
        : {}),
      ...(runtimeOptions && typeof runtimeOptions === "object"
        ? runtimeOptions
        : {}),
    };

    const config = loadConfig(mergedOptions, workspaceRoot);
    const logger = createLogger(config);
    const registry = createRejectionRegistry({
      storage: input?.storage,
      workspaceRoot,
      logger,
    });

    const lastSeenMessages = new Map<
      string,
      ReadonlyArray<V2Message | V1MessageWithParts>
    >();

    const tools = createPluginTools({
      registry,
      config,
      logger,
      workspaceRoot,
      getLastSeenMessages: (sid) => lastSeenMessages.get(normalizeSessionId(sid)),
    });

    const slashCommand = createSlashCommandDefinition({
      registry,
      config,
      logger,
      workspaceRoot,
      getLastSeenMessages: (sid) => lastSeenMessages.get(normalizeSessionId(sid)),
    });

    const hooks: V1Hooks = {
      tool: tools,
      command: {
        "context-evictor": slashCommand,
      },

      async "tool.execute.before"(hookInput, hookOutput) {
        const sessionID = normalizeSessionId(hookInput?.sessionID);
        await registry.hydrateSession(sessionID);
        const args = hookOutput?.args ?? hookInput?.args;
        if (hookInput?.tool) {
          registry.recordToolExecution(
            sessionID,
            hookInput.callID,
            hookInput.tool,
            args,
            workspaceRoot
          );
        }
      },

      async "tool.execute.after"(hookInput, hookOutput) {
        const sessionID = normalizeSessionId(hookInput?.sessionID);
        await registry.hydrateSession(sessionID);
        const args = hookInput?.args ?? hookOutput?.metadata;
        if (hookInput?.tool) {
          registry.recordToolExecution(
            sessionID,
            hookInput.callID,
            hookInput.tool,
            args,
            workspaceRoot
          );
        }
      },

      async "experimental.chat.system.transform"(_hookInput, hookOutput) {
        if (!config.enabled || !hookOutput || !Array.isArray(hookOutput.system)) {
          return;
        }
        injectIntoV1SystemArray(hookOutput.system);
      },

      async "experimental.chat.messages.transform"(hookInput, hookOutput) {
        if (!hookOutput || !Array.isArray(hookOutput.messages)) {
          return;
        }

        const firstSessionID =
          hookInput?.sessionID ??
          hookOutput.messages[0]?.info?.sessionID ??
          DEFAULT_SESSION_ID;
        const sessionID = normalizeSessionId(firstSessionID);
        await registry.hydrateSession(sessionID);

        lastSeenMessages.set(sessionID, hookOutput.messages);
        registry.syncKnownSourcesFromMessages(
          sessionID,
          hookOutput.messages,
          workspaceRoot
        );

        if (!config.enabled) {
          return;
        }

        evictInPlaceForV1(hookOutput, {
          registry,
          sessionID,
          config,
          workspaceRoot,
          logger,
        });
      },

      async "experimental.session.compacting"(hookInput, hookOutput) {
        if (!hookOutput) {
          return;
        }
        const sessionID = normalizeSessionId(hookInput?.sessionID);
        await registry.hydrateSession(sessionID);

        if (!config.enabled) {
          return;
        }

        evictForCompaction(hookOutput, {
          registry,
          sessionID,
          config,
          workspaceRoot,
          logger,
        });
      },

      async "command.execute.before"(
        cmdInput: {
          command?: string;
          name?: string;
          args?: string | string[];
          sessionID?: string;
        },
        cmdOutput?: { output?: string; handled?: boolean }
      ) {
        const rawName = (cmdInput?.command ?? cmdInput?.name ?? "")
          .trim()
          .replace(/^\//, "")
          .toLowerCase();
        if (rawName !== "context-evictor") {
          return;
        }

        const sessionID = normalizeSessionId(cmdInput?.sessionID);
        const text = await executeSlashCommand(cmdInput?.args, {
          registry,
          config,
          logger,
          workspaceRoot,
          sessionID,
          getLastSeenMessages: (sid) =>
            lastSeenMessages.get(normalizeSessionId(sid)),
        });

        if (cmdOutput && typeof cmdOutput === "object") {
          cmdOutput.output = text;
          cmdOutput.handled = true;
        }
      },
    };

    return hooks;
  };

  const callablePlugin = ((
    ctxOrInput?: PluginContext | V1PluginInput
  ): Promise<V1Hooks | void> | V1Hooks | void => {
    if (isV2PluginContext(ctxOrInput)) {
      return setup(ctxOrInput);
    }
    return server(ctxOrInput as V1PluginInput | undefined);
  }) as ContextEvictorPluginInstance;

  Object.defineProperty(callablePlugin, "name", {
    value: "context-evictor",
    writable: false,
    enumerable: true,
    configurable: true,
  });
  callablePlugin.id = "context-evictor";
  callablePlugin.setup = setup;
  callablePlugin.server = server;

  return callablePlugin;
}

/**
 * Default OpenCode V2 / V1 Context Evictor plugin instance.
 */
export const contextEvictorPlugin: ContextEvictorPluginInstance =
  createContextEvictorPlugin();

/**
 * Named PascalCase alias for compatibility with root `index.js` and V1/V2 plugin loaders.
 */
export const ContextEvictorPlugin: ContextEvictorPluginInstance =
  contextEvictorPlugin;

/**
 * Named OpenCode V2 `setup(ctx)` entrypoint.
 */
export const setup = contextEvictorPlugin.setup;

/**
 * Named OpenCode V1 `server(input)` entrypoint.
 */
export const server = contextEvictorPlugin.server;

export default contextEvictorPlugin;
