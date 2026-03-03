/** Command seal verification, resealing, and trusted-replay helpers. */

import type { Command, CommandSealState } from "../types.js";
import type { SealVerifyError } from "../../directives/command-seal.js";
import { sealRuntimeStagedCommand } from "../../directives/command-seal.js";
import { asNonEmptyString } from "../helpers.js";
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";
import { writeJsonFile } from "../../lib/fs.js";
import { resolveCommandSourceDirectiveId } from "../directives/resolution.js";

// ---------------------------------------------------------------------------
// releaseReplayConsumedForRetry
// ---------------------------------------------------------------------------

export function releaseReplayConsumedForRetry(
  commandSeal: CommandSealState,
  commandId: string,
): void {
  const normalizedCommandId = commandId.trim();
  if (!normalizedCommandId.length) return;
  commandSeal.runtimeConsumedCommandIds.delete(normalizedCommandId);
}

// ---------------------------------------------------------------------------
// tryResealTrustedCommandForActiveSession
// ---------------------------------------------------------------------------

export async function tryResealTrustedCommandForActiveSession(input: {
  command: Command;
  sealError: SealVerifyError;
  commandSigVerified: boolean;
  filePath: string;
  inboxFile: string;
  commandSeal: CommandSealState;
  recordWrite: (payload: unknown) => Promise<void>;
}): Promise<Command | null> {
  const recoverableSealErrors = new Set<SealVerifyError>([
    "missing_runtime_session",
    "runtime_session_mismatch",
    "missing_runtime_origin",
    "missing_runtime_sig",
    "invalid_runtime_sig",
  ]);
  if (!recoverableSealErrors.has(input.sealError)) return null;

  const commandId = asNonEmptyString(input.command.id);
  if (!commandId) return null;
  const sourceDirectiveId = resolveCommandSourceDirectiveId({
    command: input.command,
    payload: isRecord(input.command.payload) ? input.command.payload : null,
  });
  const pendingDirectiveId = asNonEmptyString(input.command.pendingDirectiveId);
  const runtimeOrigin =
    asNonEmptyString(input.command.runtimeOrigin)?.toLowerCase() ?? "";
  const trustedDirectiveOrigin =
    runtimeOrigin === "director_directive" ||
    runtimeOrigin === "pending_promotion";
  const directiveLinked =
    sourceDirectiveId === commandId || pendingDirectiveId === commandId;

  if (!input.commandSigVerified && !(trustedDirectiveOrigin && directiveLinked)) {
    return null;
  }

  const resealed = sealRuntimeStagedCommand(
    input.commandSeal,
    {
      ...input.command,
    },
    runtimeOrigin || "runtime_resealed",
  );
  await writeJsonFile(input.filePath, resealed).catch(() => undefined);
  await input
    .recordWrite({
      type: "inbox_command_resealed",
      at: nowIso(),
      inboxFile: input.inboxFile,
      commandId,
      kind: input.command.kind,
      reason: input.sealError,
      trustSource: input.commandSigVerified ? "command_sig" : "directive_origin",
      priorRuntimeSessionId: input.command.runtimeSessionId ?? null,
      priorRuntimeOrigin: input.command.runtimeOrigin ?? null,
      resealedRuntimeSessionId: resealed.runtimeSessionId,
      resealedRuntimeOrigin: resealed.runtimeOrigin,
    })
    .catch(() => undefined);
  return resealed;
}

// ---------------------------------------------------------------------------
// tryRehydrateRuntimeIssuedSeal
// ---------------------------------------------------------------------------

export function tryRehydrateRuntimeIssuedSeal(
  commandSeal: CommandSealState,
  command: Command,
): boolean {
  const commandId = command.id.trim();
  if (!commandId.length) return false;
  if (commandSeal.runtimeIssuedCommandIds.has(commandId)) {
    return false;
  }
  const runtimeSessionId = asNonEmptyString(command.runtimeSessionId);
  const runtimeOrigin = asNonEmptyString(command.runtimeOrigin);
  const runtimeSig = asNonEmptyString(command.runtimeSig);
  if (!runtimeSessionId || !runtimeOrigin || !runtimeSig) {
    return false;
  }
  if (runtimeSessionId !== commandSeal.runtimeCommandSessionId) {
    return false;
  }
  commandSeal.runtimeIssuedCommandIds.add(commandId);
  return true;
}

// ---------------------------------------------------------------------------
// tryAllowTrustedReplay
// ---------------------------------------------------------------------------

export function tryAllowTrustedReplay(
  commandSeal: CommandSealState,
  command: Command,
): boolean {
  const commandId = command.id.trim();
  if (!commandId.length) return false;
  const runtimeSessionId = asNonEmptyString(command.runtimeSessionId);
  if (!runtimeSessionId) return false;
  if (runtimeSessionId !== commandSeal.runtimeCommandSessionId) {
    return false;
  }
  const runtimeOrigin =
    asNonEmptyString(command.runtimeOrigin)?.toLowerCase() ?? "";
  const trustedOrigin =
    runtimeOrigin === "director_directive" ||
    runtimeOrigin === "pending_promotion" ||
    runtimeOrigin === "runtime_resealed";
  if (!trustedOrigin) return false;
  const sourceDirectiveId = resolveCommandSourceDirectiveId({
    command,
    payload: isRecord(command.payload) ? command.payload : null,
  });
  const pendingDirectiveId = asNonEmptyString(command.pendingDirectiveId);
  const directiveLinked =
    sourceDirectiveId === commandId || pendingDirectiveId === commandId;
  if (!directiveLinked) return false;
  commandSeal.runtimeConsumedCommandIds.delete(commandId);
  return true;
}
