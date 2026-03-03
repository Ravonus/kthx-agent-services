/** Engagement target helpers — snapshot hashing, own-candidate detection, lookup gating. */

import crypto from "node:crypto";

import type { EngagementTargetCandidate } from "../types.js";

import {
  asNonEmptyString,
  asPositiveInt,
  truncateText,
  normalizeCommentText,
} from "../helpers.js";

import { asNonNegativeInt } from "../generate/generate-input.js";

import {
  SELF_COMMENT_OWN_TARGET_QUERY_PATTERN,
  SELF_COMMENT_CLARIFICATION_INTENT_PATTERN,
  SELF_TOP_LEVEL_COMMENT_RARE_PERCENT,
} from "../constants.js";

import { pickDeterministicIndex } from "../write/post-visual.js";

import { isRecord } from "../../lib/guards.js";

// ---------------------------------------------------------------------------
// computePostSnapshotHash
// ---------------------------------------------------------------------------

export function computePostSnapshotHash(input: {
  postId: number;
  commentId: number | null;
  postRecord: Record<string, unknown>;
}): string | null {
  const providedHash =
    asNonEmptyString(input.postRecord.postSnapshotHash) ??
    asNonEmptyString(input.postRecord.snapshotHash);
  if (providedHash) return providedHash;
  const metrics = isRecord(input.postRecord.metrics) ? input.postRecord.metrics : null;
  const mediaItems = Array.isArray(input.postRecord.mediaItems)
    ? input.postRecord.mediaItems.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
  const mediaFingerprints = mediaItems
    .slice(0, 4)
    .map((item) => {
      const mediaType = asNonEmptyString(item.mediaType)?.toLowerCase() ?? "image";
      const id = asPositiveInt(item.id);
      const fingerprint =
        asNonEmptyString(item.contentHash) ??
        asNonEmptyString(item.hash) ??
        asNonEmptyString(item.optimizedUrl) ??
        asNonEmptyString(item.originalUrl) ??
        asNonEmptyString(item.url) ??
        null;
      if (!fingerprint) return null;
      return `${mediaType}:${id ?? 0}:${truncateText(fingerprint, 80)}`;
    })
    .filter((entry): entry is string => Boolean(entry));
  const textSource =
    asNonEmptyString(input.postRecord.textBody) ??
    asNonEmptyString(input.postRecord.body) ??
    asNonEmptyString(input.postRecord.caption) ??
    null;
  const normalizedText = textSource ? truncateText(normalizeCommentText(textSource), 280) : null;
  const stablePayload = {
    postId: input.postId,
    commentId: input.commentId ?? null,
    updatedAt:
      asNonEmptyString(input.postRecord.updatedAt) ??
      asNonEmptyString(input.postRecord.updated_at) ??
      asNonEmptyString(input.postRecord.lastInteractionAt) ??
      asNonEmptyString(input.postRecord.last_interaction_at) ??
      null,
    createdAt:
      asNonEmptyString(input.postRecord.createdAt) ??
      asNonEmptyString(input.postRecord.created_at) ??
      null,
    text: normalizedText,
    mediaCount: mediaItems.length,
    media: mediaFingerprints,
    commentCount:
      asNonNegativeInt(input.postRecord.commentCount) ??
      asNonNegativeInt(input.postRecord.commentsCount) ??
      asNonNegativeInt(input.postRecord.replyCount) ??
      asNonNegativeInt(metrics?.commentCount) ??
      null,
    likeCount:
      asNonNegativeInt(input.postRecord.likeCount) ??
      asNonNegativeInt(input.postRecord.likesCount) ??
      asNonNegativeInt(metrics?.likeCount) ??
      null,
    repostCount:
      asNonNegativeInt(input.postRecord.repostCount) ??
      asNonNegativeInt(input.postRecord.repostsCount) ??
      asNonNegativeInt(metrics?.repostCount) ??
      null,
    viewCount:
      asNonNegativeInt(input.postRecord.viewCount) ??
      asNonNegativeInt(input.postRecord.viewsCount) ??
      asNonNegativeInt(metrics?.viewCount) ??
      null,
  };
  const encoded = JSON.stringify(stablePayload);
  if (!encoded.length) return null;
  return crypto.createHash("sha1").update(encoded).digest("hex");
}

