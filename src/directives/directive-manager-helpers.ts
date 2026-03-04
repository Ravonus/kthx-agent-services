import { isRecord } from "../lib/guards.js";
import { resolveForceNowFromPayload } from "../queue/queue-state.js";

export const normalizeActionNonce = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

export const nonceToken = (value: unknown): string =>
  normalizeActionNonce(value) ?? "";

const FORCE_FLAG_RE = /(^|\s)(--force|-f)(?=\s|$)/iu;
const hasForceFlagToken = (value: unknown): boolean =>
  typeof value === "string" && FORCE_FLAG_RE.test(value.trim());

const isMentionDirectivePayload = (payload: unknown): boolean =>
  isRecord(payload) &&
  (typeof payload.mentionIntent === "string" ||
    isRecord(payload.mentionSource) ||
    isRecord(payload.mentionTarget) ||
    isRecord(payload.mentionCommand));

/** Directive-level forceNow detection (wraps payload-level from queue-state). */
export const resolveForceNowFromDirective = (directive: unknown): boolean => {
  if (!isRecord(directive)) return false;
  if (directive.forceNow === true || directive.force === true) return true;
  if (
    hasForceFlagToken(directive.note) ||
    hasForceFlagToken(directive.instruction)
  ) {
    return true;
  }
  if (isMentionDirectivePayload(directive.payload)) return true;
  return resolveForceNowFromPayload(directive.payload);
};

export const asPositiveInt = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
};

export const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const QUEUED_PENDING_STATUSES = new Set([
  "queued_for_execution",
  "draft_waiting_execution",
]);

export const TERMINAL_PENDING_STATUSES = new Set([
  "completed",
  "permission_denied",
  "no_executable_draft",
  "max_retry_exceeded",
  "failed",
  "cancelled",
  "cancelled_reconnect_reset",
]);

export const normalizePendingPromotionLimit = (value: unknown): number => {
  const parsed = asPositiveInt(value);
  if (!parsed) return 25;
  return Math.max(1, Math.min(100, parsed));
};

export const resolveDirectiveTarget = (input: {
  kind: string;
  payload: Record<string, unknown> | null;
}): { postId: number; commentId: number | null } | null => {
  const payload = input.payload;
  if (!payload) return null;
  const normalizedKind = input.kind.trim().toLowerCase();
  const postId = asPositiveInt(payload.postId);
  const commentId =
    asPositiveInt(payload.commentId) ?? asPositiveInt(payload.parentId);
  if (
    normalizedKind === "write.commentpost" ||
    normalizedKind === "write.comment" ||
    normalizedKind === "write.like" ||
    normalizedKind === "write.votepost" ||
    normalizedKind === "write.repost" ||
    normalizedKind === "write.repostpost"
  ) {
    if (!postId) return null;
    return {
      postId,
      commentId:
        normalizedKind === "write.commentpost" ||
        normalizedKind === "write.comment"
          ? commentId
          : null,
    };
  }
  if (normalizedKind === "brain.generateandqueue") {
    const goal =
      typeof payload.goal === "string" ? payload.goal.trim().toLowerCase() : "";
    if (!["comment", "like", "repost"].includes(goal)) return null;
    if (!postId) return null;
    return {
      postId,
      commentId: goal === "comment" ? commentId : null,
    };
  }
  return null;
};
