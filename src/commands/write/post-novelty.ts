/** Post novelty validation and history tracking helpers. */

import type { PostDraftContext, RecentPostNoveltyEntry } from "../types.js";

import {
  truncateText,
  normalizeCommentText,
  computeTokenOverlapRatio,
  hasLongNormalizedPhraseOverlap,
} from "../helpers.js";

import {
  POST_NOVELTY_HISTORY_WINDOW_MS,
  POST_NOVELTY_HISTORY_MAX_ITEMS,
  POST_NOVELTY_MAX_AVOID_REFERENCES,
  COMMENT_PROMPT_WRAPPER_PATTERN,
} from "../constants.js";

// ---------------------------------------------------------------------------
// buildPostNoveltyCandidateText
// ---------------------------------------------------------------------------

export function buildPostNoveltyCandidateText(input: {
  postType: "text" | "media";
  caption: string | null;
  textBody: string | null;
  mediaPrompt: string | null;
}): string {
  if (input.postType === "text") {
    return [input.caption ?? "", input.textBody ?? ""]
      .filter((value) => value.trim().length > 0)
      .join("\n")
      .trim();
  }
  return [input.caption ?? "", input.mediaPrompt ?? ""]
    .filter((value) => value.trim().length > 0)
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// pruneRecentPostNoveltyHistory
// ---------------------------------------------------------------------------

export function pruneRecentPostNoveltyHistory(
  history: RecentPostNoveltyEntry[],
  nowMs: number,
): void {
  let writeIndex = 0;
  for (const entry of history) {
    if (nowMs - entry.atMs > POST_NOVELTY_HISTORY_WINDOW_MS) continue;
    history[writeIndex] = entry;
    writeIndex += 1;
  }
  history.length = writeIndex;
  if (history.length <= POST_NOVELTY_HISTORY_MAX_ITEMS) {
    return;
  }
  const trimStart = history.length - POST_NOVELTY_HISTORY_MAX_ITEMS;
  history.splice(0, trimStart);
}

// ---------------------------------------------------------------------------
// snapshotRecentPostNoveltyReferences
// ---------------------------------------------------------------------------

export function snapshotRecentPostNoveltyReferences(
  history: RecentPostNoveltyEntry[],
  postType: "text" | "media",
): string[] {
  const nowMs = Date.now();
  pruneRecentPostNoveltyHistory(history, nowMs);
  const references: string[] = [];
  const seen = new Set<string>();
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (!entry) continue;
    if (entry.postType !== postType) continue;
    if (seen.has(entry.normalized)) continue;
    seen.add(entry.normalized);
    references.push(entry.text);
    if (references.length >= POST_NOVELTY_MAX_AVOID_REFERENCES) break;
  }
  return references;
}

// ---------------------------------------------------------------------------
// computeBidirectionalTokenOverlap
// ---------------------------------------------------------------------------

export function computeBidirectionalTokenOverlap(
  first: string,
  second: string,
): number {
  return Math.max(
    computeTokenOverlapRatio(first, second),
    computeTokenOverlapRatio(second, first),
  );
}

// ---------------------------------------------------------------------------
// validatePostDraftNovelty
// ---------------------------------------------------------------------------

