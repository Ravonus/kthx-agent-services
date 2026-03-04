import path from "node:path";

import { isRecord } from "../lib/guards.js";

import {
  bool,
  CHAT_AUTO_REPLY,
  DIRECTIVE_EXECUTED,
  DIRECTIVE_FAILED,
  DIRECTIVE_STAGED_TYPES,
  intFromUnknown,
  iso,
  MEMORY_REFRESH,
  normalizeKeywordIndex,
  normalizeLongTermArchiveIndex,
  normalizeRetentionPolicy,
  NOTIFICATIONS_FLUSHED,
  num,
  PUBLISH_RESULT,
  resolveKthxConfigPath,
  str,
  TAIL_MAX_BYTES,
  TAIL_MAX_LINES,
} from "./health-web-shared.js";
import {
  eventAt,
  getStateDb,
  parseJsonLines,
  readJsonRecord,
  readTailLines,
  resolveStateDir,
} from "./health-web-runtime-pipeline.js";

export const buildPublicProjection = (
  snapshot: Record<string, unknown>,
): Record<string, unknown> => {
  const runtime = isRecord(snapshot.runtime)
    ? (snapshot.runtime)
    : {};
  const chatBridge = isRecord(snapshot.chatBridge)
    ? (snapshot.chatBridge)
    : {};
  const agent = isRecord(snapshot.agent)
    ? (snapshot.agent)
    : {};
  const memory = isRecord(snapshot.memory)
    ? (snapshot.memory)
    : {};
  const retention = isRecord(snapshot.retention) ? snapshot.retention : {};
  const activity = isRecord(snapshot.activity)
    ? (snapshot.activity)
    : {};

  return {
    generatedAt: iso(snapshot.generatedAt) ?? new Date().toISOString(),
    available: bool(snapshot.available) ?? false,
    reason: str(snapshot.reason),
    runtime: {
      wsState: str(runtime.wsState),
      wsTransportState: str(runtime.wsTransportState),
      authEffective: str(runtime.authEffective),
      permissionState: str(runtime.permissionState),
      lastEnvelopeAt: iso(runtime.lastEnvelopeAt),
      lastPublishAt: iso(runtime.lastPublishAt),
      lastPublishError: str(runtime.lastPublishError),
    },
    chatBridge: {
      connected: bool(chatBridge.connected),
      state: str(chatBridge.state),
      subscribedTopics: num(chatBridge.subscribedTopics),
      subscriptionMode: str(chatBridge.subscriptionMode),
      requestedTopicCounts: isRecord(chatBridge.requestedTopicCounts)
        ? (chatBridge.requestedTopicCounts)
        : null,
      subscribedTopicCounts: isRecord(chatBridge.subscribedTopicCounts)
        ? (chatBridge.subscribedTopicCounts)
        : null,
      lastShellSummary: isRecord(chatBridge.lastShellSummary)
        ? (chatBridge.lastShellSummary)
        : null,
      lastTicketFailureCount: Array.isArray(chatBridge.lastTicketFailures)
        ? chatBridge.lastTicketFailures.length
        : null,
      lastError: str(chatBridge.lastError),
      updatedAt: iso(chatBridge.updatedAt),
      lastEventAt: iso(chatBridge.lastEventAt),
    },
    agent: {
      userId: str(agent.userId),
      handle: str(agent.handle),
      name: str(agent.name),
      profileSet: bool(agent.profileSet),
      openClawAgentName: str(agent.openClawAgentName),
      openClawBinaryOk: bool(agent.openClawBinaryOk),
      openClawBinarySource: str(agent.openClawBinarySource),
      openClawBinaryVersion: str(agent.openClawBinaryVersion),
      openClawBinaryError: str(agent.openClawBinaryError),
      identityUpdatedAt: iso(agent.identityUpdatedAt),
      visualSetupReady: bool(agent.visualSetupReady),
      visualSetupNotificationState: str(agent.visualSetupNotificationState),
      visualSetupUpdatedAt: iso(agent.visualSetupUpdatedAt),
      visualSetupMissingItems: Array.isArray(agent.visualSetupMissingItems)
        ? (agent.visualSetupMissingItems as unknown[])
        : [],
    },
    memory: {
      moodPrimary: str(memory.moodPrimary),
      moodScore: num(memory.moodScore),
      tier24hEvents: num(memory.tier24hEvents),
      tier7dEvents: num(memory.tier7dEvents),
      keywordIndexDocs: num(memory.keywordIndexDocs),
      keywordIndexKeywords: num(memory.keywordIndexKeywords),
      longTermArchiveCapsules: num(memory.longTermArchiveCapsules),
      longTermArchiveLatestCompactedAt: iso(
        memory.longTermArchiveLatestCompactedAt,
      ),
      longTermArchiveAgentCompressed: num(memory.longTermArchiveAgentCompressed),
      longTermArchiveAlgorithmCompressed: num(
        memory.longTermArchiveAlgorithmCompressed,
      ),
    },
    retention: {
      enabled: bool(retention.enabled),
      intervalMinutes: num(retention.intervalMinutes),
      postsDays: num(retention.postsDays),
      interactionsDays: num(retention.interactionsDays),
      notificationsDays: num(retention.notificationsDays),
      longTermEnabled: bool(retention.longTermEnabled),
      longTermMaxCapsules: num(retention.longTermMaxCapsules),
      longTermMaxCompactionsPerRun: num(retention.longTermMaxCompactionsPerRun),
    },
    activity: {
      publishSuccess: num(activity.publishSuccess),
      publishFailed: num(activity.publishFailed),
      directivesExecuted: num(activity.directivesExecuted),
      chatMessagesReceived: num(activity.chatMessagesReceived),
      chatAutoRepliesSent: num(activity.chatAutoRepliesSent),
      recentEvents: Array.isArray(activity.recentEvents)
        ? (activity.recentEvents as unknown[])
        : [],
    },
  };
};

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

