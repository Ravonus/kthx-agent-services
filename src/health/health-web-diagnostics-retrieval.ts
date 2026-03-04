import { buildRetrievalPresets } from "../memory/retrieval-presets.js";

import {
  escapeRegExp,
  type KeywordIndexDoc,
  type KeywordIndexSnapshot,
  type LongTermArchiveCapsule,
  type LongTermArchiveIndexSnapshot,
  LONG_TERM_SOURCE_WEIGHT_BY_INTENT,
  parsePostAndCommentHints,
  RETRIEVAL_MAX_AGE_HOURS_BY_INTENT,
  RETRIEVAL_SOURCE_WEIGHT_BY_INTENT,
  type RetrievalIntent,
  str,
  tokenizeRetrievalText,
} from "./health-web-shared.js";

export const buildRetrievalDiagnostics = (input: {
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
