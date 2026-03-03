/** Generate input helpers: kind resolution, permission state, and constraint logic. */

import type { GeneratedDraft } from "../types.js";

import {
  asNonEmptyString,
} from "../helpers.js";

import { parseGrantCandidatesFromPermissionState } from "../../grants/grant-state.js";

import { isRecord } from "../../lib/guards.js";

// ---------------------------------------------------------------------------
// mapAllowedWriteKindToGenerateKind
// ---------------------------------------------------------------------------

export function mapAllowedWriteKindToGenerateKind(commandKind: string): string | null {
  const normalized = commandKind.trim().toLowerCase();
  if (normalized === "write.commentpost") return "comment";
  if (normalized === "write.votepost") return "like";
  if (normalized === "write.repostpost") return "repost";
  if (normalized === "write.createstory") return "story";
  if (normalized === "write.createpost") return "thread";
  return null;
}

// ---------------------------------------------------------------------------
// resolveDirectiveScopeGenerateKinds
// ---------------------------------------------------------------------------

export function resolveDirectiveScopeGenerateKinds(payload: Record<string, unknown>): string[] {
  const scope = isRecord(payload.directiveScope) ? payload.directiveScope : null;
  if (!scope || !Array.isArray(scope.allowedCommandKinds)) return [];
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const value of scope.allowedCommandKinds) {
    if (typeof value !== "string") continue;
    const mapped = mapAllowedWriteKindToGenerateKind(value);
    if (!mapped || seen.has(mapped)) continue;
    seen.add(mapped);
    resolved.push(mapped);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// normalizeRequestedGenerateKind
// ---------------------------------------------------------------------------

export function normalizeRequestedGenerateKind(value: unknown): string | null {
  const raw = asNonEmptyString(value)?.toLowerCase();
  if (!raw) return null;
  const normalized = raw.replace(/[\s-]+/gu, "_");
  if (
    normalized === "story" ||
    normalized === "thread" ||
    normalized === "comment" ||
    normalized === "like" ||
    normalized === "repost" ||
    normalized === "media" ||
    normalized === "multi_media"
  ) {
    return normalized;
  }
  if (normalized === "stories") return "story";
  if (normalized === "reply") return "comment";
  if (normalized === "engagement") return "like";
  if (normalized === "boost") return "repost";
  if (
    normalized === "post" ||
    normalized === "image" ||
    normalized === "avatar" ||
    normalized === "banner"
  ) {
    return "media";
  }
  if (normalized === "carousel") return "multi_media";
  return null;
}

// ---------------------------------------------------------------------------
// resolveRequestedGenerateKinds
// ---------------------------------------------------------------------------

export function resolveRequestedGenerateKinds(
  payload: Record<string, unknown>,
  fallbackKind: string,
): string[] {
  const kinds: string[] = [];
  const seen = new Set<string>();
  const pushKind = (value: unknown): void => {
    const normalized = normalizeRequestedGenerateKind(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    kinds.push(normalized);
  };
  const pushArray = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      pushKind(entry);
    }
  };
  const pushCsvLike = (value: unknown): void => {
    const text = asNonEmptyString(value);
    if (!text) return;
    for (const token of text.split(/[,|]/u)) {
      pushKind(token);
    }
  };

  pushArray(payload.kinds);
  pushArray(payload.generateKinds);
  if (!Array.isArray(payload.kinds)) {
    pushCsvLike(payload.kinds);
  }
  if (!Array.isArray(payload.generateKinds)) {
    pushCsvLike(payload.generateKinds);
  }
  if (Array.isArray(payload.generateKind)) {
    pushArray(payload.generateKind);
  } else {
    pushKind(payload.generateKind);
  }

  if (kinds.length === 0) pushKind(payload.goal);
  if (kinds.length === 0) pushKind(payload.kind);
  if (kinds.length === 0) pushKind(fallbackKind);
  return kinds.slice(0, 6);
}

