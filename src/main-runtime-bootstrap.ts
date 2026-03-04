import { CommandExecutor } from "./commands/command-executor.js";
import { QueueManager } from "./queue/queue-manager.js";
import { DirectiveManager } from "./directives/directive-manager.js";
import { ChatManager } from "./chat/chat-manager.js";
import { ConsoleManager } from "./console/console-manager.js";
import { getBotToken } from "./auth/bot-token.js";
import { runBackendCall, startRuntime } from "./runtime.js";
import { nowIso } from "./lib/text.js";
import { trimEnv } from "./lib/env-parse.js";
import {
  VISUAL_SETUP_CHECK_INTERVAL_MS,
  type VisualSetupCheckState,
} from "./main-helpers.js";
import type {
  RuntimeContext,
  OpenClawManagerLike,
  MintManagerLike,
} from "./runtime-context.js";
import type { RuntimeConfig, KthxConfig } from "./types/config.js";
import type { IpcPaths } from "./types/ipc.js";
import type { MemoryStore } from "./memory/store.js";
import type { StateSqliteStore } from "./state/sqlite-state.js";
import type { PlannerTriggerOptions } from "./main-auto-credit-planner.js";
import type { BridgeClients } from "./main-bridge-clients.js";

type CommandExecutorTrpcShape = {
  agent: Record<
    string,
    { mutate: (input: Record<string, unknown>) => Promise<unknown> }
  >;
};

type DirectiveManagerTrpcShape = {
  realtime?: {
    ackDirective?: {
      mutate(input: unknown): Promise<unknown>;
    };
  };
} | null;

type MintManagerTrpcShape = {
  realtime: {
    mintBotToken: {
      mutate(input: unknown): Promise<unknown>;
    };
  };
} | null;

type HeartbeatTrpcShape = {
  agent?: {
    heartbeat?: {
      mutate(input: unknown): Promise<unknown>;
    };
  };
};

export type BootstrapRuntimeManagersDeps = {
  config: RuntimeConfig;
  kthxConfig: KthxConfig;
  ipcPaths: IpcPaths;
  stateDb: StateSqliteStore;
  trpc: unknown;
  ctx: RuntimeContext;
  memory: Pick<
    MemoryStore,
    "recordWrite" | "buildContext" | "refreshTemporalContext"
  >;
  hasInteractivePty: boolean;
  bootstrapToken: string | null;
  callAgentChatBridge: BridgeClients["callAgentChatBridge"];
  callAgentUploadChunk: BridgeClients["callAgentUploadChunk"];
  openClawManager: OpenClawManagerLike;
  mintManager: MintManagerLike;
  notifyOwnerImageGeneratorSetupIfNeeded: () => Promise<VisualSetupCheckState>;
  touchWake: (path: string) => Promise<void>;
  triggerAutoCreditPlanner: ((opts: PlannerTriggerOptions) => void) | null;
  triggerAutoPostingPlanner: ((opts: PlannerTriggerOptions) => void) | null;
};

