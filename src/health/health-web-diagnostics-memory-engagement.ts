import {
  buildRetrievalPresets,
  type RetrievalPresetTopParticipantMetric,
} from "../memory/retrieval-presets.js";

import {
  formatRangeLabelFromMs,
  type KeywordIndexSnapshot,
  normalizeParticipantToken,
  type RetrievalIntent,
} from "./health-web-shared.js";

export const buildMemoryEngagementDiagnostics = (input: {
  index: KeywordIndexSnapshot;
  rangeMs: number;
  metric: RetrievalPresetTopParticipantMetric;
  limit: number;
  postId: number | null;
  commentId: number | null;
  intent: RetrievalIntent;
}): Record<string, unknown> => {
  const nowMs = Date.now();
  const safeRangeMs = Math.max(60_000, Math.min(366 * 86_400_000, input.rangeMs));
  const rangeLabel = formatRangeLabelFromMs(safeRangeMs);
  const sinceMs = nowMs - safeRangeMs;
  const scopePostId = input.postId;
  const scopeCommentId = input.commentId;
  const docs = Object.values(input.index.docs)
    .map((doc) => ({
      doc,
      atMs: Date.parse(doc.receivedAt),
    }))
    .filter((entry) => Number.isFinite(entry.atMs) && entry.atMs >= sinceMs && entry.atMs <= nowMs)
    .filter((entry) => {
      if (scopePostId !== null && entry.doc.postId !== scopePostId) return false;
      if (scopeCommentId !== null && entry.doc.commentId !== scopeCommentId) return false;
      return true;
    });

  const metricHint =
    input.metric === "presence"
      ? "in memory most"
      : `by ${input.metric}`;
  const presetQuery = `top engagers ${metricHint} last ${Math.max(
    1,
    Math.round(safeRangeMs / 3_600_000),
  )}h`;
  const presetSummary = buildRetrievalPresets({
    docs: Object.values(input.index.docs),
    query: presetQuery,
    intent: input.intent,
    postId: scopePostId,
    commentId: scopeCommentId,
    defaultRangeMs: safeRangeMs,
    maxTopParticipants: Math.max(1, Math.min(25, input.limit)),
  });

  const totals = {
    comments: 0,
    likes: 0,
    reposts: 0,
    views: 0,
    notifications: 0,
    presence: 0,
  };
  const presenceByParticipant = new Map<string, number>();
  const timelineByDay = new Map<
    string,
    {
      day: string;
      comments: number;
      likes: number;
      reposts: number;
      views: number;
      notifications: number;
      presence: number;
    }
  >();

  for (const entry of docs) {
    const sourceType = entry.doc.sourceType ?? "";
    const day = new Date(entry.atMs).toISOString().slice(0, 10);
    const timeline = timelineByDay.get(day) ?? {
      day,
      comments: 0,
      likes: 0,
      reposts: 0,
      views: 0,
      notifications: 0,
      presence: 0,
    };
    if (sourceType === "post_comment") {
      totals.comments += 1;
      timeline.comments += 1;
    } else if (sourceType === "post_like") {
      totals.likes += 1;
      timeline.likes += 1;
    } else if (sourceType === "post_repost") {
      totals.reposts += 1;
      timeline.reposts += 1;
    } else if (sourceType === "post_view") {
      totals.views += 1;
      timeline.views += 1;
    } else if (sourceType === "notification_created") {
      totals.notifications += 1;
      timeline.notifications += 1;
    }

    const participantSet = new Set<string>();
    if (typeof entry.doc.actor === "string") {
      const normalizedActor = normalizeParticipantToken(entry.doc.actor);
      if (normalizedActor) participantSet.add(normalizedActor);
    }
    for (const rawParticipant of entry.doc.participants) {
      const normalized = normalizeParticipantToken(rawParticipant);
      if (normalized) participantSet.add(normalized);
    }
    timeline.presence += participantSet.size;
    totals.presence += participantSet.size;
    for (const participant of participantSet) {
      presenceByParticipant.set(
        participant,
        (presenceByParticipant.get(participant) ?? 0) + 1,
      );
    }
    timelineByDay.set(day, timeline);
  }

  const topPresenceParticipants = [...presenceByParticipant.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, Math.min(20, input.limit)))
    .map(([participant, count]) => ({
      participant,
      display: participant.startsWith("id:") ? participant.slice(3) : participant,
      presence: count,
    }));

  const timeline = [...timelineByDay.values()].sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : 0,
  );
  const totalEngagement =
    totals.comments +
    totals.likes +
    totals.reposts +
    totals.views +
    totals.notifications;

  return {
    range: {
      label: rangeLabel,
      maxAgeMs: safeRangeMs,
      from: new Date(sinceMs).toISOString(),
      to: new Date(nowMs).toISOString(),
    },
    scope: {
      postId: scopePostId,
      commentId: scopeCommentId,
    },
    metric: input.metric,
    totals: {
      ...totals,
      totalEngagement,
    },
    docsConsidered: docs.length,
    topParticipants: presetSummary.topParticipants,
    topPresenceParticipants,
    timeline,
    presetLines: presetSummary.lines,
  };
};
