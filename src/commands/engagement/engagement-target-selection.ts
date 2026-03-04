import type {
  EngagementTargetCandidate,
  EngagementLookupHints,
  EngagementResolutionTrace,
  RecentCommentTargetUsage,
} from "../types.js";

import {
  asNonEmptyString,
  asPositiveInt,
} from "../helpers.js";

import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";

import { collectBridgeRecordItems } from "../generate/generate-input.js";
import { ENGAGEMENT_TARGET_CACHE_TTL_MS } from "../constants.js";

import {
  computePostSnapshotHash,
} from "./engagement-helpers.js";

import { resolveCommentAuthorIdForTarget } from "./engagement-context.js";

import {
  extractPostRecordForCommentCuration,
} from "../write/comment-curation.js";

import {
  scoreCandidate,
  PREFERRED_SOURCE_ORDER_COMMENT,
  PREFERRED_SOURCE_ORDER_ENGAGEMENT,
} from "./engagement-candidate-pool.js";
import type { LookupPlan } from "./engagement-candidate-pool.js";

import type { EngagementTargetResolutionDeps } from "./engagement-target-resolution.js";

export async function selectEngagementTargetCandidate(input: {
  deps: EngagementTargetResolutionDeps;
  action: "comment" | "like" | "repost";
  commandId: string;
  hints: EngagementLookupHints;
  candidates: EngagementTargetCandidate[];
  recentCommentUsage: RecentCommentTargetUsage[];
  agentMainUserId: string | null;
  bridgeQuerySuccessCount: number;
  bridgeQueryFailureCount: number;
  trace: EngagementResolutionTrace[];
  cacheKey: string;
  pool: {
    runLookupStep: (step: string, plans: LookupPlan[]) => Promise<void>;
  };
}): Promise<EngagementTargetCandidate | null> {
  const {
    deps,
    action,
    commandId,
    hints,
    recentCommentUsage,
    bridgeQuerySuccessCount,
    bridgeQueryFailureCount,
    trace,
    cacheKey,
    pool,
  } = input;
  let candidatePool = [...input.candidates];
  const agentMainUserId = input.agentMainUserId;

  // Candidate hydration
  const byTargetKey = new Map<string, EngagementTargetCandidate>();
  for (const candidate of candidatePool) {
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
  candidatePool = [...input.candidates];

  // Filter & rank candidates
  if (action !== "comment") {
    const nonOwnCandidates = candidatePool.filter(
      (candidate) => !deps.isOwnEngagementCandidate(candidate, agentMainUserId),
    );
    if (nonOwnCandidates.length === 0) {
      await deps.memory
        .recordWrite({
          type: "engagement_target_resolution_failed",
          at: nowIso(),
          commandId,
          action,
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
  if (action === "comment") {
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
        commandId,
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
          commandId,
          action,
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
          commandId,
          action,
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
    action === "comment"
      ? PREFERRED_SOURCE_ORDER_COMMENT
      : PREFERRED_SOURCE_ORDER_ENGAGEMENT;
  const hasNonOwnCandidate =
    action === "comment"
      ? candidatePool.some(
          (candidate) =>
            !deps.isOwnEngagementCandidate(candidate, agentMainUserId),
        )
      : false;
  candidatePool.sort((a, b) => {
    const delta =
      scoreCandidate(b, action, agentMainUserId, rankTable, hasNonOwnCandidate) -
      scoreCandidate(a, action, agentMainUserId, rankTable, hasNonOwnCandidate);
    if (delta !== 0) return delta;
    if (a.postId !== b.postId) return b.postId - a.postId;
    const aComment = a.commentId ?? 0;
    const bComment = b.commentId ?? 0;
    return bComment - aComment;
  });
  let selected = candidatePool[0] ?? null;
  if (!selected) return null;

  // Comment thread enrichment
  if (action === "comment" && !selected.commentId) {
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

  // Self-comment reply filtering
  if (action === "comment") {
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
              commandId,
              action,
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
              commandId,
              action,
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
        commandId,
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
            commandId,
            action,
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
            commandId,
            action,
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
            commandId,
            action,
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

  // Final comment reuse check
  if (action === "comment") {
    const selectedTarget = selected;
    if (!selectedTarget) return null;
    const selectedReuseDecision = deps.decideCommentTargetReuse({
      commandId,
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
          commandId,
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
            commandId,
            action,
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
            commandId,
            action,
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

  // Cache and return
  const resolved = {
    ...selected,
    commentId: action === "comment" ? (selected.commentId ?? null) : null,
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
      commandId,
      action,
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
