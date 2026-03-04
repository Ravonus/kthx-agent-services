import type { GeneratedDraft } from "../types.js";

import { asNonEmptyString } from "../helpers.js";

import { parseGrantCandidatesFromPermissionState } from "../../grants/grant-state.js";

import { isRecord } from "../../lib/guards.js";

export type PermissionCanState = {
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
};

export function parsePermissionCanState(permissionState: unknown): PermissionCanState {
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
