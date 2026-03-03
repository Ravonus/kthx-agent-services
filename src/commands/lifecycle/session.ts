/** Runtime agent ID resolution and command lifecycle checkpoint recording. */

import type {
  Command,
  CommandExecutorContext,
  CommandLifecycleCheckpointStage,
} from "../types.js";
import { asNonEmptyString, truncateText } from "../helpers.js";
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";
import {
  resolveCommandRequestOrigin,
  resolveCommandSourceDirectiveId,
} from "../directives/resolution.js";

// ---------------------------------------------------------------------------
// resolveRuntimeAgentId
// ---------------------------------------------------------------------------

export async function resolveRuntimeAgentId(
  ctx: CommandExecutorContext,
  state: { agentIdCache: string | null; checkedAtMs: number },
): Promise<string | null> {
  const nowMs = Date.now();
  if (nowMs - state.checkedAtMs < 60_000) {
    return state.agentIdCache;
  }
  state.checkedAtMs = nowMs;
  const queryFn = ctx.trpc?.realtime?.authState?.query;
  if (typeof queryFn !== "function") {
    return state.agentIdCache;
  }
  try {
    const authState = await queryFn();
    const userId =
      isRecord(authState) && typeof authState.userId === "string"
        ? authState.userId.trim()
        : "";
    state.agentIdCache = userId.length > 0 ? userId : null;
  } catch {
    // best-effort cache refresh
  }
  return state.agentIdCache;
}

// ---------------------------------------------------------------------------
// recordCommandLifecycleCheckpoint
// ---------------------------------------------------------------------------

export async function recordCommandLifecycleCheckpoint(
  ctx: CommandExecutorContext,
  runtimeAgentIdState: { agentIdCache: string | null; checkedAtMs: number },
  input: {
    command: Command;
    stage: CommandLifecycleCheckpointStage;
    status?: "ok" | "failed";
    message?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const payload = isRecord(input.command.payload) ? input.command.payload : null;
  const chatContext = isRecord(payload?.chatContext) ? payload.chatContext : null;
  const sourceDirectiveId = resolveCommandSourceDirectiveId({
    command: input.command,
    payload,
  });
  const runtimeAgentId = await resolveRuntimeAgentId(ctx, runtimeAgentIdState).catch(
    () => null,
  );
  const agentId =
    asNonEmptyString(input.command.targetAgentId) ?? runtimeAgentId ?? null;
  const directiveId =
    sourceDirectiveId ?? asNonEmptyString(input.command.pendingDirectiveId) ?? null;
  const conversationId =
    asNonEmptyString(chatContext?.conversationId) ??
    asNonEmptyString(payload?.conversationId) ??
    null;
  const channelId =
    asNonEmptyString(chatContext?.channelId) ??
    asNonEmptyString(payload?.channelId) ??
    null;
  const clientMessageId =
    asNonEmptyString(chatContext?.clientMessageId) ??
    asNonEmptyString(chatContext?.processingClientMessageId) ??
    asNonEmptyString(payload?.clientMessageId) ??
    null;
  const messageId =
    asNonEmptyString(chatContext?.messageId) ??
    asNonEmptyString(payload?.messageId) ??
    null;
  await ctx.memory
    .recordWrite({
      type: "command_execution_checkpoint",
      at: nowIso(),
      agentId,
      directiveId,
      commandId: input.command.id,
      commandKind: input.command.kind,
      sourceDirectiveId,
      pendingDirectiveId: input.command.pendingDirectiveId ?? null,
      actionNonce: input.command.actionNonce ?? null,
      requestOrigin: resolveCommandRequestOrigin(input.command, payload),
      chatContext: {
        conversationId,
        channelId,
      },
      clientMessageId,
      messageId,
      stage: input.stage,
      status: input.status ?? "ok",
      ...(input.message && input.message.trim().length > 0
        ? { message: truncateText(input.message, 320) }
        : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    })
    .catch(() => undefined);
}
