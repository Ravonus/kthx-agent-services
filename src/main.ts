/**
 * Main entry point for the agent runtime microservice.
 *
 * Ported from agent-runtime.mjs lines 3808-3955, 22340-22503.
 * Handles CLI parsing, dotenv loading, config creation, MemoryStore init,
 * IPC setup, WS client creation, RuntimeContext assembly, manager bootstrap,
 * and delegation to startRuntime().
 */

import fs from "node:fs/promises";
import path from "node:path";

import { loadDotEnv } from "./config/dotenv.js";
import { createRuntimeConfig } from "./config/runtime.js";
import { loadOrInitKthxConfig, normalizeKthxConfig } from "./config/kthx.js";
import { MemoryStore } from "./memory/store.js";
import { createStateSqliteStoreFromEnv } from "./state/sqlite-state.js";
import { createIpcPaths, initIpc, resetExecutionArtifactsOnStart } from "./ipc/ipc-paths.js";
import { createRealtimeClient } from "./ws/realtime-client.js";
import { createRuntimeHashCollector } from "./lib/hash.js";
import { RuntimeContext } from "./runtime-context.js";
import { runBackendCall } from "./runtime.js";
import { trimEnv } from "./lib/env-parse.js";
import { isRecord } from "./lib/guards.js";
import { nowIso } from "./lib/text.js";
import {
  clearBotTokenState,
  getBotToken,
  setBotTokenState,
  notifySupervisorFatal,
} from "./auth/bot-token.js";
import { AuthManager } from "./auth/auth-manager.js";
import { MintManager } from "./mint/mint-manager.js";
import { GrantManager } from "./grants/grant-manager.js";
import { EventsManager } from "./ipc/events-manager.js";
import {
  parseGrantCandidatesFromPermissionState,
  type GrantState,
} from "./grants/grant-state.js";
import { OpenClawManager } from "./openclaw/openclaw-manager.js";
import {
  probeOpenClawBinary,
  resolveOpenClawBinary,
} from "./openclaw/openclaw-binary.js";
import { ChatManager } from "./chat/chat-manager.js";
import {
  markWsActivity as markWsActivityFn,
  writeDebugSnapshot,
} from "./debug/ws-state.js";
import { getRuntimeAttestation } from "./lib/crypto.js";
import type { KthxConfig } from "./types/config.js";
import type { AnyRouter } from "@trpc/server";
import {
  AGENT_KTHX_GUIDE_PATH,
  parseCli,
  parseSupervisorPid,
  printHelp,
  resolveChatApiBaseUrl,
  touchWake,
  type VisualSetupCheckState,
} from "./main-helpers.js";
import {
  notifyOwnerImageGeneratorSetupIfNeeded as _notifyOwnerVisualSetup,
} from "./main-visual-setup.js";
import { createBridgeClients } from "./main-bridge-clients.js";
import {
  createAutoCreditPlanner,
  type PlannerTriggerOptions,
} from "./main-auto-credit-planner.js";
import { createAutoPostingPlanner } from "./main-auto-posting-planner.js";
import { setupEnvelopeAndSubscription } from "./main-envelope-subscription.js";
import { bootstrapAgentAuth } from "./main-auth-bootstrap.js";
import { bootstrapRuntimeManagersAndStart } from "./main-runtime-bootstrap.js";

// ---------------------------------------------------------------------------
// Fatal handler
// ---------------------------------------------------------------------------

let fatalExitInProgress = false;

