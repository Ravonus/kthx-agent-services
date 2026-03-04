import type {
  Command,
  OwnerCapabilityCooldown,
  StateSqliteStore,
} from "../types.js";

import { asNonEmptyString } from "../helpers.js";
import { nowIso } from "../../lib/text.js";

import {
  resolveCommandSourceDirectiveId,
  isDirectiveContextLinkedCommand,
} from "../directives/resolution.js";

import {
  hasUsablePermissionWindowForAction,
  resolveOwnerCapabilityCooldown,
  resolvePermissionWindowGrantIdForAction,
  updateActionLifecycle,
} from "./grants.js";

export async function preflightGrantForAction(
  stateDb: StateSqliteStore | null | undefined,
  ownerCapabilityDeniedByTarget: Map<string, OwnerCapabilityCooldown>,
  memory: { recordWrite(payload: unknown): Promise<void> },
  input: {
    command: Command;
    payload: Record<string, unknown>;
    action: "comment" | "like" | "repost";
    lifecycle: {
      idempotencyKey: string;
      target: {
        postId: number;
        commentId: number | null;
        targetHash: string;
      };
    };
  },
): Promise<string | null> {
  const directiveId =
    resolveCommandSourceDirectiveId({
      command: input.command,
      payload: input.payload,
    }) ?? input.command.id;
  const ownerCooldown = resolveOwnerCapabilityCooldown(
    ownerCapabilityDeniedByTarget,
    {
      action: input.action,
      targetHash: input.lifecycle.target.targetHash,
    },
  );
  if (ownerCooldown) {
    const retryInMs = Math.max(0, ownerCooldown.untilMs - Date.now());
    const message = `Owner capability denied: ${ownerCooldown.reason}. retry_in_ms=${retryInMs}`;
    updateActionLifecycle(stateDb, {
      command: input.command,
      action: input.action,
      idempotencyKey: input.lifecycle.idempotencyKey,
      target: input.lifecycle.target,
      state: "failed",
      lastError: message,
    });
    throw new Error(message);
  }

  const grantId =
    asNonEmptyString(input.command.grantId) ??
    asNonEmptyString(input.payload.grantId);
  if (grantId) return grantId;

  const inferredGrantId = resolvePermissionWindowGrantIdForAction(
    input.payload.permissionState,
    input.action,
  );
  if (inferredGrantId) {
    await memory
      .recordWrite({
        type: "directive_preflight_grant_inferred",
        at: nowIso(),
        commandId: input.command.id,
        directiveId,
        action: input.action,
        grantId: inferredGrantId,
      })
      .catch(() => undefined);
    return inferredGrantId;
  }

  if (isDirectiveContextLinkedCommand(input.command)) {
    await memory
      .recordWrite({
        type: "directive_preflight_grant_bypassed",
        at: nowIso(),
        commandId: input.command.id,
        directiveId,
        action: input.action,
        reason: "directive_context",
      })
      .catch(() => undefined);
    return null;
  }

  const hasUsableWindow = hasUsablePermissionWindowForAction(
    input.payload.permissionState,
    input.action,
  );
  const reason = hasUsableWindow
    ? "missing_grant_id_with_active_window"
    : "no_grant";
  const errorMessage = `Owner capability denied: ${reason}.`;
  updateActionLifecycle(stateDb, {
    command: input.command,
    action: input.action,
    idempotencyKey: input.lifecycle.idempotencyKey,
    target: input.lifecycle.target,
    state: "failed",
    lastError: errorMessage,
  });
  await memory
    .recordWrite({
      type: "directive_preflight_grant_failed",
      at: nowIso(),
      commandId: input.command.id,
      directiveId,
      action: input.action,
      reason,
      hasUsableWindow,
    })
    .catch(() => undefined);
  throw new Error(errorMessage);
}
