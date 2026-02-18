/**
 * Bot token management: caching, expiry checking, environment access,
 * and supervisor IPC notifications.
 *
 * Ported from agent-runtime.mjs lines 831-964.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { trimEnv } from "../lib/env-parse.js";
import { nowIso } from "../lib/text.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const parseIsoToMs = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
};

const resolveBotSessionTokenFilePath = (): string => {
  const explicitFile = trimEnv("MG_BOT_SESSION_TOKEN_FILE");
  if (explicitFile) return path.resolve(explicitFile);
  const stateDir =
    trimEnv("MG_AGENT_STATE_DIR") ??
    path.join(
      trimEnv("MG_AGENT_HOME_DIR") ?? path.resolve(process.cwd(), "kthx-agents"),
      "state",
    );
  return path.resolve(stateDir, "ipc", "auth", "bot-session.json");
};

type BotSessionFileWriterMode = "auto" | "runtime" | "supervisor";

const resolveBotSessionFileWriterMode = (): BotSessionFileWriterMode => {
  const raw = trimEnv("MG_AGENT_BOT_SESSION_FILE_WRITER");
  const normalized = raw?.toLowerCase();
  if (normalized === "runtime") return "runtime";
  if (normalized === "supervisor") return "supervisor";
  return "auto";
};

const shouldRuntimeWriteBotSessionFile = (): boolean => {
  const mode = resolveBotSessionFileWriterMode();
  const hasSupervisorIpc =
    typeof process.send === "function" && process.connected !== false;
  if (mode === "runtime") return true;
  if (mode === "supervisor") {
    // Safety: if explicitly configured for supervisor writes but runtime is not
    // actually running under supervisor IPC, fall back to runtime writes.
    return !hasSupervisorIpc;
  }
  // Auto mode: if running under supervisor IPC channel, let supervisor be the sole writer.
  return !hasSupervisorIpc;
};

const writeFileAtomic = async (
  filePath: string,
  content: string,
): Promise<void> => {
  const dirPath = path.dirname(filePath);
  const tempPath = path.join(
    dirPath,
    `${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 10)}`,
  );
  await fs.writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.rm(filePath, { force: true });
    await fs.rename(tempPath, filePath);
  } catch {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw new Error(`atomic_write_failed:${filePath}`);
  }
};

const writeBotSessionFile = async ({
  token,
  expiresAt,
  state,
  reason,
}: {
  token: string | null;
  expiresAt: string | null;
  state: "active" | "cleared";
  reason?: string;
}): Promise<void> => {
  if (!shouldRuntimeWriteBotSessionFile()) return;
  const filePath = resolveBotSessionTokenFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {});
  const payload = `${JSON.stringify(
    {
      updatedAt: nowIso(),
      source: "agent-runtime",
      token,
      expiresAt,
      state,
      ...(typeof reason === "string" && reason.trim().length > 0
        ? { reason: reason.trim() }
        : {}),
    },
    null,
    2,
  )}\n`;
  await writeFileAtomic(filePath, payload).catch(() => {});
};

// ---------------------------------------------------------------------------
// Module-level cached bot token state
// ---------------------------------------------------------------------------

let cachedBotToken: string | null = null;
let cachedBotTokenExpiresAtMs: number | null = null;

/**
 * Grace period (ms) subtracted from the token expiry so we consider
 * the token expired slightly before its actual deadline.
 *
 * Configurable via `MG_AGENT_BOT_TOKEN_EXPIRY_SKEW_MS` (0 .. 300 000).
 */
export const BOT_TOKEN_EXPIRY_SKEW_MS: number = (() => {
  const raw = trimEnv("MG_AGENT_BOT_TOKEN_EXPIRY_SKEW_MS");
  if (!raw) return 15_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 15_000;
  return Math.max(0, Math.min(300_000, parsed));
})();

// ---------------------------------------------------------------------------
// Supervisor IPC
// ---------------------------------------------------------------------------

