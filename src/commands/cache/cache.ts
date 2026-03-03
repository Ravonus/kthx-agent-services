/** Cache management helpers for the command executor. */

import crypto from "node:crypto";

import {
  BRIDGE_LOOKUP_CACHE_TTL_MS,
  CURATED_PROMPT_CACHE_MAX_ENTRIES,
  CURATED_PROMPT_CACHE_TTL_MS,
  ENGAGEMENT_TARGET_CACHE_MAX_ENTRIES,
  GENERATED_DRAFT_CACHE_MAX_ENTRIES,
  GENERATED_DRAFT_CACHE_TTL_MS,
} from "../constants.js";
import { asNonEmptyString, truncateText } from "../helpers.js";
import { isRecord } from "../../lib/guards.js";
import type {
  CuratedMediaPromptCacheEntry,
  CuratedPostDraftCacheEntry,
  EngagementLookupHints,
  EngagementTargetCandidate,
  GeneratedAssetType,
  GeneratedDraft,
} from "../types.js";

export function pruneGeneratedDraftCache(
  cache: Map<string, { drafts: GeneratedDraft[]; cachedAtMs: number }>,
): void {
  const nowMs = Date.now();
  for (const [key, cached] of cache) {
    if (nowMs - cached.cachedAtMs < GENERATED_DRAFT_CACHE_TTL_MS) continue;
    cache.delete(key);
  }
  if (cache.size <= GENERATED_DRAFT_CACHE_MAX_ENTRIES) return;
  const overflow = cache.size - GENERATED_DRAFT_CACHE_MAX_ENTRIES;
  let removed = 0;
  for (const key of cache.keys()) {
    cache.delete(key);
    removed += 1;
    if (removed >= overflow) break;
  }
}

export function buildCuratedPostDraftCacheKey(input: {
  commandId: string;
  postType: "text" | "media";
  signature: string;
}): string {
  const signatureHash = crypto
    .createHash("sha256")
    .update(input.signature)
    .digest("hex")
    .slice(0, 16);
  return `${input.commandId}:${input.postType}:${signatureHash}`;
}

export function buildCuratedMediaPromptCacheKey(input: {
  commandId: string;
  sourcePrompt: string;
  generatedAssetType: GeneratedAssetType;
  mode: string;
}): string {
  const promptHash = crypto
    .createHash("sha256")
    .update(input.sourcePrompt)
    .digest("hex")
    .slice(0, 16);
  return `${input.commandId}:${input.generatedAssetType}:${input.mode}:${promptHash}`;
}

export function pruneMapByTtlAndSize<T>(
  map: Map<string, { cachedAtMs: number } & T>,
  ttlMs: number,
  maxEntries: number,
): void {
  const nowMs = Date.now();
  for (const [key, cached] of map) {
    if (nowMs - cached.cachedAtMs < ttlMs) continue;
    map.delete(key);
  }
  if (map.size <= maxEntries) return;
  const overflow = map.size - maxEntries;
  let removed = 0;
  for (const key of map.keys()) {
    map.delete(key);
    removed += 1;
    if (removed >= overflow) break;
  }
}

export function pruneCuratedPromptCaches(
  curatedPostDraftCache: Map<string, CuratedPostDraftCacheEntry>,
  curatedMediaPromptCache: Map<string, CuratedMediaPromptCacheEntry>,
): void {
  pruneMapByTtlAndSize(
    curatedPostDraftCache,
    CURATED_PROMPT_CACHE_TTL_MS,
    CURATED_PROMPT_CACHE_MAX_ENTRIES,
  );
  pruneMapByTtlAndSize(
    curatedMediaPromptCache,
    CURATED_PROMPT_CACHE_TTL_MS,
    CURATED_PROMPT_CACHE_MAX_ENTRIES,
  );
}

export function pruneBridgeLookupCache(
  bridgeLookupCache: Map<string, { expiresAtMs: number; value: unknown }>,
  nowMs: number,
): void {
  for (const [key, cached] of bridgeLookupCache) {
    if (cached.expiresAtMs > nowMs) continue;
    bridgeLookupCache.delete(key);
  }
  if (bridgeLookupCache.size <= ENGAGEMENT_TARGET_CACHE_MAX_ENTRIES) return;
  const overflow = bridgeLookupCache.size - ENGAGEMENT_TARGET_CACHE_MAX_ENTRIES;
  let removed = 0;
  for (const key of bridgeLookupCache.keys()) {
    bridgeLookupCache.delete(key);
    removed += 1;
    if (removed >= overflow) break;
  }
}

export function pruneEngagementTargetCache(
  engagementTargetCache: Map<
    string,
    { expiresAtMs: number; candidate: EngagementTargetCandidate }
  >,
  nowMs: number,
): void {
  for (const [key, cached] of engagementTargetCache) {
    if (cached.expiresAtMs > nowMs) continue;
    engagementTargetCache.delete(key);
  }
  if (engagementTargetCache.size <= ENGAGEMENT_TARGET_CACHE_MAX_ENTRIES) return;
  const overflow =
    engagementTargetCache.size - ENGAGEMENT_TARGET_CACHE_MAX_ENTRIES;
  let removed = 0;
  for (const key of engagementTargetCache.keys()) {
    engagementTargetCache.delete(key);
    removed += 1;
    if (removed >= overflow) break;
  }
}

export function buildEngagementTargetCacheKey(input: {
  action: "comment" | "like" | "repost";
  payload: Record<string, unknown>;
  hints: EngagementLookupHints;
}): string {
  const scope = isRecord(input.payload.directiveScope)
    ? input.payload.directiveScope
    : null;
  const scopeTarget =
    scope && isRecord(scope.target) ? scope.target : null;
  const channelId =
    asNonEmptyString(input.payload.channelId) ??
    asNonEmptyString(scope?.channelId) ??
    asNonEmptyString(scopeTarget?.channelId) ??
    "";
  const conversationId =
    asNonEmptyString(input.payload.conversationId) ??
    asNonEmptyString(scope?.conversationId) ??
    asNonEmptyString(scopeTarget?.conversationId) ??
    "";
  return [
    input.action,
    input.hints.postId ? `p:${input.hints.postId}` : "p:none",
    input.hints.commentId ? `c:${input.hints.commentId}` : "c:none",
    input.hints.handles.slice(0, 3).join(","),
    input.hints.interestTags.slice(0, 4).join(","),
    truncateText(input.hints.rawQuery, 120).toLowerCase(),
    channelId,
    conversationId,
  ].join("|");
}

export async function callAgentBridgeLookupCached(
  bridgeLookupCache: Map<string, { expiresAtMs: number; value: unknown }>,
  callBridge: ((payload: unknown) => Promise<unknown>) | null,
  payload: Record<string, unknown>,
  ttlMs: number = BRIDGE_LOOKUP_CACHE_TTL_MS,
): Promise<{ value: unknown; cacheHit: boolean }> {
  if (!callBridge) return { value: null, cacheHit: false };
  const nowMs = Date.now();
  pruneBridgeLookupCache(bridgeLookupCache, nowMs);
  const key = JSON.stringify(payload);
  const cached = bridgeLookupCache.get(key);
  if (cached && cached.expiresAtMs > nowMs) {
    return { value: cached.value, cacheHit: true };
  }
  const value = await callBridge(payload);
  bridgeLookupCache.set(key, {
    expiresAtMs: nowMs + Math.max(1000, ttlMs),
    value,
  });
  return { value, cacheHit: false };
}
