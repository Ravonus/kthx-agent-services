import type { KthxRetentionConfig } from "~/types/config.js";
import type {
  ArchiveCompressFn,
  ArchiveIndex,
  LongTermArchiveCapsule,
  LongTermArchiveIndex,
  MemoryActivity,
  MemoryEnvelope,
  StreamName,
} from "~/types/memory.js";
import { nowIso, toShortLine } from "~/lib/text.js";
import { normalizeIso, unique } from "~/lib/time.js";
import {
  findArchiveGzPath,
  listArchiveIndexes,
  readEventsFromGzArchive,
} from "./archive.js";
import {
  extractActorHintFromPayload,
  extractKeysFromPayload,
  extractParticipantsFromPayload,
  extractTextHintFromPayload,
} from "./extract.js";
import { eventSignature } from "./temporal.js";
import {
  KEYWORD_INDEX_INTERNAL_SKIP_PATTERN,
  asNullableString,
  buildDefaultLookupPlansForDoc,
  parseArchiveCompressionResult,
  tokenizeKeywordText,
  type KeywordIndexDoc,
} from "./store-helpers.js";

export const deriveMemoryActivity = (
  envelope: MemoryEnvelope,
  keys: ReturnType<typeof extractKeysFromPayload>,
): MemoryActivity => {
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
  else if (
    type === "directive_staged_for_queue_execution" ||
    type === "directive_staged_waiting_terminal_run"
  ) {
    activityType = "directive_staged";
  } else if (type.endsWith("_failed") || type.includes("error")) {
    activityType = "error";
  } else if (envelope.source === "local") {
    activityType = "runtime";
  } else {
    activityType = "event";
  }

  return {
    type: "memory_activity",
    activityType,
    postId,
    commentId,
    actor: actor || null,
    summary: textHint || null,
    sourceTopic: typeof envelope.topic === "string" ? envelope.topic : "unknown",
    sourceType: type || "unknown",
  };
};

export const buildKeywordDocForEnvelope = (
  envelope: MemoryEnvelope,
  keys: ReturnType<typeof extractKeysFromPayload>,
): KeywordIndexDoc | null => {
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
};

export const getLongTermCapsuleId = (
  stream: string,
  archiveBasename: string,
): string => `${stream}:${archiveBasename}`;

export const upsertLongTermArchiveCapsule = (input: {
  longTermArchiveIndex: LongTermArchiveIndex;
  capsule: LongTermArchiveCapsule;
  maxCapsules: number;
}): LongTermArchiveIndex => {
  const { longTermArchiveIndex, capsule, maxCapsules } = input;
  const nextItems = longTermArchiveIndex.items.filter((item) => item.id !== capsule.id);
  nextItems.push(capsule);
  nextItems.sort((a, b) =>
    a.compactedAt < b.compactedAt ? 1 : a.compactedAt > b.compactedAt ? -1 : 0,
  );
  return {
    ...longTermArchiveIndex,
    items: nextItems.slice(0, Math.max(1000, Math.min(2_000_000, maxCapsules))),
  };
};

export const buildArchiveSampleLines = (events: MemoryEnvelope[]): string[] => {
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
};

export type CompactArchiveIndexToLongTermDeps = {
  stateDir: string;
  longTermArchiveItems: LongTermArchiveCapsule[];
  upsertLongTermArchiveCapsule: (
    capsule: LongTermArchiveCapsule,
    maxCapsules: number,
  ) => void;
};

export const compactArchiveIndexToLongTerm = async (
  deps: CompactArchiveIndexToLongTermDeps,
  input: {
    stream: StreamName;
    index: ArchiveIndex;
    retentionConfig: KthxRetentionConfig;
    archiveCompressFn: ArchiveCompressFn | null;
  },
): Promise<boolean> => {
  const { stateDir, longTermArchiveItems } = deps;
  const { stream, index, retentionConfig, archiveCompressFn } = input;
  const capsuleId = getLongTermCapsuleId(stream, index.archiveBasename);
  const existing = longTermArchiveItems.find((item) => item.id === capsuleId);
  if (existing) return true;

  const gzPath = findArchiveGzPath({
    stateDir,
    stream,
    archiveBasename: index.archiveBasename,
  });
  const maxEvents = Math.max(20, Math.min(2000, retentionConfig.longTerm.maxEventsPerArchive));
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

  let snippets = buildArchiveSampleLines(sampleEvents).slice(0, maxSnippets);
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
  deps.upsertLongTermArchiveCapsule(capsule, retentionConfig.longTerm.maxCapsules);
  return true;
};

export type RunLongTermCompactionDeps = {
  stateDir: string;
  longTermArchiveItems: LongTermArchiveCapsule[];
  compactArchiveIndexToLongTerm: (input: {
    stream: StreamName;
    index: ArchiveIndex;
    retentionConfig: KthxRetentionConfig;
    archiveCompressFn: ArchiveCompressFn | null;
  }) => Promise<boolean>;
};

export const runLongTermCompaction = async (
  deps: RunLongTermCompactionDeps,
  input: {
    retentionConfig: KthxRetentionConfig;
    streamRetentionMap: Record<StreamName, number>;
    archiveCompressFn: ArchiveCompressFn | null;
  },
): Promise<{ compactions: number; deletableArchiveIds: Set<string> }> => {
  const { stateDir, longTermArchiveItems } = deps;
  const { retentionConfig, streamRetentionMap, archiveCompressFn } = input;
  const deletableArchiveIds = new Set<string>();
  if (retentionConfig.longTerm.enabled !== true) {
    return { compactions: 0, deletableArchiveIds };
  }

  const knownCapsuleIds = new Set(longTermArchiveItems.map((item) => item.id));
  const nowMs = Date.now();
  const candidates: Array<{ stream: StreamName; index: ArchiveIndex; ageMs: number }> = [];

  for (const stream of Object.keys(streamRetentionMap) as StreamName[]) {
    const maxDays = streamRetentionMap[stream] ?? 365;
    const cutoffMs = maxDays * 86_400_000;
    const indexes = await listArchiveIndexes({
      stateDir,
      stream,
    });
    for (const index of indexes) {
      const maxAtMs = index.receivedAtMax ? Date.parse(index.receivedAtMax) : NaN;
      if (!Number.isFinite(maxAtMs)) continue;
      const ageMs = nowMs - maxAtMs;
      if (ageMs <= cutoffMs) continue;
      const archiveId = getLongTermCapsuleId(stream, index.archiveBasename);
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
    const ok = await deps.compactArchiveIndexToLongTerm({
      stream: candidate.stream,
      index: candidate.index,
      retentionConfig,
      archiveCompressFn,
    });
    const archiveId = getLongTermCapsuleId(
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
};