// ---------------------------------------------------------------------------
// isExplicitMultiMediaRequest
// ---------------------------------------------------------------------------

export function isExplicitMultiMediaRequest(payload: Record<string, unknown>): boolean {
  const context = isRecord(payload.context) ? payload.context : null;
  const isTruthy = (value: unknown): boolean =>
    value === true || value === "true";
  if (
    isTruthy(payload.multiMedia) ||
    isTruthy(payload.carousel) ||
    isTruthy(payload.mediaSlides) ||
    isTruthy(payload.enableSlides) ||
    isTruthy(context?.multiMedia) ||
    isTruthy(context?.carousel) ||
    isTruthy(context?.mediaSlides) ||
    isTruthy(context?.enableSlides)
  ) {
    return true;
  }
  const directItems = Array.isArray(payload.mediaItems) ? payload.mediaItems : [];
  const contextItems = Array.isArray(context?.mediaItems) ? context.mediaItems : [];
  if (directItems.length > 1 || contextItems.length > 1) return true;
  const goal = asNonEmptyString(payload.goal)?.toLowerCase() ?? "";
  if (goal === "multi_media" || goal === "carousel") return true;
  const mode =
    asNonEmptyString(payload.mode)?.toLowerCase() ??
    asNonEmptyString(payload.postMode)?.toLowerCase() ??
    "";
  if (mode === "multi_media" || mode === "carousel" || mode === "slides") {
    return true;
  }
  const requestedKinds = resolveRequestedGenerateKinds(payload, "media");
  return requestedKinds.includes("multi_media");
}

// ---------------------------------------------------------------------------
// parsePermissionCanState
// ---------------------------------------------------------------------------

export function parsePermissionCanState(permissionState: unknown): {
  hasHints: boolean;
  can: {
    postMedia: boolean;
    postText: boolean;
    story: boolean;
    comment: boolean;
    like: boolean;
    repost: boolean;
    imageGenerate: boolean;
    textGenerate: boolean;
  };
} {
  const canState = isRecord(permissionState)
    ? (isRecord(permissionState.can) ? permissionState.can : permissionState)
    : null;
  const readBoolean = (key: string): boolean | null => {
    if (!canState || typeof canState[key] !== "boolean") return null;
    return canState[key] === true;
  };
  const readBooleanAlias = (keys: string[]): boolean | null => {
    for (const key of keys) {
      const value = readBoolean(key);
      if (typeof value === "boolean") return value;
    }
    return null;
  };
  const values = {
    postMedia: readBoolean("postMedia"),
    postText: readBoolean("postText"),
    story: readBoolean("story"),
    comment: readBoolean("comment"),
    like: readBoolean("like"),
    repost: readBoolean("repost"),
    imageGenerate: readBooleanAlias([
      "imageGenerate",
      "generateImage",
      "image_generate",
      "generate_image",
    ]),
    textGenerate: readBooleanAlias([
      "textGenerate",
      "generateText",
      "text_generate",
      "generate_text",
    ]),
  };

  const grantCandidates = parseGrantCandidatesFromPermissionState(permissionState);
  const nowMs = Date.now();
  const hasActiveGrant = (actionKeys: readonly string[]): boolean => {
    for (const candidate of grantCandidates) {
      if (candidate.expiresAtMs <= nowMs) continue;
      for (const key of actionKeys) {
        const action = candidate.actions.get(key);
        if (action && action.remainingCount > 0) return true;
      }
    }
    return false;
  };

  if (values.postMedia !== true) {
    if (hasActiveGrant(["post:post:media", "post:thread:media"])) {
      values.postMedia = true;
    }
  }
  if (values.postText !== true) {
    if (hasActiveGrant(["post:post:text", "post:thread:text"])) {
      values.postText = true;
    }
  }
  if (values.story !== true) {
    if (hasActiveGrant(["story", "write.createStory"])) {
      values.story = true;
    }
  }
  if (values.comment !== true) {
    if (hasActiveGrant(["comment", "write.commentPost"])) {
      values.comment = true;
    }
  }
  if (values.like !== true) {
    if (hasActiveGrant(["like", "write.votePost"])) {
      values.like = true;
    }
  }
  if (values.repost !== true) {
    if (hasActiveGrant(["repost", "write.repostPost"])) {
      values.repost = true;
    }
  }
  if (values.imageGenerate !== true) {
    if (
      hasActiveGrant([
        "post:post:media",
        "post:thread:media",
        "story",
        "write.createStory",
        "image_generate",
        "generate_image",
      ]) ||
      values.postMedia === true ||
      values.story === true
    ) {
      values.imageGenerate = true;
    }
  }
  if (values.textGenerate !== true) {
    if (
      hasActiveGrant([
        "post:post:text",
        "post:thread:text",
        "comment",
        "write.commentPost",
        "like",
        "write.votePost",
        "repost",
        "write.repostPost",
        "text_generate",
        "generate_text",
      ]) ||
      values.postText === true ||
      values.comment === true ||
      values.like === true ||
      values.repost === true
    ) {
      values.textGenerate = true;
    }
  }

  const hasAnyHints =
    grantCandidates.length > 0 ||
    Object.values(values).some((value) => typeof value === "boolean");

  return {
    hasHints: hasAnyHints,
    can: {
      postMedia: values.postMedia === true,
      postText: values.postText === true,
      story: values.story === true,
      comment: values.comment === true,
      like: values.like === true,
      repost: values.repost === true,
      imageGenerate: values.imageGenerate !== false,
      textGenerate: values.textGenerate !== false,
    },
  };
}

