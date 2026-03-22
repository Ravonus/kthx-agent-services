/** Comment curation helpers: prompt building, body extraction/validation, and context summarization. */

import type { CommentCurationContext, CuratedCommentBody, ContextBundle } from "../types.js";

import {
  asNonEmptyString,
  asPositiveInt,
  truncateText,
  stripEmDashCharacters,
  normalizeCommentText,
  computeTokenOverlapRatio,
  hasLongNormalizedPhraseOverlap,
  tokenizeCommentText,
} from "../helpers.js";

import {
  COMMENT_ECHO_PREFIX_PATTERN,
  COMMENT_PROMPT_WRAPPER_PATTERN,
} from "../constants.js";

import { isRecord } from "../../lib/guards.js";
import { parseJsonFromMixedText } from "../../lib/parsing.js";

// ---------------------------------------------------------------------------
// extractCommentPayloadHint
// ---------------------------------------------------------------------------

export function extractCommentPayloadHint(payload: Record<string, unknown>): string | null {
  const hint = [
    asNonEmptyString(payload.requestText),
    asNonEmptyString(payload.topic),
    asNonEmptyString(payload.prompt),
    asNonEmptyString(payload.caption),
    asNonEmptyString(payload.textBody),
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return hint ? truncateText(hint, 180) : null;
}

// ---------------------------------------------------------------------------
// buildEngagementRetrievalQuery
// ---------------------------------------------------------------------------

export function buildEngagementRetrievalQuery(input: {
  action: "comment" | "like" | "repost";
  postId: number;
  commentId: number | null;
  payload: Record<string, unknown>;
}): string {
  const payloadHint = extractCommentPayloadHint(input.payload);
  const actionPhrase =
    input.action === "comment"
      ? "comment engagement context"
      : input.action === "like"
        ? "like engagement context"
        : "repost engagement context";
  const commentToken =
    typeof input.commentId === "number" ? `comment ${input.commentId}` : "";
  const hintToken = payloadHint ? `hint ${payloadHint}` : "";
  const scopeToken =
    input.action === "comment"
      ? "target post and thread only"
      : "most engaged comments last comments, likes and views this week";
  return [
    actionPhrase,
    `post ${input.postId}`,
    commentToken,
    scopeToken,
    hintToken,
  ]
    .filter((value) => value.length > 0)
    .join(" · ");
}

// ---------------------------------------------------------------------------
// buildCompactEngagementMemorySummary
// ---------------------------------------------------------------------------

export function buildCompactEngagementMemorySummary(bundle: ContextBundle): string | null {
  const lines: string[] = [];
  if (
    isRecord(bundle.retrieval) &&
    bundle.retrieval.enabled === true &&
    Array.isArray(bundle.retrieval.lines)
  ) {
    lines.push(
      ...bundle.retrieval.lines
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .slice(0, 8)
        .map((entry) => `retrieval: ${entry.trim()}`),
    );
  }
  if (
    isRecord(bundle.view) &&
    bundle.view.enabled === true &&
    Array.isArray(bundle.view.lines)
  ) {
    lines.push(
      ...bundle.view.lines
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .slice(0, 6)
        .map((entry) => `view: ${entry.trim()}`),
    );
  }
  if (
    isRecord(bundle.target) &&
    isRecord(bundle.target.focus) &&
    Array.isArray(bundle.target.focus.bullets)
  ) {
    lines.push(
      ...bundle.target.focus.bullets
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .slice(0, 6)
        .map((entry) => `focus: ${entry.trim()}`),
    );
  }
  if (
    isRecord(bundle.temporal) &&
    isRecord(bundle.temporal.tiers) &&
    isRecord(bundle.temporal.tiers["24h"]) &&
    Array.isArray(bundle.temporal.tiers["24h"].bullets)
  ) {
    lines.push(
      ...bundle.temporal.tiers["24h"].bullets
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .slice(0, 2)
        .map((entry) => `tier24h: ${entry.trim()}`),
    );
  }
  if (lines.length === 0) return null;
  return truncateText(lines.join("\n"), 2200);
}

// ---------------------------------------------------------------------------
// extractPostRecordForCommentCuration
// ---------------------------------------------------------------------------

export function extractPostRecordForCommentCuration(
  value: unknown,
  expectedPostId: number,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.data)) {
    return extractPostRecordForCommentCuration(value.data, expectedPostId);
  }
  if (isRecord(value.post)) {
    const postId = asPositiveInt(value.post.id);
    if (postId === expectedPostId) return value.post;
    return null;
  }
  if (Array.isArray(value.items)) {
    const items = value.items as unknown[];
    const match = items.find((entry): entry is Record<string, unknown> => {
      if (!isRecord(entry)) return false;
      const postId = asPositiveInt(entry.id);
      return postId === expectedPostId;
    });
    if (match) return match;
    return null;
  }
  const rootPostId = asPositiveInt(value.id);
  if (rootPostId === expectedPostId) {
    return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// extractCommentRecordForCommentCuration
// ---------------------------------------------------------------------------

export function extractCommentRecordForCommentCuration(
  value: unknown,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.data)) return extractCommentRecordForCommentCuration(value.data);
  if (isRecord(value.comment)) return value.comment;
  if (Array.isArray(value.comments)) {
    const first = value.comments.find((entry) => isRecord(entry));
    if (isRecord(first)) return first;
    return null;
  }
  return value;
}

