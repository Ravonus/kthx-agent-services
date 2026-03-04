import fs from "node:fs/promises";
import path from "node:path";

import { trimEnv } from "../lib/env-parse.js";
import { isRecord } from "../lib/guards.js";
import {
  createStateSqliteStoreFromEnv,
  type StateSqliteStore,
} from "../state/sqlite-state.js";

import {
  bool,
  CHAT_AUTO_REPLY,
  DIRECTIVE_EXECUTED,
  DIRECTIVE_FAILED,
  DIRECTIVE_STAGED_TYPES,
  ENGAGEMENT_CONTEXT_PRIME_COMPLETED,
  ENGAGEMENT_CONTEXT_PRIME_EMPTY,
  ENGAGEMENT_CONTEXT_SEED,
  ENGAGEMENT_TARGET_RESOLVED,
  ENGAGEMENT_TARGET_RESOLUTION_FAILED,
  formatRangeLabelFromMs,
  INBOX_COMMAND_REQUEUED,
  intFromUnknown,
  iso,
  MEMORY_REFRESH,
  NOTIFICATIONS_FLUSHED,
  PUBLISH_RESULT,
  QUEUE_NOT_READY_REQUEUED,
  str,
} from "./health-web-shared.js";

export const buildRuntimeMetricsDiagnostics = (input: {
  writeRecords: Record<string, unknown>[];
  inboxRecords: Record<string, unknown>[];
  rangeMs: number;
  bucketMs: number;
}): Record<string, unknown> => {
  const nowMs = Date.now();
  const safeRangeMs = Math.max(60_000, Math.min(366 * 86_400_000, input.rangeMs));
  const safeBucketMs = Math.max(60_000, Math.min(24 * 3_600_000, input.bucketMs));
  const sinceMs = nowMs - safeRangeMs;
  const timeline = new Map<
    number,
    {
      bucketAt: string;
      publishOk: number;
      publishFailed: number;
      directivesStaged: number;
      directivesExecuted: number;
      directivesFailed: number;
      chatAutoReplies: number;
      memoryRefreshes: number;
      notificationsFlushed: number;
      inboundMessages: number;
      openClawPrompts: number;
      total: number;
    }
  >();
  const ensureBucket = (atMs: number) => {
    const bucketStartMs = Math.floor(atMs / safeBucketMs) * safeBucketMs;
    const existing = timeline.get(bucketStartMs);
    if (existing) return existing;
    const created = {
      bucketAt: new Date(bucketStartMs).toISOString(),
      publishOk: 0,
      publishFailed: 0,
      directivesStaged: 0,
      directivesExecuted: 0,
      directivesFailed: 0,
      chatAutoReplies: 0,
      memoryRefreshes: 0,
      notificationsFlushed: 0,
      inboundMessages: 0,
      openClawPrompts: 0,
      total: 0,
    };
    timeline.set(bucketStartMs, created);
    return created;
  };

  const totals = {
    publishOk: 0,
    publishFailed: 0,
    directivesStaged: 0,
    directivesExecuted: 0,
    directivesFailed: 0,
    chatAutoReplies: 0,
    memoryRefreshes: 0,
    notificationsFlushed: 0,
    inboundMessages: 0,
    openClawPrompts: 0,
    total: 0,
  };

  for (const envelope of input.writeRecords) {
    const payload = isRecord(envelope.payload) ? envelope.payload : null;
    if (!payload) continue;
    const type = str(payload.type);
    if (!type) continue;
    const at = eventAt(envelope, payload);
    const atMs = at ? Date.parse(at) : Number.NaN;
    if (!Number.isFinite(atMs) || atMs < sinceMs || atMs > nowMs) continue;
    const bucket = ensureBucket(atMs);
    let counted = false;
    if (type === PUBLISH_RESULT) {
      if (bool(payload.ok) === true) {
        bucket.publishOk += 1;
        totals.publishOk += 1;
      } else {
        bucket.publishFailed += 1;
        totals.publishFailed += 1;
      }
      counted = true;
    } else if (DIRECTIVE_STAGED_TYPES.has(type)) {
      bucket.directivesStaged += 1;
      totals.directivesStaged += 1;
      counted = true;
    } else if (type === DIRECTIVE_EXECUTED) {
      bucket.directivesExecuted += 1;
      totals.directivesExecuted += 1;
      counted = true;
    } else if (type === DIRECTIVE_FAILED) {
      bucket.directivesFailed += 1;
      totals.directivesFailed += 1;
      counted = true;
    } else if (type === CHAT_AUTO_REPLY) {
      bucket.chatAutoReplies += 1;
      totals.chatAutoReplies += 1;
      counted = true;
    } else if (type === MEMORY_REFRESH) {
      bucket.memoryRefreshes += 1;
      totals.memoryRefreshes += 1;
      counted = true;
    } else if (type === NOTIFICATIONS_FLUSHED) {
      bucket.notificationsFlushed += 1;
      totals.notificationsFlushed += 1;
      counted = true;
    } else if (type === "openclaw_prompt_result") {
      bucket.openClawPrompts += 1;
      totals.openClawPrompts += 1;
      counted = true;
    }
    if (counted) {
      bucket.total += 1;
      totals.total += 1;
    }
  }

  for (const row of input.inboxRecords) {
    const atRaw = iso(row.at) ?? iso(row.receivedAt);
    const atMs = atRaw ? Date.parse(atRaw) : Number.NaN;
    if (!Number.isFinite(atMs) || atMs < sinceMs || atMs > nowMs) continue;
    const bucket = ensureBucket(atMs);
    bucket.inboundMessages += 1;
    bucket.total += 1;
    totals.inboundMessages += 1;
    totals.total += 1;
  }

  const rows = [...timeline.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => value);
  const hours = Math.max(1, safeRangeMs / 3_600_000);

  return {
    range: {
      label: formatRangeLabelFromMs(safeRangeMs),
      maxAgeMs: safeRangeMs,
      from: new Date(sinceMs).toISOString(),
      to: new Date(nowMs).toISOString(),
      bucketMs: safeBucketMs,
    },
    totals: {
      ...totals,
      perHour: Number.parseFloat((totals.total / hours).toFixed(2)),
    },
    buckets: rows,
  };
};

