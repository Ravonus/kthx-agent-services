/**
 * Queue state normalization, queue class resolution, and deterministic
 * delay planning for the directive execution queue.
 *
 * Ported from agent-runtime.mjs lines 4528-4773.
 *
 * Pure functions module -- no class needed.
 */

import { isRecord } from "../lib/guards.js";
import { nowIso } from "../lib/text.js";
import type {
  QueueItem,
  QueueItemStatus,
  QueueState,
} from "../types/ipc.js";

// ---------------------------------------------------------------------------
// Force-now detection
// ---------------------------------------------------------------------------

const FORCE_FLAG_RE = /(^|\s)(--force|-f)(?=\s|$)/iu;

const hasForceFlagToken = (value: unknown): boolean =>
  typeof value === "string" && FORCE_FLAG_RE.test(value.trim());

const FORCE_PRIORITY_VALUES = new Set([
  "force",
  "forced",
  "urgent",
  "immediate",
  "now",
  "asap",
]);

const isForcePriorityValue = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  return FORCE_PRIORITY_VALUES.has(value.trim().toLowerCase());
};

/** Detect a forceNow signal from a command-like payload. */
export const resolveForceNowFromPayload = (payload: unknown): boolean => {
  if (!isRecord(payload)) return false;
  const booleanForceKeys = [
    "force",
    "forceNow",
    "urgent",
    "immediate",
    "runNow",
  ];
  if (booleanForceKeys.some((key) => payload[key] === true)) return true;
  if (isForcePriorityValue(payload.priority)) return true;
  if (hasForceFlagToken(payload.note) || hasForceFlagToken(payload.prompt))
    return true;
  if (typeof payload.args === "string" && hasForceFlagToken(payload.args))
    return true;
  if (
    Array.isArray(payload.args) &&
    payload.args.some((entry: unknown) => hasForceFlagToken(entry))
  )
    return true;
  const flags = isRecord(payload.flags) ? payload.flags : null;
  if (flags && (flags.force === true || flags.forceNow === true)) return true;
  return false;
};

/** Detect forceNow from a top-level command-like object. */
export const resolveForceNowFromCommandLike = (
  commandLike: unknown,
): boolean => {
  if (!isRecord(commandLike)) return false;
  if (commandLike.forceNow === true || commandLike.force === true) return true;
  return resolveForceNowFromPayload(commandLike.payload);
};

// ---------------------------------------------------------------------------
// Queue class resolution
// ---------------------------------------------------------------------------

const QUEUE_CLASS_VALUES = new Set([
  "general",
  "control",
  "engagement",
  "comment",
  "post",
  "media",
  "story",
]);

/** Normalize a raw string into a valid queue class or "general". */
export const normalizeQueueClass = (value: unknown): string => {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return QUEUE_CLASS_VALUES.has(raw) ? raw : "general";
};

/**
 * Determine the queue class for a command-like object based on its `kind`
 * and `payload`. Used when enqueuing directives.
 */
export const resolveQueueClass = ({
  kind,
  payload,
}: {
  kind: unknown;
  payload: unknown;
}): string => {
  const normalizedKind =
    typeof kind === "string" ? kind.trim().toLowerCase() : "";
  const normalizedPayload = isRecord(payload) ? payload : null;
  if (normalizedKind === "brain.retrypending") return "control";
  if (normalizedKind === "brain.generateandqueue") {
    const goal =
      normalizedPayload && typeof normalizedPayload.goal === "string"
        ? normalizedPayload.goal.trim().toLowerCase()
        : "";
    if (goal === "media") return "media";
    if (goal === "story") return "story";
    if (goal === "comment") return "comment";
    if (goal === "like" || goal === "engagement") return "engagement";
    if (goal === "post" || goal === "thread") return "post";
    return "general";
  }
  if (normalizedKind === "write.createpost") {
    const postType =
      normalizedPayload && typeof normalizedPayload.postType === "string"
        ? normalizedPayload.postType.trim().toLowerCase()
        : "";
    if (postType === "media") return "media";
    return "post";
  }
  if (normalizedKind === "write.createstory") return "story";
  if (
    normalizedKind === "write.comment" ||
    normalizedKind === "write.commentpost"
  )
    return "comment";
  if (
    normalizedKind === "write.like" ||
    normalizedKind === "write.votepost" ||
    normalizedKind === "write.repost" ||
    normalizedKind === "write.repostpost"
  )
    return "engagement";
  if (normalizedKind.startsWith("write.")) return "post";
  return "general";
};

