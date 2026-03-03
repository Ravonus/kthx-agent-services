/** Command outcome construction, persistence, and directive ack helpers. */

import type {
  Command,
  CommandExecutorContext,
  CommandOutcome,
  CommandLifecycleCheckpointStage,
} from "../types.js";
import { asNonEmptyString, buildExecutionDigest } from "../helpers.js";
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";
import { appendJsonLine } from "../../lib/fs.js";
import { resolveCommandSourceDirectiveId } from "../directives/resolution.js";
import { resolveDirectiveAckMutator } from "../router/agent-router.js";
import type { TrpcLike } from "../types.js";

// ---------------------------------------------------------------------------
// successOutcome / failedOutcome
// ---------------------------------------------------------------------------

export function successOutcome(command: Command, data: unknown): CommandOutcome {
  return {
    at: nowIso(),
    commandId: command.id,
    kind: command.kind,
    grantId: command.grantId,
    ok: true,
    data,
  };
}

export function failedOutcome(
  command: Command,
  message: string,
  code?: string,
): CommandOutcome {
  return {
    at: nowIso(),
    commandId: command.id,
    kind: command.kind,
    grantId: command.grantId,
    ok: false,
    error: {
      message,
      ...(code ? { code } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// writeOutcome
// ---------------------------------------------------------------------------

export async function writeOutcome(
  resultsPath: string,
  outcome: CommandOutcome,
): Promise<void> {
  await appendJsonLine(resultsPath, outcome).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// ackDirectiveForOutcome
// ---------------------------------------------------------------------------

export async function ackDirectiveForOutcome(input: {
  command: Command;
  outcome: CommandOutcome;
  trpc: TrpcLike | null;
  recordCheckpoint: (checkpointInput: {
    command: Command;
    stage: CommandLifecycleCheckpointStage;
    status?: "ok" | "failed";
    message?: string | null;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
}): Promise<void> {
  const directiveId =
    resolveCommandSourceDirectiveId({
      command: input.command,
      payload: isRecord(input.command.payload) ? input.command.payload : null,
    }) ??
    asNonEmptyString(input.command.pendingDirectiveId);
  if (!directiveId?.trim().length) return;
  const executionDigest = buildExecutionDigest(
    input.command,
    input.outcome.ok,
    input.outcome.ok ? null : input.outcome.error?.message ?? "failed",
  );
  try {
    await resolveDirectiveAckMutator(input.trpc).mutate({
      directiveId,
      status: input.outcome.ok ? "executed" : "failed",
      kind: input.command.kind,
      ...(input.outcome.ok
        ? {}
        : { error: input.outcome.error?.message ?? "Directive failed." }),
      ...(input.command.actionNonce
        ? { actionNonce: input.command.actionNonce }
        : {}),
      executionDigest,
    });
    await input.recordCheckpoint({
      command: input.command,
      stage: "ack_terminal",
      status: "ok",
      metadata: {
        directiveId,
        outcomeOk: input.outcome.ok,
      },
    });
  } catch (error: unknown) {
    await input.recordCheckpoint({
      command: input.command,
      stage: "ack_terminal",
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
      metadata: {
        directiveId,
        outcomeOk: input.outcome.ok,
      },
    });
    throw error;
  }
}