// ---------------------------------------------------------------------------
// isOwnEngagementCandidate
// ---------------------------------------------------------------------------

export function isOwnEngagementCandidate(
  candidate: EngagementTargetCandidate,
  agentMainUserId: string | null,
): boolean {
  if (agentMainUserId && candidate.authorId === agentMainUserId) {
    return true;
  }
  return candidate.source === "own_latest" || candidate.source.startsWith("own_latest+");
}

// ---------------------------------------------------------------------------
// shouldIncludeOwnLatestCommentLookup
// ---------------------------------------------------------------------------

export function shouldIncludeOwnLatestCommentLookup(input: {
  rawQuery: string;
  explicitPostId: number | null;
  explicitCommentId: number | null;
}): boolean {
  if (input.explicitPostId || input.explicitCommentId) return true;
  const query = input.rawQuery.trim();
  if (!query.length) return false;
  return SELF_COMMENT_OWN_TARGET_QUERY_PATTERN.test(query);
}

// ---------------------------------------------------------------------------
// extractEngagementTargetCandidateFromRecord
// ---------------------------------------------------------------------------

export function extractEngagementTargetCandidateFromRecord(
  record: Record<string, unknown>,
  source: string,
): EngagementTargetCandidate | null {
  const parseFrom = (entry: Record<string, unknown>): EngagementTargetCandidate | null => {
    const looksLikeCommentRecord =
      asPositiveInt(entry.commentId) !== null ||
      asPositiveInt(entry.parentId) !== null ||
      (asPositiveInt(entry.postId) !== null &&
        (asNonEmptyString(entry.body) !== null ||
          asNonEmptyString(entry.textBody) !== null));
    const postId =
      asPositiveInt(entry.postId) ??
      asPositiveInt(entry.targetPostId) ??
      (looksLikeCommentRecord ? null : asPositiveInt(entry.id));
    if (!postId) return null;
    const commentId =
      asPositiveInt(entry.commentId) ??
      asPositiveInt(entry.parentId) ??
      asPositiveInt(entry.targetCommentId) ??
      null;
    const author = isRecord(entry.author) ? entry.author : null;
    const authorId =
      asNonEmptyString(entry.authorId) ??
      asNonEmptyString(author?.mainUserId) ??
      asNonEmptyString(author?.id) ??
      null;
    const postSnapshotHash = computePostSnapshotHash({
      postId,
      commentId,
      postRecord: entry,
    });
    return {
      postId,
      commentId,
      authorId,
      source,
      postSnapshotHash,
    };
  };
  const direct = parseFrom(record);
  if (direct) return direct;
  for (const key of ["target", "post", "comment", "data"] as const) {
    const nested = isRecord(record[key]) ? record[key] : null;
    if (!nested) continue;
    const parsed = parseFrom(nested);
    if (parsed) return parsed;
  }
  return null;
}

// ---------------------------------------------------------------------------
// shouldAllowRareTopLevelSelfComment
// ---------------------------------------------------------------------------

export function shouldAllowRareTopLevelSelfComment(input: {
  commandId: string;
  postId: number;
  rawQuery: string;
}): { allow: boolean; reason: string; gateRoll: number } {
  const normalizedQuery = input.rawQuery.trim().toLowerCase();
  if (!normalizedQuery.length) {
    return {
      allow: false,
      reason: "empty_query",
      gateRoll: 100,
    };
  }
  if (!SELF_COMMENT_CLARIFICATION_INTENT_PATTERN.test(normalizedQuery)) {
    return {
      allow: false,
      reason: "no_clarification_intent",
      gateRoll: 100,
    };
  }
  const gateRoll = pickDeterministicIndex(
    `self_top_level_comment:${input.commandId}:${input.postId}:${normalizedQuery}`,
    100,
  );
  if (gateRoll < SELF_TOP_LEVEL_COMMENT_RARE_PERCENT) {
    return {
      allow: true,
      reason: "clarification_intent_rare_allow",
      gateRoll,
    };
  }
  return {
    allow: false,
    reason: "clarification_intent_gate_blocked",
    gateRoll,
  };
}
