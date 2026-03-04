import type {
  ContextBundle,
  ContextRequest,
  LongTermArchiveCapsule,
  RetrievalLookupPlan,
} from "~/types/memory.js";
import { toShortLine } from "~/lib/text.js";
import { buildRetrievalPresets } from "./retrieval-presets.js";
import {
  LONG_TERM_RETENTION_SOURCE_WEIGHT,
  RETRIEVAL_MAX_AGE_HOURS_BY_INTENT,
  RETRIEVAL_SOURCE_WEIGHT_BY_INTENT,
  asFinitePositiveInt,
  asNullableString,
  buildDefaultLookupPlansForDoc,
  resolveRetrievalIntent,
  tokenizeKeywordText,
  type KeywordMemoryIndex,
} from "./store-helpers.js";

const buildLongTermRetrievalLines = (input: {
  intent: "chat" | "directive" | "engagement";
  keywords: string[];
  postId: number | null;
  commentId: number | null;
  maxItems: number;
  longTermArchiveItems: LongTermArchiveCapsule[];
}): string[] => {
  const {
    intent,
    keywords,
    postId,
    commentId,
    maxItems,
    longTermArchiveItems,
  } = input;
  if (!longTermArchiveItems.length) return [];
  const nowMs = Date.now();
  const scored: Array<{ capsule: LongTermArchiveCapsule; score: number }> = [];

  for (const capsule of longTermArchiveItems) {
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
};

export const buildViewSummary = (input: {
  request: ContextRequest;
  viewState: {
    items: Record<
      string,
      {
        status: "unviewed" | "viewed";
        receivedAt: string;
        firstSeenAt: string;
        lastSeenAt: string;
        seenCount: number;
        postId: number | null;
        commentId: number | null;
        sourceType: string | null;
        lastTopic: string | null;
      }
    >;
  };
}): ContextBundle["view"] => {
  const { request, viewState } = input;
  const hasTarget =
    typeof request.postId === "number" || typeof request.commentId === "number";
  const includeRequested = request.includeViewState === true;
  const relevant = includeRequested || hasTarget;
  if (!relevant) {
    return { enabled: false, relevant: false, lines: [] };
  }

  const maxItemsRaw =
    typeof request.viewStateMaxItems === "number" &&
    Number.isFinite(request.viewStateMaxItems)
      ? Math.floor(request.viewStateMaxItems)
      : 8;
  const maxItems = Math.max(1, Math.min(24, maxItemsRaw));
  const lines: string[] = [];
  const entries = Object.entries(viewState.items);
  const sortByRecent = (
    a: [
      string,
      {
        status: "unviewed" | "viewed";
        receivedAt: string;
        firstSeenAt: string;
        lastSeenAt: string;
        seenCount: number;
        postId: number | null;
        commentId: number | null;
        sourceType: string | null;
        lastTopic: string | null;
      },
    ],
    b: [
      string,
      {
        status: "unviewed" | "viewed";
        receivedAt: string;
        firstSeenAt: string;
        lastSeenAt: string;
        seenCount: number;
        postId: number | null;
        commentId: number | null;
        sourceType: string | null;
        lastTopic: string | null;
      },
    ],
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
    const postEntry = viewState.items[`post:${request.postId}`];
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
    const commentEntry = viewState.items[`comment:${request.commentId}`];
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
      lines.push(
        `${key} status=${item.status} seen=${item.seenCount} last=${item.lastSeenAt}`,
      );
    }
  }

  return { enabled: true, relevant: true, lines };
};

export const buildRetrievalSummary = (input: {
  request: ContextRequest;
  keywordIndex: Pick<KeywordMemoryIndex, "docs" | "inverted">;
  longTermArchiveItems: LongTermArchiveCapsule[];
}): ContextBundle["retrieval"] => {
  const { request, keywordIndex, longTermArchiveItems } = input;

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
    docs: Object.values(keywordIndex.docs),
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
  const longTermLines = buildLongTermRetrievalLines({
    intent,
    keywords,
    postId: typeof request.postId === "number" ? request.postId : null,
    commentId: typeof request.commentId === "number" ? request.commentId : null,
    maxItems: Math.max(2, Math.min(6, maxItems)),
    longTermArchiveItems,
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
    const docIds = keywordIndex.inverted[keyword] ?? [];
    for (const docId of docIds.slice(0, 120)) {
      candidateScores.set(docId, (candidateScores.get(docId) ?? 0) + 2);
    }
  }

  if (hasTarget) {
    const targetMatchBoost = intent === "directive" ? 8 : intent === "engagement" ? 7 : 6;
    for (const [docId, doc] of Object.entries(keywordIndex.docs)) {
      const matchesComment =
        typeof request.commentId === "number" && doc.commentId === request.commentId;
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

  const mentionHandles = Array.from(baseQuery.matchAll(/@([a-z0-9_.-]+)/giu))
    .map((match) => (match[1] ?? "").trim().toLowerCase())
    .filter((token) => token.length > 0);

  const nowMs = Date.now();
  const sourceWeightMap = RETRIEVAL_SOURCE_WEIGHT_BY_INTENT[intent];
  const maxAgeHours = RETRIEVAL_MAX_AGE_HOURS_BY_INTENT[intent];
  const scored: Array<{
    doc: KeywordMemoryIndex["docs"][string];
    score: number;
  }> = [];

  for (const [docId, baseScore] of candidateScores.entries()) {
    const doc = keywordIndex.docs[docId];
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
    if (typeof request.commentId === "number" && doc.commentId === request.commentId) {
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
  lines.push(`intent=${intent} keywords=${keywordLabel} hits=${scored.length}`);

  for (const item of scored.slice(0, maxItems)) {
    const postToken =
      typeof item.doc.postId === "number" ? `post:${item.doc.postId}` : "";
    const commentToken =
      typeof item.doc.commentId === "number" ? `comment:${item.doc.commentId}` : "";
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
};