// ---------------------------------------------------------------------------
// Queue item normalization
// ---------------------------------------------------------------------------

const ALLOWED_STATUSES = new Set<QueueItemStatus>([
  "queued",
  "scheduled",
  "running",
  "done",
  "failed",
  "missing",
  "cancelled",
]);

/**
 * Validate and normalize a raw queue item object. Returns `null` when the
 * input is missing required fields.
 */
export const normalizeQueueItem = (item: unknown): QueueItem | null => {
  if (!isRecord(item)) return null;
  const id =
    typeof item.id === "string" && item.id.trim().length > 0
      ? item.id.trim()
      : "";
  const directiveId =
    typeof item.directiveId === "string" && item.directiveId.trim().length > 0
      ? item.directiveId.trim()
      : "";
  const inboxFile =
    typeof item.inboxFile === "string" && item.inboxFile.trim().length > 0
      ? item.inboxFile.trim()
      : "";
  if (!id.length || !directiveId.length || !inboxFile.length) return null;

  const statusRaw =
    typeof item.status === "string" && item.status.trim().length > 0
      ? item.status.trim()
      : "queued";
  const status = ALLOWED_STATUSES.has(statusRaw as QueueItemStatus)
    ? (statusRaw as QueueItemStatus)
    : ("queued" as QueueItemStatus);

  const dueAt =
    typeof item.dueAt === "string" && item.dueAt.trim().length > 0
      ? item.dueAt.trim()
      : null;
  const createdAt =
    typeof item.createdAt === "string" && item.createdAt.trim().length > 0
      ? item.createdAt.trim()
      : nowIso();
  const attempts =
    typeof item.attempts === "number" && Number.isFinite(item.attempts)
      ? Math.max(0, Math.floor(item.attempts))
      : 0;
  const queueClass = normalizeQueueClass(item.queueClass);
  const forceNow = item.forceNow === true;
  const commandFingerprint =
    typeof item.commandFingerprint === "string" &&
    item.commandFingerprint.trim().length > 0
      ? item.commandFingerprint.trim()
      : null;

  return {
    id,
    directiveId,
    inboxFile,
    queueClass,
    forceNow,
    commandFingerprint,
    status,
    createdAt,
    dueAt,
    attempts,
    startedAt:
      typeof item.startedAt === "string" && item.startedAt.trim().length > 0
        ? item.startedAt.trim()
        : null,
    completedAt:
      typeof item.completedAt === "string" &&
      item.completedAt.trim().length > 0
        ? item.completedAt.trim()
        : null,
    lastAttemptAt:
      typeof item.lastAttemptAt === "string" &&
      item.lastAttemptAt.trim().length > 0
        ? item.lastAttemptAt.trim()
        : null,
    lastError:
      typeof item.lastError === "string" && item.lastError.trim().length > 0
        ? item.lastError.trim()
        : null,
    scheduledBy:
      typeof item.scheduledBy === "string" &&
      item.scheduledBy.trim().length > 0
        ? item.scheduledBy.trim()
        : null,
  };
};

// ---------------------------------------------------------------------------
// Queue state normalization
// ---------------------------------------------------------------------------

/** Normalize an entire queue state file, filtering out invalid items. */
export const normalizeQueueState = (value: unknown): QueueState => {
  const base: QueueState = {
    updatedAt: nowIso(),
    runnerEnabled: false,
    items: [],
    lastPlanAt: null,
    lastPlanSource: null,
  };
  if (!isRecord(value)) return base;

  const items = Array.isArray(value.items)
    ? (value.items
        .map((item: unknown) => normalizeQueueItem(item))
        .filter(Boolean) as QueueItem[])
    : [];

  return {
    updatedAt:
      typeof value.updatedAt === "string" &&
      value.updatedAt.trim().length > 0
        ? value.updatedAt.trim()
        : base.updatedAt,
    runnerEnabled: value.runnerEnabled === true,
    items,
    lastPlanAt:
      typeof value.lastPlanAt === "string" &&
      value.lastPlanAt.trim().length > 0
        ? value.lastPlanAt.trim()
        : null,
    lastPlanSource:
      typeof value.lastPlanSource === "string" &&
      value.lastPlanSource.trim().length > 0
        ? value.lastPlanSource.trim()
        : null,
  };
};

