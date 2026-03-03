/**
 * Engagement target resolution — discovers and selects the best post/comment
 * target for an engagement action (comment, like, repost).
 */

import type {
  EngagementTargetCandidate,
  EngagementLookupHints,
  EngagementResolutionTrace,
  RecentCommentTargetUsage,
  CommentTargetReuseDecision,
  ContextRequest,
} from "../types.js";

import {
  asNonEmptyString,
  asPositiveInt,
  normalizeInterestTagToken,
  truncateText,
} from "../helpers.js";

import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";

import { collectBridgeRecordItems } from "../generate/generate-input.js";
import { ENGAGEMENT_TARGET_CACHE_TTL_MS } from "../constants.js";

import {
  computePostSnapshotHash,
  isOwnEngagementCandidate,
} from "./engagement-helpers.js";

import {
  resolvePostSnapshotHashForPostId,
  resolveCommentAuthorIdForTarget,
} from "./engagement-context.js";

import {
  extractPostRecordForCommentCuration,
} from "../write/comment-curation.js";

import {
  createEngagementCandidatePool,
  parseNotificationTargets,
  parseMentionTargets,
  scoreCandidate,
  PREFERRED_SOURCE_ORDER_COMMENT,
  PREFERRED_SOURCE_ORDER_ENGAGEMENT,
} from "./engagement-candidate-pool.js";
import type { LookupPlan } from "./engagement-candidate-pool.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChatBridgeFn = (input: unknown) => Promise<unknown>;
type BridgeLookupCache = Map<string, { expiresAtMs: number; value: unknown }>;

type MemoryWithContext = {
  recordWrite(entry: unknown): Promise<void>;
  buildContext?: (request: ContextRequest) => Promise<{
    target?: { events?: unknown[] };
    recent?: unknown[];
    archive?: unknown[];
    retrieval?: { lines?: unknown[]; lookupPlans?: unknown[] };
  }>;
};

export type EngagementTargetResolutionDeps = {
  callAgentChatBridge: ChatBridgeFn | null;
  bridgeLookupCache: BridgeLookupCache;
  memory: MemoryWithContext;
  engagementTargetCache: Map<string, { expiresAtMs: number; candidate: EngagementTargetCandidate }>;
  callAgentBridgeLookupCached: (
    payload: Record<string, unknown>,
    ttlMs?: number,
  ) => Promise<{ value: unknown; cacheHit: boolean }>;
  extractEngagementLookupHints: (payload: Record<string, unknown>) => EngagementLookupHints;
  buildEngagementTargetCacheKey: (input: {
    action: "comment" | "like" | "repost";
    payload: Record<string, unknown>;
    hints: EngagementLookupHints;
  }) => string;
  pruneEngagementTargetCache: (nowMs: number) => void;
  listRecentCommentTargetUsage: () => RecentCommentTargetUsage[];
  decideCommentTargetReuse: (input: {
    commandId: string;
    postId: number;
    commentId: number | null;
    postSnapshotHash: string | null;
    source: string;
    recentUsage: RecentCommentTargetUsage[];
  }) => CommentTargetReuseDecision;
  parseTargetIdsFromTextLine: (text: string) => { postId: number | null; commentId: number | null };
  shouldIncludeOwnLatestCommentLookup: (input: {
    rawQuery: string;
    explicitPostId: number | null;
    explicitCommentId: number | null;
  }) => boolean;
  isOwnEngagementCandidate: (candidate: EngagementTargetCandidate, agentMainUserId: string | null) => boolean;
  shouldAllowRareTopLevelSelfComment: (input: {
    commandId: string;
    postId: number;
    rawQuery: string;
  }) => { allow: boolean; reason: string; gateRoll: number };
};

// ---------------------------------------------------------------------------
// resolveEngagementTargetForDirective
// ---------------------------------------------------------------------------

