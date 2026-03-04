import WebSocket from "ws";

import { nowIso } from "../lib/text.js";
import { parseIsoToMs } from "../lib/time.js";
import { isRecord } from "../lib/guards.js";

import type {
  GatewaySessionSnapshot,
  ShellSummary,
  SubscriptionMode,
  TicketFailure,
  TopicRequest,
} from "./chat-bridge-runtime-primitives.js";
import {
  countSubscribedTopics,
  countTopicRequests,
  extractContext,
  isBotTokenInvalidMessage,
  isBridgeCallError,
  isMissingBotTokenError,
  parseWsFrame,
  toTrimmedString,
} from "./chat-bridge-runtime-primitives.js";
import { collectTopicsForMode, enrichInboxEvent } from "./chat-bridge-runtime-message-flow.js";

export type BridgeConnectMutableState = {
  stopping: boolean;
  desiredMode: SubscriptionMode;
  reconnectAttempt: number;
  cachedGatewaySession: GatewaySessionSnapshot | null;
  viewerMainUserId: string | null;
  viewerChatUserId: string | null;
  lastShellSummary: ShellSummary | null;
  activeSocket: WebSocket | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  preferredTokenSource: string | null;
};

export type BridgeConnectDeps = {
  state: BridgeConnectMutableState;
  manualTopics: TopicRequest[];
  idleKeepManualTopics: boolean;
  autoSubDms: boolean;
  autoSubGroups: boolean;
  autoSubServers: boolean;
  autoSubChannels: boolean;
  maxTopics: number;
  reconnectCatchupLimit: number;
  pingMs: number;
  tokenFastRetryMs: number;
  gatewaySessionReuseSkewMs: number;
  rateLimitedRetryFallbackMs: number;
  trackedIds: Set<string>;
  trackId: (id: string) => void;
  untrackId: (id: string) => void;
  getLastActivityAtIso: () => string;
  updateStatus: (patch: Record<string, unknown>) => Promise<void>;
  callBridge: (payload: Record<string, unknown>) => Promise<unknown>;
  disconnectRealtimeOnAuthDrift: (reason: string) => Promise<void>;
  appendBridgeEvent: (payload: Record<string, unknown>) => Promise<void>;
  haltReconnects: (reason: string) => Promise<void>;
  scheduleReconnect: (
    reason: string,
    options?: { baseDelayMs?: number; bumpAttempt?: boolean; force?: boolean },
  ) => Promise<void>;
  touchWake: (reason: string) => Promise<void>;
  appendInboxEvent: (payload: Record<string, unknown>) => Promise<void>;
  noteActivity: (reason: string) => void;
};