// ---------------------------------------------------------------------------
// Deterministic delay planning
// ---------------------------------------------------------------------------

/** Spacing factor for each queue class (multiplied by base spacing). */
const CLASS_FACTOR: Record<string, number> = {
  control: 0.2,
  engagement: 0.3,
  comment: 0.4,
  story: 0.8,
  post: 1,
  media: 1.35,
  general: 0.9,
};

/** Rapid-mode spacing in seconds by queue class. */
const RAPID_SPACING: Record<string, number> = {
  control: 1,
  engagement: 4,
  comment: 6,
  story: 12,
  post: 10,
  media: 14,
  general: 8,
};

/**
 * Compute a deterministic delay (in seconds) for each pending queue item.
 *
 * Items with `forceNow` are assigned near-zero delays. Non-force items are
 * spaced using class-based factors, repeat-streak multipliers, and backlog
 * compression to naturally drain a large queue.
 *
 * @returns A map from `inboxFile` to delay in seconds.
 */
export const computeDeterministicDelay = ({
  pendingItems,
  minSpacingSeconds,
  maxSpacingSeconds,
}: {
  pendingItems: QueueItem[];
  minSpacingSeconds: number;
  maxSpacingSeconds: number;
}): Map<string, number> => {
  const ordered = pendingItems.slice().sort((a, b) => {
    if (a.forceNow !== b.forceNow) return a.forceNow ? -1 : 1;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });

  const delayByInbox = new Map<string, number>();
  const nonForceItems = ordered.filter((item) => item.forceNow !== true);
  const nonForceCount = nonForceItems.length;
  const rapidMode = nonForceCount <= 3;
  const backlogCompressionFactor =
    nonForceCount <= 4
      ? 1
      : Math.max(
          0.55,
          1 - Math.min(0.45, Math.max(0, nonForceCount - 4) * 0.06),
        );

  let forceOffsetSeconds = 0;
  let cursorSeconds = 0;
  let previousQueueClass: string | null = null;
  let repeatStreak = 0;

  for (const item of ordered) {
    if (item.forceNow === true) {
      delayByInbox.set(item.inboxFile, forceOffsetSeconds);
      forceOffsetSeconds += 1;
      continue;
    }

    const queueClass = item.queueClass ?? "general";

    // First non-force item starts from the force-offset cursor.
    if (delayByInbox.size === forceOffsetSeconds) {
      cursorSeconds = forceOffsetSeconds;
      delayByInbox.set(item.inboxFile, cursorSeconds);
      previousQueueClass = queueClass;
      repeatStreak = 1;
      continue;
    }

    const classFactor = CLASS_FACTOR[queueClass] ?? CLASS_FACTOR.general!;
    const rapidBase =
      RAPID_SPACING[queueClass] ?? RAPID_SPACING.general!;
    const pacedBase = Math.max(
      10,
      Math.round(minSpacingSeconds * classFactor * backlogCompressionFactor),
    );
    let spacingSeconds = rapidMode
      ? rapidBase +
        Math.max(0, delayByInbox.size - forceOffsetSeconds - 1) * 3
      : pacedBase;

    if (
      queueClass === previousQueueClass &&
      (queueClass === "post" ||
        queueClass === "media" ||
        queueClass === "story")
    ) {
      repeatStreak += 1;
      const repeatMultiplier = Math.min(
        2.4,
        1 + (repeatStreak - 1) * 0.35,
      );
      spacingSeconds = Math.round(spacingSeconds * repeatMultiplier);
    } else {
      repeatStreak = 1;
    }

    previousQueueClass = queueClass;
    const minSpacingFloor = rapidMode ? 3 : 10;
    spacingSeconds = Math.max(
      minSpacingFloor,
      Math.min(maxSpacingSeconds, spacingSeconds),
    );
    cursorSeconds += spacingSeconds;
    delayByInbox.set(item.inboxFile, cursorSeconds);
  }

  return delayByInbox;
};