export const resolveStateDir = (): string => {
  const configured = trimEnv("MG_AGENT_STATE_DIR");
  if (configured) return path.resolve(configured);
  const agentHomeDir = trimEnv("MG_AGENT_HOME_DIR")
    ? path.resolve(trimEnv("MG_AGENT_HOME_DIR") ?? "kthx-agents")
    : path.resolve(process.cwd(), "kthx-agents");
  return path.resolve(agentHomeDir, "state");
};

let stateDb: StateSqliteStore | null = null;

export const getStateDb = (): StateSqliteStore => {
  if (stateDb) return stateDb;
  const db = createStateSqliteStoreFromEnv(resolveStateDir());
  db.init();
  stateDb = db;
  return db;
};

export const readJsonRecord = async (p: string): Promise<Record<string, unknown> | null> => {
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const readTailLines = async (filePath: string, maxBytes: number, maxLines: number): Promise<string[]> => {
  try {
    const stat = await fs.stat(filePath);
    if (!Number.isFinite(stat.size) || stat.size <= 0) return [];
    const total = Math.max(0, Math.floor(stat.size));
    const start = Math.max(0, total - Math.max(1, Math.floor(maxBytes)));
    const length = total - start;
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      const lines = buffer.toString("utf8").split(/\r?\n/u);
      return (start > 0 ? lines.slice(1) : lines).map((l) => l.trim()).filter((l) => l.length > 0).slice(-Math.max(1, Math.floor(maxLines)));
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
};

export const parseJsonLines = (lines: string[]): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) out.push(parsed);
    } catch { /* skip */ }
  }
  return out;
};

export const eventAt = (envelope: Record<string, unknown>, payload: Record<string, unknown> | null): string | null =>
  iso(envelope.receivedAt) ?? iso(payload?.at) ?? null;

