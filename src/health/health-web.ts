/**
 * Standalone HTTP server serving an agent health dashboard.
 *
 * Ported from agent-health-web.mjs.
 *
 * Reads various state files (debug snapshot, queue state, chat status,
 * mood, temporal memory, writes JSONL, inbox JSONL) and serves:
 *   GET /api/health  - JSON health snapshot
 *   GET /            - HTML dashboard with auto-refresh
 *
 * Optional env:
 *   MG_AGENT_STATE_DIR
 *   MG_AGENT_HEALTH_HOST (default 127.0.0.1)
 *   MG_AGENT_HEALTH_PORT (default 4278)
 */

import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { loadDotEnv } from "../config/dotenv.js";
import { trimEnv, parseIntEnv } from "../lib/env-parse.js";
import { isRecord } from "../lib/guards.js";
import {
  createStateSqliteStoreFromEnv,
  type StateSqliteStore,
} from "../state/sqlite-state.js";
import {
  buildRetrievalPresets,
  type RetrievalPresetTopParticipantMetric,
} from "../memory/retrieval-presets.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAIL_MAX_BYTES = 220_000;
const TAIL_MAX_LINES = 500;

const DIRECTIVE_STAGED_TYPES = new Set([
  "directive_staged_for_queue_execution",
  "directive_staged_waiting_terminal_run",
  "directive_queue_enqueued",
]);
const DIRECTIVE_EXECUTED = "directive_queue_executed";
const DIRECTIVE_FAILED = "directive_queue_execution_failed";
const PUBLISH_RESULT = "publish_attempt_result";
const CHAT_AUTO_REPLY = "chat_runtime_auto_reply_sent";
const MEMORY_REFRESH = "memory_temporal_refreshed";
const NOTIFICATIONS_FLUSHED = "notifications_buffer_flushed";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
};

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const bool = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : null;

const iso = (v: unknown): string | null => {
  const c = str(v);
  if (!c) return null;
  return Number.isFinite(Date.parse(c)) ? c : null;
};