// ---------------------------------------------------------------------------
// constrainGenerateKindsByPermissionState
// ---------------------------------------------------------------------------

export function constrainGenerateKindsByPermissionState(
  kinds: string[],
  permissionState: unknown,
): string[] {
  const permission = parsePermissionCanState(permissionState);
  if (!permission.hasHints || kinds.length === 0) return kinds;
  const allowed = new Set<string>();
  if (permission.can.postMedia || permission.can.postText) {
    if (permission.can.textGenerate) {
      allowed.add("thread");
    }
    if (permission.can.imageGenerate) {
      allowed.add("media");
      allowed.add("multi_media");
    }
  }
  if (permission.can.story && permission.can.imageGenerate) allowed.add("story");
  if (permission.can.comment && permission.can.textGenerate) allowed.add("comment");
  if (permission.can.like && permission.can.textGenerate) allowed.add("like");
  if (permission.can.repost) allowed.add("repost");
  if (allowed.size === 0) return [];

  const filtered = kinds.filter((kind) => allowed.has(kind));
  if (filtered.length > 0) return filtered.slice(0, 6);

  const fallbackOrder = [
    "comment",
    "like",
    "repost",
    "thread",
    "media",
    "multi_media",
    "story",
  ] as const;
  const fallback = fallbackOrder
    .filter((kind) => allowed.has(kind))
    .slice(0, 6);
  return fallback.length > 0 ? fallback : kinds;
}

// ---------------------------------------------------------------------------
// applyPermissionGenerateInputConstraints
// ---------------------------------------------------------------------------

export function applyPermissionGenerateInputConstraints(
  generateInput: Record<string, unknown>,
  permissionState: unknown,
): Record<string, unknown> {
  const normalizedKinds: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown): void => {
    const normalized = normalizeRequestedGenerateKind(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    normalizedKinds.push(normalized);
  };
  if (Array.isArray(generateInput.kinds)) {
    for (const value of generateInput.kinds) push(value);
  }
  push(generateInput.kind);
  if (normalizedKinds.length === 0) return generateInput;
  const constrained = constrainGenerateKindsByPermissionState(
    normalizedKinds,
    permissionState,
  );
  if (
    constrained.length === normalizedKinds.length &&
    constrained.every((value, index) => value === normalizedKinds[index])
  ) {
    return generateInput;
  }
  return {
    ...generateInput,
    kind: constrained[0] ?? generateInput.kind,
    kinds: constrained,
  };
}