// ---------------------------------------------------------------------------
// summarizeCommentsForPostDraft
// ---------------------------------------------------------------------------

export function summarizeCommentsForPostDraft(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const root = isRecord(value.data) ? value.data : value;
  const commentsRaw = Array.isArray(root.comments) ? root.comments : [];
  if (commentsRaw.length === 0) return null;
  const snippets: string[] = [];
  for (const item of commentsRaw) {
    if (!isRecord(item)) continue;
    const author = isRecord(item.author) ? item.author : null;
    const handle =
      asNonEmptyString(author?.handle) ??
      asNonEmptyString(item.authorHandle) ??
      "user";
    const body =
      asNonEmptyString(item.body) ??
      asNonEmptyString(item.textBody) ??
      null;
    if (!body) continue;
    snippets.push(`@${handle}: ${truncateText(body, 100)}`);
    if (snippets.length >= 5) break;
  }
  if (snippets.length === 0) return null;
  return truncateText(snippets.join(" | "), 600);
}

// ---------------------------------------------------------------------------
// summarizePostMediaForComment
// ---------------------------------------------------------------------------

export function summarizePostMediaForComment(post: Record<string, unknown>): string | null {
  const mediaItems = Array.isArray(post.mediaItems)
    ? post.mediaItems.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
  if (mediaItems.length === 0) return null;
  let imageCount = 0;
  let videoCount = 0;
  const captionHints: string[] = [];
  for (const item of mediaItems) {
    const mediaType = asNonEmptyString(item.mediaType)?.toLowerCase();
    if (mediaType === "video") {
      videoCount += 1;
    } else {
      imageCount += 1;
    }
    const caption = asNonEmptyString(item.caption);
    if (caption && captionHints.length < 3) {
      captionHints.push(truncateText(caption, 80));
    }
  }
  const bits = [
    imageCount > 0 ? `${imageCount} image${imageCount === 1 ? "" : "s"}` : null,
    videoCount > 0 ? `${videoCount} video${videoCount === 1 ? "" : "s"}` : null,
    captionHints.length > 0 ? `cues: ${captionHints.join(" | ")}` : null,
  ].filter((entry): entry is string => Boolean(entry));
  if (bits.length === 0) return null;
  return truncateText(bits.join(". "), 220);
}

// ---------------------------------------------------------------------------
// summarizeLensesForComment
// ---------------------------------------------------------------------------

