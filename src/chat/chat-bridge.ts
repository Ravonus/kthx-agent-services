/**
 * Standalone WebSocket bridge for chat functionality.
 *
 * Ported from agent-chat-bridge.mjs.
 *
 * Connects to the chat gateway via HTTP bridge endpoints, establishes a
 * WebSocket session, subscribes to topics (DMs, channels, servers), and
 * writes incoming messages to the chat inbox JSONL. Bot-session tokens are
 * resolved from explicit env/file sources.
 *
 * Required env:
 *   MG_AGENT_KEY_BOX (or MG_AGENT_KEY_BOX_FILE, or MG_AGENT_KEY)
 *   MG_BASE_URL or MG_CHAT_HTTP_BASE_URL
 *
 * Optional env:
 *   MG_BOT_SESSION_TOKEN, MG_BOT_SESSION_TOKEN_FILE
 *   MG_CHAT_AGENT_TOPICS, MG_CHAT_AGENT_AUTO_SUBSCRIBE_DMS
 *   MG_CHAT_AGENT_AUTO_SUBSCRIBE_SERVERS
 */

import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

import { loadDotEnv } from "../config/dotenv.js";
import { trimEnv, parseIntEnv } from "../lib/env-parse.js";
import { isRecord } from "../lib/guards.js";
import { nowIso } from "../lib/text.js";
import { appendJsonLine, writeJsonFile, ensureDir } from "../lib/fs-helpers.js";
import { createStateSqliteStoreFromEnv } from "../state/sqlite-state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TopicRequest = { topicType: string; topicId?: string };

type SubscriptionMode = "full" | "idle_user_only";
type TopicType = "user" | "conversation" | "channel" | "server";
type TopicCounts = Record<TopicType, number>;
type ShellSummary = {
  at: string;
  mode: SubscriptionMode;
  viewerMainUserId: string | null;
  counts: {
    dms: number;
    agentDms: number;
    groups: number;
    servers: number;
    channels: number;
  };
};
type TicketFailure = {
  topicType: string;
  topicId: string | null;
  message: string;
};

