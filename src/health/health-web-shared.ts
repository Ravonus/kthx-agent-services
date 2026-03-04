import path from "node:path";

import { trimEnv } from "../lib/env-parse.js";
import { isRecord } from "../lib/guards.js";
import {
  type RetrievalPresetTopParticipantMetric,
} from "../memory/retrieval-presets.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TAIL_MAX_BYTES = 220_000;
export const TAIL_MAX_LINES = 500;

export const DIRECTIVE_STAGED_TYPES = new Set([
  "directive_staged_for_queue_execution",
  "directive_staged_waiting_terminal_run",
  "directive_queue_enqueued",
]);
export const DIRECTIVE_EXECUTED = "directive_queue_executed";
export const DIRECTIVE_FAILED = "directive_queue_execution_failed";
export const PUBLISH_RESULT = "publish_attempt_result";
export const CHAT_AUTO_REPLY = "chat_runtime_auto_reply_sent";
export const MEMORY_REFRESH = "memory_temporal_refreshed";
export const NOTIFICATIONS_FLUSHED = "notifications_buffer_flushed";
export const ENGAGEMENT_CONTEXT_SEED = "engagement_context_seed";
export const ENGAGEMENT_CONTEXT_PRIME_COMPLETED = "engagement_context_prime_completed";
export const ENGAGEMENT_CONTEXT_PRIME_EMPTY = "engagement_context_prime_empty";
export const ENGAGEMENT_TARGET_RESOLVED = "engagement_target_resolved";
export const ENGAGEMENT_TARGET_RESOLUTION_FAILED = "engagement_target_resolution_failed";
export const QUEUE_NOT_READY_REQUEUED = "directive_queue_not_ready_requeued";
export const INBOX_COMMAND_REQUEUED = "inbox_command_requeued";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
};

export const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export const bool = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : null;

export const iso = (v: unknown): string | null => {
  const c = str(v);
  if (!c) return null;
  return Number.isFinite(Date.parse(c)) ? c : null;
};

export const intFromUnknown = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return Math.floor(v);
  }
  if (typeof v === "string") {
    const parsed = Number.parseInt(v.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
};

export const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export type RetrievalIntent = "chat" | "directive" | "engagement";

export type KeywordIndexDoc = {
  id: string;
  receivedAt: string;
  sourceType: string | null;
  topic: string | null;
  postId: number | null;
  commentId: number | null;
  actor: string | null;
  participants: string[];
  summary: string;
  keywords: string[];
};

export type KeywordIndexSnapshot = {
  version: 1;
  updatedAt: string;
  docs: Record<string, KeywordIndexDoc>;
  inverted: Record<string, string[]>;
};

export type LongTermArchiveCapsule = {
  id: string;
  stream: string;
  archiveBasename: string;
  compactedAt: string;
  eventCount: number;
  summary: string;
  keywords: string[];
  postIds: number[];
  commentIds: number[];
  compressedBy: "algorithm" | "agent";
};

export type LongTermArchiveIndexSnapshot = {
  version: 1;
  updatedAt: string;
  items: LongTermArchiveCapsule[];
};

export type RetentionPolicyView = {
  enabled: boolean;
  intervalMinutes: number;
  commandsDays: number;
  moodsDays: number;
  postsDays: number;
  interactionsDays: number;
  notificationsDays: number;
  systemDays: number;
  longTermEnabled: boolean;
  longTermMaxCapsules: number;
  longTermMaxCompactionsPerRun: number;
  longTermMaxEventsPerArchive: number;
  longTermMaxSnippetsPerArchive: number;
  longTermUseAgentCompression: boolean;
};

export const RETRIEVAL_SOURCE_WEIGHT_BY_INTENT: Record<RetrievalIntent, Record<string, number>> = {
  chat: {
    post_created: 1.5,
    post_comment: 1.8,
    post_like: 1.1,
    post_repost: 1.1,
    post_view: 1.0,
    notification_created: 1.2,
    story_reply: 1.3,
    chat_runtime_site_lookup: 2.1,
  },
  directive: {
    post_created: 2.6,
    post_comment: 2.2,
    post_like: 0.9,
    post_repost: 1.0,
    post_view: 0.8,
    notification_created: 1.8,
    story_reply: 1.4,
    chat_runtime_site_lookup: 2.4,
  },
  engagement: {
    post_created: 1.4,
    post_comment: 2.8,
    post_like: 2.5,
    post_repost: 2.4,
    post_view: 1.9,
    notification_created: 1.9,
    story_reply: 1.8,
    chat_runtime_site_lookup: 2.2,
  },
};

export const RETRIEVAL_MAX_AGE_HOURS_BY_INTENT: Record<RetrievalIntent, number> = {
  chat: 168,
  directive: 96,
  engagement: 72,
};

export const LONG_TERM_SOURCE_WEIGHT_BY_INTENT: Record<RetrievalIntent, number> = {
  chat: 1.2,
  directive: 1.5,
  engagement: 1.3,
};

export const RETRIEVAL_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "how",
  "i",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "them",
  "this",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "who",
  "why",
  "with",
  "you",
  "your",
]);

