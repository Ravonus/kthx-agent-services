import { isRecord } from "../lib/guards.js";
import { nowIso } from "../lib/text.js";
import type { ShellSummary, SubscriptionMode, TopicRequest } from "./chat-bridge-runtime-primitives.js";
import {
  extractAuthorChatUserId,
  extractAuthorMainUserId,
  extractContext,
  extractMessageId,
  recordId,
  toTrimmedString,
} from "./chat-bridge-runtime-primitives.js";

export const collectTopicsForMode = async (input: {
  mode: SubscriptionMode;
  manualTopics: TopicRequest[];
  idleKeepManualTopics: boolean;
  autoSubDms: boolean;
  autoSubGroups: boolean;
  autoSubServers: boolean;
  autoSubChannels: boolean;
  maxTopics: number;
  callBridge: (payload: Record<string, unknown>) => Promise<unknown>;
  appendBridgeEvent: (payload: Record<string, unknown>) => Promise<void>;
}): Promise<{
  topics: TopicRequest[];
  viewerMainUserId: string | null;
  viewerChatUserId: string | null;
  shellSummary: ShellSummary | null;
}> => {
  const {
    mode,
    manualTopics,
    idleKeepManualTopics,
    autoSubDms,
    autoSubGroups,
    autoSubServers,
    autoSubChannels,
    maxTopics,
    callBridge,
    appendBridgeEvent,
  } = input;

  let viewerMainUserId: string | null = null;
  let viewerChatUserId: string | null = null;
  let shellSummary: ShellSummary | null = null;

  const map = new Map<string, TopicRequest>();
  const add = (topicRequest: TopicRequest): void => {
    const key =
      topicRequest.topicType === "user"
        ? "user"
        : `${topicRequest.topicType}:${topicRequest.topicId ?? ""}`;
    if (!map.has(key)) map.set(key, topicRequest);
  };
  add({ topicType: "user" });

  if (mode === "idle_user_only") {
    if (idleKeepManualTopics) {
      manualTopics.forEach((topicRequest) => add(topicRequest));
    }
    return {
      topics: Array.from(map.values()),
      viewerMainUserId,
      viewerChatUserId,
      shellSummary,
    };
  }

  manualTopics.forEach((topicRequest) => add(topicRequest));

  if (autoSubDms || autoSubGroups || autoSubServers || autoSubChannels) {
    const shell = (await callBridge({ action: "shell" })) as Record<string, unknown> | null;
    const viewer =
      shell && isRecord(shell.viewer)
        ? (shell.viewer as Record<string, unknown>)
        : null;
    viewerMainUserId = toTrimmedString(viewer?.mainUserId);
    viewerChatUserId = toTrimmedString(viewer?.id);
    const dmCount = Array.isArray(shell?.dms) ? shell.dms.length : 0;
    const agentDmCount = Array.isArray(shell?.agentChats) ? shell.agentChats.length : 0;
    const groupCount = Array.isArray(shell?.groups) ? shell.groups.length : 0;
    const servers = Array.isArray(shell?.servers) ? shell.servers : [];
    const serverCount = servers.length;
    const channelCount = servers.reduce((count, server) => {
      if (!isRecord(server)) return count;
      const channels = (server as Record<string, unknown>).channels;
      if (!Array.isArray(channels)) return count;
      return count + channels.length;
    }, 0);
    const shellAt = nowIso();
    shellSummary = {
      at: shellAt,
      mode,
      viewerMainUserId,
      viewerChatUserId,
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
      viewerChatUserId,
      counts: shellSummary.counts,
    });

    if (autoSubDms) {
      for (const list of [
        Array.isArray(shell?.dms) ? shell.dms : [],
        Array.isArray(shell?.agentChats) ? shell.agentChats : [],
      ]) {
        for (const conversation of list as unknown[]) {
          const conversationId = recordId(conversation, ["id", "conversationId"]);
          if (conversationId) add({ topicType: "conversation", topicId: conversationId });
        }
      }
    }

    if (autoSubGroups) {
      for (const conversation of (Array.isArray(shell?.groups) ? shell.groups : []) as unknown[]) {
        const conversationId = recordId(conversation, ["id", "conversationId"]);
        if (conversationId) {
          add({ topicType: "conversation", topicId: conversationId });
        }
      }
    }

    if (autoSubServers) {
      for (const server of (Array.isArray(shell?.servers) ? shell.servers : []) as unknown[]) {
        const serverId = recordId(server, ["id", "serverId"]);
        if (serverId) {
          add({ topicType: "server", topicId: serverId });
        }
      }
    }

    if (autoSubChannels) {
      for (const server of servers as unknown[]) {
        if (!isRecord(server)) continue;
        const channelsRaw = Array.isArray((server as Record<string, unknown>).channels)
          ? (server as Record<string, unknown>).channels
          : Array.isArray((server as Record<string, unknown>).channelList)
            ? (server as Record<string, unknown>).channelList
            : [];
        for (const channel of channelsRaw as unknown[]) {
          const channelId = recordId(channel, ["id", "channelId"]);
          if (channelId) {
            add({ topicType: "channel", topicId: channelId });
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

  return {
    topics: items.length > maxTopics ? items.slice(0, maxTopics) : items,
    viewerMainUserId,
    viewerChatUserId,
    shellSummary,
  };
};

export const enrichInboxEvent = async (input: {
  topic: string;
  event: Record<string, unknown>;
  viewerMainUserId: string | null;
  viewerChatUserId: string | null;
  trackedIds: Set<string>;
  trackId: (id: string) => void;
  untrackId: (id: string) => void;
  callBridge: (payload: Record<string, unknown>) => Promise<unknown>;
  appendBridgeEvent: (payload: Record<string, unknown>) => Promise<void>;
  appendInboxEvent: (payload: Record<string, unknown>) => Promise<void>;
  touchWake: (reason: string) => Promise<void>;
}): Promise<void> => {
  const {
    topic,
    event,
    viewerMainUserId,
    viewerChatUserId,
    trackedIds,
    trackId,
    untrackId,
    callBridge,
    appendBridgeEvent,
    appendInboxEvent,
    touchWake,
  } = input;

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
  const authorMainUserId = extractAuthorMainUserId(event);
  const authorChatUserId = extractAuthorChatUserId(event);
  if (messageId && trackedIds.has(messageId)) return;
  if (messageId) trackId(messageId);
  if (viewerMainUserId && authorMainUserId === viewerMainUserId) return;
  if (viewerChatUserId && authorChatUserId === viewerChatUserId) return;

  let listError: string | null = null;
  const latest = (await callBridge({
    action: "list_messages",
    ...context,
    limit: messageId ? 8 : 1,
  }).catch((error) => {
    listError = error instanceof Error ? error.message : String(error);
    return null;
  })) as Record<string, unknown> | null;
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

  let items = latest && Array.isArray(latest.items) ? (latest.items as Record<string, unknown>[]) : [];
  let matched = messageId
    ? items.find(
        (item) =>
          isRecord(item) &&
          isRecord((item as Record<string, unknown>).message) &&
          ((item as Record<string, unknown>).message as Record<string, unknown>).id ===
            messageId,
      )
    : null;

  if (messageId && !matched) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const retryResult = (await callBridge({
      action: "list_messages",
      ...context,
      limit: 8,
    }).catch(() => null)) as Record<string, unknown> | null;
    if (retryResult && Array.isArray(retryResult.items)) {
      items = retryResult.items as Record<string, unknown>[];
      matched =
        items.find(
          (item) =>
            isRecord(item) &&
            isRecord((item as Record<string, unknown>).message) &&
            ((item as Record<string, unknown>).message as Record<string, unknown>).id ===
              messageId,
        ) ?? null;
    }
  }

  if (messageId && !matched) {
    untrackId(messageId);
    await appendBridgeEvent({
      at: nowIso(),
      level: "warn",
      source: "message_lookup_miss",
      topic,
      messageId,
      message:
        "message.created event did not resolve to list_messages payload after retry; skipping confirm",
    }).catch(() => undefined);
    return;
  }

  const firstItem = matched ?? (messageId ? null : items[0] ?? null);
  if (!isRecord(firstItem)) return;

  const author = isRecord((firstItem as Record<string, unknown>).author)
    ? ((firstItem as Record<string, unknown>).author as Record<string, unknown>)
    : null;
  const messageRecord = isRecord((firstItem as Record<string, unknown>).message)
    ? ((firstItem as Record<string, unknown>).message as Record<string, unknown>)
    : null;
  const listedAuthorMainUserId = toTrimmedString(author?.mainUserId);
  const listedAuthorChatUserId =
    toTrimmedString(messageRecord?.authorChatUserId) ??
    toTrimmedString(author?.id) ??
    toTrimmedString(author?.chatUserId);
  if (!authorMainUserId && viewerMainUserId && listedAuthorMainUserId === viewerMainUserId) return;
  if (!authorChatUserId && viewerChatUserId && listedAuthorChatUserId === viewerChatUserId) return;

  await appendInboxEvent({
    at: nowIso(),
    sourceContext: "CHAT",
    topic,
    eventType,
    context,
    message: firstItem,
  });

  const confirmedId = messageRecord && typeof messageRecord.id === "string" ? messageRecord.id.trim() : "";
  if (confirmedId) {
    const clientMessageId =
      messageRecord && typeof messageRecord.clientMessageId === "string"
        ? messageRecord.clientMessageId.trim()
        : "";
    await callBridge({
      action: "delivery_confirmed",
      ...context,
      messageId: confirmedId,
      ...(clientMessageId ? { clientMessageId } : {}),
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