export function summarizeLensesForComment(post: Record<string, unknown>): string | null {
  const lenses = Array.isArray(post.lenses)
    ? post.lenses.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
  if (lenses.length === 0) return null;
  const parts: string[] = [];
  for (const lens of lenses.slice(0, 3)) {
    const name = asNonEmptyString(lens.name);
    if (!name) continue;
    const desc = asNonEmptyString(lens.description);
    parts.push(desc ? `${name} - ${truncateText(desc, 80)}` : name);
  }
  if (parts.length === 0) return null;
  return truncateText(parts.join("; "), 220);
}

// ---------------------------------------------------------------------------
// summarizeTagsForComment
// ---------------------------------------------------------------------------

export function summarizeTagsForComment(post: Record<string, unknown>): string | null {
  const tags = Array.isArray(post.tags)
    ? post.tags.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
  const signalKeywords = Array.isArray(post.signalKeywords)
    ? post.signalKeywords.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  const signalCategories = Array.isArray(post.signalCategories)
    ? post.signalCategories.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  const parts: string[] = [];
  for (const tag of tags.slice(0, 5)) {
    const name = asNonEmptyString(tag.name) ?? asNonEmptyString(tag.slug);
    if (name) parts.push(`#${name}`);
  }
  if (signalKeywords.length > 0) {
    parts.push(...signalKeywords.slice(0, 5));
  }
  if (signalCategories.length > 0) {
    parts.push(...signalCategories.slice(0, 3).map((c) => `[${c}]`));
  }
  if (parts.length === 0) return null;
  return truncateText(parts.join(", "), 220);
}

// ---------------------------------------------------------------------------
// buildCommentCurationPrompt
// ---------------------------------------------------------------------------

