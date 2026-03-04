import {
  applyTargetLock,
  buildTargetHash,
  isTargetLockMatch,
} from "../../lib/command-target.js";
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";

import {
  asNonEmptyString,
  asPositiveInt,
  normalizeAgentProvenanceValue,
  stripEmDashCharacters,
  truncateText,
} from "../helpers.js";
import { RequeueCommandError } from "../types.js";
import type { Command, CommandOutcome, EngagementTargetCandidate } from "../types.js";
import type { ExecuteWriteEngagementRuntime } from "./write-engagement-types.js";

export async function executeWriteComment(
  this: ExecuteWriteEngagementRuntime,
  command: Command,
): Promise<CommandOutcome> {
  const payload = isRecord(command.payload) ? command.payload : null;
  if (!payload) {
    return this.failedOutcome(command, "Invalid payload for write.commentPost.");
  }
  const body =
    asNonEmptyString(payload.body) ??
    asNonEmptyString(payload.requestText) ??
    asNonEmptyString(payload.prompt) ??
    "Write a concise, relevant reply to the target post.";
  let resolvedTarget: EngagementTargetCandidate | null = null;
  try {
    resolvedTarget =
      (await this.resolveEngagementTargetForDirective({
        payload,
        action: "comment",
        commandId: command.id,
      })) ?? null;
  } catch (error: unknown) {
    if (this.isNoTargetDiscoveryFailure(error)) {
      return this.failedOutcome(
        command,
        "No target post/comment candidates found after discovery scan.",
        "no_target_candidates",
      );
    }
    throw error;
  }
  if (!resolvedTarget) {
    throw new RequeueCommandError("comment_target_resolution_waiting_for_context:no_target");
  }
  const postId = resolvedTarget.postId;
  const parentId =
    asPositiveInt(payload.parentId) ??
    asPositiveInt(payload.commentId) ??
    asPositiveInt(payload.targetCommentId) ??
    resolvedTarget.commentId ??
    null;
  payload.postId = postId;
  payload.targetPostId = postId;
  if (parentId) {
    payload.parentId = parentId;
    payload.commentId = parentId;
    payload.targetCommentId = parentId;
  }
  if (resolvedTarget.postSnapshotHash) {
    payload.targetPostSnapshotHash = resolvedTarget.postSnapshotHash;
    payload.postSnapshotHash = resolvedTarget.postSnapshotHash;
  }
  const expectedTarget = {
    postId,
    commentId: parentId ?? null,
    targetHash: buildTargetHash({
      postId,
      commentId: parentId ?? null,
    }),
  };
  const lockMatch = isTargetLockMatch({
    payload,
    expected: expectedTarget,
  });
  if (!lockMatch.ok) {
    return this.failedOutcome(
      command,
      `Target lock mismatch: ${lockMatch.reason}.`,
      "target_lock_mismatch",
    );
  }
  const target = applyTargetLock(payload, {
    postId,
    commentId: parentId ?? null,
  });
  const idempotencyKey = this.buildActionIdempotencyKey({
    command,
    action: "comment",
    postId: target.postId,
    commentId: target.commentId,
    commentBody: body,
  });
  const dedupe = this.beginActionLifecycle({
    command,
    action: "comment",
    idempotencyKey,
    target,
    state: "context_ready",
  });
  if (!dedupe.allowed) {
    if (dedupe.requeue) {
      throw new RequeueCommandError(
        `comment_waiting_for_backoff:${dedupe.reason}`,
      );
    }
    return this.successOutcome(command, {
      skipped: true,
      action: "comment",
      postId: target.postId,
      commentId: target.commentId,
      decision: dedupe.reason,
    });
  }
  try {
    const grantId = await this.preflightGrantForAction({
      command,
      payload,
      action: "comment",
      lifecycle: {
        idempotencyKey,
        target,
      },
    });
    const provenance = normalizeAgentProvenanceValue(payload.provenance);
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command,
      payload,
    });
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;
    const curatedBody = await this.curateCommentBodyWithOpenClaw({
      command,
      payload,
      postId: target.postId,
      parentId: target.commentId,
      body,
      targetHash: target.targetHash,
      lifecycleIdempotencyKey: idempotencyKey,
    });
    this.updateActionLifecycle({
      command,
      action: "comment",
      idempotencyKey,
      target,
      state: "action_running",
    });
    const finalBody = stripEmDashCharacters(curatedBody.body);
    const result = await this.agent().commentPost.mutate({
      postId: target.postId,
      body: finalBody,
      ...(target.commentId ? { parentId: target.commentId } : {}),
      ...(provenance ? { provenance } : {}),
      ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
      ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
      ...(grantId ? { grantId } : {}),
    });
    await this.ctx.memory
      .recordWrite({
        type: "comment_body_curated",
        at: nowIso(),
        commandId: command.id,
        postId: target.postId,
        parentId: target.commentId,
        source: curatedBody.source,
        reason: curatedBody.reason,
        draftBody: truncateText(body, 200),
        finalBody: truncateText(finalBody, 200),
      })
      .catch(() => undefined);
    this.updateActionLifecycle({
      command,
      action: "comment",
      idempotencyKey,
      target,
      state: "acked",
      lastError: null,
    });
    return this.successOutcome(command, result);
  } catch (error: unknown) {
    if (error instanceof RequeueCommandError) {
      this.updateActionLifecycle({
        command,
        action: "comment",
        idempotencyKey,
        target,
        state: "requeue",
        lastError: error.message,
      });
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (this.isOwnerCapabilityDeniedError(error)) {
      this.registerOwnerCapabilityCooldown({
        action: "comment",
        targetHash: target.targetHash,
        reason: "not_granted",
      });
    }
    this.updateActionLifecycle({
      command,
      action: "comment",
      idempotencyKey,
      target,
      state: "failed",
      lastError: message,
    });
    throw error;
  }
}
