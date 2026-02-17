/**
 * Command seal: HMAC-based signing and verification for runtime-staged
 * commands, ensuring only this runtime session can issue and consume them.
 *
 * Ported from agent-runtime.mjs lines 4135-4221.
 */

import type { Command } from "../types/ipc.js";
import { hmacSha256Hex, stableStringify } from "../lib/crypto.js";
import { isRecord } from "../lib/guards.js";

// ---------------------------------------------------------------------------
// Narrow context interface
// ---------------------------------------------------------------------------

/**
 * Minimal state the seal functions need. Avoids importing RuntimeContext
 * directly so the module stays free of circular dependencies.
 */
export interface CommandSealState {
  runtimeCommandSessionId: string;
  runtimeCommandSealKey: string;
  runtimeIssuedCommandIds: Set<string>;
  runtimeConsumedCommandIds: Set<string>;
}

// ---------------------------------------------------------------------------
// Sealed command type
// ---------------------------------------------------------------------------

export type SealedCommand = Command & {
  runtimeSessionId: string;
  runtimeOrigin: string;
  runtimeSig: string;
};

// ---------------------------------------------------------------------------
// Verification error codes
// ---------------------------------------------------------------------------

export type SealVerifyError =
  | "invalid_command"
  | "missing_command_id"
  | "command_not_issued_by_runtime"
  | "command_replay_detected"
  | "missing_runtime_session"
  | "runtime_session_mismatch"
  | "missing_runtime_origin"
  | "missing_runtime_sig"
  | "invalid_runtime_sig";

// ---------------------------------------------------------------------------
// Internal: build the HMAC message from a command-like record
// ---------------------------------------------------------------------------

const buildSealMessage = (
  command: Record<string, unknown>,
  runtimeSessionId: string,
  runtimeOrigin: string,
): string =>
  stableStringify({
    id: command.id,
    createdAt: command.createdAt,
    kind: command.kind,
    grantId: command.grantId ?? null,
    payload: command.payload ?? null,
    sourceDirectiveId: command.sourceDirectiveId ?? null,
    pendingDirectiveId: command.pendingDirectiveId ?? null,
    actionNonce: command.actionNonce ?? null,
    forceNow: command.forceNow === true,
    runtimeSessionId,
    runtimeOrigin,
  });

// ---------------------------------------------------------------------------
// sealRuntimeStagedCommand
// ---------------------------------------------------------------------------

/**
 * Seal a staged command with an HMAC-SHA-256 signature bound to the
 * current runtime session. Returns the sealed command with
 * `runtimeSessionId`, `runtimeOrigin`, and `runtimeSig` fields.
 */
export const sealRuntimeStagedCommand = (
  state: CommandSealState,
  command: Command,
  runtimeOrigin?: string,
): SealedCommand => {
  const normalizedOrigin =
    typeof runtimeOrigin === "string" && runtimeOrigin.trim().length > 0
      ? runtimeOrigin.trim()
      : "runtime";

  const runtimeSessionId = state.runtimeCommandSessionId;
  const runtimeSig = hmacSha256Hex(
    state.runtimeCommandSealKey,
    buildSealMessage(command, runtimeSessionId, normalizedOrigin),
  );

  const sealed: SealedCommand = {
    ...command,
    runtimeSessionId,
    runtimeOrigin: normalizedOrigin,
    runtimeSig,
  };

  if (typeof sealed.id === "string" && sealed.id.trim().length > 0) {
    state.runtimeIssuedCommandIds.add(sealed.id.trim());
  }

  return sealed;
};

// ---------------------------------------------------------------------------
// verifyRuntimeCommandSeal
// ---------------------------------------------------------------------------

/**
 * Verify a previously sealed command. Returns `null` when the seal is
 * valid, or a descriptive error code string when verification fails.
 *
 * On success the command id is added to `runtimeConsumedCommandIds` so
 * any subsequent verification of the same id will fail with
 * `"command_replay_detected"`.
 */
export const verifyRuntimeCommandSeal = (
  state: CommandSealState,
  command: unknown,
): SealVerifyError | null => {
  if (!isRecord(command)) return "invalid_command";

  const commandId =
    typeof command.id === "string" && command.id.trim().length > 0
      ? command.id.trim()
      : "";
  if (!commandId.length) return "missing_command_id";

  if (!state.runtimeIssuedCommandIds.has(commandId)) {
    return "command_not_issued_by_runtime";
  }
  if (state.runtimeConsumedCommandIds.has(commandId)) {
    return "command_replay_detected";
  }

  if (
    typeof command.runtimeSessionId !== "string" ||
    command.runtimeSessionId.trim().length === 0
  ) {
    return "missing_runtime_session";
  }
  if (command.runtimeSessionId !== state.runtimeCommandSessionId) {
    return "runtime_session_mismatch";
  }

  if (
    typeof command.runtimeOrigin !== "string" ||
    command.runtimeOrigin.trim().length === 0
  ) {
    return "missing_runtime_origin";
  }

  if (
    typeof command.runtimeSig !== "string" ||
    command.runtimeSig.trim().length === 0
  ) {
    return "missing_runtime_sig";
  }

  const expected = hmacSha256Hex(
    state.runtimeCommandSealKey,
    buildSealMessage(
      command,
      command.runtimeSessionId as string,
      command.runtimeOrigin as string,
    ),
  );

  if (expected !== command.runtimeSig) return "invalid_runtime_sig";

  // Mark consumed so replays are detected
  state.runtimeConsumedCommandIds.add(commandId);
  return null;
};
