import { isRecord } from "../lib/guards.js";
import { nowIso } from "../lib/text.js";
import type {
  RetentionDialogConfig,
  RetentionDialogState,
  RetentionDialogStep,
} from "./chat-types.js";

export const RETENTION_INTENT_PATTERN =
  /\b(retention|retain|retained|memory\s+policy|memory\s+retention|cleanup\s+interval|archive\s+policy|ttl)\b/iu;
export const RETENTION_ACTION_PATTERN =
  /\b(set|change|update|configure|adjust|tune|modify)\b/iu;
export const RETENTION_CANCEL_PATTERN =
  /\b(cancel|stop|abort|never\s*mind|nevermind)\b/iu;
export const RETENTION_BOOL_TRUE_PATTERN =
  /\b(yes|true|enable|enabled|on|confirm|apply)\b/iu;
export const RETENTION_BOOL_FALSE_PATTERN =
  /\b(no|false|disable|disabled|off)\b/iu;
export const RETENTION_LONG_TERM_HINT_PATTERN = /\b(long\s*term|archive)\b/iu;
export const RETENTION_AGENT_COMPRESSION_HINT_PATTERN =
  /\b(agent\s*compression|llm\s*compression|model\s*compression)\b/iu;

export const clampInt = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.floor(value)));

export const parseBooleanChatInput = (value: string): boolean | null => {
  const normalized = value.trim().toLowerCase();
  if (!normalized.length) return null;
  const hasTrue = RETENTION_BOOL_TRUE_PATTERN.test(normalized);
  const hasFalse = RETENTION_BOOL_FALSE_PATTERN.test(normalized);
  if (hasTrue && !hasFalse) return true;
  if (hasFalse && !hasTrue) return false;
  if (normalized === "y") return true;
  if (normalized === "n") return false;
  return null;
};

export const parseRetentionDaysInput = (value: string): number | null => {
  const normalized = value.trim().toLowerCase();
  if (!normalized.length) return null;
  if (/\b(forever|indefinite|indefinitely|lifetime)\b/iu.test(normalized)) {
    return 3650;
  }
  const parseWithUnit = (
    pattern: RegExp,
    multiplier: number,
  ): number | null => {
    const match = pattern.exec(normalized);
    if (!match?.[1]) return null;
    const raw = Number.parseFloat(match[1]);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return clampInt(Math.round(raw * multiplier), 1, 3650);
  };
  const years = parseWithUnit(/\b(\d+(?:\.\d+)?)\s*(?:years?|yrs?|y)\b/iu, 365);
  if (years !== null) return years;
  const months = parseWithUnit(/\b(\d+(?:\.\d+)?)\s*(?:months?|mos?)\b/iu, 30);
  if (months !== null) return months;
  const weeks = parseWithUnit(/\b(\d+(?:\.\d+)?)\s*(?:weeks?|w)\b/iu, 7);
  if (weeks !== null) return weeks;
  const days = parseWithUnit(/\b(\d+(?:\.\d+)?)\s*(?:days?|d)\b/iu, 1);
  if (days !== null) return days;
  const plain = Number.parseInt(normalized, 10);
  if (Number.isFinite(plain) && plain > 0) return clampInt(plain, 1, 3650);
  return null;
};