interface SupervisorBotTokenSetPayload {
  type: "mg_runtime_bot_token";
  action: "set";
  token: string;
  expiresAt: string | null;
}

interface SupervisorBotTokenClearPayload {
  type: "mg_runtime_bot_token";
  action: "clear";
  reason: string;
}

interface SupervisorFatalPayload {
  type: "mg_runtime_fatal";
  source: string;
  message: string;
  stack: string | null;
  at: string;
}

type SupervisorPayload =
  | SupervisorBotTokenSetPayload
  | SupervisorBotTokenClearPayload
  | SupervisorFatalPayload;

/**
 * Send an IPC message to the supervisor process (parent) via `process.send`.
 * Silently no-ops when no IPC channel is available.
 */
export const notifySupervisor = (payload: SupervisorPayload): void => {
  if (typeof process.send !== "function") return;
  try {
    process.send(payload);
  } catch {
    // Non-fatal; runtime must continue even if IPC is unavailable.
  }
};

/**
 * Notify supervisor that a bot token has been set.
 */
export const notifySupervisorBotTokenSet = ({
  token,
  expiresAt,
}: {
  token: string;
  expiresAt: string | null;
}): void => {
  const normalizedToken = typeof token === "string" ? token.trim() : "";
  if (!normalizedToken.length) return;
  const normalizedExpiresAt =
    typeof expiresAt === "string" && expiresAt.trim().length > 0
      ? expiresAt.trim()
      : null;
  notifySupervisor({
    type: "mg_runtime_bot_token",
    action: "set",
    token: normalizedToken,
    expiresAt: normalizedExpiresAt,
  });
};

/**
 * Notify supervisor that the bot token has been cleared.
 */
export const notifySupervisorBotTokenClear = (reason?: string): void => {
  notifySupervisor({
    type: "mg_runtime_bot_token",
    action: "clear",
    reason:
      typeof reason === "string" && reason.trim().length > 0
        ? reason.trim()
        : "unknown",
  });
};

/**
 * Notify supervisor of a fatal error.
 */
export const notifySupervisorFatal = ({
  source,
  message,
  stack,
}: {
  source?: string;
  message?: string;
  stack?: string;
}): void => {
  notifySupervisor({
    type: "mg_runtime_fatal",
    source:
      typeof source === "string" && source.trim().length > 0
        ? source.trim()
        : "unknown",
    message:
      typeof message === "string" && message.trim().length > 0
        ? message.trim()
        : "fatal error",
    stack:
      typeof stack === "string" && stack.trim().length > 0 ? stack : null,
    at: nowIso(),
  });
};

// ---------------------------------------------------------------------------
// Token cache management
// ---------------------------------------------------------------------------

/**
 * Clears the in-memory cached bot token and its expiry timestamp.
 */
export const resetBotTokenCache = (): void => {
  cachedBotToken = null;
  cachedBotTokenExpiresAtMs = null;
};

/**
 * Removes bot-session environment variables from `process.env`.
 * Only affects this process and any spawned children.
 * Used to avoid reusing an invalid token across reconnect attempts.
 */
export const dropBotTokenEnv = (): void => {
  try {
    delete process.env.MG_BOT_SESSION_TOKEN;
    delete process.env.MG_BOT_SESSION_EXPIRES_AT;
  } catch {
    // ignore
  }
};

/**
 * Full cleanup: removes env vars, clears cache, and notifies supervisor.
 */
export const clearBotTokenState = (reason?: string): void => {
  dropBotTokenEnv();
  resetBotTokenCache();
  notifySupervisorBotTokenClear(reason);
  const payload =
    typeof reason === "string" && reason.trim().length > 0
      ? {
          token: null,
          expiresAt: null,
          state: "cleared" as const,
          reason,
        }
      : {
          token: null,
          expiresAt: null,
          state: "cleared" as const,
        };
  void writeBotSessionFile({
    ...payload,
  });
};