// ---------------------------------------------------------------------------
// isGeneratedDraftAllowedByPermissionState
// ---------------------------------------------------------------------------

export function isGeneratedDraftAllowedByPermissionState(
  draft: GeneratedDraft,
  permissionState: unknown,
): boolean {
  const permission = parsePermissionCanState(permissionState);
  if (!permission.hasHints) return true;
  const action = draft.action.trim().toLowerCase();
  if (action === "comment") return permission.can.comment;
  if (action === "like") return permission.can.like;
  if (action === "repost") return permission.can.repost;
  if (action === "story") return permission.can.story;
  if (action === "post") {
    const payload = isRecord(draft.payload) ? draft.payload : null;
    const postType = asNonEmptyString(payload?.postType)?.toLowerCase() ?? "";
    if (postType === "text") return permission.can.postText;
    if (postType === "media") return permission.can.postMedia;
    return permission.can.postMedia || permission.can.postText;
  }
  return true;
}

// ---------------------------------------------------------------------------
// mapGoalToGenerateKind
// ---------------------------------------------------------------------------

export function mapGoalToGenerateKind(goal: string): string {
  if (goal === "avatar") return "media";
  if (goal === "banner") return "media";
  if (goal === "chat" || goal === "conversation") return "media";
  if (goal === "settings" || goal === "moderation") return "media";
  if (goal === "story") return "story";
  if (goal === "thread") return "thread";
  if (goal === "comment" || goal === "reply") return "comment";
  if (goal === "like" || goal === "engagement") return "like";
  if (goal === "repost" || goal === "boost") return "repost";
  if (goal === "multi_media" || goal === "carousel") return "multi_media";
  if (goal === "media" || goal === "image" || goal === "post") return "media";
  return "media";
}

// ---------------------------------------------------------------------------
// resolveEnforcedDraftAction
// ---------------------------------------------------------------------------

