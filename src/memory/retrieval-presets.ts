import type { RetrievalIntent } from "~/types/memory.js";

export type RetrievalPresetDoc = {
  receivedAt: string;
  sourceType: string | null;
  postId: number | null;
  commentId: number | null;
  actor: string | null;
  participants?: string[];
  summary: string;
};

export type RetrievalPresetEvent = {
  receivedAt: string;
  postId: number | null;
  commentId: number | null;
  actor: string | null;
  summary: string;
};

export type RetrievalPresetMostRecentPost = {
  receivedAt: string;
  postId: number;
  actor: string | null;
  summary: string;
};

export type RetrievalPresetMostEngagedPost = {
  postId: number;
  score: number;
  comments: number;
  likes: number;
  reposts: number;
  views: number;
  lastAt: string;
  summary: string | null;
};

export type RetrievalPresetMostEngagedComment = {
  commentId: number;
  postId: number | null;
  score: number;
  comments: number;
  likes: number;
  reposts: number;
  views: number;
  notifications: number;
  lastAt: string;
  summary: string | null;
};

export type RetrievalPresetTopParticipantMetric =
  | "combined"
  | "comments"
  | "likes"
  | "reposts"
  | "views"
  | "notifications"
  | "presence";

export type RetrievalPresetTopParticipant = {
  participant: string;
  display: string;
  score: number;
  comments: number;
  likes: number;
  reposts: number;
  views: number;
  notifications: number;
  presence: number;
  lastAt: string;
};

export type RetrievalPresetSummary = {
  requested: {
    mostRecentPost: boolean;
    mostEngaged: boolean;
    mostEngagedComments: boolean;
    lastComments: boolean;
    lastLikes: boolean;
    lastViews: boolean;
    topParticipants: boolean;
  };
  range: {
    label: string;
    maxAgeMs: number;
  } | null;
  mostRecentPost: RetrievalPresetMostRecentPost | null;
  mostEngaged: {
    rangeLabel: string;
    rangeMaxAgeMs: number;
    posts: RetrievalPresetMostEngagedPost[];
  } | null;
  mostEngagedComments: {
    rangeLabel: string;
    rangeMaxAgeMs: number;
    comments: RetrievalPresetMostEngagedComment[];
  } | null;
  lastComments: RetrievalPresetEvent[];
  lastLikes: RetrievalPresetEvent[];
  lastViews: RetrievalPresetEvent[];
  topParticipants: {
    rangeLabel: string;
    rangeMaxAgeMs: number;
    metric: RetrievalPresetTopParticipantMetric;
    participants: RetrievalPresetTopParticipant[];
  } | null;
  lines: string[];
};

type RetrievalPresetInput = {
  docs: RetrievalPresetDoc[];
  query: string;
  intent: RetrievalIntent;
  postId: number | null;
  commentId: number | null;
  defaultRangeMs?: number;
  maxMostEngagedPosts?: number;
  maxMostEngagedComments?: number;
  maxEventsPerType?: number;
  maxTopParticipants?: number;
  nowMs?: number;
};

type TimeRange = {
  label: string;
  maxAgeMs: number;
};

type NormalizedDoc = {
  atMs: number;
  doc: RetrievalPresetDoc;
  participantTokens: string[];
  primaryParticipant: string | null;
};

const ENGAGEMENT_WEIGHTS: Record<string, number> = {
  post_comment: 5,
  post_repost: 4,
  post_like: 2,
  post_view: 1,
};

const COMMENT_ENGAGEMENT_WEIGHTS: Record<string, number> = {
  post_comment: 4,
  post_like: 3,
  post_repost: 2,
  post_view: 1,
  notification_created: 1,
};

const PARTICIPANT_ENGAGEMENT_WEIGHTS: Record<string, number> = {
  post_comment: 5,
  post_repost: 4,
  post_like: 2,
  post_view: 1,
  notification_created: 1,
};

const DEFAULT_RANGE_MS_BY_INTENT: Record<RetrievalIntent, number> = {
  chat: 7 * 24 * 60 * 60 * 1000,
  directive: 4 * 24 * 60 * 60 * 1000,
  engagement: 3 * 24 * 60 * 60 * 1000,
};

const toSummaryPreview = (value: string, max = 120): string => {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (!compact.length) return "(no summary)";
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
};

