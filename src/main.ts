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
import { normalizePermissionStateEvent } from "./ws/permission-event.js";
import { EventsManager } from "./ipc/events-manager.js";
import { DirectiveManager } from "./directives/directive-manager.js";
import { QueueManager } from "./queue/queue-manager.js";
import {
  buildCreditsPermissionState,
  buildGrantState,
  parseGrantCandidatesFromPermissionState,
  type GrantState,
} from "./grants/grant-state.js";
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

const AGENT_KTHX_GUIDE_PATH = "/AGENT-KTHX-v2.md";
const MEDIA_GENERATOR_DEFAULT_BASE_URL = "http://127.0.0.1:4280";
const REQUIRED_PERSONA_FRAME_ROLES = ["selfie", "midshot", "fullbody"] as const;
const VISUAL_SETUP_CHECK_INTERVAL_MS = 60_000;
const VISUAL_SETUP_STATUS_FILE = "visual-setup-status.json";

type VisualSetupNotificationState =
  | "disabled"
  | "not_required"
  | "cooldown"
  | "sent"
  | "delivery_failed"
  | "conversation_unavailable"
  | "owner_missing"
  | "profile_unavailable";

type VisualSetupCheckState = {
  checkedAt: string;
  ready: boolean;
  ownerMainUserId: string | null;
  ownerHandle: string | null;
  hasImage: boolean;
  hasBanner: boolean;
  missingPersonaRoles: string[];
  setupGaps: string[];
  serviceReachable: boolean;
  commandAvailable: boolean;
  notificationState: VisualSetupNotificationState;
};

const parseFirstCommandToken = (command: string): string | null => {
  const match = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(command);
  const token = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
  return token.length > 0 ? token : null;
};

const looksPathLike = (value: string): boolean =>
  value.includes("/") || value.includes("\\") || value.startsWith(".");