export const tokenizeRetrievalText = (value: string): string[] => {
  const tokens = value
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !RETRIEVAL_STOPWORDS.has(token));
  return [...new Set(tokens)];
};

export const parsePostAndCommentHints = (value: string): { postId: number | null; commentId: number | null } => {
  const normalized = value.trim();
  if (!normalized.length) return { postId: null, commentId: null };
  const postMatch =
    /\bpost(?:\s+number)?\s*#?\s*(\d+)\b/iu.exec(normalized) ??
    /(?:^|\s)#(\d{1,10})(?:\s|$)/u.exec(normalized);
  const commentMatch = /\bcomment(?:\s+number)?\s*#?\s*(\d+)\b/iu.exec(normalized);
  return {
    postId: postMatch?.[1] ? intFromUnknown(postMatch[1]) : null,
    commentId: commentMatch?.[1] ? intFromUnknown(commentMatch[1]) : null,
  };
};

export const parseRetrievalIntent = (value: string | null): RetrievalIntent => {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "directive" || normalized === "engagement" || normalized === "chat") {
    return normalized;
  }
  return "chat";
};

export const parseTopParticipantMetric = (
  value: string | null,
): RetrievalPresetTopParticipantMetric => {
  const normalized = (value ?? "").trim().toLowerCase();
  if (
    normalized === "combined" ||
    normalized === "comments" ||
    normalized === "likes" ||
    normalized === "reposts" ||
    normalized === "views" ||
    normalized === "notifications" ||
    normalized === "presence"
  ) {
    return normalized;
  }
  return "combined";
};

export const parseMetricsBucketMsFromQuery = (
  query: URLSearchParams,
  rangeMs: number,
): number => {
  const raw = (query.get("bucket") ?? "").trim().toLowerCase();
  if (raw === "1h" || raw === "60m") return 3_600_000;
  if (raw === "2h" || raw === "120m") return 2 * 3_600_000;
  if (raw === "6h" || raw === "360m") return 6 * 3_600_000;
  if (raw === "12h" || raw === "720m") return 12 * 3_600_000;
  if (raw === "1d" || raw === "24h" || raw === "1440m") return 24 * 3_600_000;
  if (rangeMs <= 2 * 24 * 3_600_000) return 3_600_000;
  if (rangeMs <= 14 * 24 * 3_600_000) return 6 * 3_600_000;
  return 24 * 3_600_000;
};

export const normalizeParticipantToken = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  if (/^id:[a-zA-Z0-9_.:-]{6,120}$/u.test(trimmed)) return trimmed;
  const handle = trimmed.replace(/^@+/u, "").toLowerCase();
  if (!/^[a-z0-9_.-]{2,64}$/u.test(handle)) return null;
  return `@${handle}`;
};

export const resolveRangeMsFromQuery = (query: URLSearchParams): number => {
  const direct = parseBoundedIntQuery(query.get("rangeMs"), 60_000, 366 * 86_400_000);
  if (direct !== null) return direct;
  const range = (query.get("range") ?? "").trim().toLowerCase();
  if (range === "24h") return 24 * 3_600_000;
  if (range === "7d") return 7 * 24 * 3_600_000;
  if (range === "30d") return 30 * 24 * 3_600_000;
  if (range === "90d") return 90 * 24 * 3_600_000;
  if (range === "365d") return 365 * 24 * 3_600_000;
  return 30 * 24 * 3_600_000;
};