const intFromUnknown = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return Math.floor(v);
  }
  if (typeof v === "string") {
    const parsed = Number.parseInt(v.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

type RetrievalIntent = "chat" | "directive" | "engagement";

type KeywordIndexDoc = {
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

type KeywordIndexSnapshot = {
  version: 1;
  updatedAt: string;
  docs: Record<string, KeywordIndexDoc>;
  inverted: Record<string, string[]>;
};

type LongTermArchiveCapsule = {
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

type LongTermArchiveIndexSnapshot = {
  version: 1;
  updatedAt: string;
  items: LongTermArchiveCapsule[];
};

type RetentionPolicyView = {
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

const RETRIEVAL_SOURCE_WEIGHT_BY_INTENT: Record<RetrievalIntent, Record<string, number>> = {
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

const RETRIEVAL_MAX_AGE_HOURS_BY_INTENT: Record<RetrievalIntent, number> = {
  chat: 168,
  directive: 96,
  engagement: 72,
};

const LONG_TERM_SOURCE_WEIGHT_BY_INTENT: Record<RetrievalIntent, number> = {
  chat: 1.2,
  directive: 1.5,
  engagement: 1.3,
};

const RETRIEVAL_STOPWORDS = new Set([
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

const tokenizeRetrievalText = (value: string): string[] => {
  const tokens = value
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !RETRIEVAL_STOPWORDS.has(token));
  return [...new Set(tokens)];
};

const parsePostAndCommentHints = (value: string): { postId: number | null; commentId: number | null } => {
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

const parseRetrievalIntent = (value: string | null): RetrievalIntent => {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "directive" || normalized === "engagement" || normalized === "chat") {
    return normalized;
  }
  return "chat";
};

const parseTopParticipantMetric = (
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

const normalizeParticipantToken = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  if (/^id:[a-zA-Z0-9_.:-]{6,120}$/u.test(trimmed)) return trimmed;
  const handle = trimmed.replace(/^@+/u, "").toLowerCase();
  if (!/^[a-z0-9_.-]{2,64}$/u.test(handle)) return null;
  return `@${handle}`;
};

const resolveRangeMsFromQuery = (query: URLSearchParams): number => {
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

const formatRangeLabelFromMs = (rangeMs: number): string => {
  const totalHours = Math.max(1, Math.round(rangeMs / 3_600_000));
  if (totalHours % (24 * 30) === 0) return `${totalHours / (24 * 30)}mo`;
  if (totalHours % 24 === 0) return `${totalHours / 24}d`;
  return `${totalHours}h`;
};

const normalizeKeywordDoc = (docId: string, raw: unknown): KeywordIndexDoc | null => {
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

const normalizeKeywordIndex = (value: unknown): KeywordIndexSnapshot => {
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

const normalizeLongTermArchiveIndex = (
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

const parseBooleanQuery = (value: string | null): boolean | null => {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
};

const parseBoundedIntQuery = (
  value: string | null,
  min: number,
  max: number,
): number | null => {
  if (value === null) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
};

const ensureRecordField = (
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const current = parent[key];
  if (isRecord(current)) return current;
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
};

const resolveKthxConfigPath = (stateDir: string): string => {
  const configured = trimEnv("MG_AGENT_KTHX_CONFIG_PATH");
  if (configured) return path.resolve(configured);
  return path.resolve(path.dirname(stateDir), "config.json");
};

const normalizeRetentionPolicy = (
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

const buildRetrievalDiagnostics = (input: {
  index: KeywordIndexSnapshot;
  longTermIndex: LongTermArchiveIndexSnapshot;
  query: string;
  intent: RetrievalIntent;
  postId: number | null;
  commentId: number | null;
  limit: number;
  agentHandle: string | null;
  agentName: string | null;
}): Record<string, unknown> => {
  const queryHints = parsePostAndCommentHints(input.query);
  let resolvedPostId = input.postId ?? queryHints.postId;
  const resolvedCommentId = input.commentId ?? queryHints.commentId;
  if (resolvedPostId === null && resolvedCommentId !== null) {
    const commentDoc = Object.values(input.index.docs).find(
      (doc) => doc.commentId === resolvedCommentId && typeof doc.postId === "number",
    );
    if (commentDoc?.postId) resolvedPostId = commentDoc.postId;
  }

  const baseQuery = input.query.trim().length
    ? input.query.trim()
    : [
        resolvedPostId !== null ? `post ${resolvedPostId}` : "",
        resolvedCommentId !== null ? `comment ${resolvedCommentId}` : "",
      ]
        .filter((part) => part.length > 0)
        .join(" ")
        .trim();

  const keywords = tokenizeRetrievalText(baseQuery).slice(0, 12);
  const presetSummary = buildRetrievalPresets({
    docs: Object.values(input.index.docs),
    query: baseQuery,
    intent: input.intent,
    postId: resolvedPostId,
    commentId: resolvedCommentId,
    defaultRangeMs: RETRIEVAL_MAX_AGE_HOURS_BY_INTENT[input.intent] * 3_600_000,
    maxMostEngagedPosts: 3,
    maxEventsPerType: 4,
  });
  const candidateScores = new Map<string, number>();
  for (const keyword of keywords) {
    const docIds = input.index.inverted[keyword] ?? [];
    for (const docId of docIds.slice(0, 120)) {
      candidateScores.set(docId, (candidateScores.get(docId) ?? 0) + 2);
    }
  }

  if (resolvedPostId !== null || resolvedCommentId !== null) {
    const targetMatchBoost =
      input.intent === "directive"
        ? 8
        : input.intent === "engagement"
          ? 7
          : 6;
    for (const [docId, doc] of Object.entries(input.index.docs)) {
      const matchesComment =
        resolvedCommentId !== null && doc.commentId === resolvedCommentId;
      const matchesPost = resolvedPostId !== null && doc.postId === resolvedPostId;
      if (!matchesComment && !matchesPost) continue;
      const boost = matchesComment ? targetMatchBoost : targetMatchBoost - 2;
      candidateScores.set(docId, (candidateScores.get(docId) ?? 0) + boost);
    }
  }

  const mentionHandles = Array.from(baseQuery.matchAll(/@([a-z0-9_.-]+)/giu))
    .map((match) => (match[1] ?? "").trim().toLowerCase())
    .filter((token) => token.length > 0);
  const sourceWeightMap = RETRIEVAL_SOURCE_WEIGHT_BY_INTENT[input.intent];
  const maxAgeHours = RETRIEVAL_MAX_AGE_HOURS_BY_INTENT[input.intent];
  const nowMs = Date.now();

  const scored: Array<{ doc: KeywordIndexDoc; score: number; matchedKeywords: string[] }> = [];
  for (const [docId, baseScore] of candidateScores.entries()) {
    const doc = input.index.docs[docId];
    if (!doc) continue;
    const sourceType = doc.sourceType ?? "event";
    const sourceWeight = sourceWeightMap[sourceType] ?? 1;
    let score = baseScore * sourceWeight;
    const ageMs = nowMs - Date.parse(doc.receivedAt);
    if (Number.isFinite(ageMs) && ageMs >= 0) {
      const ageHours = ageMs / 3_600_000;
      if (ageHours > maxAgeHours) continue;
      const freshness = 1 - Math.min(ageHours / maxAgeHours, 1);
      const freshnessWeight =
        input.intent === "directive" ? 2.2 : input.intent === "engagement" ? 2 : 1.6;
      score += freshness * freshnessWeight;
    }
    if (resolvedPostId !== null && doc.postId === resolvedPostId) {
      score += input.intent === "directive" ? 5.5 : input.intent === "engagement" ? 4.8 : 4;
    }
    if (resolvedCommentId !== null && doc.commentId === resolvedCommentId) {
      score += input.intent === "directive" ? 7 : input.intent === "engagement" ? 6.2 : 5;
    }
    if (mentionHandles.length > 0 && doc.actor) {
      const actorLower = doc.actor.trim().toLowerCase().replace(/^@+/u, "");
      if (actorLower.length > 0) {
        const actorMatched = mentionHandles.some(
          (handle) => handle === actorLower || actorLower.includes(handle),
        );
        if (actorMatched) score += 3;
      }
    }
    const matchedKeywords = doc.keywords.filter((keyword) => keywords.includes(keyword));
    scored.push({ doc, score, matchedKeywords });
  }

  scored.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : a.doc.receivedAt < b.doc.receivedAt
        ? 1
        : a.doc.receivedAt > b.doc.receivedAt
          ? -1
          : 0,
  );

  const safeLimit = Math.max(1, Math.min(50, Math.floor(input.limit)));
  const hits = scored.slice(0, safeLimit).map((entry) => ({
    score: Number.parseFloat(entry.score.toFixed(2)),
    receivedAt: entry.doc.receivedAt,
    sourceType: entry.doc.sourceType,
    topic: entry.doc.topic,
    postId: entry.doc.postId,
    commentId: entry.doc.commentId,
    actor: entry.doc.actor,
    matchedKeywords: entry.matchedKeywords,
    summary: entry.doc.summary,
  }));

  const archiveScored: Array<{
    capsule: LongTermArchiveCapsule;
    score: number;
    matchedKeywords: string[];
  }> = [];
  const nowMsArchive = Date.now();
  for (const capsule of input.longTermIndex.items) {
    const matchedKeywords = capsule.keywords.filter((keyword) =>
      keywords.includes(keyword),
    );
    const matchedPost =
      resolvedPostId !== null && capsule.postIds.includes(resolvedPostId);
    const matchedComment =
      resolvedCommentId !== null && capsule.commentIds.includes(resolvedCommentId);
    if (!matchedKeywords.length && !matchedPost && !matchedComment) continue;
    const compactedAtMs = Date.parse(capsule.compactedAt);
    const ageDays =
      Number.isFinite(compactedAtMs) && compactedAtMs <= nowMsArchive
        ? (nowMsArchive - compactedAtMs) / 86_400_000
        : 365;
    let score =
      matchedKeywords.length *
        2.2 *
        LONG_TERM_SOURCE_WEIGHT_BY_INTENT[input.intent] +
      (1 / (1 + Math.max(0, ageDays / 30))) * 1.6;
    if (matchedPost) score += 6;
    if (matchedComment) score += 7.5;
    if (capsule.compressedBy === "agent") score += 0.5;
    archiveScored.push({ capsule, score, matchedKeywords });
  }
  archiveScored.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : a.capsule.compactedAt < b.capsule.compactedAt
        ? 1
        : a.capsule.compactedAt > b.capsule.compactedAt
          ? -1
          : 0,
  );
  const archiveHits = archiveScored.slice(0, safeLimit).map((entry) => ({
    score: Number.parseFloat(entry.score.toFixed(2)),
    compactedAt: entry.capsule.compactedAt,
    stream: entry.capsule.stream,
    archiveBasename: entry.capsule.archiveBasename,
    eventCount: entry.capsule.eventCount,
    compressedBy: entry.capsule.compressedBy,
    matchedKeywords: entry.matchedKeywords,
    summary: entry.capsule.summary,
  }));

  const agentTokens = [
    str(input.agentHandle)?.replace(/^@+/u, "").toLowerCase() ?? "",
    ...tokenizeRetrievalText(input.agentName ?? "").slice(0, 3),
  ].filter((token) => token.length > 0);

  const docsForPost =
    resolvedPostId === null
      ? []
      : Object.values(input.index.docs)
          .filter((doc) => doc.postId === resolvedPostId)
          .sort((a, b) =>
            a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0,
          );
  const mainPostCandidates = docsForPost.filter((doc) => doc.sourceType === "post_created");
  const mainPost = mainPostCandidates.length > 0 ? mainPostCandidates[0] : docsForPost[0] ?? null;
  const replies = docsForPost.filter((doc) => doc.sourceType === "post_comment");
  const repliesToAgent = replies.filter((doc) => {
    if (agentTokens.length === 0) return false;
    const summaryLower = doc.summary.toLowerCase();
    return agentTokens.some((token) => {
      if (doc.keywords.includes(token)) return true;
      return new RegExp(`(^|[^a-z0-9_])@?${escapeRegExp(token)}([^a-z0-9_]|$)`, "iu").test(summaryLower);
    });
  });

  return {
    intent: input.intent,
    query: baseQuery.length > 0 ? baseQuery : null,
    keywords,
    presets: {
      requested: presetSummary.requested,
      range: presetSummary.range,
      mostRecentPost: presetSummary.mostRecentPost,
      mostEngaged: presetSummary.mostEngaged,
      mostEngagedComments: presetSummary.mostEngagedComments,
      lastComments: presetSummary.lastComments,
      lastLikes: presetSummary.lastLikes,
      lastViews: presetSummary.lastViews,
      lines: presetSummary.lines,
    },
    totalDocs: Object.keys(input.index.docs).length,
    totalKeywords: Object.keys(input.index.inverted).length,
    hitCount: scored.length,
    hits,
    archiveHitCount: archiveScored.length,
    archiveHits,
    target: {
      postId: resolvedPostId,
      commentId: resolvedCommentId,
      mainPost: mainPost
        ? {
            receivedAt: mainPost.receivedAt,
            sourceType: mainPost.sourceType,
            summary: mainPost.summary,
            actor: mainPost.actor,
          }
        : null,
      replyCount: replies.length,
      repliesToAgentCount: repliesToAgent.length,
      repliesToAgent: repliesToAgent.slice(0, 12).map((reply) => ({
        receivedAt: reply.receivedAt,
        actor: reply.actor,
        summary: reply.summary,
        commentId: reply.commentId,
      })),
      latestReplies: replies.slice(0, 12).map((reply) => ({
        receivedAt: reply.receivedAt,
        actor: reply.actor,
        summary: reply.summary,
        commentId: reply.commentId,
      })),
    },
  };
};

const buildMemoryEngagementDiagnostics = (input: {
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

const resolveStateDir = (): string => {
  const configured = trimEnv("MG_AGENT_STATE_DIR");
  if (configured) return path.resolve(configured);
  const agentHomeDir = trimEnv("MG_AGENT_HOME_DIR")
    ? path.resolve(trimEnv("MG_AGENT_HOME_DIR") ?? "kthx-agents")
    : path.resolve(process.cwd(), "kthx-agents");
  return path.resolve(agentHomeDir, "state");
};

let stateDb: StateSqliteStore | null = null;

const getStateDb = (): StateSqliteStore => {
  if (stateDb) return stateDb;
  const db = createStateSqliteStoreFromEnv(resolveStateDir());
  db.init();
  stateDb = db;
  return db;
};

const readJsonRecord = async (p: string): Promise<Record<string, unknown> | null> => {
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const readTailLines = async (filePath: string, maxBytes: number, maxLines: number): Promise<string[]> => {
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

const parseJsonLines = (lines: string[]): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) out.push(parsed);
    } catch { /* skip */ }
  }
  return out;
};

const eventAt = (envelope: Record<string, unknown>, payload: Record<string, unknown> | null): string | null =>
  iso(envelope.receivedAt) ?? iso(payload?.at) ?? null;

const buildPublicProjection = (
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

const buildSnapshot = async (): Promise<Record<string, unknown>> => {
  const stateDir = resolveStateDir();
  const ipcDir = path.join(stateDir, "ipc");
  const chatDir = path.join(ipcDir, "chat");
  const debugDir = path.join(ipcDir, "debug");
  const memDir = path.join(stateDir, "memory");

  const files = {
    latestDebug: path.join(debugDir, "latest.json"),
    chatStatus: path.join(chatDir, "status.json"),
    chatRuntimeState: path.join(chatDir, "runtime-state.json"),
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
    readTailLines(files.writes, TAIL_MAX_BYTES, TAIL_MAX_LINES),
    readTailLines(files.chatInbox, TAIL_MAX_BYTES, TAIL_MAX_LINES),
  ]);
  const keywordIndex = normalizeKeywordIndex(keywordIndexRaw);
  const longTermArchive = normalizeLongTermArchiveIndex(longTermArchiveRaw);
  const retentionPolicy = normalizeRetentionPolicy(kthxConfigRaw);

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

// ---------------------------------------------------------------------------
// HTML dashboard (inline)
// ---------------------------------------------------------------------------

const HTML_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Agent Health</title>
<style>
:root{--bg:#f5f7fb;--card:#fff;--ink:#0f172a;--muted:#475569;--line:#dbe3ef;--ok:#15803d;--warn:#a16207;--bad:#b91c1c}
*{box-sizing:border-box}body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:linear-gradient(145deg,#eef3ff,#f8fafc);color:var(--ink)}
.wrap{max-width:1100px;margin:24px auto;padding:0 16px;display:grid;gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;box-shadow:0 8px 22px rgba(15,23,42,.06)}
.top{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.h1{font-size:22px;font-weight:700;margin:2px 0}.muted{color:var(--muted);font-size:13px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 10px;font-size:13px}.k{color:var(--muted)}
.badge{display:inline-block;padding:3px 8px;border-radius:999px;font-weight:600;font-size:12px}
.ok{background:#dcfce7;color:var(--ok)}.warn{background:#fef3c7;color:var(--warn)}.bad{background:#fee2e2;color:var(--bad)}.neutral{background:#e2e8f0;color:#334155}
.list{display:grid;gap:8px}.evt{border:1px solid var(--line);border-radius:10px;padding:8px;font-size:13px}
input,select,button{font:inherit;border:1px solid var(--line);border-radius:8px;padding:8px;background:#fff;color:var(--ink)}
button{cursor:pointer}
button:hover{background:#f1f5f9}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
</style></head><body>
<div class="wrap">
<div class="card top"><div><div class="muted">Agent Host</div><div class="h1">Read-Only Health</div></div><div class="row"><a href="/graphs" class="badge neutral" style="text-decoration:none">Open Graphs</a><div class="muted" id="ts">refreshing...</div></div></div>
<div class="grid">
<div class="card"><div class="muted">Runtime</div><div id="rt"></div></div>
<div class="card"><div class="muted">Chat Bridge</div><div id="cb"></div></div>
<div class="card"><div class="muted">Agent</div><div id="ag"></div></div>
<div class="card"><div class="muted">Memory</div><div id="mm"></div></div>
<div class="card"><div class="muted">Retention</div><div id="rp"></div></div>
<div class="card"><div class="muted">Activity</div><div id="ac"></div></div>
</div>
<div class="card">
<div class="muted">Retrieval Debug</div>
<div class="row" style="margin:8px 0">
<input id="rq" type="text" placeholder="query (e.g. post 751 engagement)" style="min-width:260px;flex:1"/>
<input id="rpost" type="number" min="1" placeholder="postId" style="width:110px"/>
<input id="rcomment" type="number" min="1" placeholder="commentId" style="width:120px"/>
<select id="rintent"><option value="chat">chat</option><option value="directive">directive</option><option value="engagement">engagement</option></select>
<button id="rrun" type="button">Run</button>
</div>
<div id="rdmeta" class="muted">Run retrieval debug queries locally.</div>
<div id="rd" class="list" style="margin-top:8px"></div>
</div>
<div class="card"><div class="muted">Recent Events</div><div id="events" class="list"></div></div>
<div class="card"><div class="muted">State Paths</div><div id="paths" class="kv"></div></div>
</div>
<script>
const esc=v=>String(v??'n/a').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const badge=v=>{const s=(v??'').toString().toLowerCase();if(['open','ok','ready','true'].includes(s))return['ok',v??'ok'];if(['pending','connecting','reconnecting'].includes(s))return['warn',v??'pending'];if(!s||s==='null'||s==='undefined')return['neutral','n/a'];return['bad',v??'down']};
const fmt=iso=>{if(!iso)return'n/a';const ms=Date.parse(iso);return Number.isFinite(ms)?new Date(ms).toLocaleString():'n/a'};
const kv=obj=>Object.entries(obj).map(([k,v])=>'<div class="k">'+esc(k)+'</div><div>'+esc(v??'n/a')+'</div>').join('');
const fmtTopicCounts=v=>{if(!v||typeof v!=='object')return'n/a';const o=v;return ['user','conversation','channel','server'].map(k=>k+':'+String(o[k]??0)).join(' · ')};
const shellCounts=v=>{if(!v||typeof v!=='object')return'n/a';const c=v.counts; if(!c||typeof c!=='object')return'n/a'; return ['dms','agentDms','groups','servers','channels'].map(k=>k+':'+String(c[k]??0)).join(' · ')};
const healthUrl='/api/health/private';
const render=snap=>{if(!snap)return;document.getElementById('ts').textContent='updated '+fmt(snap.generatedAt)+(snap.available===false&&snap.reason?' · '+snap.reason:'');
const[rC,rT]=badge(snap.runtime?.wsState);document.getElementById('rt').innerHTML='<div class="badge '+esc(rC)+'">'+esc(rT)+'</div><div class="kv" style="margin-top:8px">'+kv({auth:snap.runtime?.authEffective,permission:snap.runtime?.permissionState,wsTransport:snap.runtime?.wsTransportState,lastEnvelope:fmt(snap.runtime?.lastEnvelopeAt),lastPublish:fmt(snap.runtime?.lastPublishAt),publishError:snap.runtime?.lastPublishError??'none'})+'</div>';
const[cC,cT]=badge(snap.chatBridge?.connected===true?'ready':(snap.chatBridge?.state??'unknown'));document.getElementById('cb').innerHTML='<div class="badge '+esc(cC)+'">'+esc(cT)+'</div><div class="kv" style="margin-top:8px">'+kv({connected:String(snap.chatBridge?.connected),mode:snap.chatBridge?.subscriptionMode,topics:snap.chatBridge?.subscribedTopics,requested:fmtTopicCounts(snap.chatBridge?.requestedTopicCounts),subscribed:fmtTopicCounts(snap.chatBridge?.subscribedTopicCounts),shell:shellCounts(snap.chatBridge?.lastShellSummary),ticketFailures:snap.chatBridge?.lastTicketFailureCount,lastError:snap.chatBridge?.lastError??'none'})+'</div>';
document.getElementById('ag').innerHTML='<div class="kv">'+kv({userId:snap.agent?.userId,handle:snap.agent?.handle,name:snap.agent?.name,openclawAgent:snap.agent?.openClawAgentName,openclawBinOk:String(snap.agent?.openClawBinaryOk),openclawBinSource:snap.agent?.openClawBinarySource,openclawBinVersion:snap.agent?.openClawBinaryVersion??'n/a',openclawBinError:snap.agent?.openClawBinaryError??'none',identityUpdated:fmt(snap.agent?.identityUpdatedAt)})+'</div>';
document.getElementById('mm').innerHTML='<div class="kv">'+kv({mood:snap.memory?.moodPrimary,moodScore:snap.memory?.moodScore,tier24h:snap.memory?.tier24hEvents,tier7d:snap.memory?.tier7dEvents,keywordDocs:snap.memory?.keywordIndexDocs,keywordTerms:snap.memory?.keywordIndexKeywords,longTermCapsules:snap.memory?.longTermArchiveCapsules,longTermLatest:fmt(snap.memory?.longTermArchiveLatestCompactedAt),longTermAgent:snap.memory?.longTermArchiveAgentCompressed,longTermAlgorithm:snap.memory?.longTermArchiveAlgorithmCompressed})+'</div>';
document.getElementById('rp').innerHTML='<div class="kv">'+kv({enabled:String(snap.retention?.enabled),intervalMin:snap.retention?.intervalMinutes,postsDays:snap.retention?.postsDays,interactionsDays:snap.retention?.interactionsDays,notificationsDays:snap.retention?.notificationsDays,longTermEnabled:String(snap.retention?.longTermEnabled),longTermMaxCapsules:snap.retention?.longTermMaxCapsules,longTermCompactionsPerRun:snap.retention?.longTermMaxCompactionsPerRun})+'</div>';
document.getElementById('ac').innerHTML='<div class="kv">'+kv({publishOk:snap.activity?.publishSuccess,publishFail:snap.activity?.publishFailed,directives:snap.activity?.directivesExecuted,messages:snap.activity?.chatMessagesReceived,autoReplies:snap.activity?.chatAutoRepliesSent})+'</div>';
const evts=Array.isArray(snap.activity?.recentEvents)?snap.activity.recentEvents:[];document.getElementById('events').innerHTML=evts.length?evts.map(e=>'<div class="evt"><strong>'+esc(e?.type)+'</strong><br/><span class="muted">'+esc(e?.detail??'-')+' · '+esc(fmt(e?.at))+'</span></div>').join(''):'<div class="muted">No recent events.</div>';
const files=snap.files&&typeof snap.files==='object'?snap.files:{};const pathRows=Object.entries(files);document.getElementById('paths').innerHTML=pathRows.length?pathRows.map(([k,v])=>'<div class="k">'+esc(k)+'</div><div><code>'+esc(v)+'</code></div>').join(''):'<div class="muted">No state paths available.</div>'};
const renderRetrieval=(payload)=>{
const meta=document.getElementById('rdmeta');
const box=document.getElementById('rd');
if(!payload||payload.ok!==true){meta.textContent='retrieval unavailable';box.innerHTML='';return;}
meta.textContent='intent '+esc(payload.intent)+' · hits '+esc(payload.hitCount)+' · docs '+esc(payload.totalDocs)+' · keywords '+esc(payload.totalKeywords);
const target=payload.target&&typeof payload.target==='object'?payload.target:{};
const presets=payload.presets&&typeof payload.presets==='object'?payload.presets:{};
const rows=[];
if(target.mainPost){
rows.push('<div class="evt"><strong>Main Post</strong><br/><span class="muted">'+esc(target.mainPost.summary)+' · '+esc(fmt(target.mainPost.receivedAt))+'</span></div>');
}
rows.push('<div class="evt"><strong>Thread</strong><br/><span class="muted">postId='+esc(target.postId??'n/a')+' · commentId='+esc(target.commentId??'n/a')+' · replies='+esc(target.replyCount??0)+' · repliesToAgent='+esc(target.repliesToAgentCount??0)+'</span></div>');
if(presets.mostRecentPost&&typeof presets.mostRecentPost==='object'){
rows.push('<div class="evt"><strong>Preset: Most Recent Post</strong><br/><span class="muted">postId='+esc(presets.mostRecentPost.postId)+' · '+esc(fmt(presets.mostRecentPost.receivedAt))+'</span><br/>'+esc(presets.mostRecentPost.summary??'')+'</div>');
}
if(presets.mostEngaged&&typeof presets.mostEngaged==='object'&&Array.isArray(presets.mostEngaged.posts)){
const cards=presets.mostEngaged.posts.slice(0,3).map(p=>'<div class="muted">post '+esc(p.postId)+' score='+esc(p.score)+' · c='+esc(p.comments)+' l='+esc(p.likes)+' r='+esc(p.reposts)+' v='+esc(p.views)+' · '+esc(fmt(p.lastAt))+'</div>');
rows.push('<div class="evt"><strong>Preset: Most Engaged</strong><br/><span class="muted">range='+esc(presets.mostEngaged.rangeLabel??'n/a')+'</span>'+(cards.join('')||'<div class="muted">none</div>')+'</div>');
}
if(presets.mostEngagedComments&&typeof presets.mostEngagedComments==='object'&&Array.isArray(presets.mostEngagedComments.comments)){
const cards=presets.mostEngagedComments.comments.slice(0,4).map(c=>'<div class="muted">comment '+esc(c.commentId)+' (post '+esc(c.postId??'n/a')+') score='+esc(c.score)+' · c='+esc(c.comments)+' l='+esc(c.likes)+' r='+esc(c.reposts)+' v='+esc(c.views)+' n='+esc(c.notifications)+' · '+esc(fmt(c.lastAt))+'</div>');
rows.push('<div class="evt"><strong>Preset: Most Engaged Comments</strong><br/><span class="muted">range='+esc(presets.mostEngagedComments.rangeLabel??'n/a')+'</span>'+(cards.join('')||'<div class="muted">none</div>')+'</div>');
}
if(presets.topParticipants&&typeof presets.topParticipants==='object'&&Array.isArray(presets.topParticipants.participants)){
const cards=presets.topParticipants.participants.slice(0,8).map(p=>'<div class="muted">'+esc(p.display??p.participant)+' · score='+esc(p.score)+' · presence='+esc(p.presence)+' · c='+esc(p.comments)+' l='+esc(p.likes)+' r='+esc(p.reposts)+' v='+esc(p.views)+' n='+esc(p.notifications)+' · '+esc(fmt(p.lastAt))+'</div>');
rows.push('<div class="evt"><strong>Preset: Top Participants</strong><br/><span class="muted">range='+esc(presets.topParticipants.rangeLabel??'n/a')+' · metric='+esc(presets.topParticipants.metric??'combined')+'</span>'+(cards.join('')||'<div class="muted">none</div>')+'</div>');
}
const renderPresetEvents=(label,key)=>{
const list=Array.isArray(presets[key])?presets[key]:[];
if(!list.length)return;
const body=list.slice(0,4).map(item=>'<div class="muted">'+esc(fmt(item.receivedAt))+' · post '+esc(item.postId??'n/a')+' · '+esc(item.summary??'')+'</div>').join('');
rows.push('<div class="evt"><strong>Preset: '+esc(label)+'</strong>'+body+'</div>');
};
renderPresetEvents('Last Comments','lastComments');
renderPresetEvents('Last Likes','lastLikes');
renderPresetEvents('Last Views','lastViews');
const hits=Array.isArray(payload.hits)?payload.hits:[];
const archiveHits=Array.isArray(payload.archiveHits)?payload.archiveHits:[];
if(archiveHits.length){
rows.push('<div class="evt"><strong>Archive Capsules</strong><br/><span class="muted">hits='+esc(payload.archiveHitCount??archiveHits.length)+'</span></div>');
for(const h of archiveHits.slice(0,8)){
rows.push('<div class="evt"><strong>archive '+esc(h.stream??'unknown')+'</strong> score='+esc(h.score)+'<br/><span class="muted">'+esc(h.summary??'')+' · '+esc(fmt(h.compactedAt))+' · events='+esc(h.eventCount??'n/a')+' · '+esc(h.compressedBy??'algorithm')+'</span></div>');
}
}
for(const h of hits.slice(0,20)){
rows.push('<div class="evt"><strong>'+esc(h.sourceType??'event')+'</strong> score='+esc(h.score)+'<br/><span class="muted">'+esc(h.summary??'')+' · '+esc(fmt(h.receivedAt))+'</span></div>');
}
box.innerHTML=rows.join('')||'<div class="muted">No retrieval hits.</div>';
};
const runRetrieval=async()=>{const q=(document.getElementById('rq').value??'').toString().trim();const post=(document.getElementById('rpost').value??'').toString().trim();const comment=(document.getElementById('rcomment').value??'').toString().trim();const intent=(document.getElementById('rintent').value??'chat').toString();const sp=new URLSearchParams();if(q)sp.set('q',q);if(post)sp.set('postId',post);if(comment)sp.set('commentId',comment);if(intent)sp.set('intent',intent);sp.set('limit','20');document.getElementById('rdmeta').textContent='running retrieval...';try{const r=await fetch('/api/health/retrieval?'+sp.toString(),{cache:'no-store'});renderRetrieval(await r.json())}catch(e){document.getElementById('rdmeta').textContent='retrieval failed: '+e}};
const tick=async()=>{try{const r=await fetch(healthUrl,{cache:'no-store'});render(await r.json())}catch(e){document.getElementById('ts').textContent='refresh failed: '+e}};
void tick();setInterval(tick,3000);
document.getElementById('rrun').addEventListener('click',()=>{void runRetrieval()});
</script></body></html>`;

const GRAPH_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Agent Memory Graphs</title>
<style>
:root{--bg:#f5f7fb;--card:#fff;--ink:#0f172a;--muted:#475569;--line:#dbe3ef;--accent:#2563eb;--accent2:#0f766e}
*{box-sizing:border-box}body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:linear-gradient(145deg,#eef3ff,#f8fafc);color:var(--ink)}
.wrap{max-width:1200px;margin:24px auto;padding:0 16px;display:grid;gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;box-shadow:0 8px 22px rgba(15,23,42,.06)}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.h1{font-size:22px;font-weight:700;margin:2px 0}.muted{color:var(--muted);font-size:13px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
input,select,button{font:inherit;border:1px solid var(--line);border-radius:8px;padding:8px;background:#fff;color:var(--ink)}
button{cursor:pointer}button:hover{background:#f1f5f9}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.bars{display:grid;gap:8px}
.bar{display:grid;grid-template-columns:140px 1fr auto;gap:8px;align-items:center}
.track{height:12px;background:#e2e8f0;border-radius:999px;overflow:hidden}
.fill{height:100%;background:linear-gradient(90deg,var(--accent),#60a5fa)}
.fill2{background:linear-gradient(90deg,var(--accent2),#2dd4bf)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 10px;font-size:13px}.k{color:var(--muted)}
a{color:#2563eb;text-decoration:none}
</style></head><body>
<div class="wrap">
<div class="card top"><div><div class="muted">Agent Host</div><div class="h1">Memory Engagement Graphs</div></div><div class="row"><a href="/" class="muted">Back to health</a><div class="muted" id="ts">loading...</div></div></div>
<div class="card">
<div class="row">
<select id="range"><option value="24h">24h</option><option value="7d">7d</option><option value="30d" selected>30d</option><option value="90d">90d</option><option value="365d">365d</option></select>
<select id="metric"><option value="combined">combined</option><option value="comments">comments</option><option value="likes">likes</option><option value="reposts">reposts</option><option value="views">views</option><option value="notifications">notifications</option><option value="presence">presence</option></select>
<input id="limit" type="number" min="3" max="20" value="10" style="width:90px"/>
<input id="postId" type="number" min="1" placeholder="postId (optional)" style="width:140px"/>
<input id="commentId" type="number" min="1" placeholder="commentId (optional)" style="width:160px"/>
<button id="run" type="button">Refresh</button>
</div>
<div class="muted" id="meta" style="margin-top:8px">ready</div>
</div>
<div class="grid">
<div class="card"><div class="muted">Totals</div><div id="totals" class="kv"></div></div>
<div class="card"><div class="muted">Top Participants</div><div id="top" class="bars"></div></div>
<div class="card"><div class="muted">Presence Leaders</div><div id="presence" class="bars"></div></div>
</div>
<div class="card"><div class="muted">Timeline (daily)</div><div id="timeline" class="bars"></div></div>
</div>
<script>
const esc=v=>String(v??'n/a').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const fmt=iso=>{if(!iso)return'n/a';const ms=Date.parse(iso);return Number.isFinite(ms)?new Date(ms).toLocaleString():'n/a'};
const kv=obj=>Object.entries(obj).map(([k,v])=>'<div class="k">'+esc(k)+'</div><div>'+esc(v??'n/a')+'</div>').join('');
const barRow=(label,value,max,useAlt)=>{const width=max>0?Math.max(2,Math.round((value/max)*100)):0;return '<div class="bar"><div>'+esc(label)+'</div><div class="track"><div class="fill'+(useAlt?' fill2':'')+'" style="width:'+width+'%"></div></div><div>'+esc(value)+'</div></div>'};
const render=(payload)=>{if(!payload||payload.ok!==true){document.getElementById('meta').textContent='data unavailable';return;}
document.getElementById('ts').textContent='updated '+fmt(payload.generatedAt);
const totals=payload.totals&&typeof payload.totals==='object'?payload.totals:{};
document.getElementById('totals').innerHTML=kv({range:payload.range?.label,metric:payload.metric,docsConsidered:payload.docsConsidered,totalEngagement:totals.totalEngagement,comments:totals.comments,likes:totals.likes,reposts:totals.reposts,views:totals.views,notifications:totals.notifications,presence:totals.presence,from:fmt(payload.range?.from),to:fmt(payload.range?.to)});
const tp=payload.topParticipants&&typeof payload.topParticipants==='object'?payload.topParticipants:null;
const topRows=Array.isArray(tp?.participants)?tp.participants:[];
const topMax=topRows.reduce((m,r)=>Math.max(m,Number(r.score)||0),0);
document.getElementById('top').innerHTML=topRows.length?topRows.map((row)=>barRow((row.display??row.participant??'unknown')+' ('+(row.lastAt?new Date(row.lastAt).toLocaleDateString():'n/a')+')',Number(row.score)||0,topMax,false)).join(''):'<div class="muted">No participant data.</div>';
const pp=Array.isArray(payload.topPresenceParticipants)?payload.topPresenceParticipants:[];
const ppMax=pp.reduce((m,r)=>Math.max(m,Number(r.presence)||0),0);
document.getElementById('presence').innerHTML=pp.length?pp.map((row)=>barRow(row.display??row.participant??'unknown',Number(row.presence)||0,ppMax,true)).join(''):'<div class="muted">No presence data.</div>';
const tl=Array.isArray(payload.timeline)?payload.timeline:[];
const tlRows=tl.slice(-20);
const tlMax=tlRows.reduce((m,row)=>Math.max(m,(Number(row.comments)||0)+(Number(row.likes)||0)+(Number(row.reposts)||0)+(Number(row.views)||0)+(Number(row.notifications)||0)),0);
document.getElementById('timeline').innerHTML=tlRows.length?tlRows.map((row)=>{const total=(Number(row.comments)||0)+(Number(row.likes)||0)+(Number(row.reposts)||0)+(Number(row.views)||0)+(Number(row.notifications)||0);return barRow(row.day+' · c'+(row.comments||0)+' l'+(row.likes||0)+' r'+(row.reposts||0)+' v'+(row.views||0)+' n'+(row.notifications||0),total,tlMax,false)}).join(''):'<div class="muted">No timeline data.</div>';
document.getElementById('meta').textContent='range '+esc(payload.range?.label)+' · metric '+esc(payload.metric)+' · participants '+esc(topRows.length);
};
const run=async()=>{const sp=new URLSearchParams();sp.set('range',String(document.getElementById('range').value||'30d'));sp.set('metric',String(document.getElementById('metric').value||'combined'));sp.set('limit',String(document.getElementById('limit').value||'10'));const postId=String(document.getElementById('postId').value||'').trim();const commentId=String(document.getElementById('commentId').value||'').trim();if(postId)sp.set('postId',postId);if(commentId)sp.set('commentId',commentId);document.getElementById('meta').textContent='loading...';try{const res=await fetch('/api/health/memory-engagement?'+sp.toString(),{cache:'no-store'});render(await res.json())}catch(err){document.getElementById('meta').textContent='failed: '+err}};
document.getElementById('run').addEventListener('click',()=>{void run()});
void run();
</script></body></html>`;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const json = (res: http.ServerResponse, code: number, value: unknown): void => {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
};

const readKthxConfig = async (
  stateDir: string,
): Promise<{
  configPath: string;
  configRaw: Record<string, unknown>;
  retention: RetentionPolicyView | null;
}> => {
  const configPath = resolveKthxConfigPath(stateDir);
  const configRaw = (await readJsonRecord(configPath)) ?? {};
  return {
    configPath,
    configRaw,
    retention: normalizeRetentionPolicy(configRaw),
  };
};

const applyRetentionPatchFromQuery = (
  configRaw: Record<string, unknown>,
  query: URLSearchParams,
): { changed: boolean; retention: RetentionPolicyView | null } => {
  const memory = ensureRecordField(configRaw, "memory");
  const retention = ensureRecordField(memory, "retention");
  const longTerm = ensureRecordField(retention, "longTerm");
  let changed = false;
  const assign = (
    target: Record<string, unknown>,
    key: string,
    value: unknown,
  ): void => {
    if (target[key] === value) return;
    target[key] = value;
    changed = true;
  };
  const assignDaysCategory = (category: string, days: number): void => {
    const categoryRecord = ensureRecordField(retention, category);
    if (categoryRecord.days !== days) {
      categoryRecord.days = days;
      changed = true;
    }
  };

  const enabled = parseBooleanQuery(query.get("enabled"));
  if (enabled !== null) assign(retention, "enabled", enabled);

  const intervalMinutes = parseBoundedIntQuery(
    query.get("intervalMinutes"),
    10,
    1440,
  );
  if (intervalMinutes !== null) assign(retention, "intervalMinutes", intervalMinutes);

  const allDays = parseBoundedIntQuery(query.get("days"), 1, 3650);
  if (allDays !== null) {
    for (const category of [
      "commands",
      "moods",
      "posts",
      "interactions",
      "notifications",
      "system",
    ]) {
      assignDaysCategory(category, allDays);
    }
  }

  const dayParams: Array<[string, string]> = [
    ["commandsDays", "commands"],
    ["moodsDays", "moods"],
    ["postsDays", "posts"],
    ["interactionsDays", "interactions"],
    ["notificationsDays", "notifications"],
    ["systemDays", "system"],
  ];
  for (const [queryKey, category] of dayParams) {
    const parsed = parseBoundedIntQuery(query.get(queryKey), 1, 3650);
    if (parsed === null) continue;
    assignDaysCategory(category, parsed);
  }

  const longTermEnabled = parseBooleanQuery(query.get("longTermEnabled"));
  if (longTermEnabled !== null) assign(longTerm, "enabled", longTermEnabled);
  const longTermUseAgentCompression = parseBooleanQuery(
    query.get("longTermUseAgentCompression"),
  );
  if (longTermUseAgentCompression !== null) {
    assign(longTerm, "useAgentCompression", longTermUseAgentCompression);
  }

  const longTermMaxCapsules = parseBoundedIntQuery(
    query.get("longTermMaxCapsules"),
    1000,
    2_000_000,
  );
  if (longTermMaxCapsules !== null) {
    assign(longTerm, "maxCapsules", longTermMaxCapsules);
  }
  const longTermMaxCompactionsPerRun = parseBoundedIntQuery(
    query.get("longTermMaxCompactionsPerRun"),
    1,
    100,
  );
  if (longTermMaxCompactionsPerRun !== null) {
    assign(longTerm, "maxCompactionsPerRun", longTermMaxCompactionsPerRun);
  }
  const longTermMaxEventsPerArchive = parseBoundedIntQuery(
    query.get("longTermMaxEventsPerArchive"),
    20,
    2000,
  );
  if (longTermMaxEventsPerArchive !== null) {
    assign(longTerm, "maxEventsPerArchive", longTermMaxEventsPerArchive);
  }
  const longTermMaxSnippetsPerArchive = parseBoundedIntQuery(
    query.get("longTermMaxSnippetsPerArchive"),
    1,
    24,
  );
  if (longTermMaxSnippetsPerArchive !== null) {
    assign(longTerm, "maxSnippetsPerArchive", longTermMaxSnippetsPerArchive);
  }

  return { changed, retention: normalizeRetentionPolicy(configRaw) };
};

const main = async (): Promise<void> => {
  await loadDotEnv();
  const db = getStateDb();

  const host = trimEnv("MG_AGENT_HEALTH_HOST") ?? "127.0.0.1";
  const port = Math.max(1, Math.min(65_535, parseIntEnv("MG_AGENT_HEALTH_PORT", 4278)));
  const privateKey = trimEnv("MG_AGENT_HEALTH_PRIVATE_KEY");

  const isLocalRequest = (req: http.IncomingMessage): boolean => {
    const remoteRaw = (req.socket?.remoteAddress ?? "").trim().toLowerCase();
    if (!remoteRaw) return false;
    if (remoteRaw === "127.0.0.1" || remoteRaw === "::1" || remoteRaw === "::ffff:127.0.0.1") {
      return true;
    }
    return remoteRaw.startsWith("127.") || remoteRaw.startsWith("::ffff:127.");
  };

  const hasPrivateAccess = (req: http.IncomingMessage): boolean => {
    if (isLocalRequest(req)) return true;
    if (!privateKey) return true;
    const fromHeader = (
      req.headers["x-agent-health-key"] ??
      req.headers["x-health-key"] ??
      ""
    )
      .toString()
      .trim();
    return fromHeader === privateKey;
  };

  const handleRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    if ((req.method ?? "GET").toUpperCase() !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    if (url.pathname === "/api/health") {
      try {
        const fresh = await buildSnapshot();
        json(res, 200, buildPublicProjection(fresh));
        return;
      } catch {
        const fromDb = db.getSnapshot<Record<string, unknown>>("health.public.v1");
        if (fromDb && isRecord(fromDb)) {
          json(res, 200, fromDb);
          return;
        }
      }
      json(res, 500, { ok: false, error: "health_unavailable" });
      return;
    }
    if (url.pathname === "/api/health/private") {
      if (!hasPrivateAccess(req)) {
        json(res, 403, {
          ok: false,
          error: "forbidden",
          message: "Missing or invalid health private key.",
        });
        return;
      }
      try {
        json(res, 200, await buildSnapshot());
        return;
      } catch {
        const fromDb = db.getSnapshot<Record<string, unknown>>("health.private.v1");
        if (fromDb && isRecord(fromDb)) {
          json(res, 200, fromDb);
          return;
        }
      }
      json(res, 500, { ok: false, error: "health_unavailable" });
      return;
    }
    if (url.pathname === "/api/health/retrieval") {
      if (!hasPrivateAccess(req)) {
        json(res, 403, {
          ok: false,
          error: "forbidden",
          message: "Missing or invalid health private key.",
        });
        return;
      }
      try {
        const snapshot = await buildSnapshot();
        const files = isRecord(snapshot.files)
          ? snapshot.files
          : {};
        const agentRecord = isRecord(snapshot.agent) ? snapshot.agent : null;
        const keywordPath =
          str(files.keywordIndex) ??
          path.join(resolveStateDir(), "memory", "context", "keyword-index.json");
        const longTermArchivePath =
          str(files.longTermArchiveIndex) ??
          path.join(
            resolveStateDir(),
            "memory",
            "context",
            "long-term-archive-index.json",
          );
        const keywordIndex = normalizeKeywordIndex(
          await readJsonRecord(keywordPath),
        );
        const longTermIndex = normalizeLongTermArchiveIndex(
          await readJsonRecord(longTermArchivePath),
        );
        const intent = parseRetrievalIntent(url.searchParams.get("intent"));
        const diagnostics = buildRetrievalDiagnostics({
          index: keywordIndex,
          longTermIndex,
          query: (url.searchParams.get("q") ?? "").trim(),
          intent,
          postId: intFromUnknown(url.searchParams.get("postId")),
          commentId: intFromUnknown(url.searchParams.get("commentId")),
          limit: intFromUnknown(url.searchParams.get("limit")) ?? 12,
          agentHandle: str(agentRecord?.handle),
          agentName: str(agentRecord?.name),
        });
        json(res, 200, {
          ok: true,
          generatedAt: new Date().toISOString(),
          stateDir: resolveStateDir(),
          keywordIndexPath: keywordPath,
          longTermArchiveIndexPath: longTermArchivePath,
          keywordIndexUpdatedAt: keywordIndex.updatedAt,
          ...diagnostics,
        });
        return;
      } catch (error: unknown) {
        json(res, 500, {
          ok: false,
          error: "retrieval_debug_unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    if (url.pathname === "/api/health/memory-engagement") {
      if (!hasPrivateAccess(req)) {
        json(res, 403, {
          ok: false,
          error: "forbidden",
          message: "Missing or invalid health private key.",
        });
        return;
      }
      try {
        const snapshot = await buildSnapshot();
        const files = isRecord(snapshot.files) ? snapshot.files : {};
        const keywordPath =
          str(files.keywordIndex) ??
          path.join(resolveStateDir(), "memory", "context", "keyword-index.json");
        const keywordIndex = normalizeKeywordIndex(
          await readJsonRecord(keywordPath),
        );
        const diagnostics = buildMemoryEngagementDiagnostics({
          index: keywordIndex,
          rangeMs: resolveRangeMsFromQuery(url.searchParams),
          metric: parseTopParticipantMetric(url.searchParams.get("metric")),
          limit: intFromUnknown(url.searchParams.get("limit")) ?? 10,
          postId: intFromUnknown(url.searchParams.get("postId")),
          commentId: intFromUnknown(url.searchParams.get("commentId")),
          intent: parseRetrievalIntent(url.searchParams.get("intent")),
        });
        json(res, 200, {
          ok: true,
          generatedAt: new Date().toISOString(),
          stateDir: resolveStateDir(),
          keywordIndexPath: keywordPath,
          keywordIndexUpdatedAt: keywordIndex.updatedAt,
          ...diagnostics,
        });
        return;
      } catch (error: unknown) {
        json(res, 500, {
          ok: false,
          error: "memory_engagement_unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    if (url.pathname === "/api/health/directive-lifecycle") {
      if (!hasPrivateAccess(req)) {
        json(res, 403, {
          ok: false,
          error: "forbidden",
          message: "Missing or invalid health private key.",
        });
        return;
      }
      try {
        const limitRaw = url.searchParams.get("limit");
        const limitParsed =
          typeof limitRaw === "string" ? Number.parseInt(limitRaw, 10) : Number.NaN;
        const limit =
          Number.isFinite(limitParsed) && limitParsed > 0
            ? Math.max(1, Math.min(200, Math.floor(limitParsed)))
            : 50;
        const rows = db.getRecentCommandLifecycle(limit);
        json(res, 200, {
          ok: true,
          generatedAt: new Date().toISOString(),
          count: rows.length,
          rows,
        });
        return;
      } catch (error: unknown) {
        json(res, 500, {
          ok: false,
          error: "directive_lifecycle_unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    if (url.pathname === "/api/health/retention") {
      if (!hasPrivateAccess(req)) {
        json(res, 403, {
          ok: false,
          error: "forbidden",
          message: "Missing or invalid health private key.",
        });
        return;
      }
      try {
        const stateDir = resolveStateDir();
        const { configPath, configRaw, retention } = await readKthxConfig(stateDir);
        const wantsSet = url.searchParams.has("set");
        if (wantsSet) {
          const patched = applyRetentionPatchFromQuery(configRaw, url.searchParams);
          if (patched.changed) {
            await fs.writeFile(
              configPath,
              `${JSON.stringify(configRaw, null, 2)}\n`,
              "utf8",
            );
          }
          json(res, 200, {
            ok: true,
            updated: patched.changed,
            configPath,
            retention: patched.retention,
          });
          return;
        }
        json(res, 200, {
          ok: true,
          configPath,
          retention,
        });
        return;
      } catch (error: unknown) {
        json(res, 500, {
          ok: false,
          error: "retention_unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    if (url.pathname === "/graphs") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(GRAPH_PAGE);
      return;
    }
    if (url.pathname !== "/") { res.statusCode = 404; res.end("Not Found"); return; }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(HTML_PAGE);
  };
  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  server.listen(port, host, () => {
    process.stdout.write(`[agent-health-web] listening on http://${host}:${port}\n`);
    process.stdout.write(`[agent-health-web] stateDir=${resolveStateDir()}\n`);
  });

  const shutdown = (): void => {
    db.close();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

void main();