/**
 * Stores a freshly minted bot token in memory + process env and mirrors it
 * to the runtime token file for bridge consumers.
 */
export const setBotTokenState = async ({
  token,
  expiresAt,
}: {
  token: string;
  expiresAt: string | null;
}): Promise<void> => {
  const normalizedToken = token.trim();
  if (!normalizedToken.length) return;
  const normalizedExpiresAt =
    typeof expiresAt === "string" && expiresAt.trim().length > 0
      ? expiresAt.trim()
      : null;
  const expiresAtMs = parseIsoToMs(normalizedExpiresAt);

  cachedBotToken = normalizedToken;
  cachedBotTokenExpiresAtMs = expiresAtMs;
  process.env.MG_BOT_SESSION_TOKEN = normalizedToken;
  if (normalizedExpiresAt) {
    process.env.MG_BOT_SESSION_EXPIRES_AT = normalizedExpiresAt;
  } else {
    delete process.env.MG_BOT_SESSION_EXPIRES_AT;
  }

  notifySupervisorBotTokenSet({
    token: normalizedToken,
    expiresAt: normalizedExpiresAt,
  });
  await writeBotSessionFile({
    token: normalizedToken,
    expiresAt: normalizedExpiresAt,
    state: "active",
  });
};

// ---------------------------------------------------------------------------
// Expiry checks
// ---------------------------------------------------------------------------

/**
 * Returns `true` when `expiresAtMs` is a finite number and the current time
 * (plus the configured skew) has reached or exceeded it.
 */
export const isTokenExpiredAtMs = (expiresAtMs: number | null): boolean =>
  typeof expiresAtMs === "number" &&
  Number.isFinite(expiresAtMs) &&
  Date.now() + BOT_TOKEN_EXPIRY_SKEW_MS >= expiresAtMs;

// ---------------------------------------------------------------------------
// Token retrieval
// ---------------------------------------------------------------------------

/**
 * Retrieve the current bot token, checking env first, then in-memory cache.
 * Returns `null` when no valid token is available.
 *
 * Bot tokens are kept alive by `agent.heartbeat` while connected and can be
 * reused on reconnect within a short grace window.  Do not refresh on a
 * timer -- only refresh on UNAUTHORIZED.
 */
export const getBotToken = async (): Promise<string | null> => {
  const fromSessionEnv = trimEnv("MG_BOT_SESSION_TOKEN");
  if (fromSessionEnv) {
    const expiresAtMs = parseIsoToMs(trimEnv("MG_BOT_SESSION_EXPIRES_AT"));
    if (isTokenExpiredAtMs(expiresAtMs)) {
      clearBotTokenState("token_expired_local");
      return null;
    }
    cachedBotToken = fromSessionEnv;
    cachedBotTokenExpiresAtMs = expiresAtMs;
    return fromSessionEnv;
  }

  if (cachedBotToken) {
    if (isTokenExpiredAtMs(cachedBotTokenExpiresAtMs)) {
      clearBotTokenState("token_expired_local_cache");
      return null;
    }
    return cachedBotToken;
  }

  return null;
};

/**
 * Returns the expiry timestamp (epoch ms) of the current bot token,
 * checking the environment first, then the in-memory cache.
 * Returns `null` when no expiry is known.
 */
export const getBotTokenExpiryMs = (): number | null => {
  const envExpiresAtMs = parseIsoToMs(trimEnv("MG_BOT_SESSION_EXPIRES_AT"));
  if (typeof envExpiresAtMs === "number" && Number.isFinite(envExpiresAtMs)) {
    return envExpiresAtMs;
  }
  if (
    typeof cachedBotTokenExpiresAtMs === "number" &&
    Number.isFinite(cachedBotTokenExpiresAtMs)
  ) {
    return cachedBotTokenExpiresAtMs;
  }
  return null;
};