export const formatRangeLabelFromMs = (rangeMs: number): string => {
  const totalHours = Math.max(1, Math.round(rangeMs / 3_600_000));
  if (totalHours % (24 * 30) === 0) return `${totalHours / (24 * 30)}mo`;
  if (totalHours % 24 === 0) return `${totalHours / 24}d`;
  return `${totalHours}h`;
};

export const normalizeKeywordDoc = (docId: string, raw: unknown): KeywordIndexDoc | null => {
  if (!isRecord(raw)) return null;
  const summary = str(raw.summary);
  if (!summary) return null;
  const keywordsRaw = Array.isArray(raw.keywords) ? raw.keywords : [];
  const keywords = [
    ...new Set(
      keywordsRaw
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length >= 3),
    ),
  ].slice(0, 32);
  if (keywords.length === 0) return null;
  return {
    id: docId,
    receivedAt: iso(raw.receivedAt) ?? new Date(0).toISOString(),
    sourceType: str(raw.sourceType),
    topic: str(raw.topic),
    postId: intFromUnknown(raw.postId),
    commentId: intFromUnknown(raw.commentId),
    actor: str(raw.actor),
    participants: Array.isArray(raw.participants)
      ? [
          ...new Set(
            raw.participants
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim())
              .filter((item) => item.length > 0),
          ),
        ].slice(0, 16)
      : [],
    summary,
    keywords,
  };
};

export const normalizeKeywordIndex = (value: unknown): KeywordIndexSnapshot => {
  if (!isRecord(value)) {
    return {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      docs: {},
      inverted: {},
    };
  }
  const rawDocs = isRecord(value.docs) ? value.docs : {};
  const docs: Record<string, KeywordIndexDoc> = {};
  for (const [docId, rawDoc] of Object.entries(rawDocs)) {
    const trimmedId = docId.trim();
    if (!trimmedId.length) continue;
    const normalized = normalizeKeywordDoc(trimmedId, rawDoc);
    if (!normalized) continue;
    docs[trimmedId] = normalized;
  }
  const inverted: Record<string, string[]> = {};
  for (const [docId, doc] of Object.entries(docs)) {
    for (const keyword of doc.keywords) {
      inverted[keyword] ??= [];
      inverted[keyword].push(docId);
    }
  }
  for (const keyword of Object.keys(inverted)) {
    const docIds = (inverted[keyword] ?? [])
      .filter((docId) => Boolean(docs[docId]))
      .sort((a, b) => {
        const aAt = docs[a]?.receivedAt ?? "";
        const bAt = docs[b]?.receivedAt ?? "";
        return aAt < bAt ? 1 : aAt > bAt ? -1 : 0;
      });
    inverted[keyword] = [...new Set(docIds)].slice(0, 300);
  }
  return {
    version: 1,
    updatedAt: iso(value.updatedAt) ?? new Date(0).toISOString(),
    docs,
    inverted,
  };
};

export const normalizeLongTermArchiveIndex = (
  value: unknown,
): LongTermArchiveIndexSnapshot => {
  if (!isRecord(value)) {
    return { version: 1, updatedAt: new Date(0).toISOString(), items: [] };
  }
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const items = rawItems
    .map((raw): LongTermArchiveCapsule | null => {
      if (!isRecord(raw)) return null;
      const id = str(raw.id);
      const stream = str(raw.stream);
      const archiveBasename = str(raw.archiveBasename);
      const compactedAt = iso(raw.compactedAt);
      const summary = str(raw.summary);
      if (!id || !stream || !archiveBasename || !compactedAt || !summary) {
        return null;
      }
      const keywords = Array.isArray(raw.keywords)
        ? [
            ...new Set(
              raw.keywords
                .filter((item): item is string => typeof item === "string")
                .map((item) => item.trim().toLowerCase())
                .filter((item) => item.length >= 3),
            ),
          ].slice(0, 64)
        : [];
      const postIds = Array.isArray(raw.postIds)
        ? [
            ...new Set(
              raw.postIds
                .map((item) => intFromUnknown(item))
                .filter((item): item is number => typeof item === "number"),
            ),
          ].slice(0, 400)
        : [];
      const commentIds = Array.isArray(raw.commentIds)
        ? [
            ...new Set(
              raw.commentIds
                .map((item) => intFromUnknown(item))
                .filter((item): item is number => typeof item === "number"),
            ),
          ].slice(0, 800)
        : [];
      const compressedBy =
        str(raw.compressedBy) === "agent" ? "agent" : "algorithm";
      return {
        id,
        stream,
        archiveBasename,
        compactedAt,
        eventCount: intFromUnknown(raw.eventCount) ?? 0,
        summary,
        keywords,
        postIds,
        commentIds,
        compressedBy,
      };
    })
    .filter((item): item is LongTermArchiveCapsule => item !== null)
    .sort((a, b) =>
      a.compactedAt < b.compactedAt ? 1 : a.compactedAt > b.compactedAt ? -1 : 0,
    );
  return {
    version: 1,
    updatedAt: iso(value.updatedAt) ?? new Date(0).toISOString(),
    items,
  };
};

