import { isRecord } from "../lib/guards.js";
import { nowIso, toAnswerPreview } from "../lib/text.js";
import type { ChatInboxEntry } from "./chat-reply.js";

export type FetchConversationHistoryDeps = {
  callAgentChatBridge: (payload: Record<string, unknown>) => Promise<unknown>;
};

export const fetchConversationHistory = async (
  deps: FetchConversationHistoryDeps,
  entry: ChatInboxEntry,
): Promise<unknown[]> => {
  try {
    const limit = entry.replyToMessageId ? 40 : 10;
    const payload = {
      action: "list_messages",
      ...(entry.conversationId
        ? { conversationId: entry.conversationId }
        : { channelId: entry.channelId }),
      limit,
    };
    const result = await deps.callAgentChatBridge(payload);
    if (isRecord(result) && Array.isArray(result.items)) {
      return (result.items as unknown[]).slice(0, limit).reverse();
    }
    return [];
  } catch {
    return [];
  }
};

export type ReportSystemProbeReason =
  | "system_disclosure_request_blocked"
  | "system_disclosure_reply_blocked";

export type ReportSystemProbeDeps = {
  callAgentChatBridge: (payload: Record<string, unknown>) => Promise<unknown>;
  recordWrite: (payload: Record<string, unknown>) => Promise<unknown>;
};

export const reportSystemProbe = async (
  deps: ReportSystemProbeDeps,
  input: {
    entry: ChatInboxEntry;
    reason: ReportSystemProbeReason;
  },
): Promise<void> => {
  const { entry, reason } = input;
  const targetMainUserId = entry.authorMainUserId?.trim() ?? "";
  if (!targetMainUserId.length) return;
  const contextPayload = entry.conversationId
    ? { conversationId: entry.conversationId }
    : entry.channelId
      ? { channelId: entry.channelId }
      : null;
  if (!contextPayload) return;

  try {
    const payload = {
      action: "report_system_probe",
      targetMainUserId,
      ...(entry.messageId ? { messageId: entry.messageId } : {}),
      ...contextPayload,
      reason,
    };
    const response = await deps.callAgentChatBridge(payload);
    await deps
      .recordWrite({
        type: "chat_runtime_system_probe_reported",
        at: nowIso(),
        reason,
        messageId: entry.messageId,
        targetMainUserId,
        response: isRecord(response) ? response : null,
      })
      .catch(() => undefined);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await deps
      .recordWrite({
        type: "chat_runtime_system_probe_report_failed",
        at: nowIso(),
        reason,
        messageId: entry.messageId,
        targetMainUserId,
        error: toAnswerPreview(message, 240),
      })
      .catch(() => undefined);
  }
};
