/** MemoryStore -- central persistence layer. Ported from agent-runtime.mjs lines 1658-2755. */

import fs from "node:fs/promises";
import path from "node:path";
import type {
  MemoryStoreConfig,
  MemoryEnvelope,
  StreamName,
  ArchiveIndex,
  StreamPathMap,
  ViewState,
  MoodState,
  TemporalContext,
  TierSummary,
  ContextRequest,
  ContextBundle,
  MemoryActivity,
  RetentionCleanupResult,
  RefreshTemporalOptions,
  AgentCompressionRequest,
  RetrievalIntent,
  RetrievalLookupPlan,
  LongTermArchiveCapsule,
  LongTermArchiveIndex,
  ArchiveCompressFn,
} from "~/types/memory.js";
import type { KthxRetentionConfig } from "~/types/config.js";
import type { StateSqliteStore } from "~/state/sqlite-state.js";
import { isRecord } from "~/lib/guards.js";
import { ensureDir, readJsonFile, writeJsonFile, appendJsonLine, readLastJsonLines } from "~/lib/fs-helpers.js";
import { normalizeIso, unique } from "~/lib/time.js";
import { nowIso, toShortLine } from "~/lib/text.js";
import {
  extractKeysFromPayload,
  extractActorHintFromPayload,
  extractTextHintFromPayload,
  extractParticipantsFromPayload,
  parseMemoryEnvelope,
} from "./extract.js";
import { archiveJsonl, createArchiveBasename, listArchiveIndexes, findArchiveGzPath, readEventsFromGzArchive, pickWeightedArchiveBasenames } from "./archive.js";
import { defaultMoodState, computeMoodDelta, applyMoodSignal } from "./mood.js";
import { defaultTemporalContext, uniqueEventsBySignature, summarizeEventsForTier, summarizeTargetFocus, eventSignature } from "./temporal.js";
import { renderContextPrompt } from "./render.js";
import { runRetentionCleanup } from "./retention.js";
import { buildRetrievalPresets } from "./retrieval-presets.js";

const safeTextMemory = (value: unknown): string | null => {
  if (!isRecord(value)) return null;
  return typeof value.content === "string" ? value.content : null;
};

const VIEW_STATE_MAX_ITEMS = 12_000;
const VIEW_STATE_PRUNE_TARGET = 9_000;
const VIEW_STATE_PRUNE_CHECK_INTERVAL = 64;

const asFinitePositiveInt = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
};

const asNullableString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseViewEntityKey = (
  key: string,
): { postId: number | null; commentId: number | null } => {
  const trimmed = key.trim();
  if (!trimmed.length) return { postId: null, commentId: null };
  const match = /^(post|comment):(\d+)$/u.exec(trimmed);
  if (match) {
    const id = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isFinite(id) || id <= 0) return { postId: null, commentId: null };
    if ((match[1] ?? "") === "comment") return { postId: null, commentId: id };
    return { postId: id, commentId: null };
  }
  const legacyId = asFinitePositiveInt(trimmed);
  if (legacyId) return { postId: legacyId, commentId: null };
  return { postId: null, commentId: null };
};

const toViewStateItem = (input: {
  key: string;
  raw: unknown;
  fallbackAt: string;
}): ViewState["items"][string] => {
  const { postId: keyPostId, commentId: keyCommentId } = parseViewEntityKey(input.key);
  const raw = isRecord(input.raw) ? input.raw : {};
  const rawStatus = asNullableString(raw.status);
  const status = rawStatus === "unviewed" ? "unviewed" : "viewed";
  const receivedAt = normalizeIso(asNullableString(raw.receivedAt) ?? input.fallbackAt);
  const firstSeenAt = normalizeIso(asNullableString(raw.firstSeenAt) ?? receivedAt);
  const lastSeenAt = normalizeIso(asNullableString(raw.lastSeenAt) ?? receivedAt);
  const seenCountRaw = asFinitePositiveInt(raw.seenCount);
  const seenCount = seenCountRaw ?? (status === "viewed" ? 1 : 0);
  const postId = asFinitePositiveInt(raw.postId) ?? keyPostId;
  const commentId = asFinitePositiveInt(raw.commentId) ?? keyCommentId;
  const sourceType = asNullableString(raw.sourceType);
  const lastTopic = asNullableString(raw.lastTopic);
  return {
    status,
    receivedAt,
    firstSeenAt,
    lastSeenAt,
    seenCount,
    postId: postId ?? null,
    commentId: commentId ?? null,
    sourceType,
    lastTopic,
  };
};

const normalizeViewState = (value: unknown): ViewState => {
  const fallback = nowIso();
  if (!isRecord(value)) {
    return { version: 1, updatedAt: fallback, items: {} };
  }
  const rawItems = isRecord(value.items) ? value.items : {};
  const normalizedItems: Record<string, ViewState["items"][string]> = {};
  for (const [rawKey, rawItem] of Object.entries(rawItems)) {
    const key = rawKey.trim();
    if (!key.length) continue;
    const entity = parseViewEntityKey(key);
    const normalizedKey =
      entity.commentId !== null
        ? `comment:${entity.commentId}`
        : entity.postId !== null
          ? `post:${entity.postId}`
          : key;
    normalizedItems[normalizedKey] = toViewStateItem({
      key: normalizedKey,
      raw: rawItem,
      fallbackAt: fallback,
    });
  }
  const updatedAt = normalizeIso(asNullableString(value.updatedAt) ?? fallback);
  return {
    version: 1,
    updatedAt,
    items: normalizedItems,
  };
};

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
  lookupPlans: RetrievalLookupPlan[];
};

type KeywordMemoryIndex = {
  version: 1;
  updatedAt: string;
  docs: Record<string, KeywordIndexDoc>;
  inverted: Record<string, string[]>;
};

const KEYWORD_INDEX_MAX_DOCS = 18_000;
const KEYWORD_INDEX_PRUNE_TARGET = 14_000;
const KEYWORD_INDEX_PRUNE_CHECK_INTERVAL = 64;
const KEYWORD_INDEX_MAX_DOCS_PER_KEYWORD = 300;
const KEYWORD_INDEX_INTERNAL_SKIP_PATTERN =
  /\b(openclaw|directive_queue|challenge|mint|heartbeat|agent_runtime|chat_runtime|bridge)\b/iu;
const KEYWORD_STOPWORDS = new Set([
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

const RETRIEVAL_SOURCE_WEIGHT_BY_INTENT: Record<
  RetrievalIntent,
  Record<string, number>
> = {
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

const LONG_TERM_RETENTION_SOURCE_WEIGHT: Record<RetrievalIntent, number> = {
  chat: 1.2,
  directive: 1.5,
  engagement: 1.3,
};

const resolveRetrievalIntent = (request: ContextRequest): RetrievalIntent => {
  if (
    request.retrievalIntent === "chat" ||
    request.retrievalIntent === "directive" ||
    request.retrievalIntent === "engagement"
  ) {
    return request.retrievalIntent;
  }
  return "chat";
};

const tokenizeKeywordText = (value: string): string[] => {
  const lowered = value.toLowerCase();
  const tokens = lowered.split(/[^a-z0-9_]+/u);
  const uniqueTokens = new Set<string>();
  for (const token of tokens) {
    const trimmed = token.trim();
    if (trimmed.length < 3) continue;
    if (KEYWORD_STOPWORDS.has(trimmed)) continue;
    uniqueTokens.add(trimmed);
  }
  return [...uniqueTokens];
};

const normalizeLookupPlanArgs = (
  value: unknown,
): RetrievalLookupPlan["args"] => {
  if (!isRecord(value)) return {};
  const normalized: RetrievalLookupPlan["args"] = {};
  const entries = Object.entries(value).slice(0, 16);
  for (const [keyRaw, entryValue] of entries) {
    const key = keyRaw.trim();
    if (!key.length) continue;
    if (typeof entryValue === "string") {
      const trimmed = entryValue.trim();
      if (!trimmed.length) continue;
      normalized[key] = trimmed;
      continue;
    }
    if (typeof entryValue === "number" && Number.isFinite(entryValue)) {
      normalized[key] = entryValue;
      continue;
    }
    if (typeof entryValue === "boolean") {
      normalized[key] = entryValue;
      continue;
    }
    if (entryValue === null) {
      normalized[key] = null;
    }
  }
  return normalized;
};

const normalizeLookupPlans = (value: unknown): RetrievalLookupPlan[] => {
  if (!Array.isArray(value)) return [];
  const plans: RetrievalLookupPlan[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, 12)) {
    if (!isRecord(entry)) continue;
    const action = asNullableString(entry.action);
    const reason = asNullableString(entry.reason);
    if (!action || !reason) continue;
    const args = normalizeLookupPlanArgs(entry.args);
    const fingerprint = JSON.stringify([action, reason, Object.entries(args)]);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    plans.push({ action, reason, args });
  }
  return plans;
};

const buildDefaultLookupPlansForDoc = (input: {
  sourceType: string | null;
  postId: number | null;
  commentId: number | null;
  actor: string | null;
}): RetrievalLookupPlan[] => {
  const plans: RetrievalLookupPlan[] = [];
  const seen = new Set<string>();
  const pushPlan = (plan: RetrievalLookupPlan): void => {
    const fingerprint = JSON.stringify([
      plan.action,
      plan.reason,
      Object.entries(plan.args).sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
      ),
    ]);
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    plans.push(plan);
  };

  if (typeof input.postId === "number" && input.postId > 0) {
    pushPlan({
      action: "find_post",
      reason: "hydrate_post_context",
      args: { postId: input.postId },
    });
  }
  if (typeof input.commentId === "number" && input.commentId > 0) {
    const args: RetrievalLookupPlan["args"] = { commentId: input.commentId };
    if (typeof input.postId === "number" && input.postId > 0) {
      args.postId = input.postId;
    }
    pushPlan({
      action: "find_comment",
      reason: "hydrate_comment_context",
      args,
    });
  }
  if (input.sourceType === "notification_created") {
    pushPlan({
      action: "browse_notifications",
      reason: "refresh_notification_context",
      args: { unreadOnly: true, limit: 24 },
    });
  }
  const actor = input.actor?.trim();
  if (actor?.startsWith("@")) {
    pushPlan({
      action: "find_user",
      reason: "resolve_actor_profile",
      args: { handle: actor },
    });
  }

  return plans.slice(0, 8);
};

const normalizeKeywordDoc = (
  id: string,
  value: unknown,
): KeywordIndexDoc | null => {
  if (!isRecord(value)) return null;
  const summary = asNullableString(value.summary);
  if (!summary) return null;
  const keywordsRaw = Array.isArray(value.keywords) ? value.keywords : [];
  const keywords = unique(
    keywordsRaw
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length >= 3),
  ).slice(0, 24);
  if (keywords.length === 0) return null;
  const sourceType = asNullableString(value.sourceType);
  const postId = asFinitePositiveInt(value.postId) ?? null;
  const commentId = asFinitePositiveInt(value.commentId) ?? null;
  const actor = asNullableString(value.actor);
  const lookupPlansRaw = normalizeLookupPlans(value.lookupPlans);
  const lookupPlans =
    lookupPlansRaw.length > 0
      ? lookupPlansRaw
      : buildDefaultLookupPlansForDoc({
          sourceType,
          postId,
          commentId,
          actor,
        });
  return {
    id,
    receivedAt: normalizeIso(asNullableString(value.receivedAt) ?? nowIso()),
    sourceType,
    topic: asNullableString(value.topic),
    postId,
    commentId,
    actor,
    participants: Array.isArray(value.participants)
      ? unique(
          value.participants
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
        ).slice(0, 16)
      : [],
    summary: toShortLine(summary, 220),
    keywords,
    lookupPlans,
  };
};

