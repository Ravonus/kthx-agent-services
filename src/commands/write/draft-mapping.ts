/** Map a generated draft to a write command with payload resolution and signing. */

import crypto from "node:crypto";

import type { Command } from "../../types/ipc.js";
import type { GeneratedDraft } from "../types.js";

import { asNonEmptyString, asPositiveInt } from "../helpers.js";
import { inheritChatContextIntoPayload } from "../../chat/chat-context.js";
import { computeCommandSignature } from "../../lib/crypto.js";
import { applyTargetLock } from "../../lib/command-target.js";
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";

// ---------------------------------------------------------------------------
// mapDraftToWriteCommand
// ---------------------------------------------------------------------------

export function mapDraftToWriteCommand(
  controlKey: string | null,
  input: {
    draft: GeneratedDraft;
    command: Command;
    sourceDirectiveId: string | null;
    sourceDirectiveActionNonce: string | null;
    provenance: string | null;
  },
): Command | null {
  const draft = input.draft;
  const action = draft.action.trim().toLowerCase();
  const inheritedPayload = inheritChatContextIntoPayload({
    payload: draft.payload,
    sourcePayload: input.command.payload,
  });
  const payload = isRecord(inheritedPayload) ? inheritedPayload : null;
  if (!payload) return null;

  const basePayload: Record<string, unknown> = {
    ...payload,
    ...(input.provenance ? { provenance: input.provenance } : {}),
    sourceDirectiveId: input.sourceDirectiveId,
    ...(input.sourceDirectiveActionNonce
      ? { sourceDirectiveActionNonce: input.sourceDirectiveActionNonce }
      : {}),
  };

  const id = `draft_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const createdAt = nowIso();

  const mappedKind =
    action === "story"
      ? "write.createStory"
      : action === "comment"
        ? "write.commentPost"
        : action === "repost"
          ? "write.repostPost"
        : action === "avatar"
          ? "write.updateAvatar"
          : action === "banner"
            ? "write.updateBanner"
          : action === "like"
            ? "write.votePost"
            : action === "post"
            ? "write.createPost"
            : null;
  if (!mappedKind) return null;

  const sourcePayload = isRecord(input.command.payload) ? input.command.payload : null;
  const sourcePostId = sourcePayload
    ? asPositiveInt(sourcePayload.postId) ??
      asPositiveInt(sourcePayload.targetPostId)
    : null;
  const sourceCommentId = sourcePayload
    ? asPositiveInt(sourcePayload.parentId) ??
      asPositiveInt(sourcePayload.commentId) ??
      asPositiveInt(sourcePayload.targetCommentId)
    : null;

  if (mappedKind === "write.votePost") {
    basePayload.vote = 1;
  }
  if (
    mappedKind === "write.commentPost" ||
    mappedKind === "write.votePost" ||
    mappedKind === "write.repostPost"
  ) {
    const lockedPostId = sourcePostId ?? asPositiveInt(basePayload.postId);
    const lockedCommentId =
      mappedKind === "write.commentPost"
        ? sourceCommentId ?? asPositiveInt(basePayload.parentId)
        : null;
    if (lockedPostId) {
      basePayload.postId = lockedPostId;
      if (mappedKind === "write.commentPost" && lockedCommentId) {
        basePayload.parentId = lockedCommentId;
        basePayload.commentId = lockedCommentId;
      }
      applyTargetLock(basePayload, {
        postId: lockedPostId,
        commentId: lockedCommentId ?? null,
      });
    }
  }
  if (mappedKind === "write.createPost") {
    const postTypeRaw = asNonEmptyString(basePayload.postType)?.toLowerCase();
    if (!postTypeRaw) {
      if (asNonEmptyString(basePayload.textBody)) {
        basePayload.postType = "text";
      } else {
        basePayload.postType = "media";
      }
    }
  }

  const command: Command = {
    id,
    createdAt,
    kind: mappedKind,
    grantId: input.command.grantId,
    payload: basePayload,
    sig: null,
    sourceDirectiveId: input.sourceDirectiveId,
    pendingDirectiveId: input.command.pendingDirectiveId,
    actionNonce: input.sourceDirectiveActionNonce,
    challenge: null,
    forceNow: input.command.forceNow,
    runtimeSessionId: null,
    runtimeOrigin: null,
    runtimeSig: null,
  };
  if (controlKey) {
    command.sig = computeCommandSignature(controlKey, command);
  }
  return command;
}
