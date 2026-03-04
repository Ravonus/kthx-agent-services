import { isRecord } from "../lib/guards.js";
import { nowIso, toAnswerPreview } from "../lib/text.js";
import type { ChatInboxEntry } from "./chat-reply.js";
import type {
  RetentionDialogConfig,
  RetentionDialogState,
  RetentionDialogStep,
} from "./chat-types.js";
import {
  RETENTION_ACTION_PATTERN,
  RETENTION_CANCEL_PATTERN,
  RETENTION_INTENT_PATTERN,
  clampInt,
  extractRetentionDialogHints,
  parseBooleanChatInput,
  parseRetentionDaysInput,
  parseRetentionIntervalMinutesInput,
  resolveRetentionDialogStep,
} from "./chat-manager-retention-utils.js";

const getRetentionDialogKey = (entry: ChatInboxEntry): string | null => {
  if (entry.conversationId && entry.conversationId.trim().length > 0) {
    return `conversation:${entry.conversationId.trim()}`;
  }
  if (entry.authorMainUserId && entry.authorMainUserId.trim().length > 0) {
    return `author:${entry.authorMainUserId.trim()}`;
  }
  return null;
};

const isRetentionIntentMessage = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  if (!normalized.length) return false;
  if (RETENTION_INTENT_PATTERN.test(normalized)) return true;
  return (
    RETENTION_ACTION_PATTERN.test(normalized) &&
    /\b(memory|archive|retention|ttl|cleanup|policy)\b/iu.test(normalized)
  );
};

const retentionStepPrompt = (step: RetentionDialogStep): string => {
  switch (step) {
    case "ask_days":
      return "Retention setup: how long should primary memory be kept before archival/compression? Example: `365 days` or `2 years`.";
    case "ask_interval":
      return "Retention setup: how often should cleanup run? Example: `every 3 hours` or `180 minutes`.";
    case "ask_long_term":
      return "Retention setup: should long-term archive stay enabled? Reply `yes` or `no`.";
    case "ask_agent_compression":
      return "Retention setup: should long-term archive use agent compression for older capsules? Reply `yes` or `no`.";
    case "ask_confirm":
      return "Reply `confirm` to apply, or `cancel` to abort.";
  }
};

const retentionSummary = (config: RetentionDialogConfig): string =>
  [
    `days=${config.days}`,
    `intervalMin=${config.intervalMinutes}`,
    `longTerm=${config.longTermEnabled ? "on" : "off"}`,
    `agentCompression=${config.longTermUseAgentCompression ? "on" : "off"}`,
  ].join(" · ");

const toRetentionDialogConfig = (
  pending: Partial<RetentionDialogConfig>,
): RetentionDialogConfig | null => {
  if (
    typeof pending.days !== "number" ||
    !Number.isFinite(pending.days) ||
    pending.days <= 0
  ) {
    return null;
  }
  if (
    typeof pending.intervalMinutes !== "number" ||
    !Number.isFinite(pending.intervalMinutes) ||
    pending.intervalMinutes <= 0
  ) {
    return null;
  }
  if (typeof pending.longTermEnabled !== "boolean") return null;
  const longTermUseAgentCompression =
    pending.longTermEnabled === true
      ? pending.longTermUseAgentCompression === true
      : false;
  return {
    days: clampInt(pending.days, 1, 3650),
    intervalMinutes: clampInt(pending.intervalMinutes, 10, 1440),
    longTermEnabled: pending.longTermEnabled,
    longTermUseAgentCompression,
  };
};

const buildRetentionConfirmPrompt = (config: RetentionDialogConfig): string =>
  ["Retention plan:", retentionSummary(config), retentionStepPrompt("ask_confirm")].join(
    "\n",
  );

const applyRetentionPolicy = async (
  config: RetentionDialogConfig,
): Promise<{ ok: boolean; reply: string }> => {
  const hostRaw = (process.env.MG_AGENT_HEALTH_HOST ?? "").trim();
  const host = hostRaw.length > 0 ? hostRaw : "127.0.0.1";
  const portRaw = Number.parseInt(
    (process.env.MG_AGENT_HEALTH_PORT ?? "4278").trim(),
    10,
  );
  const port =
    Number.isFinite(portRaw) && portRaw > 0 && portRaw <= 65_535
      ? portRaw
      : 4278;
  const key = (process.env.MG_AGENT_HEALTH_PRIVATE_KEY ?? "").trim();
  const url = new URL(`/api/health/retention`, `http://${host}:${port}`);
  url.searchParams.set("set", "1");
  url.searchParams.set("days", String(config.days));
  url.searchParams.set("intervalMinutes", String(config.intervalMinutes));
  url.searchParams.set("longTermEnabled", config.longTermEnabled ? "1" : "0");
  url.searchParams.set(
    "longTermUseAgentCompression",
    config.longTermUseAgentCompression ? "1" : "0",
  );
  if (key.length > 0) url.searchParams.set("key", key);

  let response: Response;
  try {
    response = await fetch(url.toString(), { method: "GET" });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reply: `Retention update failed: ${toAnswerPreview(message, 160)}`,
    };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const payloadRecord = isRecord(payload) ? payload : null;
  if (!response.ok || payloadRecord?.ok === false) {
    const detail =
      payloadRecord && typeof payloadRecord.message === "string"
        ? payloadRecord.message
        : `HTTP ${response.status}`;
    return {
      ok: false,
      reply: `Retention update failed: ${toAnswerPreview(detail, 160)}`,
    };
  }
  const updated =
    payloadRecord && typeof payloadRecord.updated === "boolean"
      ? payloadRecord.updated
      : true;
  return {
    ok: true,
    reply: `Retention ${updated ? "updated" : "already up to date"}.\n${retentionSummary(config)}`,
  };
};

