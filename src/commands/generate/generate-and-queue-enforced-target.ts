import { RequeueCommandError } from "../types.js";
import type { Command, CommandOutcome } from "../types.js";
import { asPositiveInt } from "../helpers.js";
import { isRecord } from "../../lib/guards.js";
import type {
  ExecuteGenerateAndQueueRuntime,
  GenerateAndQueuePreparationResult,
} from "./generate-and-queue.js";

export const ensureEnforcedDraftTarget = async (
  runtime: ExecuteGenerateAndQueueRuntime,
  input: {
    command: Command;
    payload: Record<string, unknown>;
    enforcedDraftAction: "comment" | "like" | "repost";
  },
): Promise<Extract<GenerateAndQueuePreparationResult, { kind: "outcome" }> | null> => {
  const scopedDirective = isRecord(input.payload.directiveScope)
    ? input.payload.directiveScope
    : null;
  const scopedTarget =
    scopedDirective && isRecord(scopedDirective.target)
      ? scopedDirective.target
      : null;
  const hasTargetPostId =
    asPositiveInt(input.payload.postId) ??
    asPositiveInt(input.payload.targetPostId) ??
    (scopedDirective
      ? asPositiveInt(scopedDirective.targetPostId) ??
        (scopedTarget ? asPositiveInt(scopedTarget.postId) : null)
      : null);
  if (hasTargetPostId) {
    return null;
  }

  let resolvedTarget: Awaited<
    ReturnType<ExecuteGenerateAndQueueRuntime["resolveEngagementTargetForDirective"]>
  > = null;
  try {
    resolvedTarget = await runtime.resolveEngagementTargetForDirective({
      payload: input.payload,
      action: input.enforcedDraftAction,
      commandId: input.command.id,
    });
  } catch (error: unknown) {
    if (runtime.isNoTargetDiscoveryFailure(error)) {
      return {
        kind: "outcome",
        outcome: runtime.failedOutcome(
          input.command,
          `No target candidates found for ${input.enforcedDraftAction} after discovery scan.`,
          "no_target_candidates",
        ),
      };
    }
    throw error;
  }

  if (!resolvedTarget) {
    throw new RequeueCommandError(
      `engagement_target_resolution_waiting_for_context:${input.enforcedDraftAction}:no_target`,
    );
  }

  input.payload.postId = resolvedTarget.postId;
  input.payload.targetPostId = resolvedTarget.postId;
  if (input.enforcedDraftAction === "comment" && resolvedTarget.commentId) {
    input.payload.commentId = resolvedTarget.commentId;
    input.payload.parentId = resolvedTarget.commentId;
    input.payload.targetCommentId = resolvedTarget.commentId;
  }
  if (resolvedTarget.postSnapshotHash) {
    input.payload.targetPostSnapshotHash = resolvedTarget.postSnapshotHash;
    input.payload.postSnapshotHash = resolvedTarget.postSnapshotHash;
  }
  const nextScope = isRecord(input.payload.directiveScope)
    ? { ...input.payload.directiveScope }
    : ({} as Record<string, unknown>);
  nextScope.targetPostId = resolvedTarget.postId;
  if (input.enforcedDraftAction === "comment" && resolvedTarget.commentId) {
    nextScope.targetCommentId = resolvedTarget.commentId;
  }
  const nextScopeTarget = isRecord(nextScope.target)
    ? { ...nextScope.target }
    : ({} as Record<string, unknown>);
  nextScopeTarget.postId = resolvedTarget.postId;
  nextScopeTarget.commentId =
    input.enforcedDraftAction === "comment" ? (resolvedTarget.commentId ?? null) : null;
  nextScope.target = nextScopeTarget;
  input.payload.directiveScope = nextScope;
  return null;
};