export type PipelineEventRow = {
  at: string;
  type: string;
  payload: Record<string, unknown> | null;
  source: "writes" | "state_events";
};

export type PipelineStageStatus = "ok" | "warn" | "bad" | "idle";

const stageBadgeForPipeline = (
  status: PipelineStageStatus,
): { label: string; color: string } => {
  if (status === "ok") return { label: "OK", color: "ok" };
  if (status === "warn") return { label: "WARN", color: "warn" };
  if (status === "bad") return { label: "BAD", color: "bad" };
  return { label: "IDLE", color: "neutral" };
};

const parsePipelineEventsFromWrites = (
  rows: Record<string, unknown>[],
): PipelineEventRow[] => {
  const events: PipelineEventRow[] = [];
  for (const envelope of rows) {
    const payload = isRecord(envelope.payload) ? envelope.payload : null;
    if (!payload) continue;
    const type = str(payload.type);
    if (!type) continue;
    const at = eventAt(envelope, payload);
    if (!at) continue;
    events.push({ at, type, payload, source: "writes" });
  }
  return events;
};

const parsePipelineEventsFromStateEvents = (
  rows: Record<string, unknown>[],
): PipelineEventRow[] => {
  const events: PipelineEventRow[] = [];
  for (const row of rows) {
    const eventType = str(row.eventType);
    const rowPayload = isRecord(row.payload) ? row.payload : null;
    const nestedPayload =
      rowPayload && isRecord(rowPayload.payload) ? rowPayload.payload : null;
    const payload = nestedPayload ?? rowPayload ?? null;
    const type = eventType ?? str(payload?.type);
    const at = iso(row.at) ?? iso(rowPayload?.receivedAt) ?? iso(payload?.at);
    if (!type || !at) continue;
    events.push({ at, type, payload, source: "state_events" });
  }
  return events;
};

const parseNotificationItems = (
  rows: Record<string, unknown>[],
): Array<{ at: string; payload: Record<string, unknown> | null }> => {
  const out: Array<{ at: string; payload: Record<string, unknown> | null }> = [];
  for (const envelope of rows) {
    const payload = isRecord(envelope.payload) ? envelope.payload : null;
    const type = str(payload?.type);
    const at = iso(envelope.receivedAt) ?? iso(payload?.at);
    if (!at) continue;
    if (type && type !== "notification_created") continue;
    out.push({ at, payload });
  }
  return out;
};

const filterRowsByRange = <T extends { at: string }>(
  rows: T[],
  sinceMs: number,
  nowMs: number,
): T[] =>
  rows.filter((row) => {
    const atMs = Date.parse(row.at);
    return Number.isFinite(atMs) && atMs >= sinceMs && atMs <= nowMs;
  });

