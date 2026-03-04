import path from "node:path";

import { computeCommandSignature } from "../../lib/crypto.js";
import { readJsonMaybeIncomplete } from "../../lib/fs.js";
import { parseCommand } from "../../lib/parsing.js";
import { nowIso } from "../../lib/text.js";

import {
  verifyRuntimeCommandSeal,
  type CommandSealState,
} from "../../directives/command-seal.js";
import { asNonEmptyString } from "../helpers.js";
import { RequeueCommandError } from "../types.js";
import type {
  Command,
  CommandOutcome,
  CommandLifecycleCheckpointStage,
  ExecuteResult,
} from "../types.js";

type QueueAttemptsContext = { attempts?: number; maxAttempts?: number };

export type ProcessCommandFileRuntime = {
  ctx: {
    memory: {
      recordWrite(entry: unknown): Promise<void>;
    };
    controlKey?: string | null;
    commandSeal: CommandSealState;
  };
  markQueueItemCompletedByInbox: (
    inboxFile: string,
    status: "done" | "failed" | "missing",
    reason: string | null,
  ) => Promise<void>;
  markQueueItemNotReadyByInbox: (inboxFile: string, reason: string) => Promise<void>;
  writeOutcome: (outcome: CommandOutcome) => Promise<void>;
  moveInboxFileToProcessed: (
    filePath: string,
    suffix: "done" | "failed" | "invalid" | "rejected",
  ) => Promise<void>;
  recordCommandLifecycleCheckpoint: (input: {
    command: Command;
    stage: CommandLifecycleCheckpointStage;
    status?: "ok" | "failed";
    message?: string | null;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  finalizeCommandOutcome: (input: {
    command: Command;
    outcome: CommandOutcome;
  }) => Promise<void>;
  resolveRuntimeAgentId: () => Promise<string | null>;
  tryAllowTrustedReplay: (command: Command) => boolean;
  tryRehydrateRuntimeIssuedSeal: (command: Command) => boolean;
  tryResealTrustedCommandForActiveSession: (input: {
    command: Command;
    sealError: string;
    commandSigVerified: boolean;
    filePath: string;
    inboxFile: string;
  }) => Promise<Command | null>;
  emitChatProcessingIndicator: (command: Command) => Promise<void>;
  executeCommand: (command: Command) => Promise<ExecuteResult>;
  releaseReplayConsumedForRetry: (commandId: string) => void;
  primeCommandContextForRequeue: (
    command: Command,
    reason: string,
  ) => Promise<void>;
  updatePendingDirectiveStatusForOutcome: (
    command: Command,
    outcome: CommandOutcome | null,
  ) => Promise<void>;
};

export async function processCommandFilePath(
  this: ProcessCommandFileRuntime,
  filePath: string,
  queueContext?: QueueAttemptsContext,
): Promise<boolean> {
  const inboxFile = path.basename(filePath);
  const read = await readJsonMaybeIncomplete(filePath);
  if (read.status === "missing") {
    await this.markQueueItemCompletedByInbox(inboxFile, "missing", "file missing before execution");
    return true;
  }
  if (read.status === "not_ready") {
    await this.markQueueItemNotReadyByInbox(inboxFile, "inbox_json_not_ready").catch(
      () => undefined,
    );
    return false;
  }
  if (read.status === "invalid") {
    await this.writeOutcome({
      at: nowIso(),
      commandId: `invalid:${inboxFile}`,
      kind: "unknown",
      grantId: null,
      ok: false,
      error: { message: "invalid json command" },
    });
    await this.moveInboxFileToProcessed(filePath, "invalid");
    await this.markQueueItemCompletedByInbox(inboxFile, "failed", "invalid json command");
    return true;
  }

  let command = parseCommand(read.value);
  if (!command) {
    await this.writeOutcome({
      at: nowIso(),
      commandId: `parse_failed:${inboxFile}`,
      kind: "unknown",
      grantId: null,
      ok: false,
      error: { message: "command parse failed" },
    });
    await this.moveInboxFileToProcessed(filePath, "invalid");
    await this.markQueueItemCompletedByInbox(inboxFile, "failed", "command parse failed");
    return true;
  }
  await this.recordCommandLifecycleCheckpoint({
    command,
    stage: "received",
    status: "ok",
    metadata: {
      inboxFile,
    },
  });
  const runtimeOrigin =
    asNonEmptyString(command.runtimeOrigin)?.trim().toLowerCase() ?? "";
  const isDirectiveScopedCommand =
    runtimeOrigin === "director_directive" ||
    runtimeOrigin === "pending_promotion" ||
    runtimeOrigin === "runtime_resealed" ||
    asNonEmptyString(command.sourceDirectiveId) !== null ||
    asNonEmptyString(command.pendingDirectiveId) !== null;
  const targetAgentId = asNonEmptyString(command.targetAgentId);
  if (!targetAgentId && isDirectiveScopedCommand) {
    const missingReason = "directive_target_agent_missing";
    await this.ctx.memory
      .recordWrite({
        type: "inbox_command_target_agent_missing",
        at: nowIso(),
        inboxFile,
        commandId: command.id,
        kind: command.kind,
        runtimeOrigin: command.runtimeOrigin ?? null,
        sourceDirectiveId: command.sourceDirectiveId ?? null,
        pendingDirectiveId: command.pendingDirectiveId ?? null,
        reason: missingReason,
      })
      .catch(() => undefined);
    const outcome: CommandOutcome = {
      at: nowIso(),
      commandId: command.id,
      kind: command.kind,
      grantId: command.grantId,
      ok: false,
      error: {
        message: "Rejected command: directive target agent id is missing.",
        code: missingReason,
      },
    };
    await this.finalizeCommandOutcome({ command, outcome });
    await this.moveInboxFileToProcessed(filePath, "rejected");
    await this.markQueueItemCompletedByInbox(
      inboxFile,
      "failed",
      "directive target agent id missing",
    );
    return true;
  }
  if (targetAgentId) {
    const runtimeAgentId = await this.resolveRuntimeAgentId();
    if (!runtimeAgentId || runtimeAgentId.length === 0) {
      const unresolvedReason = `target_agent_identity_unknown:${targetAgentId}`;
      await this.ctx.memory
        .recordWrite({
          type: "inbox_command_target_agent_identity_unknown",
          at: nowIso(),
          inboxFile,
          commandId: command.id,
          kind: command.kind,
          targetAgentId,
          reason: unresolvedReason,
        })
        .catch(() => undefined);
      await this.markQueueItemNotReadyByInbox(inboxFile, unresolvedReason).catch(
        () => undefined,
      );
      return false;
    }
    if (runtimeAgentId !== targetAgentId) {
      const mismatchReason = `target_agent_mismatch:${targetAgentId}:${runtimeAgentId}`;
      await this.ctx.memory
        .recordWrite({
          type: "inbox_command_target_agent_mismatch",
          at: nowIso(),
          inboxFile,
          commandId: command.id,
          kind: command.kind,
          targetAgentId,
          runtimeAgentId,
          reason: mismatchReason,
        })
        .catch(() => undefined);
      await this.markQueueItemNotReadyByInbox(inboxFile, mismatchReason).catch(
        () => undefined,
      );
      return false;
    }
  }

  let commandSigVerified = false;
  if (this.ctx.controlKey) {
    const expected = computeCommandSignature(this.ctx.controlKey, command);
    if (!command.sig || command.sig !== expected) {
      const outcome: CommandOutcome = {
        at: nowIso(),
        commandId: command.id,
        kind: command.kind,
        grantId: command.grantId,
        ok: false,
        error: {
          message:
            "Rejected command: invalid command signature for this runtime session.",
          code: "invalid_command_sig",
        },
      };
      await this.finalizeCommandOutcome({ command, outcome });
      await this.moveInboxFileToProcessed(filePath, "rejected");
      await this.markQueueItemCompletedByInbox(inboxFile, "failed", "invalid command signature");
      return true;
    }
    commandSigVerified = true;
  }

  let sealError = verifyRuntimeCommandSeal(this.ctx.commandSeal, command);
  if (
    sealError === "command_replay_detected" &&
    this.tryAllowTrustedReplay(command)
  ) {
    sealError = verifyRuntimeCommandSeal(this.ctx.commandSeal, command);
  }
  if (
    sealError === "command_not_issued_by_runtime" &&
    this.tryRehydrateRuntimeIssuedSeal(command)
  ) {
    await this.ctx.memory
      .recordWrite({
        type: "inbox_command_seal_rehydrated",
        at: nowIso(),
        inboxFile,
        commandId: command.id,
        kind: command.kind,
        runtimeOrigin: command.runtimeOrigin ?? null,
      })
      .catch(() => undefined);
    sealError = verifyRuntimeCommandSeal(this.ctx.commandSeal, command);
  }
  if (sealError) {
    const resealedCommand = await this.tryResealTrustedCommandForActiveSession({
      command,
      sealError,
      commandSigVerified,
      filePath,
      inboxFile,
    });
    if (resealedCommand) {
      command = resealedCommand;
      sealError = verifyRuntimeCommandSeal(this.ctx.commandSeal, command);
    }
  }
  if (sealError) {
    const outcome: CommandOutcome = {
      at: nowIso(),
      commandId: command.id,
      kind: command.kind,
      grantId: command.grantId,
      ok: false,
      error: {
        message:
          "Rejected external or stale command file. Only runtime-sealed commands from this active tunnel session are executable.",
        code: sealError,
      },
    };
    await this.ctx.memory.recordWrite({
      type: "inbox_command_rejected",
      at: nowIso(),
      inboxFile,
      commandId: command.id,
      kind: command.kind,
      reason: sealError,
    }).catch(() => undefined);
    await this.finalizeCommandOutcome({ command, outcome });
    await this.moveInboxFileToProcessed(filePath, "rejected");
    await this.markQueueItemCompletedByInbox(
      inboxFile,
      "failed",
      `runtime command seal rejected (${sealError})`,
    );
    return true;
  }

  await this.recordCommandLifecycleCheckpoint({
    command,
    stage: "queued",
    status: "ok",
    metadata: {
      inboxFile,
    },
  });
  await this.recordCommandLifecycleCheckpoint({
    command,
    stage: "executing",
    status: "ok",
  });
  await this.emitChatProcessingIndicator(command).catch(() => undefined);

  const result = await this.executeCommand(command).catch(async (error: unknown) => {
    if (error instanceof RequeueCommandError) {
      this.releaseReplayConsumedForRetry(command.id);
      const requeueReason =
        typeof error.message === "string" && error.message.trim().length > 0
          ? error.message.trim()
          : "not_ready";
      await this.markQueueItemNotReadyByInbox(inboxFile, requeueReason).catch(() => undefined);
      await this.primeCommandContextForRequeue(command, requeueReason).catch(() => undefined);
      void this.ctx.memory
        .recordWrite({
          type: "inbox_command_requeued",
          at: nowIso(),
          inboxFile,
          commandId: command.id,
          kind: command.kind,
          reason: requeueReason,
          replayConsumedReleased: true,
        })
        .catch(() => undefined);
      return {
        processed: false,
        outcome: null,
      } satisfies ExecuteResult;
    }
    const message = error instanceof Error ? error.message : String(error);
    const outcome: CommandOutcome = {
      at: nowIso(),
      commandId: command.id,
      kind: command.kind,
      grantId: command.grantId,
      ok: false,
      error: { message },
    };
    return {
      processed: true,
      outcome,
    } satisfies ExecuteResult;
  });

  if (!result.processed) {
    const attempts = queueContext?.attempts ?? 0;
    const maxAttempts = queueContext?.maxAttempts ?? 0;
    if (maxAttempts > 0 && attempts >= maxAttempts - 1) {
      const terminalOutcome: CommandOutcome = {
        at: nowIso(),
        commandId: command.id,
        kind: command.kind,
        grantId: command.grantId,
        ok: false,
        error: {
          message: `Command failed after ${attempts} attempts (max retry exceeded).`,
          code: "max_retry_exceeded",
        },
      };
      await this.finalizeCommandOutcome({ command, outcome: terminalOutcome });
      await this.updatePendingDirectiveStatusForOutcome(command, terminalOutcome).catch(
        () => undefined,
      );
      await this.moveInboxFileToProcessed(filePath, "failed");
      await this.markQueueItemCompletedByInbox(
        inboxFile,
        "failed",
        `max_retry_exceeded (${attempts} attempts)`,
      );
      return true;
    }
    return false;
  }
  const outcome = result.outcome;
  if (!outcome) {
    await this.updatePendingDirectiveStatusForOutcome(command, null).catch(
      () => undefined,
    );
    await this.moveInboxFileToProcessed(filePath, "done");
    await this.markQueueItemCompletedByInbox(inboxFile, "done", null);
    return true;
  }

  if (command.kind.trim().toLowerCase().startsWith("write.")) {
    await this.recordCommandLifecycleCheckpoint({
      command,
      stage: "write_mutation",
      status: outcome.ok ? "ok" : "failed",
      message: outcome.ok ? null : outcome.error?.message ?? null,
    });
  }

  await this.finalizeCommandOutcome({ command, outcome });
  await this.updatePendingDirectiveStatusForOutcome(command, outcome).catch(
    () => undefined,
  );

  if (outcome.ok) {
    await this.moveInboxFileToProcessed(filePath, "done");
    await this.markQueueItemCompletedByInbox(inboxFile, "done", null);
  } else {
    await this.moveInboxFileToProcessed(filePath, "failed");
    await this.markQueueItemCompletedByInbox(
      inboxFile,
      "failed",
      outcome.error?.message ?? "command failed",
    );
  }
  return true;
}
