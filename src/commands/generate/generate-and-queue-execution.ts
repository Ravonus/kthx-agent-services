import { RequeueCommandError } from "../types.js";
import type { CommandOutcome } from "../types.js";
import { asNonEmptyString, asPositiveInt, truncateText } from "../helpers.js";
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";
import type {
  ExecuteGenerateAndQueueRuntime,
  GenerateAndQueuePreparedState,
} from "./generate-and-queue.js";

export async function executePreparedGenerateAndQueue(
  this: ExecuteGenerateAndQueueRuntime,
  state: GenerateAndQueuePreparedState,
): Promise<CommandOutcome> {
  const {
    command,
    payload,
    sourceDirectiveId,
    sourceDirectiveActionNonce,
    provenance,
    generatedResult,
    executionDrafts,
  } = state;

  const executedOutcomes: CommandOutcome[] = [];
  const skippedDrafts: Array<{ kind: string; reason: string }> = [];
  const failedDrafts: Array<{ kind: string; reason: string; code: string | null }> = [];
  const blockedWriteKinds = new Set<string>();
  for (const draft of executionDrafts) {
    if (!draft) continue;
    const draftCommand = this.mapDraftToWriteCommand({
      draft,
      command,
      sourceDirectiveId,
      sourceDirectiveActionNonce,
      provenance,
    });
    if (!draftCommand) continue;
    const normalizedDraftKind = draftCommand.kind.trim().toLowerCase();
    if (blockedWriteKinds.has(normalizedDraftKind)) {
      skippedDrafts.push({
        kind: normalizedDraftKind,
        reason: "skipped_after_recoverable_grant_denial",
      });
      continue;
    }
    try {
      const outcome = await this.executeCommandFromMappedDraft(draftCommand);
      executedOutcomes.push(outcome);
      if (!outcome.ok) {
        const failureReason = asNonEmptyString(outcome.error?.message) ??
          "generated draft execution failed.";
        failedDrafts.push({
          kind: normalizedDraftKind,
          reason: failureReason,
          code: asNonEmptyString(outcome.error?.code) ?? null,
        });
        await this.ctx.memory
          .recordWrite({
            type: "generate_draft_execution_failed",
            at: nowIso(),
            commandId: command.id,
            draftKind: normalizedDraftKind,
            reason: failureReason,
            code: asNonEmptyString(outcome.error?.code) ?? null,
            sourceDirectiveId,
          })
          .catch(() => undefined);
        if (this.isRecoverableDraftGrantErrorMessage(failureReason)) {
          blockedWriteKinds.add(normalizedDraftKind);
        }
        continue;
      }
      const outcomeData = isRecord(outcome.data) ? outcome.data : null;
      const skipped = outcomeData?.skipped === true;
      const decision = asNonEmptyString(outcomeData?.decision);
      if (skipped) {
        const reason = decision ?? "skipped";
        skippedDrafts.push({
          kind: normalizedDraftKind,
          reason,
        });
        if (this.isRecoverableDraftSkipDecision(reason)) {
          blockedWriteKinds.add(normalizedDraftKind);
        }
      }
    } catch (error: unknown) {
      // If the write executor threw RequeueCommandError and no drafts have applied yet,
      // propagate it so the command actually gets requeued (with cached drafts).
      // This prevents burning a generated prompt for nothing.
      if (error instanceof RequeueCommandError) {
        const anyApplied = executedOutcomes.some((entry) => entry.ok);
        if (!anyApplied) {
          throw error;
        }
        // Some drafts already applied — can't requeue without creating duplicates,
        // so treat this draft as failed and continue.
      }
      const reason = error instanceof Error ? error.message : String(error);
      if (this.isRecoverableDraftExecutionError(error)) {
        blockedWriteKinds.add(normalizedDraftKind);
        skippedDrafts.push({
          kind: normalizedDraftKind,
          reason,
        });
        await this.ctx.memory
          .recordWrite({
            type: "generate_draft_execution_skipped",
            at: nowIso(),
            commandId: command.id,
            draftKind: normalizedDraftKind,
            reason,
            sourceDirectiveId,
          })
          .catch(() => undefined);
        continue;
      }
      failedDrafts.push({
        kind: normalizedDraftKind,
        reason,
        code: null,
      });
      await this.ctx.memory
        .recordWrite({
          type: "generate_draft_execution_failed",
          at: nowIso(),
          commandId: command.id,
          draftKind: normalizedDraftKind,
          reason,
          sourceDirectiveId,
        })
        .catch(() => undefined);
      if (this.isRecoverableDraftGrantErrorMessage(reason)) {
        blockedWriteKinds.add(normalizedDraftKind);
      }
      continue;
    }
  }

  const firstFailure = failedDrafts[0] ?? null;
  if (firstFailure && executedOutcomes.filter((entry) => entry.ok).length === 0) {
    await this.recordCommandLifecycleCheckpoint({
      command,
      stage: "write_mutation",
      status: "failed",
      message: firstFailure.reason,
      metadata: {
        executedCount: executedOutcomes.length,
        failedCount: failedDrafts.length,
      },
    });
    return this.failedOutcome(
      command,
      firstFailure.reason,
      firstFailure.code ?? undefined,
    );
  }

  const appliedOutcomeCount = executedOutcomes.filter((entry) => {
    if (!entry.ok) return false;
    const entryData = isRecord(entry.data) ? entry.data : null;
    return entryData?.skipped !== true;
  }).length;
  const skippedReasonSet = new Set(
    skippedDrafts
      .map((entry) => entry.reason.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
  const allSkippedReasonsIdempotentNoop =
    skippedReasonSet.size > 0 &&
    Array.from(skippedReasonSet).every(
      (reason) => reason === "already_acked" || reason === "already_in_flight",
    );
  if (appliedOutcomeCount === 0 && skippedDrafts.length > 0 && failedDrafts.length === 0) {
    if (allSkippedReasonsIdempotentNoop) {
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "write_mutation",
        status: "ok",
        metadata: {
          executedCount: executedOutcomes.length,
          skippedCount: skippedDrafts.length,
          failedCount: failedDrafts.length,
          idempotentNoop: true,
        },
      });
    } else {
    const firstSkipReason = skippedDrafts[0]?.reason ?? "no_executable_draft";
    await this.recordCommandLifecycleCheckpoint({
      command,
      stage: "write_mutation",
      status: "failed",
      message: firstSkipReason,
      metadata: {
        executedCount: executedOutcomes.length,
        skippedCount: skippedDrafts.length,
        failedCount: failedDrafts.length,
      },
    });
    return this.failedOutcome(
      command,
      `Generated drafts were skipped: ${truncateText(firstSkipReason, 220)}.`,
      "no_executable_draft",
    );
    }
  }

  if (executedOutcomes.length > 0 || skippedDrafts.length > 0 || failedDrafts.length > 0) {
    await this.recordCommandLifecycleCheckpoint({
      command,
      stage: "write_mutation",
      status: failedDrafts.length > 0 && appliedOutcomeCount === 0 ? "failed" : "ok",
      message: failedDrafts.length > 0 ? failedDrafts[0]?.reason ?? null : null,
      metadata: {
        executedCount: executedOutcomes.length,
        appliedCount: appliedOutcomeCount,
        executedKinds: executedOutcomes.map((entry) => entry.kind),
        skippedCount: skippedDrafts.length,
        failedCount: failedDrafts.length,
      },
    });
  }

  // Command completed — clear the draft cache entry.
  this.generatedDraftCache.delete(command.id);

  return this.successOutcome(command, {
    generated: generatedResult,
    executed: executedOutcomes.map((entry) => {
      const entryData = isRecord(entry.data) ? entry.data : null;
      const commandId = asNonEmptyString(entry.commandId) ?? "";
      const kind = asNonEmptyString(entry.kind) ?? "";
      const postId =
        asPositiveInt(entryData?.postId) ??
        asPositiveInt(entryData?.targetPostId) ??
        null;
      const commentId =
        asPositiveInt(entryData?.commentId) ??
        asPositiveInt(entryData?.parentId) ??
        asPositiveInt(entryData?.targetCommentId) ??
        null;
      const action = asNonEmptyString(entryData?.action) ?? null;
      const decision = asNonEmptyString(entryData?.decision) ?? null;
      const delta =
        typeof entryData?.delta === "number" && Number.isFinite(entryData.delta)
          ? entryData.delta
          : null;
      const applied = typeof entryData?.applied === "boolean" ? entryData.applied : null;
      return {
        commandId,
        kind,
        ok: entry.ok,
        skipped: entryData?.skipped === true,
        ...(action ? { action } : {}),
        ...(postId ? { postId } : {}),
        ...(commentId ? { commentId } : {}),
        ...(decision ? { decision } : {}),
        ...(delta !== null ? { delta } : {}),
        ...(applied !== null ? { applied } : {}),
      };
    }),
    ...(skippedDrafts.length > 0
      ? {
          skippedDrafts: skippedDrafts.slice(0, 24),
        }
      : {}),
    ...(failedDrafts.length > 0
      ? {
          failedDrafts: failedDrafts.slice(0, 24),
        }
      : {}),
  });
}