export const parseBooleanQuery = (value: string | null): boolean | null => {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
};

export const parseBoundedIntQuery = (
  value: string | null,
  min: number,
  max: number,
): number | null => {
  if (value === null) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
};

export const ensureRecordField = (
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const current = parent[key];
  if (isRecord(current)) return current;
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
};

export const resolveKthxConfigPath = (stateDir: string): string => {
  const configured = trimEnv("MG_AGENT_KTHX_CONFIG_PATH");
  if (configured) return path.resolve(configured);
  return path.resolve(path.dirname(stateDir), "config.json");
};

export const normalizeRetentionPolicy = (
  configRaw: unknown,
): RetentionPolicyView | null => {
  if (!isRecord(configRaw)) return null;
  const memory = isRecord(configRaw.memory) ? configRaw.memory : {};
  const retention = isRecord(memory.retention) ? memory.retention : {};
  const longTerm = isRecord(retention.longTerm) ? retention.longTerm : {};
  const readDays = (value: unknown): number | null =>
    isRecord(value) ? intFromUnknown(value.days) : null;
  return {
    enabled: bool(retention.enabled) ?? true,
    intervalMinutes: parseBoundedIntQuery(
      String(intFromUnknown(retention.intervalMinutes) ?? ""),
      10,
      1440,
    ) ?? 180,
    commandsDays: readDays(retention.commands) ?? 365,
    moodsDays: readDays(retention.moods) ?? 365,
    postsDays: readDays(retention.posts) ?? 365,
    interactionsDays: readDays(retention.interactions) ?? 365,
    notificationsDays: readDays(retention.notifications) ?? 365,
    systemDays: readDays(retention.system) ?? 365,
    longTermEnabled: bool(longTerm.enabled) ?? true,
    longTermMaxCapsules:
      parseBoundedIntQuery(String(intFromUnknown(longTerm.maxCapsules) ?? ""), 1000, 2_000_000) ??
      200_000,
    longTermMaxCompactionsPerRun:
      parseBoundedIntQuery(
        String(intFromUnknown(longTerm.maxCompactionsPerRun) ?? ""),
        1,
        100,
      ) ?? 10,
    longTermMaxEventsPerArchive:
      parseBoundedIntQuery(
        String(intFromUnknown(longTerm.maxEventsPerArchive) ?? ""),
        20,
        2000,
      ) ?? 180,
    longTermMaxSnippetsPerArchive:
      parseBoundedIntQuery(
        String(intFromUnknown(longTerm.maxSnippetsPerArchive) ?? ""),
        1,
        24,
      ) ?? 8,
    longTermUseAgentCompression: bool(longTerm.useAgentCompression) ?? true,
  };
};

export type MemorySourceMetricKey =
  | "comments"
  | "likes"
  | "reposts"
  | "views"
  | "notifications";


export const resolveMemorySourceMetric = (
  sourceType: string | null,
): MemorySourceMetricKey | null => {
  if (sourceType === "post_comment") return "comments";
  if (sourceType === "post_like") return "likes";
  if (sourceType === "post_repost") return "reposts";
  if (sourceType === "post_view") return "views";
  if (sourceType === "notification_created") return "notifications";
  return null;
};

export const metricValueFromParticipant = (
  participant: {
    comments: number;
    likes: number;
    reposts: number;
    views: number;
    notifications: number;
    presence: number;
    combined: number;
  },
  metric: RetrievalPresetTopParticipantMetric,
): number => {
  if (metric === "comments") return participant.comments;
  if (metric === "likes") return participant.likes;
  if (metric === "reposts") return participant.reposts;
  if (metric === "views") return participant.views;
  if (metric === "notifications") return participant.notifications;
  if (metric === "presence") return participant.presence;
  return participant.combined;
};
