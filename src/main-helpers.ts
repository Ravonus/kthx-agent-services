import fs from "node:fs/promises";
import path from "node:path";

import { trimEnv } from "./lib/env-parse.js";
import { isRecord } from "./lib/guards.js";
import { nowIso } from "./lib/text.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const touchWake = async (wakePath: string): Promise<void> => {
  await fs
    .writeFile(wakePath, nowIso(), "utf8")
    .catch(() => {});
};

export const resolveChatApiBaseUrl = (realtimeWsUrl: string): string => {
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

export const parseRetryAfterMs = (input: {
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

export const summarizeBridgeIssues = (body: unknown): string | null => {
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

export const isEnabledEnvFlag = (value: string | null): boolean => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

export const isBotTokenAuthFailureMessage = (message: string): boolean =>
  /bot token is invalid/iu.test(message) ||
  /bot token invalid/iu.test(message) ||
  /bot token expired/iu.test(message) ||
  /bot token missing/iu.test(message) ||
  /x-bot-session-token/iu.test(message) ||
  /bound to a different connectionid/iu.test(message) ||
  /not bound to an agent/iu.test(message);

export const isAgentKeyBoxAuthFailureMessage = (message: string): boolean =>
  /agent key is invalid for this realtime connection/iu.test(message) ||
  /agent_key_box_resolution_failed/iu.test(message) ||
  /runtime_integrity_gate/iu.test(message) ||
  /agent_not_found/iu.test(message) ||
  /x-agent-key-box/iu.test(message);

export const parseSupervisorPid = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) return null;
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

export const AGENT_KTHX_GUIDE_PATH = "/AGENT-KTHX-v2.md";
export const MEDIA_GENERATOR_DEFAULT_BASE_URL = "http://127.0.0.1:4280";
export const REQUIRED_PERSONA_FRAME_ROLES = ["selfie", "midshot", "fullbody"] as const;
export const VISUAL_SETUP_CHECK_INTERVAL_MS = 60_000;
export const VISUAL_SETUP_STATUS_FILE = "visual-setup-status.json";

export type VisualSetupNotificationState =
  | "disabled"
  | "not_required"
  | "cooldown"
  | "sent"
  | "delivery_failed"
  | "conversation_unavailable"
  | "owner_missing"
  | "profile_unavailable";

export type VisualSetupCheckState = {
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

export const parseFirstCommandToken = (command: string): string | null => {
  const match = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(command);
  const token = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
  return token.length > 0 ? token : null;
};

export const looksPathLike = (value: string): boolean =>
  value.includes("/") || value.includes("\\") || value.startsWith(".");

export const splitPathEntries = (value: string | null | undefined): string[] => {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  return value
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

export const commandCandidates = (token: string): string[] => {
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

export const isExecutableFile = async (candidatePath: string): Promise<boolean> => {
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

export const resolveCommandOnPath = async (token: string): Promise<string | null> => {
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

export const isCommandLikelyAvailable = async (
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

export const resolveMediaGeneratorBaseUrlForStartup = (): string => {
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

export const probeHttpEndpoint = async (
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

export const parseCli = (): { cmd: "run" | "help" } => {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    return { cmd: "help" };
  }
  return { cmd: "run" };
};

export const printHelp = (): void => {
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
