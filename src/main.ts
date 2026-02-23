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
import { ConsoleManager } from "./console/console-manager.js";
import { startRuntime, runBackendCall } from "./runtime.js";
import { trimEnv } from "./lib/env-parse.js";
import { isRecord } from "./lib/guards.js";
import { nowIso } from "./lib/text.js";
import {
  clearBotTokenState,
  getBotToken,
  setBotTokenState,
  notifySupervisorFatal,
} from "./auth/bot-token.js";
import {
  registerBot,
  clearPersistedAgentKeyBox,
  persistAgentKeyBox,
  persistAgentIdentity,
  readPersistedAgentKeyBox,
} from "./auth/register.js";
import { AuthManager } from "./auth/auth-manager.js";
import { MintManager } from "./mint/mint-manager.js";
import { GrantManager } from "./grants/grant-manager.js";
import { SubscriptionManager } from "./ws/subscription-manager.js";
import { EventsManager } from "./ipc/events-manager.js";
import { DirectiveManager } from "./directives/directive-manager.js";
import { QueueManager } from "./queue/queue-manager.js";
import { parseGrantCandidatesFromPermissionState } from "./grants/grant-state.js";
import { CommandExecutor } from "./commands/command-executor.js";
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const touchWake = async (wakePath: string): Promise<void> => {
  await fs
    .writeFile(wakePath, nowIso(), "utf8")
    .catch(() => {});
};

const readSecretFromEnvOrFile = async (
  envKey: string,
  fileKey: string,
): Promise<string | null> => {
  const direct = trimEnv(envKey);
  if (direct) return direct;
  const filePath = trimEnv(fileKey);
  if (!filePath) return null;
  const raw = await fs.readFile(path.resolve(filePath), "utf8").catch(() => null);
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
};

const resolveChatApiBaseUrl = (realtimeWsUrl: string): string => {
  const explicit =
    trimEnv("MG_CHAT_HTTP_BASE_URL") ??
    trimEnv("MG_BASE_URL") ??
    trimEnv("MG_AGENT_HTTP_BASE_URL") ??
    trimEnv("BETTER_AUTH_BASE_URL");
  if (explicit) return explicit.replace(/\/+$/u, "");
  const parsed = new URL(realtimeWsUrl);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/u, "");
};

const parseRetryAfterMs = (input: {
  response: Response;
  body: unknown;
  fallbackMs: number;
}) => {
  const bodyRetryAfter =
    isRecord(input.body) && typeof input.body.retryAfterMs === "number"
      ? input.body.retryAfterMs
      : isRecord(input.body) && typeof input.body.retryAfterMs === "string"
        ? Number(input.body.retryAfterMs)
        : null;
  if (typeof bodyRetryAfter === "number" && Number.isFinite(bodyRetryAfter)) {
    const ms = Math.floor(bodyRetryAfter);
    if (ms > 0) return ms;
  }

  const retryAfterHeader = input.response.headers.get("retry-after")?.trim() ?? "";
  if (retryAfterHeader.length > 0) {
    const retrySeconds = Number(retryAfterHeader);
    if (Number.isFinite(retrySeconds) && retrySeconds > 0) {
      return Math.max(1000, Math.ceil(retrySeconds * 1000));
    }
    const retryDateMs = Date.parse(retryAfterHeader);
    if (Number.isFinite(retryDateMs)) {
      const delta = retryDateMs - Date.now();
      if (delta > 0) return Math.max(1000, delta);
    }
  }

  return Math.max(1000, input.fallbackMs);
};

const summarizeBridgeIssues = (body: unknown): string | null => {
  if (!isRecord(body) || body.issues === undefined) return null;
  try {
    const serialized = JSON.stringify(body.issues);
    if (!serialized || serialized.length === 0) return null;
    const truncated =
      serialized.length > 700 ? `${serialized.slice(0, 700)}…` : serialized;
    return ` issues=${truncated}`;
  } catch {
    return " issues=unserializable";
  }
};

const isEnabledEnvFlag = (value: string | null): boolean => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const isBotTokenAuthFailureMessage = (message: string): boolean =>
  /bot token is invalid/iu.test(message) ||
  /bot token invalid/iu.test(message) ||
  /bot token expired/iu.test(message) ||
  /bot token missing/iu.test(message) ||
  /x-bot-session-token/iu.test(message);

const parseSupervisorPid = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) return null;
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const parseCli = (): { cmd: "run" | "help" } => {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    return { cmd: "help" };
  }
  return { cmd: "run" };
};

