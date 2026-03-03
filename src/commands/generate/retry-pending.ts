import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";
import { asPositiveInt } from "../helpers.js";
import type { Command, CommandExecutorContext, CommandOutcome } from "../types.js";

type RetryPendingSummary = {
  scanned: number;
  promoted: number;
  skippedPermissionDenied: number;
  skippedTerminal: number;
  skippedAlreadySeen: number;
  skippedQueued: number;
  limit: number;
};

type RetryPendingDeps = {
  ctx: CommandExecutorContext;
  resolveCommandSourceDirectiveId: (input: {
    command: Command;
    payload?: Record<string, unknown> | null;
  }) => string | null;
  successOutcome: (command: Command, data: unknown) => CommandOutcome;
  failedOutcome: (
    command: Command,
    message: string,
    code?: string,
  ) => CommandOutcome;
};

export async function executeRetryPending(
  command: Command,
  deps: RetryPendingDeps,
): Promise<CommandOutcome> {
  const payload = isRecord(command.payload) ? command.payload : {};
  const sourceDirectiveId = deps.resolveCommandSourceDirectiveId({
    command,
    payload,
  });
  const requestedLimit = asPositiveInt(payload.limit);
  const limit = Math.max(1, Math.min(100, requestedLimit ?? 20));
  const retryPermissionDenied =
    payload.force === true ||
    payload.forceNow === true ||
    payload.retryPermissionDenied === true ||
    payload.retryBlocked === true;
  if (!deps.ctx.promotePendingDirectives) {
    return deps.failedOutcome(
      command,
      "Retry pending is unavailable: pending promotion handler is not wired.",
      "pending_retry_handler_missing",
    );
  }

  let summary: RetryPendingSummary;
  try {
    summary = await deps.ctx.promotePendingDirectives({
      limit,
      retryPermissionDenied,
      bypassCooldown: true,
      source: "brain_retry_pending",
    });
  } catch (error: unknown) {
    return deps.failedOutcome(
      command,
      error instanceof Error ? error.message : "retry pending failed",
      "pending_retry_failed",
    );
  }

  const summaryParts = [
    `scanned ${summary.scanned}`,
    `queued ${summary.promoted}`,
    `seen-skip ${summary.skippedAlreadySeen}`,
    `queued-skip ${summary.skippedQueued}`,
    `terminal-skip ${summary.skippedTerminal}`,
    `permission-skip ${summary.skippedPermissionDenied}`,
  ];
  const completionBody =
    summary.promoted > 0
      ? `Queued ${summary.promoted} pending directive${summary.promoted === 1 ? "" : "s"} (${summaryParts.join(", ")}).`
      : `No pending directives were queued (${summaryParts.join(", ")}).`;

  await deps.ctx.memory
    .recordWrite({
      type: "retry_pending_command_completed",
      at: nowIso(),
      commandId: command.id,
      sourceDirectiveId,
      retryPermissionDenied,
      ...summary,
    })
    .catch(() => undefined);

  return deps.successOutcome(command, {
    retryPending: summary,
    chatCompletion: {
      body: completionBody,
      metadata: {
        automated: true,
        sourceContext: "CHAT",
        actionPreview: {
          type: "retry_pending",
          status: summary.promoted > 0 ? "success" : "noop",
          title: "Pending queue retry",
          summary: completionBody,
        },
      },
    },
  });
}
