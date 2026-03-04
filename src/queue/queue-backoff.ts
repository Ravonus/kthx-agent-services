import type { QueueItem } from "../types/ipc.js";

export const NOT_READY_MIN_REQUEUE_DELAY_SECONDS = 2;
export const NOT_READY_MAX_REQUEUE_DELAY_SECONDS = 300;
export const NOT_READY_MAX_ATTEMPTS = 30;
export const RUNNING_RECOVERY_MIN_AGE_MS = 60_000;

export const TERMINAL_QUEUE_STATUSES = new Set<QueueItem["status"]>([
  "done",
  "failed",
  "missing",
  "cancelled",
]);

const MEDIA_GENERATION_FAST_REQUEUE_PATTERN =
  /\b(image_generation_setup_required|media_generation_waiting_for_output|no_media_url|chat_delivery_media_url_invalid|unsupported_media_payload_mime|invalid_data_uri|media_source_empty|upload_only_image_video)\b/iu;
const PERSONA_SETUP_REQUEUE_PATTERN = /\bpersona_reference_setup_required:/iu;

export const resolveNotReadyBackoffProfile = (
  reason: string | null | undefined,
): string => {
  const normalizedReason = typeof reason === "string" ? reason.trim().toLowerCase() : "";
  if (MEDIA_GENERATION_FAST_REQUEUE_PATTERN.test(normalizedReason)) {
    return "media_generation_fast_retry";
  }
  if (PERSONA_SETUP_REQUEUE_PATTERN.test(normalizedReason)) {
    return "persona_setup_retry";
  }
  return "default_not_ready_retry";
};

export const computeNotReadyRequeueDelaySeconds = (
  attempts: number,
  reason?: string | null,
): number => {
  const normalizedAttempts =
    Number.isFinite(attempts) && attempts > 0 ? Math.trunc(attempts) : 1;
  const profile = resolveNotReadyBackoffProfile(reason);

  if (profile === "media_generation_fast_retry") {
    if (normalizedAttempts <= 5) {
      return Math.max(
        NOT_READY_MIN_REQUEUE_DELAY_SECONDS,
        normalizedAttempts * 2,
      );
    }
    if (normalizedAttempts <= 12) {
      return Math.min(
        NOT_READY_MAX_REQUEUE_DELAY_SECONDS,
        10 + (normalizedAttempts - 5) * 2,
      );
    }
    return Math.min(NOT_READY_MAX_REQUEUE_DELAY_SECONDS, 30);
  }

  if (profile === "persona_setup_retry") {
    if (normalizedAttempts <= 4) {
      return Math.min(
        NOT_READY_MAX_REQUEUE_DELAY_SECONDS,
        5 * normalizedAttempts,
      );
    }
    if (normalizedAttempts <= 10) {
      return Math.min(
        NOT_READY_MAX_REQUEUE_DELAY_SECONDS,
        20 + (normalizedAttempts - 4) * 5,
      );
    }
    return Math.min(NOT_READY_MAX_REQUEUE_DELAY_SECONDS, 60);
  }

  if (normalizedAttempts <= 3) {
    return Math.max(
      NOT_READY_MIN_REQUEUE_DELAY_SECONDS,
      normalizedAttempts * 2,
    );
  }
  if (normalizedAttempts <= 8) {
    return Math.min(
      NOT_READY_MAX_REQUEUE_DELAY_SECONDS,
      12 + (normalizedAttempts - 3) * 8,
    );
  }
  if (normalizedAttempts <= 20) {
    return Math.min(
      NOT_READY_MAX_REQUEUE_DELAY_SECONDS,
      60 + (normalizedAttempts - 8) * 10,
    );
  }
  return NOT_READY_MAX_REQUEUE_DELAY_SECONDS;
};
