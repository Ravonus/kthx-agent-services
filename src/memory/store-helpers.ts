import type {
  AgentCompressionRequest,
  ContextRequest,
  LongTermArchiveCapsule,
  LongTermArchiveIndex,
  RetrievalIntent,
  RetrievalLookupPlan,
  StreamName,
  ViewState,
} from "~/types/memory.js";
import type { KthxRetentionConfig } from "~/types/config.js";
import { isRecord } from "~/lib/guards.js";
import { normalizeIso, unique } from "~/lib/time.js";
import { nowIso, toShortLine } from "~/lib/text.js";

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


export {
  KEYWORD_INDEX_INTERNAL_SKIP_PATTERN,
  KEYWORD_INDEX_MAX_DOCS,
  KEYWORD_INDEX_MAX_DOCS_PER_KEYWORD,
  KEYWORD_INDEX_PRUNE_CHECK_INTERVAL,
  KEYWORD_INDEX_PRUNE_TARGET,
  LONG_TERM_RETENTION_SOURCE_WEIGHT,
  RETRIEVAL_MAX_AGE_HOURS_BY_INTENT,
  RETRIEVAL_SOURCE_WEIGHT_BY_INTENT,
  VIEW_STATE_MAX_ITEMS,
  VIEW_STATE_PRUNE_CHECK_INTERVAL,
  VIEW_STATE_PRUNE_TARGET,
  asFinitePositiveInt,
  asNullableString,
  buildDefaultLookupPlansForDoc,
  buildRetentionStreamDaysMap,
  normalizeKeywordDoc,
  normalizeKeywordIndex,
  normalizeLongTermArchiveCapsule,
  normalizeLongTermArchiveIndex,
  normalizeLookupPlanArgs,
  normalizeLookupPlans,
  normalizeTypeCounts,
  normalizeViewState,
  parseArchiveCompressionResult,
  parseViewEntityKey,
  resolveRetrievalIntent,
  safeTextMemory,
  toViewStateItem,
  tokenizeKeywordText,
};

export type { KeywordIndexDoc, KeywordMemoryIndex };
