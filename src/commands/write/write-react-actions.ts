import {
  applyTargetLock,
  buildTargetHash,
  isTargetLockMatch,
} from "../../lib/command-target.js";
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";

import {
  asNonEmptyString,
} from "../helpers.js";
import { RequeueCommandError } from "../types.js";
import type { Command, CommandOutcome, EngagementTargetCandidate } from "../types.js";
import type { ExecuteWriteEngagementRuntime } from "./write-engagement-types.js";

export async function executeWriteVote(
  this: ExecuteWriteEngagementRuntime,
  command: Command,
): Promise<CommandOutcome> {
  const payload = isRecord(command.payload) ? command.payload : null;
  if (!payload) return this.failedOutcome(command, "Invalid payload for write.votePost.");
  let resolvedTarget: EngagementTargetCandidate | null = null;
  try {
    resolvedTarget =
      (await this.resolveEngagementTargetForDirective({
        payload,
        action: "like",
        commandId: command.id,
      })) ?? null;
  } catch (error: unknown) {
    if (this.isNoTargetDiscoveryFailure(error)) {
      return this.failedOutcome(
        command,
        "No target post candidates found after discovery scan.",
        "no_target_candidates",
      );
    }
    throw error;
  }
  if (!resolvedTarget) {
    throw new RequeueCommandError("like_target_resolution_waiting_for_context:no_target");
  }
  const postId = resolvedTarget.postId;
  payload.postId = postId;
  payload.targetPostId = postId;
  const expectedTarget = {
    postId,
    commentId: null,
    targetHash: buildTargetHash({
      postId,
      commentId: null,
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
    commentId: null,
  });
  const idempotencyKey = this.buildActionIdempotencyKey({
    command,
    action: "like",
    postId: target.postId,
    commentId: target.commentId,
  });
  const dedupe = this.beginActionLifecycle({
    command,
    action: "like",
    idempotencyKey,
    target,
    state: "context_ready",
  });
  if (!dedupe.allowed) {
    if (dedupe.requeue) {
      throw new RequeueCommandError(
        `engagement_like_waiting_for_backoff:${dedupe.reason}`,
      );
    }
    return this.successOutcome(command, {
      skipped: true,
      action: "like",
      postId: target.postId,
      decision: dedupe.reason,
    });
  }
  const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
    command,
    payload,
  });
  const sourceDirectiveActionNonce =
    asNonEmptyString(payload.sourceDirectiveActionNonce) ??
    command.actionNonce ??
    null;
  const voteRaw =
    typeof payload.vote === "number" && Number.isFinite(payload.vote)
      ? Math.trunc(payload.vote)
      : 1;
  const vote = voteRaw > 0 ? 1 : voteRaw < 0 ? -1 : 0;
  try {
    const grantId = await this.preflightGrantForAction({
      command,
      payload,
      action: "like",
      lifecycle: {
        idempotencyKey,
        target,
      },
    });
    if (vote === 1) {
      const decision = await this.evaluateEngagementActionWithOpenClaw({
        command,
        action: "like",
        postId,
        payload,
        targetHash: target.targetHash,
        lifecycleIdempotencyKey: idempotencyKey,
      });
      const needsRequeue =
        !decision.shouldExecute &&
        decision.reason.trim().toLowerCase().startsWith("openclaw_");
      if (needsRequeue) {
        throw new RequeueCommandError(
          `engagement_like_waiting_for_openclaw:${decision.reason}`,
        );
      }
      await this.ctx.memory
        .recordWrite({
          type: "engagement_action_decision",
          at: nowIso(),
          commandId: command.id,
          action: "like",
          postId,
          shouldExecute: decision.shouldExecute,
          reason: decision.reason,
          source: decision.source,
        })
        .catch(() => undefined);
      if (!decision.shouldExecute) {
        const explicitRequested =
          command.forceNow === true ||
          payload.explicitPublishRequested === true ||
          payload.forceNow === true ||
          payload.userExplicitRequest === true ||
          command.runtimeOrigin === "director_directive" ||
          command.runtimeOrigin === "pending_promotion";
        if (explicitRequested) {
          await this.ctx.memory
            .recordWrite({
              type: "engagement_action_decision_overridden",
              at: nowIso(),
              commandId: command.id,
              action: "like",
              postId,
              reason: decision.reason,
              source: decision.source,
              override: "explicit_request",
            })
            .catch(() => undefined);
        } else {
          this.updateActionLifecycle({
            command,
            action: "like",
            idempotencyKey,
            target,
            state: "acked",
            lastError: null,
          });
          return this.successOutcome(command, {
            skipped: true,
            action: "like",
            postId,
            decision: decision.reason,
          });
        }
      }
    }
    this.updateActionLifecycle({
      command,
      action: "like",
      idempotencyKey,
      target,
      state: "action_running",
    });
    const result = await this.agent().votePost.mutate({
      postId,
      vote,
      ...(grantId ? { grantId } : {}),
      ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
      ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
    });
    const resultRecord = isRecord(result) ? result : null;
    if (resultRecord?.applied === false) {
      this.updateActionLifecycle({
        command,
        action: "like",
        idempotencyKey,
        target,
        state: "acked",
        lastError: null,
      });
      return this.successOutcome(command, {
        skipped: true,
        action: "like",
        postId,
        applied: false,
        ...(typeof resultRecord.delta === "number" && Number.isFinite(resultRecord.delta)
          ? { delta: resultRecord.delta }
          : {}),
        decision:
          asNonEmptyString(resultRecord.decision) ??
          (resultRecord.liked === false ? "noop_not_liked" : "noop"),
      });
    }
    this.updateActionLifecycle({
      command,
      action: "like",
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
        action: "like",
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
        action: "like",
        targetHash: target.targetHash,
        reason: "not_granted",
      });
    }
    this.updateActionLifecycle({
      command,
      action: "like",
      idempotencyKey,
      target,
      state: "failed",
      lastError: message,
    });
    throw error;
  }
}

