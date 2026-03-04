import {
  type RetrievalPresetTopParticipantMetric,
} from "../memory/retrieval-presets.js";

import {
  formatRangeLabelFromMs,
  type KeywordIndexDoc,
  type KeywordIndexSnapshot,
  type LongTermArchiveIndexSnapshot,
  metricValueFromParticipant,
  normalizeParticipantToken,
  parseMetricsBucketMsFromQuery,
  parsePostAndCommentHints,
  type RetrievalIntent,
  resolveMemorySourceMetric,
  tokenizeRetrievalText,
} from "./health-web-shared.js";

export const buildMemoryMapDiagnostics = (input: {
  index: KeywordIndexSnapshot;
  longTermIndex: LongTermArchiveIndexSnapshot;
  rangeMs: number;
  metric: RetrievalPresetTopParticipantMetric;
  limit: number;
  postId: number | null;
  commentId: number | null;
  intent: RetrievalIntent;
  query: string;
}): Record<string, unknown> => {
  const nowMs = Date.now();
  const safeRangeMs = Math.max(60_000, Math.min(366 * 86_400_000, input.rangeMs));
  const sinceMs = nowMs - safeRangeMs;
  const rangeLabel = formatRangeLabelFromMs(safeRangeMs);
  const safeLimit = Math.max(3, Math.min(100, Math.floor(input.limit)));
  const query = input.query.trim();
  const queryHints = parsePostAndCommentHints(query);
  const scopedPostId = input.postId ?? queryHints.postId;
  const scopedCommentId = input.commentId ?? queryHints.commentId;
  const queryTokens = tokenizeRetrievalText(query).slice(0, 16);

  const candidateDocs = Object.values(input.index.docs)
    .map((doc) => ({ doc, atMs: Date.parse(doc.receivedAt) }))
    .filter((entry) => Number.isFinite(entry.atMs))
    .filter((entry) => entry.atMs >= sinceMs && entry.atMs <= nowMs)
    .filter((entry) => {
      if (scopedPostId !== null && entry.doc.postId !== scopedPostId) return false;
      if (scopedCommentId !== null && entry.doc.commentId !== scopedCommentId) return false;
      return true;
    });

  const docMatchesQuery = (doc: KeywordIndexDoc): boolean => {
    if (!query.length) return true;
    const summaryLower = doc.summary.toLowerCase();
    const actorLower = (doc.actor ?? "").toLowerCase();
    const participantsLower = doc.participants.map((value) => value.toLowerCase());
    const keywordSet = new Set(doc.keywords);
    const matchesHints =
      (queryHints.postId !== null && doc.postId === queryHints.postId) ||
      (queryHints.commentId !== null && doc.commentId === queryHints.commentId);
    if (matchesHints) return true;
    if (!queryTokens.length) return true;
    for (const token of queryTokens) {
      if (keywordSet.has(token)) return true;
      if (summaryLower.includes(token)) return true;
      if (actorLower.includes(token)) return true;
      if (participantsLower.some((item) => item.includes(token))) return true;
    }
    return false;
  };

  const scopedDocs = candidateDocs.filter((entry) => docMatchesQuery(entry.doc));

  const participantStats = new Map<
    string,
    {
      participant: string;
      display: string;
      comments: number;
      likes: number;
      reposts: number;
      views: number;
      notifications: number;
      presence: number;
      docs: number;
      combined: number;
      lastAt: string | null;
      postCounts: Map<number, number>;
      commentCounts: Map<number, number>;
    }
  >();
  const postStats = new Map<
    number,
    {
      postId: number;
      comments: number;
      likes: number;
      reposts: number;
      views: number;
      notifications: number;
      docs: number;
      participants: Set<string>;
      lastAt: string | null;
      latestSummary: string | null;
    }
  >();
  const commentStats = new Map<
    number,
    {
      commentId: number;
      postId: number | null;
      comments: number;
      likes: number;
      reposts: number;
      views: number;
      notifications: number;
      docs: number;
      participants: Set<string>;
      lastAt: string | null;
      latestSummary: string | null;
    }
  >();
  const sourceCounts = new Map<string, number>();
  const nodeWeights = new Map<string, number>();
  const edgeWeights = new Map<string, number>();
  const bucketMs = parseMetricsBucketMsFromQuery(
    new URLSearchParams([
      ["bucket", safeRangeMs <= 2 * 24 * 3_600_000 ? "1h" : "1d"],
    ]),
    safeRangeMs,
  );
  const timeline = new Map<
    number,
    {
      bucketAt: string;
      comments: number;
      likes: number;
      reposts: number;
      views: number;
      notifications: number;
      total: number;
      docs: number;
      uniqueParticipants: number;
    }
  >();

  const sortedDocEntries = [...scopedDocs].sort((a, b) =>
    a.atMs < b.atMs ? -1 : a.atMs > b.atMs ? 1 : 0,
  );

  for (const entry of sortedDocEntries) {
    const sourceType = entry.doc.sourceType ?? "event";
    sourceCounts.set(sourceType, (sourceCounts.get(sourceType) ?? 0) + 1);
    const sourceMetric = resolveMemorySourceMetric(sourceType);
    const participants = new Set<string>();
    if (entry.doc.actor) {
      const normalizedActor = normalizeParticipantToken(entry.doc.actor);
      if (normalizedActor) participants.add(normalizedActor);
    }
    for (const rawParticipant of entry.doc.participants) {
      const normalized = normalizeParticipantToken(rawParticipant);
      if (normalized) participants.add(normalized);
    }
    const participantList = [...participants].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    for (const participant of participantList) {
      const current =
        participantStats.get(participant) ??
        {
          participant,
          display: participant.startsWith("id:")
            ? participant.slice(3)
            : participant,
          comments: 0,
          likes: 0,
          reposts: 0,
          views: 0,
          notifications: 0,
          presence: 0,
          docs: 0,
          combined: 0,
          lastAt: null,
          postCounts: new Map<number, number>(),
          commentCounts: new Map<number, number>(),
        };
      current.docs += 1;
      current.presence += 1;
      if (sourceMetric) current[sourceMetric] += 1;
      if (
        current.lastAt === null ||
        (entry.doc.receivedAt && current.lastAt < entry.doc.receivedAt)
      ) {
        current.lastAt = entry.doc.receivedAt;
      }
      if (typeof entry.doc.postId === "number") {
        current.postCounts.set(
          entry.doc.postId,
          (current.postCounts.get(entry.doc.postId) ?? 0) + 1,
        );
      }
      if (typeof entry.doc.commentId === "number") {
        current.commentCounts.set(
          entry.doc.commentId,
          (current.commentCounts.get(entry.doc.commentId) ?? 0) + 1,
        );
      }
      participantStats.set(participant, current);
      nodeWeights.set(participant, (nodeWeights.get(participant) ?? 0) + 1);
    }

    if (participantList.length >= 2) {
      const safeParticipants = participantList.slice(0, 12);
      for (let i = 0; i < safeParticipants.length; i += 1) {
        for (let j = i + 1; j < safeParticipants.length; j += 1) {
          const a = safeParticipants[i] ?? "";
          const b = safeParticipants[j] ?? "";
          if (!a || !b) continue;
          const key = `${a}|${b}`;
          edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1);
        }
      }
    }

    if (typeof entry.doc.postId === "number") {
      const post =
        postStats.get(entry.doc.postId) ??
        {
          postId: entry.doc.postId,
          comments: 0,
          likes: 0,
          reposts: 0,
          views: 0,
          notifications: 0,
          docs: 0,
          participants: new Set<string>(),
          lastAt: null,
          latestSummary: null,
        };
      post.docs += 1;
      if (sourceMetric) post[sourceMetric] += 1;
      for (const participant of participantList) {
        post.participants.add(participant);
      }
      if (post.lastAt === null || post.lastAt < entry.doc.receivedAt) {
        post.lastAt = entry.doc.receivedAt;
        post.latestSummary = entry.doc.summary;
      }
      postStats.set(entry.doc.postId, post);
    }

    if (typeof entry.doc.commentId === "number") {
      const comment =
        commentStats.get(entry.doc.commentId) ??
        {
          commentId: entry.doc.commentId,
          postId: entry.doc.postId,
          comments: 0,
          likes: 0,
          reposts: 0,
          views: 0,
          notifications: 0,
          docs: 0,
          participants: new Set<string>(),
          lastAt: null,
          latestSummary: null,
        };
      comment.docs += 1;
      if (sourceMetric) comment[sourceMetric] += 1;
      for (const participant of participantList) {
        comment.participants.add(participant);
      }
      if (comment.lastAt === null || comment.lastAt < entry.doc.receivedAt) {
        comment.lastAt = entry.doc.receivedAt;
        comment.latestSummary = entry.doc.summary;
      }
      commentStats.set(entry.doc.commentId, comment);
    }

    const bucketStartMs = Math.floor(entry.atMs / bucketMs) * bucketMs;
    const bucket =
      timeline.get(bucketStartMs) ??
      {
        bucketAt: new Date(bucketStartMs).toISOString(),
        comments: 0,
        likes: 0,
        reposts: 0,
        views: 0,
        notifications: 0,
        total: 0,
        docs: 0,
        uniqueParticipants: 0,
      };
    bucket.docs += 1;
    bucket.uniqueParticipants += participantList.length;
    if (sourceMetric) bucket[sourceMetric] += 1;
    bucket.total += 1;
    timeline.set(bucketStartMs, bucket);
  }

  const selectTopId = (counts: Map<number, number>): number | null => {
    let bestId: number | null = null;
    let bestCount = -1;
    for (const [id, count] of counts.entries()) {
      if (count > bestCount) {
        bestId = id;
        bestCount = count;
      }
    }
    return bestId;
  };

  const participantLeaders = [...participantStats.values()]
    .map((participant) => {
      participant.combined =
        participant.comments * 4 +
        participant.likes * 2 +
        participant.reposts * 3 +
        participant.views +
        participant.notifications * 2 +
        participant.presence;
      const metricScore = metricValueFromParticipant(participant, input.metric);
      return {
        participant: participant.participant,
        display: participant.display,
        metricScore,
        comments: participant.comments,
        likes: participant.likes,
        reposts: participant.reposts,
        views: participant.views,
        notifications: participant.notifications,
        presence: participant.presence,
        docs: participant.docs,
        combined: participant.combined,
        lastAt: participant.lastAt,
        topPostId: selectTopId(participant.postCounts),
        topCommentId: selectTopId(participant.commentCounts),
      };
    })
    .sort((a, b) =>
      b.metricScore !== a.metricScore
        ? b.metricScore - a.metricScore
        : b.combined !== a.combined
          ? b.combined - a.combined
          : (b.lastAt ?? "") < (a.lastAt ?? "")
            ? -1
            : 1,
    )
    .slice(0, safeLimit);

  const topPosts = [...postStats.values()]
    .map((post) => {
      const combined =
        post.comments * 4 +
        post.likes * 2 +
        post.reposts * 3 +
        post.views +
        post.notifications * 2 +
        post.docs;
      return {
        postId: post.postId,
        comments: post.comments,
        likes: post.likes,
        reposts: post.reposts,
        views: post.views,
        notifications: post.notifications,
        docs: post.docs,
        participantCount: post.participants.size,
        combined,
        lastAt: post.lastAt,
        summary: post.latestSummary,
      };
    })
    .sort((a, b) =>
      b.combined !== a.combined
        ? b.combined - a.combined
        : (b.lastAt ?? "") < (a.lastAt ?? "")
          ? -1
          : 1,
    )
    .slice(0, safeLimit);

  const topComments = [...commentStats.values()]
    .map((comment) => {
      const combined =
        comment.comments * 4 +
        comment.likes * 2 +
        comment.reposts * 3 +
        comment.views +
        comment.notifications * 2 +
        comment.docs;
      return {
        commentId: comment.commentId,
        postId: comment.postId,
        comments: comment.comments,
        likes: comment.likes,
        reposts: comment.reposts,
        views: comment.views,
        notifications: comment.notifications,
        docs: comment.docs,
        participantCount: comment.participants.size,
        combined,
        lastAt: comment.lastAt,
        summary: comment.latestSummary,
      };
    })
    .sort((a, b) =>
      b.combined !== a.combined
        ? b.combined - a.combined
        : (b.lastAt ?? "") < (a.lastAt ?? "")
          ? -1
          : 1,
    )
    .slice(0, safeLimit);

  const sourceDistribution = [...sourceCounts.entries()]
    .map(([sourceType, count]) => ({ sourceType, count }))
    .sort((a, b) => b.count - a.count);

  const networkNodeSet = new Set(
    participantLeaders.slice(0, Math.max(10, Math.min(40, safeLimit * 2))).map((entry) => entry.participant),
  );
  const networkNodes = participantLeaders
    .filter((entry) => networkNodeSet.has(entry.participant))
    .map((entry) => ({
      id: entry.participant,
      label: entry.display,
      score: entry.metricScore,
      combined: entry.combined,
      weight: nodeWeights.get(entry.participant) ?? 0,
    }));
  const networkEdges = [...edgeWeights.entries()]
    .map(([pair, weight]) => {
      const [source, target] = pair.split("|");
      return { source: source ?? "", target: target ?? "", weight };
    })
    .filter(
      (edge) =>
        edge.source.length > 0 &&
        edge.target.length > 0 &&
        networkNodeSet.has(edge.source) &&
        networkNodeSet.has(edge.target),
    )
    .sort((a, b) => b.weight - a.weight)
    .slice(0, Math.max(20, Math.min(200, safeLimit * 5)));

  const timelineRows = [...timeline.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => row);

  const archiveTop = input.longTermIndex.items
    .map((capsule) => {
      const matchedKeywords =
        queryTokens.length > 0
          ? capsule.keywords.filter((keyword) => queryTokens.includes(keyword))
          : [];
      const matchedPost =
        scopedPostId !== null && capsule.postIds.includes(scopedPostId);
      const matchedComment =
        scopedCommentId !== null && capsule.commentIds.includes(scopedCommentId);
      const include =
        query.length === 0 ||
        matchedKeywords.length > 0 ||
        matchedPost ||
        matchedComment;
      if (!include) return null;
      const compactedAtMs = Date.parse(capsule.compactedAt);
      const ageDays =
        Number.isFinite(compactedAtMs) && compactedAtMs <= nowMs
          ? (nowMs - compactedAtMs) / 86_400_000
          : 365;
      const recencyScore = 1 / (1 + Math.max(0, ageDays / 30));
      const score =
        matchedKeywords.length * 2.1 +
        (matchedPost ? 4.5 : 0) +
        (matchedComment ? 5 : 0) +
        recencyScore * 1.4 +
        Math.min(capsule.eventCount / 80, 3);
      return {
        id: capsule.id,
        stream: capsule.stream,
        compactedAt: capsule.compactedAt,
        eventCount: capsule.eventCount,
        compressedBy: capsule.compressedBy,
        summary: capsule.summary,
        matchedKeywords,
        score: Number.parseFloat(score.toFixed(2)),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : b.compactedAt < a.compactedAt
          ? -1
          : 1,
    )
    .slice(0, safeLimit);

  const totalParticipants = participantStats.size;
  const totalPosts = postStats.size;
  const totalComments = commentStats.size;
  const biggestParticipant = participantLeaders[0] ?? null;

  return {
    range: {
      label: rangeLabel,
      maxAgeMs: safeRangeMs,
      from: new Date(sinceMs).toISOString(),
      to: new Date(nowMs).toISOString(),
      bucketMs,
    },
    filters: {
      query: query.length > 0 ? query : null,
      tokens: queryTokens,
      metric: input.metric,
      intent: input.intent,
      postId: scopedPostId,
      commentId: scopedCommentId,
      limit: safeLimit,
    },
    totals: {
      docsInRange: candidateDocs.length,
      docsMatched: scopedDocs.length,
      participants: totalParticipants,
      posts: totalPosts,
      comments: totalComments,
      sources: sourceDistribution.length,
    },
    biggestParticipant,
    sourceDistribution,
    participantLeaders,
    topPosts,
    topComments,
    timeline: timelineRows,
    network: {
      nodes: networkNodes,
      edges: networkEdges,
    },
    archive: {
      capsules: input.longTermIndex.items.length,
      matched: archiveTop.length,
      top: archiveTop,
    },
  };
};
