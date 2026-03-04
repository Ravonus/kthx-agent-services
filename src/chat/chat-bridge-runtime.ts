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
import { jitterDelay } from "../lib/async.js";
import { nowIso } from "../lib/text.js";
import { writeJsonFile, ensureDir } from "../lib/fs-helpers.js";
import { createStateSqliteStoreFromEnv } from "../state/sqlite-state.js";

import type {
  BridgeStatus,
  GatewaySessionSnapshot,
  ReconnectOptions,
  ShellSummary,
  SubscriptionMode,
  TopicRequest,
} from "./chat-bridge-runtime-primitives.js";
import {
  RECONNECT_DELAYS,
  emptyTopicCounts,
  parseAgentUserIdFromKeyBox,
  parseBooleanEnv,
  parseConfiguredTopics,
  readBotTokenFromFile,
  readSecretFromEnvOrFile,
  resolveHttpBaseUrl,
} from "./chat-bridge-runtime-primitives.js";
import {
  disconnectRealtimeOnAuthDrift as _disconnectRealtimeOnAuthDrift,
  recordBridgeActivity as _recordBridgeActivity,
  requestModeSwitch as _requestModeSwitch,
  resolveBridgeAgentMainUserId as _resolveBridgeAgentMainUserId,
} from "./chat-bridge-runtime-control.js";
import {
  createBridgeStateStoreWriters as _createBridgeStateStoreWriters,
  createChatBridgeEventWriters as _createEventWriters,
} from "./chat-bridge-runtime-events.js";
import { executeBridgeCall as _executeBridgeCall } from "./chat-bridge-runtime-bridge-call.js";
import { runBridgeConnect as _runBridgeConnect } from "./chat-bridge-runtime-connect.js";


