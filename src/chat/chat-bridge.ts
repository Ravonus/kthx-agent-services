/**
 * Standalone WebSocket bridge for chat functionality.
 *
 * Ported from agent-chat-bridge.mjs.
 *
 * Connects to the chat gateway via HTTP bridge endpoints, establishes a
 * WebSocket session, subscribes to topics (DMs, channels, servers), and
 * writes incoming messages to the chat inbox JSONL. Bot-session tokens are
 * resolved from the environment or a token file, with automatic fallback
 * retry on mismatch.
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TopicRequest = { topicType: string; topicId?: string };

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
};

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
  const legacyWsTokenFile = path.join(stateDir, "secrets", "MG_BOT_SESSION_TOKEN.ws.txt");
  const tokenFile = path.resolve(trimEnv("MG_BOT_SESSION_TOKEN_FILE") ?? defaultTokenFile);
  const botTokenFile = trimEnv("MG_BOT_TOKEN_FILE");
  const eventsPath = path.join(stateDir, "ipc", "chat", "events.jsonl");
  const inboxPath = path.join(stateDir, "ipc", "chat", "inbox.jsonl");
  const statusPath = path.join(stateDir, "ipc", "chat", "status.json");
  const wakePath = path.join(stateDir, "ipc", "wake-chat");

  const maxTrackedIds = Math.max(100, parseIntEnv("MG_CHAT_AGENT_TRACKED_MESSAGE_IDS", 1200));
  const maxTopics = Math.max(5, parseIntEnv("MG_CHAT_AGENT_MAX_TOPICS", 180));
  const pingMs = Math.max(5_000, parseIntEnv("MG_CHAT_AGENT_PING_MS", 25_000));
  const autoSubDms = parseBooleanEnv("MG_CHAT_AGENT_AUTO_SUBSCRIBE_DMS", true);
  const autoSubServers = parseBooleanEnv("MG_CHAT_AGENT_AUTO_SUBSCRIBE_SERVERS", true);
  const manualTopics = parseConfiguredTopics(trimEnv("MG_CHAT_AGENT_TOPICS"));

  let preferredTokenSource: string | null = null;
  let preferredTokenValue: string | null = null;

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
    if (defaultTokenFile !== tokenFile) push(`file:${defaultTokenFile}`, await readBotTokenFromFile(defaultTokenFile));
    push(`file:${legacyWsTokenFile}`, await readBotTokenFromFile(legacyWsTokenFile));
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
    const candidates = await resolveBotTokenCandidates();
    const attempts = candidates.length > 0 ? candidates : [{ source: "none", token: null }];
    let lastError: Error | null = null;

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
        return (body as Record<string, unknown>).data;
      }
      const errMsg = isRecord(body) && typeof (body as Record<string, unknown>).error === "string" ? (body as Record<string, unknown>).error as string : `HTTP ${res.status}`;
      lastError = new Error(`${errMsg} (tokenSource=${candidate.source})`);
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
  let status: BridgeStatus = { state: "booting", startedAt: nowIso(), updatedAt: nowIso(), baseHttpUrl, gatewayWsUrl: null, botTokenSource: null, reconnectAttempt: 0, connected: false, subscribedTopics: [], lastError: null, viewerMainUserId: null };
  const updateStatus = async (patch: Partial<BridgeStatus>): Promise<void> => {
    status = { ...status, ...patch, updatedAt: nowIso() };
    await writeJsonFile(statusPath, status).catch(() => undefined);
  };

  // WebSocket state
  let activeSocket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectAttempt = 0;
  let stopping = false;
  let viewerMainUserId: string | null = null;

  // Topic collection
  const collectTopics = async (): Promise<TopicRequest[]> => {
    const map = new Map<string, TopicRequest>();
    const add = (r: TopicRequest): void => {
      const key = r.topicType === "user" ? "user" : `${r.topicType}:${r.topicId ?? ""}`;
      if (!map.has(key)) map.set(key, r);
    };
    add({ topicType: "user" });
    manualTopics.forEach((r) => add(r));

    if (autoSubDms || autoSubServers) {
      const shell = await callBridge({ action: "shell" }) as Record<string, unknown> | null;
      const viewer = shell && isRecord(shell.viewer) ? shell.viewer as Record<string, unknown> : null;
      viewerMainUserId = viewer && typeof viewer.mainUserId === "string" ? viewer.mainUserId as string : null;

      if (autoSubDms) {
        for (const list of [Array.isArray(shell?.dms) ? shell.dms : [], Array.isArray(shell?.agentChats) ? shell.agentChats : []]) {
          for (const conv of list as unknown[]) {
            if (isRecord(conv) && typeof (conv as Record<string, unknown>).id === "string") add({ topicType: "conversation", topicId: (conv as Record<string, unknown>).id as string });
          }
        }
      }
      if (autoSubServers) {
        for (const srv of (Array.isArray(shell?.servers) ? shell.servers : []) as unknown[]) {
          if (isRecord(srv) && typeof (srv as Record<string, unknown>).id === "string") add({ topicType: "server", topicId: (srv as Record<string, unknown>).id as string });
        }
      }
    }
    const items = Array.from(map.values());
    return items.length > maxTopics ? items.slice(0, maxTopics) : items;
  };

  // Inbox enrichment
  const enrichInbox = async (topic: string, event: Record<string, unknown>): Promise<void> => {
    const eventType = typeof event.type === "string" ? event.type.trim() : "";
    if (eventType !== "message.created") return;
    const context = extractContext(topic, event);
    if (!context) return;

    const messageId = extractMessageId(event);
    const authorId = extractAuthorMainUserId(event);
    if (messageId && trackedIds.has(messageId)) return;
    if (messageId) trackId(messageId);
    if (viewerMainUserId && authorId === viewerMainUserId) return;

    const latest = await callBridge({
      action: "list_messages",
      ...context,
      limit: messageId ? 8 : 1,
    }).catch(() => null) as Record<string, unknown> | null;

    const items = latest && Array.isArray(latest.items) ? latest.items as Record<string, unknown>[] : [];
    const matched = messageId ? items.find((item) => isRecord(item) && isRecord((item as Record<string, unknown>).message) && ((item as Record<string, unknown>).message as Record<string, unknown>).id === messageId) : null;
    if (messageId && !matched) { untrackId(messageId); return; }
    const firstItem = matched ?? (messageId ? null : items[0] ?? null);
    if (!isRecord(firstItem)) return;

    // Self-message filter
    const author = isRecord((firstItem as Record<string, unknown>).author) ? (firstItem as Record<string, unknown>).author as Record<string, unknown> : null;
    if (!authorId && viewerMainUserId && author && author.mainUserId === viewerMainUserId) return;

    await appendJsonLine(inboxPath, { at: nowIso(), sourceContext: "CHAT", topic, eventType, context, message: firstItem });

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
      }).catch(() => undefined);
    }

    await touchWake("chat_message_received");
  };

  // Reconnect scheduler
  const scheduleReconnect = async (reason: string): Promise<void> => {
    if (stopping || reconnectTimer) return;
    reconnectAttempt += 1;
    const baseDelay = RECONNECT_DELAYS[Math.min(reconnectAttempt - 1, RECONNECT_DELAYS.length - 1)] ?? 30_000;
    const delay = jitterDelay(baseDelay);
    console.warn(`[agent-chat-bridge] reconnect in ${delay}ms (attempt ${reconnectAttempt}): ${reason}`);
    await updateStatus({ state: "reconnecting", connected: false, reconnectAttempt, lastError: reason });
    reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, delay);
  };

  // Connect
  const connect = async (): Promise<void> => {
    if (stopping) return;
    await updateStatus({ state: "connecting", connected: false, gatewayWsUrl: null, reconnectAttempt, lastError: null });

    let session: Record<string, unknown>;
    try {
      session = await callBridge({ action: "gateway_session" }) as Record<string, unknown>;
    } catch (e) {
      await scheduleReconnect(`gateway_session_failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    if (!isRecord(session) || session.enabled !== true) { await scheduleReconnect("chat_gateway_disabled"); return; }
    const wsUrl = typeof session.wsUrl === "string" ? session.wsUrl : null;
    const authToken = typeof session.authToken === "string" ? session.authToken : null;
    if (!wsUrl || !authToken) { await scheduleReconnect("missing_ws_credentials"); return; }
    await updateStatus({ gatewayWsUrl: wsUrl });

    let topicRequests: TopicRequest[];
    try { topicRequests = await collectTopics(); } catch (e) {
      await scheduleReconnect(`topic_collection_failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // Collect tickets
    const ticketMap = new Map<string, string>();
    if (typeof session.userTopic === "string" && typeof session.userTopicTicket === "string" && (session.userTopic as string).length && (session.userTopicTicket as string).length) {
      ticketMap.set(session.userTopic as string, session.userTopicTicket as string);
    }
    for (const req of topicRequests) {
      try {
        const ticket = await callBridge({ action: "gateway_ticket", topicType: req.topicType, ...(req.topicId ? { topicId: req.topicId } : {}) }) as Record<string, unknown>;
        if (isRecord(ticket) && typeof ticket.topic === "string" && typeof ticket.ticket === "string") {
          ticketMap.set(ticket.topic as string, ticket.ticket as string);
        }
      } catch { /* best-effort */ }
    }

    const socket = new WebSocket(`${wsUrl}?token=${encodeURIComponent(authToken)}`);
    activeSocket = socket;

    socket.on("open", () => {
      reconnectAttempt = 0;
      void updateStatus({ state: "connected", connected: true, gatewayWsUrl: wsUrl, botTokenSource: preferredTokenSource, reconnectAttempt, lastError: null, viewerMainUserId, subscribedTopics: Array.from(ticketMap.keys()) });
      console.log(`[agent-chat-bridge] connected, subscribed to ${ticketMap.size} topic(s)`);
      for (const ticket of ticketMap.values()) socket.send(JSON.stringify({ type: "subscribe", ticket }));
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" })); }, pingMs);
    });

    socket.on("message", (rawFrame) => {
      const frame = parseWsFrame(rawFrame);
      if (!frame) return;
      void appendJsonLine(eventsPath, { at: nowIso(), frame });
      if (frame.type !== "event") return;
      const topic = typeof frame.topic === "string" ? frame.topic : "";
      const event = isRecord(frame.event) ? frame.event as Record<string, unknown> : null;
      if (!event || event.type !== "message.created") return;
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
    const sock = activeSocket; activeSocket = null;
    if (sock && sock.readyState === WebSocket.OPEN) sock.close(1000, "shutdown");
    await updateStatus({ state: "stopped", connected: false, lastError: signal });
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  console.log(`[agent-chat-bridge] starting base=${baseHttpUrl} stateDir=${stateDir}`);
  await updateStatus({ state: "starting", connected: false, subscribedTopics: [], lastError: null });
  await appendJsonLine(eventsPath, { at: nowIso(), type: "bridge_start", baseHttpUrl, stateDir, tokenFile, autoSubscribeDms: autoSubDms, autoSubscribeServers: autoSubServers });
  await connect();
};

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stateDir = path.resolve(trimEnv("MG_AGENT_STATE_DIR") ?? path.join("kthx-agents", "state"));
  await writeJsonFile(path.join(stateDir, "ipc", "chat", "status.json"), { state: "fatal", startedAt: nowIso(), updatedAt: nowIso(), connected: false, lastError: message }).catch(() => undefined);
  console.error(`[agent-chat-bridge] ${message}`);
  process.exit(1);
});
