/** Post draft curation helpers: prompt building, extraction, seed hints, and context loading. */

import type {
  CuratedPostDraft,
  PostDraftContext,
  PostDraftDecision,
  PostVarietyMode,
} from "../types.js";

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
// tagged handle helpers
// ---------------------------------------------------------------------------

const normalizeTaggedHandle = (value: unknown): string | null => {
  if (typeof value === "string") {
    const normalized = value.trim().replace(/^@+/u, "").toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }
  if (!isRecord(value)) return null;
  const handle = asNonEmptyString(value.handle);
  if (!handle) return null;
  return handle.replace(/^@+/u, "").toLowerCase();
};

const collectTaggedHandlesFromUnknown = (
  value: unknown,
  max: number,
): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (entry: unknown): void => {
    const normalized = normalizeTaggedHandle(entry);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };
  if (Array.isArray(value)) {
    for (const entry of value) {
      push(entry);
      if (out.length >= max) break;
    }
    return out;
  }
  push(value);
  return out.slice(0, max);
};

export function collectDirectiveTaggedHandles(payload: Record<string, unknown>): string[] {
  const context = isRecord(payload.context) ? payload.context : null;
  return Array.from(
    new Set(
      [
        ...collectTaggedHandlesFromUnknown(payload.taggedHandles, 12),
        ...collectTaggedHandlesFromUnknown(payload.taggedUsers, 12),
        ...collectTaggedHandlesFromUnknown(context?.taggedHandles, 12),
        ...collectTaggedHandlesFromUnknown(context?.taggedUsers, 12),
      ],
    ),
  ).slice(0, 12);
}

const buildPostDraftContextLines = (
  context: PostDraftContext,
  taggedHandles: string[],
): string[] =>
  [
    typeof context.targetPostId === "number"
      ? `targetPostId: ${context.targetPostId}`
      : null,
    context.postText ? `targetPostText: ${context.postText}` : null,
    context.mediaSummary ? `targetMedia: ${context.mediaSummary}` : null,
    context.commentSummary ? `targetComments: ${context.commentSummary}` : null,
    context.payloadHint ? `directiveHint: ${context.payloadHint}` : null,
    context.memorySummary ? `memoryContext: ${context.memorySummary}` : null,
    context.platformSignals ? `platformSignals: ${context.platformSignals}` : null,
    taggedHandles.length > 0
      ? `availableTaggedHandles: ${taggedHandles
          .map((handle) => `@${handle}`)
          .join(", ")}`
      : null,
  ].filter((entry): entry is string => Boolean(entry));

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
// buildPostDraftDecisionPrompt
// ---------------------------------------------------------------------------