export async function resolveEngagementTargetForDirective(
  deps: EngagementTargetResolutionDeps,
  input: {
    payload: Record<string, unknown>;
    action: "comment" | "like" | "repost";
    commandId: string;
  },
): Promise<EngagementTargetCandidate | null> {
  // ── S1: Explicit target from directive payload ──────────────────────
  const scopedDirective = isRecord(input.payload.directiveScope)
    ? input.payload.directiveScope
    : null;
  const scopedTarget = scopedDirective && isRecord(scopedDirective.target)
    ? scopedDirective.target
    : null;
  const explicitPostId =
    asPositiveInt(input.payload.postId) ??
    asPositiveInt(input.payload.targetPostId) ??
    (scopedDirective
      ? asPositiveInt(scopedDirective.targetPostId) ??
        (scopedTarget ? asPositiveInt(scopedTarget.postId) : null)
      : null);
  const explicitCommentId =
    asPositiveInt(input.payload.parentId) ??
    asPositiveInt(input.payload.commentId) ??
    asPositiveInt(input.payload.targetCommentId) ??
    (scopedDirective
      ? asPositiveInt(scopedDirective.targetCommentId) ??
        (scopedTarget ? asPositiveInt(scopedTarget.commentId) : null)
      : null);
  if (explicitPostId) {
    const explicitResolvedCommentId =
      input.action === "comment" ? (explicitCommentId ?? null) : null;
    const postSnapshotHash = await resolvePostSnapshotHashForPostId(
      { callAgentChatBridge: deps.callAgentChatBridge, bridgeLookupCache: deps.bridgeLookupCache },
      { postId: explicitPostId, commentId: explicitResolvedCommentId },
    );
    return {
      postId: explicitPostId,
      commentId: explicitResolvedCommentId,
      authorId: null,
      source: "directive_payload",
      postSnapshotHash,
    };
  }

  // ── S2: Hinted target from payload ─────────────────────────────────
  const hints = deps.extractEngagementLookupHints(input.payload);
  const hintedPostId = hints.postId;
  const hintedCommentId = hints.commentId;
  if (hintedPostId) {
    const hintedResolvedCommentId = input.action === "comment" ? hintedCommentId : null;
    const postSnapshotHash = await resolvePostSnapshotHashForPostId(
      { callAgentChatBridge: deps.callAgentChatBridge, bridgeLookupCache: deps.bridgeLookupCache },
      { postId: hintedPostId, commentId: hintedResolvedCommentId },
    );
    return {
      postId: hintedPostId,
      commentId: hintedResolvedCommentId,
      authorId: null,
      source: "payload_hint",
      postSnapshotHash,
    };
  }

  // ── S3: Cache check ────────────────────────────────────────────────
  const hasBridge = Boolean(deps.callAgentChatBridge);

  const cacheKey = deps.buildEngagementTargetCacheKey({
    action: input.action,
    payload: input.payload,
    hints,
  });
  const recentCommentUsage =
    input.action === "comment" ? deps.listRecentCommentTargetUsage() : [];
  const nowMs = Date.now();
  deps.pruneEngagementTargetCache(nowMs);
  const cachedResolution = deps.engagementTargetCache.get(cacheKey);
  if (cachedResolution && cachedResolution.expiresAtMs > nowMs) {
    if (input.action === "comment") {
      const reuseDecision = deps.decideCommentTargetReuse({
        commandId: input.commandId,
        postId: cachedResolution.candidate.postId,
        commentId: cachedResolution.candidate.commentId ?? null,
        postSnapshotHash: cachedResolution.candidate.postSnapshotHash ?? null,
        source: cachedResolution.candidate.source,
        recentUsage: recentCommentUsage,
      });
      if (!reuseDecision.allow) {
        deps.engagementTargetCache.delete(cacheKey);
        await deps.memory
          .recordWrite({
            type: "engagement_target_cache_skipped_recent_comment_target",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            postId: cachedResolution.candidate.postId,
            commentId: cachedResolution.candidate.commentId ?? null,
            source: cachedResolution.candidate.source,
            postSnapshotHash: cachedResolution.candidate.postSnapshotHash ?? null,
            reason: reuseDecision.reason,
            recentCommandId: reuseDecision.recentMatch?.commandId ?? null,
            recentPostId: reuseDecision.recentMatch?.postId ?? null,
            recentCommentId: reuseDecision.recentMatch?.commentId ?? null,
            recentPostSnapshotHash: reuseDecision.recentMatch?.postSnapshotHash ?? null,
          })
          .catch(() => undefined);
      } else {
        return {
          ...cachedResolution.candidate,
          commentId: cachedResolution.candidate.commentId ?? null,
        };
      }
    } else {
      return {
        ...cachedResolution.candidate,
        commentId: null,
      };
    }
  }

  // ── S4: Create candidate pool & run discovery stages ───────────────
  const pool = createEngagementCandidatePool(
    {
      callAgentBridgeLookupCached: deps.callAgentBridgeLookupCached,
      memory: deps.memory,
    },
    { action: input.action, commandId: input.commandId, hasBridge },
  );

  // Agent profile resolution
  let agentMainUserId: string | null = null;
  let agentHandle: string | null = null;
  let agentPreferenceTags: string[] = [];
  if (hasBridge) {
    const profileResult = await deps.callAgentBridgeLookupCached({
      action: "agent_profile",
    }).catch((error: unknown) => {
      pool.incrementBridgeFailure();
      void deps.memory
        .recordWrite({
          type: "engagement_target_lookup_failed",
          at: nowIso(),
          commandId: input.commandId,
          action: input.action,
          step: "agent_profile",
          source: "agent_profile",
          lookupAction: "agent_profile",
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return null;
    });
    if (profileResult) {
      pool.incrementBridgeSuccess();
      const profileRecord = isRecord(profileResult.value) ? profileResult.value : null;
      if (profileRecord && isRecord(profileRecord.agent)) {
        const agentRecord = profileRecord.agent;
        agentMainUserId = asNonEmptyString(agentRecord.mainUserId) ?? null;
        agentHandle =
          asNonEmptyString(agentRecord.handle)?.replace(/^@+/u, "").toLowerCase() ??
          null;
        const agentPreferredTags = Array.isArray(agentRecord.preferredTags)
          ? (agentRecord.preferredTags as unknown[])
          : [];
        const profilePreferredTags = Array.isArray(profileRecord.preferredTags)
          ? (profileRecord.preferredTags as unknown[])
          : [];
        const configPreferredTags =
          isRecord(profileRecord.config) && Array.isArray(profileRecord.config.preferredTags)
            ? (profileRecord.config.preferredTags as unknown[])
            : [];
        agentPreferenceTags = Array.from(
          new Set(
            [
              ...agentPreferredTags,
              ...profilePreferredTags,
              ...configPreferredTags,
            ]
              .map((value) => normalizeInterestTagToken(value))
              .filter((value): value is string => Boolean(value)),
          ),
        ).slice(0, 8);
      }
      pool.pushTrace({
        step: "agent_profile",
        queryCount: 1,
        cacheHits: profileResult.cacheHit ? 1 : 0,
        addedCandidates: 0,
        totalCandidates: 0,
      });
    }
  }

  // ── S5: Notification discovery ─────────────────────────────────────
  if (hasBridge) {
    await pool.runLookupStep("notifications_priority", [
      {
        source: "notifications_unread",
        request: {
          action: "browse_notifications",
          unreadOnly: true,
          limit: 24,
        },
        parser: (value: unknown): EngagementTargetCandidate[] =>
          parseNotificationTargets(value, "notifications_unread", input.action),
      },
      {
        source: "notifications_recent",
        request: {
          action: "browse_notifications",
          unreadOnly: false,
          limit: 24,
        },
        parser: (value: unknown): EngagementTargetCandidate[] =>
          parseNotificationTargets(value, "notifications_recent", input.action),
      },
    ]);
  }

  // ── S6: Memory context ─────────────────────────────────────────────
  if (typeof deps.memory.buildContext === "function") {
    try {
      const request: ContextRequest = {
        mode: "engagement",
        audience: "runtime_write",
        maxRecentEvents: 80,
        maxArchiveEvents: 40,
        includeKeywordRetrieval: true,
        retrievalIntent: "engagement",
        retrievalMaxItems: 12,
        retrievalQuery: [
          input.action,
          hints.rawQuery,
          "target resolution",
        ]
          .filter((entry) => entry.trim().length > 0)
          .join(" · "),
      };
      const bundle = await deps.memory.buildContext(request);
      const before = pool.getCandidates().length;
      const envelopes = [
        ...(Array.isArray(bundle.target?.events) ? bundle.target.events : []),
        ...(Array.isArray(bundle.recent) ? bundle.recent : []),
        ...(Array.isArray(bundle.archive) ? bundle.archive : []),
      ];
      for (const envelope of envelopes) {
        if (!isRecord(envelope) || !isRecord(envelope.payload)) continue;
        pool.pushCandidate(
          extractEngagementTargetCandidateFromRecordDirect(
            envelope.payload,
            "memory_event",
          ),
        );
      }
      if (isRecord(bundle.retrieval) && Array.isArray(bundle.retrieval.lines)) {
        for (const line of bundle.retrieval.lines) {
          if (typeof line !== "string") continue;
          const parsedIds = deps.parseTargetIdsFromTextLine(line);
          if (!parsedIds.postId) continue;
          pool.pushCandidate({
            postId: parsedIds.postId,
            commentId: input.action === "comment" ? (parsedIds.commentId ?? null) : null,
            authorId: null,
            source: "memory_retrieval",
            postSnapshotHash: null,
          });
        }
      }
      if (
        isRecord(bundle.retrieval) &&
        Array.isArray(bundle.retrieval.lookupPlans)
      ) {
        for (const plan of bundle.retrieval.lookupPlans) {
          if (!isRecord(plan)) continue;
          const args = isRecord(plan.args) ? plan.args : null;
          if (!args) continue;
          const postId = asPositiveInt(args.postId);
          const commentId = asPositiveInt(args.commentId) ?? null;
          if (!postId) continue;
          pool.pushCandidate({
            postId,
            commentId:
              input.action === "comment" ? (commentId ?? null) : null,
            authorId: null,
            source: "memory_lookup_plan",
            postSnapshotHash: null,
          });
        }
      }
      pool.pushTrace({
        step: "memory_context",
        queryCount: 1,
        cacheHits: 0,
        addedCandidates: pool.getCandidates().length - before,
        totalCandidates: pool.getCandidates().length,
      });
    } catch (error: unknown) {
      await deps.memory
        .recordWrite({
          type: "engagement_target_lookup_failed",
          at: nowIso(),
          commandId: input.commandId,
          action: input.action,
          step: "memory_context",
          source: "memory",
          lookupAction: "buildContext",
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
    }
  }

  // ── S7: Payload hints & high-signal lookups ────────────────────────
  const hintPlans: LookupPlan[] = [];
  if (hintedPostId) {
    hintPlans.push({
      source: "hint_post_lookup",
      request: { action: "find_post", postId: hintedPostId },
    });
  }
  for (const handle of hints.handles.slice(0, 4)) {
    hintPlans.push({
      source: "hint_handle_latest",
      request: {
        action: "find_post",
        authorHandle: `@${handle}`,
        latest: true,
      },
    });
  }
  await pool.runLookupStep("payload_hints", hintPlans);

  const discoveryTags = Array.from(
    new Set([...hints.interestTags, ...agentPreferenceTags]),
  ).slice(0, 8);
  const allowOwnLatestCommentLookup = deps.shouldIncludeOwnLatestCommentLookup({
    rawQuery: hints.rawQuery,
    explicitPostId,
    explicitCommentId,
  });
  const ownCommentPlans: LookupPlan[] = [];
  if (input.action === "comment" && agentHandle && allowOwnLatestCommentLookup) {
    ownCommentPlans.push({
      source: "own_latest",
      request: {
        action: "find_post",
        authorHandle: `@${agentHandle}`,
        latest: true,
      },
    });
  }
  ownCommentPlans.push({
    source: "unanswered_mention",
    request: {
      action: "browse_unanswered_mentions",
      limit: 24,
      sinceHours: 24 * 14,
    },
    parser: (value: unknown): EngagementTargetCandidate[] =>
      parseMentionTargets(value, input.action),
  });
  await pool.runLookupStep("high_signal", ownCommentPlans);

  // ── S8: Interest discovery ─────────────────────────────────────────
  const interestLookupPlans: LookupPlan[] = [];
  if (discoveryTags.length > 0) {
    interestLookupPlans.push(
      {
        source: "interest_trending",
        request: {
          action: "browse_trending",
          limit: 24,
          tags: discoveryTags.slice(0, 8),
        },
      },
      {
        source: "interest_explore",
        request: {
          action: "browse_posts",
          limit: 24,
          tags: discoveryTags.slice(0, 8),
        },
      },
    );
    const interestSearchQuery = truncateText(
      [hints.rawQuery, ...discoveryTags.slice(0, 4)]
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .join(" "),
      220,
    );
    if (interestSearchQuery.length > 2) {
      interestLookupPlans.push({
        source: "interest_search",
        request: {
          action: "search_global",
          query: interestSearchQuery,
          limit: 24,
          includePeople: false,
        },
      });
    }
  }
  await pool.runLookupStep("interest_discovery", interestLookupPlans);

  // ── S9: Top engagers & engagement network ──────────────────────────
  let topEngagerHandles: string[] = [];
  if (hasBridge) {
    const topEngagerResult = await deps.callAgentBridgeLookupCached({
      action: "browse_top_engagers",
      limit: 10,
      windowHours: 24 * 14,
    }).catch((error: unknown) => {
      pool.incrementBridgeFailure();
      void deps.memory
        .recordWrite({
          type: "engagement_target_lookup_failed",
          at: nowIso(),
          commandId: input.commandId,
          action: input.action,
          step: "browse_top_engagers",
          source: "browse_top_engagers",
          lookupAction: "browse_top_engagers",
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return null;
    });
    if (topEngagerResult) {
      pool.incrementBridgeSuccess();
      topEngagerHandles = collectBridgeRecordItems(topEngagerResult.value)
        .map((row) => {
          const user = isRecord(row.user) ? row.user : null;
          return asNonEmptyString(user?.handle) ?? asNonEmptyString(row.handle) ?? null;
        })
        .filter((entry): entry is string => Boolean(entry))
        .map((entry) => entry.replace(/^@+/u, "").toLowerCase())
        .slice(0, 4);
      pool.pushTrace({
        step: "browse_top_engagers",
        queryCount: 1,
        cacheHits: topEngagerResult.cacheHit ? 1 : 0,
        addedCandidates: 0,
        totalCandidates: pool.getCandidates().length,
      });
    }
  }
  const topEngagerPlans: LookupPlan[] = topEngagerHandles.map((handle) => ({
    source: "top_engager_latest",
    request: {
      action: "find_post",
      authorHandle: `@${handle}`,
      latest: true,
    },
  }));
  topEngagerPlans.push({
    source: "recent_actions",
    request: {
      action: "browse_recent_actions",
      limit: 18,
    },
  });
  await pool.runLookupStep("engagement_network", topEngagerPlans);

  // ── S10: Broad feed & search fallback ──────────────────────────────
  if (!pool.hasConfidentCandidate()) {
    await pool.runLookupStep("broad_feed", [
      {
        source: "home_feed",
        request: { action: "browse_home_feed", limit: 24 },
      },
      {
        source: "trending",
        request: { action: "browse_trending", limit: 24 },
      },
      {
        source: "explore",
        request: { action: "browse_posts", limit: 24 },
      },
    ]);
  }

  if (!pool.hasConfidentCandidate() && hints.rawQuery.trim().length > 2) {
    await pool.runLookupStep("search_global", [
      {
        source: "search_global",
        request: {
          action: "search_global",
          query: truncateText(hints.rawQuery, 220),
          limit: 24,
        },
      },
    ]);
  }

  // ── S11: No candidates → fail ──────────────────────────────────────
  const candidates = pool.getCandidates();
  const trace = pool.getTrace();
  const { bridgeQuerySuccessCount, bridgeQueryFailureCount } = pool.getBridgeCounts();

  if (candidates.length === 0) {
    await deps.memory
      .recordWrite({
        type: "engagement_target_resolution_failed",
        at: nowIso(),
        commandId: input.commandId,
        action: input.action,
        reason:
          bridgeQuerySuccessCount > 0
            ? "no_candidates_discovery_exhausted"
            : bridgeQueryFailureCount > 0
              ? "lookup_transient_failure"
              : hasBridge
                ? "no_candidates_unknown"
                : "bridge_unavailable",
        query: hints.rawQuery,
        bridgeQuerySuccessCount,
        bridgeQueryFailureCount,
        trace,
      })
      .catch(() => undefined);
    if (bridgeQuerySuccessCount > 0) {
      throw new Error("engagement_target_unavailable:no_targets_discovered");
    }
    return null;
  }

  // ── S12: Candidate hydration ───────────────────────────────────────
  const byTargetKey = new Map<string, EngagementTargetCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.postId}:${candidate.commentId ?? 0}`;
    byTargetKey.set(key, candidate);
  }
  const hydrationPool = [...byTargetKey.values()].slice(0, 10);
  await pool.runLookupStep(
    "candidate_hydration",
    hydrationPool.map((candidate) => ({
      source: "hydrate_find_post",
      request: {
        action: "find_post",
        postId: candidate.postId,
      },
      parser: (value: unknown): EngagementTargetCandidate[] => {
        const postRecord = extractPostRecordForCommentCuration(value, candidate.postId);
        if (!postRecord) return [];
        const author = isRecord(postRecord.author) ? postRecord.author : null;
        const authorId =
          asNonEmptyString(author?.mainUserId) ??
          asNonEmptyString(author?.id) ??
          asNonEmptyString(postRecord.authorId) ??
          candidate.authorId;
        const postSnapshotHash = computePostSnapshotHash({
          postId: candidate.postId,
          commentId: candidate.commentId,
          postRecord,
        });
        return [
          {
            ...candidate,
            authorId,
            source: candidate.source,
            postSnapshotHash: postSnapshotHash ?? candidate.postSnapshotHash ?? null,
          },
        ];
      },
    })),
  );

  // ── S13: Filter & rank candidates ──────────────────────────────────
  let candidatePool = [...candidates];
  if (input.action !== "comment") {
    const nonOwnCandidates = candidatePool.filter(
      (candidate) => !deps.isOwnEngagementCandidate(candidate, agentMainUserId),
    );
    if (nonOwnCandidates.length === 0) {
      await deps.memory
        .recordWrite({
          type: "engagement_target_resolution_failed",
          at: nowIso(),
          commandId: input.commandId,
          action: input.action,
          reason: "self_candidates_only",
          query: hints.rawQuery,
          bridgeQuerySuccessCount,
          bridgeQueryFailureCount,
          trace,
        })
        .catch(() => undefined);
      throw new Error("engagement_target_unavailable:no_targets_discovered:self_candidates_only");
    }
    candidatePool = nonOwnCandidates;
  }
  if (input.action === "comment") {
    const allowedCandidates: EngagementTargetCandidate[] = [];
    const filteredRecent: Array<{
      postId: number;
      commentId: number | null;
      source: string;
      reason: string;
      postSnapshotHash: string | null;
      recentPostSnapshotHash: string | null;
    }> = [];
    for (const candidate of candidatePool) {
      const reuseDecision = deps.decideCommentTargetReuse({
        commandId: input.commandId,
        postId: candidate.postId,
        commentId: candidate.commentId ?? null,
        postSnapshotHash: candidate.postSnapshotHash ?? null,
        source: candidate.source,
        recentUsage: recentCommentUsage,
      });
      if (reuseDecision.allow) {
        allowedCandidates.push(candidate);
        continue;
      }
      filteredRecent.push({
        postId: candidate.postId,
        commentId: candidate.commentId ?? null,
        source: candidate.source,
        reason: reuseDecision.reason,
        postSnapshotHash: candidate.postSnapshotHash ?? null,
        recentPostSnapshotHash: reuseDecision.recentMatch?.postSnapshotHash ?? null,
      });
    }
    if (allowedCandidates.length === 0) {
      await deps.memory
        .recordWrite({
          type: "engagement_target_resolution_failed",
          at: nowIso(),
          commandId: input.commandId,
          action: input.action,
          reason: "recent_comment_target_reuse_blocked",
          query: hints.rawQuery,
          bridgeQuerySuccessCount,
          bridgeQueryFailureCount,
          filteredRecentTargets: filteredRecent.slice(0, 8),
          trace,
        })
        .catch(() => undefined);
      throw new Error(
        "engagement_target_unavailable:no_targets_discovered:recent_comment_target_reuse_blocked",
      );
    }
    if (filteredRecent.length > 0) {
      await deps.memory
        .recordWrite({
          type: "engagement_target_filtered_recent_comment_target",
          at: nowIso(),
          commandId: input.commandId,
          action: input.action,
          filteredCount: filteredRecent.length,
          keptCount: allowedCandidates.length,
          filtered: filteredRecent.slice(0, 8),
          query: hints.rawQuery,
        })
        .catch(() => undefined);
    }
    candidatePool = allowedCandidates;
  }

  const rankTable =
    input.action === "comment"
      ? PREFERRED_SOURCE_ORDER_COMMENT
      : PREFERRED_SOURCE_ORDER_ENGAGEMENT;
  const hasNonOwnCandidate =
    input.action === "comment"
      ? candidatePool.some(
          (candidate) =>
            !deps.isOwnEngagementCandidate(candidate, agentMainUserId),
        )
      : false;
  candidatePool.sort((a, b) => {
    const delta =
      scoreCandidate(b, input.action, agentMainUserId, rankTable, hasNonOwnCandidate) -
      scoreCandidate(a, input.action, agentMainUserId, rankTable, hasNonOwnCandidate);
    if (delta !== 0) return delta;
    if (a.postId !== b.postId) return b.postId - a.postId;
    const aComment = a.commentId ?? 0;
    const bComment = b.commentId ?? 0;
    return bComment - aComment;
  });
  let selected = candidatePool[0] ?? null;
  if (!selected) return null;

  // ── S14: Comment thread enrichment ─────────────────────────────────
  if (input.action === "comment" && !selected.commentId) {
    const selectedPostId = selected.postId;
    try {
      const commentLookup = await deps.callAgentBridgeLookupCached({
        action: "browse_comments",
        postId: selectedPostId,
        limit: 12,
      });
      const commentRecords = collectBridgeRecordItems(commentLookup.value)
        .map((entry) => {
          const postId = asPositiveInt(entry.postId);
          const commentId = asPositiveInt(entry.commentId) ?? asPositiveInt(entry.id);
          if (!postId || postId !== selectedPostId || !commentId) return null;
          const author = isRecord(entry.author) ? entry.author : null;
          const authorId =
            asNonEmptyString(author?.mainUserId) ??
            asNonEmptyString(author?.id) ??
            asNonEmptyString(entry.authorId) ??
            null;
          const createdAtRaw =
            asNonEmptyString(entry.createdAt) ??
            asNonEmptyString(entry.created_at);
          const createdAtMs = createdAtRaw ? Date.parse(createdAtRaw) : NaN;
          return {
            commentId,
            authorId,
            createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : -1,
          };
        })
        .filter(
          (
            value,
          ): value is { commentId: number; authorId: string | null; createdAtMs: number } =>
            Boolean(value),
        )
        .filter((value) => !agentMainUserId || value.authorId !== agentMainUserId)
        .sort((a, b) => b.createdAtMs - a.createdAtMs);
      if (commentRecords.length > 0) {
        selected = {
          ...selected,
          commentId: commentRecords[0]?.commentId ?? null,
          source: `${selected.source}+comment_thread`,
        };
      }
    } catch {
      // best-effort parent comment enrichment only
    }
  }

  // ── S15: Self-comment reply filtering ──────────────────────────────
  if (input.action === "comment") {
    const commentAuthorById = new Map<number, string | null>();
    const isAllowedOwnReplyCandidate = async (
      candidate: EngagementTargetCandidate,
    ): Promise<boolean> => {
      if (!agentMainUserId) return true;
      if (!deps.isOwnEngagementCandidate(candidate, agentMainUserId)) return true;
      if (!candidate.commentId) return true;
      const cached = commentAuthorById.get(candidate.commentId);
      if (cached !== undefined) {
        return cached !== agentMainUserId;
      }
      const resolvedAuthorId = await resolveCommentAuthorIdForTarget(
        { callAgentChatBridge: deps.callAgentChatBridge, bridgeLookupCache: deps.bridgeLookupCache },
        { postId: candidate.postId, commentId: candidate.commentId },
      );
      commentAuthorById.set(candidate.commentId, resolvedAuthorId);
      return resolvedAuthorId !== agentMainUserId;
    };
    if (
      agentMainUserId &&
      deps.isOwnEngagementCandidate(selected, agentMainUserId) &&
      typeof selected.commentId === "number" &&
      selected.commentId > 0
    ) {
      const selectedAllowed = await isAllowedOwnReplyCandidate(selected);
      if (!selectedAllowed) {
        let fallback: EngagementTargetCandidate | null = null;
        for (const candidate of candidatePool) {
          if (
            candidate.postId === selected.postId &&
            candidate.commentId === selected.commentId
          ) {
            continue;
          }
          if (!(await isAllowedOwnReplyCandidate(candidate))) continue;
          fallback = candidate;
          break;
        }
        if (fallback) {
          await deps.memory
            .recordWrite({
              type: "engagement_target_filtered_self_own_comment_reply",
              at: nowIso(),
              commandId: input.commandId,
              action: input.action,
              postId: selected.postId,
              commentId: selected.commentId,
              source: selected.source,
              reason: "fallback_to_non_self_parent",
              fallbackPostId: fallback.postId,
              fallbackCommentId: fallback.commentId,
              fallbackSource: fallback.source,
              query: hints.rawQuery,
            })
            .catch(() => undefined);
          selected = fallback;
        } else {
          await deps.memory
            .recordWrite({
              type: "engagement_target_filtered_self_own_comment_reply",
              at: nowIso(),
              commandId: input.commandId,
              action: input.action,
              postId: selected.postId,
              commentId: selected.commentId,
              source: selected.source,
              reason: "no_fallback",
              query: hints.rawQuery,
            })
            .catch(() => undefined);
          throw new Error(
            "engagement_target_unavailable:no_targets_discovered:self_own_comment_reply_filtered",
          );
        }
      }
    }
    const selectedIsOwn = deps.isOwnEngagementCandidate(selected, agentMainUserId);
    if (selectedIsOwn && !selected.commentId) {
      const selectedPostId = selected.postId;
      const selectedCommentId = selected.commentId;
      const rareAllowance = deps.shouldAllowRareTopLevelSelfComment({
        commandId: input.commandId,
        postId: selectedPostId,
        rawQuery: hints.rawQuery,
      });
      const fallback = candidatePool.find((candidate) => {
        if (candidate.postId === selectedPostId && candidate.commentId === selectedCommentId) {
          return false;
        }
        const candidateIsOwn = deps.isOwnEngagementCandidate(
          candidate,
          agentMainUserId,
        );
        if (candidateIsOwn && !candidate.commentId) return false;
        return true;
      });
      if (fallback) {
        await deps.memory
          .recordWrite({
            type: "engagement_target_filtered_self_root_comment",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            postId: selected.postId,
            source: selected.source,
            reason: "fallback_to_non_self_or_thread",
            gateRoll: rareAllowance.gateRoll,
            fallbackPostId: fallback.postId,
            fallbackCommentId: fallback.commentId,
            fallbackSource: fallback.source,
            query: hints.rawQuery,
          })
          .catch(() => undefined);
        selected = fallback;
      } else if (!rareAllowance.allow) {
        await deps.memory
          .recordWrite({
            type: "engagement_target_filtered_self_root_comment",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            postId: selected.postId,
            source: selected.source,
            reason: rareAllowance.reason,
            gateRoll: rareAllowance.gateRoll,
            query: hints.rawQuery,
          })
          .catch(() => undefined);
        throw new Error(
          "engagement_target_unavailable:no_targets_discovered:self_root_comment_filtered",
        );
      } else if (rareAllowance.allow) {
        await deps.memory
          .recordWrite({
            type: "engagement_target_allowed_self_root_comment",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            postId: selected.postId,
            source: selected.source,
            reason: rareAllowance.reason,
            gateRoll: rareAllowance.gateRoll,
            query: hints.rawQuery,
          })
          .catch(() => undefined);
      }
    }
  }

  // ── S16: Final comment reuse check ─────────────────────────────────
  if (input.action === "comment") {
    const selectedTarget = selected;
    if (!selectedTarget) return null;
    const selectedReuseDecision = deps.decideCommentTargetReuse({
      commandId: input.commandId,
      postId: selectedTarget.postId,
      commentId: selectedTarget.commentId ?? null,
      postSnapshotHash: selectedTarget.postSnapshotHash ?? null,
      source: selectedTarget.source,
      recentUsage: recentCommentUsage,
    });
    if (!selectedReuseDecision.allow) {
      const fallback = candidatePool.find((candidate) => {
        if (candidate.postId === selectedTarget.postId) return false;
        if (
          agentMainUserId &&
          deps.isOwnEngagementCandidate(candidate, agentMainUserId) &&
          !candidate.commentId
        ) {
          return false;
        }
        const reuseDecision = deps.decideCommentTargetReuse({
          commandId: input.commandId,
          postId: candidate.postId,
          commentId: candidate.commentId ?? null,
          postSnapshotHash: candidate.postSnapshotHash ?? null,
          source: candidate.source,
          recentUsage: recentCommentUsage,
        });
        return reuseDecision.allow;
      });
      if (fallback) {
        await deps.memory
          .recordWrite({
            type: "engagement_target_filtered_recent_comment_target",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            filteredCount: 1,
            keptCount: 1,
            filtered: [
              {
                postId: selectedTarget.postId,
                commentId: selectedTarget.commentId ?? null,
                source: selectedTarget.source,
                reason: selectedReuseDecision.reason,
                postSnapshotHash: selectedTarget.postSnapshotHash ?? null,
                recentPostSnapshotHash:
                  selectedReuseDecision.recentMatch?.postSnapshotHash ?? null,
              },
            ],
            fallbackPostId: fallback.postId,
            fallbackCommentId: fallback.commentId ?? null,
            fallbackSource: fallback.source,
            query: hints.rawQuery,
          })
          .catch(() => undefined);
        selected = fallback;
      } else {
        await deps.memory
          .recordWrite({
            type: "engagement_target_resolution_failed",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            reason: "recent_comment_target_reuse_blocked_after_thread_resolution",
            query: hints.rawQuery,
            bridgeQuerySuccessCount,
            bridgeQueryFailureCount,
            selectedPostId: selectedTarget.postId,
            selectedCommentId: selectedTarget.commentId ?? null,
            selectedSource: selectedTarget.source,
            selectedPostSnapshotHash: selectedTarget.postSnapshotHash ?? null,
            selectedReason: selectedReuseDecision.reason,
            recentPostSnapshotHash:
              selectedReuseDecision.recentMatch?.postSnapshotHash ?? null,
            trace,
          })
          .catch(() => undefined);
        throw new Error(
          "engagement_target_unavailable:no_targets_discovered:recent_comment_target_reuse_blocked",
        );
      }
    }
  }

  // ── S17: Cache & return ────────────────────────────────────────────
  const resolved = {
    ...selected,
    commentId: input.action === "comment" ? (selected.commentId ?? null) : null,
  };
  deps.engagementTargetCache.set(cacheKey, {
    expiresAtMs: Date.now() + ENGAGEMENT_TARGET_CACHE_TTL_MS,
    candidate: resolved,
  });
  deps.pruneEngagementTargetCache(Date.now());
  await deps.memory
    .recordWrite({
      type: "engagement_target_resolved",
      at: nowIso(),
      commandId: input.commandId,
      action: input.action,
      postId: resolved.postId,
      commentId: resolved.commentId,
      source: resolved.source,
      postSnapshotHash: resolved.postSnapshotHash ?? null,
      query: hints.rawQuery,
      candidatesConsidered: candidatePool.length,
      trace,
    })
    .catch(() => undefined);
  return resolved;
}

// ---------------------------------------------------------------------------
// Internal: direct-call wrapper for extractEngagementTargetCandidateFromRecord
// (avoids deps round-trip for memory-event parsing within the function)
// ---------------------------------------------------------------------------
import {
  extractEngagementTargetCandidateFromRecord as extractEngagementTargetCandidateFromRecordDirect,
} from "./engagement-helpers.js";
