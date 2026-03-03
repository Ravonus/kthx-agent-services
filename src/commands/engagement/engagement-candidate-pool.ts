/**
 * Engagement candidate accumulator — stateful pool for collecting, deduplicating,
 * and scoring engagement target candidates during resolution.
 */

import type { EngagementTargetCandidate, EngagementResolutionTrace } from "../types.js";

import {
  asNonEmptyString,
  asPositiveInt,
} from "../helpers.js";

import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";

import {
  collectBridgeRecordItems,
} from "../generate/generate-input.js";

import {
  computePostSnapshotHash,
  isOwnEngagementCandidate,
  extractEngagementTargetCandidateFromRecord,
} from "./engagement-helpers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LookupPlan = {
  source: string;
  request: Record<string, unknown>;
  parser?: (value: unknown) => EngagementTargetCandidate[];
};

type ChatBridgeFn = (input: unknown) => Promise<unknown>;
type BridgeLookupCache = Map<string, { expiresAtMs: number; value: unknown }>;

export type CandidatePoolDeps = {
  callAgentBridgeLookupCached: (
    payload: Record<string, unknown>,
    ttlMs?: number,
  ) => Promise<{ value: unknown; cacheHit: boolean }>;
  memory: { recordWrite(entry: unknown): Promise<void> };
};

// ---------------------------------------------------------------------------
// Source ranking tables
// ---------------------------------------------------------------------------

export const PREFERRED_SOURCE_ORDER_COMMENT = new Map<string, number>([
  ["notifications_unread", 0],
  ["notifications_recent", 1],
  ["payload_hint", 2],
  ["memory_lookup_plan", 2],
  ["memory_retrieval", 2],
  ["unanswered_mention", 3],
  ["interest_trending", 4],
  ["interest_explore", 5],
  ["interest_search", 6],
  ["top_engager_latest", 7],
  ["recent_actions", 8],
  ["home_feed", 9],
  ["trending", 10],
  ["search_global", 11],
  ["explore", 12],
  ["memory_event", 13],
  ["own_latest", 14],
  ["directive_payload", 15],
]);

export const PREFERRED_SOURCE_ORDER_ENGAGEMENT = new Map<string, number>([
  ["notifications_unread", 0],
  ["notifications_recent", 1],
  ["payload_hint", 2],
  ["memory_lookup_plan", 2],
  ["unanswered_mention", 2],
  ["interest_trending", 3],
  ["interest_explore", 4],
  ["interest_search", 5],
  ["top_engager_latest", 6],
  ["recent_actions", 7],
  ["home_feed", 8],
  ["trending", 9],
  ["search_global", 10],
  ["explore", 11],
  ["memory_retrieval", 12],
  ["memory_event", 13],
  ["own_latest", 14],
  ["directive_payload", 15],
]);

// ---------------------------------------------------------------------------
// createEngagementCandidatePool
// ---------------------------------------------------------------------------

export type EngagementCandidatePoolHandle = ReturnType<typeof createEngagementCandidatePool>;