const formatRangeLabel = (maxAgeMs: number): string => {
  const totalHours = Math.max(1, Math.round(maxAgeMs / 3_600_000));
  if (totalHours % (24 * 30) === 0) return `${totalHours / (24 * 30)}mo`;
  if (totalHours % (24 * 7) === 0) return `${totalHours / (24 * 7)}w`;
  if (totalHours % 24 === 0) return `${totalHours / 24}d`;
  return `${totalHours}h`;
};

const parseRangeFromQuery = (
  query: string,
  fallbackMs: number,
): TimeRange => {
  const lowered = query.toLowerCase();
  const unitPatterns: Array<{ regex: RegExp; multiplier: number; unit: string }> = [
    {
      regex: /\b(?:last|past|within|in)\s+(\d{1,3})\s*(?:m|min|mins|minute|minutes)\b/iu,
      multiplier: 60 * 1000,
      unit: "m",
    },
    {
      regex: /\b(?:last|past|within|in)\s+(\d{1,3})\s*(?:h|hr|hrs|hour|hours)\b/iu,
      multiplier: 60 * 60 * 1000,
      unit: "h",
    },
    {
      regex: /\b(?:last|past|within|in)\s+(\d{1,3})\s*(?:d|day|days)\b/iu,
      multiplier: 24 * 60 * 60 * 1000,
      unit: "d",
    },
    {
      regex: /\b(?:last|past|within|in)\s+(\d{1,3})\s*(?:w|wk|wks|week|weeks)\b/iu,
      multiplier: 7 * 24 * 60 * 60 * 1000,
      unit: "w",
    },
    {
      regex: /\b(?:last|past|within|in)\s+(\d{1,3})\s*(?:mo|month|months)\b/iu,
      multiplier: 30 * 24 * 60 * 60 * 1000,
      unit: "mo",
    },
    {
      regex: /\b(\d{1,3})\s*(?:m|min|mins|minute|minutes)\b/iu,
      multiplier: 60 * 1000,
      unit: "m",
    },
    {
      regex: /\b(\d{1,3})\s*(?:h|hr|hrs|hour|hours)\b/iu,
      multiplier: 60 * 60 * 1000,
      unit: "h",
    },
    {
      regex: /\b(\d{1,3})\s*(?:d|day|days)\b/iu,
      multiplier: 24 * 60 * 60 * 1000,
      unit: "d",
    },
  ];

  for (const pattern of unitPatterns) {
    const match = pattern.regex.exec(lowered);
    const countRaw = match?.[1] ?? "";
    const count = Number.parseInt(countRaw, 10);
    if (!Number.isFinite(count) || count <= 0) continue;
    const maxAgeMs = count * pattern.multiplier;
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) continue;
    return {
      label: `${count}${pattern.unit}`,
      maxAgeMs,
    };
  }

  if (/\btoday\b/iu.test(lowered)) {
    return { label: "24h", maxAgeMs: 24 * 60 * 60 * 1000 };
  }
  if (/\b(?:this|last)\s+week\b/iu.test(lowered) || /\b7d\b/iu.test(lowered)) {
    return { label: "7d", maxAgeMs: 7 * 24 * 60 * 60 * 1000 };
  }
  if (
    /\b(?:this|last)\s+month\b/iu.test(lowered) ||
    /\b30d\b/iu.test(lowered)
  ) {
    return { label: "30d", maxAgeMs: 30 * 24 * 60 * 60 * 1000 };
  }

  const fallback = Math.max(60_000, Math.floor(fallbackMs));
  return {
    label: formatRangeLabel(fallback),
    maxAgeMs: fallback,
  };
};

const normalizeParticipantToken = (value: string | null): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  if (/^id:[a-zA-Z0-9_.:-]{6,120}$/u.test(trimmed)) return trimmed;
  const handle = trimmed.replace(/^@+/u, "").toLowerCase();
  if (!/^[a-z0-9_.-]{2,64}$/u.test(handle)) return null;
  return `@${handle}`;
};

const participantDisplay = (value: string): string =>
  value.startsWith("id:") ? value.slice(3) : value;