export type HandleRetentionPolicyDialogDeps = {
  retentionDialogs: Map<string, RetentionDialogState>;
  markStateDirty: () => void;
  recordWrite: (payload: Record<string, unknown>) => Promise<unknown>;
};

export const handleRetentionPolicyDialog = async (
  deps: HandleRetentionPolicyDialogDeps,
  entry: ChatInboxEntry,
): Promise<string | null> => {
  const body = entry.body.trim();
  if (!body.length) return null;

  const dialogKey = getRetentionDialogKey(entry);
  if (!dialogKey) return null;
  const existing = deps.retentionDialogs.get(dialogKey) ?? null;
  const wantsRetentionFlow = isRetentionIntentMessage(body);
  if (!existing && !wantsRetentionFlow) return null;

  if (entry.channelId) {
    if (existing) {
      deps.retentionDialogs.delete(dialogKey);
      deps.markStateDirty();
    }
    return "Retention settings can only be changed in a DM with me. Open a DM and I’ll walk through it step by step.";
  }

  if (RETENTION_CANCEL_PATTERN.test(body)) {
    if (existing) {
      deps.retentionDialogs.delete(dialogKey);
      deps.markStateDirty();
      return "Retention update canceled. Send `set retention ...` to start again.";
    }
    return "No retention update is currently in progress.";
  }

  let dialog = existing;
  if (!dialog) {
    const now = nowIso();
    const pending = extractRetentionDialogHints(body);
    dialog = {
      key: dialogKey,
      step: resolveRetentionDialogStep(pending),
      createdAt: now,
      updatedAt: now,
      conversationId: entry.conversationId,
      authorMainUserId: entry.authorMainUserId,
      pending,
    };
    deps.retentionDialogs.set(dialogKey, dialog);
    deps.markStateDirty();
    await deps
      .recordWrite({
        type: "chat_runtime_retention_dialog_started",
        at: now,
        messageId: entry.messageId,
        conversationId: entry.conversationId,
        channelId: entry.channelId,
        pending,
      })
      .catch(() => undefined);
  } else {
    if (dialog.step === "ask_days") {
      const days = parseRetentionDaysInput(body);
      if (days === null) {
        return "I need the retention length first. Example: `365 days` or `2 years`.";
      }
      dialog.pending.days = days;
    } else if (dialog.step === "ask_interval") {
      const interval = parseRetentionIntervalMinutesInput(body);
      if (interval === null) {
        return "I need the cleanup interval. Example: `every 3 hours` or `180 minutes`.";
      }
      dialog.pending.intervalMinutes = interval;
    } else if (dialog.step === "ask_long_term") {
      const longTermEnabled = parseBooleanChatInput(body);
      if (longTermEnabled === null) {
        return "Should long-term archive be enabled? Reply `yes` or `no`.";
      }
      dialog.pending.longTermEnabled = longTermEnabled;
      if (!longTermEnabled) dialog.pending.longTermUseAgentCompression = false;
    } else if (dialog.step === "ask_agent_compression") {
      const useCompression = parseBooleanChatInput(body);
      if (useCompression === null) {
        return "Should I enable agent compression for long-term capsules? Reply `yes` or `no`.";
      }
      dialog.pending.longTermUseAgentCompression = useCompression;
    } else {
      const decision = parseBooleanChatInput(body);
      if (decision === null) {
        return "Reply `confirm` to apply retention changes, or `cancel`.";
      }
      if (!decision) {
        deps.retentionDialogs.delete(dialogKey);
        deps.markStateDirty();
        return "No changes applied. Retention update canceled.";
      }
      const resolved = toRetentionDialogConfig(dialog.pending);
      if (!resolved) {
        dialog.step = resolveRetentionDialogStep(dialog.pending);
        dialog.updatedAt = nowIso();
        deps.retentionDialogs.set(dialogKey, dialog);
        deps.markStateDirty();
        return retentionStepPrompt(dialog.step);
      }
      const applied = await applyRetentionPolicy(resolved);
      await deps
        .recordWrite({
          type: applied.ok
            ? "chat_runtime_retention_dialog_applied"
            : "chat_runtime_retention_dialog_apply_failed",
          at: nowIso(),
          messageId: entry.messageId,
          conversationId: entry.conversationId,
          channelId: entry.channelId,
          config: resolved,
          ok: applied.ok,
          replyPreview: toAnswerPreview(applied.reply, 220),
        })
        .catch(() => undefined);
      if (applied.ok) {
        deps.retentionDialogs.delete(dialogKey);
        deps.markStateDirty();
      } else {
        dialog.updatedAt = nowIso();
        deps.retentionDialogs.set(dialogKey, dialog);
        deps.markStateDirty();
      }
      return applied.reply;
    }
    dialog.updatedAt = nowIso();
    dialog.step = resolveRetentionDialogStep(dialog.pending);
    deps.retentionDialogs.set(dialogKey, dialog);
    deps.markStateDirty();
  }

  const resolved = toRetentionDialogConfig(dialog.pending);
  if (resolved) {
    dialog.step = "ask_confirm";
    dialog.updatedAt = nowIso();
    deps.retentionDialogs.set(dialogKey, dialog);
    deps.markStateDirty();
    return buildRetentionConfirmPrompt(resolved);
  }
  return retentionStepPrompt(dialog.step);
};