const splitPathEntries = (value: string | null | undefined): string[] => {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  return value
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const commandCandidates = (token: string): string[] => {
  if (process.platform !== "win32") return [token];
  const lower = token.toLowerCase();
  if (/\.(?:exe|cmd|bat|com|ps1)$/u.test(lower)) return [token];
  const pathExt = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1";
  const extensions = pathExt
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (!extensions.length) return [token];
  return extensions.map((ext) => `${token}${ext.toLowerCase()}`);
};

const isExecutableFile = async (candidatePath: string): Promise<boolean> => {
  try {
    const stat = await fs.stat(candidatePath);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    await fs.access(candidatePath, 0o1);
    return true;
  } catch {
    return false;
  }
};

const resolveCommandOnPath = async (token: string): Promise<string | null> => {
  const entries = splitPathEntries(process.env.PATH);
  if (!entries.length) return null;
  const candidates = commandCandidates(token);
  for (const dir of entries) {
    for (const candidate of candidates) {
      const fullPath = path.resolve(dir, candidate);
      if (await isExecutableFile(fullPath)) return fullPath;
    }
  }
  return null;
};

const isCommandLikelyAvailable = async (
  commandTemplate: string | null | undefined,
): Promise<boolean> => {
  const template = typeof commandTemplate === "string" ? commandTemplate.trim() : "";
  if (!template.length) return false;
  const token = parseFirstCommandToken(template);
  if (!token) return false;
  if (looksPathLike(token)) {
    return isExecutableFile(path.resolve(token));
  }
  const resolved = await resolveCommandOnPath(token);
  return typeof resolved === "string" && resolved.length > 0;
};

const resolveMediaGeneratorBaseUrlForStartup = (): string => {
  const explicit = trimEnv("MG_AGENT_MEDIA_GENERATOR_BASE_URL");
  if (explicit) {
    return explicit.replace(/\/+$/u, "");
  }
  const portRaw = trimEnv("PW_PORT");
  if (portRaw) {
    const port = Number.parseInt(portRaw, 10);
    if (Number.isFinite(port) && port > 0 && port <= 65535) {
      return `http://127.0.0.1:${port}`;
    }
  }
  return MEDIA_GENERATOR_DEFAULT_BASE_URL;
};

const probeHttpEndpoint = async (
  baseUrl: string,
  timeoutMs = 1500,
): Promise<boolean> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(baseUrl, {
      method: "GET",
      signal: controller.signal,
    });
    return response.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
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
  type AutoPostingAction = "post_media" | "post_text" | "story";
  const AUTO_POSTING_ACTION_KEYS: Record<AutoPostingAction, readonly string[]> = {
    post_media: ["post:post:media", "post:thread:media", "write.createPost"],
    post_text: ["post:post:text", "post:thread:text", "write.createPost"],
    story: ["story", "write.createStory"],
  };
  const autoPostingPlannerEnabled = isEnabledEnvFlag(
    trimEnv("MG_AUTO_POSTING_PLANNER_ENABLED") ?? "1",
  );
  const autoPostingPlannerMinIntervalMs = Math.max(
    5_000,
    Number.parseInt(
      trimEnv("MG_AUTO_POSTING_PLANNER_MIN_INTERVAL_MS") ??
        `${autoCreditPlannerMinIntervalMs}`,
      10,
    ) || autoCreditPlannerMinIntervalMs,
  );
  const autoPostingPlanCooldownMs = Math.max(
    autoPostingPlannerMinIntervalMs,
    Number.parseInt(
      trimEnv("MG_AUTO_POSTING_PLAN_COOLDOWN_MS") ??
        `${Math.max(autoPostingPlannerMinIntervalMs, 60_000)}`,
      10,
    ) || Math.max(autoPostingPlannerMinIntervalMs, 60_000),
  );
  const autoPostingFollowupDelayMs = Math.max(
    autoPostingPlannerMinIntervalMs + 250,
    Number.parseInt(
      trimEnv("MG_AUTO_POSTING_FOLLOWUP_DELAY_MS") ??
        `${autoPostingPlannerMinIntervalMs + 250}`,
      10,
    ) || autoPostingPlannerMinIntervalMs + 250,
  );
  let autoPostingPlanInFlight: Promise<void> | null = null;
  let autoPostingPlanLastAtMs = 0;
  const autoPostingRecentPlans = new Map<string, number>();
  let autoPostingFollowupTimer: ReturnType<typeof setTimeout> | null = null;
  let triggerAutoPostingPlanner:
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
      eventType === "director_credits_added" ||
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
    const permissionStateEvent = normalizePermissionStateEvent(eventType, payload);
    if (permissionStateEvent) {
      ctx.debugSnapshot.permission = permissionStateEvent.permissionState;
      await writeDebugSnapshot(ipcPaths, ctx.debugSnapshot);
      const permissionGrantCandidates = parseGrantCandidatesFromPermissionState(
        permissionStateEvent.permissionState,
      );
      if (permissionGrantCandidates.length > 0) {
        let latestExpiring = permissionGrantCandidates[0]!;
        for (const candidate of permissionGrantCandidates.slice(1)) {
          if (candidate.expiresAtMs > latestExpiring.expiresAtMs) {
            latestExpiring = candidate;
          }
        }
        grantManager.setActiveGrant(latestExpiring);
      } else if (grantManager.isGrantExpired()) {
        grantManager.setActiveGrant(null);
      }
      triggerAutoCreditPlanner?.({
        trigger: permissionStateEvent.trigger,
        permissionState: permissionStateEvent.permissionState,
      });
      triggerAutoPostingPlanner?.({
        trigger: permissionStateEvent.trigger,
        permissionState: permissionStateEvent.permissionState,
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
      const directivePayload: Record<string, unknown> = isRecord(payload.directive)
        ? { ...(payload.directive as Record<string, unknown>) }
        : { ...payload };
      const hasAgentId =
        typeof directivePayload.agentId === "string" &&
        directivePayload.agentId.trim().length > 0;
      if (!hasAgentId) {
        const topicMatch = /^user:([^:]+):director$/iu.exec(
          envelope.topic.trim(),
        );
        const topicAgentId = topicMatch?.[1]?.trim() ?? "";
        if (topicAgentId.length > 0) {
          directivePayload.agentId = topicAgentId;
        }
      }
      try {
        await flushSocketBatchForDirective("directive_intake");
        await ctx.directiveManager?.intake(directivePayload);
      } catch (error: unknown) {
        const directiveIdRaw = directivePayload.id;
        const directiveId =
          typeof directiveIdRaw === "string" && directiveIdRaw.trim().length > 0
            ? directiveIdRaw.trim()
            : null;
        const kindRaw = directivePayload.kind;
        const kind =
          typeof kindRaw === "string" && kindRaw.trim().length > 0
            ? kindRaw.trim()
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
      const directorGrantPayload = payload.grant as Record<string, unknown>;
      await grantManager.persistDirectorGrant(
        directorGrantPayload,
        envelope.receivedAt,
      );
      grantManager.setActiveGrant(
        buildGrantState(directorGrantPayload, envelope.receivedAt),
      );
      triggerAutoCreditPlanner?.({ trigger: "director_grant" });
      triggerAutoPostingPlanner?.({ trigger: "director_grant" });
    }
    if (
      (eventType === "director_credit" && isRecord(payload.credit)) ||
      eventType === "director_credits_added"
    ) {
      const creditPayload =
        eventType === "director_credit"
          ? payload.credit
          : payload;
      if (isRecord(creditPayload)) {
        await grantManager.persistCreditsGrant(
          creditPayload as Record<string, unknown>,
          envelope.receivedAt,
        );
        grantManager.setActiveGrant(
          buildCreditsPermissionState(
            creditPayload as Record<string, unknown>,
            envelope.receivedAt,
          ),
        );
        triggerAutoCreditPlanner?.({ trigger: eventType });
        triggerAutoPostingPlanner?.({ trigger: eventType });
      }
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

  const notifyOwnerImageGeneratorSetupIfNeeded = async (): Promise<VisualSetupCheckState> => {
    const checkedAt = nowIso();
    const notifyEnabled = (trimEnv("MG_AGENT_NOTIFY_IMAGE_SETUP") ?? "1") !== "0";
    const authStateDir = path.join(config.stateDir, "ipc", "auth");
    const noticePath = path.join(authStateDir, "image-generator-setup-notice.json");
    const visualSetupStatusPath = path.join(authStateDir, VISUAL_SETUP_STATUS_FILE);
    const persistVisualSetupStatus = async (
      state: VisualSetupCheckState,
    ): Promise<void> => {
      await fs.mkdir(authStateDir, { recursive: true }).catch(() => {});
      await fs
        .writeFile(
          visualSetupStatusPath,
          `${JSON.stringify(state, null, 2)}\n`,
          "utf8",
        )
        .catch(() => {});
    };

    const imageGenerateCmd = config.imageGenerateCmd ?? ctx.kthxConfig.image.commandTemplate;
    const serviceBaseUrl = resolveMediaGeneratorBaseUrlForStartup();
    const [serviceReachable, commandAvailable] = await Promise.all([
      probeHttpEndpoint(serviceBaseUrl, 1600),
      isCommandLikelyAvailable(imageGenerateCmd),
    ]);

    const profileData = await callAgentChatBridge({ action: "agent_profile" }).catch(
      () => null,
    );
    const agentRecord = isRecord(profileData) && isRecord(profileData.agent)
      ? profileData.agent
      : null;
    const owner = isRecord(profileData) && isRecord(profileData.owner)
      ? profileData.owner
      : null;
    const ownerMainUserId =
      owner && typeof owner.mainUserId === "string"
        ? owner.mainUserId.trim()
        : "";
    const ownerHandle =
      owner && typeof owner.handle === "string"
        ? owner.handle.trim().replace(/^@+/u, "").toLowerCase()
        : null;

    if (!agentRecord) {
      const state: VisualSetupCheckState = {
        checkedAt,
        ready: false,
        ownerMainUserId: ownerMainUserId.length > 0 ? ownerMainUserId : null,
        ownerHandle,
        hasImage: false,
        hasBanner: false,
        missingPersonaRoles: [...REQUIRED_PERSONA_FRAME_ROLES],
        setupGaps: ["agent profile unavailable"],
        serviceReachable,
        commandAvailable,
        notificationState: "profile_unavailable",
      };
      await persistVisualSetupStatus(state);
      return state;
    }

    const hasImage =
      typeof agentRecord.image === "string" &&
      agentRecord.image.trim().length > 0;
    const hasBanner =
      typeof agentRecord.banner === "string" &&
      agentRecord.banner.trim().length > 0;
    const requiredRoleSet = new Set<string>(REQUIRED_PERSONA_FRAME_ROLES);
    const missingPersonaRoles = (() => {
      const personaSetup = isRecord(agentRecord.personaSetup)
        ? agentRecord.personaSetup
        : null;
      const rawMissingRoles = personaSetup && Array.isArray(personaSetup.missingRoles)
        ? personaSetup.missingRoles
        : [];
      return rawMissingRoles
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim().toLowerCase())
        .filter((value) => requiredRoleSet.has(value));
    })();
    const setupGaps: string[] = [];
    if (!hasImage) setupGaps.push("avatar image missing");
    if (!hasBanner) setupGaps.push("banner image missing");
    if (missingPersonaRoles.length > 0) {
      setupGaps.push(`persona frames missing (${missingPersonaRoles.join(", ")})`);
    }
    if (!serviceReachable && !commandAvailable) {
      setupGaps.push("image generator unavailable / browser login not completed");
    }

    const pendingStateBase: Omit<VisualSetupCheckState, "notificationState"> = {
      checkedAt,
      ready: setupGaps.length === 0,
      ownerMainUserId: ownerMainUserId.length > 0 ? ownerMainUserId : null,
      ownerHandle,
      hasImage,
      hasBanner,
      missingPersonaRoles,
      setupGaps,
      serviceReachable,
      commandAvailable,
    };

    if (pendingStateBase.ready) {
      await fs.rm(noticePath, { force: true }).catch(() => {});
      await memory
        .recordWrite({
          type: "image_generator_setup_complete",
          at: checkedAt,
          ownerMainUserId: pendingStateBase.ownerMainUserId,
          ownerHandle,
          serviceReachable,
          commandAvailable,
        })
        .catch(() => {});
      const state: VisualSetupCheckState = {
        ...pendingStateBase,
        notificationState: "not_required",
      };
      await persistVisualSetupStatus(state);
      return state;
    }

    if (!notifyEnabled) {
      const state: VisualSetupCheckState = {
        ...pendingStateBase,
        notificationState: "disabled",
      };
      await persistVisualSetupStatus(state);
      return state;
    }

    if (!ownerMainUserId.length) {
      const state: VisualSetupCheckState = {
        ...pendingStateBase,
        notificationState: "owner_missing",
      };
      await persistVisualSetupStatus(state);
      return state;
    }

    const reminderIntervalMs = (() => {
      const raw = trimEnv("MG_AGENT_SETUP_REMINDER_INTERVAL_MS");
      if (!raw) return 15 * 60_000;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed)) return 15 * 60_000;
      return Math.max(60_000, Math.min(24 * 60 * 60 * 1000, parsed));
    })();
    const existingNotice = await fs
      .readFile(noticePath, "utf8")
      .then((raw) => JSON.parse(raw) as unknown)
      .catch(() => null);
    const previousSignature =
      isRecord(existingNotice) && typeof existingNotice.missingSignature === "string"
        ? existingNotice.missingSignature
        : "";
    const lastNotifiedAtRaw =
      isRecord(existingNotice) && typeof existingNotice.lastNotifiedAt === "string"
        ? existingNotice.lastNotifiedAt
        : isRecord(existingNotice) && typeof existingNotice.sentAt === "string"
          ? existingNotice.sentAt
          : "";
    const lastNotifiedAtMs = (() => {
      if (!lastNotifiedAtRaw.trim().length) return null;
      const parsed = Date.parse(lastNotifiedAtRaw);
      return Number.isFinite(parsed) ? parsed : null;
    })();
    const missingSignature = [
      hasImage ? "image:ok" : "image:missing",
      hasBanner ? "banner:ok" : "banner:missing",
      `persona_missing:${missingPersonaRoles.join(",") || "none"}`,
      serviceReachable ? "service:http_ok" : "service:http_missing",
      commandAvailable ? "service:cmd_ok" : "service:cmd_missing",
    ].join("|");
    const shouldNotifyByTime =
      lastNotifiedAtMs === null || Date.now() - lastNotifiedAtMs >= reminderIntervalMs;
    const shouldNotifyByChange = missingSignature !== previousSignature;
    if (!shouldNotifyByTime && !shouldNotifyByChange) {
      const state: VisualSetupCheckState = {
        ...pendingStateBase,
        notificationState: "cooldown",
      };
      await persistVisualSetupStatus(state);
      return state;
    }

    const openDmData = await callAgentChatBridge({
      action: "open_dm",
      otherMainUserId: ownerMainUserId,
    }).catch(() => null);
    const conversationId = (() => {
      if (!isRecord(openDmData)) return null;
      const directId =
        typeof openDmData.id === "string" ? openDmData.id.trim() : "";
      if (directId.length > 0) return directId;
      const directConversationId =
        typeof openDmData.conversationId === "string"
          ? openDmData.conversationId.trim()
          : "";
      if (directConversationId.length > 0) return directConversationId;
      const nestedConversation =
        isRecord(openDmData.conversation) ? openDmData.conversation : null;
      if (
        nestedConversation &&
        typeof nestedConversation.id === "string" &&
        nestedConversation.id.trim().length > 0
      ) {
        return nestedConversation.id.trim();
      }
      return null;
    })();
    if (!conversationId) {
      const state: VisualSetupCheckState = {
        ...pendingStateBase,
        notificationState: "conversation_unavailable",
      };
      await persistVisualSetupStatus(state);
      return state;
    }

    const guideUrl = `${chatApiBaseUrl}${AGENT_KTHX_GUIDE_PATH}`;
    const setupMessage = [
      `Heads up${ownerHandle ? ` @${ownerHandle}` : ""}: required visual setup is still incomplete.`,
      `Missing right now: ${setupGaps.join("; ")}.`,
      `Guide source (AGENT-KTHX markdown): ${guideUrl}.`,
      `Store/update it at: \`${agentGuideLocalPath}\`.`,
      `Quick fetch command: \`curl -fsSL ${guideUrl} -o ${agentGuideLocalPath}\`.`,
      !serviceReachable && !commandAvailable
        ? "Image generator is not ready yet. Install/start it from the guide, then complete the first browser OpenAI login."
        : "Image generator looks reachable. Next step: generate avatar, banner, and persona reference frames (selfie, midshot, fullbody).",
      "This reminder will continue until avatar, banner, and persona setup are complete.",
    ].join(" ");

    const delivered = await callAgentChatBridge({
      action: "send_message",
      conversationId,
      body: setupMessage,
      format: "markdown",
      metadata: {
        automated: true,
        sourceContext: "SYSTEM",
        setupEvent: "image_persona_setup_required",
        requiredPersonaFrameRoles: REQUIRED_PERSONA_FRAME_ROLES,
        missingPersonaFrameRoles: missingPersonaRoles,
        hasImage,
        hasBanner,
        serviceReachable,
        commandAvailable,
      },
    })
      .then(() => true)
      .catch(() => false);
    if (!delivered) {
      const state: VisualSetupCheckState = {
        ...pendingStateBase,
        notificationState: "delivery_failed",
      };
      await persistVisualSetupStatus(state);
      return state;
    }

    await fs.mkdir(path.dirname(noticePath), { recursive: true }).catch(() => {});
    await fs
      .writeFile(
        noticePath,
        `${JSON.stringify(
          {
            lastNotifiedAt: checkedAt,
            missingSignature,
            setupGaps,
            ownerMainUserId,
            ownerHandle,
            conversationId,
            serviceBaseUrl,
            imageGenerateCmdPreview: imageGenerateCmd?.slice(0, 220) ?? null,
            hasImage,
            hasBanner,
            missingPersonaRoles,
            requiredPersonaFrameRoles: REQUIRED_PERSONA_FRAME_ROLES,
            serviceReachable,
            commandAvailable,
            notificationState: "sent",
          },
          null,
          2,
        )}\n`,
        "utf8",
      )
      .catch(() => {});

    await memory
      .recordWrite({
        type: "image_generator_setup_owner_notified",
        at: checkedAt,
        ownerMainUserId,
        ownerHandle,
        conversationId,
        serviceBaseUrl,
        hasImage,
        hasBanner,
        missingPersonaRoles,
        serviceReachable,
        commandAvailable,
      })
      .catch(() => {});

    const state: VisualSetupCheckState = {
      ...pendingStateBase,
      notificationState: "sent",
    };
    await persistVisualSetupStatus(state);
    return state;
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

  const scheduleAutoPostingPlannerFollowup = (trigger: string): void => {
    if (!autoPostingPlannerEnabled) return;
    if (autoPostingFollowupTimer) return;
    autoPostingFollowupTimer = setTimeout(() => {
      autoPostingFollowupTimer = null;
      triggerAutoPostingPlanner?.({ trigger });
    }, autoPostingFollowupDelayMs);
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
      const grantCandidates = resolveGrantCandidates(permissionState);
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
        const postRecord = isRecord(value.post) ? value.post : null;
        const postId =
          parsePositiveInt(value.id) ??
          parsePositiveInt(value.postId) ??
          parsePositiveInt(value.targetPostId) ??
          (postRecord ? parsePositiveInt(postRecord.id) ?? parsePositiveInt(postRecord.postId) : null);
        if (!postId) return null;
        const commentId =
          parsePositiveInt(value.commentId) ??
          parsePositiveInt(value.parentId) ??
          parsePositiveInt(value.targetCommentId) ??
          (postRecord ? parsePositiveInt(postRecord.commentId) : null);
        const author = isRecord(value.author) ? value.author : null;
        const postAuthor = postRecord && isRecord(postRecord.author) ? postRecord.author : null;
        const userRecord = isRecord(value.user) ? value.user : null;
        const authorId =
          (typeof value.authorId === "string" && value.authorId.trim().length > 0
            ? value.authorId.trim()
            : null) ??
          (typeof author?.mainUserId === "string" && author.mainUserId.trim().length > 0
            ? author.mainUserId.trim()
            : null) ??
          (typeof author?.id === "string" && author.id.trim().length > 0
            ? author.id.trim()
            : null) ??
          (typeof postRecord?.authorId === "string" && postRecord.authorId.trim().length > 0
            ? postRecord.authorId.trim()
            : null) ??
          (typeof postAuthor?.mainUserId === "string" && postAuthor.mainUserId.trim().length > 0
            ? postAuthor.mainUserId.trim()
            : null) ??
          (typeof postAuthor?.id === "string" && postAuthor.id.trim().length > 0
            ? postAuthor.id.trim()
            : null) ??
          (typeof userRecord?.mainUserId === "string" && userRecord.mainUserId.trim().length > 0
            ? userRecord.mainUserId.trim()
            : null) ??
          (typeof userRecord?.id === "string" && userRecord.id.trim().length > 0
            ? userRecord.id.trim()
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
      const resolveAuthorIdFromPostRecord = (record: Record<string, unknown>): string | null => {
        const author = isRecord(record.author) ? record.author : null;
        return (
          (typeof record.authorId === "string" && record.authorId.trim().length > 0
            ? record.authorId.trim()
            : null) ??
          (typeof author?.mainUserId === "string" && author.mainUserId.trim().length > 0
            ? author.mainUserId.trim()
            : null) ??
          (typeof author?.id === "string" && author.id.trim().length > 0
            ? author.id.trim()
            : null)
        );
      };
      const resolveFindPostAuthorId = (value: unknown, postId: number): string | null => {
        if (!isRecord(value)) return null;
        if (isRecord(value.data)) {
          const nested = resolveFindPostAuthorId(value.data, postId);
          if (nested) return nested;
        }
        if (isRecord(value.post)) {
          const id =
            parsePositiveInt(value.post.id) ??
            parsePositiveInt(value.post.postId);
          if (id === postId) {
            return resolveAuthorIdFromPostRecord(value.post);
          }
        }
        if (Array.isArray(value.items)) {
          for (const entry of value.items) {
            if (!isRecord(entry)) continue;
            const id =
              parsePositiveInt(entry.id) ??
              parsePositiveInt(entry.postId);
            if (id !== postId) continue;
            const resolved = resolveAuthorIdFromPostRecord(entry);
            if (resolved) return resolved;
          }
        }
        const rootId = parsePositiveInt(value.id) ?? parsePositiveInt(value.postId);
        if (rootId === postId) {
          return resolveAuthorIdFromPostRecord(value);
        }
        return null;
      };
      const resolveFindCommentAuthorId = (
        value: unknown,
        postId: number,
        commentId: number,
      ): string | null => {
        if (!isRecord(value)) return null;
        if (isRecord(value.data)) {
          const nested = resolveFindCommentAuthorId(value.data, postId, commentId);
          if (nested) return nested;
        }
        const readAuthorId = (record: Record<string, unknown>): string | null => {
          const author = isRecord(record.author) ? record.author : null;
          return (
            (typeof record.authorId === "string" && record.authorId.trim().length > 0
              ? record.authorId.trim()
              : null) ??
            (typeof author?.mainUserId === "string" && author.mainUserId.trim().length > 0
              ? author.mainUserId.trim()
              : null) ??
            (typeof author?.id === "string" && author.id.trim().length > 0
              ? author.id.trim()
              : null)
          );
        };
        if (isRecord(value.comment)) {
          const rowPostId = parsePositiveInt(value.comment.postId);
          const rowCommentId =
            parsePositiveInt(value.comment.commentId) ??
            parsePositiveInt(value.comment.id);
          if (rowPostId === postId && rowCommentId === commentId) {
            return readAuthorId(value.comment);
          }
        }
        if (Array.isArray(value.comments)) {
          for (const entry of value.comments) {
            if (!isRecord(entry)) continue;
            const rowPostId = parsePositiveInt(entry.postId);
            const rowCommentId =
              parsePositiveInt(entry.commentId) ??
              parsePositiveInt(entry.id);
            if (rowPostId !== postId || rowCommentId !== commentId) continue;
            const resolved = readAuthorId(entry);
            if (resolved) return resolved;
          }
        }
        const rootPostId = parsePositiveInt(value.postId);
        const rootCommentId =
          parsePositiveInt(value.commentId) ??
          parsePositiveInt(value.id);
        if (rootPostId === postId && rootCommentId === commentId) {
          return readAuthorId(value);
        }
        return null;
      };
      const normalizeInterestTag = (value: unknown): string | null => {
        if (typeof value !== "string") return null;
        const normalized = value
          .trim()
          .toLowerCase()
          .replace(/^#+/u, "")
          .replace(/[^a-z0-9_-]+/gu, "-")
          .replace(/-+/gu, "-")
          .replace(/^-+|-+$/gu, "")
          .slice(0, 40);
        return normalized.length >= 2 ? normalized : null;
      };

      let agentMainUserId: string | null = null;
      let interestTags: string[] = [];
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
        interestTags = Array.from(
          new Set(
            [
              ...(Array.isArray(agentRecord.preferredTags)
                ? agentRecord.preferredTags
                : []),
              ...(Array.isArray(profileData.preferredTags)
                ? profileData.preferredTags
                : []),
              ...(isRecord(profileData.config) && Array.isArray(profileData.config.preferredTags)
                ? profileData.config.preferredTags
                : []),
            ]
              .map((value) => normalizeInterestTag(value))
              .filter((value): value is string => Boolean(value)),
          ),
        ).slice(0, 8);
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
        const targetCommentId =
          parsePositiveInt(mention.targetCommentId) ??
          parsePositiveInt(mention.commentId) ??
          parsePositiveInt(mention.parentId);
        pushTarget({
          postId: targetId,
          commentId: targetCommentId ?? null,
          authorId: null,
          source: "unanswered_mention",
        });
      }

      const [homeData, trendingData, exploreData, interestTrendingData, interestExploreData] = await Promise.all([
        callAgentChatBridge({ action: "browse_home_feed", limit: 24 }).catch(() => null),
        callAgentChatBridge({ action: "browse_trending", limit: 24 }).catch(() => null),
        callAgentChatBridge({ action: "browse_posts", limit: 24 }).catch(() => null),
        interestTags.length > 0
          ? callAgentChatBridge({
              action: "browse_trending",
              limit: 24,
              tags: interestTags.slice(0, 8),
            }).catch(() => null)
          : Promise.resolve(null),
        interestTags.length > 0
          ? callAgentChatBridge({
              action: "browse_posts",
              limit: 24,
              tags: interestTags.slice(0, 8),
            }).catch(() => null)
          : Promise.resolve(null),
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
      for (const item of parseRecordItems(interestTrendingData)) {
        pushTarget(parsePostTarget(item, "interest_trending"));
      }
      for (const item of parseRecordItems(interestExploreData)) {
        pushTarget(parsePostTarget(item, "interest_explore"));
      }

      const unresolvedTargets = targets.filter((entry) => !entry.authorId).slice(0, 36);
      if (unresolvedTargets.length > 0) {
        const resolvedAuthorByTarget = new Map<string, string>();
        await Promise.all(
          unresolvedTargets.map(async (target) => {
            const response = await callAgentChatBridge({
              action: "find_post",
              postId: target.postId,
            }).catch(() => null);
            const resolvedAuthorId = resolveFindPostAuthorId(response, target.postId);
            if (!resolvedAuthorId) return;
            resolvedAuthorByTarget.set(
              `${target.postId}:${target.commentId ?? 0}`,
              resolvedAuthorId,
            );
          }),
        );
        if (resolvedAuthorByTarget.size > 0) {
          for (const target of targets) {
            if (target.authorId) continue;
            const key = `${target.postId}:${target.commentId ?? 0}`;
            const resolvedAuthorId = resolvedAuthorByTarget.get(key);
            if (!resolvedAuthorId) continue;
            target.authorId = resolvedAuthorId;
            if (!target.source.includes("+hydrated")) {
              target.source = `${target.source}+hydrated`;
            }
          }
        }
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
      const knownNonOwnTargets = agentMainUserId
        ? targets.filter((entry) => entry.authorId !== null && entry.authorId !== agentMainUserId)
        : targets.slice();
      const unknownAuthorTargets = agentMainUserId
        ? targets.filter((entry) => entry.authorId === null)
        : [];
      const nonOwnTargets = agentMainUserId
        ? knownNonOwnTargets.length > 0
          ? knownNonOwnTargets
          : unknownAuthorTargets
        : targets.slice();
      const ownReplyCommentCandidates = ownTargets.filter(
        (entry): entry is AutoCreditPostTarget & { commentId: number } =>
          typeof entry.commentId === "number" && entry.commentId > 0,
      );
      const ownReplyAuthorByTargetKey = new Map<string, string | null>();
      await Promise.all(
        ownReplyCommentCandidates.map(async (entry) => {
          const response = await callAgentChatBridge({
            action: "find_comment",
            postId: entry.postId,
            commentId: entry.commentId,
          }).catch(() => null);
          const authorId = resolveFindCommentAuthorId(response, entry.postId, entry.commentId);
          ownReplyAuthorByTargetKey.set(
            `${entry.postId}:${entry.commentId}`,
            authorId,
          );
        }),
      );
      const ownReplyTargets = ownReplyCommentCandidates.filter((entry) => {
        const key = `${entry.postId}:${entry.commentId}`;
        const parentAuthorId = ownReplyAuthorByTargetKey.get(key) ?? null;
        if (agentMainUserId && parentAuthorId === agentMainUserId) {
          return false;
        }
        if (!parentAuthorId) {
          return entry.source.startsWith("unanswered_mention");
        }
        return true;
      });
      const commentTargets = (
        nonOwnTargets.length > 0 ? [...nonOwnTargets, ...ownReplyTargets] : ownReplyTargets
      ).sort((left, right) => {
        const score = (entry: AutoCreditPostTarget): number => {
          const isOwnReply =
            agentMainUserId !== null &&
            entry.authorId === agentMainUserId &&
            typeof entry.commentId === "number" &&
            entry.commentId > 0;
          if (isOwnReply) return 0;
          const isMentionSource = entry.source.startsWith("unanswered_mention");
          if (isMentionSource && typeof entry.commentId === "number" && entry.commentId > 0) {
            return 1;
          }
          if (isMentionSource) return 2;
          if (typeof entry.commentId === "number" && entry.commentId > 0) return 3;
          if (entry.source.startsWith("interest_")) return 4;
          if (entry.source === "home_feed") return 5;
          if (entry.source === "trending") return 6;
          if (entry.source === "explore") return 7;
          return 8;
        };
        const rankDelta = score(left) - score(right);
        if (rankDelta !== 0) return rankDelta;
        if ((right.commentId ?? 0) !== (left.commentId ?? 0)) {
          return (right.commentId ?? 0) - (left.commentId ?? 0);
        }
        return right.postId - left.postId;
      });
      const engagementTargets = nonOwnTargets;

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
        nonOwnTargetPoolSize: nonOwnTargets.length,
        unknownAuthorTargetPoolSize: unknownAuthorTargets.length,
        commentTargetPoolSize: commentTargets.length,
        interestTags,
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

  triggerAutoPostingPlanner = (opts: {
    trigger: string;
    permissionState?: unknown;
  }) => {
    if (!autoPostingPlannerEnabled) return;
    if (!ctx.directiveManager) return;
    if (ctx.queueManager && !ctx.queueManager.isRunnerEnabled()) return;
    const nowMs = Date.now();
    if (autoPostingPlanInFlight) return;
    if (nowMs - autoPostingPlanLastAtMs < autoPostingPlannerMinIntervalMs) return;

    autoPostingPlanInFlight = (async () => {
      const permissionState = opts.permissionState ?? ctx.debugSnapshot.permission;
      const grantCandidates = resolveGrantCandidates(permissionState);
      if (!grantCandidates.length) return;

      const now = Date.now();
      const availableForAction = (
        grant: GrantState,
        keys: readonly string[],
      ): {
        available: number;
        notBeforeBlocked: number;
        earliestNotBeforeAtMs: number | null;
      } => {
        let available = 0;
        let notBeforeBlocked = 0;
        let earliestNotBeforeAtMs: number | null = null;
        for (const key of keys) {
          const actionState = grant.actions.get(key);
          if (!actionState || actionState.remainingCount <= 0) continue;
          const notBeforeAtMs =
            typeof actionState.notBeforeAtMs === "number" &&
            Number.isFinite(actionState.notBeforeAtMs)
              ? actionState.notBeforeAtMs
              : grant.issuedAtMs + actionState.notBeforeSeconds * 1000;
          if (notBeforeAtMs > now) {
            notBeforeBlocked += actionState.remainingCount;
            if (earliestNotBeforeAtMs === null || notBeforeAtMs < earliestNotBeforeAtMs) {
              earliestNotBeforeAtMs = notBeforeAtMs;
            }
            continue;
          }
          available += actionState.remainingCount;
        }
        return {
          available,
          notBeforeBlocked,
          earliestNotBeforeAtMs,
        };
      };

      let selected:
        | {
            action: AutoPostingAction;
            grantId: string | null;
            available: number;
          }
        | null = null;
      const actionPriority: AutoPostingAction[] = ["post_media", "post_text", "story"];
      const availableByAction: Record<AutoPostingAction, number> = {
        post_media: 0,
        post_text: 0,
        story: 0,
      };
      const notBeforeBlockedByAction: Record<AutoPostingAction, number> = {
        post_media: 0,
        post_text: 0,
        story: 0,
      };
      let cooldownBlocked = 0;
      let earliestNotBeforeAtMs: number | null = null;
      for (const candidate of grantCandidates) {
        if (candidate.expiresAtMs <= now) continue;
        const grantId = candidate.id.trim().length > 0 ? candidate.id.trim() : null;
        for (const action of actionPriority) {
          const availability = availableForAction(candidate, AUTO_POSTING_ACTION_KEYS[action]);
          const available = availability.available;
          availableByAction[action] += available;
          notBeforeBlockedByAction[action] += availability.notBeforeBlocked;
          if (
            availability.earliestNotBeforeAtMs !== null &&
            (earliestNotBeforeAtMs === null || availability.earliestNotBeforeAtMs < earliestNotBeforeAtMs)
          ) {
            earliestNotBeforeAtMs = availability.earliestNotBeforeAtMs;
          }
          if (available <= 0) continue;
          const dedupeKey = `${action}:${grantId ?? "none"}`;
          const lastPlannedAt = autoPostingRecentPlans.get(dedupeKey) ?? 0;
          if (now - lastPlannedAt < autoPostingPlanCooldownMs) {
            cooldownBlocked += 1;
            continue;
          }
          selected = {
            action,
            grantId,
            available,
          };
          break;
        }
        if (selected) break;
      }

      if (!selected) {
        const totalAvailable =
          availableByAction.post_media + availableByAction.post_text + availableByAction.story;
        const totalNotBeforeBlocked =
          notBeforeBlockedByAction.post_media +
          notBeforeBlockedByAction.post_text +
          notBeforeBlockedByAction.story;
        const reason =
          totalAvailable > 0
            ? cooldownBlocked > 0
              ? "cooldown"
              : "no_plan_targets"
            : totalNotBeforeBlocked > 0
              ? "not_before"
              : "no_posting_window";
        await memory.recordWrite({
          type: "auto_posting_planner_skipped",
          at: nowIso(),
          trigger: opts.trigger,
          reason,
          availableByAction,
          notBeforeBlockedByAction,
          cooldownBlocked,
          grantCandidateCount: grantCandidates.length,
          ...(earliestNotBeforeAtMs !== null
            ? { nextReadyAt: new Date(earliestNotBeforeAtMs).toISOString() }
            : {}),
        }).catch(() => {});
        return;
      }

      const directiveId = `auto_post_${selected.action}_${Date.now().toString(36)}_${crypto
        .randomUUID()
        .replaceAll("-", "")
        .slice(0, 12)}`;
      const directivePayloadBase: Record<string, unknown> = {
        id: directiveId,
        kind: "brain.generateAndQueue",
        createdAt: nowIso(),
        ...(selected.grantId ? { grantId: selected.grantId } : {}),
        forceNow: true,
      };
      const payloadByAction: Record<AutoPostingAction, Record<string, unknown>> = {
        post_media: {
          goal: "post",
          kind: "media",
          kinds: ["media"],
          mediaPersonaLock: true,
          generatedAssetType: "image",
          forceNow: true,
          provenance: "runtime_auto_posting",
          requireExplicitPublishVerb: false,
          explicitPublishRequested: false,
          directiveScope: {
            allowedCommandKinds: ["write.createPost"],
          },
          autoPlanned: {
            trigger: opts.trigger,
            source: "posting_window_media",
          },
        },
        post_text: {
          goal: "post",
          kind: "thread",
          kinds: ["thread"],
          forceNow: true,
          provenance: "runtime_auto_posting",
          requireExplicitPublishVerb: false,
          explicitPublishRequested: false,
          directiveScope: {
            allowedCommandKinds: ["write.createPost"],
          },
          autoPlanned: {
            trigger: opts.trigger,
            source: "posting_window_text",
          },
        },
        story: {
          goal: "story",
          kind: "story",
          kinds: ["story"],
          forceNow: true,
          provenance: "runtime_auto_posting",
          requireExplicitPublishVerb: false,
          explicitPublishRequested: false,
          directiveScope: {
            allowedCommandKinds: ["write.createStory"],
          },
          autoPlanned: {
            trigger: opts.trigger,
            source: "posting_window_story",
          },
        },
      };
      await ctx.directiveManager?.intake({
        ...directivePayloadBase,
        payload: payloadByAction[selected.action],
      });
      const dedupeKey = `${selected.action}:${selected.grantId ?? "none"}`;
      autoPostingRecentPlans.set(dedupeKey, Date.now());
      const cutoff = Date.now() - autoPostingPlanCooldownMs;
      for (const [key, seenAt] of autoPostingRecentPlans) {
        if (seenAt < cutoff) autoPostingRecentPlans.delete(key);
      }
      await memory.recordWrite({
        type: "auto_posting_planner_enqueued",
        at: nowIso(),
        trigger: opts.trigger,
        action: selected.action,
        grantId: selected.grantId,
        available: selected.available,
        availableByAction,
        directiveId,
      }).catch(() => {});
      if (selected.available > 1) {
        scheduleAutoPostingPlannerFollowup("auto_posting_followup");
      }
    })()
      .catch(async (error: unknown) => {
        await memory.recordWrite({
          type: "auto_posting_planner_failed",
          at: nowIso(),
          trigger: opts.trigger,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {});
      })
      .finally(() => {
        autoPostingPlanLastAtMs = Date.now();
        autoPostingPlanInFlight = null;
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
      pendingDir: ipcPaths.pendingDir,
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
    promotePendingDirectives: async (input) => {
      if (!ctx.directiveManager) {
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
      return ctx.directiveManager.promoteFromPending({
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
  const triggerStartupAutoPlanners = (): void => {
    triggerAutoCreditPlanner?.({ trigger: "runtime_startup" });
    triggerAutoPostingPlanner?.({ trigger: "runtime_startup" });
  };

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

  const visualSetupEnforcementEnabled =
    (trimEnv("MG_AGENT_ENFORCE_VISUAL_SETUP") ?? "1") !== "0";
  let startupAutoPlannersTriggered = false;
  const runStartupAutoPlannersOnce = (reason: string): void => {
    if (startupAutoPlannersTriggered) return;
    startupAutoPlannersTriggered = true;
    triggerStartupAutoPlanners();
    void memory
      .recordWrite({
        type: "runtime_startup_auto_planners_triggered",
        at: nowIso(),
        reason,
      })
      .catch(() => {});
  };
  if (visualSetupEnforcementEnabled) {
    const initialVisualSetupState = await notifyOwnerImageGeneratorSetupIfNeeded().catch(
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        void memory.recordWrite({
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
      void memory
        .recordWrite({
          type: "visual_setup_pending_runtime_startup",
          at: nowIso(),
          visualSetupReady: false,
          notificationState: initialVisualSetupState?.notificationState ?? "profile_unavailable",
          setupGaps: initialVisualSetupState?.setupGaps ?? ["agent profile unavailable"],
        })
        .catch(() => {});
    }
    setInterval(() => {
      void notifyOwnerImageGeneratorSetupIfNeeded()
        .then((state) => {
          if (state.ready) {
            runStartupAutoPlannersOnce("visual_setup_ready_after_reminder");
          }
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          void memory.recordWrite({
            type: "image_generator_setup_owner_notify_failed",
            at: nowIso(),
            error: message,
          });
        });
    }, VISUAL_SETUP_CHECK_INTERVAL_MS);
  } else {
    runStartupAutoPlannersOnce("visual_setup_enforcement_disabled");
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
