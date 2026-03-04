import fs from "node:fs/promises";
import path from "node:path";

import { trimEnv, parseIntEnv } from "../lib/env-parse.js";
import { isRecord } from "../lib/guards.js";
import { nowIso } from "../lib/text.js";
import { parseIsoToMs } from "../lib/time.js";

export type TopicRequest = { topicType: string; topicId?: string };

export type SubscriptionMode = "full" | "idle_user_only";
export type TopicType = "user" | "conversation" | "channel" | "server";
export type TopicCounts = Record<TopicType, number>;
export type ShellSummary = {
  at: string;
  mode: SubscriptionMode;
  viewerMainUserId: string | null;
  viewerChatUserId: string | null;
  counts: {
    dms: number;
    agentDms: number;
    groups: number;
    servers: number;
    channels: number;
  };
};
export type TicketFailure = {
  topicType: string;
  topicId: string | null;
  message: string;
};

export type BridgeStatus = {
  state: string;
  startedAt: string;
  updatedAt: string;
  baseHttpUrl: string;
  gatewayWsUrl: string | null;
  botTokenSource: string | null;
  reconnectAttempt: number;
  connected: boolean;
  subscribedTopics: string[];
  lastError: string | null;
  viewerMainUserId: string | null;
  viewerChatUserId: string | null;
  subscriptionMode: SubscriptionMode;
  idleEnabled: boolean;
  idleTimeoutMs: number;
  lastActivityAt: string | null;
  lastModeChangeAt: string | null;
  requestedTopicCounts: TopicCounts;
  subscribedTopicCounts: TopicCounts;
  lastShellSummary: ShellSummary | null;
  lastTicketFailures: TicketFailure[];
};

export type GatewaySessionSnapshot = {
  wsUrl: string;
  authToken: string;
  authTokenExpiresAtMs: number | null;
  userTopic: string | null;
  userTopicTicket: string | null;
  userTopicExpiresAtMs: number | null;
};

export type ReconnectOptions = {
  baseDelayMs?: number;
  bumpAttempt?: boolean;
  force?: boolean;
};

export class BridgeCallError extends Error {
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly tokenSource: string | null;

