/** Generate input helpers: kind resolution, permission state, and constraint logic. */

import type { GeneratedDraft } from "../types.js";

import {
  asNonEmptyString,
} from "../helpers.js";

import { isRecord } from "../../lib/guards.js";
import {
  constrainGenerateKindsByPermissionState,
  isGeneratedDraftAllowedByPermissionState,
  parsePermissionCanState,
} from "./generate-input-permissions.js";

export {
  parsePermissionCanState,
  constrainGenerateKindsByPermissionState,
  isGeneratedDraftAllowedByPermissionState,
};

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
  const scopedGenerateKinds = resolveDirectiveScopeGenerateKinds(payload).filter(
    (kind): kind is "comment" | "like" | "repost" =>
      kind === "comment" || kind === "like" || kind === "repost",
  );
  if (scopedGenerateKinds.length === 1) {
    return scopedGenerateKinds[0] ?? null;
  }

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
    "Create a new photorealistic image with strong identity continuity and a fresh scene.";
  const caption =
    asNonEmptyString(sourcePayload?.caption) ??
    asNonEmptyString(input.payload.caption);
  const nextPayload: Record<string, unknown> = {
    ...(sourcePayload ?? {}),
    ...input.payload,
    postType: "media",
    generatedAssetType: "image",
    mediaPrompt,
    imagePrompt: mediaPrompt,
    prompt: mediaPrompt,
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
    payload.mediaItems,
    context?.mediaReferenceUrls,
    context?.mediaReferenceFiles,
    context?.mediaReferenceMedia,
    context?.referenceMedia,
    context?.referenceImages,
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
    const recentGeneratedAssetType =
      asNonEmptyString(recentGeneratedAsset?.type)?.trim().toLowerCase() ?? "";
    const includeRecentGeneratedPersonaReference =
      recentGeneratedAssetType !== "persona" && recentGeneratedAssetType !== "avatar";
    if (includeRecentGeneratedPersonaReference) {
      pushMaybe(recentGeneratedAsset?.href);
      pushMaybe(recentGeneratedAsset?.url);
      pushMaybe(recentGeneratedAsset?.imageUrl);
      pushMaybe(recentGeneratedAsset?.mediaUrl);
      pushMaybe(recentGeneratedAsset?.originalUrl);
      pushMaybe(recentGeneratedAsset?.optimizedUrl);
      pushMaybe(recentGeneratedAsset?.mediaOptimizedUrl);
    }
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
