/**
 * Runtime configuration builder.
 *
 * Ported from agent-runtime.mjs lines 3320-3583 (createRuntimeConfig).
 * Reads ~80+ environment variables and returns a complete RuntimeConfig.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import type { RuntimeConfig } from "~/types/config.js";
import {
  trimEnv,
  requiredEnv,
  parseIntEnv,
  parseBoundedIntEnv,
  parseCsvEnv,
} from "~/lib/env-parse.js";

// ---------------------------------------------------------------------------
// Hash extension normalization
// ---------------------------------------------------------------------------

const RUNTIME_HASH_DEFAULT_EXTENSIONS = new Set([
  ".mjs",
  ".js",
  ".cjs",
  ".json",
  ".md",
  ".ps1",
  ".sh",
]);

const parseRuntimeHashExtensions = (rawValues: string[]): Set<string> => {
  const values = Array.isArray(rawValues) ? rawValues : [];
  if (!values.length) return new Set(RUNTIME_HASH_DEFAULT_EXTENSIONS);
  const normalized = values
    .map((value) => value.trim().toLowerCase())
    .map((value) => (value.startsWith(".") ? value : `.${value}`))
    .filter((value) => /^[.a-z0-9_-]{2,16}$/u.test(value));
  return normalized.length
    ? new Set(normalized)
    : new Set(RUNTIME_HASH_DEFAULT_EXTENSIONS);
};

// ---------------------------------------------------------------------------
// Default home directory
// ---------------------------------------------------------------------------

const DEFAULT_KTHX_HOME_DIR = path.resolve(process.cwd(), "kthx-agents");

// ---------------------------------------------------------------------------
// createRuntimeConfig
// ---------------------------------------------------------------------------

export const createRuntimeConfig = (): RuntimeConfig => {
  const runtimeFilePath = path.resolve(fileURLToPath(import.meta.url));
  const runtimeRootDir = path.dirname(runtimeFilePath);

  const agentHomeDir = trimEnv("MG_AGENT_HOME_DIR")
    ? path.resolve(trimEnv("MG_AGENT_HOME_DIR") ?? DEFAULT_KTHX_HOME_DIR)
    : DEFAULT_KTHX_HOME_DIR;

  const cwdStateDir = path.join(agentHomeDir, "state");
  const stateDir = trimEnv("MG_AGENT_STATE_DIR")
    ? path.resolve(trimEnv("MG_AGENT_STATE_DIR") ?? cwdStateDir)
    : cwdStateDir;

  const kthxConfigPath = trimEnv("MG_AGENT_KTHX_CONFIG_PATH")
    ? path.resolve(
        trimEnv("MG_AGENT_KTHX_CONFIG_PATH") ??
          path.join(agentHomeDir, "config.json"),
      )
    : path.join(agentHomeDir, "config.json");

  const connectionId =
    trimEnv("MG_REALTIME_CONNECTION_ID") ?? `agent-${Date.now()}`;

  // -- boolean flags --------------------------------------------------------
  const subscribeGlobalFeed =
    (trimEnv("MG_AGENT_SUBSCRIBE_GLOBAL_FEED") ?? "1") !== "0";
  const subscribeActivityFeed =
    (trimEnv("MG_AGENT_SUBSCRIBE_ACTIVITY_FEED") ?? "1") !== "0";
  const autoSubscribeLenses =
    (trimEnv("MG_AGENT_AUTO_SUBSCRIBE_LENSES") ?? "1") !== "0";
  const consoleEnabled =
    (trimEnv("MG_AGENT_CONSOLE") ?? "0") === "1";
  const consoleAllowNonTty =
    (trimEnv("MG_AGENT_CONSOLE_ALLOW_NON_TTY") ?? "0") === "1";
  const autoRequestGrantOnDefer =
    (trimEnv("MG_AGENT_AUTO_REQUEST_GRANT") ?? "0") !== "0";
  const mintConsoleDebugEnabled =
    (trimEnv("MG_AGENT_MINT_CONSOLE_DEBUG") ?? "1") !== "0";
  // Mint challenge fallback paths were removed; challenge solving is now OpenClaw-only.
  // Keep this effectively enabled even if stale env files still set "0".
  const mintChallengeUseOpenClaw = true;
  const rejectMultipleChoiceChallenges =
    (trimEnv("MG_AGENT_REJECT_MULTIPLE_CHOICE_CHALLENGE") ?? "0") === "1";
  const mintChallengeAutoRetryEnabled =
    (trimEnv("MG_AGENT_MINT_CHALLENGE_AUTO_RETRY") ?? "1") !== "0";
  const allowSyntheticMediaFallback =
    (trimEnv("MG_AGENT_ALLOW_SYNTHETIC_MEDIA_FALLBACK") ?? "1") !== "0";
  const backendSerializeRequests =
    (trimEnv("MG_AGENT_BACKEND_SERIALIZE") ?? "1") !== "0";
  const backendRequestDebug =
    (trimEnv("MG_AGENT_BACKEND_DEBUG") ?? "0") === "1";
  const eventsResetOnStart =
    (trimEnv("MG_AGENT_EVENTS_RESET_ON_START") ?? "1") !== "0";
  const queueRunnerDefaultEnabled =
    (trimEnv("MG_AGENT_QUEUE_RUNNER_ENABLED") ?? "1") !== "0";

  // -- chat runtime ---------------------------------------------------------
  const chatRuntimeEnabled =
    (trimEnv("MG_CHAT_RUNTIME_ENABLED") ?? "1") !== "0";
  const chatRuntimeUseOpenClaw =
    (trimEnv("MG_CHAT_RUNTIME_USE_OPENCLAW") ?? "1") !== "0";
  const chatRuntimeReplayOnStart =
    (trimEnv("MG_CHAT_RUNTIME_REPLAY_ON_START") ?? "0") === "1";
  const chatRuntimeChannelRequireMention =
    (trimEnv("MG_CHAT_RUNTIME_CHANNEL_REQUIRE_MENTION") ?? "1") !== "0";
  const chatRuntimeTextStreamEnabled =
    (trimEnv("MG_CHAT_RUNTIME_TEXT_STREAM_ENABLED") ?? "1") !== "0";
  const chatRuntimeTextStreamNativeEnabled =
    (trimEnv("MG_CHAT_RUNTIME_TEXT_STREAM_NATIVE_ENABLED") ?? "0") !== "0";
  const chatRuntimeTextStreamNativeOnly =
    (trimEnv("MG_CHAT_RUNTIME_TEXT_STREAM_NATIVE_ONLY") ?? "0") === "1";

  // -- openclaw wake --------------------------------------------------------
  const openClawWakeIncludeSocketStateChange =
    (trimEnv("MG_OPENCLAW_WAKE_INCLUDE_SOCKET_STATE_CHANGE") ?? "1") !== "0";
  const openClawWakeIncludeMediaPrepared =
    (trimEnv("MG_OPENCLAW_WAKE_INCLUDE_MEDIA_PREPARED") ?? "1") !== "0";

  // -- numeric fields -------------------------------------------------------
  const lensRefreshMinMs = Math.max(
    0,
    parseIntEnv("MG_AGENT_LENS_REFRESH_MIN_MS", 0),
  );
  const imageGenerateCmd = trimEnv("MG_AGENT_IMAGE_GENERATE_CMD");
  const imageGenerateTimeoutMs = Math.max(
    5_000,
    parseIntEnv("MG_AGENT_IMAGE_GENERATE_TIMEOUT_MS", 90_000),
  );
  const botSessionTokenTtlSeconds = Math.max(
    10,
    Math.min(86_400, parseIntEnv("MG_AGENT_BOT_SESSION_TTL_SECONDS", 86_400)),
  );
  const botSessionMaxUses = parseBoundedIntEnv(
    "MG_AGENT_BOT_SESSION_MAX_USES",
    { min: 1, max: 25 },
  );
  const autoRequestGrantCooldownMs = Math.max(
    10_000,
    parseIntEnv("MG_AGENT_AUTO_REQUEST_GRANT_COOLDOWN_MS", 180_000),
  );
  const mintChallengeAutoRetryMaxAttempts = Math.max(
    1,
    Math.min(
      10,
      parseIntEnv("MG_AGENT_MINT_CHALLENGE_AUTO_RETRY_MAX", 3),
    ),
  );
  const challengeAnswerMaxChars = Math.max(
    32,
    Math.min(
      512,
      parseIntEnv("MG_AGENT_CHALLENGE_ANSWER_MAX_CHARS", 128),
    ),
  );
  const wsUploadDataUriMaxBytes = Math.max(
    64_000,
    parseIntEnv("MG_AGENT_WS_UPLOAD_DATA_URI_MAX_BYTES", 700_000),
  );
  const httpUploadChunkBytes = Math.max(
    64_000,
    parseIntEnv("MG_AGENT_HTTP_UPLOAD_CHUNK_BYTES", 256_000),
  );
  const openClawWakeDebounceMs = Math.max(
    0,
    parseIntEnv("MG_OPENCLAW_WAKE_DEBOUNCE_MS", 30_000),
  );
  const openClawWakeBatchMs = Math.max(
    0,
    parseIntEnv("MG_OPENCLAW_WAKE_BATCH_MS", 2_000),
  );

  // -- chat runtime numerics ------------------------------------------------
  const chatRuntimePollMs = Math.max(
    300,
    parseIntEnv("MG_CHAT_RUNTIME_POLL_MS", 1200),
  );
  const chatRuntimeReadChunkBytes = Math.max(
    8192,
    Math.min(
      1_048_576,
      parseIntEnv("MG_CHAT_RUNTIME_READ_CHUNK_BYTES", 262_144),
    ),
  );
  const chatRuntimeSeenMessageLimit = Math.max(
    100,
    Math.min(
      10_000,
      parseIntEnv("MG_CHAT_RUNTIME_SEEN_MESSAGE_LIMIT", 1500),
    ),
  );
  const chatRuntimeReplyMaxChars = Math.max(
    120,
    Math.min(
      2000,
      parseIntEnv("MG_CHAT_RUNTIME_REPLY_MAX_CHARS", 1200),
    ),
  );
  const chatRuntimeOpenClawInputMaxChars = Math.max(
    120,
    Math.min(
      2000,
      parseIntEnv("MG_CHAT_RUNTIME_OPENCLAW_INPUT_MAX_CHARS", 900),
    ),
  );
  const chatRuntimeTextStreamStepChars = Math.max(
    6,
    Math.min(
      160,
      parseIntEnv("MG_CHAT_RUNTIME_TEXT_STREAM_STEP_CHARS", 28),
    ),
  );
  const chatRuntimeTextStreamStepMs = Math.max(
    30,
    Math.min(
      500,
      parseIntEnv("MG_CHAT_RUNTIME_TEXT_STREAM_STEP_MS", 70),
    ),
  );
  const chatRuntimeTextStreamUpdateMinMs = Math.max(
    60,
    Math.min(
      3000,
      parseIntEnv("MG_CHAT_RUNTIME_TEXT_STREAM_UPDATE_MIN_MS", 180),
    ),
  );

  // -- execution / queue / ws -----------------------------------------------
  const autoRetryPendingMs = Math.max(
    0,
    parseIntEnv("MG_AGENT_AUTO_RETRY_PENDING_MS", 0),
  );
  const pendingRetryMaxAttempts = Math.max(
    1,
    Math.min(
      20,
      parseIntEnv("MG_AGENT_PENDING_RETRY_MAX_ATTEMPTS", 3),
    ),
  );
  const currentEventsMaxLines = Math.max(
    20,
    Math.min(
      5000,
      parseIntEnv("MG_AGENT_CURRENT_EVENTS_MAX_LINES", 200),
    ),
  );
  const mintRetryMinBackoffMs = Math.max(
    5_000,
    parseIntEnv("MG_AGENT_MINT_RETRY_MIN_MS", 30_000),
  );
  const mintRetryMaxBackoffMs = Math.max(
    mintRetryMinBackoffMs,
    parseIntEnv("MG_AGENT_MINT_RETRY_MAX_MS", 300_000),
  );
  const wsActivityStaleMs = Math.max(
    10_000,
    parseIntEnv("MG_AGENT_WS_ACTIVITY_STALE_MS", 45_000),
  );
  const wsPendingWatchdogMs = Math.max(
    15_000,
    parseIntEnv("MG_AGENT_WS_PENDING_WATCHDOG_MS", 180_000),
  );
  const memoryCompressionIntervalEnvRaw = trimEnv(
    "MG_AGENT_MEMORY_COMPRESS_INTERVAL_MS",
  );
  const memoryCompressionIntervalMs = Math.max(
    60_000,
    parseIntEnv("MG_AGENT_MEMORY_COMPRESS_INTERVAL_MS", 1_800_000),
  );
  const backendRequestMinGapMs = Math.max(
    0,
    parseIntEnv("MG_AGENT_BACKEND_MIN_GAP_MS", 250),
  );
  const backendRequestMaxQueue = Math.max(
    1,
    Math.min(
      500,
      parseIntEnv("MG_AGENT_BACKEND_MAX_QUEUE", 100),
    ),
  );
  const runtimeHashMaxFiles = Math.max(
    8,
    Math.min(
      1024,
      parseIntEnv("MG_AGENT_RUNTIME_HASH_MAX_FILES", 512),
    ),
  );
  const runtimeHashExtensions = parseRuntimeHashExtensions(
    parseCsvEnv("MG_AGENT_RUNTIME_HASH_EXTENSIONS"),
  );

  return {
    runtimeFilePath,
    runtimeRootDir,
    runtimeHashMaxFiles,
    runtimeHashExtensions,
    agentHomeDir,
    kthxConfigPath,
    stateDir,
    connectionId,
    realtimeWsUrl: requiredEnv("MG_REALTIME_WS_URL"),
    heartbeatIntervalMs: parseIntEnv("MG_AGENT_HEARTBEAT_MS", 25_000),
    rotateBytes: parseIntEnv("MG_AGENT_ROTATE_BYTES", 4_000_000),
    tailMaxBytes: parseIntEnv("MG_AGENT_TAIL_BYTES", 700_000),
    tailMaxLines: parseIntEnv("MG_AGENT_TAIL_LINES", 250),
    subscribeGlobalFeed,
    subscribeActivityFeed,
    autoSubscribeLenses,
    lensRefreshMinMs,
    consoleEnabled,
    consoleAllowNonTty,
    imageGenerateCmd,
    imageGenerateTimeoutMs,
    botSessionTokenTtlSeconds,
    botSessionMaxUses,
    autoRequestGrantOnDefer,
    autoRequestGrantCooldownMs,
    mintConsoleDebugEnabled,
    mintChallengeUseOpenClaw,
    rejectMultipleChoiceChallenges,
    mintChallengeAutoRetryEnabled,
    mintChallengeAutoRetryMaxAttempts,
    challengeAnswerMaxChars,
    wsUploadDataUriMaxBytes,
    allowSyntheticMediaFallback,
    httpUploadChunkBytes,
    openClawWakeDebounceMs,
    openClawWakeBatchMs,
    openClawWakeIncludeSocketStateChange,
    openClawWakeIncludeMediaPrepared,
    chatRuntimeEnabled,
    chatRuntimePollMs,
    chatRuntimeReadChunkBytes,
    chatRuntimeSeenMessageLimit,
    chatRuntimeReplyMaxChars,
    chatRuntimeOpenClawInputMaxChars,
    chatRuntimeUseOpenClaw,
    chatRuntimeReplayOnStart,
    chatRuntimeChannelRequireMention,
    chatRuntimeMentionNames: parseCsvEnv("MG_CHAT_RUNTIME_MENTION_NAMES"),
    chatRuntimeTextStreamEnabled,
    chatRuntimeTextStreamNativeEnabled,
    chatRuntimeTextStreamNativeOnly,
    chatRuntimeTextStreamStepChars,
    chatRuntimeTextStreamStepMs,
    chatRuntimeTextStreamUpdateMinMs,
    autoRetryPendingMs,
    terminalTriggerOnly: false,
    queueRunnerDefaultEnabled,
    executionStateResetOnStart: true,
    pendingRetryMaxAttempts,
    eventsResetOnStart,
    currentEventsMaxLines,
    mintRetryMinBackoffMs,
    mintRetryMaxBackoffMs,
    wsActivityStaleMs,
    wsPendingWatchdogMs,
    memoryCompressionIntervalMs,
    memoryCompressionIntervalEnvOverride: Boolean(
      memoryCompressionIntervalEnvRaw,
    ),
    backendSerializeRequests,
    backendRequestMinGapMs,
    backendRequestMaxQueue,
    backendRequestDebug,
    extraPublicTopics: parseCsvEnv("MG_AGENT_PUBLIC_TOPICS"),
    extraUserTopics: parseCsvEnv("MG_AGENT_USER_TOPICS"),
  };
};