export function buildCommentCurationPrompt(input: {
  postId: number;
  parentId: number | null;
  targetHash: string;
  draftBody: string;
  context: CommentCurationContext;
}): string {
  const contextLines = [
    `postId: ${input.postId}`,
    input.context.postKind ? `postKind: ${input.context.postKind}` : null,
    input.context.postAuthorHandle
      ? `postAuthor: @${input.context.postAuthorHandle.replace(/^@+/u, "")}`
      : null,
    input.context.communitySummary ? `community: ${input.context.communitySummary}` : null,
    input.context.tagsSummary ? `topics: ${input.context.tagsSummary}` : null,
    input.context.postText ? `postText: ${input.context.postText}` : null,
    input.context.mediaSummary ? `mediaContext: ${input.context.mediaSummary}` : null,
    input.context.threadSummary ? `threadContext: ${input.context.threadSummary}` : null,
    input.context.payloadHint ? `requestHint: ${input.context.payloadHint}` : null,
    input.context.memorySummary ? `memoryContext: ${input.context.memorySummary}` : null,
  ].filter((entry): entry is string => Boolean(entry));

  return [
    "You are rewriting a social-media comment for quality and relevance.",
    "Return strict JSON only with exactly this shape: {\"body\":\"...\"}.",
    "Rules:",
    "- body must be 14-180 characters.",
    "- 1-2 concise sentences in a natural voice.",
    "- Must clearly reference THIS target post/thread context.",
    "- Use community and topic context to understand the subject being discussed.",
    "- Include at least one concrete detail from post/media/thread/community context.",
    "- Do not copy wording from the draft or post text.",
    "- Never start with 'Frame N:' and never output image-prompt wrappers.",
    "- No hashtags, no emojis, no system/tool mentions.",
    "- Never use em dash characters; use '-' or normal punctuation instead.",
    "Return strict JSON ONLY with this exact shape:",
    `{"action":"comment","target":{"postId":${input.postId},"commentId":${input.parentId ?? "null"},"targetHash":"${input.targetHash}"},"body":"<comment>","reason":"<short reason>","shouldExecute":true}`,
    `Draft comment: ${input.draftBody}`,
    "Context:",
    ...contextLines.map((line) => `- ${line}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// normalizeCuratedCommentBody
// ---------------------------------------------------------------------------

export function normalizeCuratedCommentBody(value: string): string {
  const unfenced = value
    .replace(/^```(?:json|text|markdown)?\s*/iu, "")
    .replace(/```$/u, "")
    .trim();
  const unquoted = unfenced.replace(/^["'`]|["'`]$/gu, "").trim();
  const stripped = unquoted.replace(/^(?:body|comment|reply)\s*:\s*/iu, "").trim();
  return stripEmDashCharacters(stripped).replace(/\s+/gu, " ").trim();
}

// ---------------------------------------------------------------------------
// extractCuratedCommentBodyFromUnknown
// ---------------------------------------------------------------------------

export function extractCuratedCommentBodyFromUnknown(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.length) return null;
    const parsed = parseJsonFromMixedText(trimmed);
    if (parsed !== null && parsed !== value) {
      const fromParsed = extractCuratedCommentBodyFromUnknown(parsed);
      if (fromParsed) return fromParsed;
    }
    const normalized = normalizeCuratedCommentBody(trimmed);
    return normalized.length > 0 ? normalized : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const extracted = extractCuratedCommentBodyFromUnknown(entry);
      if (extracted) return extracted;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const keys = ["body", "comment", "reply", "text", "output", "result", "content"] as const;
  for (const key of keys) {
    const extracted = extractCuratedCommentBodyFromUnknown(value[key]);
    if (extracted) return extracted;
  }
  return null;
}

// ---------------------------------------------------------------------------
// hasTargetContextAnchor
// ---------------------------------------------------------------------------

export function hasTargetContextAnchor(
  candidate: string,
  context: CommentCurationContext,
): boolean {
  const anchorSource = [
    context.postText ?? "",
    context.mediaSummary ?? "",
    context.threadSummary ?? "",
  ]
    .filter((part) => part.trim().length > 0)
    .join(" \n ");
  const anchorTokens = Array.from(new Set(tokenizeCommentText(anchorSource)));
  if (anchorTokens.length < 3) {
    return true;
  }
  const candidateTokens = new Set(tokenizeCommentText(candidate));
  if (candidateTokens.size === 0) {
    return false;
  }
  const minimumOverlap = anchorTokens.length >= 12 ? 2 : 1;
  let overlap = 0;
  for (const token of anchorTokens) {
    if (candidateTokens.has(token)) {
      overlap += 1;
      if (overlap >= minimumOverlap) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// isDraftCommentEchoLike
// ---------------------------------------------------------------------------

export function isDraftCommentEchoLike(body: string, context: CommentCurationContext): boolean {
  const trimmed = body.trim();
  if (!trimmed.length) return true;
  if (COMMENT_ECHO_PREFIX_PATTERN.test(trimmed)) return true;
  if (COMMENT_PROMPT_WRAPPER_PATTERN.test(trimmed)) return true;
  if (
    context.postText &&
    normalizeCommentText(trimmed) === normalizeCommentText(context.postText)
  ) {
    return true;
  }
  if (context.postText && computeTokenOverlapRatio(trimmed, context.postText) >= 0.9) {
    return true;
  }
  if (
    context.postText &&
    hasLongNormalizedPhraseOverlap(trimmed, context.postText)
  ) {
    return true;
  }
  if (context.mediaSummary && computeTokenOverlapRatio(trimmed, context.mediaSummary) >= 0.9) {
    return true;
  }
  if (
    context.mediaSummary &&
    hasLongNormalizedPhraseOverlap(trimmed, context.mediaSummary)
  ) {
    return true;
  }
  if (context.threadSummary && computeTokenOverlapRatio(trimmed, context.threadSummary) >= 0.82) {
    return true;
  }
  if (
    context.threadSummary &&
    hasLongNormalizedPhraseOverlap(trimmed, context.threadSummary)
  ) {
    return true;
  }
  if (context.payloadHint && computeTokenOverlapRatio(trimmed, context.payloadHint) >= 0.84) {
    return true;
  }
  if (
    context.payloadHint &&
    hasLongNormalizedPhraseOverlap(trimmed, context.payloadHint)
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// validateCuratedCommentCandidate
// ---------------------------------------------------------------------------

export function validateCuratedCommentCandidate(input: {
  candidate: string;
  draftBody: string;
  context: CommentCurationContext;
}): { ok: true } | { ok: false; reason: string } {
  const candidate = input.candidate.trim();
  if (candidate.length < 10) {
    return { ok: false, reason: "too_short" };
  }
  if (candidate.length > 280) {
    return { ok: false, reason: "too_long" };
  }
  if (COMMENT_ECHO_PREFIX_PATTERN.test(candidate)) {
    return { ok: false, reason: "frame_prefix" };
  }
  if (COMMENT_PROMPT_WRAPPER_PATTERN.test(candidate)) {
    return { ok: false, reason: "prompt_wrapper" };
  }
  const normalizedCandidate = normalizeCommentText(candidate);
  const normalizedDraft = normalizeCommentText(input.draftBody);
  if (normalizedCandidate === normalizedDraft) {
    return { ok: false, reason: "same_as_draft" };
  }
  const draftOverlap = computeTokenOverlapRatio(candidate, input.draftBody);
  if (draftOverlap >= 0.86) {
    return { ok: false, reason: "too_similar_to_draft" };
  }
  if (hasLongNormalizedPhraseOverlap(candidate, input.draftBody)) {
    return { ok: false, reason: "contains_draft_phrase" };
  }
  if (input.context.postText) {
    const normalizedPostText = normalizeCommentText(input.context.postText);
    if (normalizedCandidate === normalizedPostText) {
      return { ok: false, reason: "same_as_post_text" };
    }
    const overlap = computeTokenOverlapRatio(candidate, input.context.postText);
    if (overlap >= 0.86) {
      return { ok: false, reason: "too_similar_to_post_text" };
    }
    if (hasLongNormalizedPhraseOverlap(candidate, input.context.postText)) {
      return { ok: false, reason: "contains_post_phrase" };
    }
  }
  if (input.context.mediaSummary) {
    const overlap = computeTokenOverlapRatio(candidate, input.context.mediaSummary);
    if (overlap >= 0.9) {
      return { ok: false, reason: "too_similar_to_media_summary" };
    }
    if (hasLongNormalizedPhraseOverlap(candidate, input.context.mediaSummary)) {
      return { ok: false, reason: "contains_media_summary_phrase" };
    }
  }
  if (input.context.threadSummary) {
    const overlap = computeTokenOverlapRatio(candidate, input.context.threadSummary);
    if (overlap >= 0.82) {
      return { ok: false, reason: "too_similar_to_thread_summary" };
    }
    if (hasLongNormalizedPhraseOverlap(candidate, input.context.threadSummary)) {
      return { ok: false, reason: "contains_thread_phrase" };
    }
  }
  if (input.context.payloadHint) {
    const overlap = computeTokenOverlapRatio(candidate, input.context.payloadHint);
    if (overlap >= 0.84) {
      return { ok: false, reason: "too_similar_to_payload_hint" };
    }
    if (hasLongNormalizedPhraseOverlap(candidate, input.context.payloadHint)) {
      return { ok: false, reason: "contains_payload_hint_phrase" };
    }
  }
  if (!hasTargetContextAnchor(candidate, input.context)) {
    return { ok: false, reason: "missing_target_context_anchor" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// buildDraftCommentFallback
// ---------------------------------------------------------------------------

export function buildDraftCommentFallback(input: {
  draftBody: string;
  context: CommentCurationContext;
}): CuratedCommentBody | null {
  const fallbackBody = normalizeCuratedCommentBody(input.draftBody);
  if (fallbackBody.length === 0 || fallbackBody.length > 280) {
    return null;
  }
  const echoLike = isDraftCommentEchoLike(fallbackBody, input.context);
  return {
    body: fallbackBody,
    source: "draft_fallback",
    reason: echoLike
      ? "generated_draft_fallback_echo_like"
      : "generated_draft_fallback",
  };
}