const main = async (): Promise<void> => {
  await loadDotEnv();

  const baseHttpUrl = resolveHttpBaseUrl();
  let agentKeyBox = await readSecretFromEnvOrFile("MG_AGENT_KEY_BOX", "MG_AGENT_KEY_BOX_FILE");
  const agentKey = trimEnv("MG_AGENT_KEY");
  if (!agentKeyBox && !agentKey) throw new Error("Missing agent auth. Set MG_AGENT_KEY_BOX or MG_AGENT_KEY.");
  let keyBoxAgentMainUserId = parseAgentUserIdFromKeyBox(agentKeyBox);

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
  let stateDbReady = false;
  try {
    stateDb.init();
    stateDbReady = true;
  } catch (error) {
    console.warn("[chat-bridge] state sqlite init failed; continuing without sqlite state store.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const { safeStateAppendEvent, safeStateUpsertSnapshot } =
    _createBridgeStateStoreWriters(stateDb, stateDbReady);

  const maxTrackedIds = Math.max(100, parseIntEnv("MG_CHAT_AGENT_TRACKED_MESSAGE_IDS", 1200));
  const maxTopics = Math.max(5, parseIntEnv("MG_CHAT_AGENT_MAX_TOPICS", 180));
  const reconnectCatchupLimit = Math.max(
    1,
    Math.min(50, parseIntEnv("MG_CHAT_AGENT_RECONNECT_CATCHUP_LIMIT", 20)),
  );
  const pingMs = Math.max(5_000, parseIntEnv("MG_CHAT_AGENT_PING_MS", 25_000));
  const tokenPollMs = Math.max(
    250,
    Math.min(10_000, parseIntEnv("MG_CHAT_AGENT_TOKEN_POLL_MS", 1000)),
  );
  const botTokenExpirySkewMs = Math.max(
    0,
    Math.min(
      300_000,
      parseIntEnv("MG_AGENT_BOT_TOKEN_EXPIRY_SKEW_MS", 15_000),
    ),
  );
  const tokenFastRetryMs = Math.max(
    100,
    Math.min(5_000, parseIntEnv("MG_CHAT_AGENT_TOKEN_FAST_RETRY_MS", 250)),
  );
  const gatewaySessionReuseSkewMs = Math.max(
    5_000,
    parseIntEnv("MG_CHAT_AGENT_GATEWAY_SESSION_REUSE_SKEW_MS", 30_000),
  );
  const rateLimitedRetryFallbackMs = Math.max(
    5_000,
    parseIntEnv("MG_CHAT_AGENT_RATE_LIMIT_RETRY_FALLBACK_MS", 15_000),
  );
  const agentProfileResolveCooldownMs = Math.max(
    2_000,
    parseIntEnv("MG_CHAT_AGENT_PROFILE_RESOLVE_COOLDOWN_MS", 15_000),
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
  const rejectedBotTokenValues = new Set<string>();
  let bridgeRateLimitedUntilMs = 0;
  let bridgeRateLimitedReason: string | null = null;
  let haltReconnectsFn: ((reason: string) => Promise<void>) | null = null;
  let disconnectOnAuthDriftFn: ((reason: string) => Promise<void>) | null = null;
  const realtimeConnectionId = trimEnv("MG_REALTIME_CONNECTION_ID") ?? null;
  let bridgeAgentMainUserId: string | null = null;
  let lastAgentProfileResolveAtMs = 0;
  const bridgeCallState = {
    get preferredTokenSource(): string | null {
      return preferredTokenSource;
    },
    set preferredTokenSource(value: string | null) {
      preferredTokenSource = value;
    },
    get preferredTokenValue(): string | null {
      return preferredTokenValue;
    },
    set preferredTokenValue(value: string | null) {
      preferredTokenValue = value;
    },
    get bridgeRateLimitedUntilMs(): number {
      return bridgeRateLimitedUntilMs;
    },
    set bridgeRateLimitedUntilMs(value: number) {
      bridgeRateLimitedUntilMs = value;
    },
    get bridgeRateLimitedReason(): string | null {
      return bridgeRateLimitedReason;
    },
    set bridgeRateLimitedReason(value: string | null) {
      bridgeRateLimitedReason = value;
    },
  };

  const resolveBotTokenCandidates = async (): Promise<Array<{ source: string; token: string | null }>> => {
    const candidates: Array<{ source: string; token: string }> = [];
    const push = (source: string, token: string | null): void => {
      const t = typeof token === "string" ? token.trim() : "";
      if (!t.length) return;
      if (rejectedBotTokenValues.has(t)) return;
      if (!candidates.some((c) => c.token === t)) {
        candidates.push({ source, token: t });
      }
    };
    push("env:MG_BOT_SESSION_TOKEN", trimEnv("MG_BOT_SESSION_TOKEN"));
    push("env:MG_BOT_TOKEN", trimEnv("MG_BOT_TOKEN"));
    push(
      `file:${tokenFile}`,
      await readBotTokenFromFile(tokenFile, botTokenExpirySkewMs),
    );
    if (botTokenFile) {
      const resolvedBotTokenFile = path.resolve(botTokenFile);
      push(
        `file:${resolvedBotTokenFile}`,
        await readBotTokenFromFile(resolvedBotTokenFile, botTokenExpirySkewMs),
      );
    }
    if (preferredTokenValue && preferredTokenSource) {
      const idx = candidates.findIndex((c) => c.token === preferredTokenValue);
      if (idx > 0) { const [item] = candidates.splice(idx, 1); candidates.unshift(item!); }
    }
    return candidates;
  };

  const refreshAgentKeyBox = async (reason: string): Promise<boolean> => {
    const latestKeyBox = await readSecretFromEnvOrFile(
      "MG_AGENT_KEY_BOX",
      "MG_AGENT_KEY_BOX_FILE",
    );
    const normalized = typeof latestKeyBox === "string" ? latestKeyBox.trim() : "";
    if (!normalized.length) return false;
    if (normalized === (agentKeyBox ?? "")) return false;
    agentKeyBox = normalized;
    keyBoxAgentMainUserId = parseAgentUserIdFromKeyBox(agentKeyBox);
    console.warn(
      `[chat-bridge] Reloaded agent key box from local auth sources (reason=${reason}).`,
    );
    return true;
  };

  const buildHeaders = async (botToken: string | null): Promise<Record<string, string>> => ({
    "content-type": "application/json",
    ...(botToken ? { "x-bot-session-token": botToken } : {}),
    ...(agentKeyBox ? { "x-agent-key-box": agentKeyBox } : { "x-agent-key": agentKey! }),
    ...(realtimeConnectionId
      ? { "x-realtime-connection-id": realtimeConnectionId }
      : {}),
  });

  const callBridge = async (payload: Record<string, unknown>): Promise<unknown> =>
    _executeBridgeCall(
      {
        baseHttpUrl,
        state: bridgeCallState,
        resolveBotTokenCandidates: () => resolveBotTokenCandidates(),
        buildHeaders: (botToken) => buildHeaders(botToken),
        disconnectOnAuthDrift: () => disconnectOnAuthDriftFn,
        haltReconnects: () => haltReconnectsFn,
        refreshAgentKeyBox: (reason) => refreshAgentKeyBox(reason),
        rejectedBotTokenValues,
        rateLimitedRetryFallbackMs,
      },
      payload,
    );

  const touchWake = async (reason: string): Promise<void> => {
    await ensureDir(path.dirname(wakePath));
    await fs.writeFile(wakePath, JSON.stringify({ at: nowIso(), reason }), "utf8").catch(() => undefined);
  };

  const { appendBridgeEvent, appendInboxEvent } = _createEventWriters({
    eventsPath,
    inboxPath,
    safeStateAppendEvent,
  });

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
    viewerChatUserId: null,
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
  let reconnectHaltReason: string | null = null;
  const updateStatus = async (patch: Partial<BridgeStatus>): Promise<void> => {
    const currentState = status.state;
    const requestedState = typeof patch.state === "string" ? patch.state : null;
    const preserveTerminalState =
      reconnectHaltReason !== null &&
      (currentState === "fatal" || currentState === "unauthorized") &&
      requestedState !== "stopped";
    const nextPatch = preserveTerminalState
      ? {
          ...patch,
          state: currentState,
          connected: false,
          lastError: status.lastError ?? patch.lastError ?? null,
        }
      : patch;
    status = { ...status, ...nextPatch, updatedAt: nowIso() };
    await writeJsonFile(statusPath, status).catch(() => undefined);
    safeStateUpsertSnapshot({
      scope: "chat.bridge.status",
      visibility: "public",
      at: status.updatedAt,
      data: status,
    });
  };

  const resolveBridgeAgentMainUserId = async (): Promise<string | null> =>
    _resolveBridgeAgentMainUserId({
      baseHttpUrl,
      agentProfileResolveCooldownMs,
      getBridgeAgentMainUserId: () => bridgeAgentMainUserId,
      setBridgeAgentMainUserId: (value) => {
        bridgeAgentMainUserId = value;
      },
      getLastAgentProfileResolveAtMs: () => lastAgentProfileResolveAtMs,
      setLastAgentProfileResolveAtMs: (value) => {
        lastAgentProfileResolveAtMs = value;
      },
      buildHeaders: (botToken) => buildHeaders(botToken),
    });

  const disconnectRealtimeOnAuthDrift = async (reason: string): Promise<void> =>
    _disconnectRealtimeOnAuthDrift({
      reason,
      viewerMainUserId,
      keyBoxAgentMainUserId,
      realtimeConnectionId,
      getBridgeAgentMainUserId: () => bridgeAgentMainUserId,
      resolveBridgeAgentMainUserId: () => resolveBridgeAgentMainUserId(),
      appendBridgeEvent: (payload) => appendBridgeEvent(payload),
    });
  disconnectOnAuthDriftFn = disconnectRealtimeOnAuthDrift;

  // WebSocket state
  let activeSocket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  let tokenWatchTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectAttempt = 0;
  let cachedGatewaySession: GatewaySessionSnapshot | null = null;
  let lastObservedTokenValue: string | null = null;
  let stopping = false;
  let viewerMainUserId: string | null = null;
  let viewerChatUserId: string | null = null;
  let desiredMode: SubscriptionMode = "full";
  let lastActivityAtMs = Date.now();
  let lastShellSummary: ShellSummary | null = null;
  const connectState = {
    get stopping(): boolean { return stopping; },
    set stopping(value: boolean) { stopping = value; },
    get desiredMode(): SubscriptionMode { return desiredMode; },
    set desiredMode(value: SubscriptionMode) { desiredMode = value; },
    get reconnectAttempt(): number { return reconnectAttempt; },
    set reconnectAttempt(value: number) { reconnectAttempt = value; },
    get cachedGatewaySession(): GatewaySessionSnapshot | null { return cachedGatewaySession; },
    set cachedGatewaySession(value: GatewaySessionSnapshot | null) { cachedGatewaySession = value; },
    get viewerMainUserId(): string | null { return viewerMainUserId; },
    set viewerMainUserId(value: string | null) { viewerMainUserId = value; },
    get viewerChatUserId(): string | null { return viewerChatUserId; },
    set viewerChatUserId(value: string | null) { viewerChatUserId = value; },
    get lastShellSummary(): ShellSummary | null { return lastShellSummary; },
    set lastShellSummary(value: ShellSummary | null) { lastShellSummary = value; },
    get activeSocket(): WebSocket | null { return activeSocket; },
    set activeSocket(value: WebSocket | null) { activeSocket = value; },
    get pingTimer(): ReturnType<typeof setInterval> | null { return pingTimer; },
    set pingTimer(value: ReturnType<typeof setInterval> | null) { pingTimer = value; },
    get preferredTokenSource(): string | null { return preferredTokenSource; },
    set preferredTokenSource(value: string | null) { preferredTokenSource = value; },
  };

  const getLastActivityAtIso = (): string => new Date(lastActivityAtMs).toISOString();
  const requestMode = async (
    nextMode: SubscriptionMode,
    reason: string,
  ): Promise<void> =>
    _requestModeSwitch({
      nextMode,
      reason,
      idleEnabled,
      getDesiredMode: () => desiredMode,
      setDesiredMode: (mode) => {
        desiredMode = mode;
      },
      appendBridgeEvent: (payload) => appendBridgeEvent(payload),
      updateStatus: (patch) => updateStatus(patch),
      getLastActivityAtIso: () => getLastActivityAtIso(),
      scheduleReconnect: (nextReason, options) => scheduleReconnect(nextReason, options),
      getActiveSocket: () => activeSocket,
    });

  const noteActivity = (reason: string): void =>
    _recordBridgeActivity({
      reason,
      idleEnabled,
      getDesiredMode: () => desiredMode,
      setLastActivityAtMs: (value) => {
        lastActivityAtMs = value;
      },
      appendBridgeEvent: (payload) => appendBridgeEvent(payload),
      updateStatus: (patch) => updateStatus(patch),
      getLastActivityAtIso: () => getLastActivityAtIso(),
      requestModeSwitch: (nextMode, nextReason) => requestMode(nextMode, nextReason),
    });

  const haltReconnects = async (reason: string): Promise<void> => {
    if (reconnectHaltReason) return;
    reconnectHaltReason = reason;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    const socket = activeSocket;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      try {
        socket.close(4004, "bridge_unauthorized");
      } catch {
        // ignore
      }
    }
    if (activeSocket === socket) {
      activeSocket = null;
    }
    const lowerReason = reason.toLowerCase();
    const haltState =
      lowerReason.includes("unauthorized") ||
      lowerReason.includes("invalid agent key") ||
      lowerReason.includes("x-agent-key")
        ? "unauthorized"
        : "fatal";
    await appendBridgeEvent({
      at: nowIso(),
      type: "bridge_reconnect_halted",
      reason,
    });
    if (haltState === "unauthorized") {
      await disconnectRealtimeOnAuthDrift("chat_bridge_reconnect_halted_unauthorized");
    }
    await updateStatus({
      state: haltState,
      connected: false,
      lastError: reason,
      reconnectAttempt,
      subscriptionMode: desiredMode,
      lastActivityAt: getLastActivityAtIso(),
    });
  };
  haltReconnectsFn = haltReconnects;

  // Reconnect scheduler
  const scheduleReconnect = async (reason: string, options: ReconnectOptions = {}): Promise<void> => {
    if (stopping) return;
    if (reconnectHaltReason) return;
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
  const connect = async (): Promise<void> =>
    _runBridgeConnect({
      state: connectState,
      manualTopics,
      idleKeepManualTopics,
      autoSubDms,
      autoSubGroups,
      autoSubServers,
      autoSubChannels,
      maxTopics,
      reconnectCatchupLimit,
      pingMs,
      tokenFastRetryMs,
      gatewaySessionReuseSkewMs,
      rateLimitedRetryFallbackMs,
      trackedIds,
      trackId: (id) => trackId(id),
      untrackId: (id) => untrackId(id),
      getLastActivityAtIso: () => getLastActivityAtIso(),
      updateStatus: (patch) => updateStatus(patch),
      callBridge: (payload) => callBridge(payload),
      disconnectRealtimeOnAuthDrift: (reason) => disconnectRealtimeOnAuthDrift(reason),
      appendBridgeEvent: (payload) => appendBridgeEvent(payload),
      haltReconnects: (reason) => haltReconnects(reason),
      scheduleReconnect: (reason, options) => scheduleReconnect(reason, options),
      touchWake: (reason) => touchWake(reason),
      appendInboxEvent: (payload) => appendInboxEvent(payload),
      noteActivity: (reason) => noteActivity(reason),
    });

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
      const refreshedAgentKeyBox = await refreshAgentKeyBox("token_watch_poll");
      if (reconnectHaltReason && refreshedAgentKeyBox) {
        const previousHaltReason = reconnectHaltReason;
        reconnectHaltReason = null;
        await appendBridgeEvent({
          at: nowIso(),
          type: "bridge_reconnect_unhalted",
          reason: "agent_key_box_updated",
          previousHaltReason,
        });
        await scheduleReconnect("agent_key_box_updated", {
          baseDelayMs: tokenFastRetryMs,
          bumpAttempt: false,
          force: true,
        });
        return;
      }
      const candidates = await resolveBotTokenCandidates();
      const latest = candidates.length > 0 ? candidates[0]!.token : null;
      if (latest === lastObservedTokenValue) return;
      lastObservedTokenValue = latest;
      if (latest) {
        rejectedBotTokenValues.delete(latest);
      }
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

export const runChatBridgeCli = (): void => {
  void main().catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const stateDir = path.resolve(
      trimEnv("MG_AGENT_STATE_DIR") ?? path.join("kthx-agents", "state"),
    );
    await writeJsonFile(path.join(stateDir, "ipc", "chat", "status.json"), {
      state: "fatal",
      startedAt: nowIso(),
      updatedAt: nowIso(),
      connected: false,
      lastError: message,
    }).catch(() => undefined);
    console.error(`[agent-chat-bridge] ${message}`);
    process.exit(1);
  });
};