export async function executeWriteRepost(
  this: ExecuteWriteEngagementRuntime,
  command: Command,
): Promise<CommandOutcome> {
  const payload = isRecord(command.payload) ? command.payload : null;
  if (!payload) return this.failedOutcome(command, "Invalid payload for write.repostPost.");
  let resolvedTarget: EngagementTargetCandidate | null = null;
  try {
    resolvedTarget =
      (await this.resolveEngagementTargetForDirective({
        payload,
        action: "repost",
        commandId: command.id,
      })) ?? null;
  } catch (error: unknown) {
    if (this.isNoTargetDiscoveryFailure(error)) {
      return this.failedOutcome(
        command,
        "No target post candidates found after discovery scan.",
        "no_target_candidates",
      );
    }
    throw error;
  }
  if (!resolvedTarget) {
    throw new RequeueCommandError("repost_target_resolution_waiting_for_context:no_target");
  }
  const postId = resolvedTarget.postId;
  payload.postId = postId;
  payload.targetPostId = postId;
  const expectedTarget = {
    postId,
    commentId: null,
    targetHash: buildTargetHash({
      postId,
      commentId: null,
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
    commentId: null,
  });
  const idempotencyKey = this.buildActionIdempotencyKey({
    command,
    action: "repost",
    postId: target.postId,
    commentId: target.commentId,
  });
  const dedupe = this.beginActionLifecycle({
    command,
    action: "repost",
    idempotencyKey,
    target,
    state: "context_ready",
  });
  if (!dedupe.allowed) {
    if (dedupe.requeue) {
      throw new RequeueCommandError(
        `engagement_repost_waiting_for_backoff:${dedupe.reason}`,
      );
    }
    return this.successOutcome(command, {
      skipped: true,
      action: "repost",
      postId: target.postId,
      decision: dedupe.reason,
    });
  }
  const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
    command,
    payload,
  });
  const sourceDirectiveActionNonce =
    asNonEmptyString(payload.sourceDirectiveActionNonce) ??
    command.actionNonce ??
    null;
  const repost = payload.repost === 0 ? 0 : 1;
  try {
    const grantId = await this.preflightGrantForAction({
      command,
      payload,
      action: "repost",
      lifecycle: {
        idempotencyKey,
        target,
      },
    });
    if (repost === 1) {
      const decision = await this.evaluateEngagementActionWithOpenClaw({
        command,
        action: "repost",
        postId,
        payload,
        targetHash: target.targetHash,
        lifecycleIdempotencyKey: idempotencyKey,
      });
      const needsRequeue =
        !decision.shouldExecute &&
        decision.reason.trim().toLowerCase().startsWith("openclaw_");
      if (needsRequeue) {
        throw new RequeueCommandError(
          `engagement_repost_waiting_for_openclaw:${decision.reason}`,
        );
      }
      await this.ctx.memory
        .recordWrite({
          type: "engagement_action_decision",
          at: nowIso(),
          commandId: command.id,
          action: "repost",
          postId,
          shouldExecute: decision.shouldExecute,
          reason: decision.reason,
          source: decision.source,
        })
        .catch(() => undefined);
      if (!decision.shouldExecute) {
        const explicitRequested =
          command.forceNow === true ||
          payload.explicitPublishRequested === true ||
          payload.forceNow === true ||
          payload.userExplicitRequest === true ||
          command.runtimeOrigin === "director_directive" ||
          command.runtimeOrigin === "pending_promotion";
        if (explicitRequested) {
          await this.ctx.memory
            .recordWrite({
              type: "engagement_action_decision_overridden",
              at: nowIso(),
              commandId: command.id,
              action: "repost",
              postId,
              reason: decision.reason,
              source: decision.source,
              override: "explicit_request",
            })
            .catch(() => undefined);
        } else {
          this.updateActionLifecycle({
            command,
            action: "repost",
            idempotencyKey,
            target,
            state: "acked",
            lastError: null,
          });
          return this.successOutcome(command, {
            skipped: true,
            action: "repost",
            postId,
            decision: decision.reason,
          });
        }
      }
    }
    this.updateActionLifecycle({
      command,
      action: "repost",
      idempotencyKey,
      target,
      state: "action_running",
    });
    const result = await this.agent().repostPost.mutate({
      postId,
      repost,
      ...(grantId ? { grantId } : {}),
      ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
      ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
    });
    const resultRecord = isRecord(result) ? result : null;
    if (resultRecord?.applied === false) {
      this.updateActionLifecycle({
        command,
        action: "repost",
        idempotencyKey,
        target,
        state: "acked",
        lastError: null,
      });
      return this.successOutcome(command, {
        skipped: true,
        action: "repost",
        postId,
        applied: false,
        ...(typeof resultRecord.delta === "number" && Number.isFinite(resultRecord.delta)
          ? { delta: resultRecord.delta }
          : {}),
        decision:
          asNonEmptyString(resultRecord.decision) ??
          (resultRecord.reposted === false ? "noop_not_reposted" : "noop"),
      });
    }
    this.updateActionLifecycle({
      command,
      action: "repost",
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
        action: "repost",
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
        action: "repost",
        targetHash: target.targetHash,
        reason: "not_granted",
      });
    }
    this.updateActionLifecycle({
      command,
      action: "repost",
      idempotencyKey,
      target,
      state: "failed",
      lastError: message,
    });
    throw error;
  }
}