export const buildSnapshot = async (): Promise<Record<string, unknown>> => {
  const stateDir = resolveStateDir();
  const ipcDir = path.join(stateDir, "ipc");
  const chatDir = path.join(ipcDir, "chat");
  const debugDir = path.join(ipcDir, "debug");
  const memDir = path.join(stateDir, "memory");

  const files = {
    latestDebug: path.join(debugDir, "latest.json"),
    chatStatus: path.join(chatDir, "status.json"),
    chatRuntimeState: path.join(chatDir, "runtime-state.json"),
    notifications: path.join(stateDir, "notifications.jsonl"),
    memoryActivity: path.join(stateDir, "memory-activity.jsonl"),
    agentIdentity: path.join(ipcDir, "auth", "agent-identity.json"),
    mood: path.join(memDir, "mood.json"),
    temporal: path.join(memDir, "context", "temporal.json"),
    keywordIndex: path.join(memDir, "context", "keyword-index.json"),
    longTermArchiveIndex: path.join(
      memDir,
      "context",
      "long-term-archive-index.json",
    ),
    writes: path.join(stateDir, "writes.jsonl"),
    chatInbox: path.join(chatDir, "inbox.jsonl"),
    kthxConfig: resolveKthxConfigPath(stateDir),
    visualSetupStatus: path.join(ipcDir, "auth", "visual-setup-status.json"),
  };

  const [
    latestDebug,
    chatStatus,
    chatRuntimeState,
    agentIdentity,
    mood,
    temporal,
    keywordIndexRaw,
    longTermArchiveRaw,
    kthxConfigRaw,
    visualSetupStatusRaw,
    writes,
    inbox,
  ] = await Promise.all([
    readJsonRecord(files.latestDebug),
    readJsonRecord(files.chatStatus),
    readJsonRecord(files.chatRuntimeState),
    readJsonRecord(files.agentIdentity),
    readJsonRecord(files.mood),
    readJsonRecord(files.temporal),
    readJsonRecord(files.keywordIndex),
    readJsonRecord(files.longTermArchiveIndex),
    readJsonRecord(files.kthxConfig),
    readJsonRecord(files.visualSetupStatus),
    readTailLines(files.writes, TAIL_MAX_BYTES, TAIL_MAX_LINES),
    readTailLines(files.chatInbox, TAIL_MAX_BYTES, TAIL_MAX_LINES),
  ]);
  const keywordIndex = normalizeKeywordIndex(keywordIndexRaw);
  const longTermArchive = normalizeLongTermArchiveIndex(longTermArchiveRaw);
  const retentionPolicy = normalizeRetentionPolicy(kthxConfigRaw);
  const visualSetupStatus = isRecord(visualSetupStatusRaw) ? visualSetupStatusRaw : null;

  const writeRecords = parseJsonLines(writes);
  const inboxRecords = parseJsonLines(inbox);

  let publishSuccess = 0, publishFailed = 0, directivesStaged = 0, directivesExecuted = 0, directivesFailed = 0;
  let chatAutoReplies = 0, memoryRefreshes = 0, notificationsFlushed = 0;
  let lastDirectiveAt: string | null = null, lastPublishAt: string | null = null;
  let lastInboundAt: string | null = null, lastAutoReplyAt: string | null = null;
  let lastOpenClawAgentName: string | null = null;
  let lastOpenClawProbe: Record<string, unknown> | null = null;
  const recentEvents: Array<{ at: string | null; type: string; detail: string | null }> = [];

  for (const envelope of writeRecords) {
    const payload = isRecord(envelope.payload) ? envelope.payload : null;
    if (!payload) continue;
    const type = str(payload.type);
    if (!type) continue;
    const at = eventAt(envelope, payload);

    if (type === PUBLISH_RESULT) { if (bool(payload.ok) === true) publishSuccess++; else publishFailed++; lastPublishAt = at ?? lastPublishAt; }
    if (DIRECTIVE_STAGED_TYPES.has(type)) { directivesStaged++; lastDirectiveAt = at ?? lastDirectiveAt; }
    if (type === DIRECTIVE_EXECUTED) { directivesExecuted++; lastDirectiveAt = at ?? lastDirectiveAt; }
    if (type === DIRECTIVE_FAILED) { directivesFailed++; lastDirectiveAt = at ?? lastDirectiveAt; }
    if (type === CHAT_AUTO_REPLY) { chatAutoReplies++; lastAutoReplyAt = at ?? lastAutoReplyAt; }
    if (type === MEMORY_REFRESH) memoryRefreshes++;
    if (type === NOTIFICATIONS_FLUSHED) notificationsFlushed++;
    if (type === "openclaw_prompt_result") {
      const agentName = str(payload.agentName);
      if (agentName) lastOpenClawAgentName = agentName;
    }
    if (type === "openclaw_binary_probe") {
      lastOpenClawProbe = payload;
    }

    const detail = type === PUBLISH_RESULT
      ? (bool(payload.ok) === true ? "publish ok" : str(payload.error) ?? "publish failed")
      : type.startsWith("directive_") ? str(payload.directiveId) : type === CHAT_AUTO_REPLY ? str(payload.replyToMessageId) : type === MEMORY_REFRESH ? str(payload.source) : null;
    recentEvents.push({ at, type, detail });
  }

  const inboundIds = new Set<string>();
  for (const row of inboxRecords) {
    const envelopeMsg = isRecord(row.message) ? row.message : null;
    const nested = envelopeMsg && isRecord(envelopeMsg.message) ? envelopeMsg.message : envelopeMsg;
    const msgId = str(nested?.id);
    if (msgId) { inboundIds.add(msgId); lastInboundAt = iso(row.at) ?? iso(row.receivedAt) ?? lastInboundAt; }
  }

  const ws = latestDebug && isRecord(latestDebug.ws) ? latestDebug.ws : null;
  const auth = latestDebug && isRecord(latestDebug.auth) ? latestDebug.auth : null;
  const authUser = auth && isRecord(auth.user) ? auth.user : null;
  const perm = latestDebug && isRecord(latestDebug.permission) ? latestDebug.permission : null;
  const pub = latestDebug && isRecord(latestDebug.publish) ? latestDebug.publish : null;

  const tiers = temporal && isRecord(temporal.tiers) ? temporal.tiers : null;
  const t24 = tiers && isRecord(tiers["24h"]) ? tiers["24h"] : null;
  const t7d = tiers && isRecord(tiers["7d"]) ? tiers["7d"] : null;
  const t30d = tiers && isRecord(tiers["30d"]) ? tiers["30d"] : null;
  const t365d = tiers && isRecord(tiers["365d"]) ? tiers["365d"] : null;
  const visualSetupMissingItems = Array.isArray(visualSetupStatus?.setupGaps)
    ? visualSetupStatus.setupGaps
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : [];

  const available = [latestDebug, chatStatus, mood, temporal].some(
    (item) => item !== null && item !== undefined,
  );
  const snapshot: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    available,
    reason: available ? null : "No runtime state files found yet.",
    stateDir,
    files,
    runtime: {
      wsState: str(ws?.state), wsTransportState: str(ws?.transportState), wsAt: iso(ws?.at),
      wsActivityAt: iso(ws?.activityAt), wsActivitySource: str(ws?.activitySource),
      authState: str(auth?.state), authEffective: str(auth?.authEffective) ?? str(auth?.effective) ?? str(auth?.status),
      permissionState: str(perm?.state) ?? str(perm?.status), permissionReason: str(perm?.reason) ?? str(perm?.detail),
      lastEnvelopeAt: iso(latestDebug?.lastEnvelopeAt), lastPublishAt: iso(pub?.at),
      lastPublishOk: bool(pub?.ok), lastPublishError: str(pub?.error),
    },
    chatBridge: {
      connected: bool(chatStatus?.connected), state: str(chatStatus?.state), updatedAt: iso(chatStatus?.updatedAt),
      subscribedTopics: Array.isArray(chatStatus?.subscribedTopics) ? (chatStatus.subscribedTopics as unknown[]).length : 0,
      subscriptionMode: str(chatStatus?.subscriptionMode),
      requestedTopicCounts: isRecord(chatStatus?.requestedTopicCounts)
        ? (chatStatus?.requestedTopicCounts)
        : null,
      subscribedTopicCounts: isRecord(chatStatus?.subscribedTopicCounts)
        ? (chatStatus?.subscribedTopicCounts)
        : null,
      lastShellSummary: isRecord(chatStatus?.lastShellSummary)
        ? (chatStatus?.lastShellSummary)
        : null,
      lastTicketFailures: Array.isArray(chatStatus?.lastTicketFailures)
        ? (chatStatus?.lastTicketFailures as unknown[])
        : [],
      lastError: str(chatStatus?.lastError), lastEventAt: iso(chatStatus?.lastEventAt),
      runtimeReadOffset: num(chatRuntimeState?.readOffset),
      runtimeLastProcessedMessageId: str(chatRuntimeState?.lastProcessedMessageId),
      runtimeLastProcessedAt: iso(chatRuntimeState?.lastProcessedAt),
    },
    agent: {
      userId:
        str(chatStatus?.viewerMainUserId) ??
        str(auth?.userId) ??
        str(auth?.mainUserId) ??
        str(authUser?.id),
      handle:
        str(agentIdentity?.handle) ??
        str(auth?.handle) ??
        str(authUser?.handle),
      name:
        str(agentIdentity?.name) ??
        str(auth?.name) ??
        str(authUser?.name),
      profileSet: Boolean(
        str(agentIdentity?.handle) ??
          str(agentIdentity?.name) ??
          str(agentIdentity?.bio),
      ),
      bio: str(agentIdentity?.bio),
      personality: str(agentIdentity?.personality),
      identityUpdatedAt: iso(agentIdentity?.updatedAt),
      openClawAgentName: lastOpenClawAgentName,
      openClawBinaryCommand: str(lastOpenClawProbe?.command),
      openClawBinarySource: str(lastOpenClawProbe?.source),
      openClawBinaryOk: bool(lastOpenClawProbe?.probeOk),
      openClawBinaryVersion: str(lastOpenClawProbe?.probeVersion),
      openClawBinaryError: str(lastOpenClawProbe?.probeError),
      visualSetupReady: bool(visualSetupStatus?.ready),
      visualSetupNotificationState: str(visualSetupStatus?.notificationState),
      visualSetupUpdatedAt: iso(visualSetupStatus?.checkedAt),
      visualSetupMissingItems,
    },
    memory: {
      moodPrimary: str(mood?.primary), moodScore: num(mood?.score), moodUpdatedAt: iso(mood?.updatedAt),
      temporalUpdatedAt: iso(temporal?.updatedAt),
      tier24hEvents: num(t24?.eventCount), tier7dEvents: num(t7d?.eventCount),
      tier30dEvents: num(t30d?.eventCount), tier365dEvents: num(t365d?.eventCount),
      tier30dCompressedBy: str(t30d?.compressedBy), tier365dCompressedBy: str(t365d?.compressedBy),
      keywordIndexUpdatedAt: iso(keywordIndex.updatedAt),
      keywordIndexDocs: Object.keys(keywordIndex.docs).length,
      keywordIndexKeywords: Object.keys(keywordIndex.inverted).length,
      longTermArchiveUpdatedAt: iso(longTermArchive.updatedAt),
      longTermArchiveCapsules: longTermArchive.items.length,
      longTermArchiveLatestCompactedAt: longTermArchive.items[0]?.compactedAt ?? null,
      longTermArchiveAgentCompressed: longTermArchive.items.filter((item) => item.compressedBy === "agent").length,
      longTermArchiveAlgorithmCompressed: longTermArchive.items.filter((item) => item.compressedBy !== "agent").length,
    },
    retention: retentionPolicy,
    activity: {
      scannedWrites: writeRecords.length, scannedInbox: inboxRecords.length,
      publishSuccess, publishFailed, directivesStaged, directivesExecuted, directivesFailed,
      chatMessagesReceived: inboundIds.size, chatAutoRepliesSent: chatAutoReplies,
      memoryRefreshes, notificationsFlushed,
      lastDirectiveAt, lastPublishAt, lastInboundMessageAt: lastInboundAt, lastAutoReplyAt,
      recentEvents: recentEvents.slice(-12).reverse(),
    },
  };

  const publicSnapshot = buildPublicProjection(snapshot);
  try {
    const db = getStateDb();
    db.upsertSnapshot({
      scope: "health.public.v1",
      visibility: "public",
      at: iso(snapshot.generatedAt) ?? null,
      data: publicSnapshot,
    });
    db.upsertSnapshot({
      scope: "health.private.v1",
      visibility: "private",
      at: iso(snapshot.generatedAt) ?? null,
      data: snapshot,
    });
  } catch {
    // best effort: keep file-based health available
  }

  return snapshot;
};
