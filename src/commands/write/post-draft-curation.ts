/** Post draft curation helpers: prompt building, extraction, seed hints, and context loading. */

import type { PostDraftContext, PostVarietyMode } from "../types.js";

import {
  asNonEmptyString,
  asPositiveInt,
  truncateText,
  stripEmDashCharacters,
  normalizeCommentText,
} from "../helpers.js";

import { POST_NOVELTY_MAX_AVOID_REFERENCES } from "../constants.js";

import { isRecord } from "../../lib/guards.js";
import { parseJsonFromMixedText } from "../../lib/parsing.js";

import { buildPostVarietyModeRules } from "./post-variety.js";

// ---------------------------------------------------------------------------
// extractTargetPostIdForPostDraft
// ---------------------------------------------------------------------------

export function extractTargetPostIdForPostDraft(payload: Record<string, unknown>): number | null {
  const directPostId = asPositiveInt(payload.postId);
  if (directPostId) return directPostId;
  const targetPostId = asPositiveInt(payload.targetPostId);
  if (targetPostId) return targetPostId;
  const scope = isRecord(payload.directiveScope) ? payload.directiveScope : null;
  if (scope) {
    const scopedPostId = asPositiveInt(scope.targetPostId);
    if (scopedPostId) return scopedPostId;
    const scopedPost = isRecord(scope.target) ? scope.target : null;
    if (scopedPost) {
      const nestedPostId = asPositiveInt(scopedPost.postId);
      if (nestedPostId) return nestedPostId;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// extractPostDiscoverySignalFromRecord
// ---------------------------------------------------------------------------

export function extractPostDiscoverySignalFromRecord(record: Record<string, unknown>): string | null {
  const author = isRecord(record.author) ? record.author : null;
  const handle =
    asNonEmptyString(author?.handle) ??
    asNonEmptyString(record.authorHandle) ??
    asNonEmptyString(record.handle) ??
    null;
  const text =
    asNonEmptyString(record.textBody) ??
    asNonEmptyString(record.body) ??
    asNonEmptyString(record.caption) ??
    asNonEmptyString(record.text) ??
    asNonEmptyString(record.content) ??
    asNonEmptyString(record.title) ??
    asNonEmptyString(record.summary) ??
    null;
  const mediaCount = Array.isArray(record.mediaItems)
    ? record.mediaItems.length
    : asPositiveInt(record.mediaCount) ?? null;
  const compactText = text
    ? truncateText(stripEmDashCharacters(text).replace(/\s+/gu, " ").trim(), 120)
    : null;
  const mediaSummary =
    !compactText && mediaCount && mediaCount > 0
      ? `${mediaCount} media item${mediaCount === 1 ? "" : "s"}`
      : null;
  const signal = compactText ?? mediaSummary;
  if (!signal) return null;
  return handle ? `@${handle.replace(/^@+/u, "")}: ${signal}` : signal;
}

// ---------------------------------------------------------------------------
// collectDirectiveSeedHints
// ---------------------------------------------------------------------------

export function collectDirectiveSeedHints(payload: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  const push = (value: unknown): void => {
    const text = asNonEmptyString(value);
    if (!text) return;
    candidates.push(text);
  };
  push(payload.requestText);
  push(payload.topic);
  push(payload.prompt);
  push(payload.mediaPrompt);
  push(payload.imagePrompt);
  push(payload.caption);
  push(payload.textBody);
  push(payload.body);
  push(payload.text);
  push(payload.message);
  push(payload.title);
  const scope = isRecord(payload.directiveScope) ? payload.directiveScope : null;
  if (scope) {
    push(scope.reason);
    push(scope.note);
    push(scope.topic);
    push(scope.caption);
    push(scope.textBody);
    push(scope.body);
    push(scope.text);
    const target = isRecord(scope.target) ? scope.target : null;
    if (target) {
      push(target.caption);
      push(target.textBody);
      push(target.body);
    }
  }
  const normalized = new Set<string>();
  const deduped: string[] = [];
  for (const entry of candidates) {
    const clean = truncateText(entry, 320);
    const key = normalizeCommentText(clean);
    if (!key.length || normalized.has(key)) continue;
    normalized.add(key);
    deduped.push(clean);
  }
  return deduped.slice(0, 12);
}

// ---------------------------------------------------------------------------
// buildPostDraftCurationPrompt
// ---------------------------------------------------------------------------

export function buildPostDraftCurationPrompt(input: {
  postType: "text" | "media";
  caption: string | null;
  textBody: string | null;
  mediaPrompt: string | null;
  context: PostDraftContext;
  varietyMode: PostVarietyMode;
  seedHints: string[];
  avoidReferences: string[];
}): string {
  const contextLines = [
    typeof input.context.targetPostId === "number"
      ? `targetPostId: ${input.context.targetPostId}`
      : null,
    input.context.postText ? `targetPostText: ${input.context.postText}` : null,
    input.context.mediaSummary ? `targetMedia: ${input.context.mediaSummary}` : null,
    input.context.commentSummary ? `targetComments: ${input.context.commentSummary}` : null,
    input.context.payloadHint ? `directiveHint: ${input.context.payloadHint}` : null,
    input.context.memorySummary ? `memoryContext: ${input.context.memorySummary}` : null,
    input.context.platformSignals ? `platformSignals: ${input.context.platformSignals}` : null,
  ].filter((entry): entry is string => Boolean(entry));
  if (input.postType === "text") {
    return [
      "Rewrite this directive-generated POST so it is original, social, and context-aware.",
      "Use memoryContext + targetPostText + targetComments as grounding, then produce a fresh thought.",
      "Do not echo or paraphrase target post text/comments. Synthesize a new opinion or angle.",
      "Return strict JSON only with exactly this shape: {\"caption\":\"...\",\"textBody\":\"...\"}.",
      "Rules:",
      "- textBody: 40-240 chars, natural voice, no hashtags, no emojis.",
      "- caption: optional, 0-140 chars.",
      "- Never use em dash characters; use '-' or normal punctuation instead.",
      "- Must not reuse long phrases from targetPostText/targetMedia/directiveHint.",
      "- Must not reuse long phrases from directive seed text.",
      "- Must not reuse long phrases from recent self-post references.",
      ...buildPostVarietyModeRules(input.varietyMode, "text").map((rule) => `- ${rule}`),
      `draftCaption: ${input.caption ?? ""}`,
      `draftTextBody: ${input.textBody ?? ""}`,
      ...(input.seedHints.length > 0
        ? [
            "Directive seeds (avoid echo):",
            ...input.seedHints.slice(0, 8).map((entry) => `- ${entry}`),
          ]
        : []),
      ...(input.avoidReferences.length > 0
        ? [
            "Recent self-post references (must differ):",
            ...input.avoidReferences.slice(0, POST_NOVELTY_MAX_AVOID_REFERENCES).map((entry) => `- ${entry}`),
          ]
        : []),
      "Context:",
      ...contextLines.map((line) => `- ${line}`),
    ].join("\n");
  }
  return [
    "Rewrite this directive-generated MEDIA POST so it is original and not an echo.",
    "Use memoryContext + targetPostText + targetComments to create a new media direction.",
    "Do not copy title/caption/prompt from source post/comments/directive.",
    "Return strict JSON only with exactly this shape: {\"caption\":\"...\",\"mediaPrompt\":\"...\"}.",
    "Rules:",
    "- caption: 10-220 chars, natural social voice, no hashtags, no emojis.",
    "- mediaPrompt: 20-320 chars, concrete visual prompt, no wrappers like 'Generate an image of'.",
    "- Never use em dash characters; use '-' or normal punctuation instead.",
    "- Must be materially different from targetPostText/targetMedia/directiveHint.",
    "- Must be materially different from directive seed text.",
    "- Must be materially different from recent self-post references.",
    ...buildPostVarietyModeRules(input.varietyMode, "media").map((rule) => `- ${rule}`),
    `draftCaption: ${input.caption ?? ""}`,
    `draftMediaPrompt: ${input.mediaPrompt ?? ""}`,
    ...(input.seedHints.length > 0
      ? [
          "Directive seeds (avoid echo):",
          ...input.seedHints.slice(0, 8).map((entry) => `- ${entry}`),
        ]
      : []),
    ...(input.avoidReferences.length > 0
      ? [
          "Recent self-post references (must differ):",
          ...input.avoidReferences.slice(0, POST_NOVELTY_MAX_AVOID_REFERENCES).map((entry) => `- ${entry}`),
        ]
      : []),
    "Context:",
    ...contextLines.map((line) => `- ${line}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// extractCuratedPostDraftFromUnknown
// ---------------------------------------------------------------------------

export function extractCuratedPostDraftFromUnknown(
  value: unknown,
  postType: "text" | "media",
): { caption: string | null; textBody: string | null; mediaPrompt: string | null } | null {
  const fromString = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed.length) return null;
    const parsed = parseJsonFromMixedText(trimmed);
    if (parsed !== null && parsed !== raw) {
      return extractCuratedPostDraftFromUnknown(parsed, postType);
    }
    return null;
  };
  if (typeof value === "string") {
    return fromString(value);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = extractCuratedPostDraftFromUnknown(entry, postType);
      if (parsed) return parsed;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const caption =
    asNonEmptyString(value.caption) ??
    asNonEmptyString(value.title) ??
    null;
  const textBody =
    asNonEmptyString(value.textBody) ??
    asNonEmptyString(value.body) ??
    asNonEmptyString(value.text) ??
    null;
  const mediaPrompt =
    asNonEmptyString(value.mediaPrompt) ??
    asNonEmptyString(value.imagePrompt) ??
    asNonEmptyString(value.prompt) ??
    null;
  if (postType === "text" && textBody) {
    return {
      caption: caption ? stripEmDashCharacters(caption) : null,
      textBody: truncateText(stripEmDashCharacters(textBody), 240),
      mediaPrompt: null,
    };
  }
  if (postType === "media" && (mediaPrompt || caption)) {
    return {
      caption: caption ? truncateText(stripEmDashCharacters(caption), 2200) : null,
      textBody: null,
      mediaPrompt: mediaPrompt ? truncateText(stripEmDashCharacters(mediaPrompt), 320) : null,
    };
  }
  for (const key of ["draft", "payload", "result", "output", "data", "content"] as const) {
    const nested = extractCuratedPostDraftFromUnknown(value[key], postType);
    if (nested) return nested;
  }
  return null;
}

// ---------------------------------------------------------------------------
// buildChatLiteralFallbackPayloadFromStory
// ---------------------------------------------------------------------------

export function buildChatLiteralFallbackPayloadFromStory(input: {
  payload: Record<string, unknown>;
  fallbackPrompt?: string | null;
}): Record<string, unknown> {
  const chatContext = isRecord(input.payload.chatContext) ? input.payload.chatContext : null;
  const fallbackPrompt =
    asNonEmptyString(input.fallbackPrompt) ??
    asNonEmptyString(input.payload.mediaPrompt) ??
    asNonEmptyString(input.payload.imagePrompt) ??
    asNonEmptyString(input.payload.prompt) ??
    asNonEmptyString(input.payload.topic) ??
    asNonEmptyString(input.payload.caption) ??
    asNonEmptyString(chatContext?.originalMessage) ??
    "Generate an image that fulfills this chat request.";

  const nextPayload: Record<string, unknown> = {
    ...input.payload,
    goal: "media",
    generateKind: "media",
    generatedAssetType: "image",
    chatLiteralGenerate: true,
    requireExplicitPublishVerb: false,
    explicitPublishRequested: false,
    explicitPublishVerbDetected: false,
  };
  nextPayload.prompt = fallbackPrompt;
  nextPayload.instruction = fallbackPrompt;
  nextPayload.topic = fallbackPrompt;
  nextPayload.mediaPrompt = fallbackPrompt;
  nextPayload.imagePrompt = fallbackPrompt;
  return nextPayload;
}