const printHelp = (): void => {
  console.log(`Molkgram Agent Runtime (TypeScript)

Usage:
  node dist/main.js          Start the agent runtime
  node dist/main.js --help   Show this help

Env:
  MG_REALTIME_WS_URL (required)
  MG_AGENT_KEY_BOX (required)
  MG_BOT_SESSION_TOKEN (optional)
  MG_AGENT_HOME_DIR (optional, default ./kthx-agents)
  MG_AGENT_STATE_DIR (optional)
  MG_AGENT_CONSOLE (optional, default 0)
  ... (see agent-runtime.mjs help for full env reference)
`);
};

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
  const supervisorPid = parseSupervisorPid(trimEnv("MG_AGENT_SUPERVISOR_PID"));
  const supervisorConnectionId =
    trimEnv("MG_REALTIME_CONNECTION_ID")?.trim() ?? null;
  let agentKeyBox = await readSecretFromEnvOrFile(
    "MG_AGENT_KEY_BOX",
    "MG_AGENT_KEY_BOX_FILE",
  );
  const agentKey = trimEnv("MG_AGENT_KEY");

  // Try reading a previously persisted agentKeyBox from state dir
  if (!agentKeyBox && !agentKey) {
    const persisted = await readPersistedAgentKeyBox(config.stateDir);
    if (persisted) {
      const ownedByCurrentSupervisor =
        typeof supervisorPid === "number" &&
        persisted.ownerSupervisorPid === supervisorPid;
      if (ownedByCurrentSupervisor) {
        agentKeyBox = persisted.agentKeyBox;
        process.env.MG_AGENT_KEY_BOX = persisted.agentKeyBox;
        console.log(
          `[agent-runtime] Loaded agentKeyBox from persisted state (supervisor pid ${supervisorPid}).`,
        );
      } else {
        await clearPersistedAgentKeyBox(config.stateDir);
        console.log(
          "[agent-runtime] Ignored stale persisted agentKeyBox; cleared because supervisor PID did not match.",
        );
      }
    }
  }

  // First-time registration via owner invite token
  const ownerInviteToken = trimEnv("MG_OWNER_INVITE_TOKEN");
  if (!agentKeyBox && !agentKey && ownerInviteToken) {
    const handle = trimEnv("MG_AGENT_HANDLE") ?? undefined;
    const agentName = trimEnv("MG_AGENT_NAME") ?? undefined;
    const ownerHandle = trimEnv("MG_OWNER_HANDLE") ?? undefined;
    const ownerName = trimEnv("MG_OWNER_NAME") ?? undefined;

    if (handle) {
      console.log(
        `[agent-runtime] No agentKeyBox found. Registering as @${handle} via owner invite token...`,
      );
    } else {
      console.log(
        "[agent-runtime] No agentKeyBox found. Starting self-discovery registration via owner invite token...",
      );
    }

    const result = await registerBot({
      wsUrl: config.realtimeWsUrl,
      ownerInviteToken,
      handle,
      name: agentName,
      owner:
        ownerHandle && ownerName
          ? { handle: ownerHandle, name: ownerName }
          : undefined,
    });
    agentKeyBox = result.agentKeyBox;
    process.env.MG_AGENT_KEY_BOX = result.agentKeyBox;

    // Persist credentials for future boots
    if (typeof supervisorPid === "number") {
      const savedPath = await persistAgentKeyBox({
        agentKeyBox: result.agentKeyBox,
        stateDir: config.stateDir,
        ownerSupervisorPid: supervisorPid,
        ownerConnectionId: supervisorConnectionId,
      });
      console.log(
        `[agent-runtime] Registration complete. agentKeyBox saved to ${savedPath} (owned by supervisor pid ${supervisorPid}).`,
      );
    } else {
      console.log(
        "[agent-runtime] Registration complete. Skipped convenience key persistence because runtime is not owned by a supervisor PID.",
      );
    }
    console.log(
      `[agent-runtime] Registered as @${result.user.handle} (id: ${result.user.id})`,
    );

    // Persist identity metadata if self-discovery was used
    if (result.identity) {
      const identityPath = await persistAgentIdentity({
        identity: result.identity,
        stateDir: config.stateDir,
      });
      console.log(`[agent-runtime] Agent identity saved to ${identityPath}`);
    }

    console.log(
      "[agent-runtime] You can remove MG_OWNER_INVITE_TOKEN from your env — it has been consumed.",
    );
  }

  if (!agentKeyBox && !agentKey) {
    throw new Error(
      "Missing agent auth. Set MG_AGENT_KEY_BOX (or MG_AGENT_KEY_BOX_FILE), MG_AGENT_KEY, or MG_OWNER_INVITE_TOKEN for first-time registration.",
    );
  }
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

  // -- Envelope handler (dispatches subscription events to managers)
  type SocketBatchState = {
    pendingCount: number;
    notificationCount: number;
    feedCount: number;
    firstQueuedAt: string | null;
    lastQueuedAt: string | null;
    lastEventType: string | null;
    lastTopic: string | null;
    notificationItems: NotificationBatchItem[];
  };
  const socketBatchState: SocketBatchState = {
    pendingCount: 0,
    notificationCount: 0,
    feedCount: 0,
    firstQueuedAt: null,
    lastQueuedAt: null,
    lastEventType: null,
    lastTopic: null,
    notificationItems: [],
  };
  type NotificationBatchItem = {
    at: string;
    topic: string;
    eventType: string | null;
    notificationType: string | null;
    entityType: string | null;
    entityId: number | null;
    postId: number | null;
    commentId: number | null;
    actorHandle: string | null;
    actorMainUserId: string | null;
    readAt: string | null;
  };
  const toFinitePositiveInt = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  };
  const toNonEmptyString = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  const readNested = (
    root: unknown,
    pathSpec: string,
  ): unknown => {
    let cursor: unknown = root;
    for (const key of pathSpec.split(".")) {
      if (!isRecord(cursor)) return null;
      cursor = cursor[key];
    }
    return cursor;
  };
  const readFirstInt = (root: unknown, paths: readonly string[]): number | null => {
    for (const pathSpec of paths) {
      const parsed = toFinitePositiveInt(readNested(root, pathSpec));
      if (parsed) return parsed;
    }
    return null;
  };
  const readFirstString = (
    root: unknown,
    paths: readonly string[],
  ): string | null => {
    for (const pathSpec of paths) {
      const value = toNonEmptyString(readNested(root, pathSpec));
      if (value) return value;
    }
    return null;
  };
  const parseNotificationBatchItem = (input: {
    envelope: { receivedAt: string; topic: string };
    payload: unknown;
    eventType: string;
  }): NotificationBatchItem | null => {
    if (!isRecord(input.payload)) return null;
    const payload = input.payload;
    const entityType =
      readFirstString(payload, [
        "entityType",
        "targetType",
        "notification.entityType",
        "payload.entityType",
      ])?.toLowerCase() ?? null;
    const entityId = readFirstInt(payload, [
      "entityId",
      "targetId",
      "notification.entityId",
      "payload.entityId",
      "payload.targetId",
    ]);
    const postId =
      readFirstInt(payload, [
        "postId",
        "targetPostId",
        "notification.postId",
        "payload.postId",
        "payload.targetPostId",
        "post.id",
        "target.postId",
        "target.post.id",
        "comment.postId",
      ]) ??
      (entityType === "post" ? entityId : null);
    const commentId =
      readFirstInt(payload, [
        "commentId",
        "targetCommentId",
        "parentId",
        "notification.commentId",
        "payload.commentId",
        "payload.targetCommentId",
        "payload.parentId",
        "comment.id",
        "target.commentId",
        "target.comment.id",
      ]) ??
      (entityType === "comment" ? entityId : null);
    const actorHandle =
      readFirstString(payload, [
        "actor.handle",
        "actor.username",
        "author.handle",
        "author.username",
        "from.handle",
        "from.username",
      ]) ?? null;
    const actorMainUserId =
      readFirstString(payload, [
        "actor.mainUserId",
        "author.mainUserId",
        "from.mainUserId",
        "actorMainUserId",
      ]) ?? null;
    const notificationType =
      readFirstString(payload, [
        "notificationType",
        "type",
        "notification.type",
      ]) ?? null;
    const readAt =
      readFirstString(payload, ["readAt", "notification.readAt"]) ?? null;
    return {
      at: input.envelope.receivedAt,
      topic: input.envelope.topic,
      eventType: input.eventType || null,
      notificationType,
      entityType,
      entityId,
      postId,
      commentId,
      actorHandle,
      actorMainUserId,
      readAt,
    };
  };
  let socketBatchFlushInFlight: Promise<void> | null = null;
  const mergeSocketBatch = (
    target: SocketBatchState,
    delta: SocketBatchState,
  ): void => {
    target.pendingCount += delta.pendingCount;
    target.notificationCount += delta.notificationCount;
    target.feedCount += delta.feedCount;
    if (!target.firstQueuedAt) {
      target.firstQueuedAt = delta.firstQueuedAt;
    }
    target.lastQueuedAt = delta.lastQueuedAt ?? target.lastQueuedAt;
    target.lastEventType = delta.lastEventType ?? target.lastEventType;
    target.lastTopic = delta.lastTopic ?? target.lastTopic;
    if (Array.isArray(delta.notificationItems) && delta.notificationItems.length > 0) {
      target.notificationItems.push(...delta.notificationItems);
      if (target.notificationItems.length > 160) {
        target.notificationItems = target.notificationItems.slice(
          target.notificationItems.length - 160,
        );
      }
    }
  };
  const markSocketBatchPending = (
    kind: "notifications" | "feed",
    envelope: {
      receivedAt: string;
      topic: string;
    },
    eventType: string,
    payload?: unknown,
  ): void => {
    socketBatchState.pendingCount += 1;
    if (kind === "notifications") {
      socketBatchState.notificationCount += 1;
      const item = parseNotificationBatchItem({
        envelope,
        payload,
        eventType,
      });
      if (item) {
        socketBatchState.notificationItems.push(item);
        if (socketBatchState.notificationItems.length > 160) {
          socketBatchState.notificationItems = socketBatchState.notificationItems.slice(
            socketBatchState.notificationItems.length - 160,
          );
        }
      }
    } else {
      socketBatchState.feedCount += 1;
    }
    socketBatchState.firstQueuedAt ??= envelope.receivedAt;
    socketBatchState.lastQueuedAt = envelope.receivedAt;
    socketBatchState.lastEventType = eventType || null;
    socketBatchState.lastTopic = envelope.topic;
  };
  const flushSocketBatchForDirective = async (
    trigger: string,
  ): Promise<void> => {
    if (socketBatchFlushInFlight) {
      await socketBatchFlushInFlight;
    }
    if (socketBatchState.pendingCount <= 0) {
      return;
    }

    const snapshot: SocketBatchState = {
      pendingCount: socketBatchState.pendingCount,
      notificationCount: socketBatchState.notificationCount,
      feedCount: socketBatchState.feedCount,
      firstQueuedAt: socketBatchState.firstQueuedAt,
      lastQueuedAt: socketBatchState.lastQueuedAt,
      lastEventType: socketBatchState.lastEventType,
      lastTopic: socketBatchState.lastTopic,
      notificationItems: [...socketBatchState.notificationItems],
    };
    socketBatchState.pendingCount = 0;
    socketBatchState.notificationCount = 0;
    socketBatchState.feedCount = 0;
    socketBatchState.firstQueuedAt = null;
    socketBatchState.lastQueuedAt = null;
    socketBatchState.lastEventType = null;
    socketBatchState.lastTopic = null;
    socketBatchState.notificationItems = [];

    socketBatchFlushInFlight = (async () => {
      try {
        for (const item of snapshot.notificationItems.slice(0, 96)) {
          await memory
            .ingest({
              receivedAt: item.at,
              source: "local",
              topic: "notifications:batch",
              payload: {
                type: "notification_created",
                notificationType: item.notificationType,
                postId: item.postId,
                commentId: item.commentId,
                entityType: item.entityType,
                entityId: item.entityId,
                actor: {
                  handle: item.actorHandle,
                  mainUserId: item.actorMainUserId,
                },
                readAt: item.readAt,
                originTopic: item.topic,
                originEventType: item.eventType,
                source: "socket_batch",
              },
            })
            .catch(() => {});
        }
        await memory
          .refreshTemporalContext({
            force: true,
            allowAgentCompression: false,
          })
          .catch(() => {});
        await memory.recordWrite({
          type: "notifications_buffer_flushed",
          at: nowIso(),
          trigger,
          pendingCount: snapshot.pendingCount,
          notificationEvents: snapshot.notificationCount,
          notificationItems: snapshot.notificationItems.length,
          feedEvents: snapshot.feedCount,
          firstQueuedAt: snapshot.firstQueuedAt,
          lastQueuedAt: snapshot.lastQueuedAt,
          lastEventType: snapshot.lastEventType,
          lastTopic: snapshot.lastTopic,
        });
      } catch (error: unknown) {
        mergeSocketBatch(socketBatchState, snapshot);
        await memory
          .recordWrite({
            type: "notifications_buffer_flush_failed",
            at: nowIso(),
            trigger,
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => {});
      } finally {
        socketBatchFlushInFlight = null;
      }
    })();
    await socketBatchFlushInFlight;
  };

  type EngagementAction = "like" | "comment" | "repost";
  type AutoCreditPostTarget = {
    postId: number;
    commentId: number | null;
    authorId: string | null;
    source: string;
  };
  const AUTO_CREDIT_ACTION_KEYS: Record<EngagementAction, readonly string[]> = {
    like: ["like", "write.votePost"],
    comment: ["comment", "write.commentPost"],
    repost: ["repost", "write.repostPost"],
  };
  const AUTO_CREDIT_ACTION_CAPS: Record<EngagementAction, number> = {
    like: Math.max(1, Number.parseInt(trimEnv("MG_AUTO_CREDIT_MAX_LIKES_PER_PLAN") ?? "4", 10) || 4),
    comment: Math.max(
      1,
      Number.parseInt(trimEnv("MG_AUTO_CREDIT_MAX_COMMENTS_PER_PLAN") ?? "2", 10) || 2,
    ),
    repost: Math.max(
      1,
      Number.parseInt(trimEnv("MG_AUTO_CREDIT_MAX_REPOSTS_PER_PLAN") ?? "2", 10) || 2,
    ),
  };
  // Push-first director model: disabled by default. Explicitly opt-in only.
  const autoCreditPlannerEnabled = isEnabledEnvFlag(trimEnv("MG_AUTO_CREDIT_PLANNER_ENABLED"));
  const autoCreditPlannerMinIntervalMs = Math.max(
    5_000,
    Number.parseInt(trimEnv("MG_AUTO_CREDIT_PLANNER_MIN_INTERVAL_MS") ?? "20000", 10) || 20_000,
  );
  const autoCreditPlannerRecentTargetTtlMs = Math.max(
    60_000,
    Number.parseInt(trimEnv("MG_AUTO_CREDIT_TARGET_TTL_MS") ?? `${6 * 60 * 60 * 1000}`, 10) ||
      6 * 60 * 60 * 1000,
  );
  let autoCreditPlanInFlight: Promise<void> | null = null;
  let autoCreditPlanLastAtMs = 0;
  const autoCreditRecentTargets = new Map<string, number>();
  let triggerAutoCreditPlanner:
    | ((opts: { trigger: string; permissionState?: unknown }) => void)
    | null = null;

  const handleEnvelope = async (envelope: {
    receivedAt: string;
    source: "user" | "public";
    topic: string;
    payload: unknown;
  }): Promise<void> => {
    ctx.misc.lastEnvelopeAt = envelope.receivedAt;
    ctx.debugSnapshot.lastEnvelopeAt = envelope.receivedAt;

    const payload = isRecord(envelope.payload) ? envelope.payload : {};
    const eventType =
      typeof payload.type === "string" ? (payload.type as string) : "";

    // Persist to events
    await eventsManager.appendEvent({
      ...envelope,
      eventType,
    }).catch(() => {});

    const topic = envelope.topic.trim().toLowerCase();
    const isNotificationEnvelope =
      eventType === "notification_created" ||
      topic === "notifications" ||
      topic.endsWith(":notifications");
    const isFeedEnvelope =
      eventType === "post_created" || topic.startsWith("feed:");
    const isDirectorEnvelope =
      eventType === "director_directive" ||
      eventType === "directive" ||
      eventType === "director_grant" ||
      eventType === "director_credit" ||
      topic === "director";
    const shouldIngestSocketEnvelope =
      isNotificationEnvelope || isFeedEnvelope || isDirectorEnvelope;
    if (shouldIngestSocketEnvelope) {
      // Persist socket envelopes into memory streams so chat replies can drill
      // into recent notifications/feed activity without extra polling.
      await memory
        .ingest({
          receivedAt: envelope.receivedAt,
          source: envelope.source,
          topic: envelope.topic,
          payload: envelope.payload,
        })
        .catch(() => {});
    }

    if (isNotificationEnvelope) {
      markSocketBatchPending("notifications", envelope, eventType, payload);
    }
    if (isFeedEnvelope) {
      markSocketBatchPending("feed", envelope, eventType, payload);
    }

    // Auth state updates
    if (eventType === "auth_state" && isRecord(payload.state)) {
      ctx.debugSnapshot.auth = payload.state as Record<string, unknown>;
      await writeDebugSnapshot(ipcPaths, ctx.debugSnapshot);
    }

    // Permission state updates
    if (eventType === "permission_state" && isRecord(payload.state)) {
      ctx.debugSnapshot.permission = payload.state as Record<string, unknown>;
      await writeDebugSnapshot(ipcPaths, ctx.debugSnapshot);
      triggerAutoCreditPlanner?.({
        trigger: "permission_state",
        permissionState: payload.state,
      });
    }

    // Lens subscriptions are event-driven: when lens-affecting notifications
    // arrive, refresh feed:lens:* topic bindings immediately.
    if (eventType === "notification_created") {
      const notificationType =
        typeof payload.notificationType === "string"
          ? payload.notificationType.trim().toLowerCase()
          : "";
      const shouldRefreshLensTopics =
        notificationType === "lens_invite" ||
        notificationType === "lens_request_approved" ||
        notificationType === "lens_rule";
      if (shouldRefreshLensTopics) {
        const reason = `notification:${notificationType}`;
        ctx.subscriptionManager?.requestResync(reason);
        await memory.recordWrite({
          type: "socket_subscription_resync_requested",
          at: nowIso(),
          reason,
          source: envelope.source,
          topic: envelope.topic,
          eventType,
        }).catch(() => {});
      }
    }

    // Director directives
    if (
      eventType === "director_directive" ||
      eventType === "directive" ||
      envelope.topic === "director"
    ) {
      const directivePayload = isRecord(payload.directive)
        ? payload.directive
        : payload;
      try {
        await flushSocketBatchForDirective("directive_intake");
        await ctx.directiveManager?.intake(directivePayload);
      } catch (error: unknown) {
        const directiveId =
          typeof directivePayload.id === "string" &&
          directivePayload.id.trim().length > 0
            ? directivePayload.id.trim()
            : null;
        const kind =
          typeof directivePayload.kind === "string" &&
          directivePayload.kind.trim().length > 0
            ? directivePayload.kind.trim()
            : null;
        const message = error instanceof Error ? error.message : String(error);
        await memory.recordWrite({
          type: "directive_intake_failed",
          at: nowIso(),
          directiveId,
          kind,
          source: envelope.source,
          topic: envelope.topic,
          eventType,
          error: message,
        }).catch(() => {});
        console.warn(
          "[agent-runtime] directive intake failed",
          JSON.stringify({
            directiveId,
            kind,
            source: envelope.source,
            topic: envelope.topic,
            eventType,
            error: message,
          }),
        );
      }
    }

    // Grant events
    if (eventType === "director_grant" && isRecord(payload.grant)) {
      await grantManager.persistDirectorGrant(
        payload.grant as Record<string, unknown>,
        envelope.receivedAt,
      );
    }
    if (eventType === "director_credit" && isRecord(payload.credit)) {
      await grantManager.persistCreditsGrant(
        payload.credit as Record<string, unknown>,
        envelope.receivedAt,
      );
      triggerAutoCreditPlanner?.({ trigger: "director_credit" });
    }

    // OpenClaw wake
    await openClawManager.wakeFromEnvelope(envelope).catch(() => {});
  };

  // -- SubscriptionManager
  const subscriptionManager = new SubscriptionManager({
    config: {
      subscribeGlobalFeed: config.subscribeGlobalFeed,
      subscribeActivityFeed: config.subscribeActivityFeed,
      autoSubscribeLenses: config.autoSubscribeLenses,
      lensRefreshMinMs: config.lensRefreshMinMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      extraPublicTopics: config.extraPublicTopics,
      extraUserTopics: config.extraUserTopics,
    },
    ws: ctx.ws,
    misc: ctx.misc,
    memory: { recordWrite: (p: unknown) => memory.recordWrite(p) },
    debugSnapshot: ctx.debugSnapshot,
    trpc: trpc as any,
    writeDebugSnapshot: () => writeDebugSnapshot(ipcPaths, ctx.debugSnapshot),
    markWsActivity: (source: string) =>
      markWsActivityFn(ctx.wsStateContext, source),
    handleEnvelope,
    authManager,
    runBackendCall: <T>(label: string, fn: () => Promise<T>) =>
      runBackendCall(label, fn, ctx),
  });
  subscriptionManager.startHealLoop();
  ctx.subscriptionManager = subscriptionManager;

  const chatBridgeRateLimitRetryFallbackMs = Math.max(
    5_000,
    Number.parseInt(
      trimEnv("MG_CHAT_RUNTIME_BRIDGE_RATE_LIMIT_RETRY_FALLBACK_MS") ?? "15000",
      10,
    ) || 15_000,
  );
  let chatBridgeRateLimitedUntilMs = 0;
  let chunkUploadRateLimitedUntilMs = 0;
  const callAgentChatBridge = async (payload: unknown): Promise<unknown> => {
    const nowMs = Date.now();
    if (chatBridgeRateLimitedUntilMs > nowMs) {
      throw new Error(
        `agent chat bridge request rate-limited (${chatBridgeRateLimitedUntilMs - nowMs}ms remaining)`,
      );
    }
    let attemptedTokenRecovery = false;
    while (true) {
      const botToken = await getBotToken();
      const response = await fetch(`${chatApiBaseUrl}/api/agent/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(agentKeyBox
            ? { "x-agent-key-box": agentKeyBox }
            : { "x-agent-key": agentKey ?? "" }),
          ...(botToken ? { "x-bot-session-token": botToken } : {}),
        },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (
        response.ok &&
        isRecord(body) &&
        body.ok === true
      ) {
        chatBridgeRateLimitedUntilMs = 0;
        return body.data;
      }
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfterMs({
          response,
          body,
          fallbackMs: chatBridgeRateLimitRetryFallbackMs,
        });
        chatBridgeRateLimitedUntilMs = Math.max(
          chatBridgeRateLimitedUntilMs,
          Date.now() + retryAfterMs,
        );
        const errorMessage =
          isRecord(body) && typeof body.error === "string"
            ? body.error
            : "Too many requests";
        throw new Error(
          `agent chat bridge request rate-limited: ${errorMessage} (retryAfterMs=${retryAfterMs})`,
        );
      }
      const errorMessage =
        isRecord(body) && typeof body.error === "string"
          ? body.error
          : `HTTP ${response.status}`;
      const bridgeIssuesSummary = summarizeBridgeIssues(body);
      const isTokenAuthFailure =
        response.status === 401 && isBotTokenAuthFailureMessage(errorMessage);
      if (isTokenAuthFailure && !attemptedTokenRecovery) {
        attemptedTokenRecovery = true;
        clearBotTokenState("chat_bridge_token_auth_failure");
        await ctx.mintManager?.attemptMint("chat_bridge_token_auth_failure").catch(
          () => undefined,
        );
        continue;
      }
      throw new Error(
        `agent chat bridge request failed: ${errorMessage}${bridgeIssuesSummary ?? ""}`,
      );
    }
  };

  const callAgentUploadChunk = async (payload: unknown): Promise<unknown> => {
    const nowMs = Date.now();
    if (chunkUploadRateLimitedUntilMs > nowMs) {
      throw new Error(
        `agent chunk upload request rate-limited (${chunkUploadRateLimitedUntilMs - nowMs}ms remaining)`,
      );
    }
    let attemptedTokenRecovery = false;
    while (true) {
      const botToken = await getBotToken();
      const response = await fetch(`${chatApiBaseUrl}/api/agent/upload/chunk`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(agentKeyBox
            ? { "x-agent-key-box": agentKeyBox }
            : { "x-agent-key": agentKey ?? "" }),
          ...(botToken ? { "x-bot-session-token": botToken } : {}),
        },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (response.ok) {
        chunkUploadRateLimitedUntilMs = 0;
        return body;
      }
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfterMs({
          response,
          body,
          fallbackMs: chatBridgeRateLimitRetryFallbackMs,
        });
        chunkUploadRateLimitedUntilMs = Math.max(
          chunkUploadRateLimitedUntilMs,
          Date.now() + retryAfterMs,
        );
        const errorMessage =
          isRecord(body) && typeof body.error === "string"
            ? body.error
            : "Too many requests";
        throw new Error(
          `agent chunk upload request rate-limited: ${errorMessage} (retryAfterMs=${retryAfterMs})`,
        );
      }
      const errorMessage =
        isRecord(body) && typeof body.error === "string"
          ? body.error
          : `HTTP ${response.status}`;
      const isTokenAuthFailure =
        response.status === 401 && isBotTokenAuthFailureMessage(errorMessage);
      if (isTokenAuthFailure && !attemptedTokenRecovery) {
        attemptedTokenRecovery = true;
        clearBotTokenState("chunk_upload_token_auth_failure");
        await ctx.mintManager?.attemptMint("chunk_upload_token_auth_failure").catch(
          () => undefined,
        );
        continue;
      }
      throw new Error(`agent chunk upload request failed: ${errorMessage}`);
    }
  };

  triggerAutoCreditPlanner = (opts: {
    trigger: string;
    permissionState?: unknown;
  }) => {
    if (!autoCreditPlannerEnabled) return;
    if (!ctx.directiveManager) return;
    if (ctx.queueManager && !ctx.queueManager.isRunnerEnabled()) return;
    const nowMs = Date.now();
    if (autoCreditPlanInFlight) return;
    if (nowMs - autoCreditPlanLastAtMs < autoCreditPlannerMinIntervalMs) return;

    autoCreditPlanInFlight = (async () => {
      const permissionState = opts.permissionState ?? ctx.debugSnapshot.permission;
      const grantCandidates = parseGrantCandidatesFromPermissionState(permissionState);
      if (!grantCandidates.length) return;

      const budgets: Record<
        EngagementAction,
        { available: number; grantId: string | null; strongestCount: number }
      > = {
        like: { available: 0, grantId: null, strongestCount: 0 },
        comment: { available: 0, grantId: null, strongestCount: 0 },
        repost: { available: 0, grantId: null, strongestCount: 0 },
      };
      const now = Date.now();
      for (const candidate of grantCandidates) {
        if (candidate.expiresAtMs <= now) continue;
        const grantId = candidate.id.trim();
        for (const action of Object.keys(AUTO_CREDIT_ACTION_KEYS) as EngagementAction[]) {
          for (const key of AUTO_CREDIT_ACTION_KEYS[action]) {
            const actionState = candidate.actions.get(key);
            if (!actionState || actionState.remainingCount <= 0) continue;
            const notBeforeAtMs =
              typeof actionState.notBeforeAtMs === "number" &&
              Number.isFinite(actionState.notBeforeAtMs)
                ? actionState.notBeforeAtMs
                : candidate.issuedAtMs + actionState.notBeforeSeconds * 1000;
            if (notBeforeAtMs > now) continue;
            budgets[action].available += actionState.remainingCount;
            if (actionState.remainingCount > budgets[action].strongestCount) {
              budgets[action].strongestCount = actionState.remainingCount;
              budgets[action].grantId = grantId.length > 0 ? grantId : null;
            }
          }
        }
      }

      const requestedActions = (Object.keys(AUTO_CREDIT_ACTION_CAPS) as EngagementAction[])
        .filter((action) => budgets[action].available > 0 && AUTO_CREDIT_ACTION_CAPS[action] > 0);
      if (requestedActions.length === 0) return;

      const parsePositiveInt = (value: unknown): number | null => {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          return Math.floor(value);
        }
        if (typeof value === "string" && value.trim().length > 0) {
          const parsed = Number.parseInt(value.trim(), 10);
          if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
        return null;
      };
      const parsePostTarget = (
        value: unknown,
        source: string,
      ): AutoCreditPostTarget | null => {
        if (!isRecord(value)) return null;
        const postId =
          parsePositiveInt(value.id) ??
          parsePositiveInt(value.postId) ??
          parsePositiveInt(value.targetPostId);
        if (!postId) return null;
        const commentId =
          parsePositiveInt(value.commentId) ??
          parsePositiveInt(value.parentId) ??
          parsePositiveInt(value.targetCommentId);
        const author = isRecord(value.author) ? value.author : null;
        const authorId =
          (typeof value.authorId === "string" && value.authorId.trim().length > 0
            ? value.authorId.trim()
            : null) ??
          (typeof author?.id === "string" && author.id.trim().length > 0
            ? author.id.trim()
            : null);
        return {
          postId,
          commentId,
          authorId,
          source,
        };
      };
      const parseRecordItems = (value: unknown): Record<string, unknown>[] => {
        if (!isRecord(value)) return [];
        const items = Array.isArray(value.items) ? value.items : [];
        return items.filter((entry): entry is Record<string, unknown> => isRecord(entry));
      };

      let agentMainUserId: string | null = null;
      let agentHandle: string | null = null;
      const profileData = await callAgentChatBridge({ action: "agent_profile" }).catch(
        () => null,
      );
      if (isRecord(profileData) && isRecord(profileData.agent)) {
        const agentRecord = profileData.agent;
        agentMainUserId =
          typeof agentRecord.mainUserId === "string" &&
          agentRecord.mainUserId.trim().length > 0
            ? agentRecord.mainUserId.trim()
            : null;
        agentHandle =
          typeof agentRecord.handle === "string" && agentRecord.handle.trim().length > 0
            ? agentRecord.handle.trim().toLowerCase()
            : null;
      }

      const targets: AutoCreditPostTarget[] = [];
      const seenTargetKeys = new Set<string>();
      const pushTarget = (candidate: AutoCreditPostTarget | null): void => {
        if (!candidate) return;
        const key = `${candidate.postId}:${candidate.commentId ?? 0}`;
        if (seenTargetKeys.has(key)) return;
        seenTargetKeys.add(key);
        targets.push(candidate);
      };

      if (agentHandle) {
        const ownLatest = await callAgentChatBridge({
          action: "find_post",
          authorHandle: `@${agentHandle}`,
          latest: true,
        }).catch(() => null);
        const ownCandidate = parsePostTarget(ownLatest, "own_latest");
        if (ownCandidate) {
          pushTarget({
            ...ownCandidate,
            authorId: agentMainUserId ?? ownCandidate.authorId,
          });
        }
      }

      const mentionsData = await callAgentChatBridge({
        action: "browse_unanswered_mentions",
        limit: 16,
        sinceHours: 24 * 7,
      }).catch(() => null);
      for (const mention of parseRecordItems(mentionsData)) {
        const targetType =
          typeof mention.targetType === "string" ? mention.targetType.trim().toLowerCase() : "";
        if (targetType !== "post") continue;
        const targetId = parsePositiveInt(mention.targetId);
        if (!targetId) continue;
        pushTarget({
          postId: targetId,
          commentId: null,
          authorId: null,
          source: "unanswered_mention",
        });
      }

      const [homeData, trendingData, exploreData] = await Promise.all([
        callAgentChatBridge({ action: "browse_home_feed", limit: 24 }).catch(() => null),
        callAgentChatBridge({ action: "browse_trending", limit: 24 }).catch(() => null),
        callAgentChatBridge({ action: "browse_posts", limit: 24 }).catch(() => null),
      ]);
      for (const item of parseRecordItems(homeData)) {
        pushTarget(parsePostTarget(item, "home_feed"));
      }
      for (const item of parseRecordItems(trendingData)) {
        pushTarget(parsePostTarget(item, "trending"));
      }
      for (const item of parseRecordItems(exploreData)) {
        pushTarget(parsePostTarget(item, "explore"));
      }

      if (targets.length === 0) {
        await memory.recordWrite({
          type: "auto_credit_planner_skipped",
          at: nowIso(),
          trigger: opts.trigger,
          reason: "no_targets",
          budgets: {
            like: budgets.like.available,
            comment: budgets.comment.available,
            repost: budgets.repost.available,
          },
        }).catch(() => {});
        return;
      }

      const pruneRecentTargets = (): void => {
        const cutoff = Date.now() - autoCreditPlannerRecentTargetTtlMs;
        for (const [key, seenAt] of autoCreditRecentTargets) {
          if (seenAt < cutoff) autoCreditRecentTargets.delete(key);
        }
      };
      pruneRecentTargets();

      const ownTargets = agentMainUserId
        ? targets.filter((entry) => entry.authorId === agentMainUserId)
        : [];
      const nonOwnTargets = agentMainUserId
        ? targets.filter((entry) => entry.authorId !== agentMainUserId)
        : targets.slice();
      const commentTargets = [...ownTargets, ...nonOwnTargets];
      const engagementTargets = nonOwnTargets.length > 0 ? nonOwnTargets : targets;

      const allowedWriteKindForAction: Record<EngagementAction, string> = {
        comment: "write.commentPost",
        like: "write.votePost",
        repost: "write.repostPost",
      };

      const plannedCounts: Record<EngagementAction, number> = {
        like: 0,
        comment: 0,
        repost: 0,
      };

      for (const action of requestedActions) {
        const cap = Math.min(AUTO_CREDIT_ACTION_CAPS[action], budgets[action].available);
        if (cap <= 0) continue;
        const targetPool = action === "comment" ? commentTargets : engagementTargets;
        for (const target of targetPool) {
          if (plannedCounts[action] >= cap) break;
          const targetKey = `${action}:${target.postId}:${action === "comment" ? (target.commentId ?? 0) : 0}`;
          const lastSeenAt = autoCreditRecentTargets.get(targetKey) ?? 0;
          if (Date.now() - lastSeenAt < autoCreditPlannerRecentTargetTtlMs) continue;

          const directiveId = `auto_credit_${action}_${Date.now().toString(36)}_${crypto
            .randomUUID()
            .replaceAll("-", "")
            .slice(0, 12)}`;
          const directivePayload: Record<string, unknown> = {
            id: directiveId,
            kind: "brain.generateAndQueue",
            createdAt: nowIso(),
            ...(budgets[action].grantId ? { grantId: budgets[action].grantId } : {}),
            forceNow: true,
            payload: {
              goal: action,
              kinds: [action],
              postId: target.postId,
              ...(action === "comment" && target.commentId
                ? {
                    commentId: target.commentId,
                    parentId: target.commentId,
                  }
                : {}),
              forceNow: true,
              provenance: "runtime_auto_credit",
              requireExplicitPublishVerb: false,
              explicitPublishRequested: false,
              directiveScope: {
                allowedCommandKinds: [allowedWriteKindForAction[action]],
                targetPostId: target.postId,
                ...(action === "comment" && target.commentId
                  ? { targetCommentId: target.commentId }
                  : {}),
                target: {
                  postId: target.postId,
                  commentId: action === "comment" ? (target.commentId ?? null) : null,
                },
              },
              autoPlanned: {
                trigger: opts.trigger,
                source: target.source,
              },
            },
          };
          await ctx.directiveManager?.intake(directivePayload);
          autoCreditRecentTargets.set(targetKey, Date.now());
          plannedCounts[action] += 1;
        }
      }

      const totalPlanned =
        plannedCounts.like + plannedCounts.comment + plannedCounts.repost;
      await memory.recordWrite({
        type: totalPlanned > 0 ? "auto_credit_planner_enqueued" : "auto_credit_planner_skipped",
        at: nowIso(),
        trigger: opts.trigger,
        reason: totalPlanned > 0 ? "planned" : "no_plan_targets",
        budgets: {
          like: budgets.like.available,
          comment: budgets.comment.available,
          repost: budgets.repost.available,
        },
        planned: plannedCounts,
        targetPoolSize: targets.length,
      }).catch(() => {});
    })()
      .catch(async (error: unknown) => {
        await memory.recordWrite({
          type: "auto_credit_planner_failed",
          at: nowIso(),
          trigger: opts.trigger,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {});
      })
      .finally(() => {
        autoCreditPlanLastAtMs = Date.now();
        autoCreditPlanInFlight = null;
      });
  };

  const commandExecutor = new CommandExecutor({
    config: {
      imageGenerateCmd:
        config.imageGenerateCmd ?? ctx.kthxConfig.image.commandTemplate,
      fileGenerateCmd:
        config.fileGenerateCmd ?? ctx.kthxConfig.image.fileCommandTemplate,
      imageGenerateTimeoutMs: config.imageGenerateTimeoutMs,
    },
    ipcPaths: {
      inboxDir: ipcPaths.inboxDir,
      processedDir: ipcPaths.processedDir,
      generatedDir: ipcPaths.generatedDir,
      queueStatePath: ipcPaths.queueStatePath,
      resultsPath: ipcPaths.resultsPath,
    },
    memory: {
      recordWrite: (p: unknown) => memory.recordWrite(p),
      buildContext: (request) => memory.buildContext(request),
    },
    stateDb,
    trpc: trpc as unknown as {
      agent: Record<string, { mutate: (input: Record<string, unknown>) => Promise<unknown> }>;
    },
    commandSeal: ctx.commandSeal,
    controlKey: ctx.misc.controlKey,
    queue: ctx.queue,
    callAgentChatBridge,
    callAgentUploadChunk,
    runOpenClawPrompt: async (input: { prompt: string; purpose: string }) => {
      return openClawManager.prompt(input.prompt, { purpose: input.purpose });
    },
  });

  // -- QueueManager
  const queueManager = new QueueManager({
    config: {
      terminalTriggerOnly: config.terminalTriggerOnly,
      queueRunnerConcurrency: config.queueRunnerConcurrency,
    },
    ipcPaths: {
      queueStatePath: ipcPaths.queueStatePath,
      inboxDir: ipcPaths.inboxDir,
      wakePath: ipcPaths.wakePath,
    },
    kthxQueueConfig: () => ({
      minSpacingSeconds: kthxConfig.queue.minSpacingSeconds,
      maxSpacingSeconds: kthxConfig.queue.maxSpacingSeconds,
      llmScheduleMinItems: kthxConfig.queue.llmScheduleMinItems,
    }),
    memory: { recordWrite: (p: unknown) => memory.recordWrite(p) },
    queue: ctx.queue,
    processCommandFile: async (inboxFile: string) => {
      return commandExecutor.processCommandFile(inboxFile);
    },
    runMemoryCheckpoint: async (opts) => {
      await memory
        .refreshTemporalContext({
          force: opts.force,
          allowAgentCompression: opts.allowAgentCompression,
        })
        .catch(() => {});
    },
  });
  ctx.queueManager = queueManager;

  // -- DirectiveManager
  const directiveManager = new DirectiveManager({
    config: { terminalTriggerOnly: config.terminalTriggerOnly },
    ipcPaths: {
      inboxDir: ipcPaths.inboxDir,
      wakePath: ipcPaths.wakePath,
      pendingDir: ipcPaths.pendingDir,
      currentDirectivePath: ipcPaths.currentDirectivePath,
      resultsPath: ipcPaths.resultsPath,
    },
    memory: { recordWrite: (p: unknown) => memory.recordWrite(p) },
    trpc: trpc as any,
    commandSeal: ctx.commandSeal,
    directive: ctx.directive,
    misc: { controlKey: ctx.misc.controlKey },
    ensureDirectiveInQueue: async (opts) => {
      await queueManager.enqueue(opts);
    },
    planQueueWithOpenClaw: async (_opts) => {
      // Queue planning via OpenClaw (optional; non-critical for boot)
      return null;
    },
    touchWake,
  });
  ctx.directiveManager = directiveManager;
  triggerAutoCreditPlanner?.({ trigger: "runtime_startup" });

  // -- ChatManager
  const chatManager = new ChatManager({
    config: {
      chatRuntimeEnabled: config.chatRuntimeEnabled,
      chatRuntimePollMs: config.chatRuntimePollMs,
      chatRuntimeReadChunkBytes: config.chatRuntimeReadChunkBytes,
      chatRuntimeSeenMessageLimit: config.chatRuntimeSeenMessageLimit,
      chatRuntimeReplyMaxChars: config.chatRuntimeReplyMaxChars,
      chatRuntimeOpenClawInputMaxChars: config.chatRuntimeOpenClawInputMaxChars,
      chatRuntimeUseOpenClaw: config.chatRuntimeUseOpenClaw,
      chatRuntimeReplayOnStart: config.chatRuntimeReplayOnStart,
      chatRuntimeChannelRequireMention: config.chatRuntimeChannelRequireMention,
      chatRuntimeMentionNames: config.chatRuntimeMentionNames,
      chatRuntimeTextStreamEnabled: config.chatRuntimeTextStreamEnabled,
      chatRuntimeTextStreamNativeEnabled: config.chatRuntimeTextStreamNativeEnabled,
      chatRuntimeTextStreamNativeOnly: config.chatRuntimeTextStreamNativeOnly,
      chatRuntimeTextStreamStepChars: config.chatRuntimeTextStreamStepChars,
      chatRuntimeTextStreamStepMs: config.chatRuntimeTextStreamStepMs,
      chatRuntimeTextStreamUpdateMinMs: config.chatRuntimeTextStreamUpdateMinMs,
      chatRuntimeStaleReplyMaxAgeMs: config.chatRuntimeStaleReplyMaxAgeMs,
      chatRuntimeStaleReplyMaxAgeImportantMs:
        config.chatRuntimeStaleReplyMaxAgeImportantMs,
    },
    ipcPaths: {
      chatInboxPath: ipcPaths.chatInboxPath,
      chatRuntimeStatePath: ipcPaths.chatRuntimeStatePath,
    },
    memory: {
      recordWrite: (p: unknown) => memory.recordWrite(p),
      buildContext: (request) => memory.buildContext(request),
    },
    chat: ctx.chat,
    callAgentChatBridge,
    runOpenClawPrompt: async (opts) => {
      const result = await openClawManager.prompt(opts.prompt, {
        purpose: opts.purpose,
        onTextDelta: opts.onTextDelta ?? null,
      });
      return result;
    },
    resolveOpenClawAgentName: () => openClawManager.resolveAgentName(),
    runMemoryCheckpoint: async (opts) => {
      await memory
        .refreshTemporalContext({
          force: opts.force,
          allowAgentCompression: opts.allowAgentCompression,
        })
        .catch(() => {});
    },
  });
  ctx.chatManager = chatManager;

  // -- Console manager (wired up but started by runtime.ts)
  const consoleManager = new ConsoleManager({
    ctx,
    hasInteractivePty,
    ensureSocketBotToken: async (reason: string) => {
      await mintManager.attemptMint(reason).catch(() => {});
      return getBotToken();
    },
    sendHeartbeat: async () => {
      await runBackendCall(
        "agent.heartbeat.mutate",
        () => (trpc as Record<string, any>)?.agent?.heartbeat?.mutate?.({}),
        ctx,
      );
    },
  });
  ctx.consoleManager = consoleManager;

  // -- Record runtime seal
  await memory.recordWrite({
    type: "runtime_command_seal_initialized",
    at: nowIso(),
    runtimeSessionId: ctx.commandSeal.runtimeCommandSessionId,
  });

  // -- Initial mint attempt (if no bootstrap token)
  if (!bootstrapToken) {
    await memory.recordWrite({
      type: "runtime_initial_mint_attempt",
      at: nowIso(),
      reason: "no_bootstrap_token",
    });
    await mintManager.attemptMint("runtime_boot").catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      void memory.recordWrite({
        type: "runtime_initial_mint_failed",
        at: nowIso(),
        error: msg,
      });
    });
  }

  // -- Start
  await startRuntime({
    ctx,
    hasInteractivePty,
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