export const buildPipelineDiagnostics = (input: {
  writeRecords: Record<string, unknown>[];
  stateEvents: Record<string, unknown>[];
  inboxRecords: Record<string, unknown>[];
  notificationRecords: Record<string, unknown>[];
  lifecycleRows: Record<string, unknown>[];
  rangeMs: number;
}): Record<string, unknown> => {
  const nowMs = Date.now();
  const safeRangeMs = Math.max(60_000, Math.min(366 * 86_400_000, input.rangeMs));
  const sinceMs = nowMs - safeRangeMs;
  const writesEvents = parsePipelineEventsFromWrites(input.writeRecords);
  const stateEvents = parsePipelineEventsFromStateEvents(input.stateEvents);
  const usingWrites = writesEvents.length > 0;
  const pipelineEventsAll = usingWrites ? writesEvents : stateEvents;
  const pipelineEvents = filterRowsByRange(pipelineEventsAll, sinceMs, nowMs);
  const notificationRows = filterRowsByRange(
    parseNotificationItems(input.notificationRecords),
    sinceMs,
    nowMs,
  );
  const inboxRows = filterRowsByRange(
    input.inboxRecords
      .map((row) => ({
        at: iso(row.at) ?? iso(row.receivedAt) ?? "",
      }))
      .filter((row): row is { at: string } => row.at.length > 0),
    sinceMs,
    nowMs,
  );

  const eventsByType = new Map<string, PipelineEventRow[]>();
  for (const event of pipelineEvents) {
    const bucket = eventsByType.get(event.type) ?? [];
    bucket.push(event);
    eventsByType.set(event.type, bucket);
  }
  for (const bucket of eventsByType.values()) {
    bucket.sort((a, b) =>
      a.at < b.at ? 1 : a.at > b.at ? -1 : 0,
    );
  }

  const latestEvent = (types: readonly string[]): PipelineEventRow | null => {
    let best: PipelineEventRow | null = null;
    for (const type of types) {
      const candidate = eventsByType.get(type)?.[0] ?? null;
      if (!candidate) continue;
      if (!best || candidate.at > best.at) best = candidate;
    }
    return best;
  };
  const countEvents = (types: readonly string[]): number =>
    types.reduce((sum, type) => sum + (eventsByType.get(type)?.length ?? 0), 0);

  const stageRows = {
    notifications: notificationRows.length,
    notificationsFlushed: countEvents([NOTIFICATIONS_FLUSHED]),
    contextSeed: countEvents([ENGAGEMENT_CONTEXT_SEED]),
    contextPrimeCompleted: countEvents([ENGAGEMENT_CONTEXT_PRIME_COMPLETED]),
    contextPrimeEmpty: countEvents([ENGAGEMENT_CONTEXT_PRIME_EMPTY]),
    targetResolved: countEvents([ENGAGEMENT_TARGET_RESOLVED]),
    targetFailed: countEvents([ENGAGEMENT_TARGET_RESOLUTION_FAILED]),
    queueNotReadyRequeued: countEvents([QUEUE_NOT_READY_REQUEUED]),
    inboxCommandRequeued: countEvents([INBOX_COMMAND_REQUEUED]),
    directivesExecuted: countEvents([DIRECTIVE_EXECUTED]),
    directivesFailed: countEvents([DIRECTIVE_FAILED]),
  };

  const notificationsLatestAt = notificationRows[notificationRows.length - 1]?.at ?? null;
  const flushLatest = latestEvent([NOTIFICATIONS_FLUSHED]);
  const seedLatest = latestEvent([ENGAGEMENT_CONTEXT_SEED]);
  const primeLatest = latestEvent([
    ENGAGEMENT_CONTEXT_PRIME_COMPLETED,
    ENGAGEMENT_CONTEXT_PRIME_EMPTY,
  ]);
  const targetLatest = latestEvent([
    ENGAGEMENT_TARGET_RESOLVED,
    ENGAGEMENT_TARGET_RESOLUTION_FAILED,
  ]);
  const requeueLatest = latestEvent([
    QUEUE_NOT_READY_REQUEUED,
    INBOX_COMMAND_REQUEUED,
  ]);
  const directivesLatest = latestEvent([DIRECTIVE_EXECUTED, DIRECTIVE_FAILED]);

  const lifecycleRows = input.lifecycleRows
    .map((row) => {
      const updatedAt = iso(row.updatedAt) ?? iso(row.createdAt) ?? null;
      const state = str(row.state);
      if (!updatedAt || !state) return null;
      return {
        updatedAt,
        state,
        attempts: intFromUnknown(row.attempts) ?? 0,
        directiveId: str(row.directiveId),
        action: str(row.action),
        lastError: str(row.lastError),
      };
    })
    .filter(
      (row): row is {
        updatedAt: string;
        state: string;
        attempts: number;
        directiveId: string | null;
        action: string | null;
        lastError: string | null;
      } => row !== null,
    )
    .filter((row) => {
      const atMs = Date.parse(row.updatedAt);
      return Number.isFinite(atMs) && atMs >= sinceMs && atMs <= nowMs;
    });
  const lifecycleCounts = new Map<string, number>();
  for (const row of lifecycleRows) {
    lifecycleCounts.set(row.state, (lifecycleCounts.get(row.state) ?? 0) + 1);
  }
  const lifecycleLatest =
    lifecycleRows.length > 0
      ? lifecycleRows.slice().sort((a, b) =>
          a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
        )[0] ?? null
      : null;
  const lifecycleStuck = lifecycleRows.filter((row) => {
    if (!["queued", "context_ready", "llm_running", "action_running", "requeue"].includes(row.state)) {
      return false;
    }
    const atMs = Date.parse(row.updatedAt);
    return Number.isFinite(atMs) && nowMs - atMs > 20 * 60_000;
  }).length;

  const staleMinutes = (at: string | null): number | null => {
    if (!at) return null;
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) return null;
    return Math.max(0, Math.round((nowMs - atMs) / 60_000));
  };

  const stageStatus: Record<
    string,
    {
      status: PipelineStageStatus;
      badge: { label: string; color: string };
      count: number;
      latestAt: string | null;
      staleMinutes: number | null;
      detail: string;
    }
  > = {};

  const setStage = (
    key: string,
    inputStage: {
      status: PipelineStageStatus;
      count: number;
      latestAt: string | null;
      detail: string;
    },
  ): void => {
    stageStatus[key] = {
      status: inputStage.status,
      badge: stageBadgeForPipeline(inputStage.status),
      count: inputStage.count,
      latestAt: inputStage.latestAt,
      staleMinutes: staleMinutes(inputStage.latestAt),
      detail: inputStage.detail,
    };
  };

  const notificationsStatus: PipelineStageStatus =
    notificationRows.length > 0
      ? "ok"
      : inboxRows.length > 0
        ? "warn"
        : "idle";
  setStage("notifications", {
    status: notificationsStatus,
    count: notificationRows.length,
    latestAt: notificationsLatestAt,
    detail:
      notificationRows.length > 0
        ? "Notification memory envelopes observed."
        : inboxRows.length > 0
          ? "Inbox active but no notification memory entries in range."
          : "No notification activity in range.",
  });

  const flushCount = stageRows.notificationsFlushed;
  const flushStatus: PipelineStageStatus =
    flushCount > 0
      ? "ok"
      : notificationRows.length > 0
        ? "bad"
        : "idle";
  setStage("flush", {
    status: flushStatus,
    count: flushCount,
    latestAt: flushLatest?.at ?? null,
    detail:
      flushCount > 0
        ? "Notification buffer flushes recorded."
        : notificationRows.length > 0
          ? "Notifications detected but no buffer flush event."
          : "No flushes in range.",
  });

  const primeCompleted = stageRows.contextPrimeCompleted;
  const primeEmpty = stageRows.contextPrimeEmpty;
  const seedCount = stageRows.contextSeed;
  const contextStatus: PipelineStageStatus =
    primeCompleted > 0
      ? "ok"
      : seedCount > 0 || primeEmpty > 0
        ? "warn"
        : flushCount > 0
          ? "warn"
          : "idle";
  setStage("context", {
    status: contextStatus,
    count: seedCount + primeCompleted + primeEmpty,
    latestAt: primeLatest?.at ?? seedLatest?.at ?? null,
    detail:
      primeCompleted > 0
        ? `Prime completed=${primeCompleted}, empty=${primeEmpty}.`
        : seedCount > 0 || primeEmpty > 0
          ? `Seed=${seedCount}, prime empty=${primeEmpty}.`
          : "No context seed/prime events in range.",
  });

  const resolvedCount = stageRows.targetResolved;
  const failedCount = stageRows.targetFailed;
  const targetStatus: PipelineStageStatus =
    resolvedCount > 0 && failedCount === 0
      ? "ok"
      : resolvedCount > 0 && failedCount > 0
        ? "warn"
        : failedCount > 0
          ? "bad"
          : contextStatus === "ok" || contextStatus === "warn"
            ? "warn"
            : "idle";
  setStage("target", {
    status: targetStatus,
    count: resolvedCount + failedCount,
    latestAt: targetLatest?.at ?? null,
    detail:
      resolvedCount > 0 || failedCount > 0
        ? `resolved=${resolvedCount}, failed=${failedCount}.`
        : "No engagement target events in range.",
  });

  const requeueCount =
    stageRows.queueNotReadyRequeued + stageRows.inboxCommandRequeued;
  const queueStatus: PipelineStageStatus =
    requeueCount > 0
      ? stageRows.directivesExecuted > 0
        ? "warn"
        : "bad"
      : stageRows.directivesExecuted > 0
        ? "ok"
        : stageRows.directivesFailed > 0
          ? "bad"
          : "idle";
  setStage("queue", {
    status: queueStatus,
    count: requeueCount + stageRows.directivesExecuted + stageRows.directivesFailed,
    latestAt: directivesLatest?.at ?? requeueLatest?.at ?? null,
    detail:
      `executed=${stageRows.directivesExecuted}, failed=${stageRows.directivesFailed}, requeued=${requeueCount}.`,
  });

  const lifecycleFailed = lifecycleCounts.get("failed") ?? 0;
  const lifecycleAcked = lifecycleCounts.get("acked") ?? 0;
  const lifecycleStatus: PipelineStageStatus =
    lifecycleStuck > 0
      ? "bad"
      : lifecycleFailed > 0
        ? lifecycleAcked > 0
          ? "warn"
          : "bad"
        : lifecycleRows.length > 0
          ? "ok"
          : "idle";
  setStage("lifecycle", {
    status: lifecycleStatus,
    count: lifecycleRows.length,
    latestAt: lifecycleLatest?.updatedAt ?? null,
    detail:
      `acked=${lifecycleAcked}, failed=${lifecycleFailed}, stuck=${lifecycleStuck}.`,
  });

  const recentEvents = pipelineEvents
    .slice()
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, 40)
    .map((event) => ({
      at: event.at,
      type: event.type,
      source: event.source,
      detail:
        str(event.payload?.error) ??
        str(event.payload?.reason) ??
        str(event.payload?.action) ??
        str(event.payload?.directiveId) ??
        null,
    }));

  const lifecycleRecent = lifecycleRows
    .slice()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, 40);

  return {
    range: {
      label: formatRangeLabelFromMs(safeRangeMs),
      maxAgeMs: safeRangeMs,
      from: new Date(sinceMs).toISOString(),
      to: new Date(nowMs).toISOString(),
    },
    sources: {
      pipelineEventsSource: usingWrites ? "writes.jsonl" : "state.sqlite/state_events",
      writeRecords: input.writeRecords.length,
      stateEvents: input.stateEvents.length,
      inboxRecords: input.inboxRecords.length,
      notificationRecords: input.notificationRecords.length,
      lifecycleRows: input.lifecycleRows.length,
      lifecycleRowsInRange: lifecycleRows.length,
    },
    totals: {
      notifications: notificationRows.length,
      flushes: stageRows.notificationsFlushed,
      contextSeed: stageRows.contextSeed,
      contextPrimeCompleted: stageRows.contextPrimeCompleted,
      contextPrimeEmpty: stageRows.contextPrimeEmpty,
      targetResolved: stageRows.targetResolved,
      targetFailed: stageRows.targetFailed,
      directivesExecuted: stageRows.directivesExecuted,
      directivesFailed: stageRows.directivesFailed,
      queueRequeued: requeueCount,
      lifecycleStuck,
      inboxMessages: inboxRows.length,
      pipelineEvents: pipelineEvents.length,
    },
    stages: stageStatus,
    lifecycle: {
      counts: Object.fromEntries(
        [...lifecycleCounts.entries()].sort((a, b) => b[1] - a[1]),
      ),
      stuck: lifecycleStuck,
      latest: lifecycleLatest,
    },
    recent: {
      events: recentEvents,
      lifecycle: lifecycleRecent,
      notifications: notificationRows
        .slice(-40)
        .reverse()
        .map((row) => ({
          at: row.at,
          entityType: str(row.payload?.entityType),
          entityId: intFromUnknown(row.payload?.entityId),
          postId: intFromUnknown(row.payload?.postId),
          commentId: intFromUnknown(row.payload?.commentId),
          actor:
            str(
              isRecord(row.payload?.actor)
                ? row.payload.actor.handle
                : row.payload?.actor,
            ) ?? null,
        })),
    },
  };
};