const handleFatalExit = async (
  source: string,
  error: unknown,
): Promise<void> => {
  if (fatalExitInProgress) return;
  fatalExitInProgress = true;
  const message = error instanceof Error ? error.message : String(error);
  const stack =
    error instanceof Error && typeof error.stack === "string"
      ? error.stack
      : null;
  notifySupervisorFatal(
    stack !== null
      ? { source, message, stack }
      : { source, message },
  );
  try {
    process.stderr.write(
      `[agent-runtime] fatal(${source}): ${message}\n`,
    );
    if (stack) process.stderr.write(`${stack}\n`);
  } catch {
    // ignore stderr failures during fatal exit
  }
  process.exit(1);
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  await loadDotEnv();
  const cli = parseCli();
  if (cli.cmd === "help") {
    printHelp();
    return;
  }

  const hasInteractivePty = Boolean(
    process.stdin.isTTY && process.stdout.isTTY,
  );
  const requirePty =
    (trimEnv("MG_AGENT_RUNTIME_REQUIRE_PTY") ?? "0") === "1" ||
    (trimEnv("MG_AGENT_SUPERVISOR_REQUIRE_PTY") ?? "0") === "1";
  if (requirePty && !hasInteractivePty) {
    console.error(
      "[agent-runtime] Interactive PTY required (REQUIRE_PTY is enabled).",
    );
    process.exitCode = 2;
    return;
  }

  // -- Bootstrap token
  const bootstrapToken = await getBotToken();
  if (bootstrapToken) {
    await setBotTokenState({
      token: bootstrapToken,
      expiresAt: trimEnv("MG_BOT_SESSION_EXPIRES_AT") ?? null,
    });
  }

  // -- Config
  const config = createRuntimeConfig();
  const chatApiBaseUrl = resolveChatApiBaseUrl(config.realtimeWsUrl);
  const agentGuideSourceUrl = `${chatApiBaseUrl}${AGENT_KTHX_GUIDE_PATH}`;
  const agentGuideLocalPath = path.resolve(process.cwd(), "AGENT-KTHX.md");
  console.log(`[agent-runtime] Agent guide source: ${agentGuideSourceUrl}`);
  console.log(`[agent-runtime] Agent guide local target: ${agentGuideLocalPath}`);
  console.log(
    `[agent-runtime] Fetch/update command: curl -fsSL "${agentGuideSourceUrl}" -o "${agentGuideLocalPath}"`,
  );
  const supervisorPid = parseSupervisorPid(trimEnv("MG_AGENT_SUPERVISOR_PID"));
  const supervisorConnectionId =
    trimEnv("MG_REALTIME_CONNECTION_ID")?.trim() ?? null;
  const {
    agentKey,
    getAgentKeyBox,
    refreshAgentKeyBoxFromLocalSources,
  } = await bootstrapAgentAuth({
    config: {
      stateDir: config.stateDir,
      realtimeWsUrl: config.realtimeWsUrl,
    },
    supervisorPid,
    supervisorConnectionId,
    agentKey: trimEnv("MG_AGENT_KEY"),
  });
  const collectRuntimeHashes = createRuntimeHashCollector({
    runtimeFilePath: config.runtimeFilePath,
    rootDir: config.runtimeRootDir,
    maxFiles: config.runtimeHashMaxFiles,
    extensions: config.runtimeHashExtensions,
  });

  // -- KthxConfig
  const kthxConfigInfo = await loadOrInitKthxConfig({
    configPath: config.kthxConfigPath,
    homeDir: config.agentHomeDir,
  }).catch(() => null);
  const kthxConfig: KthxConfig = isRecord(kthxConfigInfo?.config)
    ? (kthxConfigInfo!.config as KthxConfig)
    : normalizeKthxConfig({}, config.agentHomeDir);
  const openClawBinaryResolution = resolveOpenClawBinary({
    configuredBinPath: kthxConfig.openclaw.binPath,
  });
  const openClawProbeCheckedAtMs = Date.now();
  const openClawProbeResult = kthxConfig.openclaw.enabled
    ? await probeOpenClawBinary(
        openClawBinaryResolution,
        Math.min(15_000, Math.max(5_000, kthxConfig.openclaw.timeoutMs)),
      )
    : null;

  // -- MemoryStore
  const stateDb = createStateSqliteStoreFromEnv(config.stateDir);
  const memory = new MemoryStore({
    stateDir: config.stateDir,
    rotateBytes: config.rotateBytes,
    tailMaxBytes: config.tailMaxBytes,
    tailMaxLines: config.tailMaxLines,
    stateDb,
  });
  await memory.init();
  await memory.recordWrite({
    type: "runtime_paths",
    at: nowIso(),
    agentHomeDir: config.agentHomeDir,
    stateDir: config.stateDir,
    kthxConfigPath: config.kthxConfigPath,
  });
  await memory.recordWrite({
    type: "openclaw_binary_probe",
    at: nowIso(),
    enabled: kthxConfig.openclaw.enabled,
    command: openClawBinaryResolution.command,
    resolvedPath: openClawBinaryResolution.resolvedPath,
    source: openClawBinaryResolution.source,
    warning: openClawBinaryResolution.warning,
    probeOk: openClawProbeResult?.ok ?? null,
    probeCode: openClawProbeResult?.code ?? null,
    probeVersion: openClawProbeResult?.version ?? null,
    probeError: openClawProbeResult?.error ?? null,
    probeStdoutPreview:
      typeof openClawProbeResult?.stdout === "string"
        ? openClawProbeResult.stdout.slice(0, 180)
        : null,
    probeStderrPreview:
      typeof openClawProbeResult?.stderr === "string"
        ? openClawProbeResult.stderr.slice(0, 180)
        : null,
  });
  if (kthxConfig.openclaw.enabled) {
    if (openClawProbeResult?.ok) {
      const versionText =
        typeof openClawProbeResult.version === "string" &&
          openClawProbeResult.version.trim().length > 0
          ? ` (${openClawProbeResult.version.trim()})`
          : "";
      console.log(
        `[agent-runtime] OpenClaw binary ready: ${openClawBinaryResolution.command} [${openClawBinaryResolution.source}]${versionText}`,
      );
    } else {
      const probeError =
        openClawProbeResult?.error ??
        (typeof openClawProbeResult?.code === "number"
          ? `exit_code_${openClawProbeResult.code}`
          : "unknown_error");
      console.warn(
        `[agent-runtime] OpenClaw binary check failed: ${openClawBinaryResolution.command} [${openClawBinaryResolution.source}] (${probeError})`,
      );
      if (openClawBinaryResolution.warning) {
        console.warn(
          `[agent-runtime] OpenClaw binary resolution warning: ${openClawBinaryResolution.warning}`,
        );
      }
    }
  }

  // -- IPC
  const ipcPaths = createIpcPaths(config.stateDir);
  await initIpc(ipcPaths);
  if (config.executionStateResetOnStart) {
    const resetSummary = await resetExecutionArtifactsOnStart(ipcPaths);
    await memory.recordWrite({
      type: "execution_state_reset_on_start",
      at: nowIso(),
      ...resetSummary,
    });
  }
  if (config.eventsResetOnStart) {
    const stat = await fs.stat(ipcPaths.eventsPath).catch(() => null);
    if (stat && stat.size > 0) {
      const archiveName = `${new Date()
        .toISOString()
        .replaceAll(":", "-")}__events.jsonl`;
      const archivePath = path.join(ipcPaths.eventsHistoryDir, archiveName);
      await fs
        .rename(ipcPaths.eventsPath, archivePath)
        .catch(async () => {
          await fs.copyFile(ipcPaths.eventsPath, archivePath).catch(() => {});
          await fs.rm(ipcPaths.eventsPath, { force: true }).catch(() => {});
        });
      await fs.writeFile(ipcPaths.eventsPath, "", "utf8").catch(() => {});
    }
  }

  // -- WS Client
  const { wsClient, trpc } = createRealtimeClient<AnyRouter>({
    baseWsUrl: config.realtimeWsUrl,
    connectionId: config.connectionId,
    clientKeepAliveMs: config.heartbeatIntervalMs,
    getBotToken,
    getAgentKeyBox: async () => {
      await refreshAgentKeyBoxFromLocalSources("ws_connection_params", {
        allowPersisted: true,
      });
      return getAgentKeyBox();
    },
    getRuntimeIntegrity: async () => {
      const hashes = await collectRuntimeHashes();
      return hashes;
    },
  });

  // -- RuntimeContext
  const ctx = new RuntimeContext({
    config,
    kthxConfig,
    memory,
    ipcPaths,
  });
  ctx.wsClient = wsClient;
  ctx.trpc = trpc;
  ctx.collectRuntimeHashes = collectRuntimeHashes;
  ctx.openclaw.resolvedOpenClawBin = openClawBinaryResolution.command;
  ctx.openclaw.openClawBinSource = openClawBinaryResolution.source;
  ctx.openclaw.openClawBinResolvedPath = openClawBinaryResolution.resolvedPath;
  ctx.openclaw.openClawBinResolutionWarning = openClawBinaryResolution.warning;
  ctx.openclaw.openClawBinAvailable = openClawProbeResult?.ok ?? null;
  ctx.openclaw.openClawBinVersion = openClawProbeResult?.version ?? null;
  ctx.openclaw.openClawBinCheckedAtMs = openClawProbeCheckedAtMs;
  ctx.openclaw.openClawBinLastError = openClawProbeResult
    ? openClawProbeResult.ok
      ? null
      : openClawProbeResult.error ??
        (typeof openClawProbeResult.code === "number"
          ? `exit_code_${openClawProbeResult.code}`
          : "unknown_error")
    : null;

  // -- OpenClaw wake config
  // v2 runtime is local-only for wake signaling (hook files + queue runner tick).
  // We intentionally ignore outbound wake webhook URL/token.
  const envWakeUrl = trimEnv("MG_OPENCLAW_WAKE_URL");
  const envWakeKey =
    trimEnv("MG_OPENCLAW_WAKE_KEY") ?? trimEnv("MG_OPENCLAW_WAKE_TOKEN");
  if (envWakeUrl || envWakeKey) {
    console.log(
      "[agent-runtime] Ignoring MG_OPENCLAW_WAKE_URL / MG_OPENCLAW_WAKE_KEY; wake is local-only in v2.",
    );
  }
  ctx.openclaw.openClawWakeUrl = null;
  ctx.openclaw.openClawWakeKey = null;
  const wakeReasons = Array.isArray(kthxConfig.openclaw.wakeReasons)
    ? kthxConfig.openclaw.wakeReasons
        .filter((reason): reason is string => typeof reason === "string")
        .map((reason) => reason.trim())
        .filter((reason) => reason.length > 0)
    : [];
  ctx.openclaw.openClawWakeReasonSet =
    wakeReasons.length > 0 ? new Set(wakeReasons) : null;
  ctx.misc.controlKey = trimEnv("MG_AGENT_CONTROL_KEY") ?? null;

  // =========================================================================
  // Manager bootstrap
  // =========================================================================

  const refreshAgentKeyBoxForAuth = async (reason: string): Promise<boolean> => {
    const previous = getAgentKeyBox();
    const resolved = await refreshAgentKeyBoxFromLocalSources(reason, {
      allowPersisted: true,
    });
    const current = getAgentKeyBox();
    const changed =
      resolved.ok &&
      typeof current === "string" &&
      current.trim().length > 0 &&
      current !== previous;
    await memory
      .recordWrite({
        type: "auth_agent_key_box_refresh_attempt",
        at: nowIso(),
        reason,
        success: resolved.ok,
        changed,
        source: resolved.source,
        hasAgentKeyBox: Boolean(current && current.trim().length > 0),
      })
      .catch(() => {});
    return changed;
  };

  // -- AuthManager
  const authManager = new AuthManager({
    auth: ctx.auth,
    config: { connectionId: config.connectionId },
    debugSnapshot: ctx.debugSnapshot,
    memory: {
      recordWrite: (p: unknown) => memory.recordWrite(p),
    },
    misc: ctx.misc,
    wsClient: wsClient as any,
    writeDebugSnapshot: () => writeDebugSnapshot(ipcPaths, ctx.debugSnapshot),
    refreshAgentKeyBox: refreshAgentKeyBoxForAuth,
  });
  ctx.authManager = authManager;

  // -- GrantManager
  const grantManager = new GrantManager({
    ipcPaths: {
      latestDirectorGrantPath: ipcPaths.latestDirectorGrantPath,
      wakePath: ipcPaths.wakePath,
    },
    memory: { recordWrite: (p: unknown) => memory.recordWrite(p) },
  });
  ctx.grantManager = grantManager;

  // -- EventsManager
  const eventsManager = new EventsManager({
    ipcPaths: { eventsPath: ipcPaths.eventsPath },
    config: {
      currentEventsMaxLines: config.currentEventsMaxLines,
      tailMaxBytes: config.tailMaxBytes,
    },
    memory: { recordWrite: (p: unknown) => memory.recordWrite(p) },
  });
  await eventsManager.initialize();
  ctx.eventsManager = eventsManager;

  // -- OpenClawManager
  const openClawManager = new OpenClawManager({
    config: {
      agentHomeDir: config.agentHomeDir,
      stateDir: config.stateDir,
      kthxConfigPath: config.kthxConfigPath,
      chatRuntimeTextStreamEnabled: config.chatRuntimeTextStreamEnabled,
      chatRuntimeTextStreamNativeEnabled: config.chatRuntimeTextStreamNativeEnabled,
      openClawWakeDebounceMs: config.openClawWakeDebounceMs,
      openClawWakeBatchMs: config.openClawWakeBatchMs,
      openClawWakeIncludeSocketStateChange: config.openClawWakeIncludeSocketStateChange,
      openClawWakeIncludeMediaPrepared: config.openClawWakeIncludeMediaPrepared,
    },
    openclaw: ctx.openclaw,
    openclawConfig: () => {
      const oc = ctx.kthxConfig.openclaw;
      if (!oc || !oc.enabled) return null;
      return {
        enabled: oc.enabled,
        binPath: oc.binPath,
        agentName: oc.agentName,
        autoCreateResponseAgent: oc.autoCreateResponseAgent,
        responseAgentName: oc.responseAgentName,
        responseAgentModel: oc.responseAgentModel,
        listAgentsCommand: oc.listAgentsCommand,
        promptCommand: oc.promptCommand,
        scheduleCommand: oc.scheduleCommand,
        wakeUrl: oc.wakeUrl,
        wakeToken: oc.wakeToken,
        wakeReasons: oc.wakeReasons,
        allowCreateAgent: oc.allowCreateAgent,
        createAgentCommand: oc.createAgentCommand,
        timeoutMs: oc.timeoutMs,
      };
    },
    memory: { recordWrite: (p: unknown) => memory.recordWrite(p) },
    ipcPaths: {
      hookRequestsPath: ipcPaths.hookRequestsPath,
      hookWakePath: ipcPaths.hookWakePath,
      wakePath: ipcPaths.wakePath,
    },
    touchWake,
  });
  ctx.openClawManager = openClawManager;
  openClawManager.ensureUtilAgent().catch(() => {});

  // -- MintManager
  const mintManager = new MintManager({
    mint: ctx.mint,
    config: {
      connectionId: config.connectionId,
      challengeAnswerMaxChars: config.challengeAnswerMaxChars,
      mintChallengeUseOpenClaw: config.mintChallengeUseOpenClaw,
      rejectMultipleChoiceChallenges: config.rejectMultipleChoiceChallenges,
      mintChallengeAutoRetryEnabled: config.mintChallengeAutoRetryEnabled,
      mintChallengeAutoRetryMaxAttempts: config.mintChallengeAutoRetryMaxAttempts,
      mintRetryMinBackoffMs: config.mintRetryMinBackoffMs,
      mintRetryMaxBackoffMs: config.mintRetryMaxBackoffMs,
    },
    ipcPaths: {
      mintDebugPath: ipcPaths.mintDebugPath,
      mintTracePath: ipcPaths.mintTracePath,
    },
    misc: { subscriptionResyncRequested: ctx.misc.subscriptionResyncRequested, subscriptionResyncReason: ctx.misc.subscriptionResyncReason },
    memory: { recordWrite: (p: unknown) => memory.recordWrite(p) },
    trpc: trpc as any,
    wsClient: wsClient as any,
    runBackendCall: <T>(label: string, fn: () => Promise<T>) =>
      runBackendCall(label, fn, ctx),
    markWsActivity: (source: string) =>
      markWsActivityFn(ctx.wsStateContext, source),
    getRuntimeAttestation: (connectionId: string) =>
      getRuntimeAttestation(connectionId),
    runUtilAgentPrompt: async (input: { prompt: string; purpose: string }) => {
      const result = await openClawManager.promptAgent(
        kthxConfig.openclaw.responseAgentName,
        input.prompt,
        { purpose: input.purpose },
      );
      return result;
    },
  });
  await mintManager.initialize();
  ctx.mintManager = mintManager;

  let triggerAutoCreditPlanner:
    | ((opts: PlannerTriggerOptions) => void)
    | null = null;
  let triggerAutoPostingPlanner:
    | ((opts: PlannerTriggerOptions) => void)
    | null = null;

  setupEnvelopeAndSubscription({
    config: {
      subscribeGlobalFeed: config.subscribeGlobalFeed,
      subscribeActivityFeed: config.subscribeActivityFeed,
      autoSubscribeLenses: config.autoSubscribeLenses,
      lensRefreshMinMs: config.lensRefreshMinMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      extraPublicTopics: config.extraPublicTopics,
      extraUserTopics: config.extraUserTopics,
    },
    ctx,
    memory,
    eventsManager,
    grantManager,
    openClawManager,
    authManager,
    trpc: trpc as any,
    writeDebugSnapshot: () => writeDebugSnapshot(ipcPaths, ctx.debugSnapshot),
    markWsActivity: (source) => markWsActivityFn(ctx.wsStateContext, source),
    getAgentKeyBox: async () => {
      await refreshAgentKeyBoxFromLocalSources("subscription_has_auth", {
        allowPersisted: true,
      });
      return getAgentKeyBox();
    },
    runBackendCall: <T>(label: string, fn: () => Promise<T>) =>
      runBackendCall(label, fn, ctx),
    getPlannerTriggers: () => ({
      triggerAutoCreditPlanner,
      triggerAutoPostingPlanner,
    }),
  });

  const { callAgentChatBridge, callAgentUploadChunk } = createBridgeClients({
    chatApiBaseUrl,
    supervisorConnectionId,
    agentKey: agentKey ?? null,
    getAgentKeyBox,
    getBotToken,
    refreshAgentKeyBoxForAuth,
    attemptMint: async (reason) => {
      await ctx.mintManager?.attemptMint(reason).catch(() => undefined);
    },
    recordWrite: (payload) => memory.recordWrite(payload),
  });

  const notifyOwnerImageGeneratorSetupIfNeeded = async (): Promise<VisualSetupCheckState> => {
    return _notifyOwnerVisualSetup({
      stateDir: config.stateDir,
      imageGenerateCmd: config.imageGenerateCmd ?? null,
      kthxImageCommandTemplate: ctx.kthxConfig.image.commandTemplate,
      callAgentChatBridge,
      chatApiBaseUrl,
      agentGuideLocalPath,
      recordWrite: (payload) => memory.recordWrite(payload),
    });
  };

  const resolveGrantCandidates = (permissionState: unknown): GrantState[] => {
    const now = Date.now();
    const candidates = parseGrantCandidatesFromPermissionState(permissionState);
    const activeGrant = grantManager.getActiveGrant();
    const merged = new Map<string, GrantState>();
    const scoreGrant = (grant: GrantState): number => {
      let score = 0;
      for (const action of grant.actions.values()) {
        if (action.remainingCount <= 0) continue;
        score += action.remainingCount;
      }
      return score;
    };
    const addCandidate = (candidate: GrantState | null): void => {
      if (!candidate) return;
      if (candidate.expiresAtMs <= now) return;
      const id = candidate.id.trim();
      const key =
        id.length > 0
          ? id
          : `anonymous:${candidate.issuedAtMs}:${candidate.expiresAtMs}:${candidate.actions.size}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, candidate);
        return;
      }
      const existingScore = scoreGrant(existing);
      const nextScore = scoreGrant(candidate);
      if (
        candidate.expiresAtMs > existing.expiresAtMs ||
        (candidate.expiresAtMs === existing.expiresAtMs && nextScore > existingScore) ||
        (candidate.expiresAtMs === existing.expiresAtMs &&
          nextScore === existingScore &&
          candidate.actions.size > existing.actions.size)
      ) {
        merged.set(key, candidate);
      }
    };
    for (const candidate of candidates) addCandidate(candidate);
    addCandidate(activeGrant);
    return Array.from(merged.values()).sort((left, right) => right.expiresAtMs - left.expiresAtMs);
  };

  const resolvePlannerRuntimeAgentId = async () => {
    const queryFn = ctx.trpc?.realtime?.authState?.query;
    if (typeof queryFn === "function") {
      try {
        const authState = await queryFn();
        if (isRecord(authState) && typeof authState.userId === "string") {
          const userId = authState.userId.trim();
          if (userId.length > 0) {
            return userId;
          }
        }
      } catch {
        // Fall through to the last known snapshot.
      }
    }
    const authSnapshot = ctx.debugSnapshot.auth;
    if (isRecord(authSnapshot) && typeof authSnapshot.userId === "string") {
      const userId = authSnapshot.userId.trim();
      if (userId.length > 0) {
        return userId;
      }
    }
    return null;
  };

  triggerAutoCreditPlanner = createAutoCreditPlanner({
    hasDirectiveManager: () => Boolean(ctx.directiveManager),
    isQueueRunnerEnabled: () =>
      ctx.queueManager ? ctx.queueManager.isRunnerEnabled() : true,
    getPermissionState: () => ctx.debugSnapshot.permission,
    resolveGrantCandidates,
    resolveRuntimeAgentId: resolvePlannerRuntimeAgentId,
    callAgentChatBridge,
    intakeDirective: async (directive) => {
      if (!ctx.directiveManager) return;
      await ctx.directiveManager.intake(directive);
    },
    recordWrite: (payload) => memory.recordWrite(payload),
  });

  triggerAutoPostingPlanner = createAutoPostingPlanner({
    hasDirectiveManager: () => Boolean(ctx.directiveManager),
    isQueueRunnerEnabled: () =>
      ctx.queueManager ? ctx.queueManager.isRunnerEnabled() : true,
    getPermissionState: () => ctx.debugSnapshot.permission,
    resolveGrantCandidates,
    resolveRuntimeAgentId: resolvePlannerRuntimeAgentId,
    intakeDirective: async (directive) => {
      if (!ctx.directiveManager) return;
      await ctx.directiveManager.intake(directive);
    },
    recordWrite: (payload) => memory.recordWrite(payload),
  });

  await bootstrapRuntimeManagersAndStart({
    config,
    kthxConfig,
    ipcPaths,
    stateDb,
    trpc,
    ctx,
    memory,
    hasInteractivePty,
    bootstrapToken,
    callAgentChatBridge,
    callAgentUploadChunk,
    openClawManager,
    mintManager,
    notifyOwnerImageGeneratorSetupIfNeeded,
    touchWake,
    triggerAutoCreditPlanner,
    triggerAutoPostingPlanner,
  });
};

// ---------------------------------------------------------------------------
// Top-level error handlers
// ---------------------------------------------------------------------------

process.on("uncaughtException", (error: unknown) => {
  void handleFatalExit("uncaughtException", error);
});

process.on("unhandledRejection", (error: unknown) => {
  const exitOnReject =
    (trimEnv("MG_AGENT_EXIT_ON_UNHANDLED_REJECTION") ?? "0") === "1";
  if (exitOnReject) {
    void handleFatalExit("unhandledRejection", error);
  }
});

void main().catch((error: unknown) => {
  void handleFatalExit("main", error);
});