const parseTopParticipantMetric = (
  query: string,
): RetrievalPresetTopParticipantMetric => {
  const lowered = query.toLowerCase();
  if (/\b(memory\s+most|most\s+in\s+memory|memory\s+presence)\b/iu.test(lowered)) {
    return "presence";
  }
  const hasComments = /\bcomments?\b/iu.test(lowered);
  const hasLikes = /\blikes?\b/iu.test(lowered);
  const hasReposts = /\b(reposts?|quotes?)\b/iu.test(lowered);
  const hasViews = /\bviews?\b/iu.test(lowered);
  const hasNotifications = /\bnotifications?\b/iu.test(lowered);
  const metricsRequested = [
    hasComments,
    hasLikes,
    hasReposts,
    hasViews,
    hasNotifications,
  ].filter(Boolean).length;
  if (metricsRequested > 1) return "combined";
  if (hasComments) return "comments";
  if (hasLikes) return "likes";
  if (hasReposts) return "reposts";
  if (hasViews) return "views";
  if (hasNotifications) return "notifications";
  return "combined";
};

const buildPresetRequestFlags = (query: string): {
  mostRecentPost: boolean;
  mostEngaged: boolean;
  mostEngagedComments: boolean;
  lastComments: boolean;
  lastLikes: boolean;
  lastViews: boolean;
  topParticipants: boolean;
} => {
  const lowered = query.toLowerCase();
  const hasRecentLead = /\b(last|latest|recent)\b/iu.test(lowered);
  const hasCommentsWord = /\bcomments?\b/iu.test(lowered);
  const hasLikesWord = /\blikes?\b/iu.test(lowered);
  const hasViewsWord = /\bviews?\b/iu.test(lowered);

  const groupedRecentList =
    hasRecentLead &&
    (hasCommentsWord || hasLikesWord || hasViewsWord) &&
    /(?:,|\/|&|\band\b)/iu.test(lowered);
  const mostEngagedComments =
    /\b(most|top|highest|best)\s+engaged\s+comments?\b/iu.test(lowered) ||
    /\btop\s+comments?\b/iu.test(lowered) ||
    /\bhighest\s+comment\s+engagement\b/iu.test(lowered);
  const mostEngagedPosts =
    (/\b(most\s+engaged|top\s+engaged|highest\s+engagement|best\s+performing|top\s+performing)\b/iu.test(
      lowered,
    ) || (/\bmost\b/iu.test(lowered) && /\bengagement\b/iu.test(lowered))) &&
    !mostEngagedComments;
  const topParticipants =
    /\b(biggest|top|most)\s+(engagers?|engagement|users|people|accounts)\b/iu.test(
      lowered,
    ) ||
    /\bwho\s+(?:engaged|engages|is\s+in\s+memory)\b/iu.test(lowered) ||
    /\bmemory\s+most\b/iu.test(lowered) ||
    /\bmost\s+active\s+(users|people|accounts)\b/iu.test(lowered);

  return {
    mostRecentPost:
      /\b(most\s+recent|latest|newest|last)\s+post\b/iu.test(lowered),
    mostEngaged: mostEngagedPosts,
    mostEngagedComments,
    lastComments:
      /\b(last|latest|recent)\s+comments?\b/iu.test(lowered) ||
      (groupedRecentList && hasCommentsWord),
    lastLikes:
      /\b(last|latest|recent)\s+likes?\b/iu.test(lowered) ||
      (groupedRecentList && hasLikesWord),
    lastViews:
      /\b(last|latest|recent)\s+views?\b/iu.test(lowered) ||
      (groupedRecentList && hasViewsWord),
    topParticipants,
  };
};

const normalizeDocs = (docs: RetrievalPresetDoc[]): NormalizedDoc[] =>
  docs
    .map((doc) => ({
      doc,
      atMs: Date.parse(doc.receivedAt),
      participantTokens: [
        normalizeParticipantToken(doc.actor),
        ...(Array.isArray(doc.participants) ? doc.participants : []).map(
          (entry) => normalizeParticipantToken(entry),
        ),
      ].filter((entry): entry is string => typeof entry === "string"),
      primaryParticipant:
        normalizeParticipantToken(doc.actor) ??
        (Array.isArray(doc.participants)
          ? doc.participants
              .map((entry) => normalizeParticipantToken(entry))
              .find((entry): entry is string => typeof entry === "string") ?? null
          : null),
    }))
    .filter((entry) => Number.isFinite(entry.atMs))
    .sort((a, b) => b.atMs - a.atMs);

const resolveScopedPostId = (
  docs: NormalizedDoc[],
  postId: number | null,
  commentId: number | null,
): number | null => {
  if (typeof postId === "number") return postId;
  if (typeof commentId !== "number") return null;
  const fromComment = docs.find(
    (entry) =>
      entry.doc.commentId === commentId && typeof entry.doc.postId === "number",
  );
  return fromComment?.doc.postId ?? null;
};