  constructor(
    message: string,
    options: {
      status?: number | null;
      retryAfterMs?: number | null;
      tokenSource?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "BridgeCallError";
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.tokenSource = options.tokenSource ?? null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const parseBooleanEnv = (key: string, fallback = false): boolean => {
  const raw = trimEnv(key);
  if (!raw) return fallback;
  const n = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(n)) return true;
  if (["0", "false", "no", "off"].includes(n)) return false;
  return fallback;
};

export const isMissingBotTokenError = (message: string): boolean =>
  /bot token missing/iu.test(message) ||
  /x-bot-session-token/iu.test(message) ||
  /tokensource=none/iu.test(message);

export const payloadRequiresBotToken = (payload: Record<string, unknown>): boolean => {
  const action = typeof payload.action === "string" ? payload.action.trim() : "";
  return (
    action === "send_message" ||
    action === "edit_message" ||
    action === "open_dm" ||
    action === "respond_to_request" ||
    action === "accept_request" ||
    action === "decline_request" ||
    action === "typing" ||
    action === "delivery_confirmed" ||
    action === "report_system_probe"
  );
};

export const isBridgeCallError = (value: unknown): value is BridgeCallError =>
  value instanceof BridgeCallError;

export const isBotTokenInvalidMessage = (message: string): boolean =>
  /bot token is invalid/iu.test(message) ||
  /bot token invalid/iu.test(message) ||
  /bot token expired/iu.test(message) ||
  /bound to a different connectionid/iu.test(message) ||
  /not bound to an agent/iu.test(message) ||
  /x-bot-session-token/iu.test(message);

export const isAgentKeyAuthFailureMessage = (message: string): boolean =>
  /agent key is invalid for this realtime connection/iu.test(message) ||
  /agent_key_box_resolution_failed/iu.test(message) ||
  /runtime_integrity_gate/iu.test(message) ||
  /agent_not_found/iu.test(message) ||
  /x-agent-key-box/iu.test(message);

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


export const parseAgentUserIdFromKeyBox = (keyBox: string | null): string | null => {
  const trimmed = typeof keyBox === "string" ? keyBox.trim() : "";
  if (!trimmed.length) return null;
  const parts = trimmed.split(".");
  if (parts.length !== 5 || parts[0] !== "mkbox_v1") return null;
  const userId = parts[1]?.trim() ?? "";
  return userId.length >= 8 ? userId : null;
};

export const trimTrailingSlashes = (value: string): string =>
  value.replace(/\/+$/u, "");

export const resolveRealtimeInternalHttpUrl = (): string | null => {
  const explicit =
    trimEnv("REALTIME_INTERNAL_HTTP_URL") ??
    trimEnv("MG_REALTIME_INTERNAL_HTTP_URL") ??
    trimEnv("MG_REALTIME_HTTP_URL");
  if (explicit) return trimTrailingSlashes(explicit);

  const realtimeWsUrl = trimEnv("MG_REALTIME_WS_URL") ?? trimEnv("NEXT_PUBLIC_REALTIME_WS_URL");
  if (!realtimeWsUrl) return null;
  try {
    const parsed = new URL(realtimeWsUrl);
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/trpc\/?$/u, "") || "/";
    return trimTrailingSlashes(parsed.toString());
  } catch {
    return null;
  }
};

export const requestRealtimeDisconnect = async (input: {
  userId: string | null;
  connectionId: string | null;
  reason: string;
}): Promise<{ ok: boolean; disconnected: number | null; error: string | null }> => {
  const baseUrl = resolveRealtimeInternalHttpUrl();
  if (!baseUrl) {
    return {
      ok: false,
      disconnected: null,
      error: "realtime_internal_url_unconfigured",
    };
  }
  const userId = typeof input.userId === "string" ? input.userId.trim() : "";
  const connectionId =
    typeof input.connectionId === "string" ? input.connectionId.trim() : "";
  if (!userId.length && !connectionId.length) {
    return {
      ok: false,
      disconnected: null,
      error: "disconnect_target_missing",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_200);
  try {
    const headers = new Headers();
    headers.set("content-type", "application/json");
    const internalToken =
      trimEnv("REALTIME_INTERNAL_TOKEN") ?? trimEnv("MG_REALTIME_INTERNAL_TOKEN");
    if (internalToken && internalToken.length > 0) {
      headers.set("x-mg-internal-token", internalToken);
    }
    const response = await fetch(`${baseUrl}/internal/disconnect`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        userId: userId.length > 0 ? userId : null,
        connectionId: connectionId.length > 0 ? connectionId : null,
        reason: input.reason,
      }),
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as unknown;
    const disconnected =
      isRecord(body) &&
      typeof body.disconnected === "number" &&
      Number.isFinite(body.disconnected)
        ? Math.max(0, Math.floor(body.disconnected))
        : null;
    if (response.ok) {
      return {
        ok: true,
        disconnected,
        error: null,
      };
    }
    const error =
      isRecord(body) && typeof body.error === "string"
        ? body.error
        : `disconnect_http_${response.status}`;
    return {
      ok: false,
      disconnected,
      error,
    };
  } catch (error) {
    return {
      ok: false,
      disconnected: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
};

export const resolveHttpBaseUrl = (): string => {
  const explicit = trimEnv("MG_CHAT_HTTP_BASE_URL") ?? trimEnv("MG_BASE_URL") ?? trimEnv("MG_AGENT_HTTP_BASE_URL") ?? trimEnv("BETTER_AUTH_BASE_URL");
  if (explicit) return explicit.replace(/\/+$/u, "");

  const realtimeUrl = trimEnv("MG_REALTIME_WS_URL");
  if (!realtimeUrl) throw new Error("Missing base URL. Set MG_CHAT_HTTP_BASE_URL or MG_BASE_URL.");

  const parsed = new URL(realtimeUrl);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/trpc\/?$/u, "") || "/";
  return parsed.toString().replace(/\/+$/u, "");
};

export const readSecretFromEnvOrFile = async (envKey: string, fileKey: string): Promise<string | null> => {
  const direct = trimEnv(envKey);
  if (direct) return direct;
  const filePath = trimEnv(fileKey);
  if (!filePath) return null;
  const raw = await fs.readFile(path.resolve(filePath), "utf8").catch(() => null);
  return raw?.trim().length ? raw.trim() : null;
};

export const readBotTokenFromFile = async (
  filePath: string,
  tokenExpirySkewMs: number,
): Promise<string | null> => {
  const raw = await fs.readFile(filePath, "utf8").catch(() => null);
  if (!raw?.trim().length) return null;
  try {
    const parsed = JSON.parse(raw.trim()) as unknown;
    if (isRecord(parsed)) {
      const state =
        typeof parsed.state === "string"
          ? parsed.state.trim().toLowerCase()
          : "";
      if (state === "cleared") {
        return null;
      }
      const expiresAt =
        typeof parsed.expiresAt === "string"
          ? parsed.expiresAt.trim()
          : "";
      if (expiresAt.length > 0) {
        const expiresAtMs = Date.parse(expiresAt);
        if (
          Number.isFinite(expiresAtMs) &&
          Date.now() + tokenExpirySkewMs >= expiresAtMs
        ) {
          return null;
        }
      }
      const token = typeof parsed.token === "string" ? parsed.token.trim() : typeof parsed.sessionToken === "string" ? (parsed.sessionToken as string).trim() : "";
      return token.length ? token : null;
    }
    return null;
  } catch {
    return raw.trim();
  }
};

export const parseWsFrame = (raw: unknown): Record<string, unknown> | null => {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? "");
  if (!text.trim().length) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const toTrimmedString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

export const extractContext = (topic: unknown, event: unknown): Record<string, string> | null => {
  if (typeof topic === "string") {
    if (topic.startsWith("chat:conversation:")) return { conversationId: topic.slice("chat:conversation:".length) };
    if (topic.startsWith("chat:channel:")) return { channelId: topic.slice("chat:channel:".length) };
  }
  const payload = isRecord(event) && isRecord((event as Record<string, unknown>).payload) ? (event as Record<string, unknown>).payload as Record<string, unknown> : null;
  if (payload) {
    if (typeof payload.conversationId === "string" && (payload.conversationId as string).length) return { conversationId: payload.conversationId as string };
    if (typeof payload.channelId === "string" && (payload.channelId as string).length) return { channelId: payload.channelId as string };
    const msg = isRecord(payload.message) ? payload.message as Record<string, unknown> : null;
    if (msg) {
      if (typeof msg.conversationId === "string" && (msg.conversationId as string).length) return { conversationId: msg.conversationId as string };
      if (typeof msg.channelId === "string" && (msg.channelId as string).length) return { channelId: msg.channelId as string };
    }
  }
  return null;
};

export const extractMessageId = (event: Record<string, unknown>): string | null => {
  const payload = isRecord(event.payload) ? event.payload as Record<string, unknown> : null;
  if (!payload) return null;
  if (typeof payload.messageId === "string" && (payload.messageId as string).trim().length) return (payload.messageId as string).trim();
  const msg = isRecord(payload.message) ? payload.message as Record<string, unknown> : null;
  if (msg && typeof msg.id === "string" && (msg.id as string).trim().length) return (msg.id as string).trim();
  return null;
};

export const extractAuthorMainUserId = (event: Record<string, unknown>): string | null => {
  const payload = isRecord(event.payload) ? event.payload as Record<string, unknown> : null;
  if (!payload) return null;
  return typeof payload.authorMainUserId === "string" && (payload.authorMainUserId as string).trim().length
    ? (payload.authorMainUserId as string).trim()
    : null;
};

export const extractAuthorChatUserId = (event: Record<string, unknown>): string | null => {
  const payload = isRecord(event.payload) ? event.payload as Record<string, unknown> : null;
  if (!payload) return null;
  const directPayloadAuthorId = toTrimmedString(payload.authorChatUserId);
  if (directPayloadAuthorId) return directPayloadAuthorId;
  const payloadAuthor = isRecord(payload.author) ? payload.author as Record<string, unknown> : null;
  const payloadAuthorId = toTrimmedString(payloadAuthor?.id) ?? toTrimmedString(payloadAuthor?.chatUserId);
  if (payloadAuthorId) return payloadAuthorId;
  const msg = isRecord(payload.message) ? payload.message as Record<string, unknown> : null;
  if (!msg) return null;
  const directMessageAuthorId = toTrimmedString(msg.authorChatUserId);
  if (directMessageAuthorId) return directMessageAuthorId;
  const messageAuthor = isRecord(msg.author) ? msg.author as Record<string, unknown> : null;
  return toTrimmedString(messageAuthor?.id) ?? toTrimmedString(messageAuthor?.chatUserId);
};

export const parseConfiguredTopics = (value: string | null): TopicRequest[] => {
  if (!value) return [];
  return value.split(/[\n,]/u).map((e) => e.trim()).filter((e) => e.length > 0).map((entry) => {
    if (entry === "user") return { topicType: "user" };
    const d = entry.indexOf(":");
    if (d <= 0 || d === entry.length - 1) return null;
    const topicType = entry.slice(0, d).trim();
    const topicId = entry.slice(d + 1).trim();
    if (!topicId.length || !["conversation", "channel", "server"].includes(topicType)) return null;
    return { topicType, topicId };
  }).filter((e): e is TopicRequest => e !== null);
};

export const recordId = (
  value: unknown,
  keys: string[],
): string | null => {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const direct = value[key];
    if (typeof direct === "string" && direct.trim().length) {
      return direct.trim();
    }
  }
  for (const nestedKey of ["conversation", "channel", "server"]) {
    const nested = value[nestedKey];
    if (!isRecord(nested)) continue;
    for (const key of keys) {
      const nestedValue = nested[key];
      if (typeof nestedValue === "string" && nestedValue.trim().length) {
        return nestedValue.trim();
      }
    }
  }
  return null;
};

export const emptyTopicCounts = (): TopicCounts => ({
  user: 0,
  conversation: 0,
  channel: 0,
  server: 0,
});

export const toTopicType = (value: string): TopicType | null => {
  if (value === "user" || value === "conversation" || value === "channel" || value === "server") {
    return value;
  }
  if (value.startsWith("chat:user:")) return "user";
  if (value.startsWith("chat:conversation:")) return "conversation";
  if (value.startsWith("chat:channel:")) return "channel";
  if (value.startsWith("chat:server:")) return "server";
  return null;
};

export const countTopicRequests = (requests: TopicRequest[]): TopicCounts => {
  const counts = emptyTopicCounts();
  for (const req of requests) {
    const type = toTopicType(req.topicType);
    if (type) counts[type] += 1;
  }
  return counts;
};

export const countSubscribedTopics = (topics: Iterable<string>): TopicCounts => {
  const counts = emptyTopicCounts();
  for (const topic of topics) {
    const type = toTopicType(topic);
    if (type) counts[type] += 1;
  }
  return counts;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];