export function validatePostDraftNovelty(
  history: RecentPostNoveltyEntry[],
  input: {
    postType: "text" | "media";
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
    context: PostDraftContext;
    seedHints: string[];
  },
):
  | { ok: true; candidateText: string }
  | {
      ok: false;
      reason: string;
      candidateText: string;
      referencePreview: string | null;
    } {
  const candidateText = buildPostNoveltyCandidateText({
    postType: input.postType,
    caption: input.caption,
    textBody: input.textBody,
    mediaPrompt: input.mediaPrompt,
  });
  if (candidateText.length < 12) {
    return {
      ok: false,
      reason: "candidate_too_short",
      candidateText,
      referencePreview: null,
    };
  }
  if (
    input.postType === "media" &&
    input.mediaPrompt &&
    COMMENT_PROMPT_WRAPPER_PATTERN.test(input.mediaPrompt)
  ) {
    return {
      ok: false,
      reason: "media_prompt_wrapper",
      candidateText,
      referencePreview: input.mediaPrompt,
    };
  }
  const normalizedCandidate = normalizeCommentText(candidateText);
  if (!normalizedCandidate.length) {
    return {
      ok: false,
      reason: "candidate_empty_after_normalization",
      candidateText,
      referencePreview: null,
    };
  }
  const compareAgainstReference = (
    reference: string,
    threshold: number,
    reasonPrefix: string,
  ):
    | { ok: true }
    | { ok: false; reason: string; referencePreview: string } => {
    const trimmedReference = reference.trim();
    if (trimmedReference.length < 12) return { ok: true };
    const normalizedReference = normalizeCommentText(trimmedReference);
    if (!normalizedReference.length) return { ok: true };
    if (normalizedCandidate === normalizedReference) {
      return {
        ok: false,
        reason: `same_as_${reasonPrefix}`,
        referencePreview: trimmedReference,
      };
    }
    const overlap = computeBidirectionalTokenOverlap(
      candidateText,
      trimmedReference,
    );
    if (overlap >= threshold) {
      return {
        ok: false,
        reason: `too_similar_to_${reasonPrefix}`,
        referencePreview: trimmedReference,
      };
    }
    if (
      hasLongNormalizedPhraseOverlap(candidateText, trimmedReference) &&
      overlap >= Math.max(0.42, threshold - 0.24)
    ) {
      return {
        ok: false,
        reason: `contains_${reasonPrefix}_phrase`,
        referencePreview: trimmedReference,
      };
    }
    return { ok: true };
  };

  const contextReferences = [
    input.context.postText,
    input.context.mediaSummary,
    input.context.commentSummary,
    input.context.payloadHint,
  ].filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length >= 12,
  );
  const contextThreshold = input.postType === "media" ? 0.72 : 0.78;
  for (const reference of contextReferences) {
    const check = compareAgainstReference(
      reference,
      contextThreshold,
      "target_context",
    );
    if (!check.ok) {
      return {
        ok: false,
        reason: check.reason,
        candidateText,
        referencePreview: truncateText(check.referencePreview, 240),
      };
    }
  }

  const seedThreshold = input.postType === "media" ? 0.74 : 0.8;
  for (const seed of input.seedHints) {
    const check = compareAgainstReference(
      seed,
      seedThreshold,
      "directive_seed",
    );
    if (!check.ok) {
      return {
        ok: false,
        reason: check.reason,
        candidateText,
        referencePreview: truncateText(check.referencePreview, 240),
      };
    }
  }

  const nowMs = Date.now();
  pruneRecentPostNoveltyHistory(history, nowMs);
  const historyThreshold = input.postType === "media" ? 0.68 : 0.76;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (!entry) continue;
    if (entry.postType !== input.postType) continue;
    if (entry.normalized === normalizedCandidate) {
      return {
        ok: false,
        reason: "same_as_recent_self_post",
        candidateText,
        referencePreview: truncateText(entry.text, 240),
      };
    }
    const overlap = computeBidirectionalTokenOverlap(
      candidateText,
      entry.text,
    );
    if (overlap >= historyThreshold) {
      return {
        ok: false,
        reason: "too_similar_to_recent_self_post",
        candidateText,
        referencePreview: truncateText(entry.text, 240),
      };
    }
    if (
      hasLongNormalizedPhraseOverlap(candidateText, entry.text) &&
      overlap >= Math.max(0.4, historyThreshold - 0.24)
    ) {
      return {
        ok: false,
        reason: "contains_recent_self_phrase",
        candidateText,
        referencePreview: truncateText(entry.text, 240),
      };
    }
  }
  return { ok: true, candidateText };
}

// ---------------------------------------------------------------------------
// notePublishedPostForNoveltyHistory
// ---------------------------------------------------------------------------

export function notePublishedPostForNoveltyHistory(
  history: RecentPostNoveltyEntry[],
  input: {
    postType: "text" | "media";
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
    commandId: string;
    targetPostId: number | null;
  },
): void {
  const text = buildPostNoveltyCandidateText({
    postType: input.postType,
    caption: input.caption,
    textBody: input.textBody,
    mediaPrompt: input.mediaPrompt,
  });
  if (text.length < 12) return;
  const normalized = normalizeCommentText(text);
  if (!normalized.length) return;
  const nowMs = Date.now();
  pruneRecentPostNoveltyHistory(history, nowMs);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (!entry) continue;
    if (entry.normalized !== normalized) continue;
    history.splice(index, 1);
  }
  history.push({
    atMs: nowMs,
    postType: input.postType,
    text,
    normalized,
    commandId: input.commandId,
    targetPostId: input.targetPostId,
  });
  pruneRecentPostNoveltyHistory(history, nowMs);
}
