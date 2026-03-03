/** Chat message delivery — draft preview, failure messages, processing indicators, and outcome routing. */

import crypto from "node:crypto";

import type { Command } from "../../types/ipc.js";
import type { CommandOutcome, DraftPreviewPayload, CommandLifecycleCheckpointStage } from "../types.js";

import { asNonEmptyString } from "../helpers.js";

import {
  clampPublishText,
  resolveChatTargetFromPayload,
  sendChatResultMessageFromOutcome,
} from "../../chat/chat-context.js";

import {
  resolveChatProcessingClientMessageId,
  buildChatProcessingIndicator,
  buildDeterministicChatClientMessageId,
  buildNonWriteChatCompletion,
} from "./chat-completion.js";

import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

type ChatBridgeFn = (input: unknown) => Promise<unknown>;
type MemoryWriter = { recordWrite(entry: unknown): Promise<void> };
type RecordCheckpointFn = (input: {
  command: Command;
  stage: CommandLifecycleCheckpointStage;
  status?: "ok" | "failed";
  message?: string | null;
  metadata?: Record<string, unknown>;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// sendDraftPreviewMessage
// ---------------------------------------------------------------------------

export async function sendDraftPreviewMessage(
  callAgentChatBridge: ChatBridgeFn | null,
  input: {
    payload: Record<string, unknown>;
    preview: DraftPreviewPayload;
  },
): Promise<boolean> {
  if (!callAgentChatBridge) return false;
  const chatTarget = resolveChatTargetFromPayload(input.payload);
  if (!chatTarget) return false;
  try {
    await callAgentChatBridge({
      action: "send_message",
      clientMessageId: `runtime_draft_result_${Date.now().toString(36)}_${crypto
        .randomUUID()
        .replaceAll("-", "")
        .slice(0, 10)}`,
      ...(chatTarget.conversationId
        ? { conversationId: chatTarget.conversationId }
        : { channelId: chatTarget.channelId }),
      body: input.preview.body,
      format: "markdown",
      metadata: {
        automated: true,
        sourceContext: "CHAT",
        draftPreviewText: input.preview.draftPreviewText,
        draftPostKind: input.preview.draftPostKind,
        draftMode: input.preview.draftMode,
        draftSlideCount: input.preview.draftSlideCount,
        actionPreview: {
          type: "draft",
          status: "success",
          title: "Draft ready",
          summary: input.preview.summary,
        },
      },
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// sendDraftFailureMessage
// ---------------------------------------------------------------------------

export async function sendDraftFailureMessage(
  callAgentChatBridge: ChatBridgeFn | null,
  input: {
    payload: Record<string, unknown>;
    message: string;
  },
): Promise<boolean> {
  if (!callAgentChatBridge) return false;
  const chatTarget = resolveChatTargetFromPayload(input.payload);
  if (!chatTarget) return false;
  try {
    await callAgentChatBridge({
      action: "send_message",
      clientMessageId: `runtime_draft_error_${Date.now().toString(36)}_${crypto
        .randomUUID()
        .replaceAll("-", "")
        .slice(0, 10)}`,
      ...(chatTarget.conversationId
        ? { conversationId: chatTarget.conversationId }
        : { channelId: chatTarget.channelId }),
      body: input.message,
      format: "markdown",
      metadata: {
        automated: true,
        sourceContext: "CHAT",
        actionPreview: {
          type: "draft",
          status: "failed",
          title: "Draft failed",
          error: input.message,
        },
      },
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// emitChatProcessingIndicator
// ---------------------------------------------------------------------------

export async function emitChatProcessingIndicator(
  deps: { callAgentChatBridge: ChatBridgeFn | null; memory: MemoryWriter },
  command: Command,
): Promise<boolean> {
  const callAgentChatBridge = deps.callAgentChatBridge;
  if (!callAgentChatBridge) return false;
  const chatTarget = resolveChatTargetFromPayload(command.payload);
  if (!chatTarget) return false;
  const processingClientMessageId = resolveChatProcessingClientMessageId(command);
  if (!processingClientMessageId) return false;
  const processingIndicator = buildChatProcessingIndicator(command);
  if (!processingIndicator) return false;
  const route = chatTarget.conversationId
    ? { conversationId: chatTarget.conversationId }
    : { channelId: chatTarget.channelId };
  try {
    await callAgentChatBridge({
      action: "send_message",
      clientMessageId: processingClientMessageId,
      ...route,
      body: clampPublishText(processingIndicator.body, 1200),
      format: "markdown",
      metadata: processingIndicator.metadata,
    });
    await deps.memory
      .recordWrite({
        type: "chat_command_processing_sent",
        at: nowIso(),
        commandId: command.id,
        kind: command.kind,
        targetConversationId: chatTarget.conversationId ?? null,
        targetChannelId: chatTarget.channelId ?? null,
      })
      .catch(() => undefined);
    return true;
  } catch (error: unknown) {
    await deps.memory
      .recordWrite({
        type: "chat_command_processing_send_failed",
        at: nowIso(),
        commandId: command.id,
        kind: command.kind,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    return false;
  }
}

// ---------------------------------------------------------------------------
// sendNonWriteChatCompletion
// ---------------------------------------------------------------------------

export async function sendNonWriteChatCompletion(
  deps: { callAgentChatBridge: ChatBridgeFn | null; memory: MemoryWriter },
  input: {
    command: Command;
    body: string;
    metadata: Record<string, unknown>;
  },
): Promise<boolean> {
  if (!deps.callAgentChatBridge) return false;
  const chatTarget = resolveChatTargetFromPayload(input.command.payload);
  if (!chatTarget) return false;
  const route = chatTarget.conversationId
    ? { conversationId: chatTarget.conversationId }
    : { channelId: chatTarget.channelId };
  const processingClientMessageId = resolveChatProcessingClientMessageId(input.command);
  if (processingClientMessageId) {
    try {
      await deps.callAgentChatBridge({
        action: "edit_message",
        clientMessageId: processingClientMessageId,
        ...route,
        body: clampPublishText(input.body, 1200),
        metadata: input.metadata,
      });
      await deps.memory
        .recordWrite({
          type: "chat_command_result_edited",
          at: nowIso(),
          commandId: input.command.id,
          kind: input.command.kind,
          ok: true,
          targetConversationId: chatTarget.conversationId ?? null,
          targetChannelId: chatTarget.channelId ?? null,
        })
        .catch(() => undefined);
      return true;
    } catch {
      // Fallback to sending a dedicated terminal message when progress message edit is unavailable.
    }
  }
  const clientMessageId = buildDeterministicChatClientMessageId({
    prefix: "runtime_chat_result",
    stableKey: input.command.id,
  });
  try {
    await deps.callAgentChatBridge({
      action: "send_message",
      clientMessageId,
      ...route,
      body: clampPublishText(input.body, 1200),
      format: "markdown",
      metadata: input.metadata,
    });
    await deps.memory
      .recordWrite({
        type: "chat_command_result_sent",
        at: nowIso(),
        commandId: input.command.id,
        kind: input.command.kind,
        ok: true,
        targetConversationId: chatTarget.conversationId ?? null,
        targetChannelId: chatTarget.channelId ?? null,
      })
      .catch(() => undefined);
    return true;
  } catch (error: unknown) {
    await deps.memory
      .recordWrite({
        type: "chat_command_result_send_failed",
        at: nowIso(),
        commandId: input.command.id,
        kind: input.command.kind,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    return false;
  }
}

// ---------------------------------------------------------------------------
// emitChatOutcome
// ---------------------------------------------------------------------------

export async function emitChatOutcome(
  deps: {
    callAgentChatBridge: ChatBridgeFn | null;
    memory: MemoryWriter;
    recordCheckpoint: RecordCheckpointFn;
  },
  command: Command,
  outcome: CommandOutcome,
): Promise<boolean> {
  const payload = isRecord(command.payload) ? command.payload : null;
  const chatTarget = resolveChatTargetFromPayload(payload ?? null);
  if (!chatTarget) {
    const sourceContext = asNonEmptyString(payload?.sourceContext)?.toLowerCase() ?? "";
    if (sourceContext === "chat" || isRecord(payload?.chatContext)) {
      await deps.recordCheckpoint({
        command,
        stage: "chat_delivery",
        status: "failed",
        message: "chat_target_missing",
        metadata: {
          mode: "terminal_delivery",
        },
      });
    }
    return false;
  }
  const route = chatTarget.conversationId
    ? { conversationId: chatTarget.conversationId }
    : { channelId: chatTarget.channelId };
  const outcomeData = isRecord(outcome.data) ? outcome.data : null;
  const chatDeliveryHandled = outcomeData?.chatDeliveryHandled === true;
  const outcomeMode = asNonEmptyString(outcomeData?.mode)?.toLowerCase() ?? "";
  const outcomeErrorMessage = asNonEmptyString(outcome.error?.message) ?? "";
  const literalGenerateDeliveryOwned =
    payload?.chatLiteralGenerate === true ||
    payload?.chatLiteralGenerate === "true" ||
    outcomeMode === "chat_literal_generate" ||
    /literal generate delivery failed:/iu.test(outcomeErrorMessage);

  if (literalGenerateDeliveryOwned) {
    if (outcomeData?.chatDeliveryCheckpointRecorded === true) {
      return chatDeliveryHandled;
    }
    let delivered = chatDeliveryHandled;
    let fallbackUsed = false;
    if (!delivered) {
      const chatContext = isRecord(payload?.chatContext) ? payload.chatContext : null;
      const previewClientMessageId =
        asNonEmptyString(chatContext?.processingClientMessageId) ??
        asNonEmptyString(chatContext?.previewClientMessageId) ??
        `runtime_generate_${command.id}`;
      const completion = buildNonWriteChatCompletion({ command, outcome });
      if (completion && deps.callAgentChatBridge) {
        try {
          await deps.callAgentChatBridge({
            action: "edit_message",
            clientMessageId: previewClientMessageId,
            ...route,
            body: clampPublishText(completion.body, 1200),
            metadata: completion.metadata,
          });
          delivered = true;
        } catch {
          // Preview card edit failed; fall through to fresh message fallback.
        }
      }
      if (!delivered && completion) {
        fallbackUsed = true;
        delivered = await sendNonWriteChatCompletion(deps, {
          command,
          body: completion.body,
          metadata: completion.metadata,
        });
      }
    }
    await deps.recordCheckpoint({
      command,
      stage: "chat_delivery",
      status: delivered ? "ok" : "failed",
      message: delivered ? null : "chat_preview_delivery_failed",
      metadata: {
        mode: "chat_literal_generate_preview",
        outcomeOk: outcome.ok,
        usedFallback: fallbackUsed,
      },
    });
    return delivered;
  }

  if (payload?.requireDraftOnly === true && chatDeliveryHandled) {
    if (outcomeData?.chatDeliveryCheckpointRecorded === true) {
      return true;
    }
    await deps.recordCheckpoint({
      command,
      stage: "chat_delivery",
      status: "ok",
      metadata: {
        mode: "draft_preview",
        outcomeOk: outcome.ok,
      },
    });
    return true;
  }

  const kind = command.kind.trim().toLowerCase();
  if (kind.startsWith("write.")) {
    let fallbackUsed = false;
    const callAgentChatBridge = deps.callAgentChatBridge;
    let delivered = await sendChatResultMessageFromOutcome({
      command,
      outcome,
      chatTarget,
      deps: {
        callAgentChatBridge:
          callAgentChatBridge ??
          (async () => {
            throw new Error("chat_bridge_unavailable");
          }),
        memory: deps.memory,
      },
    });
    if (!delivered) {
      const fallbackCompletion = buildNonWriteChatCompletion({ command, outcome });
      if (fallbackCompletion) {
        fallbackUsed = true;
        delivered = await sendNonWriteChatCompletion(deps, {
          command,
          body: fallbackCompletion.body,
          metadata: fallbackCompletion.metadata,
        });
      }
    }
    await deps.recordCheckpoint({
      command,
      stage: "chat_delivery",
      status: delivered ? "ok" : "failed",
      message: delivered ? null : "chat_result_send_failed",
      metadata: {
        mode: "write_outcome",
        usedFallback: fallbackUsed,
      },
    });
    return delivered;
  }

  const completion = buildNonWriteChatCompletion({ command, outcome });
  if (!completion) {
    await deps.recordCheckpoint({
      command,
      stage: "chat_delivery",
      status: "failed",
      message: "chat_completion_unavailable",
      metadata: {
        mode: "non_write_terminal",
      },
    });
    return false;
  }
  const delivered = await sendNonWriteChatCompletion(deps, {
    command,
    body: completion.body,
    metadata: completion.metadata,
  });
  await deps.recordCheckpoint({
    command,
    stage: "chat_delivery",
    status: delivered ? "ok" : "failed",
    message: delivered ? null : "chat_result_send_failed",
    metadata: {
      mode: "non_write_terminal",
    },
  });
  return delivered;
}
