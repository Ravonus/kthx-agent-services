import { isRecord } from "../lib/guards.js";
import { nowIso, toAnswerPreview } from "../lib/text.js";
import type { ChatInboxEntry } from "./chat-reply.js";

export type FetchConversationHistoryDeps = {
  callAgentChatBridge: (payload: Record<string, unknown>) => Promise<unknown>;
};

// ---------------------------------------------------------------------------
// Conversation history LRU cache — avoids redundant HTTP bridge calls when
// multiple messages arrive in the same conversation within a short window.
// ---------------------------------------------------------------------------

interface CachedHistory {
  items: unknown[];
  fetchedAtMs: number;
  limit: number;
}

const HISTORY_CACHE_TTL_MS = 15_000;
const HISTORY_CACHE_MAX_ENTRIES = 32;

const historyCache = new Map<string, CachedHistory>();

const pruneHistoryCache = (): void => {
  if (historyCache.size <= HISTORY_CACHE_MAX_ENTRIES) return;
  // Evict oldest entries first.
  const entries = [...historyCache.entries()].sort(
    (a, b) => a[1].fetchedAtMs - b[1].fetchedAtMs,
  );
  const toRemove = entries.length - HISTORY_CACHE_MAX_ENTRIES;
  for (let i = 0; i < toRemove; i++) {
    historyCache.delete(entries[i]![0]);
  }
};

export const fetchConversationHistory = async (
  deps: FetchConversationHistoryDeps,
  entry: ChatInboxEntry,
): Promise<unknown[]> => {
  try {
    const limit = entry.replyToMessageId ? 40 : 10;
    const cacheKey = entry.conversationId ?? entry.channelId ?? "";

    // Check cache — reuse if fresh and limit is sufficient.
    if (cacheKey) {
      const cached = historyCache.get(cacheKey);
      if (
        cached &&
        Date.now() - cached.fetchedAtMs < HISTORY_CACHE_TTL_MS &&
        cached.limit >= limit
      ) {
        return cached.items.slice(0, limit);
      }
    }

    const payload = {
      action: "list_messages",
      ...(entry.conversationId
        ? { conversationId: entry.conversationId }
        : { channelId: entry.channelId }),
      limit,
    };
    const result = await deps.callAgentChatBridge(payload);
    const items =
      isRecord(result) && Array.isArray(result.items)
        ? (result.items as unknown[]).slice(0, limit).reverse()
        : [];

    // Cache the result.
    if (cacheKey) {
      historyCache.set(cacheKey, {
        items,
        fetchedAtMs: Date.now(),
        limit,
      });
      pruneHistoryCache();
    }

    return items;
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