const normalizeKeywordIndex = (value: unknown): KeywordMemoryIndex => {
  const fallbackAt = nowIso();
  if (!isRecord(value)) {
    return { version: 1, updatedAt: fallbackAt, docs: {}, inverted: {} };
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
    const docIds = inverted[keyword] ?? [];
    const sortedDocIds = docIds
      .filter((docId) => Boolean(docs[docId]))
      .sort((a, b) => {
        const aAt = docs[a]?.receivedAt ?? "";
        const bAt = docs[b]?.receivedAt ?? "";
        return aAt < bAt ? 1 : aAt > bAt ? -1 : 0;
      })
      .slice(0, KEYWORD_INDEX_MAX_DOCS_PER_KEYWORD);
    inverted[keyword] = unique(sortedDocIds);
  }
  return {
    version: 1,
    updatedAt: normalizeIso(asNullableString(value.updatedAt) ?? fallbackAt),
    docs,
    inverted,
  };
};

const normalizeTypeCounts = (value: unknown): Array<{ type: string; count: number }> => {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (!isRecord(entry)) return null;
        const type = asNullableString(entry.type);
        const countRaw = asFinitePositiveInt(entry.count);
        if (!type || !countRaw) return null;
        return { type, count: countRaw };
      })
      .filter((entry): entry is { type: string; count: number } => entry !== null)
      .slice(0, 24);
  }
  if (isRecord(value)) {
    return Object.entries(value)
      .map(([type, countValue]) => {
        const count = asFinitePositiveInt(countValue);
        if (!count) return null;
        return { type: type.trim(), count };
      })
      .filter((entry): entry is { type: string; count: number } => entry !== null)
      .sort((a, b) => b.count - a.count)
      .slice(0, 24);
  }
  return [];
};

const normalizeLongTermArchiveCapsule = (
  value: unknown,
): LongTermArchiveCapsule | null => {
  if (!isRecord(value)) return null;
  const stream = asNullableString(value.stream);
  const archiveBasename = asNullableString(value.archiveBasename);
  const compactedAt = asNullableString(value.compactedAt);
  const summary = asNullableString(value.summary);
  if (!stream || !archiveBasename || !compactedAt || !summary) return null;
  const id = asNullableString(value.id) ?? `${stream}:${archiveBasename}`;
  const eventCount = asFinitePositiveInt(value.eventCount) ?? 0;
  const postIds = Array.isArray(value.postIds)
    ? unique(
        value.postIds
          .map((entry) => asFinitePositiveInt(entry))
          .filter((entry): entry is number => typeof entry === "number"),
      ).slice(0, 200)
    : [];
  const commentIds = Array.isArray(value.commentIds)
    ? unique(
        value.commentIds
          .map((entry) => asFinitePositiveInt(entry))
          .filter((entry): entry is number => typeof entry === "number"),
      ).slice(0, 400)
    : [];
  const snippets = Array.isArray(value.snippets)
    ? unique(
        value.snippets
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => toShortLine(entry, 240))
          .filter((entry) => entry.length > 0),
      ).slice(0, 16)
    : [];
  const keywords = Array.isArray(value.keywords)
    ? unique(
        value.keywords
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry.length >= 3),
      ).slice(0, 64)
    : tokenizeKeywordText(
        [summary, ...snippets, ...postIds.map((idValue) => `post${idValue}`)].join(
          " ",
        ),
      ).slice(0, 64);
  const compressedByRaw = asNullableString(value.compressedBy);
  const compressedBy =
    compressedByRaw === "agent" ? "agent" : "algorithm";
  return {
    id,
    stream,
    archiveBasename,
    compactedAt: normalizeIso(compactedAt),
    receivedAtMin: asNullableString(value.receivedAtMin),
    receivedAtMax: asNullableString(value.receivedAtMax),
    eventCount,
    postIds,
    commentIds,
    topTypes: normalizeTypeCounts(value.topTypes),
    summary: toShortLine(summary, 320),
    snippets,
    keywords,
    compressedBy,
  };
};

const normalizeLongTermArchiveIndex = (value: unknown): LongTermArchiveIndex => {
  const fallbackUpdatedAt = nowIso();
  if (!isRecord(value)) {
    return { version: 1, updatedAt: fallbackUpdatedAt, items: [] };
  }
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const items = rawItems
    .map((entry) => normalizeLongTermArchiveCapsule(entry))
    .filter((entry): entry is LongTermArchiveCapsule => entry !== null)
    .sort((a, b) =>
      a.compactedAt < b.compactedAt
        ? 1
        : a.compactedAt > b.compactedAt
          ? -1
          : 0,
    );
  return {
    version: 1,
    updatedAt: normalizeIso(asNullableString(value.updatedAt) ?? fallbackUpdatedAt),
    items,
  };
};

const buildRetentionStreamDaysMap = (
  retentionConfig: KthxRetentionConfig,
): Record<StreamName, number> => ({
  notifications: retentionConfig.notifications?.days ?? 365,
  feed: retentionConfig.posts?.days ?? 365,
  activity: retentionConfig.interactions?.days ?? 365,
  likes: retentionConfig.interactions?.days ?? 365,
  reposts: retentionConfig.interactions?.days ?? 365,
  comments: retentionConfig.interactions?.days ?? 365,
  views: retentionConfig.interactions?.days ?? 365,
  writes: Math.max(
    retentionConfig.commands?.days ?? 365,
    retentionConfig.system?.days ?? 365,
  ),
  errors: retentionConfig.system?.days ?? 365,
  director: retentionConfig.system?.days ?? 365,
  memory_activity: retentionConfig.system?.days ?? 365,
  tags: retentionConfig.posts?.days ?? 365,
  story_replies: retentionConfig.interactions?.days ?? 365,
});