export function createEngagementCandidatePool(deps: CandidatePoolDeps, input: {
  action: "comment" | "like" | "repost";
  commandId: string;
  hasBridge: boolean;
}) {
  const trace: EngagementResolutionTrace[] = [];
  const candidates: EngagementTargetCandidate[] = [];
  const candidateByTargetKey = new Map<string, EngagementTargetCandidate>();
  let bridgeQuerySuccessCount = 0;
  let bridgeQueryFailureCount = 0;

  const pushCandidate = (candidate: EngagementTargetCandidate | null): boolean => {
    if (!candidate) return false;
    if (!candidate.postId || candidate.postId <= 0) return false;
    const key = `${candidate.postId}:${candidate.commentId ?? 0}`;
    const existing = candidateByTargetKey.get(key);
    if (existing) {
      const nextAuthorId = existing.authorId ?? candidate.authorId ?? null;
      if (nextAuthorId !== existing.authorId) {
        existing.authorId = nextAuthorId;
      }
      const nextSnapshotHash =
        candidate.postSnapshotHash ??
        existing.postSnapshotHash ??
        null;
      if (nextSnapshotHash !== existing.postSnapshotHash) {
        existing.postSnapshotHash = nextSnapshotHash;
      }
      if (
        existing.source.startsWith("own_latest") &&
        !candidate.source.startsWith("own_latest")
      ) {
        existing.source = candidate.source;
      }
      return false;
    }
    candidateByTargetKey.set(key, candidate);
    candidates.push(candidate);
    return true;
  };

  const addCandidatesFrom = (value: unknown, source: string): number => {
    let added = 0;
    for (const item of collectBridgeRecordItems(value)) {
      const parsed = extractEngagementTargetCandidateFromRecord(item, source);
      if (!parsed) continue;
      if (pushCandidate(parsed)) added += 1;
    }
    return added;
  };

  const runLookupStep = async (
    step: string,
    plans: LookupPlan[],
  ): Promise<void> => {
    if (!input.hasBridge || plans.length === 0) return;
    let queryCount = 0;
    let cacheHits = 0;
    let addedCandidates = 0;
    for (const plan of plans) {
      try {
        const result = await deps.callAgentBridgeLookupCached(plan.request);
        bridgeQuerySuccessCount += 1;
        queryCount += 1;
        if (result.cacheHit) cacheHits += 1;
        if (typeof plan.parser === "function") {
          for (const candidate of plan.parser(result.value)) {
            if (pushCandidate(candidate)) addedCandidates += 1;
          }
        } else {
          addedCandidates += addCandidatesFrom(result.value, plan.source);
        }
      } catch (error: unknown) {
        bridgeQueryFailureCount += 1;
        await deps.memory
          .recordWrite({
            type: "engagement_target_lookup_failed",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            step,
            source: plan.source,
            lookupAction: asNonEmptyString(plan.request.action) ?? "unknown",
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
      }
    }
    trace.push({
      step,
      queryCount,
      cacheHits,
      addedCandidates,
      totalCandidates: candidates.length,
    });
  };

  const hasConfidentCandidate = (): boolean =>
    candidates.some((candidate) => {
      if (input.action === "comment") {
        return (
          candidate.source === "notifications_unread" ||
          candidate.source === "notifications_recent" ||
          candidate.source === "interest_trending" ||
          candidate.source === "interest_explore" ||
          candidate.source === "interest_search" ||
          candidate.source === "unanswered_mention"
        );
      }
      return (
        candidate.source === "notifications_unread" ||
        candidate.source === "notifications_recent" ||
        candidate.source === "interest_trending" ||
        candidate.source === "interest_explore" ||
        candidate.source === "interest_search" ||
        candidate.source === "unanswered_mention" ||
        candidate.source === "top_engager_latest" ||
        candidate.source === "recent_actions"
      );
    });

  return {
    pushCandidate,
    addCandidatesFrom,
    runLookupStep,
    hasConfidentCandidate,
    getCandidates: () => candidates,
    getTrace: () => trace,
    getBridgeCounts: () => ({ bridgeQuerySuccessCount, bridgeQueryFailureCount }),
    pushTrace: (entry: EngagementResolutionTrace) => { trace.push(entry); },
    incrementBridgeSuccess: () => { bridgeQuerySuccessCount += 1; },
    incrementBridgeFailure: () => { bridgeQueryFailureCount += 1; },
  };
}

// ---------------------------------------------------------------------------
// parseNotificationTargets
// ---------------------------------------------------------------------------

export function parseNotificationTargets(
  value: unknown,
  source: string,
  action: "comment" | "like" | "repost",
): EngagementTargetCandidate[] {
  const resolved: EngagementTargetCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: EngagementTargetCandidate | null): void => {
    if (!candidate) return;
    if (!candidate.postId || candidate.postId <= 0) return;
    const key = `${candidate.postId}:${candidate.commentId ?? 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    resolved.push(candidate);
  };
  for (const row of collectBridgeRecordItems(value)) {
    push(extractEngagementTargetCandidateFromRecord(row, source));

    const entityType =
      asNonEmptyString(row.entityType)?.toLowerCase() ??
      asNonEmptyString(row.targetType)?.toLowerCase() ??
      null;
    const entityId =
      asPositiveInt(row.entityId) ??
      asPositiveInt(row.targetId) ??
      null;
    const postIdFromFields =
      asPositiveInt(row.postId) ??
      asPositiveInt(row.targetPostId) ??
      (isRecord(row.post) ? asPositiveInt(row.post.id) : null) ??
      (isRecord(row.target)
        ? asPositiveInt(row.target.postId) ??
          (isRecord(row.target.post) ? asPositiveInt(row.target.post.id) : null)
        : null);
    const commentIdFromFields =
      asPositiveInt(row.commentId) ??
      asPositiveInt(row.targetCommentId) ??
      asPositiveInt(row.parentId) ??
      (isRecord(row.comment) ? asPositiveInt(row.comment.id) : null) ??
      (isRecord(row.target)
        ? asPositiveInt(row.target.commentId) ??
          (isRecord(row.target.comment) ? asPositiveInt(row.target.comment.id) : null)
        : null);
    const postId =
      postIdFromFields ??
      (entityType === "post" ? entityId : null) ??
      null;
    const commentId =
      commentIdFromFields ??
      (entityType === "comment" ? entityId : null) ??
      null;
    if (!postId) continue;
    const postSnapshotHash = computePostSnapshotHash({
      postId,
      commentId: action === "comment" ? commentId : null,
      postRecord: row,
    });
    push({
      postId,
      commentId: action === "comment" ? commentId : null,
      authorId: null,
      source,
      postSnapshotHash,
    });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// mentionParser
// ---------------------------------------------------------------------------

export function parseMentionTargets(
  value: unknown,
  action: "comment" | "like" | "repost",
): EngagementTargetCandidate[] {
  const resolved: EngagementTargetCandidate[] = [];
  for (const row of collectBridgeRecordItems(value)) {
    const targetType = asNonEmptyString(row.targetType)?.toLowerCase() ?? "";
    if (targetType !== "post") continue;
    const targetId = asPositiveInt(row.targetId);
    if (!targetId) continue;
    const targetCommentId = asPositiveInt(row.targetCommentId) ?? null;
    const postSnapshotHash = computePostSnapshotHash({
      postId: targetId,
      commentId: action === "comment" ? targetCommentId : null,
      postRecord: row,
    });
    resolved.push({
      postId: targetId,
      commentId: action === "comment" ? targetCommentId : null,
      authorId: null,
      source: "unanswered_mention",
      postSnapshotHash,
    });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// scoreCandidate
// ---------------------------------------------------------------------------

export function scoreCandidate(
  candidate: EngagementTargetCandidate,
  action: "comment" | "like" | "repost",
  agentMainUserId: string | null,
  rankTable: Map<string, number>,
  hasNonOwnCandidate: boolean,
): number {
  const sourceRank = rankTable.get(candidate.source) ?? 999;
  const isOwn = isOwnEngagementCandidate(candidate, agentMainUserId);
  const ownBias =
    action === "comment"
      ? isOwn
        ? candidate.commentId
          ? 8
          : hasNonOwnCandidate
            ? -420
            : -260
        : 36
      : isOwn
        ? -140
        : 40;
  const commentBias =
    action === "comment" && candidate.commentId ? 26 : 0;
  return 10_000 - sourceRank * 120 + ownBias + commentBias + (candidate.postId % 17);
}
