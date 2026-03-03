/** Pre-fetch engagement context for commands that will be requeued. */

import type { Command, EngagementTargetCandidate, EngagementLookupHints } from "../types.js";
import { asNonEmptyString, asPositiveInt, truncateText } from "../helpers.js";
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";

import { extractEngagementLookupHints } from "../follow/follow-actions.js";
import { collectBridgeRecordItems } from "../generate/generate-input.js";
import { extractEngagementTargetCandidateFromRecord } from "../engagement/engagement-helpers.js";
import {
  buildEngagementTargetCacheKey,
  pruneEngagementTargetCache,
} from "../cache/cache.js";

import { ENGAGEMENT_TARGET_CACHE_TTL_MS } from "../constants.js";

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

type MemoryWriter = { recordWrite(entry: unknown): Promise<void> };
type ResolveActionFn = (command: Command) => "comment" | "like" | "repost" | null;
type BridgeLookupCachedFn = (
  request: Record<string, unknown>,
  ttlMs: number,
) => Promise<{ value: unknown; cacheHit: boolean } | null>;
type EngagementTargetCache = Map<
  string,
  { expiresAtMs: number; candidate: EngagementTargetCandidate }
>;

// ---------------------------------------------------------------------------
// primeCommandContextForRequeue
// ---------------------------------------------------------------------------

export async function primeCommandContextForRequeue(
  deps: {
    memory: MemoryWriter;
    callAgentChatBridge: ((input: unknown) => Promise<unknown>) | null;
    resolveEngagementActionForCommand: ResolveActionFn;
    callAgentBridgeLookupCached: BridgeLookupCachedFn;
    engagementTargetCache: EngagementTargetCache;
  },
  command: Command,
  reason: string,
): Promise<void> {
  const action = deps.resolveEngagementActionForCommand(command);
  if (!action) return;
  if (!deps.callAgentChatBridge) return;
  const loweredReason = reason.toLowerCase();
  const shouldPrime =
    loweredReason.includes("no_target") ||
    loweredReason.includes("waiting_for_context") ||
    loweredReason.includes("missing_target_post_context");
  if (!shouldPrime) return;

  const payload = isRecord(command.payload) ? command.payload : {};
  const hints = extractEngagementLookupHints(payload);
  const bridgeRequests: Record<string, unknown>[] = [
    { action: "browse_notifications", unreadOnly: true, limit: 24 },
    { action: "browse_notifications", unreadOnly: false, limit: 24 },
    { action: "browse_unanswered_mentions", limit: 24, sinceHours: 24 * 14 },
    { action: "browse_recent_actions", limit: 24 },
    { action: "browse_top_engagers", limit: 12, windowHours: 24 * 14 },
    { action: "browse_home_feed", limit: 24 },
    { action: "browse_trending", limit: 24 },
    { action: "browse_posts", limit: 24 },
  ];
  if (hints.interestTags.length > 0) {
    const tags = hints.interestTags.slice(0, 8);
    bridgeRequests.push(
      { action: "browse_trending", limit: 24, tags },
      { action: "browse_posts", limit: 24, tags },
    );
  }
  if (hints.rawQuery.trim().length > 2) {
    bridgeRequests.push({
      action: "search_global",
      query: truncateText(hints.rawQuery, 220),
      limit: 24,
    });
  }
  if (hints.interestTags.length > 0) {
    const tagQuery = truncateText(hints.interestTags.slice(0, 4).join(" "), 220);
    if (tagQuery.length > 2) {
      bridgeRequests.push({
        action: "search_global",
        query: tagQuery,
        limit: 24,
        includePeople: false,
      });
    }
  }
  if (hints.postId) {
    bridgeRequests.unshift({
      action: "find_post",
      postId: hints.postId,
    });
  }

  const discovered: EngagementTargetCandidate[] = [];
  const seenTargets = new Set<string>();
  for (const request of bridgeRequests) {
    let result: { value: unknown; cacheHit: boolean } | null = null;
    try {
      result = await deps.callAgentBridgeLookupCached(request, 5_000);
    } catch {
      result = null;
    }
    if (!result) continue;
    for (const row of collectBridgeRecordItems(result.value)) {
      const parsedDirect = extractEngagementTargetCandidateFromRecord(
        row,
        "requeue_prime",
      );
      const entityType =
        asNonEmptyString(row.entityType)?.toLowerCase() ??
        asNonEmptyString(row.targetType)?.toLowerCase() ??
        null;
      const entityId =
        asPositiveInt(row.entityId) ??
        asPositiveInt(row.targetId) ??
        null;
      const parsedFallback =
        parsedDirect ??
        (() => {
          const postId =
            asPositiveInt(row.postId) ??
            asPositiveInt(row.targetPostId) ??
            (entityType === "post" ? entityId : null);
          if (!postId) return null;
          const commentId =
            asPositiveInt(row.commentId) ??
            asPositiveInt(row.targetCommentId) ??
            asPositiveInt(row.parentId) ??
            (entityType === "comment" ? entityId : null);
          return {
            postId,
            commentId: action === "comment" ? commentId : null,
            authorId: null,
            source: "requeue_prime",
          } satisfies EngagementTargetCandidate;
        })();
      const parsed = parsedFallback;
      if (!parsed) continue;
      const key = `${parsed.postId}:${parsed.commentId ?? 0}`;
      if (seenTargets.has(key)) continue;
      seenTargets.add(key);
      discovered.push(parsed);
      if (discovered.length >= 24) break;
    }
    if (discovered.length >= 24) break;
  }

  if (!discovered.length) {
    await deps.memory
      .recordWrite({
        type: "engagement_context_prime_empty",
        at: nowIso(),
        commandId: command.id,
        action,
        reason,
        query: hints.rawQuery,
      })
      .catch(() => undefined);
    return;
  }

  for (const candidate of discovered.slice(0, 12)) {
    await deps.memory
      .recordWrite({
        type: "engagement_context_seed",
        at: nowIso(),
        commandId: command.id,
        action,
        postId: candidate.postId,
        commentId: candidate.commentId,
        authorId: candidate.authorId,
        source: candidate.source,
        query: hints.rawQuery,
      })
      .catch(() => undefined);
  }

  const cacheSeed = discovered[0] ?? null;
  if (cacheSeed) {
    const cacheKey = buildEngagementTargetCacheKey({
      action,
      payload,
      hints,
    });
    deps.engagementTargetCache.set(cacheKey, {
      expiresAtMs: Date.now() + ENGAGEMENT_TARGET_CACHE_TTL_MS,
      candidate: {
        ...cacheSeed,
        commentId: action === "comment" ? cacheSeed.commentId : null,
      },
    });
    pruneEngagementTargetCache(deps.engagementTargetCache, Date.now());
  }

  await deps.memory
    .recordWrite({
      type: "engagement_context_prime_completed",
      at: nowIso(),
      commandId: command.id,
      action,
      reason,
      discoveredCount: discovered.length,
      query: hints.rawQuery,
    })
    .catch(() => undefined);
}