export const bootstrapRuntimeManagersAndStart = async (
  deps: BootstrapRuntimeManagersDeps,
): Promise<void> => {
  const commandExecutor = new CommandExecutor({
    config: {
      imageGenerateCmd:
        deps.config.imageGenerateCmd ?? deps.ctx.kthxConfig.image.commandTemplate,
      fileGenerateCmd:
        deps.config.fileGenerateCmd ?? deps.ctx.kthxConfig.image.fileCommandTemplate,
      imageGenerateTimeoutMs: deps.config.imageGenerateTimeoutMs,
    },
    ipcPaths: {
      inboxDir: deps.ipcPaths.inboxDir,
      processedDir: deps.ipcPaths.processedDir,
      generatedDir: deps.ipcPaths.generatedDir,
      queueStatePath: deps.ipcPaths.queueStatePath,
      resultsPath: deps.ipcPaths.resultsPath,
      pendingDir: deps.ipcPaths.pendingDir,
    },
    memory: {
      recordWrite: (p: unknown) => deps.memory.recordWrite(p),
      buildContext: (request) => deps.memory.buildContext(request),
    },
    stateDb: deps.stateDb,
    trpc: deps.trpc as CommandExecutorTrpcShape,
    commandSeal: deps.ctx.commandSeal,
    controlKey: deps.ctx.misc.controlKey,
    queue: deps.ctx.queue,
    callAgentChatBridge: deps.callAgentChatBridge,
    callAgentUploadChunk: deps.callAgentUploadChunk,
    runOpenClawPrompt: async (input: { prompt: string; purpose: string }) => {
      return deps.openClawManager.prompt(input.prompt, {
        purpose: input.purpose,
      });
    },
    promotePendingDirectives: async (input) => {
      if (!deps.ctx.directiveManager) {
        return {
          scanned: 0,
          promoted: 0,
          skippedPermissionDenied: 0,
          skippedTerminal: 0,
          skippedAlreadySeen: 0,
          skippedQueued: 0,
          limit: Math.max(1, Math.min(100, input.limit)),
        };
      }
      return deps.ctx.directiveManager.promoteFromPending({
        limit: input.limit,
        retryPermissionDenied: input.retryPermissionDenied,
        ...(typeof input.bypassCooldown === "boolean"
          ? { bypassCooldown: input.bypassCooldown }
          : {}),
        ...(typeof input.source === "string" && input.source.trim().length > 0
          ? { source: input.source.trim() }
          : {}),
      });
    },
  });

  const queueManager = new QueueManager({
    config: {
      terminalTriggerOnly: deps.config.terminalTriggerOnly,
      queueRunnerConcurrency: deps.config.queueRunnerConcurrency,
    },
    ipcPaths: {
      queueStatePath: deps.ipcPaths.queueStatePath,
      inboxDir: deps.ipcPaths.inboxDir,
      wakePath: deps.ipcPaths.wakePath,
    },
    kthxQueueConfig: () => ({
      minSpacingSeconds: deps.kthxConfig.queue.minSpacingSeconds,
      maxSpacingSeconds: deps.kthxConfig.queue.maxSpacingSeconds,
      llmScheduleMinItems: deps.kthxConfig.queue.llmScheduleMinItems,
    }),
    memory: { recordWrite: (p: unknown) => deps.memory.recordWrite(p) },
    queue: deps.ctx.queue,
    processCommandFile: async (inboxFile: string) => {
      return commandExecutor.processCommandFile(inboxFile);
    },
    runMemoryCheckpoint: async (opts) => {
      await deps.memory
        .refreshTemporalContext({
          force: opts.force,
          allowAgentCompression: opts.allowAgentCompression,
        })
        .catch(() => {});
    },
  });
  deps.ctx.queueManager = queueManager;

  const directiveManager = new DirectiveManager({
    config: { terminalTriggerOnly: deps.config.terminalTriggerOnly },
    ipcPaths: {
      inboxDir: deps.ipcPaths.inboxDir,
      wakePath: deps.ipcPaths.wakePath,
      pendingDir: deps.ipcPaths.pendingDir,
      currentDirectivePath: deps.ipcPaths.currentDirectivePath,
      resultsPath: deps.ipcPaths.resultsPath,
    },
    memory: { recordWrite: (p: unknown) => deps.memory.recordWrite(p) },
    trpc: deps.trpc as DirectiveManagerTrpcShape,
    commandSeal: deps.ctx.commandSeal,
    directive: deps.ctx.directive,
    misc: { controlKey: deps.ctx.misc.controlKey },
    ensureDirectiveInQueue: async (opts) => {
      await queueManager.enqueue(opts);
    },
    planQueueWithOpenClaw: async (_opts) => {
      return null;
    },
    touchWake: deps.touchWake,
  });
  deps.ctx.directiveManager = directiveManager;

  const triggerStartupAutoPlanners = (): void => {
    deps.triggerAutoCreditPlanner?.({ trigger: "runtime_startup" });
    deps.triggerAutoPostingPlanner?.({ trigger: "runtime_startup" });
  };

  const chatManager = new ChatManager({
    config: {
      chatRuntimeEnabled: deps.config.chatRuntimeEnabled,
      chatRuntimePollMs: deps.config.chatRuntimePollMs,
      chatRuntimeReadChunkBytes: deps.config.chatRuntimeReadChunkBytes,
      chatRuntimeSeenMessageLimit: deps.config.chatRuntimeSeenMessageLimit,
      chatRuntimeReplyMaxChars: deps.config.chatRuntimeReplyMaxChars,
      chatRuntimeOpenClawInputMaxChars: deps.config.chatRuntimeOpenClawInputMaxChars,
      chatRuntimeUseOpenClaw: deps.config.chatRuntimeUseOpenClaw,
      chatRuntimeReplayOnStart: deps.config.chatRuntimeReplayOnStart,
      chatRuntimeChannelRequireMention: deps.config.chatRuntimeChannelRequireMention,
      chatRuntimeMentionNames: deps.config.chatRuntimeMentionNames,
      chatRuntimeTextStreamEnabled: deps.config.chatRuntimeTextStreamEnabled,
      chatRuntimeTextStreamNativeEnabled: deps.config.chatRuntimeTextStreamNativeEnabled,
      chatRuntimeTextStreamNativeOnly: deps.config.chatRuntimeTextStreamNativeOnly,
      chatRuntimeTextStreamStepChars: deps.config.chatRuntimeTextStreamStepChars,
      chatRuntimeTextStreamStepMs: deps.config.chatRuntimeTextStreamStepMs,
      chatRuntimeTextStreamUpdateMinMs: deps.config.chatRuntimeTextStreamUpdateMinMs,
      chatRuntimeStaleReplyMaxAgeMs: deps.config.chatRuntimeStaleReplyMaxAgeMs,
      chatRuntimeStaleReplyMaxAgeImportantMs:
        deps.config.chatRuntimeStaleReplyMaxAgeImportantMs,
    },
    ipcPaths: {
      chatInboxPath: deps.ipcPaths.chatInboxPath,
      chatRuntimeStatePath: deps.ipcPaths.chatRuntimeStatePath,
    },
    memory: {
      recordWrite: (p: unknown) => deps.memory.recordWrite(p),
      buildContext: (request) => deps.memory.buildContext(request),
    },
    chat: deps.ctx.chat,
    callAgentChatBridge: deps.callAgentChatBridge,
    runOpenClawPrompt: async (opts) => {
      return deps.openClawManager.prompt(opts.prompt, {
        purpose: opts.purpose,
        onTextDelta: opts.onTextDelta ?? null,
      });
    },
    resolveOpenClawAgentName: () => deps.openClawManager.resolveAgentName(),
    runMemoryCheckpoint: async (opts) => {
      await deps.memory
        .refreshTemporalContext({
          force: opts.force,
          allowAgentCompression: opts.allowAgentCompression,
        })
        .catch(() => {});
    },
  });
  deps.ctx.chatManager = chatManager;

  const consoleManager = new ConsoleManager({
    ctx: deps.ctx,
    hasInteractivePty: deps.hasInteractivePty,
    ensureSocketBotToken: async (reason: string) => {
      await deps.mintManager.attemptMint(reason).catch(() => {});
      return getBotToken();
    },
    sendHeartbeat: async () => {
      await runBackendCall(
        "agent.heartbeat.mutate",
        () => {
          const heartbeatMutator = (deps.trpc as HeartbeatTrpcShape).agent?.heartbeat?.mutate;
          if (!heartbeatMutator) return Promise.resolve(null);
          return heartbeatMutator({});
        },
        deps.ctx,
      );
    },
  });
  deps.ctx.consoleManager = consoleManager;

  await deps.memory.recordWrite({
    type: "runtime_command_seal_initialized",
    at: nowIso(),
    runtimeSessionId: deps.ctx.commandSeal.runtimeCommandSessionId,
  });

  if (!deps.bootstrapToken) {
    await deps.memory.recordWrite({
      type: "runtime_initial_mint_attempt",
      at: nowIso(),
      reason: "no_bootstrap_token",
    });
    await deps.mintManager.attemptMint("runtime_boot").catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      void deps.memory.recordWrite({
        type: "runtime_initial_mint_failed",
        at: nowIso(),
        error: message,
      });
    });
  }

  const visualSetupEnforcementEnabled =
    (trimEnv("MG_AGENT_ENFORCE_VISUAL_SETUP") ?? "1") !== "0";
  let startupAutoPlannersTriggered = false;
  const runStartupAutoPlannersOnce = (reason: string): void => {
    if (startupAutoPlannersTriggered) return;
    startupAutoPlannersTriggered = true;
    triggerStartupAutoPlanners();
    void deps.memory
      .recordWrite({
        type: "runtime_startup_auto_planners_triggered",
        at: nowIso(),
        reason,
      })
      .catch(() => {});
  };

  if (visualSetupEnforcementEnabled) {
    const initialVisualSetupState =
      await deps.notifyOwnerImageGeneratorSetupIfNeeded().catch(
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          void deps.memory.recordWrite({
            type: "image_generator_setup_owner_notify_failed",
            at: nowIso(),
            error: message,
          });
          return null;
        },
      );

    if (initialVisualSetupState?.ready) {
      runStartupAutoPlannersOnce("visual_setup_ready");
    } else {
      void deps.memory
        .recordWrite({
          type: "visual_setup_pending_runtime_startup",
          at: nowIso(),
          visualSetupReady: false,
          notificationState:
            initialVisualSetupState?.notificationState ?? "profile_unavailable",
          setupGaps:
            initialVisualSetupState?.setupGaps ?? ["agent profile unavailable"],
        })
        .catch(() => {});
    }

    setInterval(() => {
      void deps.notifyOwnerImageGeneratorSetupIfNeeded()
        .then((state) => {
          if (state.ready) {
            runStartupAutoPlannersOnce("visual_setup_ready_after_reminder");
          }
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          void deps.memory.recordWrite({
            type: "image_generator_setup_owner_notify_failed",
            at: nowIso(),
            error: message,
          });
        });
    }, VISUAL_SETUP_CHECK_INTERVAL_MS);
  } else {
    runStartupAutoPlannersOnce("visual_setup_enforcement_disabled");
  }

  await startRuntime({
    ctx: deps.ctx,
    hasInteractivePty: deps.hasInteractivePty,
  });
};
