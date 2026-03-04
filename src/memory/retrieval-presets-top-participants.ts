import type {
  RetrievalPresetSummary,
  RetrievalPresetTopParticipantMetric,
} from "./retrieval-presets.js";

type TopParticipantsSourceDoc = {
  atMs: number;
  doc: {
    sourceType: string | null;
    postId: number | null;
    commentId: number | null;
    receivedAt: string;
  };
  participantTokens: string[];
  primaryParticipant: string | null;
};

type TopParticipantsRange = {
  label: string;
  maxAgeMs: number;
};

const PARTICIPANT_ENGAGEMENT_WEIGHTS: Record<string, number> = {
  post_comment: 5,
  post_repost: 4,
  post_like: 2,
  post_view: 1,
  notification_created: 1,
};

const participantDisplay = (value: string): string =>
  value.startsWith("id:") ? value.slice(3) : value;

const isInRange = (atMs: number, nowMs: number, maxAgeMs: number): boolean => {
  if (atMs > nowMs) return false;
  return nowMs - atMs <= maxAgeMs;
};

export const buildTopParticipantsPreset = (input: {
  docs: TopParticipantsSourceDoc[];
  nowMs: number;
  range: TopParticipantsRange;
  scopePostId: number | null;
  scopeCommentId: number | null;
  maxTopParticipants: number;
  topParticipantMetric: RetrievalPresetTopParticipantMetric;
}): RetrievalPresetSummary["topParticipants"] => {
  const {
    docs,
    nowMs,
    range,
    scopePostId,
    scopeCommentId,
    maxTopParticipants,
    topParticipantMetric,
  } = input;

  const aggregate = new Map<
    string,
    {
      participant: string;
      score: number;
      comments: number;
      likes: number;
      reposts: number;
      views: number;
      notifications: number;
      presence: number;
      lastAt: string;
    }
  >();

  for (const entry of docs) {
    if (!isInRange(entry.atMs, nowMs, range.maxAgeMs)) continue;
    if (typeof scopePostId === "number" && entry.doc.postId !== scopePostId) continue;
    if (
      typeof scopeCommentId === "number" &&
      entry.doc.commentId !== scopeCommentId
    ) {
      continue;
    }

    const seenInDoc = new Set<string>();
    for (const participant of entry.participantTokens) {
      if (seenInDoc.has(participant)) continue;
      seenInDoc.add(participant);
      const existing = aggregate.get(participant) ?? {
        participant,
        score: 0,
        comments: 0,
        likes: 0,
        reposts: 0,
        views: 0,
        notifications: 0,
        presence: 0,
        lastAt: entry.doc.receivedAt,
      };
      existing.presence += 1;
      if (Date.parse(entry.doc.receivedAt) > Date.parse(existing.lastAt)) {
        existing.lastAt = entry.doc.receivedAt;
      }
      aggregate.set(participant, existing);
    }

    const engager = entry.primaryParticipant;
    if (!engager) continue;
    const existing = aggregate.get(engager) ?? {
      participant: engager,
      score: 0,
      comments: 0,
      likes: 0,
      reposts: 0,
      views: 0,
      notifications: 0,
      presence: 0,
      lastAt: entry.doc.receivedAt,
    };
    const sourceType = entry.doc.sourceType ?? "";
    const weight = PARTICIPANT_ENGAGEMENT_WEIGHTS[sourceType] ?? 0;
    existing.score += weight;
    if (sourceType === "post_comment") existing.comments += 1;
    else if (sourceType === "post_like") existing.likes += 1;
    else if (sourceType === "post_repost") existing.reposts += 1;
    else if (sourceType === "post_view") existing.views += 1;
    else if (sourceType === "notification_created") existing.notifications += 1;
    if (Date.parse(entry.doc.receivedAt) > Date.parse(existing.lastAt)) {
      existing.lastAt = entry.doc.receivedAt;
    }
    aggregate.set(engager, existing);
  }

  const metricSelector = (
    entry: {
      score: number;
      comments: number;
      likes: number;
      reposts: number;
      views: number;
      notifications: number;
      presence: number;
    },
  ): number => {
    if (topParticipantMetric === "comments") return entry.comments;
    if (topParticipantMetric === "likes") return entry.likes;
    if (topParticipantMetric === "reposts") return entry.reposts;
    if (topParticipantMetric === "views") return entry.views;
    if (topParticipantMetric === "notifications") return entry.notifications;
    if (topParticipantMetric === "presence") return entry.presence;
    return entry.score + entry.presence * 0.35 + entry.notifications * 0.4;
  };

  const participants = [...aggregate.values()]
    .sort((a, b) => {
      const bScore = metricSelector(b);
      const aScore = metricSelector(a);
      if (bScore !== aScore) return bScore - aScore;
      return Date.parse(b.lastAt) - Date.parse(a.lastAt);
    })
    .slice(0, maxTopParticipants)
    .map((entry) => ({
      participant: entry.participant,
      display: participantDisplay(entry.participant),
      score: Number.parseFloat(metricSelector(entry).toFixed(2)),
      comments: entry.comments,
      likes: entry.likes,
      reposts: entry.reposts,
      views: entry.views,
      notifications: entry.notifications,
      presence: entry.presence,
      lastAt: entry.lastAt,
    }));

  return {
    rangeLabel: range.label,
    rangeMaxAgeMs: range.maxAgeMs,
    metric: topParticipantMetric,
    participants,
  };
};