export const runBridgeConnect = async (deps: BridgeConnectDeps): Promise<void> => {
  const {
    state,
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
    trackId,
    untrackId,
    getLastActivityAtIso,
    updateStatus,
    callBridge,
    disconnectRealtimeOnAuthDrift,
    appendBridgeEvent,
    haltReconnects,
    scheduleReconnect,
    touchWake,
    appendInboxEvent,
    noteActivity,
  } = deps;

  if (state.stopping) return;
  const connectMode = state.desiredMode;
  await updateStatus({
    state: "connecting",
    connected: false,
    gatewayWsUrl: null,
    reconnectAttempt: state.reconnectAttempt,
    lastError: null,
    subscriptionMode: connectMode,
    lastActivityAt: getLastActivityAtIso(),
  });

  const resolveReusableGatewaySession = (): Record<string, unknown> | null => {
    const cached = state.cachedGatewaySession;
    if (!cached) return null;
    if (
      cached.authTokenExpiresAtMs !== null &&
      cached.authTokenExpiresAtMs <= Date.now() + gatewaySessionReuseSkewMs
    ) {
      state.cachedGatewaySession = null;
      return null;
    }
    return {
      enabled: true,
      wsUrl: cached.wsUrl,
      authToken: cached.authToken,
      authTokenExpiresAt:
        cached.authTokenExpiresAtMs !== null
          ? new Date(cached.authTokenExpiresAtMs).toISOString()
          : null,
      userTopic: cached.userTopic,
      userTopicTicket: cached.userTopicTicket,
      userTopicExpiresAt:
        cached.userTopicExpiresAtMs !== null
          ? new Date(cached.userTopicExpiresAtMs).toISOString()
          : null,
    };
  };

  const captureGatewaySession = (input: Record<string, unknown>): void => {
    if (input.enabled !== true) {
      state.cachedGatewaySession = null;
      return;
    }
    const wsUrl = typeof input.wsUrl === "string" ? input.wsUrl.trim() : "";
    const authToken =
      typeof input.authToken === "string" ? input.authToken.trim() : "";
    if (!wsUrl.length || !authToken.length) {
      state.cachedGatewaySession = null;
      return;
    }
    state.cachedGatewaySession = {
      wsUrl,
      authToken,
      authTokenExpiresAtMs: parseIsoToMs(input.authTokenExpiresAt),
      userTopic:
        typeof input.userTopic === "string" && input.userTopic.trim().length > 0
          ? input.userTopic.trim()
          : null,
      userTopicTicket:
        typeof input.userTopicTicket === "string" &&
        input.userTopicTicket.trim().length > 0
          ? input.userTopicTicket.trim()
          : null,
      userTopicExpiresAtMs: parseIsoToMs(input.userTopicExpiresAt),
    };
  };

  let session: Record<string, unknown> | null = resolveReusableGatewaySession();
  if (!session) {
    try {
      session = (await callBridge({ action: "gateway_session" })) as Record<
        string,
        unknown
      >;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTokenAuthDrift =
        isMissingBotTokenError(message) || isBotTokenInvalidMessage(message);
      if (isBridgeCallError(error) && error.status === 401 && !isTokenAuthDrift) {
        await disconnectRealtimeOnAuthDrift("chat_bridge_gateway_session_unauthorized");
        await appendBridgeEvent({
          at: nowIso(),
          type: "gateway_session_unauthorized",
          message,
        });
        await haltReconnects(`gateway_session_unauthorized: ${message}`);
        return;
      }
      if (isBridgeCallError(error) && error.status === 429) {
        const retryMs = Math.max(1000, error.retryAfterMs ?? rateLimitedRetryFallbackMs);
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
      if (isBridgeCallError(error) && error.status === 401 && isTokenAuthDrift) {
        const reason = isMissingBotTokenError(message)
          ? "chat_bridge_missing_bot_token"
          : "chat_bridge_invalid_bot_token";
        await disconnectRealtimeOnAuthDrift(reason);
        await appendBridgeEvent({
          at: nowIso(),
          type: "gateway_session_waiting_for_bot_token",
          reason,
          message,
        });
        await updateStatus({
          state: "waiting_for_bot_token",
          connected: false,
          lastError: null,
          subscriptionMode: connectMode,
          lastActivityAt: getLastActivityAtIso(),
        });
        return;
      }
      await scheduleReconnect(`gateway_session_failed: ${message}`);
      return;
    }
    captureGatewaySession(session);
  } else {
    await appendBridgeEvent({
      at: nowIso(),
      type: "gateway_session_reused",
    });
  }

  if (!isRecord(session) || session.enabled !== true) {
    await haltReconnects("chat_gateway_disabled");
    return;
  }
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
    const collected = await collectTopicsForMode({
      mode: connectMode,
      manualTopics,
      idleKeepManualTopics,
      autoSubDms,
      autoSubGroups,
      autoSubServers,
      autoSubChannels,
      maxTopics,
      callBridge: (payload) => callBridge(payload),
      appendBridgeEvent: (payload) => appendBridgeEvent(payload),
    });
    topicRequests = collected.topics;
    state.viewerMainUserId = collected.viewerMainUserId;
    state.viewerChatUserId = collected.viewerChatUserId;
    state.lastShellSummary = collected.shellSummary;
  } catch (error) {
    const topicCollectionError =
      error instanceof Error ? error.message : String(error);
    state.lastShellSummary = null;
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

  const ticketMap = new Map<string, string>();
  const ticketFailures: TicketFailure[] = [];
  let gatewayTicketRateLimitRetryMs: number | null = null;
  if (
    typeof session.userTopic === "string" &&
    typeof session.userTopicTicket === "string" &&
    (session.userTopic as string).length &&
    (session.userTopicTicket as string).length
  ) {
    ticketMap.set(session.userTopic as string, session.userTopicTicket as string);
  }

  for (const request of topicRequests) {
    try {
      const ticket = (await callBridge({
        action: "gateway_ticket",
        topicType: request.topicType,
        ...(request.topicId ? { topicId: request.topicId } : {}),
      })) as Record<string, unknown>;
      if (
        isRecord(ticket) &&
        typeof ticket.topic === "string" &&
        typeof ticket.ticket === "string"
      ) {
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
          topicType: request.topicType,
          topicId: request.topicId ?? null,
          message,
          retryMs: gatewayTicketRateLimitRetryMs,
        });
        break;
      }
      if (ticketFailures.length < 40) {
        ticketFailures.push({
          topicType: request.topicType,
          topicId: request.topicId ?? null,
          message,
        });
      }
      await appendBridgeEvent({
        at: nowIso(),
        type: "gateway_ticket_failed",
        topicType: request.topicType,
        topicId: request.topicId ?? null,
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
      lastShellSummary: state.lastShellSummary,
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
    shellSummary: state.lastShellSummary,
  });
  if (ticketMap.size === 0) {
    await updateStatus({
      state: "connecting_degraded",
      connected: false,
      subscriptionMode: connectMode,
      requestedTopicCounts,
      subscribedTopicCounts,
      lastShellSummary: state.lastShellSummary,
      lastTicketFailures: ticketFailures.slice(0, 20),
    });
    await appendBridgeEvent({
      at: nowIso(),
      type: "gateway_ticket_empty",
      mode: connectMode,
      requestedTopics: topicRequests.map((request) => ({
        topicType: request.topicType,
        topicId: request.topicId ?? null,
      })),
    });
    await scheduleReconnect("gateway_ticket_empty");
    return;
  }

  const pendingDynamicTopicSubscriptions = new Set<string>();
  const ensureContextTopicSubscription = (context: Record<string, string> | null): void => {
    if (!context) return;
    const topicType =
      typeof context.channelId === "string" && context.channelId.length
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
        const ticket = (await callBridge({
          action: "gateway_ticket",
          topicType,
          topicId,
        })) as Record<string, unknown>;
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

  const catchupTopicMessages = async (topic: string): Promise<number> => {
    const context = extractContext(topic, null);
    if (!context) return 0;
    let lookupError: string | null = null;
    const latest = (await callBridge({
      action: "list_messages",
      ...context,
      limit: reconnectCatchupLimit,
    }).catch((error) => {
      lookupError = error instanceof Error ? error.message : String(error);
      return null;
    })) as Record<string, unknown> | null;
    if (!latest || !Array.isArray(latest.items)) {
      if (lookupError) {
        await appendBridgeEvent({
          at: nowIso(),
          level: "warn",
          type: "reconnect_catchup_failed",
          topic,
          context,
          message: lookupError,
        }).catch(() => undefined);
      }
      return 0;
    }

    let importedCount = 0;
    const rows = latest.items.filter(
      (entry): entry is Record<string, unknown> => isRecord(entry),
    );
    for (const row of rows.reverse()) {
      const msg = isRecord(row.message) ? (row.message as Record<string, unknown>) : null;
      const messageId = toTrimmedString(msg?.id);
      if (!messageId || trackedIds.has(messageId)) continue;
      trackId(messageId);

      const author = isRecord(row.author) ? (row.author as Record<string, unknown>) : null;
      const authorMainUserId = toTrimmedString(author?.mainUserId);
      const authorChatUserId =
        toTrimmedString(msg?.authorChatUserId) ??
        toTrimmedString(author?.id) ??
        toTrimmedString(author?.chatUserId);
      if (state.viewerMainUserId && authorMainUserId === state.viewerMainUserId) {
        continue;
      }
      if (state.viewerChatUserId && authorChatUserId === state.viewerChatUserId) {
        continue;
      }

      await appendInboxEvent({
        at: nowIso(),
        sourceContext: "CHAT",
        topic,
        eventType: "message.catchup",
        context,
        message: row,
      });
      importedCount += 1;

      const clientMessageId = toTrimmedString(msg?.clientMessageId);
      await callBridge({
        action: "delivery_confirmed",
        ...context,
        messageId,
        ...(clientMessageId ? { clientMessageId } : {}),
      }).catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await appendBridgeEvent({
          at: nowIso(),
          level: "warn",
          source: "delivery_confirm_failed",
          topic,
          messageId,
          message,
        }).catch(() => undefined);
      });
    }
    return importedCount;
  };

  const runReconnectCatchup = async (): Promise<void> => {
    const topics = Array.from(ticketMap.keys());
    let importedCount = 0;
    let scannedCount = 0;
    for (const topic of topics) {
      if (!topic.startsWith("chat:conversation:") && !topic.startsWith("chat:channel:")) {
        continue;
      }
      scannedCount += 1;
      importedCount += await catchupTopicMessages(topic);
    }
    await appendBridgeEvent({
      at: nowIso(),
      type: "reconnect_catchup_complete",
      scannedCount,
      importedCount,
      limit: reconnectCatchupLimit,
    }).catch(() => undefined);
    if (importedCount > 0) {
      await touchWake("chat_reconnect_catchup");
    }
  };

  const socket = new WebSocket(`${wsUrl}?token=${encodeURIComponent(authToken)}`);
  state.activeSocket = socket;

  socket.on("open", () => {
    if (connectMode !== state.desiredMode) {
      socket.close(1000, "stale_mode");
      return;
    }
    state.reconnectAttempt = 0;
    void updateStatus({
      state: "connected",
      connected: true,
      gatewayWsUrl: wsUrl,
      botTokenSource: state.preferredTokenSource,
      reconnectAttempt: state.reconnectAttempt,
      lastError: null,
      viewerMainUserId: state.viewerMainUserId,
      viewerChatUserId: state.viewerChatUserId,
      subscribedTopics: Array.from(ticketMap.keys()),
      subscriptionMode: connectMode,
      lastActivityAt: getLastActivityAtIso(),
      lastModeChangeAt: nowIso(),
      requestedTopicCounts,
      subscribedTopicCounts,
      lastShellSummary: state.lastShellSummary,
      lastTicketFailures: ticketFailures.slice(0, 20),
    });
    console.log(
      `[agent-chat-bridge] connected (${connectMode}), subscribed to ${ticketMap.size} topic(s)`,
    );
    for (const ticket of ticketMap.values()) {
      socket.send(JSON.stringify({ type: "subscribe", ticket }));
    }
    if (state.pingTimer) clearInterval(state.pingTimer);
    state.pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping" }));
      }
    }, pingMs);
    void runReconnectCatchup().catch(() => undefined);
  });

  socket.on("message", (rawFrame) => {
    const frame = parseWsFrame(rawFrame);
    if (!frame) return;
    void appendBridgeEvent({ at: nowIso(), type: "frame", frame });
    if (frame.type !== "event") return;
    const topic = typeof frame.topic === "string" ? frame.topic : "";
    const event = isRecord(frame.event) ? (frame.event as Record<string, unknown>) : null;
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
    void enrichInboxEvent({
      topic,
      event,
      viewerMainUserId: state.viewerMainUserId,
      viewerChatUserId: state.viewerChatUserId,
      trackedIds,
      trackId: (id) => trackId(id),
      untrackId: (id) => untrackId(id),
      callBridge: (payload) => callBridge(payload),
      appendBridgeEvent: (payload) => appendBridgeEvent(payload),
      appendInboxEvent: (payload) => appendInboxEvent(payload),
      touchWake: (reason) => touchWake(reason),
    }).catch(() => undefined);
  });

  socket.on("close", (code, reasonRaw) => {
    if (state.pingTimer) {
      clearInterval(state.pingTimer);
      state.pingTimer = null;
    }
    if (state.activeSocket === socket) state.activeSocket = null;
    const reasonText =
      Buffer.isBuffer(reasonRaw)
        ? reasonRaw.toString("utf8")
        : typeof reasonRaw === "string"
          ? reasonRaw
          : "";
    void scheduleReconnect(
      `socket_closed code=${code}${reasonText ? ` reason=${reasonText}` : ""}`,
    );
  });

  socket.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    void updateStatus({
      state: "error",
      connected: false,
      lastError: `socket_error: ${message}`,
    });
  });
};