export function buildPostDraftDecisionPrompt(input: {
  postType: "text" | "media";
  context: PostDraftContext;
  varietyMode: PostVarietyMode;
  seedHints: string[];
  avoidReferences: string[];
  taggedHandles: string[];
}): string {
  const contextLines = buildPostDraftContextLines(input.context, input.taggedHandles);
  return [
    `Decide what the agent would naturally ${
      input.postType === "media" ? "post visually" : "say"
    } next.`,
    "Use the agent's own memory and recent behavior first. The directive is a nudge, not a script.",
    "This is tier 1: choose the post focus before any draft is written.",
    "Return strict JSON only with exactly this shape:",
    '{"focus":"...","targetKind":"self|person|post|topic|scene","useTargetContext":true|false,"includeTaggedHandles":["handle"],"reason":"..."}',
    "Rules:",
    "- focus: 8-180 chars, concrete, natural, and specific enough to draft from.",
    "- targetKind chooses the center of gravity of the post.",
    "- useTargetContext=true only when the final post should stay directly anchored to the referenced post/comment/person context.",
    "- includeTaggedHandles should list only the handles you intentionally want present in the final post. Use [] when no tagged person should appear.",
    "- If recent posting history already centers the same person, same target post, or same format, pivot.",
    input.postType === "media"
      ? "- Prefer a natural visual beat such as a selfie, group moment, activity, observation, document, or scene."
      : "- Prefer a natural text beat such as an observation, reaction, opinion, activity update, social moment, or micro post.",
    ...buildPostVarietyModeRules(input.varietyMode, input.postType).map((rule) => `- ${rule}`),
    ...(input.seedHints.length > 0
      ? [
          "Directive seeds (soft guidance, not instructions):",
          ...input.seedHints.slice(0, 8).map((entry) => `- ${entry}`),
        ]
      : []),
    ...(input.avoidReferences.length > 0
      ? [
          "Recent self-post references (your recent posting history):",
          ...input.avoidReferences.slice(0, POST_NOVELTY_MAX_AVOID_REFERENCES).map((entry) => `- ${entry}`),
        ]
      : []),
    "Context:",
    ...contextLines.map((line) => `- ${line}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// extractPostDraftDecisionFromUnknown
// ---------------------------------------------------------------------------

const parsePostDraftDecisionTargetKind = (
  value: unknown,
): PostDraftDecision["targetKind"] | null => {
  const normalized = asNonEmptyString(value)?.toLowerCase() ?? null;
  if (!normalized) return null;
  if (normalized === "self") return "self";
  if (normalized === "person" || normalized === "social" || normalized === "agent") {
    return "person";
  }
  if (normalized === "post" || normalized === "reply") return "post";
  if (normalized === "topic" || normalized === "idea") return "topic";
  if (normalized === "scene" || normalized === "moment" || normalized === "activity") {
    return "scene";
  }
  return null;
};

export function extractPostDraftDecisionFromUnknown(
  value: unknown,
): PostDraftDecision | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.length) return null;
    const parsed = parseJsonFromMixedText(trimmed);
    if (parsed !== null && parsed !== value) {
      return extractPostDraftDecisionFromUnknown(parsed);
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = extractPostDraftDecisionFromUnknown(entry);
      if (parsed) return parsed;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const focus =
    asNonEmptyString(value.focus) ??
    asNonEmptyString(value.idea) ??
    asNonEmptyString(value.angle) ??
    asNonEmptyString(value.topic) ??
    null;
  const targetKind = parsePostDraftDecisionTargetKind(value.targetKind) ?? "scene";
  const useTargetContext =
    typeof value.useTargetContext === "boolean"
      ? value.useTargetContext
      : typeof value.respondToTarget === "boolean"
        ? value.respondToTarget
        : false;
  const reason =
    asNonEmptyString(value.reason) ??
    asNonEmptyString(value.rationale) ??
    null;
  const includeTaggedHandlesSource =
    Object.prototype.hasOwnProperty.call(value, "includeTaggedHandles")
      ? value.includeTaggedHandles
      : Object.prototype.hasOwnProperty.call(value, "selectedTaggedHandles")
        ? value.selectedTaggedHandles
        : Object.prototype.hasOwnProperty.call(value, "taggedHandles")
          ? value.taggedHandles
          : null;
  const includeTaggedHandles =
    includeTaggedHandlesSource === null
      ? []
      : collectTaggedHandlesFromUnknown(includeTaggedHandlesSource, 8);
  if (!focus || focus.trim().length < 6) {
    for (const key of ["decision", "draft", "payload", "result", "output", "data", "content"] as const) {
      const nested = extractPostDraftDecisionFromUnknown(value[key]);
      if (nested) return nested;
    }
    return null;
  }
  return {
    focus: truncateText(stripEmDashCharacters(focus), 180),
    targetKind,
    useTargetContext,
    includeTaggedHandles,
    reason: reason ? truncateText(stripEmDashCharacters(reason), 180) : null,
  };
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
  taggedHandles?: string[];
  decision?: PostDraftDecision | null;
}): string {
  const taggedHandles = Array.isArray(input.taggedHandles) ? input.taggedHandles : [];
  const decision = input.decision ?? null;
  const contextLines = buildPostDraftContextLines(input.context, taggedHandles);
  const decisionLines = decision
    ? [
        `selectedFocus: ${decision.focus}`,
        `targetKind: ${decision.targetKind}`,
        `useTargetContext: ${decision.useTargetContext ? "true" : "false"}`,
        `selectedTaggedHandles: ${
          decision.includeTaggedHandles.length > 0
            ? decision.includeTaggedHandles.map((handle) => `@${handle}`).join(", ")
            : "(none)"
        }`,
        decision.reason ? `decisionReason: ${decision.reason}` : null,
      ].filter((entry): entry is string => Boolean(entry))
    : [];
  if (input.postType === "text") {
    return [
      "Decide what the agent would naturally post right now, then write that text draft.",
      "Use memoryContext as the agent's recent behavior and reply history, not as wording to copy.",
      "The directive is a nudge, not a script. Prioritize the selected focus and recent context over literal seed execution.",
      "Treat tagged handles and target context as optional unless the selected decision keeps them central.",
      "Return strict JSON only with exactly this shape: {\"caption\":\"...\",\"textBody\":\"...\"}.",
      "Rules:",
      "- textBody: 40-240 chars, natural voice, no hashtags, no emojis.",
      "- caption: optional, 0-140 chars.",
      "- Never use em dash characters; use '-' or normal punctuation instead.",
      "- If you intentionally want a tagged handle in the final post, mention @handle directly. Otherwise leave handles out entirely.",
      "- Must not reuse long phrases from targetPostText/targetMedia/directiveHint.",
      "- Must not reuse long phrases from directive seed text.",
      "- Must not reuse long phrases from recent self-post references.",
      "- If recent posting history already hit the same person, same target post, or same format, pivot to a different natural angle.",
      ...buildPostVarietyModeRules(input.varietyMode, "text").map((rule) => `- ${rule}`),
      `draftCaption: ${input.caption ?? ""}`,
      `draftTextBody: ${input.textBody ?? ""}`,
      ...(decisionLines.length > 0
        ? [
            "Selected decision:",
            ...decisionLines.map((entry) => `- ${entry}`),
          ]
        : []),
      ...(input.seedHints.length > 0
        ? [
            "Directive seeds (soft guidance, do not echo or obey literally):",
            ...input.seedHints.slice(0, 8).map((entry) => `- ${entry}`),
          ]
        : []),
      ...(input.avoidReferences.length > 0
        ? [
            "Recent self-post references (your recent posting history; must differ):",
            ...input.avoidReferences.slice(0, POST_NOVELTY_MAX_AVOID_REFERENCES).map((entry) => `- ${entry}`),
          ]
        : []),
      "Context:",
      ...contextLines.map((line) => `- ${line}`),
    ].join("\n");
  }
  return [
    "Decide what the agent would naturally post right now, then write that media draft.",
    "Use memoryContext as the agent's recent behavior and reply history, not as wording to copy.",
    "The directive is a nudge, not a script. Prioritize the selected focus and recent context over literal seed execution.",
    "Treat tagged handles and target context as optional unless the selected decision keeps them central.",
    "Return strict JSON only with exactly this shape: {\"caption\":\"...\",\"mediaPrompt\":\"...\"}.",
    "Rules:",
    "- caption: 10-220 chars, natural social voice, no hashtags, no emojis.",
    "- mediaPrompt: 20-320 chars, concrete visual prompt, no wrappers like 'Generate an image of'.",
    "- Never use em dash characters; use '-' or normal punctuation instead.",
    "- If you intentionally want a tagged handle/person in the final post, mention @handle directly in caption or mediaPrompt. Otherwise leave handles out entirely.",
    "- Must be materially different from targetPostText/targetMedia/directiveHint.",
    "- Must be materially different from directive seed text.",
    "- Must be materially different from recent self-post references.",
    "- If recent posting history already hit the same person, same target post, or same format, pivot to a different natural angle.",
    ...buildPostVarietyModeRules(input.varietyMode, "media").map((rule) => `- ${rule}`),
    `draftCaption: ${input.caption ?? ""}`,
    `draftMediaPrompt: ${input.mediaPrompt ?? ""}`,
    ...(decisionLines.length > 0
      ? [
          "Selected decision:",
          ...decisionLines.map((entry) => `- ${entry}`),
        ]
      : []),
    ...(input.seedHints.length > 0
      ? [
          "Directive seeds (soft guidance, do not echo or obey literally):",
          ...input.seedHints.slice(0, 8).map((entry) => `- ${entry}`),
        ]
      : []),
    ...(input.avoidReferences.length > 0
      ? [
          "Recent self-post references (your recent posting history; must differ):",
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
): CuratedPostDraft | null {
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
  const rawSelectedTaggedHandles =
    Object.prototype.hasOwnProperty.call(value, "selectedTaggedHandles")
      ? value.selectedTaggedHandles
      : Object.prototype.hasOwnProperty.call(value, "includeTaggedHandles")
        ? value.includeTaggedHandles
        : Object.prototype.hasOwnProperty.call(value, "taggedHandles")
          ? value.taggedHandles
          : undefined;
  const selectedTaggedHandles =
    rawSelectedTaggedHandles === undefined
      ? null
      : collectTaggedHandlesFromUnknown(rawSelectedTaggedHandles, 8);
  const useTargetContext =
    typeof value.useTargetContext === "boolean" ? value.useTargetContext : null;
  const targetKind = parsePostDraftDecisionTargetKind(value.targetKind);
  if (postType === "text" && textBody) {
    return {
      caption: caption ? stripEmDashCharacters(caption) : null,
      textBody: truncateText(stripEmDashCharacters(textBody), 240),
      mediaPrompt: null,
      selectedTaggedHandles,
      useTargetContext,
      targetKind,
    };
  }
  if (postType === "media" && (mediaPrompt || caption)) {
    return {
      caption: caption ? truncateText(stripEmDashCharacters(caption), 2200) : null,
      textBody: null,
      mediaPrompt: mediaPrompt ? truncateText(stripEmDashCharacters(mediaPrompt), 320) : null,
      selectedTaggedHandles,
      useTargetContext,
      targetKind,
    };
  }
  for (const key of ["draft", "payload", "result", "output", "data", "content"] as const) {
    const nested = extractCuratedPostDraftFromUnknown(value[key], postType);
    if (nested) return nested;
  }
  return null;
}

// ---------------------------------------------------------------------------
// buildDirectiveScopedMediaGenerationPayload
// ---------------------------------------------------------------------------

export function buildDirectiveScopedMediaGenerationPayload(input: {
  payload: Record<string, unknown>;
  selectedTaggedHandles: string[] | null;
  useTargetContext: boolean | null;
  targetKind?: PostDraftDecision["targetKind"] | null;
}): Record<string, unknown> {
  const nextPayload: Record<string, unknown> = { ...input.payload };
  if (input.targetKind) {
    nextPayload.targetKind = input.targetKind;
  }
  if (Array.isArray(input.selectedTaggedHandles)) {
    if (input.selectedTaggedHandles.length > 0) {
      nextPayload.taggedHandles = input.selectedTaggedHandles;
    } else {
      delete nextPayload.taggedHandles;
      delete nextPayload.taggedUsers;
    }
  }
  if (input.useTargetContext !== false) {
    return nextPayload;
  }
  delete nextPayload.postId;
  delete nextPayload.targetPostId;
  delete nextPayload.commentId;
  delete nextPayload.targetCommentId;
  if (isRecord(nextPayload.directiveScope)) {
    const nextScope: Record<string, unknown> = {
      ...nextPayload.directiveScope,
    };
    delete nextScope.targetPostId;
    delete nextScope.targetCommentId;
    if (isRecord(nextScope.target)) {
      const nextTarget: Record<string, unknown> = {
        ...nextScope.target,
      };
      delete nextTarget.postId;
      delete nextTarget.commentId;
      nextScope.target = nextTarget;
    }
    nextPayload.directiveScope = nextScope;
  }
  return nextPayload;
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