export const parseRetentionIntervalMinutesInput = (value: string): number | null => {
  const normalized = value.trim().toLowerCase();
  if (!normalized.length) return null;
  if (/\bhourly\b/iu.test(normalized)) return 60;
  if (/\bdaily\b/iu.test(normalized)) return 1440;
  const parseWithUnit = (
    pattern: RegExp,
    multiplier: number,
  ): number | null => {
    const match = pattern.exec(normalized);
    if (!match?.[1]) return null;
    const raw = Number.parseFloat(match[1]);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return clampInt(Math.round(raw * multiplier), 10, 1440);
  };
  const hours =
    parseWithUnit(
      /\bevery\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/iu,
      60,
    ) ??
    parseWithUnit(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/iu, 60);
  if (hours !== null) return hours;
  const days =
    parseWithUnit(/\bevery\s+(\d+(?:\.\d+)?)\s*(?:days?|d)\b/iu, 1440) ??
    parseWithUnit(/\b(\d+(?:\.\d+)?)\s*(?:days?|d)\b/iu, 1440);
  if (days !== null) return days;
  const minutes =
    parseWithUnit(
      /\bevery\s+(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/iu,
      1,
    ) ??
    parseWithUnit(/\b(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/iu, 1);
  if (minutes !== null) return minutes;
  const plain = Number.parseInt(normalized, 10);
  if (Number.isFinite(plain) && plain > 0) return clampInt(plain, 10, 1440);
  return null;
};

export const extractRetentionDialogHints = (
  value: string,
): Partial<RetentionDialogConfig> => {
  const pending: Partial<RetentionDialogConfig> = {};
  const days = parseRetentionDaysInput(value);
  if (days !== null) pending.days = days;
  const intervalMinutes = parseRetentionIntervalMinutesInput(value);
  if (intervalMinutes !== null) pending.intervalMinutes = intervalMinutes;
  if (RETENTION_LONG_TERM_HINT_PATTERN.test(value)) {
    const longTermEnabled = parseBooleanChatInput(value);
    if (longTermEnabled !== null) pending.longTermEnabled = longTermEnabled;
  }
  if (RETENTION_AGENT_COMPRESSION_HINT_PATTERN.test(value)) {
    const useCompression = parseBooleanChatInput(value);
    if (useCompression !== null) {
      pending.longTermUseAgentCompression = useCompression;
    }
  }
  if (pending.longTermEnabled === false) {
    pending.longTermUseAgentCompression = false;
  }
  return pending;
};

export const resolveRetentionDialogStep = (
  pending: Partial<RetentionDialogConfig>,
): RetentionDialogStep => {
  if (typeof pending.days !== "number") return "ask_days";
  if (typeof pending.intervalMinutes !== "number") return "ask_interval";
  if (typeof pending.longTermEnabled !== "boolean") return "ask_long_term";
  if (
    pending.longTermEnabled &&
    typeof pending.longTermUseAgentCompression !== "boolean"
  ) {
    return "ask_agent_compression";
  }
  return "ask_confirm";
};

export const parseRetentionDialogState = (value: unknown): RetentionDialogState | null => {
  if (!isRecord(value)) return null;
  const key =
    typeof value.key === "string" && value.key.trim().length > 0
      ? value.key.trim()
      : "";
  if (!key.length) return null;
  const stepRaw =
    typeof value.step === "string" && value.step.trim().length > 0
      ? value.step.trim()
      : "";
  const step: RetentionDialogStep | null = [
    "ask_days",
    "ask_interval",
    "ask_long_term",
    "ask_agent_compression",
    "ask_confirm",
  ].includes(stepRaw)
    ? (stepRaw as RetentionDialogStep)
    : null;
  if (!step) return null;
  const pendingRaw = isRecord(value.pending) ? value.pending : {};
  const pending: Partial<RetentionDialogConfig> = {};
  if (
    typeof pendingRaw.days === "number" &&
    Number.isFinite(pendingRaw.days) &&
    pendingRaw.days > 0
  ) {
    pending.days = clampInt(pendingRaw.days, 1, 3650);
  }
  if (
    typeof pendingRaw.intervalMinutes === "number" &&
    Number.isFinite(pendingRaw.intervalMinutes) &&
    pendingRaw.intervalMinutes > 0
  ) {
    pending.intervalMinutes = clampInt(pendingRaw.intervalMinutes, 10, 1440);
  }
  if (typeof pendingRaw.longTermEnabled === "boolean") {
    pending.longTermEnabled = pendingRaw.longTermEnabled;
  }
  if (typeof pendingRaw.longTermUseAgentCompression === "boolean") {
    pending.longTermUseAgentCompression = pendingRaw.longTermUseAgentCompression;
  }
  if (pending.longTermEnabled === false) {
    pending.longTermUseAgentCompression = false;
  }
  return {
    key,
    step,
    createdAt:
      typeof value.createdAt === "string" && value.createdAt.trim().length > 0
        ? value.createdAt.trim()
        : nowIso(),
    updatedAt:
      typeof value.updatedAt === "string" && value.updatedAt.trim().length > 0
        ? value.updatedAt.trim()
        : nowIso(),
    conversationId:
      typeof value.conversationId === "string" &&
      value.conversationId.trim().length > 0
        ? value.conversationId.trim()
        : null,
    authorMainUserId:
      typeof value.authorMainUserId === "string" &&
      value.authorMainUserId.trim().length > 0
        ? value.authorMainUserId.trim()
        : null,
    pending,
  };
};