const parseArchiveCompressionResult = (value: unknown): {
  summary: string | null;
  snippets: string[];
} => {
  if (!isRecord(value)) {
    return { summary: null, snippets: [] };
  }
  const candidates = [
    value,
    isRecord(value.parsed) ? value.parsed : null,
    isRecord(value.payload) ? value.payload : null,
    isRecord(value.envelope) && isRecord(value.envelope.payload)
      ? value.envelope.payload
      : null,
  ].filter((entry): entry is Record<string, unknown> => entry !== null);

  for (const candidate of candidates) {
    const summary = asNullableString(candidate.summary);
    const snippetsRaw = Array.isArray(candidate.snippets)
      ? candidate.snippets
      : Array.isArray(candidate.bullets)
        ? candidate.bullets
        : [];
    const snippets = snippetsRaw
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => toShortLine(entry, 220))
      .filter((entry) => entry.length > 0)
      .slice(0, 12);
    if (summary || snippets.length > 0) {
      return {
        summary: summary ? toShortLine(summary, 320) : null,
        snippets,
      };
    }
  }

  return { summary: null, snippets: [] };
};

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export class MemoryStore {
  readonly stateDir: string;
  readonly rotateBytes: number;
  readonly tailMaxBytes: number;
  readonly tailMaxLines: number;
  readonly streamPaths: StreamPathMap;
  readonly stateDb: StateSqliteStore | null;

  private readonly viewStatePath: string;
  private viewState: ViewState;
  private viewStateDirty: boolean;
  private viewStateWriteTimer: ReturnType<typeof setTimeout> | null;
  private viewStateMutationCount: number;
  private readonly keywordIndexPath: string;
  private keywordIndex: KeywordMemoryIndex;
  private keywordIndexDirty: boolean;
  private keywordIndexWriteTimer: ReturnType<typeof setTimeout> | null;
  private keywordIndexMutationCount: number;
  private readonly longTermArchiveIndexPath: string;
  private longTermArchiveIndex: LongTermArchiveIndex;
  private longTermArchiveDirty: boolean;
  private longTermArchiveWriteTimer: ReturnType<typeof setTimeout> | null;

  private readonly memoryDir: string;
  private readonly memoryContextDir: string;
  private readonly moodStatePath: string;
  private readonly temporalContextPath: string;
  private readonly temporalTierPaths: Record<string, string>;

  moodState: MoodState;
  private moodDirty: boolean;
  private moodWriteTimer: ReturnType<typeof setTimeout> | null;

  temporalContext: TemporalContext;
  private temporalDirty: boolean;
  private temporalWriteTimer: ReturnType<typeof setTimeout> | null;
  private temporalRefreshInFlight: Promise<TemporalContext> | null;
  private lastContextReadAtMs: number;

  constructor(config: MemoryStoreConfig) {
    this.stateDir = config.stateDir;
    this.rotateBytes = config.rotateBytes;
    this.tailMaxBytes = config.tailMaxBytes;
    this.tailMaxLines = config.tailMaxLines;
    this.stateDb = config.stateDb ?? null;

    this.streamPaths = {
      director: path.join(this.stateDir, "director.jsonl"),
      notifications: path.join(this.stateDir, "notifications.jsonl"),
      feed: path.join(this.stateDir, "feed.jsonl"),
      activity: path.join(this.stateDir, "activity.jsonl"),
      memory_activity: path.join(this.stateDir, "memory-activity.jsonl"),
      likes: path.join(this.stateDir, "likes.jsonl"),
      reposts: path.join(this.stateDir, "reposts.jsonl"),
      comments: path.join(this.stateDir, "comments.jsonl"),
      views: path.join(this.stateDir, "views.jsonl"),
      tags: path.join(this.stateDir, "tags.jsonl"),
      story_replies: path.join(this.stateDir, "story_replies.jsonl"),
      writes: path.join(this.stateDir, "writes.jsonl"),
      errors: path.join(this.stateDir, "errors.jsonl"),
    };

    this.viewStatePath = path.join(this.stateDir, "view-state.json");
    this.viewState = { version: 1, updatedAt: new Date(0).toISOString(), items: {} };
    this.viewStateDirty = false;
    this.viewStateWriteTimer = null;
    this.viewStateMutationCount = 0;

    this.memoryDir = path.join(this.stateDir, "memory");
    this.memoryContextDir = path.join(this.memoryDir, "context");
    this.moodStatePath = path.join(this.memoryDir, "mood.json");
    this.temporalContextPath = path.join(this.memoryContextDir, "temporal.json");
    this.keywordIndexPath = path.join(this.memoryContextDir, "keyword-index.json");
    this.longTermArchiveIndexPath = path.join(
      this.memoryContextDir,
      "long-term-archive-index.json",
    );
    this.temporalTierPaths = {
      "24h": path.join(this.memoryContextDir, "24h.json"),
      "7d": path.join(this.memoryContextDir, "7d.json"),
      "30d": path.join(this.memoryContextDir, "30d.json"),
      "365d": path.join(this.memoryContextDir, "365d.json"),
    };
    this.keywordIndex = { version: 1, updatedAt: new Date(0).toISOString(), docs: {}, inverted: {} };
    this.keywordIndexDirty = false;
    this.keywordIndexWriteTimer = null;
    this.keywordIndexMutationCount = 0;
    this.longTermArchiveIndex = {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      items: [],
    };
    this.longTermArchiveDirty = false;
    this.longTermArchiveWriteTimer = null;

    this.moodState = defaultMoodState();
    this.moodDirty = false;
    this.moodWriteTimer = null;
    this.temporalContext = defaultTemporalContext();
    this.temporalDirty = false;
    this.temporalWriteTimer = null;
    this.temporalRefreshInFlight = null;
    this.lastContextReadAtMs = 0;
  }

  // ---- init ---------------------------------------------------------------

  async init(): Promise<void> {
    this.stateDb?.init();
    await ensureDir(this.stateDir);
    await ensureDir(this.memoryDir);
    await ensureDir(this.memoryContextDir);

    const existing = await readJsonFile(this.viewStatePath);
    this.viewState = normalizeViewState(existing);
    const keywordExisting = await readJsonFile(this.keywordIndexPath);
    this.keywordIndex = normalizeKeywordIndex(keywordExisting);
    const longTermExisting = await readJsonFile(this.longTermArchiveIndexPath);
    this.longTermArchiveIndex = normalizeLongTermArchiveIndex(longTermExisting);
    const moodExisting = await readJsonFile(this.moodStatePath);
    if (isRecord(moodExisting) && moodExisting.version === 1) {
      this.moodState = { ...defaultMoodState(), ...(moodExisting as MoodState) };
    }
    const temporalExisting = await readJsonFile(this.temporalContextPath);
    if (isRecord(temporalExisting) && temporalExisting.version === 1 && isRecord(temporalExisting.tiers)) {
      this.temporalContext = {
        ...defaultTemporalContext(),
        ...(temporalExisting as TemporalContext),
        tiers: { ...defaultTemporalContext().tiers, ...((temporalExisting as TemporalContext).tiers ?? {}) },
      };
    }

    await Promise.all(
      Object.values(this.streamPaths).map(async (filePath) => {
        await ensureDir(path.dirname(filePath));
        await fs.access(filePath).catch(async () => { await fs.writeFile(filePath, "", "utf8"); });
      }),
    );
    await fs.access(this.moodStatePath).catch(async () => { await writeJsonFile(this.moodStatePath, this.moodState); });
    await fs.access(this.temporalContextPath).catch(async () => { await writeJsonFile(this.temporalContextPath, this.temporalContext); });
    await fs.access(this.keywordIndexPath).catch(async () => { await writeJsonFile(this.keywordIndexPath, this.keywordIndex); });
    await fs
      .access(this.longTermArchiveIndexPath)
      .catch(async () => {
        await writeJsonFile(
          this.longTermArchiveIndexPath,
          this.longTermArchiveIndex,
        );
      });
    await Promise.all(
      Object.entries(this.temporalTierPaths).map(async ([tier, filePath]) => {
        await fs.access(filePath).catch(async () => {
          await writeJsonFile(filePath, { version: 1, tier, updatedAt: new Date(0).toISOString(), bullets: [] });
        });
      }),
    );
  }

  // ---- flush helpers ------------------------------------------------------

  private scheduleViewStateWrite(): void {
    if (this.viewStateWriteTimer) return;
    this.viewStateWriteTimer = setTimeout(() => {
      this.viewStateWriteTimer = null;
      void this.flushViewState().catch(() => undefined);
    }, 250);
  }

  async flushViewState(): Promise<void> {
    if (!this.viewStateDirty) return;
    this.viewState.updatedAt = nowIso();
    await writeJsonFile(this.viewStatePath, this.viewState);
    this.stateDb?.upsertSnapshot({
      scope: "memory.view_state",
      visibility: "private",
      at: this.viewState.updatedAt,
      data: this.viewState,
    });
    this.viewStateDirty = false;
  }

  private scheduleKeywordIndexWrite(): void {
    if (this.keywordIndexWriteTimer) return;
    this.keywordIndexWriteTimer = setTimeout(() => {
      this.keywordIndexWriteTimer = null;
      void this.flushKeywordIndex().catch(() => undefined);
    }, 400);
  }

  async flushKeywordIndex(): Promise<void> {
    if (!this.keywordIndexDirty) return;
    this.keywordIndex.updatedAt = nowIso();
    await writeJsonFile(this.keywordIndexPath, this.keywordIndex);
    this.stateDb?.upsertSnapshot({
      scope: "memory.keyword_index",
      visibility: "private",
      at: this.keywordIndex.updatedAt,
      data: {
        version: 1,
        updatedAt: this.keywordIndex.updatedAt,
        docs: Object.keys(this.keywordIndex.docs).length,
        keywords: Object.keys(this.keywordIndex.inverted).length,
      },
    });
    this.keywordIndexDirty = false;
  }

  private scheduleLongTermArchiveWrite(): void {
    if (this.longTermArchiveWriteTimer) return;
    this.longTermArchiveWriteTimer = setTimeout(() => {
      this.longTermArchiveWriteTimer = null;
      void this.flushLongTermArchiveIndex().catch(() => undefined);
    }, 600);
  }

  async flushLongTermArchiveIndex(): Promise<void> {
    if (!this.longTermArchiveDirty) return;
    this.longTermArchiveIndex.updatedAt = nowIso();
    await writeJsonFile(this.longTermArchiveIndexPath, this.longTermArchiveIndex);
    this.stateDb?.upsertSnapshot({
      scope: "memory.long_term_archive_index",
      visibility: "private",
      at: this.longTermArchiveIndex.updatedAt,
      data: {
        version: 1,
        updatedAt: this.longTermArchiveIndex.updatedAt,
        items: this.longTermArchiveIndex.items.length,
        latestCompactedAt:
          this.longTermArchiveIndex.items[0]?.compactedAt ?? null,
      },
    });
    this.longTermArchiveDirty = false;
  }

  private scheduleMoodStateWrite(): void {
    if (this.moodWriteTimer) return;
    this.moodWriteTimer = setTimeout(() => {
      this.moodWriteTimer = null;
      void this.flushMoodState().catch(() => undefined);
    }, 300);
  }

  async flushMoodState(): Promise<void> {
    if (!this.moodDirty) return;
    this.moodState.updatedAt = nowIso();
    await writeJsonFile(this.moodStatePath, this.moodState);
    this.stateDb?.upsertSnapshot({
      scope: "memory.mood_state",
      visibility: "private",
      at: this.moodState.updatedAt,
      data: this.moodState,
    });
    this.moodDirty = false;
  }

  private scheduleTemporalContextWrite(): void {
    if (this.temporalWriteTimer) return;
    this.temporalWriteTimer = setTimeout(() => {
      this.temporalWriteTimer = null;
      void this.flushTemporalContext().catch(() => undefined);
    }, 350);
  }

  async flushTemporalContext(): Promise<void> {
    if (!this.temporalDirty) return;
    this.temporalContext.updatedAt = nowIso();
    await writeJsonFile(this.temporalContextPath, this.temporalContext);
    await Promise.all(
      Object.entries(this.temporalTierPaths).map(async ([tier, filePath]) => {
        const tierPayload = isRecord(this.temporalContext.tiers?.[tier])
          ? this.temporalContext.tiers[tier]
          : { version: 1, tier, updatedAt: nowIso(), bullets: [] };
        await writeJsonFile(filePath, tierPayload);
      }),
    );
    this.stateDb?.upsertSnapshot({
      scope: "memory.temporal_context",
      visibility: "private",
      at: this.temporalContext.updatedAt,
      data: this.temporalContext,
    });
    this.temporalDirty = false;
  }

  // ---- rotation -----------------------------------------------------------

  async maybeRotate(stream: StreamName): Promise<void> {
    const activePath = this.streamPaths[stream];
    const stat = await fs.stat(activePath).catch(() => null);
    if (!stat || stat.size < this.rotateBytes) return;
    await archiveJsonl({ stream, stateDir: this.stateDir, activePath, archiveBasename: createArchiveBasename() });
  }

  // ---- derive memory activity ---------------------------------------------

  private deriveMemoryActivity(envelope: MemoryEnvelope, keys: ReturnType<typeof extractKeysFromPayload>): MemoryActivity {
    const type = keys.type ?? "";
    const actor = extractActorHintFromPayload(envelope.payload);
    const textHint = extractTextHintFromPayload(envelope.payload);
    const postId = typeof keys.postId === "number" ? keys.postId : null;
    const commentId = typeof keys.commentId === "number" ? keys.commentId : null;

    let activityType = "";
    if (type === "post_view") activityType = "read";
    else if (type === "post_comment") activityType = "comment";
    else if (type === "post_like") activityType = "like";
    else if (type === "post_repost") activityType = "repost";
    else if (type === "post_created") activityType = "post_created";
    else if (type === "publish_attempt_result") activityType = "publish_result";
    else if (type === "publish_attempt") activityType = "publish_attempt";
    else if (type === "directive_queue_executed") activityType = "directive_executed";
    else if (type === "directive_staged_for_queue_execution" || type === "directive_staged_waiting_terminal_run") activityType = "directive_staged";
    else if (type.endsWith("_failed") || type.includes("error")) activityType = "error";
    else if (envelope.source === "local") activityType = "runtime";
    else activityType = "event";

    return {
      type: "memory_activity", activityType, postId, commentId,
      actor: actor || null, summary: textHint || null,
      sourceTopic: typeof envelope.topic === "string" ? envelope.topic : "unknown",
      sourceType: type || "unknown",
    };
  }

  getMoodSnapshot(): MoodState {
    return isRecord(this.moodState) ? this.moodState : defaultMoodState();
  }

  private resolveViewStateEntity(
    keys: ReturnType<typeof extractKeysFromPayload>,
  ): { key: string; postId: number | null; commentId: number | null } | null {
    if (typeof keys.commentId === "number" && keys.commentId > 0) {
      return {
        key: `comment:${keys.commentId}`,
        postId: typeof keys.postId === "number" && keys.postId > 0 ? keys.postId : null,
        commentId: keys.commentId,
      };
    }
    if (typeof keys.postId === "number" && keys.postId > 0) {
      return { key: `post:${keys.postId}`, postId: keys.postId, commentId: null };
    }
    return null;
  }

  private maybePruneViewState(): void {
    const entries = Object.entries(this.viewState.items);
    if (entries.length <= VIEW_STATE_MAX_ITEMS) return;
    const sorted = entries.sort((a, b) => {
      const aMs = Date.parse(a[1].lastSeenAt);
      const bMs = Date.parse(b[1].lastSeenAt);
      if (!Number.isFinite(aMs) && !Number.isFinite(bMs)) return 0;
      if (!Number.isFinite(aMs)) return 1;
      if (!Number.isFinite(bMs)) return -1;
      return bMs - aMs;
    });
    const keep = sorted.slice(0, VIEW_STATE_PRUNE_TARGET);
    const nextItems: ViewState["items"] = {};
    for (const [key, item] of keep) nextItems[key] = item;
    this.viewState.items = nextItems;
    this.viewStateDirty = true;
  }

  private upsertViewStateItem(input: {
    key: string;
    status: "unviewed" | "viewed";
    receivedAt: string;
    postId: number | null;
    commentId: number | null;
    sourceType: string | null;
    topic: string | null;
  }): { created: boolean } {
    const receivedAt = normalizeIso(input.receivedAt);
    const existing = this.viewState.items[input.key];
    const created = !existing;

    const next: ViewState["items"][string] = {
      status:
        input.status === "viewed"
          ? "viewed"
          : existing?.status === "viewed"
            ? "viewed"
            : "unviewed",
      receivedAt: existing?.receivedAt ?? receivedAt,
      firstSeenAt: existing?.firstSeenAt ?? receivedAt,
      lastSeenAt: receivedAt,
      seenCount:
        input.status === "viewed"
          ? (existing?.seenCount ?? 0) + 1
          : existing?.seenCount ?? 0,
      postId:
        (typeof input.postId === "number" && input.postId > 0 ? input.postId : null) ??
        existing?.postId ??
        null,
      commentId:
        (typeof input.commentId === "number" && input.commentId > 0
          ? input.commentId
          : null) ??
        existing?.commentId ??
        null,
      sourceType: input.sourceType ?? existing?.sourceType ?? null,
      lastTopic: input.topic ?? existing?.lastTopic ?? null,
    };

    this.viewState.items[input.key] = next;
    this.viewStateDirty = true;
    this.viewStateMutationCount += 1;
    if (
      this.viewStateMutationCount % VIEW_STATE_PRUNE_CHECK_INTERVAL === 0 ||
      Object.keys(this.viewState.items).length > VIEW_STATE_MAX_ITEMS
    ) {
      this.maybePruneViewState();
    }
    this.scheduleViewStateWrite();
    return { created };
  }

  private buildViewSummary(request: ContextRequest): ContextBundle["view"] {
    const hasTarget =
      typeof request.postId === "number" || typeof request.commentId === "number";
    const includeRequested = request.includeViewState === true;
    const relevant = includeRequested || hasTarget;
    if (!relevant) {
      return { enabled: false, relevant: false, lines: [] };
    }

    const maxItemsRaw =
      typeof request.viewStateMaxItems === "number" && Number.isFinite(request.viewStateMaxItems)
        ? Math.floor(request.viewStateMaxItems)
        : 8;
    const maxItems = Math.max(1, Math.min(24, maxItemsRaw));
    const lines: string[] = [];
    const entries = Object.entries(this.viewState.items);
    const sortByRecent = (
      a: [string, ViewState["items"][string]],
      b: [string, ViewState["items"][string]],
    ): number => {
      const aMs = Date.parse(a[1].lastSeenAt);
      const bMs = Date.parse(b[1].lastSeenAt);
      if (!Number.isFinite(aMs) && !Number.isFinite(bMs)) return 0;
      if (!Number.isFinite(aMs)) return 1;
      if (!Number.isFinite(bMs)) return -1;
      return bMs - aMs;
    };

    lines.push(`viewIndexSize=${entries.length}`);

    if (typeof request.postId === "number") {
      const postEntry = this.viewState.items[`post:${request.postId}`];
      if (postEntry) {
        lines.push(
          `post:${request.postId} status=${postEntry.status} seen=${postEntry.seenCount} last=${postEntry.lastSeenAt}`,
        );
      } else {
        lines.push(`post:${request.postId} status=unknown`);
      }
      const relatedComments = entries
        .filter(
          ([, item]) =>
            typeof item.commentId === "number" &&
            item.commentId > 0 &&
            item.postId === request.postId,
        )
        .sort(sortByRecent)
        .slice(0, maxItems);
      if (relatedComments.length > 0) {
        lines.push(`post:${request.postId} relatedComments=${relatedComments.length}`);
        for (const [, item] of relatedComments) {
          lines.push(
            `comment:${item.commentId} status=${item.status} seen=${item.seenCount} last=${item.lastSeenAt}`,
          );
        }
      }
    }

    if (typeof request.commentId === "number") {
      const commentEntry = this.viewState.items[`comment:${request.commentId}`];
      if (commentEntry) {
        lines.push(
          `comment:${request.commentId} status=${commentEntry.status} seen=${commentEntry.seenCount} last=${commentEntry.lastSeenAt} post=${commentEntry.postId ?? "null"}`,
        );
      } else {
        lines.push(`comment:${request.commentId} status=unknown`);
      }
    }

    if (!hasTarget) {
      const recent = entries.sort(sortByRecent).slice(0, maxItems);
      for (const [key, item] of recent) {
        lines.push(`${key} status=${item.status} seen=${item.seenCount} last=${item.lastSeenAt}`);
      }
    }

    return { enabled: true, relevant: true, lines };
  }

  private pruneKeywordIndex(): void {
    const entries = Object.entries(this.keywordIndex.docs);
    if (entries.length <= KEYWORD_INDEX_MAX_DOCS) return;
    const keepEntries = entries
      .sort((a, b) =>
        a[1].receivedAt < b[1].receivedAt
          ? 1
          : a[1].receivedAt > b[1].receivedAt
            ? -1
            : 0,
      )
      .slice(0, KEYWORD_INDEX_PRUNE_TARGET);
    const nextDocs: KeywordMemoryIndex["docs"] = {};
    for (const [docId, doc] of keepEntries) {
      nextDocs[docId] = doc;
    }
    const nextInverted: KeywordMemoryIndex["inverted"] = {};
    for (const [docId, doc] of Object.entries(nextDocs)) {
      for (const keyword of doc.keywords) {
        nextInverted[keyword] ??= [];
        nextInverted[keyword].push(docId);
      }
    }
    for (const keyword of Object.keys(nextInverted)) {
      nextInverted[keyword] = unique(
        (nextInverted[keyword] ?? []).slice(0, KEYWORD_INDEX_MAX_DOCS_PER_KEYWORD),
      );
    }
    this.keywordIndex.docs = nextDocs;
    this.keywordIndex.inverted = nextInverted;
    this.keywordIndexDirty = true;
  }

  private upsertKeywordDoc(doc: KeywordIndexDoc): void {
    const existing = this.keywordIndex.docs[doc.id];
    if (existing) {
      for (const keyword of existing.keywords) {
        const docIds = this.keywordIndex.inverted[keyword];
        if (!docIds) continue;
        this.keywordIndex.inverted[keyword] = docIds.filter((id) => id !== doc.id);
        if ((this.keywordIndex.inverted[keyword] ?? []).length === 0) {
          delete this.keywordIndex.inverted[keyword];
        }
      }
    }
    this.keywordIndex.docs[doc.id] = doc;
    for (const keyword of doc.keywords) {
      const current = this.keywordIndex.inverted[keyword] ?? [];
      const next = [doc.id, ...current.filter((id) => id !== doc.id)].slice(
        0,
        KEYWORD_INDEX_MAX_DOCS_PER_KEYWORD,
      );
      this.keywordIndex.inverted[keyword] = next;
    }
    this.keywordIndexDirty = true;
    this.keywordIndexMutationCount += 1;
    if (
      this.keywordIndexMutationCount % KEYWORD_INDEX_PRUNE_CHECK_INTERVAL === 0 ||
      Object.keys(this.keywordIndex.docs).length > KEYWORD_INDEX_MAX_DOCS
    ) {
      this.pruneKeywordIndex();
    }
    this.scheduleKeywordIndexWrite();
  }

  private buildKeywordDocForEnvelope(
    envelope: MemoryEnvelope,
    keys: ReturnType<typeof extractKeysFromPayload>,
  ): KeywordIndexDoc | null {
    const sourceType = keys.type ?? null;
    if (sourceType && KEYWORD_INDEX_INTERNAL_SKIP_PATTERN.test(sourceType)) {
      return null;
    }
    const actor = extractActorHintFromPayload(envelope.payload) || null;
    const participants = extractParticipantsFromPayload(envelope.payload);
    const textHint = extractTextHintFromPayload(envelope.payload);
    const fallbackSummaryParts = [
      sourceType,
      typeof keys.postId === "number" ? `post:${keys.postId}` : "",
      typeof keys.commentId === "number" ? `comment:${keys.commentId}` : "",
    ]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .join(" ");
    const summary = toShortLine(
      textHint.length > 0 ? textHint : fallbackSummaryParts,
      220,
    );
    if (!summary.length) return null;

    const keywordText = [
      summary,
      actor ?? "",
      sourceType ?? "",
      ...(keys.tags ?? []),
      ...(keys.categories ?? []),
    ].join(" ");
    const keywords = tokenizeKeywordText(keywordText).slice(0, 24);
    if (keywords.length === 0) return null;

    const signature = eventSignature(envelope);
    const docId =
      signature.length > 0
        ? signature
        : `${normalizeIso(envelope.receivedAt)}|${envelope.topic}|${sourceType ?? "event"}`;
    const postId = typeof keys.postId === "number" ? keys.postId : null;
    const commentId = typeof keys.commentId === "number" ? keys.commentId : null;
    return {
      id: docId,
      receivedAt: normalizeIso(envelope.receivedAt),
      sourceType,
      topic: asNullableString(envelope.topic),
      postId,
      commentId,
      actor,
      participants,
      summary,
      keywords,
      lookupPlans: buildDefaultLookupPlansForDoc({
        sourceType,
        postId,
        commentId,
        actor,
      }),
    };
  }

  private getLongTermCapsuleId(stream: string, archiveBasename: string): string {
    return `${stream}:${archiveBasename}`;
  }

  private upsertLongTermArchiveCapsule(
    capsule: LongTermArchiveCapsule,
    maxCapsules: number,
  ): void {
    const nextItems = this.longTermArchiveIndex.items.filter(
      (item) => item.id !== capsule.id,
    );
    nextItems.push(capsule);
    nextItems.sort((a, b) =>
      a.compactedAt < b.compactedAt ? 1 : a.compactedAt > b.compactedAt ? -1 : 0,
    );
    this.longTermArchiveIndex.items = nextItems.slice(
      0,
      Math.max(1000, Math.min(2_000_000, maxCapsules)),
    );
    this.longTermArchiveDirty = true;
    this.scheduleLongTermArchiveWrite();
  }

  private buildArchiveSampleLines(events: MemoryEnvelope[]): string[] {
    const lines: string[] = [];
    for (const env of events) {
      const keys = extractKeysFromPayload(env.payload);
      const type = keys.type ?? "event";
      const actor = extractActorHintFromPayload(env.payload);
      const textHint = extractTextHintFromPayload(env.payload);
      const fallbackSummary = [
        type,
        keys.postId ? `post:${keys.postId}` : "",
        keys.commentId ? `comment:${keys.commentId}` : "",
        actor ? `actor:${actor}` : "",
      ]
        .filter((token) => token.length > 0)
        .join(" ");
      const summary = textHint.length > 0 ? textHint : fallbackSummary;
      if (!summary.length) continue;
      lines.push(toShortLine(summary, 220));
    }
    return unique(lines).filter((line) => line.length > 0);
  }

  private async compactArchiveIndexToLongTerm(input: {
    stream: StreamName;
    index: ArchiveIndex;
    retentionConfig: KthxRetentionConfig;
    archiveCompressFn: ArchiveCompressFn | null;
  }): Promise<boolean> {
    const { stream, index, retentionConfig, archiveCompressFn } = input;
    const capsuleId = this.getLongTermCapsuleId(stream, index.archiveBasename);
    const existing = this.longTermArchiveIndex.items.find(
      (item) => item.id === capsuleId,
    );
    if (existing) return true;

    const gzPath = findArchiveGzPath({
      stateDir: this.stateDir,
      stream,
      archiveBasename: index.archiveBasename,
    });
    const maxEvents = Math.max(
      20,
      Math.min(2000, retentionConfig.longTerm.maxEventsPerArchive),
    );
    const maxSnippets = Math.max(
      1,
      Math.min(24, retentionConfig.longTerm.maxSnippetsPerArchive),
    );
    const sampleEvents = await readEventsFromGzArchive({
      gzPath,
      filter: () => true,
      maxEvents,
    });

    const topTypes = Object.entries(index.types ?? {})
      .map(([type, count]) => ({
        type: type.trim(),
        count: Math.max(0, Math.floor(count)),
      }))
      .filter((entry) => entry.type.length > 0 && entry.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 24);

    let snippets = this.buildArchiveSampleLines(sampleEvents).slice(0, maxSnippets);
    let summary = toShortLine(
      [
        `archive ${stream}/${index.archiveBasename}`,
        `events=${index.eventCount}`,
        topTypes.length > 0
          ? `topTypes=${topTypes
              .slice(0, 4)
              .map((entry) => `${entry.type}:${entry.count}`)
              .join(",")}`
          : "",
        index.postIds.length > 0 ? `posts=${index.postIds.length}` : "",
        index.commentIds.length > 0 ? `comments=${index.commentIds.length}` : "",
      ]
        .filter((token) => token.length > 0)
        .join(" "),
      320,
    );
    let compressedBy: "algorithm" | "agent" = "algorithm";

    if (
      retentionConfig.longTerm.useAgentCompression === true &&
      typeof archiveCompressFn === "function"
    ) {
      try {
        const compressed = await archiveCompressFn({
          stream,
          archiveBasename: index.archiveBasename,
          receivedAtMin: index.receivedAtMin ?? null,
          receivedAtMax: index.receivedAtMax ?? null,
          eventCount: index.eventCount,
          topTypes,
          postIds: index.postIds.slice(0, 200),
          commentIds: index.commentIds.slice(0, 400),
          sampleLines: snippets,
        });
        const parsed = parseArchiveCompressionResult(compressed);
        if (parsed.summary || parsed.snippets.length > 0) {
          if (parsed.summary) {
            summary = parsed.summary;
          }
          if (parsed.snippets.length > 0) {
            snippets = parsed.snippets.slice(0, maxSnippets);
          }
          compressedBy = "agent";
        }
      } catch {
        // Non-fatal: keep algorithm summary.
      }
    }

    const keywords = tokenizeKeywordText(
      [
        summary,
        ...snippets,
        ...index.postIds.slice(0, 32).map((id) => `post ${id}`),
        ...index.commentIds.slice(0, 48).map((id) => `comment ${id}`),
        ...topTypes.slice(0, 10).map((entry) => entry.type),
      ].join(" "),
    ).slice(0, 64);

    const capsule: LongTermArchiveCapsule = {
      id: capsuleId,
      stream,
      archiveBasename: index.archiveBasename,
      compactedAt: nowIso(),
      receivedAtMin: index.receivedAtMin ?? null,
      receivedAtMax: index.receivedAtMax ?? null,
      eventCount: Math.max(0, Math.floor(index.eventCount)),
      postIds: unique(index.postIds.slice(0, 400)),
      commentIds: unique(index.commentIds.slice(0, 800)),
      topTypes,
      summary,
      snippets: snippets.slice(0, maxSnippets),
      keywords,
      compressedBy,
    };
    this.upsertLongTermArchiveCapsule(
      capsule,
      retentionConfig.longTerm.maxCapsules,
    );
    return true;
  }

  private async runLongTermCompaction(input: {
    retentionConfig: KthxRetentionConfig;
    streamRetentionMap: Record<StreamName, number>;
    archiveCompressFn: ArchiveCompressFn | null;
  }): Promise<{ compactions: number; deletableArchiveIds: Set<string> }> {
    const { retentionConfig, streamRetentionMap, archiveCompressFn } = input;
    const deletableArchiveIds = new Set<string>();
    if (retentionConfig.longTerm.enabled !== true) {
      return { compactions: 0, deletableArchiveIds };
    }

    const knownCapsuleIds = new Set(
      this.longTermArchiveIndex.items.map((item) => item.id),
    );
    const nowMs = Date.now();
    const candidates: Array<{ stream: StreamName; index: ArchiveIndex; ageMs: number }> = [];

    for (const stream of Object.keys(streamRetentionMap) as StreamName[]) {
      const maxDays = streamRetentionMap[stream] ?? 365;
      const cutoffMs = maxDays * 86_400_000;
      const indexes = await listArchiveIndexes({
        stateDir: this.stateDir,
        stream,
      });
      for (const index of indexes) {
        const maxAtMs = index.receivedAtMax ? Date.parse(index.receivedAtMax) : NaN;
        if (!Number.isFinite(maxAtMs)) continue;
        const ageMs = nowMs - maxAtMs;
        if (ageMs <= cutoffMs) continue;
        const archiveId = this.getLongTermCapsuleId(stream, index.archiveBasename);
        if (knownCapsuleIds.has(archiveId)) {
          deletableArchiveIds.add(archiveId);
          continue;
        }
        candidates.push({ stream, index, ageMs });
      }
    }

    candidates.sort((a, b) => b.ageMs - a.ageMs);
    const maxCompactions = Math.max(
      1,
      Math.min(100, retentionConfig.longTerm.maxCompactionsPerRun),
    );
    let compactions = 0;

    for (const candidate of candidates) {
      if (compactions >= maxCompactions) break;
      const ok = await this.compactArchiveIndexToLongTerm({
        stream: candidate.stream,
        index: candidate.index,
        retentionConfig,
        archiveCompressFn,
      });
      const archiveId = this.getLongTermCapsuleId(
        candidate.stream,
        candidate.index.archiveBasename,
      );
      if (ok) {
        compactions += 1;
        deletableArchiveIds.add(archiveId);
        knownCapsuleIds.add(archiveId);
      }
    }

    return { compactions, deletableArchiveIds };
  }

  private buildLongTermRetrievalLines(input: {
    intent: RetrievalIntent;
    keywords: string[];
    postId: number | null;
    commentId: number | null;
    maxItems: number;
  }): string[] {
    const { intent, keywords, postId, commentId, maxItems } = input;
    if (!this.longTermArchiveIndex.items.length) return [];
    const nowMs = Date.now();
    const scored: Array<{ capsule: LongTermArchiveCapsule; score: number }> = [];

    for (const capsule of this.longTermArchiveIndex.items) {
      const keywordMatches = keywords.filter((keyword) =>
        capsule.keywords.includes(keyword),
      ).length;
      const postMatched =
        typeof postId === "number" && capsule.postIds.includes(postId);
      const commentMatched =
        typeof commentId === "number" && capsule.commentIds.includes(commentId);
      if (!keywordMatches && !postMatched && !commentMatched) continue;
      const compactedAtMs = Date.parse(capsule.compactedAt);
      const ageDays =
        Number.isFinite(compactedAtMs) && compactedAtMs <= nowMs
          ? (nowMs - compactedAtMs) / 86_400_000
          : 365;
      const recencyScore = 1 / (1 + Math.max(0, ageDays / 30));
      let score =
        keywordMatches * 2.2 * LONG_TERM_RETENTION_SOURCE_WEIGHT[intent] +
        recencyScore * 1.6;
      if (postMatched) score += 6;
      if (commentMatched) score += 7.5;
      if (capsule.compressedBy === "agent") score += 0.5;
      scored.push({ capsule, score });
    }

    scored.sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : a.capsule.compactedAt < b.capsule.compactedAt
          ? 1
          : a.capsule.compactedAt > b.capsule.compactedAt
            ? -1
            : 0,
    );
    if (!scored.length) return [];
    const lines: string[] = [`archiveCapsuleHits=${scored.length}`];
    for (const item of scored.slice(0, Math.max(1, Math.min(6, maxItems)))) {
      const c = item.capsule;
      lines.push(
        `archive_capsule score=${item.score.toFixed(2)} stream=${c.stream} events=${c.eventCount} range=${c.receivedAtMin ?? "n/a"}..${c.receivedAtMax ?? "n/a"} :: ${c.summary}`,
      );
      if (c.snippets.length > 0) {
        lines.push(`archive_snippet ${toShortLine(c.snippets[0] ?? "", 180)}`);
      }
    }
    return lines;
  }

  private buildRetrievalSummary(request: ContextRequest): ContextBundle["retrieval"] {
    const includeRequested = request.includeKeywordRetrieval === true;
    const hasTarget =
      typeof request.postId === "number" || typeof request.commentId === "number";
    const query = asNullableString(request.retrievalQuery);
    const intent = resolveRetrievalIntent(request);
    if (!includeRequested && !hasTarget) {
      return { enabled: false, intent, query: null, keywords: [], lines: [] };
    }
    const baseQuery =
      query ??
      [
        typeof request.postId === "number" ? `post ${request.postId}` : "",
        typeof request.commentId === "number" ? `comment ${request.commentId}` : "",
      ]
        .filter((part) => part.length > 0)
        .join(" ")
        .trim();
    const keywords = tokenizeKeywordText(baseQuery).slice(0, 12);
    const presetSummary = buildRetrievalPresets({
      docs: Object.values(this.keywordIndex.docs),
      query: baseQuery,
      intent,
      postId: typeof request.postId === "number" ? request.postId : null,
      commentId: typeof request.commentId === "number" ? request.commentId : null,
      defaultRangeMs: RETRIEVAL_MAX_AGE_HOURS_BY_INTENT[intent] * 3_600_000,
      maxMostEngagedPosts: 3,
      maxEventsPerType: 3,
    });
    const maxItemsRaw =
      typeof request.retrievalMaxItems === "number" &&
      Number.isFinite(request.retrievalMaxItems)
        ? Math.floor(request.retrievalMaxItems)
        : 6;
    const maxItems = Math.max(2, Math.min(12, maxItemsRaw));
    const longTermLines = this.buildLongTermRetrievalLines({
      intent,
      keywords,
      postId: typeof request.postId === "number" ? request.postId : null,
      commentId:
        typeof request.commentId === "number" ? request.commentId : null,
      maxItems: Math.max(2, Math.min(6, maxItems)),
    });
    const lookupPlans: RetrievalLookupPlan[] = [];
    const lookupPlanFingerprints = new Set<string>();
    const addLookupPlan = (plan: RetrievalLookupPlan): void => {
      const fingerprint = JSON.stringify([
        plan.action,
        Object.entries(plan.args).sort((a, b) =>
          a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
        ),
      ]);
      if (lookupPlanFingerprints.has(fingerprint)) return;
      lookupPlanFingerprints.add(fingerprint);
      lookupPlans.push(plan);
    };
    for (const plan of buildDefaultLookupPlansForDoc({
      sourceType: null,
      postId: typeof request.postId === "number" ? request.postId : null,
      commentId: typeof request.commentId === "number" ? request.commentId : null,
      actor: null,
    })) {
      addLookupPlan(plan);
    }
    const formatLookupPlanLine = (plan: RetrievalLookupPlan): string => {
      const tokens: string[] = [plan.action];
      const postId = asFinitePositiveInt(plan.args.postId);
      if (postId) tokens.push(`post ${postId}`);
      const commentId = asFinitePositiveInt(plan.args.commentId);
      if (commentId) tokens.push(`comment ${commentId}`);
      const handle =
        typeof plan.args.handle === "string" ? plan.args.handle.trim() : "";
      if (handle.length > 0) tokens.push(`handle ${handle}`);
      return `lookup ${tokens.join(" ")} reason=${plan.reason}`;
    };
    const candidateScores = new Map<string, number>();
    for (const keyword of keywords) {
      const docIds = this.keywordIndex.inverted[keyword] ?? [];
      for (const docId of docIds.slice(0, 120)) {
        candidateScores.set(docId, (candidateScores.get(docId) ?? 0) + 2);
      }
    }

    if (hasTarget) {
      const targetMatchBoost =
        intent === "directive" ? 8 : intent === "engagement" ? 7 : 6;
      for (const [docId, doc] of Object.entries(this.keywordIndex.docs)) {
        const matchesComment =
          typeof request.commentId === "number" &&
          doc.commentId === request.commentId;
        const matchesPost =
          typeof request.postId === "number" && doc.postId === request.postId;
        if (!matchesComment && !matchesPost) continue;
        const boost = matchesComment ? targetMatchBoost : targetMatchBoost - 2;
        candidateScores.set(docId, (candidateScores.get(docId) ?? 0) + boost);
      }
    }

    if (candidateScores.size === 0) {
      const lines = [
        ...presetSummary.lines,
        ...longTermLines,
        ...lookupPlans.slice(0, 6).map((plan) => formatLookupPlanLine(plan)),
      ];
      return {
        enabled: true,
        intent,
        query: baseQuery.length > 0 ? baseQuery : null,
        keywords,
        lines,
        lookupPlans: lookupPlans.slice(0, 8),
      };
    }

    const mentionHandles = Array.from(
      baseQuery.matchAll(/@([a-z0-9_.-]+)/giu),
    )
      .map((match) => (match[1] ?? "").trim().toLowerCase())
      .filter((token) => token.length > 0);

    const nowMs = Date.now();
    const sourceWeightMap = RETRIEVAL_SOURCE_WEIGHT_BY_INTENT[intent];
    const maxAgeHours = RETRIEVAL_MAX_AGE_HOURS_BY_INTENT[intent];
    const scored: Array<{ doc: KeywordIndexDoc; score: number }> = [];
    for (const [docId, baseScore] of candidateScores.entries()) {
      const doc = this.keywordIndex.docs[docId];
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
          intent === "directive" ? 2.2 : intent === "engagement" ? 2 : 1.6;
        score += freshness * freshnessWeight;
      }
      if (typeof request.postId === "number" && doc.postId === request.postId) {
        score += intent === "directive" ? 5.5 : intent === "engagement" ? 4.8 : 4;
      }
      if (
        typeof request.commentId === "number" &&
        doc.commentId === request.commentId
      ) {
        score += intent === "directive" ? 7 : intent === "engagement" ? 6.2 : 5;
      }
      if (mentionHandles.length > 0 && typeof doc.actor === "string") {
        const actorLower = doc.actor.trim().toLowerCase().replace(/^@+/u, "");
        if (actorLower.length > 0) {
          const actorMatched = mentionHandles.some(
            (handle) => handle === actorLower || actorLower.includes(handle),
          );
          if (actorMatched) score += 3;
        }
      }
      if (
        intent === "engagement" &&
        (sourceType === "post_comment" ||
          sourceType === "post_like" ||
          sourceType === "post_repost" ||
          sourceType === "post_view")
      ) {
        score += 1.4;
      }
      if (
        intent === "directive" &&
        (sourceType === "post_created" ||
          sourceType === "post_comment" ||
          sourceType === "notification_created")
      ) {
        score += 1.2;
      }
      scored.push({ doc, score });
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
    const lines: string[] = [...presetSummary.lines];
    const keywordLabel = keywords.length > 0 ? keywords.join(",") : "none";
    lines.push(
      `intent=${intent} keywords=${keywordLabel} hits=${scored.length}`,
    );
    for (const item of scored.slice(0, maxItems)) {
      const postToken =
        typeof item.doc.postId === "number" ? `post:${item.doc.postId}` : "";
      const commentToken =
        typeof item.doc.commentId === "number"
          ? `comment:${item.doc.commentId}`
          : "";
      const sourceToken = item.doc.sourceType ?? "event";
      const tokens = [sourceToken, postToken, commentToken]
        .filter((token) => token.length > 0)
        .join(" ");
      lines.push(
        `${item.doc.receivedAt} score=${item.score.toFixed(2)} ${tokens} :: ${item.doc.summary}`,
      );
      for (const plan of item.doc.lookupPlans.slice(0, 4)) {
        addLookupPlan(plan);
      }
    }
    if (lookupPlans.length > 0) {
      lines.push(`lookupPlans=${lookupPlans.length}`);
      for (const plan of lookupPlans.slice(0, 8)) {
        lines.push(formatLookupPlanLine(plan));
      }
    }
    lines.push(...longTermLines);

    return {
      enabled: true,
      intent,
      query: baseQuery.length > 0 ? baseQuery : null,
      keywords,
      lines,
      lookupPlans: lookupPlans.slice(0, 8),
    };
  }

  // ---- ingest -------------------------------------------------------------

  async ingest(envelope: MemoryEnvelope): Promise<void> {
    const keys = extractKeysFromPayload(envelope.payload);
    const type = keys.type;
    const activityRecord = this.deriveMemoryActivity(envelope, keys);
    this.stateDb?.appendEvent({
      source: envelope.source,
      topic: envelope.topic,
      eventType: type ?? "unknown",
      visibility: "private",
      at: envelope.receivedAt,
      payload: envelope,
    });

    const shouldIndexForRetrieval =
      type === "post_created" ||
      type === "post_comment" ||
      type === "post_like" ||
      type === "post_repost" ||
      type === "post_view" ||
      type === "notification_created" ||
      type === "story_reply" ||
      type === "chat_runtime_site_lookup" ||
      envelope.source !== "local";
    if (shouldIndexForRetrieval) {
      const keywordDoc = this.buildKeywordDocForEnvelope(envelope, keys);
      if (keywordDoc) {
        this.upsertKeywordDoc(keywordDoc);
      }
    }

    const streams: StreamName[] = [];
    if (type === "director_grant") streams.push("director");
    else if (type === "notification_created") streams.push("notifications");
    else if (type === "post_created") streams.push("feed");
    else if (type === "post_like") streams.push("likes", "activity");
    else if (type === "post_repost") streams.push("reposts", "activity");
    else if (type === "post_comment") streams.push("comments", "activity");
    else if (type === "post_view") streams.push("views", "activity");
    else streams.push(envelope.source === "local" ? "writes" : "errors");

    await Promise.all(unique(streams).map(async (stream) => {
      await appendJsonLine(this.streamPaths[stream], envelope);
      await this.maybeRotate(stream);
    }));

    await appendJsonLine(this.streamPaths.memory_activity, {
      receivedAt: envelope.receivedAt, source: "local", topic: "derived:memory_activity", payload: activityRecord,
    });
    await this.maybeRotate("memory_activity");

    const moodSignal = computeMoodDelta(envelope, keys);
    if (moodSignal.delta !== 0 || activityRecord.activityType === "read" || activityRecord.activityType === "comment" || activityRecord.activityType === "publish_result") {
      this.moodState = applyMoodSignal(this.moodState, { delta: moodSignal.delta, reason: moodSignal.reason, at: envelope.receivedAt, activityType: activityRecord.activityType });
      this.moodDirty = true;
      this.scheduleMoodStateWrite();
    }

    if (keys.postId && (keys.tags.length || keys.categories.length)) {
      await appendJsonLine(this.streamPaths.tags, { receivedAt: envelope.receivedAt, source: "local", topic: "derived:tags", payload: { postId: keys.postId, tags: keys.tags, categories: keys.categories, origin: envelope.topic } });
      await this.maybeRotate("tags");
    }

    const shouldTrackViewState =
      type === "post_created" ||
      type === "notification_created" ||
      type === "post_view" ||
      type === "post_like" ||
      type === "post_repost" ||
      type === "post_comment";
    const viewEntity = shouldTrackViewState
      ? this.resolveViewStateEntity(keys)
      : null;
    if (viewEntity) {
      const viewStatus: "unviewed" | "viewed" =
        type === "post_created" || type === "notification_created"
          ? "unviewed"
          : "viewed";
      const { created } = this.upsertViewStateItem({
        key: viewEntity.key,
        status: viewStatus,
        receivedAt: envelope.receivedAt,
        postId: viewEntity.postId,
        commentId: viewEntity.commentId,
        sourceType: type,
        topic: envelope.topic,
      });
      if (created && viewStatus === "unviewed") {
        const receivedAt = normalizeIso(envelope.receivedAt);
        await appendJsonLine(this.streamPaths.views, {
          receivedAt,
          source: "local",
          topic: "derived:view_queue",
          payload: {
            postId: viewEntity.postId,
            commentId: viewEntity.commentId,
            status: "unviewed",
            receivedAt,
          },
        });
        await this.maybeRotate("views");
      }
    }

    const at = activityRecord.activityType;
    const shouldRefreshTemporalContext =
      at === "read" ||
      at === "comment" ||
      at === "publish_result" ||
      at === "directive_executed";
    if (shouldRefreshTemporalContext) {
      void this.refreshTemporalContext({
        force: false,
        allowAgentCompression: false,
      }).catch(() => undefined);
    }
  }

  async recordWrite(payload: unknown): Promise<void> {
    await this.ingest({ receivedAt: nowIso(), source: "local", topic: "agent_write", payload });
  }

  // ---- read ---------------------------------------------------------------

  async readRecentEnvelopes({ maxLines }: { maxLines: number }): Promise<MemoryEnvelope[]> {
    const streams: StreamName[] = ["notifications", "feed", "activity", "memory_activity", "likes", "reposts", "comments", "views", "director"];
    const perStream = Math.max(30, Math.ceil(maxLines / streams.length));
    const reads = await Promise.all(streams.map(async (stream) => {
      const items = await readLastJsonLines({ filePath: this.streamPaths[stream], maxLines: perStream, maxBytes: this.tailMaxBytes });
      return items.map(parseMemoryEnvelope).filter((env): env is MemoryEnvelope => Boolean(env));
    }));
    const merged = reads.flat();
    merged.sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0));
    return merged;
  }

  async readArchiveContext({ request, maxEvents, targetFilter }: { request: ContextRequest; maxEvents: number; targetFilter: (env: MemoryEnvelope) => boolean }): Promise<MemoryEnvelope[]> {
    if (maxEvents <= 0) return [];
    const streams: StreamName[] = ["feed", "activity", "memory_activity", "notifications"];
    const results: MemoryEnvelope[] = [];
    const wantTargeted = typeof request.postId === "number" || typeof request.commentId === "number";

    for (const stream of streams) {
      if (results.length >= maxEvents) break;
      const indexes = await listArchiveIndexes({ stateDir: this.stateDir, stream });
      if (!indexes.length) continue;
      const picks = wantTargeted
        ? indexes.filter((idx) => (typeof request.postId === "number" && idx.postIds?.includes(request.postId)) || (typeof request.commentId === "number" && idx.commentIds?.includes(request.commentId))).slice(0, 4).map((idx) => idx.archiveBasename)
        : pickWeightedArchiveBasenames(indexes, 2);
      for (const basename of picks) {
        if (results.length >= maxEvents) break;
        const gzPath = findArchiveGzPath({ stateDir: this.stateDir, stream, archiveBasename: basename });
        const batch = await readEventsFromGzArchive({ gzPath, filter: wantTargeted ? targetFilter : () => true, maxEvents: Math.min(maxEvents - results.length, 30) });
        results.push(...batch);
      }
    }
    results.sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0));
    return results.slice(-maxEvents);
  }

  async readArchiveWindow({ maxAgeDays, maxEvents, filter }: { maxAgeDays: number; maxEvents: number; filter?: (env: MemoryEnvelope) => boolean }): Promise<MemoryEnvelope[]> {
    const safeMax = Math.max(0, Math.floor(maxEvents));
    if (safeMax <= 0) return [];
    const minMs = Date.now() - Math.max(1, Math.floor(maxAgeDays)) * 86_400_000;
    const scanStreams: StreamName[] = ["feed", "activity", "memory_activity", "notifications", "comments", "views"];
    const out: MemoryEnvelope[] = [];
    for (const stream of scanStreams) {
      if (out.length >= safeMax) break;
      const indexes = await listArchiveIndexes({ stateDir: this.stateDir, stream });
      for (const idx of indexes.slice(0, 16)) {
        if (out.length >= safeMax) break;
        const maxAtMs = idx.receivedAtMax ? Date.parse(idx.receivedAtMax) : NaN;
        if (!Number.isFinite(maxAtMs) || maxAtMs < minMs) continue;
        const batch = await readEventsFromGzArchive({ gzPath: findArchiveGzPath({ stateDir: this.stateDir, stream, archiveBasename: idx.archiveBasename }), filter: filter ?? ((e) => Date.parse(e.receivedAt) >= minMs), maxEvents: Math.min(safeMax - out.length, 120) });
        out.push(...batch);
      }
    }
    return uniqueEventsBySignature(out).sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0)).slice(-safeMax);
  }

  // ---- context ------------------------------------------------------------

  async buildContext(request: ContextRequest): Promise<ContextBundle> {
    const maxRecent = request.maxRecentEvents ?? 80;
    const maxArchive = request.maxArchiveEvents ?? 40;
    await this.refreshTemporalContext({
      force: false,
      allowAgentCompression: false,
    }).catch(() => undefined);

    const identityPath = path.join(this.stateDir, "memory", "identity.json");
    const modePath = request.mode ? path.join(this.stateDir, "memory", "modes", `${request.mode}.json`) : null;
    const [identityRaw, modeRaw] = await Promise.all([readJsonFile(identityPath), modePath ? readJsonFile(modePath) : Promise.resolve(null)]);

    const notesDir = path.join(this.stateDir, "memory", "notes");
    const noteFiles = await fs.readdir(notesDir).catch(() => []);
    const notes: Array<{ version: number; title: string; content: string; appliesTo?: { modes?: string[]; audiences?: string[] } }> = [];
    for (const name of noteFiles) {
      if (!name.endsWith(".json")) continue;
      const note = await readJsonFile(path.join(notesDir, name));
      if (!isRecord(note) || note.version !== 1) continue;
      if (typeof note.title !== "string" || typeof note.content !== "string") continue;
      notes.push(note as { version: number; title: string; content: string; appliesTo?: { modes?: string[]; audiences?: string[] } });
    }

    const eligible = notes.filter((n) => {
      const a = n.appliesTo;
      if (!a) return true;
      if (
        request.mode &&
        Array.isArray(a.modes) &&
        a.modes.length > 0 &&
        !a.modes.includes(request.mode)
      ) {
        return false;
      }
      if (
        request.audience &&
        Array.isArray(a.audiences) &&
        a.audiences.length > 0 &&
        !a.audiences.includes(request.audience)
      ) {
        return false;
      }
      return true;
    });

    const recent = await this.readRecentEnvelopes({ maxLines: Math.max(maxRecent, 120) });
    const tf = (env: MemoryEnvelope): boolean => {
      const k = extractKeysFromPayload(env.payload);
      return (typeof request.postId === "number" && k.postId === request.postId) || (typeof request.commentId === "number" && k.commentId === request.commentId);
    };
    const targetEvents = recent.filter(tf).slice(-maxRecent);
    const archiveEvents = await this.readArchiveContext({ request, maxEvents: maxArchive, targetFilter: tf });
    const targetFocus = summarizeTargetFocus({ request, targetEvents: uniqueEventsBySignature([...targetEvents, ...archiveEvents.filter(tf)]) });
    const viewSummary = this.buildViewSummary(request);
    const retrievalSummary = this.buildRetrievalSummary(request);

    const nowMs = Date.now();
    if (nowMs - this.lastContextReadAtMs > 12_000) {
      this.lastContextReadAtMs = nowMs;
      void this.recordWrite({ type: "memory_context_read", at: nowIso(), mode: request.mode ?? null, audience: request.audience ?? null, postId: request.postId ?? null, commentId: request.commentId ?? null });
    }

    return {
      generatedAt: nowIso(), identity: identityRaw ? safeTextMemory(identityRaw) : null, mode: modeRaw ? safeTextMemory(modeRaw) : null, audience: request.audience ?? null, view: viewSummary, retrieval: retrievalSummary,
      mood: this.getMoodSnapshot(), temporal: isRecord(this.temporalContext) ? this.temporalContext : defaultTemporalContext(),
      target: { postId: request.postId ?? null, commentId: request.commentId ?? null, events: targetEvents, focus: targetFocus },
      recent: recent.slice(-maxRecent), archive: archiveEvents, notes: eligible,
    };
  }

  renderContextPrompt(bundle: ContextBundle): string { return renderContextPrompt(bundle); }

  // ---- temporal refresh ---------------------------------------------------

  async refreshTemporalContext(options: RefreshTemporalOptions = {}): Promise<TemporalContext> {
    const { force = false, allowAgentCompression = false, agentCompressFn = null } = options;

    const run = async (): Promise<TemporalContext> => {
      const nowMs = Date.now();
      const updMs = Date.parse(this.temporalContext.updatedAt ?? "");
      if (!force && Number.isFinite(updMs) && nowMs - updMs < 120_000) return this.temporalContext;

      const recent = await this.readRecentEnvelopes({ maxLines: 1600 });
      const archived = await this.readArchiveWindow({ maxAgeDays: 365, maxEvents: 900 });
      const combined = uniqueEventsBySignature([...archived, ...recent]).sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0));
      const byAge = (d: number): MemoryEnvelope[] => { const m = nowMs - d * 86_400_000; return combined.filter((e) => { const t = Date.parse(e.receivedAt); return Number.isFinite(t) && t >= m; }); };

      const specs = [{ key: "24h", days: 1, label: "last 24 hours", maxBullets: 20 }, { key: "7d", days: 7, label: "last 7 days", maxBullets: 16 }, { key: "30d", days: 30, label: "last 30 days", maxBullets: 12 }, { key: "365d", days: 365, label: "last 365 days", maxBullets: 8 }];
      const nextTiers: Record<string, TierSummary> = {};
      const specByKey = new Map<string, (typeof specs)[number]>();

      for (const s of specs) { nextTiers[s.key] = summarizeEventsForTier({ tier: s.key, label: s.label, events: byAge(s.days), maxBullets: s.maxBullets }); specByKey.set(s.key, s); }

      if (allowAgentCompression && typeof agentCompressFn === "function") {
        const targets: AgentCompressionRequest["tiers"] = {};
        for (const tk of ["30d", "365d"]) { const sm = nextTiers[tk]; if (!sm) continue; targets[tk] = { tier: tk, label: sm.windowLabel ?? tk, eventCount: sm.eventCount, topTypes: sm.topTypes, topPosts: sm.topPosts, topActors: sm.topActors, bullets: sm.algorithmBullets }; }
        if (Object.keys(targets).length > 0) {
          try {
            const ac = await agentCompressFn({ tiers: targets });
            const te = isRecord(ac) && isRecord(ac.tiers) ? ac.tiers : null;
            const normBullets = (c: unknown, max: number): string[] => { if (!Array.isArray(c)) return []; return unique(c.filter((l): l is string => typeof l === "string").map((l) => toShortLine(l, 140)).filter((l) => l.length > 0)).slice(0, max); };
            for (const tk of Object.keys(targets)) {
              const sm = nextTiers[tk]; if (!sm) continue;
              const mx = specByKey.get(tk)?.maxBullets ?? 8;
              const fe = te ? te[tk] : null; const dv = isRecord(ac) ? ac[tk] : null; const pref = fe ?? dv;
              const prefRecord = isRecord(pref) ? pref : null;
              const cb = Array.isArray(pref) ? pref : prefRecord && Array.isArray(prefRecord.bullets) ? prefRecord.bullets : Object.keys(targets).length === 1 && Array.isArray(ac) ? ac : [];
              const nb = normBullets(cb, mx);
              if (nb.length > 0) { sm.bullets = nb; sm.compressedBy = "agent"; } else { sm.bullets = sm.algorithmBullets; sm.compressedBy = "algorithm"; }
            }
          } catch { /* keep algorithm summary */ }
        }
      }

      this.temporalContext = { version: 1, updatedAt: nowIso(), algorithmVersion: 1, tiers: { ...defaultTemporalContext().tiers, ...nextTiers } };
      this.temporalDirty = true;
      this.scheduleTemporalContextWrite();
      return this.temporalContext;
    };

    if (this.temporalRefreshInFlight) return this.temporalRefreshInFlight;
    this.temporalRefreshInFlight = run().finally(() => { this.temporalRefreshInFlight = null; });
    return this.temporalRefreshInFlight;
  }

  // ---- retention (delegated) ----------------------------------------------

  async runRetentionCleanup({
    retentionConfig,
    archiveCompressFn = null,
  }: {
    retentionConfig: KthxRetentionConfig;
    archiveCompressFn?: ArchiveCompressFn | null;
  }): Promise<RetentionCleanupResult | null> {
    const streamRetentionMap = buildRetentionStreamDaysMap(retentionConfig);
    const { compactions, deletableArchiveIds } = await this.runLongTermCompaction({
      retentionConfig,
      streamRetentionMap,
      archiveCompressFn,
    });

    const longTermEnabled = retentionConfig.longTerm.enabled === true;
    const { result, moodDirty, updatedMoodState } = await runRetentionCleanup({
      retentionConfig,
      streamPaths: this.streamPaths,
      tailMaxBytes: this.tailMaxBytes,
      stateDir: this.stateDir,
      moodState: this.moodState,
      streamRetentionMap,
      archiveDeleteGuard: ({ stream, index }) => {
        if (!longTermEnabled) return true;
        const archiveId = this.getLongTermCapsuleId(stream, index.archiveBasename);
        return deletableArchiveIds.has(archiveId);
      },
      longTermCompactions: compactions,
    });

    if (this.longTermArchiveDirty) {
      await this.flushLongTermArchiveIndex().catch(() => undefined);
    }
    if (moodDirty) {
      this.moodState = updatedMoodState;
      this.moodDirty = true;
      this.scheduleMoodStateWrite();
    }
    return result;
  }
}