export function resolveEnforcedDraftAction(
  payload: Record<string, unknown>,
): "comment" | "like" | "repost" | null {
  const normalizedKinds = resolveRequestedGenerateKinds(payload, "story");
  const goal = asNonEmptyString(payload.goal)?.toLowerCase() ?? "";
  if (goal === "comment" || goal === "like" || goal === "repost") {
    if (
      normalizedKinds.length <= 1 ||
      normalizedKinds.every((kind) => kind === goal)
    ) {
      return goal;
    }
  }

  if (normalizedKinds.length === 1) {
    const onlyKind = normalizedKinds[0];
    if (onlyKind === "comment" || onlyKind === "like" || onlyKind === "repost") {
      return onlyKind;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// extractInlineDrafts
// ---------------------------------------------------------------------------

export function extractInlineDrafts(payload: Record<string, unknown>): GeneratedDraft[] {
  const drafts = Array.isArray(payload.drafts) ? payload.drafts : [];
  return drafts
    .map((entry) => {
      if (!isRecord(entry) || !isRecord(entry.payload)) return null;
      const action = asNonEmptyString(entry.action);
      if (!action) return null;
      return {
        action,
        payload: entry.payload,
      } satisfies GeneratedDraft;
    })
    .filter((entry): entry is GeneratedDraft => Boolean(entry));
}

// ---------------------------------------------------------------------------
// extractGeneratedDrafts
// ---------------------------------------------------------------------------

export function extractGeneratedDrafts(generatedResult: unknown): GeneratedDraft[] {
  if (!isRecord(generatedResult) || !Array.isArray(generatedResult.items)) return [];
  const drafts: GeneratedDraft[] = [];
  for (const item of generatedResult.items) {
    if (!isRecord(item) || !Array.isArray(item.drafts)) continue;
    for (const draft of item.drafts) {
      if (!isRecord(draft) || !isRecord(draft.payload)) continue;
      const action = asNonEmptyString(draft.action);
      if (!action) continue;
      drafts.push({
        action,
        payload: draft.payload,
      });
    }
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// isPersonaMediaCompatibleDraft
// ---------------------------------------------------------------------------

export function isPersonaMediaCompatibleDraft(draft: GeneratedDraft): boolean {
  const action = draft.action.trim().toLowerCase();
  if (action === "story" || action === "avatar" || action === "banner") return true;
  if (action !== "post") return false;
  const payload = isRecord(draft.payload) ? draft.payload : null;
  const postType = asNonEmptyString(payload?.postType)?.toLowerCase() ?? "";
  if (postType.length > 0) {
    if (
      postType === "media" ||
      postType === "image" ||
      postType === "gif" ||
      postType === "video" ||
      postType === "photo" ||
      postType === "sticker"
    ) {
      return true;
    }
    if (postType === "text" || postType === "thread") return false;
  }
  const generatedAssetType =
    asNonEmptyString(payload?.generatedAssetType)?.toLowerCase() ?? "";
  if (
    generatedAssetType === "image" ||
    generatedAssetType === "gif" ||
    generatedAssetType === "video"
  ) {
    return true;
  }
  const mediaPrompt =
    asNonEmptyString(payload?.mediaPrompt) ??
    asNonEmptyString(payload?.imagePrompt);
  if (mediaPrompt) return true;
  if (asNonEmptyString(payload?.mediaUrl)) return true;
  const mediaItemsRaw = payload?.mediaItems;
  const mediaItems = Array.isArray(mediaItemsRaw) ? mediaItemsRaw : [];
  return mediaItems.some((entry) => {
    if (!isRecord(entry)) return false;
    return Boolean(asNonEmptyString(entry.mediaUrl));
  });
}

// ---------------------------------------------------------------------------
// buildPersonaLockedMediaFallbackDraft
// ---------------------------------------------------------------------------

export function buildPersonaLockedMediaFallbackDraft(input: {
  payload: Record<string, unknown>;
  drafts: GeneratedDraft[];
}): GeneratedDraft | null {
  const sourceDraft = input.drafts.find(
    (draft) => draft.action.trim().toLowerCase() === "post",
  );
  const sourcePayload = sourceDraft && isRecord(sourceDraft.payload)
    ? sourceDraft.payload
    : null;
  const mediaPrompt =
    asNonEmptyString(sourcePayload?.mediaPrompt) ??
    asNonEmptyString(sourcePayload?.imagePrompt) ??
    asNonEmptyString(sourcePayload?.prompt) ??
    asNonEmptyString(sourcePayload?.textBody) ??
    asNonEmptyString(sourcePayload?.caption) ??
    asNonEmptyString(input.payload.mediaPrompt) ??
    asNonEmptyString(input.payload.imagePrompt) ??
    asNonEmptyString(input.payload.prompt) ??
    asNonEmptyString(input.payload.topic) ??
    "Photorealistic selfie of yourself with strong identity continuity.";
  const caption =
    asNonEmptyString(sourcePayload?.caption) ??
    asNonEmptyString(input.payload.caption);
  const mediaMode =
    asNonEmptyString(input.payload.mediaMode) ??
    asNonEmptyString(sourcePayload?.mediaMode) ??
    "selfie";
  const nextPayload: Record<string, unknown> = {
    ...(sourcePayload ?? {}),
    ...input.payload,
    postType: "media",
    generatedAssetType: "image",
    mediaPrompt,
    imagePrompt: mediaPrompt,
    prompt: mediaPrompt,
    mediaMode,
    mediaPersonaLock: true,
  };
  if (caption) {
    nextPayload.caption = caption;
  }
  return {
    action: "post",
    payload: nextPayload,
  };
}

// ---------------------------------------------------------------------------
// collectBridgeRecordItems
// ---------------------------------------------------------------------------

export function collectBridgeRecordItems(value: unknown): Record<string, unknown>[] {
  const collected: Record<string, unknown>[] = [];
  const seen = new Set<Record<string, unknown>>();
  const push = (entry: unknown): void => {
    if (!isRecord(entry) || seen.has(entry)) return;
    seen.add(entry);
    collected.push(entry);
  };
  if (Array.isArray(value)) {
    for (const entry of value) push(entry);
    return collected;
  }
  if (!isRecord(value)) return collected;
  for (const key of ["items", "results", "posts", "comments", "data"] as const) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      for (const entry of nested) push(entry);
    } else {
      push(nested);
    }
  }
  push(value.post);
  push(value.comment);
  if (collected.length === 0) push(value);
  return collected;
}

// ---------------------------------------------------------------------------
// collectMediaReferenceInputs
// ---------------------------------------------------------------------------

export function collectMediaReferenceInputs(
  payload: Record<string, unknown>,
  maxCollectedReferenceInputs: number,
  options?: {
    includeRecentGeneratedAsset?: boolean;
  },
): string[] {
  const context = isRecord(payload.context) ? payload.context : null;
  const includeRecentGeneratedAsset = options?.includeRecentGeneratedAsset !== false;
  const collected: string[] = [];
  const pushMaybe = (value: unknown): void => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed.length) return;
    collected.push(trimmed);
  };
  const pushMaybeArray = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (typeof entry === "string") {
        pushMaybe(entry);
        continue;
      }
      if (!isRecord(entry)) continue;
      pushMaybe(entry.mediaRef);
      pushMaybe(entry.uploadedUrl);
      pushMaybe(entry.mediaUrl);
      pushMaybe(entry.url);
      pushMaybe(entry.image);
      pushMaybe(entry.imageUrl);
      pushMaybe(entry.originalUrl);
      pushMaybe(entry.mediaOptimizedUrl);
      pushMaybe(entry.optimizedUrl);
      pushMaybe(entry.file);
      pushMaybe(entry.path);
      pushMaybe(entry.href);
    }
  };

  [
    payload.mediaReferenceUrls,
    payload.mediaReferenceFiles,
    payload.mediaReferenceMedia,
    payload.referenceMedia,
    payload.referenceImages,
    payload.taggedUsers,
    payload.mediaItems,
    context?.mediaReferenceUrls,
    context?.mediaReferenceFiles,
    context?.mediaReferenceMedia,
    context?.referenceMedia,
    context?.referenceImages,
    context?.taggedUsers,
    context?.mediaItems,
  ].forEach((value) => pushMaybeArray(value));
  [
    payload.mediaReferenceUrl,
    payload.mediaReferenceFile,
    payload.referenceImage,
    payload.referenceMediaUrl,
    context?.mediaReferenceUrl,
    context?.mediaReferenceFile,
    context?.referenceImage,
    context?.referenceMediaUrl,
    payload.mediaOptimizedUrl,
    payload.optimizedUrl,
    context?.mediaOptimizedUrl,
    context?.optimizedUrl,
  ].forEach((value) => pushMaybe(value));

  if (includeRecentGeneratedAsset) {
    const recentGeneratedAsset = isRecord(payload.recentGeneratedAsset)
      ? payload.recentGeneratedAsset
      : null;
    pushMaybe(recentGeneratedAsset?.href);
    pushMaybe(recentGeneratedAsset?.url);
    pushMaybe(recentGeneratedAsset?.imageUrl);
    pushMaybe(recentGeneratedAsset?.mediaUrl);
    pushMaybe(recentGeneratedAsset?.originalUrl);
    pushMaybe(recentGeneratedAsset?.optimizedUrl);
    pushMaybe(recentGeneratedAsset?.mediaOptimizedUrl);
  }

  return Array.from(new Set(collected)).slice(0, maxCollectedReferenceInputs);
}

// ---------------------------------------------------------------------------
// asNonNegativeInt
// ---------------------------------------------------------------------------

export function asNonNegativeInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}