type BridgeStatus = {
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

type ReconnectOptions = {
  baseDelayMs?: number;
  bumpAttempt?: boolean;
  force?: boolean;
};

class BridgeCallError extends Error {
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

const parseBooleanEnv = (key: string, fallback = false): boolean => {
  const raw = trimEnv(key);
  if (!raw) return fallback;
  const n = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(n)) return true;
  if (["0", "false", "no", "off"].includes(n)) return false;
  return fallback;
};

const isMissingBotTokenError = (message: string): boolean =>
  /bot token missing/iu.test(message) ||
  /x-bot-session-token/iu.test(message) ||
  /tokensource=none/iu.test(message);

const payloadRequiresBotToken = (payload: Record<string, unknown>): boolean => {
  const action = typeof payload.action === "string" ? payload.action.trim() : "";
  return (
    action === "gateway_session" ||
    action === "gateway_ticket" ||
    action === "shell" ||
    action === "list_messages" ||
    action === "find_user" ||
    action === "find_post" ||
    action === "find_comment" ||
    action === "send_message" ||
    action === "edit_message" ||
    action === "open_dm" ||
    action === "typing" ||
    action === "delivery_confirmed"
  );
};

const isBridgeCallError = (value: unknown): value is BridgeCallError =>
  value instanceof BridgeCallError;

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

const jitterDelay = (ms: number): number => {
  const multiplier = 1 + (Math.random() * 2 - 1) * 0.2;
  return Math.max(0, Math.round(ms * multiplier));
};

const resolveHttpBaseUrl = (): string => {
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

const readSecretFromEnvOrFile = async (envKey: string, fileKey: string): Promise<string | null> => {
  const direct = trimEnv(envKey);
  if (direct) return direct;
  const filePath = trimEnv(fileKey);
  if (!filePath) return null;
  const raw = await fs.readFile(path.resolve(filePath), "utf8").catch(() => null);
  return raw?.trim().length ? raw.trim() : null;
};

const readBotTokenFromFile = async (filePath: string): Promise<string | null> => {
  const raw = await fs.readFile(filePath, "utf8").catch(() => null);
  if (!raw?.trim().length) return null;
  try {
    const parsed = JSON.parse(raw.trim()) as unknown;
    if (isRecord(parsed)) {
      const token = typeof parsed.token === "string" ? parsed.token.trim() : typeof parsed.sessionToken === "string" ? (parsed.sessionToken as string).trim() : "";
      return token.length ? token : null;
    }
    return null;
  } catch {
    return raw.trim();
  }
};

const parseWsFrame = (raw: unknown): Record<string, unknown> | null => {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? "");
  if (!text.trim().length) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const extractContext = (topic: unknown, event: unknown): Record<string, string> | null => {
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

const extractMessageId = (event: Record<string, unknown>): string | null => {
  const payload = isRecord(event.payload) ? event.payload as Record<string, unknown> : null;
  if (!payload) return null;
  if (typeof payload.messageId === "string" && (payload.messageId as string).trim().length) return (payload.messageId as string).trim();
  const msg = isRecord(payload.message) ? payload.message as Record<string, unknown> : null;
  if (msg && typeof msg.id === "string" && (msg.id as string).trim().length) return (msg.id as string).trim();
  return null;
};

const extractAuthorMainUserId = (event: Record<string, unknown>): string | null => {
  const payload = isRecord(event.payload) ? event.payload as Record<string, unknown> : null;
  if (!payload) return null;
  return typeof payload.authorMainUserId === "string" && (payload.authorMainUserId as string).trim().length
    ? (payload.authorMainUserId as string).trim()
    : null;
};

const parseConfiguredTopics = (value: string | null): TopicRequest[] => {
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

const recordId = (
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

const emptyTopicCounts = (): TopicCounts => ({
  user: 0,
  conversation: 0,
  channel: 0,
  server: 0,
});

const toTopicType = (value: string): TopicType | null => {
  if (value === "user" || value === "conversation" || value === "channel" || value === "server") {
    return value;
  }
  if (value.startsWith("chat:user:")) return "user";
  if (value.startsWith("chat:conversation:")) return "conversation";
  if (value.startsWith("chat:channel:")) return "channel";
  if (value.startsWith("chat:server:")) return "server";
  return null;
};

const countTopicRequests = (requests: TopicRequest[]): TopicCounts => {
  const counts = emptyTopicCounts();
  for (const req of requests) {
    const type = toTopicType(req.topicType);
    if (type) counts[type] += 1;
  }
  return counts;
};

const countSubscribedTopics = (topics: Iterable<string>): TopicCounts => {
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

const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];

const main = async (): Promise<void> => {
  await loadDotEnv();

  const baseHttpUrl = resolveHttpBaseUrl();
  const agentKeyBox = await readSecretFromEnvOrFile("MG_AGENT_KEY_BOX", "MG_AGENT_KEY_BOX_FILE");
  const agentKey = trimEnv("MG_AGENT_KEY");
  if (!agentKeyBox && !agentKey) throw new Error("Missing agent auth. Set MG_AGENT_KEY_BOX or MG_AGENT_KEY.");

  const agentHomeDir = path.resolve(trimEnv("MG_AGENT_HOME_DIR") ?? "kthx-agents");
  const stateDir = path.resolve(trimEnv("MG_AGENT_STATE_DIR") ?? path.join(agentHomeDir, "state"));
  const defaultTokenFile = path.join(stateDir, "ipc", "auth", "bot-session.json");
  const tokenFile = path.resolve(trimEnv("MG_BOT_SESSION_TOKEN_FILE") ?? defaultTokenFile);
  const botTokenFile = trimEnv("MG_BOT_TOKEN_FILE");
  const eventsPath = path.join(stateDir, "ipc", "chat", "events.jsonl");
  const inboxPath = path.join(stateDir, "ipc", "chat", "inbox.jsonl");
  const statusPath = path.join(stateDir, "ipc", "chat", "status.json");
  const wakePath = path.join(stateDir, "ipc", "wake-chat");
  const stateDb = createStateSqliteStoreFromEnv(stateDir);
  stateDb.init();

  const maxTrackedIds = Math.max(100, parseIntEnv("MG_CHAT_AGENT_TRACKED_MESSAGE_IDS", 1200));
  const maxTopics = Math.max(5, parseIntEnv("MG_CHAT_AGENT_MAX_TOPICS", 180));
  const pingMs = Math.max(5_000, parseIntEnv("MG_CHAT_AGENT_PING_MS", 25_000));
  const tokenPollMs = Math.max(
    250,
    Math.min(10_000, parseIntEnv("MG_CHAT_AGENT_TOKEN_POLL_MS", 1000)),
  );
  const tokenFastRetryMs = Math.max(
    100,
    Math.min(5_000, parseIntEnv("MG_CHAT_AGENT_TOKEN_FAST_RETRY_MS", 250)),
  );
  const missingTokenRetryMs = Math.max(
    2_000,
    parseIntEnv(
      "MG_CHAT_AGENT_MISSING_TOKEN_RETRY_MS",
      Math.max(5_000, tokenPollMs * 5),
    ),
  );
  const rateLimitedRetryFallbackMs = Math.max(
    5_000,
    parseIntEnv("MG_CHAT_AGENT_RATE_LIMIT_RETRY_FALLBACK_MS", 15_000),
  );
  const idleEnabled = parseBooleanEnv("MG_CHAT_AGENT_IDLE_SUBSCRIPTIONS_ENABLED", true);
  const idleTimeoutMs = Math.max(30_000, parseIntEnv("MG_CHAT_AGENT_IDLE_TIMEOUT_MS", 300_000));
  const idleCheckMs = Math.max(
    5_000,
    Math.min(
      60_000,
      parseIntEnv(
        "MG_CHAT_AGENT_IDLE_CHECK_MS",
        Math.max(5_000, Math.min(15_000, Math.floor(idleTimeoutMs / 3))),
      ),
    ),
  );
  const idleKeepManualTopics = parseBooleanEnv("MG_CHAT_AGENT_IDLE_KEEP_MANUAL_TOPICS", false);
  const autoSubDms = parseBooleanEnv("MG_CHAT_AGENT_AUTO_SUBSCRIBE_DMS", true);
  const autoSubGroups = parseBooleanEnv("MG_CHAT_AGENT_AUTO_SUBSCRIBE_GROUPS", true);
  const autoSubServers = parseBooleanEnv("MG_CHAT_AGENT_AUTO_SUBSCRIBE_SERVERS", true);
  const autoSubChannels = parseBooleanEnv("MG_CHAT_AGENT_AUTO_SUBSCRIBE_CHANNELS", true);
  const manualTopics = parseConfiguredTopics(trimEnv("MG_CHAT_AGENT_TOPICS"));

  let preferredTokenSource: string | null = null;
  let preferredTokenValue: string | null = null;
  let bridgeRateLimitedUntilMs = 0;
  let bridgeRateLimitedReason: string | null = null;

  const resolveBotTokenCandidates = async (): Promise<Array<{ source: string; token: string | null }>> => {
    const candidates: Array<{ source: string; token: string }> = [];
    const push = (source: string, token: string | null): void => {
      const t = typeof token === "string" ? token.trim() : "";
      if (t.length && !candidates.some((c) => c.token === t)) candidates.push({ source, token: t });
    };
    push("env:MG_BOT_SESSION_TOKEN", trimEnv("MG_BOT_SESSION_TOKEN"));
    push("env:MG_BOT_TOKEN", trimEnv("MG_BOT_TOKEN"));
    push(`file:${tokenFile}`, await readBotTokenFromFile(tokenFile));
    if (botTokenFile) {
      const resolvedBotTokenFile = path.resolve(botTokenFile);
      push(`file:${resolvedBotTokenFile}`, await readBotTokenFromFile(resolvedBotTokenFile));
    }
    if (preferredTokenValue && preferredTokenSource) {
      const idx = candidates.findIndex((c) => c.token === preferredTokenValue);
      if (idx > 0) { const [item] = candidates.splice(idx, 1); candidates.unshift(item!); }
    }
    return candidates;
  };

  const buildHeaders = (botToken: string | null): Record<string, string> => ({
    "content-type": "application/json",
    ...(botToken ? { "x-bot-session-token": botToken } : {}),
    ...(agentKeyBox ? { "x-agent-key-box": agentKeyBox } : { "x-agent-key": agentKey! }),
  });

  const callBridge = async (payload: Record<string, unknown>): Promise<unknown> => {
    const nowMs = Date.now();
    if (bridgeRateLimitedUntilMs > nowMs) {
      throw new BridgeCallError(
        bridgeRateLimitedReason ?? "bridge call is rate limited",
        {
          status: 429,
          retryAfterMs: bridgeRateLimitedUntilMs - nowMs,
          tokenSource: preferredTokenSource,
        },
      );
    }

    const candidates = await resolveBotTokenCandidates();
    if (payloadRequiresBotToken(payload) && candidates.length === 0) {
      throw new BridgeCallError(
        "Bot token missing. Provide x-bot-session-token. (tokenSource=none)",
        { status: 401, tokenSource: "none" },
      );
    }
    const attempts = candidates.length > 0 ? candidates : [{ source: "none", token: null }];
    let lastError: BridgeCallError | null = null;

    for (let i = 0; i < attempts.length; i++) {
      const candidate = attempts[i]!;
      const res = await fetch(`${baseHttpUrl}/api/agent/chat`, {
        method: "POST",
        headers: buildHeaders(candidate.token),
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => null)) as unknown;
      if (res.ok && isRecord(body) && (body as Record<string, unknown>).ok === true) {
        preferredTokenSource = candidate.source;
        preferredTokenValue = candidate.token;
        bridgeRateLimitedUntilMs = 0;
        bridgeRateLimitedReason = null;
        return (body as Record<string, unknown>).data;
      }
      const errMsg = isRecord(body) && typeof (body as Record<string, unknown>).error === "string" ? (body as Record<string, unknown>).error as string : `HTTP ${res.status}`;
      if (res.status === 429) {
        const retryAfterMs = parseRetryAfterMs({
          response: res,
          body,
          fallbackMs: rateLimitedRetryFallbackMs,
        });
        bridgeRateLimitedUntilMs = Math.max(
          bridgeRateLimitedUntilMs,
          Date.now() + retryAfterMs,
        );
        bridgeRateLimitedReason = errMsg;
        throw new BridgeCallError(`${errMsg} (tokenSource=${candidate.source})`, {
          status: 429,
          retryAfterMs,
          tokenSource: candidate.source,
        });
      }
      lastError = new BridgeCallError(`${errMsg} (tokenSource=${candidate.source})`, {
        status: res.status,
        tokenSource: candidate.source,
      });
      const isTokenMismatch = /bot token is invalid/iu.test(errMsg) || /bot token invalid/iu.test(errMsg);
      if (isTokenMismatch && i < attempts.length - 1) continue;
      throw lastError;
    }
    throw lastError ?? new Error("unknown_bridge_error");
  };

  const touchWake = async (reason: string): Promise<void> => {
    await ensureDir(path.dirname(wakePath));
    await fs.writeFile(wakePath, JSON.stringify({ at: nowIso(), reason }), "utf8").catch(() => undefined);
  };

  const appendBridgeEvent = async (payload: Record<string, unknown>): Promise<void> => {
    await appendJsonLine(eventsPath, payload).catch(() => undefined);
    const eventType =
      typeof payload.type === "string" && payload.type.trim().length > 0
        ? payload.type.trim()
        : "event";
    const at =
      typeof payload.at === "string" && payload.at.trim().length > 0
        ? payload.at.trim()
        : nowIso();
    stateDb.appendEvent({
      source: "chat-bridge",
      topic: "chat.bridge",
      eventType,
      visibility: "private",
      at,
      payload,
    });
  };

  const appendInboxEvent = async (payload: Record<string, unknown>): Promise<void> => {
    await appendJsonLine(inboxPath, payload).catch(() => undefined);
    const at =
      typeof payload.at === "string" && payload.at.trim().length > 0
        ? payload.at.trim()
        : nowIso();
    stateDb.appendEvent({
      source: "chat-bridge",
      topic: "chat.inbox",
      eventType: "message.created",
      visibility: "private",
      at,
      payload,
    });
  };

  // Tracked message IDs (ring buffer)
  const trackedIds = new Set<string>();
  const trackedQueue: string[] = [];
  const trackId = (id: string): void => {
    if (!id || trackedIds.has(id)) return;
    trackedIds.add(id); trackedQueue.push(id);
    if (trackedQueue.length > maxTrackedIds) { const r = trackedQueue.shift(); if (r) trackedIds.delete(r); }
  };
  const untrackId = (id: string): void => {
    if (!id || !trackedIds.has(id)) return;
    trackedIds.delete(id);
    const idx = trackedQueue.indexOf(id);
    if (idx >= 0) trackedQueue.splice(idx, 1);
  };

  // Status management
  let status: BridgeStatus = {
    state: "booting",
    startedAt: nowIso(),
    updatedAt: nowIso(),
    baseHttpUrl,
    gatewayWsUrl: null,
    botTokenSource: null,
    reconnectAttempt: 0,
    connected: false,
    subscribedTopics: [],
    lastError: null,
    viewerMainUserId: null,
    subscriptionMode: "full",
    idleEnabled,
    idleTimeoutMs,
    lastActivityAt: nowIso(),
    lastModeChangeAt: nowIso(),
    requestedTopicCounts: emptyTopicCounts(),
    subscribedTopicCounts: emptyTopicCounts(),
    lastShellSummary: null,
    lastTicketFailures: [],
  };
  const updateStatus = async (patch: Partial<BridgeStatus>): Promise<void> => {
    status = { ...status, ...patch, updatedAt: nowIso() };
    await writeJsonFile(statusPath, status).catch(() => undefined);
    stateDb.upsertSnapshot({
      scope: "chat.bridge.status",
      visibility: "public",
      at: status.updatedAt,
      data: status,
    });
  };

  // WebSocket state
  let activeSocket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  let tokenWatchTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectAttempt = 0;
  let lastObservedTokenValue: string | null = null;
  let stopping = false;
  let viewerMainUserId: string | null = null;
  let desiredMode: SubscriptionMode = "full";
  let lastActivityAtMs = Date.now();
  let lastShellSummary: ShellSummary | null = null;

  const getLastActivityAtIso = (): string => new Date(lastActivityAtMs).toISOString();

  // Topic collection
  const collectTopics = async (mode: SubscriptionMode): Promise<TopicRequest[]> => {
    const map = new Map<string, TopicRequest>();
    const add = (r: TopicRequest): void => {
      const key = r.topicType === "user" ? "user" : `${r.topicType}:${r.topicId ?? ""}`;
      if (!map.has(key)) map.set(key, r);
    };
    add({ topicType: "user" });

    if (mode === "idle_user_only") {
      if (idleKeepManualTopics) {
        manualTopics.forEach((r) => add(r));
      }
      return Array.from(map.values());
    }

    manualTopics.forEach((r) => add(r));

    if (autoSubDms || autoSubGroups || autoSubServers || autoSubChannels) {
      const shell = await callBridge({ action: "shell" }) as Record<string, unknown> | null;
      const viewer = shell && isRecord(shell.viewer) ? shell.viewer as Record<string, unknown> : null;
      viewerMainUserId = viewer && typeof viewer.mainUserId === "string" ? viewer.mainUserId as string : null;
      const dmCount = Array.isArray(shell?.dms) ? shell.dms.length : 0;
      const agentDmCount = Array.isArray(shell?.agentChats) ? shell.agentChats.length : 0;
      const groupCount = Array.isArray(shell?.groups) ? shell.groups.length : 0;
      const servers = Array.isArray(shell?.servers) ? shell.servers : [];
      const serverCount = servers.length;
      const channelCount = servers.reduce((count, srv) => {
        if (!isRecord(srv)) {
          return count;
        }
        const channels = (srv as Record<string, unknown>).channels;
        if (!Array.isArray(channels)) {
          return count;
        }
        return count + channels.length;
      }, 0);
      const shellAt = nowIso();
      lastShellSummary = {
        at: shellAt,
        mode,
        viewerMainUserId,
        counts: {
          dms: dmCount,
          agentDms: agentDmCount,
          groups: groupCount,
          servers: serverCount,
          channels: channelCount,
        },
      };
      await appendBridgeEvent({
        at: shellAt,
        type: "shell_summary",
        mode,
        viewerMainUserId,
        counts: lastShellSummary.counts,
      });

      if (autoSubDms) {
        for (const list of [Array.isArray(shell?.dms) ? shell.dms : [], Array.isArray(shell?.agentChats) ? shell.agentChats : []]) {
          for (const conv of list as unknown[]) {
            const convId = recordId(conv, ["id", "conversationId"]);
            if (convId) add({ topicType: "conversation", topicId: convId });
          }
        }
      }
      if (autoSubGroups) {
        for (const conv of (Array.isArray(shell?.groups) ? shell.groups : []) as unknown[]) {
          const convId = recordId(conv, ["id", "conversationId"]);
          if (convId) {
            add({
              topicType: "conversation",
              topicId: convId,
            });
          }
        }
      }
      if (autoSubServers) {
        for (const srv of (Array.isArray(shell?.servers) ? shell.servers : []) as unknown[]) {
          const serverId = recordId(srv, ["id", "serverId"]);
          if (serverId) {
            add({
              topicType: "server",
              topicId: serverId,
            });
          }
        }
      }
      if (autoSubChannels) {
        for (const srv of servers as unknown[]) {
          if (!isRecord(srv)) continue;
          const channelsRaw = Array.isArray((srv as Record<string, unknown>).channels)
            ? (srv as Record<string, unknown>).channels
            : Array.isArray((srv as Record<string, unknown>).channelList)
              ? (srv as Record<string, unknown>).channelList
              : [];
          for (const channel of channelsRaw as unknown[]) {
            const channelId = recordId(channel, ["id", "channelId"]);
            if (channelId) {
              add({
                topicType: "channel",
                topicId: channelId,
              });
            }
          }
        }
      }
    }
    const items = Array.from(map.values());
    if (autoSubChannels && !items.some((item) => item.topicType === "channel")) {
      await appendBridgeEvent({
        at: nowIso(),
        type: "channel_topics_none",
        mode,
        message:
          "No channel topics discovered from shell response. Agent may not be a server member, or shell returned no channel list.",
      });
    }
    return items.length > maxTopics ? items.slice(0, maxTopics) : items;
  };

  // Inbox enrichment
  const enrichInbox = async (topic: string, event: Record<string, unknown>): Promise<void> => {
    const eventType = typeof event.type === "string" ? event.type.trim() : "";
    if (eventType !== "message.created") return;
    const context = extractContext(topic, event);
    if (!context) {
      await appendBridgeEvent({
        at: nowIso(),
        level: "warn",
        source: "context_missing",
        topic,
        eventType,
        message: "message.created event missing conversation/channel context",
      }).catch(() => undefined);
      return;
    }

    const messageId = extractMessageId(event);
    const authorId = extractAuthorMainUserId(event);
    if (messageId && trackedIds.has(messageId)) return;
    if (messageId) trackId(messageId);
    if (viewerMainUserId && authorId === viewerMainUserId) return;

    let listError: string | null = null;
    const latest = await callBridge({
      action: "list_messages",
      ...context,
      limit: messageId ? 8 : 1,
    }).catch((error) => {
      listError = error instanceof Error ? error.message : String(error);
      return null;
    }) as Record<string, unknown> | null;
    if (!latest && listError) {
      await appendBridgeEvent({
        at: nowIso(),
        level: "warn",
        source: "list_messages_failed",
        topic,
        messageId,
        context,
        message: listError,
      }).catch(() => undefined);
      if (messageId) untrackId(messageId);
      return;
    }

    const items = latest && Array.isArray(latest.items) ? latest.items as Record<string, unknown>[] : [];
    const matched = messageId ? items.find((item) => isRecord(item) && isRecord((item as Record<string, unknown>).message) && ((item as Record<string, unknown>).message as Record<string, unknown>).id === messageId) : null;
    if (messageId && !matched) {
      untrackId(messageId);
      await appendBridgeEvent({
        at: nowIso(),
        level: "warn",
        source: "message_lookup_miss",
        topic,
        messageId,
        message:
          "message.created event did not resolve to list_messages payload; skipping confirm",
      }).catch(() => undefined);
      return;
    }
    const firstItem = matched ?? (messageId ? null : items[0] ?? null);
    if (!isRecord(firstItem)) return;

    // Self-message filter
    const author = isRecord((firstItem as Record<string, unknown>).author) ? (firstItem as Record<string, unknown>).author as Record<string, unknown> : null;
    if (!authorId && viewerMainUserId && author && author.mainUserId === viewerMainUserId) return;

    await appendInboxEvent({
      at: nowIso(),
      sourceContext: "CHAT",
      topic,
      eventType,
      context,
      message: firstItem,
    });

    // Delivery confirmation
    const msgRecord = isRecord((firstItem as Record<string, unknown>).message) ? (firstItem as Record<string, unknown>).message as Record<string, unknown> : null;
    const confirmedId = msgRecord && typeof msgRecord.id === "string" ? (msgRecord.id as string).trim() : "";
    if (confirmedId) {
      const clientMsgId = msgRecord && typeof msgRecord.clientMessageId === "string" ? (msgRecord.clientMessageId as string).trim() : "";
      await callBridge({
        action: "delivery_confirmed",
        ...context,
        messageId: confirmedId,
        ...(clientMsgId ? { clientMessageId: clientMsgId } : {}),
      }).catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await appendBridgeEvent({
          at: nowIso(),
          level: "warn",
          source: "delivery_confirm_failed",
          topic,
          messageId: confirmedId,
          message,
        }).catch(() => undefined);
      });
    }

    await touchWake("chat_message_received");
  };

  const requestMode = async (nextMode: SubscriptionMode, reason: string): Promise<void> => {
    if (!idleEnabled && nextMode !== "full") return;
    if (desiredMode === nextMode) return;
    desiredMode = nextMode;

    await appendBridgeEvent({
      at: nowIso(),
      type: "bridge_mode_switch_requested",
      mode: nextMode,
      reason,
    });
    await updateStatus({
      subscriptionMode: nextMode,
      lastModeChangeAt: nowIso(),
      lastActivityAt: getLastActivityAtIso(),
    });
    await scheduleReconnect(`mode_switch:${reason}`, {
      baseDelayMs: 120,
      bumpAttempt: false,
    });
    const sock = activeSocket;
    if (sock && (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING)) {
      try {
        sock.close(1000, "mode_switch");
      } catch {
        // ignore
      }
    }
  };

  const noteActivity = (reason: string): void => {
    lastActivityAtMs = Date.now();
    void appendBridgeEvent({ at: nowIso(), type: "bridge_activity", reason }).catch(() => undefined);
    void updateStatus({ lastActivityAt: getLastActivityAtIso() });
    if (idleEnabled && desiredMode === "idle_user_only") {
      void requestMode("full", `activity:${reason}`);
    }
  };

  // Reconnect scheduler
  const scheduleReconnect = async (reason: string, options: ReconnectOptions = {}): Promise<void> => {
    if (stopping) return;
    const force = options.force ?? false;
    if (force && reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (reconnectTimer) return;
    const bumpAttempt = options.bumpAttempt ?? true;
    if (bumpAttempt) {
      reconnectAttempt += 1;
    }
    const fallbackDelay = RECONNECT_DELAYS[
      Math.min(Math.max(0, reconnectAttempt - 1), RECONNECT_DELAYS.length - 1)
    ] ?? 30_000;
    const baseDelay = options.baseDelayMs ?? fallbackDelay;
    const delay = jitterDelay(baseDelay);
    console.warn(`[agent-chat-bridge] reconnect in ${delay}ms (attempt ${reconnectAttempt}): ${reason}`);
    await updateStatus({
      state: "reconnecting",
      connected: false,
      reconnectAttempt,
      lastError: reason,
      subscriptionMode: desiredMode,
      lastActivityAt: getLastActivityAtIso(),
    });
    reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, delay);
  };

  // Connect
  const connect = async (): Promise<void> => {
    if (stopping) return;
    const connectMode = desiredMode;
    await updateStatus({
      state: "connecting",
      connected: false,
      gatewayWsUrl: null,
      reconnectAttempt,
      lastError: null,
      subscriptionMode: connectMode,
      lastActivityAt: getLastActivityAtIso(),
    });

    let session: Record<string, unknown>;
    try {
      session = await callBridge({ action: "gateway_session" }) as Record<string, unknown>;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (isBridgeCallError(e) && e.status === 429) {
        const retryMs = Math.max(1000, e.retryAfterMs ?? rateLimitedRetryFallbackMs);
        await appendBridgeEvent({
          at: nowIso(),
          type: "gateway_session_rate_limited",
          retryMs,
          message,
        });
        await updateStatus({
          state: "rate_limited",
          connected: false,
          lastError: `gateway_session_rate_limited: ${message}`,
          subscriptionMode: connectMode,
          lastActivityAt: getLastActivityAtIso(),
        });
        await scheduleReconnect("gateway_session_rate_limited", {
          baseDelayMs: retryMs,
          bumpAttempt: false,
        });
        return;
      }
      const missingToken = isMissingBotTokenError(message);
      if (missingToken) {
        await appendBridgeEvent({
          at: nowIso(),
          type: "gateway_session_waiting_for_bot_token",
          retryMs: missingTokenRetryMs,
          message,
        });
        await updateStatus({
          state: "waiting_for_bot_token",
          connected: false,
          lastError: null,
          subscriptionMode: connectMode,
          lastActivityAt: getLastActivityAtIso(),
        });
        await scheduleReconnect("waiting_for_bot_token", {
          baseDelayMs: missingTokenRetryMs,
          bumpAttempt: false,
        });
        return;
      }
      await scheduleReconnect(`gateway_session_failed: ${message}`);
      return;
    }

    if (!isRecord(session) || session.enabled !== true) { await scheduleReconnect("chat_gateway_disabled"); return; }
    const wsUrl = typeof session.wsUrl === "string" ? session.wsUrl : null;
    const authToken = typeof session.authToken === "string" ? session.authToken : null;
    if (!wsUrl || !authToken) {
      await scheduleReconnect("missing_ws_credentials", {
        baseDelayMs: tokenFastRetryMs,
        bumpAttempt: false,
      });
      return;
    }
    await updateStatus({ gatewayWsUrl: wsUrl });

    let topicRequests: TopicRequest[];
    try {
      topicRequests = await collectTopics(connectMode);
    } catch (e) {
      const topicCollectionError = e instanceof Error ? e.message : String(e);
      lastShellSummary = null;
      await appendBridgeEvent({
        at: nowIso(),
        type: "topic_collection_failed",
        mode: connectMode,
        message: topicCollectionError,
      });
      await updateStatus({
        state: "reconnecting",
        connected: false,
        lastError: `topic_collection_failed: ${topicCollectionError}`,
      });
      await scheduleReconnect(`topic_collection_failed: ${topicCollectionError}`);
      return;
    }
    const requestedTopicCounts = countTopicRequests(topicRequests);

    // Collect tickets
    const ticketMap = new Map<string, string>();
    const ticketFailures: TicketFailure[] = [];
    let gatewayTicketRateLimitRetryMs: number | null = null;
    if (typeof session.userTopic === "string" && typeof session.userTopicTicket === "string" && (session.userTopic as string).length && (session.userTopicTicket as string).length) {
      ticketMap.set(session.userTopic as string, session.userTopicTicket as string);
    }
    for (const req of topicRequests) {
      try {
        const ticket = await callBridge({ action: "gateway_ticket", topicType: req.topicType, ...(req.topicId ? { topicId: req.topicId } : {}) }) as Record<string, unknown>;
        if (isRecord(ticket) && typeof ticket.topic === "string" && typeof ticket.ticket === "string") {
          ticketMap.set(ticket.topic as string, ticket.ticket as string);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isBridgeCallError(error) && error.status === 429) {
          gatewayTicketRateLimitRetryMs = Math.max(
            gatewayTicketRateLimitRetryMs ?? 0,
            Math.max(1000, error.retryAfterMs ?? rateLimitedRetryFallbackMs),
          );
          await appendBridgeEvent({
            at: nowIso(),
            type: "gateway_ticket_rate_limited",
            topicType: req.topicType,
            topicId: req.topicId ?? null,
            message,
            retryMs: gatewayTicketRateLimitRetryMs,
          });
          break;
        }
        if (ticketFailures.length < 40) {
          ticketFailures.push({
            topicType: req.topicType,
            topicId: req.topicId ?? null,
            message,
          });
        }
        await appendBridgeEvent({
          at: nowIso(),
          type: "gateway_ticket_failed",
          topicType: req.topicType,
          topicId: req.topicId ?? null,
          message,
        });
      }
    }
    if (gatewayTicketRateLimitRetryMs !== null) {
      await updateStatus({
        state: "rate_limited",
        connected: false,
        subscriptionMode: connectMode,
        requestedTopicCounts,
        subscribedTopicCounts: countSubscribedTopics(ticketMap.keys()),
        lastShellSummary,
      });
      await scheduleReconnect("gateway_ticket_rate_limited", {
        baseDelayMs: gatewayTicketRateLimitRetryMs,
        bumpAttempt: false,
      });
      return;
    }
    const subscribedTopicCounts = countSubscribedTopics(ticketMap.keys());
    await appendBridgeEvent({
      at: nowIso(),
      type: "gateway_ticket_summary",
      mode: connectMode,
      requestedTopicCounts,
      subscribedTopicCounts,
      requestedTopicCount: topicRequests.length,
      subscribedTopicCount: ticketMap.size,
      failureCount: ticketFailures.length,
      failureSample: ticketFailures.slice(0, 12),
      shellSummary: lastShellSummary,
    });
    if (ticketMap.size === 0) {
      await updateStatus({
        state: "connecting_degraded",
        connected: false,
        subscriptionMode: connectMode,
        requestedTopicCounts,
        subscribedTopicCounts,
        lastShellSummary,
        lastTicketFailures: ticketFailures.slice(0, 20),
      });
      await appendBridgeEvent({
        at: nowIso(),
        type: "gateway_ticket_empty",
        mode: connectMode,
        requestedTopics: topicRequests.map((r) => ({
          topicType: r.topicType,
          topicId: r.topicId ?? null,
        })),
      });
      await scheduleReconnect("gateway_ticket_empty");
      return;
    }

    const pendingDynamicTopicSubscriptions = new Set<string>();
    const ensureContextTopicSubscription = (context: Record<string, string> | null): void => {
      if (!context) return;
      const topicType = typeof context.channelId === "string" && context.channelId.length
        ? "channel"
        : typeof context.conversationId === "string" && context.conversationId.length
          ? "conversation"
          : null;
      const topicId =
        topicType === "channel"
          ? context.channelId ?? null
          : topicType === "conversation"
            ? context.conversationId ?? null
            : null;
      if (!topicType || !topicId) return;
      const topicName = `chat:${topicType}:${topicId}`;
      if (ticketMap.has(topicName) || pendingDynamicTopicSubscriptions.has(topicName)) {
        return;
      }
      pendingDynamicTopicSubscriptions.add(topicName);
      void (async () => {
        try {
          const ticket = await callBridge({
            action: "gateway_ticket",
            topicType,
            topicId,
          }) as Record<string, unknown>;
          const issuedTopic = typeof ticket.topic === "string" ? ticket.topic : topicName;
          const issuedTicket = typeof ticket.ticket === "string" ? ticket.ticket : "";
          if (!issuedTicket.trim().length) {
            await appendBridgeEvent({
              at: nowIso(),
              type: "dynamic_topic_ticket_empty",
              topicType,
              topicId,
              topic: issuedTopic,
            });
            return;
          }
          ticketMap.set(issuedTopic, issuedTicket);
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "subscribe", ticket: issuedTicket }));
          }
          const nextCounts = countSubscribedTopics(ticketMap.keys());
          await appendBridgeEvent({
            at: nowIso(),
            type: "dynamic_topic_subscribed",
            topicType,
            topicId,
            topic: issuedTopic,
          });
          await updateStatus({
            subscribedTopics: Array.from(ticketMap.keys()),
            subscribedTopicCounts: nextCounts,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (isBridgeCallError(error) && error.status === 429) {
            const retryMs = Math.max(1000, error.retryAfterMs ?? rateLimitedRetryFallbackMs);
            await appendBridgeEvent({
              at: nowIso(),
              type: "dynamic_topic_rate_limited",
              topicType,
              topicId,
              topic: topicName,
              message,
              retryMs,
            });
            await scheduleReconnect("dynamic_topic_rate_limited", {
              baseDelayMs: retryMs,
              bumpAttempt: false,
            });
            return;
          }
          await appendBridgeEvent({
            at: nowIso(),
            type: "dynamic_topic_subscribe_failed",
            topicType,
            topicId,
            topic: topicName,
            message,
          });
        } finally {
          pendingDynamicTopicSubscriptions.delete(topicName);
        }
      })();
    };

    const socket = new WebSocket(`${wsUrl}?token=${encodeURIComponent(authToken)}`);
    activeSocket = socket;

    socket.on("open", () => {
      if (connectMode !== desiredMode) {
        socket.close(1000, "stale_mode");
        return;
      }
      reconnectAttempt = 0;
      void updateStatus({
        state: "connected",
        connected: true,
        gatewayWsUrl: wsUrl,
        botTokenSource: preferredTokenSource,
        reconnectAttempt,
        lastError: null,
        viewerMainUserId,
        subscribedTopics: Array.from(ticketMap.keys()),
        subscriptionMode: connectMode,
        lastActivityAt: getLastActivityAtIso(),
        lastModeChangeAt: nowIso(),
        requestedTopicCounts,
        subscribedTopicCounts,
        lastShellSummary,
        lastTicketFailures: ticketFailures.slice(0, 20),
      });
      console.log(`[agent-chat-bridge] connected (${connectMode}), subscribed to ${ticketMap.size} topic(s)`);
      for (const ticket of ticketMap.values()) socket.send(JSON.stringify({ type: "subscribe", ticket }));
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" })); }, pingMs);
    });

    socket.on("message", (rawFrame) => {
      const frame = parseWsFrame(rawFrame);
      if (!frame) return;
      void appendBridgeEvent({ at: nowIso(), type: "frame", frame });
      if (frame.type !== "event") return;
      const topic = typeof frame.topic === "string" ? frame.topic : "";
      const event = isRecord(frame.event) ? frame.event as Record<string, unknown> : null;
      if (!event) return;
      const eventType = typeof event.type === "string" ? event.type : "";
      if (
        eventType === "message.created" ||
        eventType === "typing.started" ||
        eventType === "typing.stopped" ||
        eventType === "read.updated"
      ) {
        noteActivity(`${eventType}:${topic || "unknown"}`);
      }
      if (topic.startsWith("chat:user:")) {
        const context = extractContext(topic, event);
        ensureContextTopicSubscription(context);
      }
      if (eventType !== "message.created") return;
      void enrichInbox(topic, event).catch(() => undefined);
    });

    socket.on("close", (code, reasonRaw) => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (activeSocket === socket) activeSocket = null;
      const reasonText = Buffer.isBuffer(reasonRaw) ? reasonRaw.toString("utf8") : typeof reasonRaw === "string" ? reasonRaw : "";
      void scheduleReconnect(`socket_closed code=${code}${reasonText ? ` reason=${reasonText}` : ""}`);
    });

    socket.on("error", (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      void updateStatus({ state: "error", connected: false, lastError: `socket_error: ${msg}` });
    });
  };

  // Shutdown
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    if (tokenWatchTimer) { clearInterval(tokenWatchTimer); tokenWatchTimer = null; }
    const sock = activeSocket; activeSocket = null;
    if (sock && sock.readyState === WebSocket.OPEN) sock.close(1000, "shutdown");
    await updateStatus({ state: "stopped", connected: false, lastError: signal });
    stateDb.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  console.log(`[agent-chat-bridge] starting base=${baseHttpUrl} stateDir=${stateDir}`);
  await updateStatus({
    state: "starting",
    connected: false,
    subscribedTopics: [],
    lastError: null,
    subscriptionMode: desiredMode,
    idleEnabled,
    idleTimeoutMs,
    lastActivityAt: getLastActivityAtIso(),
    lastModeChangeAt: nowIso(),
    requestedTopicCounts: emptyTopicCounts(),
    subscribedTopicCounts: emptyTopicCounts(),
    lastShellSummary: null,
    lastTicketFailures: [],
  });
  await appendBridgeEvent({
    at: nowIso(),
    type: "bridge_start",
    baseHttpUrl,
    stateDir,
    tokenFile,
    autoSubscribeDms: autoSubDms,
    autoSubscribeGroups: autoSubGroups,
    autoSubscribeServers: autoSubServers,
    autoSubscribeChannels: autoSubChannels,
    idleEnabled,
    idleTimeoutMs,
    idleCheckMs,
    idleKeepManualTopics,
  });
  {
    const initialCandidates = await resolveBotTokenCandidates();
    lastObservedTokenValue =
      initialCandidates.length > 0 ? initialCandidates[0]!.token : null;
  }
  if (idleEnabled) {
    idleTimer = setInterval(() => {
      if (stopping || desiredMode !== "full") return;
      const idleForMs = Date.now() - lastActivityAtMs;
      if (idleForMs < idleTimeoutMs) return;
      void requestMode("idle_user_only", `idle_timeout_${idleForMs}ms`);
    }, idleCheckMs);
  }
  tokenWatchTimer = setInterval(() => {
    void (async () => {
      if (stopping) return;
      const candidates = await resolveBotTokenCandidates();
      const latest = candidates.length > 0 ? candidates[0]!.token : null;
      if (latest === lastObservedTokenValue) return;
      lastObservedTokenValue = latest;
      if (!latest) return;
      const socket = activeSocket;
      if (socket && socket.readyState === WebSocket.OPEN) return;
      await appendBridgeEvent({
        at: nowIso(),
        type: "bot_token_updated_detected",
        tokenSource: candidates[0]?.source ?? null,
      });
      if (socket && socket.readyState === WebSocket.CONNECTING) {
        try {
          socket.close(1000, "bot_token_updated");
        } catch {
          // ignore
        }
      }
      await scheduleReconnect("bot_token_updated", {
        baseDelayMs: tokenFastRetryMs,
        bumpAttempt: false,
        force: true,
      });
    })().catch(() => undefined);
  }, tokenPollMs);
  await connect();
};

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stateDir = path.resolve(trimEnv("MG_AGENT_STATE_DIR") ?? path.join("kthx-agents", "state"));
  await writeJsonFile(path.join(stateDir, "ipc", "chat", "status.json"), { state: "fatal", startedAt: nowIso(), updatedAt: nowIso(), connected: false, lastError: message }).catch(() => undefined);
  console.error(`[agent-chat-bridge] ${message}`);
  process.exit(1);
});