const isInRange = (atMs: number, nowMs: number, maxAgeMs: number): boolean => {
  if (atMs > nowMs) return false;
  return nowMs - atMs <= maxAgeMs;
};

const collectLatestEvents = (
  docs: NormalizedDoc[],
  sourceType: string,
  limit: number,
  scopePostId: number | null,
  scopeCommentId: number | null,
): RetrievalPresetEvent[] => {
  const maxItems = Math.max(1, Math.min(10, Math.floor(limit)));
  return docs
    .filter((entry) => entry.doc.sourceType === sourceType)
    .filter((entry) => {
      if (typeof scopePostId === "number") return entry.doc.postId === scopePostId;
      if (typeof scopeCommentId === "number")
        return entry.doc.commentId === scopeCommentId;
      return true;
    })
    .slice(0, maxItems)
    .map((entry) => ({
      receivedAt: entry.doc.receivedAt,
      postId: entry.doc.postId,
      commentId: entry.doc.commentId,
      actor: entry.doc.actor,
      summary: entry.doc.summary,
    }));
};

export const buildRetrievalPresets = (
  input: RetrievalPresetInput,
): RetrievalPresetSummary => {
  const query = input.query.trim();
  const requested = buildPresetRequestFlags(query);
  const shouldRunAnyPreset =
    requested.mostRecentPost ||
    requested.mostEngaged ||
    requested.mostEngagedComments ||
    requested.lastComments ||
    requested.lastLikes ||
    requested.lastViews ||
    requested.topParticipants;

  if (!shouldRunAnyPreset) {
    return {
      requested,
      range: null,
      mostRecentPost: null,
      mostEngaged: null,
      mostEngagedComments: null,
      lastComments: [],
      lastLikes: [],
      lastViews: [],
      topParticipants: null,
      lines: [],
    };
  }

  const docs = normalizeDocs(input.docs);
  const nowMsCandidate = input.nowMs;
  const nowMs =
    typeof nowMsCandidate === "number" && Number.isFinite(nowMsCandidate)
      ? nowMsCandidate
      : Date.now();
  const defaultRangeMs =
    typeof input.defaultRangeMs === "number" && Number.isFinite(input.defaultRangeMs)
      ? Math.max(60_000, Math.floor(input.defaultRangeMs))
      : DEFAULT_RANGE_MS_BY_INTENT[input.intent];
  const range = parseRangeFromQuery(query, defaultRangeMs);
  const scopePostId = resolveScopedPostId(docs, input.postId, input.commentId);
  const scopeCommentId = input.commentId;
  const maxEngagedPosts = Math.max(
    1,
    Math.min(5, Math.floor(input.maxMostEngagedPosts ?? 3)),
  );
  const maxEngagedComments = Math.max(
    1,
    Math.min(6, Math.floor(input.maxMostEngagedComments ?? 4)),
  );
  const maxEventsPerType = Math.max(
    1,
    Math.min(6, Math.floor(input.maxEventsPerType ?? 3)),
  );
  const maxTopParticipants = Math.max(
    1,
    Math.min(12, Math.floor(input.maxTopParticipants ?? 6)),
  );
  const topParticipantMetric = parseTopParticipantMetric(query);

  let mostRecentPost: RetrievalPresetMostRecentPost | null = null;
  if (requested.mostRecentPost) {
    const latestPost = docs.find(
      (entry) =>
        entry.doc.sourceType === "post_created" &&
        (typeof scopePostId !== "number" || entry.doc.postId === scopePostId),
    );
    if (latestPost && typeof latestPost.doc.postId === "number") {
      mostRecentPost = {
        receivedAt: latestPost.doc.receivedAt,
        postId: latestPost.doc.postId,
        actor: latestPost.doc.actor,
        summary: latestPost.doc.summary,
      };
    }
  }

  let mostEngaged: RetrievalPresetSummary["mostEngaged"] = null;
  if (requested.mostEngaged) {
    const postSummaryById = new Map<number, string>();
    for (const entry of docs) {
      if (entry.doc.sourceType !== "post_created") continue;
      if (typeof entry.doc.postId !== "number") continue;
      if (!postSummaryById.has(entry.doc.postId)) {
        postSummaryById.set(entry.doc.postId, entry.doc.summary);
      }
    }

    const aggregate = new Map<
      number,
      {
        postId: number;
        score: number;
        comments: number;
        likes: number;
        reposts: number;
        views: number;
        lastAt: string;
      }
    >();

    for (const entry of docs) {
      if (!isInRange(entry.atMs, nowMs, range.maxAgeMs)) continue;
      if (typeof scopePostId === "number" && entry.doc.postId !== scopePostId) continue;
      if (typeof entry.doc.postId !== "number") continue;
      const weight = ENGAGEMENT_WEIGHTS[entry.doc.sourceType ?? ""] ?? 0;
      if (weight <= 0) continue;
      const existing = aggregate.get(entry.doc.postId) ?? {
        postId: entry.doc.postId,
        score: 0,
        comments: 0,
        likes: 0,
        reposts: 0,
        views: 0,
        lastAt: entry.doc.receivedAt,
      };
      existing.score += weight;
      if (entry.doc.sourceType === "post_comment") existing.comments += 1;
      else if (entry.doc.sourceType === "post_like") existing.likes += 1;
      else if (entry.doc.sourceType === "post_repost") existing.reposts += 1;
      else if (entry.doc.sourceType === "post_view") existing.views += 1;
      if (Date.parse(entry.doc.receivedAt) > Date.parse(existing.lastAt)) {
        existing.lastAt = entry.doc.receivedAt;
      }
      aggregate.set(entry.doc.postId, existing);
    }

    const posts = [...aggregate.values()]
      .sort((a, b) =>
        b.score !== a.score
          ? b.score - a.score
          : Date.parse(b.lastAt) - Date.parse(a.lastAt),
      )
      .slice(0, maxEngagedPosts)
      .map((entry) => ({
        ...entry,
        summary: postSummaryById.get(entry.postId) ?? null,
      }));

    mostEngaged = {
      rangeLabel: range.label,
      rangeMaxAgeMs: range.maxAgeMs,
      posts,
    };
  }

  let mostEngagedComments: RetrievalPresetSummary["mostEngagedComments"] = null;
  if (requested.mostEngagedComments) {
    const commentSummaryById = new Map<number, string>();
    for (const entry of docs) {
      if (entry.doc.sourceType !== "post_comment") continue;
      if (typeof entry.doc.commentId !== "number") continue;
      if (!commentSummaryById.has(entry.doc.commentId)) {
        commentSummaryById.set(entry.doc.commentId, entry.doc.summary);
      }
    }

    const aggregate = new Map<
      number,
      {
        commentId: number;
        postId: number | null;
        score: number;
        comments: number;
        likes: number;
        reposts: number;
        views: number;
        notifications: number;
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
      if (typeof entry.doc.commentId !== "number") continue;
      const weight = COMMENT_ENGAGEMENT_WEIGHTS[entry.doc.sourceType ?? ""] ?? 0;
      if (weight <= 0) continue;
      const existing = aggregate.get(entry.doc.commentId) ?? {
        commentId: entry.doc.commentId,
        postId: entry.doc.postId,
        score: 0,
        comments: 0,
        likes: 0,
        reposts: 0,
        views: 0,
        notifications: 0,
        lastAt: entry.doc.receivedAt,
      };
      existing.score += weight;
      if (entry.doc.sourceType === "post_comment") existing.comments += 1;
      else if (entry.doc.sourceType === "post_like") existing.likes += 1;
      else if (entry.doc.sourceType === "post_repost") existing.reposts += 1;
      else if (entry.doc.sourceType === "post_view") existing.views += 1;
      else if (entry.doc.sourceType === "notification_created") {
        existing.notifications += 1;
      }
      if (typeof entry.doc.postId === "number") {
        existing.postId = entry.doc.postId;
      }
      if (Date.parse(entry.doc.receivedAt) > Date.parse(existing.lastAt)) {
        existing.lastAt = entry.doc.receivedAt;
      }
      aggregate.set(entry.doc.commentId, existing);
    }

    const comments = [...aggregate.values()]
      .sort((a, b) =>
        b.score !== a.score
          ? b.score - a.score
          : Date.parse(b.lastAt) - Date.parse(a.lastAt),
      )
      .slice(0, maxEngagedComments)
      .map((entry) => ({
        ...entry,
        summary: commentSummaryById.get(entry.commentId) ?? null,
      }));

    mostEngagedComments = {
      rangeLabel: range.label,
      rangeMaxAgeMs: range.maxAgeMs,
      comments,
    };
  }

  const lastComments = requested.lastComments
    ? collectLatestEvents(
        docs,
        "post_comment",
        maxEventsPerType,
        scopePostId,
        scopeCommentId,
      )
    : [];
  const lastLikes = requested.lastLikes
    ? collectLatestEvents(
        docs,
        "post_like",
        maxEventsPerType,
        scopePostId,
        scopeCommentId,
      )
    : [];
  const lastViews = requested.lastViews
    ? collectLatestEvents(
        docs,
        "post_view",
        maxEventsPerType,
        scopePostId,
        scopeCommentId,
      )
    : [];

  let topParticipants: RetrievalPresetSummary["topParticipants"] = null;
  if (requested.topParticipants) {
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
      return (
        entry.score +
        entry.presence * 0.35 +
        entry.notifications * 0.4
      );
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

    topParticipants = {
      rangeLabel: range.label,
      rangeMaxAgeMs: range.maxAgeMs,
      metric: topParticipantMetric,
      participants,
    };
  }

  const lines: string[] = [];
  if (requested.mostRecentPost) {
    if (mostRecentPost) {
      lines.push(
        `preset:most_recent_post post:${mostRecentPost.postId} at=${mostRecentPost.receivedAt} :: ${toSummaryPreview(
          mostRecentPost.summary,
        )}`,
      );
    } else {
      lines.push("preset:most_recent_post none");
    }
  }

  if (requested.mostEngaged) {
    const postCount = mostEngaged?.posts.length ?? 0;
    lines.push(`preset:most_engaged range=${range.label} posts=${postCount}`);
    if (mostEngaged) {
      for (const post of mostEngaged.posts) {
        lines.push(
          `engaged post:${post.postId} score=${post.score.toFixed(1)} comments=${post.comments} likes=${post.likes} reposts=${post.reposts} views=${post.views} last=${post.lastAt} :: ${toSummaryPreview(post.summary ?? "(summary unavailable)")}`,
        );
      }
    }
  }

  if (requested.mostEngagedComments) {
    const commentCount = mostEngagedComments?.comments.length ?? 0;
    lines.push(
      `preset:most_engaged_comments range=${range.label} comments=${commentCount}`,
    );
    if (mostEngagedComments) {
      for (const comment of mostEngagedComments.comments) {
        lines.push(
          `engaged comment:${comment.commentId} post:${comment.postId ?? "n/a"} score=${comment.score.toFixed(1)} comments=${comment.comments} likes=${comment.likes} reposts=${comment.reposts} views=${comment.views} notifications=${comment.notifications} last=${comment.lastAt} :: ${toSummaryPreview(comment.summary ?? "(summary unavailable)")}`,
        );
      }
    }
  }

  const appendEventLines = (
    label: "comments" | "likes" | "views",
    events: RetrievalPresetEvent[],
  ): void => {
    lines.push(`preset:last_${label} count=${events.length}`);
    for (const event of events) {
      const postToken =
        typeof event.postId === "number" ? `post:${event.postId}` : "post:n/a";
      const commentToken =
        typeof event.commentId === "number"
          ? `comment:${event.commentId}`
          : "comment:n/a";
      const actorToken = event.actor?.trim().length ? event.actor : "unknown";
      lines.push(
        `${label.slice(0, -1)} ${postToken} ${commentToken} actor=${actorToken} at=${event.receivedAt} :: ${toSummaryPreview(event.summary)}`,
      );
    }
  };

  if (requested.lastComments) appendEventLines("comments", lastComments);
  if (requested.lastLikes) appendEventLines("likes", lastLikes);
  if (requested.lastViews) appendEventLines("views", lastViews);
  if (requested.topParticipants) {
    const count = topParticipants?.participants.length ?? 0;
    lines.push(
      `preset:top_participants range=${range.label} metric=${topParticipantMetric} users=${count}`,
    );
    if (topParticipants) {
      for (const entry of topParticipants.participants) {
        lines.push(
          `participant ${entry.participant} score=${entry.score.toFixed(2)} presence=${entry.presence} comments=${entry.comments} likes=${entry.likes} reposts=${entry.reposts} views=${entry.views} notifications=${entry.notifications} last=${entry.lastAt}`,
        );
      }
    }
  }

  return {
    requested,
    range,
    mostRecentPost,
    mostEngaged,
    mostEngagedComments,
    lastComments,
    lastLikes,
    lastViews,
    topParticipants,
    lines,
  };
};
