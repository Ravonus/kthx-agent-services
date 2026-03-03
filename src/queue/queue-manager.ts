/**
 * QueueManager: lifecycle management for the directive execution queue,
 * including enqueue, deterministic planning, runner tick execution, and
 * backlog compression.
 *
 * Ported from agent-runtime.mjs lines 6772-7263.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { isRecord } from "../lib/guards.js";
import { nowIso } from "../lib/text.js";
import { parseIsoToMs } from "../lib/time.js";
import { readJsonFile, writeJsonFile } from "../lib/fs.js";
import type { QueueItem, QueueState } from "../types/ipc.js";
import type {
  QueueManagerLike,
  QueueReconnectResetResult,
} from "../runtime-context.js";
import {
  normalizeQueueClass,
  normalizeQueueState,
  computeDeterministicDelay,
} from "./queue-state.js";

// ---------------------------------------------------------------------------
// Narrow context interface
// ---------------------------------------------------------------------------

export interface QueueManagerContext {
  config: {
    terminalTriggerOnly: boolean;
    queueRunnerConcurrency: number;
  };
  ipcPaths: {
    queueStatePath: string;
    inboxDir: string;
    wakePath: string;
  };
  kthxQueueConfig: () => QueueSettingsSnapshot;
  memory: {
    recordWrite(payload: unknown): Promise<void>;
  };
  queue: QueueTrackingState;
  /** External hook: process a command file from the inbox dir. */
  processCommandFile: (
    inboxFile: string,
    opts?: { interactiveRl?: unknown; attempts?: number; maxAttempts?: number },
  ) => Promise<boolean>;
  /** External hook: run a memory checkpoint before execution. */
  runMemoryCheckpoint: (opts: {
    force: boolean;
    source: string;
    allowAgentCompression: boolean;
  }) => Promise<void>;
}

export interface QueueSettingsSnapshot {
  minSpacingSeconds: number;
  maxSpacingSeconds: number;
  llmScheduleMinItems: number;
}

export interface QueueTrackingState {
  queueRunnerEnabled: boolean;
  queueRunnerTickInFlight: boolean;
  queueStateMutation: Promise<void>;
}

const NOT_READY_MIN_REQUEUE_DELAY_SECONDS = 2;
const NOT_READY_MAX_REQUEUE_DELAY_SECONDS = 300;
const NOT_READY_MAX_ATTEMPTS = 30;
const RUNNING_RECOVERY_MIN_AGE_MS = 60_000;
const TERMINAL_QUEUE_STATUSES = new Set<QueueItem["status"]>([
  "done",
  "failed",
  "missing",
  "cancelled",
]);
const MEDIA_GENERATION_FAST_REQUEUE_PATTERN =
  /\b(image_generation_setup_required|media_generation_waiting_for_output|no_media_url|chat_delivery_media_url_invalid|unsupported_media_payload_mime|invalid_data_uri|media_source_empty|upload_only_image_video)\b/iu;
const PERSONA_SETUP_REQUEUE_PATTERN = /\bpersona_reference_setup_required:/iu;

const resolveNotReadyBackoffProfile = (reason: string | null | undefined): string => {
  const normalizedReason = typeof reason === "string" ? reason.trim().toLowerCase() : "";
  if (MEDIA_GENERATION_FAST_REQUEUE_PATTERN.test(normalizedReason)) {
    return "media_generation_fast_retry";
  }
  if (PERSONA_SETUP_REQUEUE_PATTERN.test(normalizedReason)) {
    return "persona_setup_retry";
  }
  return "default_not_ready_retry";
};

const computeNotReadyRequeueDelaySeconds = (
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

// ---------------------------------------------------------------------------
// QueueManager
// ---------------------------------------------------------------------------

export class QueueManager implements QueueManagerLike {
  private readonly ctx: QueueManagerContext;
  private readonly activeExecutions = new Set<string>();

  constructor(ctx: QueueManagerContext) {
    this.ctx = ctx;
  }

  // -----------------------------------------------------------------------
  // Enabled state
  // -----------------------------------------------------------------------

  setRunnerEnabled(enabled: boolean): void {
    this.ctx.queue.queueRunnerEnabled = enabled;
    void this.mutateQueueState((state) => ({
      ...state,
      runnerEnabled: enabled,
    }));
  }

  isRunnerEnabled(): boolean {
    return this.ctx.queue.queueRunnerEnabled;
  }

  // -----------------------------------------------------------------------
  // Enqueue a directive into the queue state file
  // -----------------------------------------------------------------------

  async enqueue(item: unknown): Promise<void> {
    if (!isRecord(item)) return;
    const directiveId =
      typeof item.directiveId === "string" ? item.directiveId.trim() : "";
    const inboxFile =
      typeof item.inboxFile === "string" ? item.inboxFile.trim() : "";
    if (!directiveId.length || !inboxFile.length) return;

    const queueClass = normalizeQueueClass(item.queueClass);
    const forceNow = item.forceNow === true;
    const commandFingerprint =
      typeof item.commandFingerprint === "string" &&
      item.commandFingerprint.trim().length > 0
        ? item.commandFingerprint.trim()
        : null;

    await this.mutateQueueState((state) => {
      // Dedup by command fingerprint
      if (commandFingerprint) {
        const existingByFp = state.items.find(
          (qi) =>
            qi.directiveId === directiveId &&
            qi.completedAt === null &&
            typeof qi.commandFingerprint === "string" &&
            qi.commandFingerprint.trim() === commandFingerprint,
        );
        if (existingByFp) return state;
      }
      // Dedup by inbox file
      const existing = state.items.find(
        (qi) => qi.inboxFile === inboxFile,
      );
      if (existing) {
        if (
          existing.forceNow === forceNow &&
          existing.queueClass === queueClass &&
          (!commandFingerprint ||
            existing.commandFingerprint === commandFingerprint)
        ) {
          return state;
        }
        const next = { ...state };
        next.items = state.items.map((qi) => {
          if (qi.inboxFile !== inboxFile) return qi;
          const nextQueueClass =
            qi.queueClass === "general" && queueClass !== "general"
              ? queueClass
              : qi.queueClass ?? queueClass;
          return {
            ...qi,
            queueClass: nextQueueClass,
            forceNow: qi.forceNow === true || forceNow,
            commandFingerprint:
              qi.commandFingerprint ?? commandFingerprint ?? null,
          };
        });
        return next;
      }

      // New item
      const next = { ...state };
      next.items = [
        ...state.items,
        {
          id: crypto.randomUUID(),
          directiveId,
          inboxFile,
          queueClass,
          forceNow,
          commandFingerprint,
          status: "queued" as const,
          createdAt: nowIso(),
          dueAt: null,
          attempts: 0,
          startedAt: null,
          completedAt: null,
          lastAttemptAt: null,
          lastError: null,
          scheduledBy: null,
        },
      ];
      return next;
    });

    await this.ctx.memory.recordWrite({
      type: "directive_queue_enqueued",
      at: nowIso(),
      directiveId,
      inboxFile,
      queueClass,
      forceNow,
    });
  }

  // -----------------------------------------------------------------------
  // Runner tick: pick the next due item, execute, update status
  // -----------------------------------------------------------------------

  async runnerTick(): Promise<void> {
    if (this.ctx.queue.queueRunnerTickInFlight) return;
    this.ctx.queue.queueRunnerTickInFlight = true;
    try {
      await this.recoverAbandonedRunningItems();

      // Deterministic plan first
      await this.planQueueDeterministic("queue_runner_tick");

      const maxConcurrency = Math.max(
        1,
        Math.floor(this.ctx.config.queueRunnerConcurrency),
      );
      const availableSlots = Math.max(
        0,
        maxConcurrency - this.activeExecutions.size,
      );
      if (availableSlots === 0) return;

      const state = await this.readQueueState();
      const candidates = state.items
        .filter(
          (item) =>
            item.status === "queued" || item.status === "scheduled",
        )
        .filter((item) => !this.activeExecutions.has(item.id))
        .filter((item) => !item.completedAt)
        .map((item) => {
          const dueMs = parseIsoToMs(item.dueAt);
          const effectiveDueMs =
            typeof dueMs === "number" && Number.isFinite(dueMs)
              ? dueMs
              : item.forceNow === true
                ? 0
                : Number.POSITIVE_INFINITY;
          return { item, dueMs: effectiveDueMs };
        })
        .filter((entry) => Number.isFinite(entry.dueMs))
        .sort((a, b) => {
          if (a.item.forceNow !== b.item.forceNow)
            return a.item.forceNow ? -1 : 1;
          if (a.dueMs !== b.dueMs) return a.dueMs - b.dueMs;
          return a.item.createdAt < b.item.createdAt
            ? -1
            : a.item.createdAt > b.item.createdAt
              ? 1
              : 0;
        });

      if (!candidates.length) return;
      const nowMs = Date.now();
      const dueCandidates = candidates
        .filter(
          (candidate) =>
            candidate.item.forceNow === true || candidate.dueMs <= nowMs,
        )
        .slice(0, availableSlots);
      for (const candidate of dueCandidates) {
        const inboxPath = path.join(
          this.ctx.ipcPaths.inboxDir,
          candidate.item.inboxFile,
        );
        const inboxExists = await fs
          .access(inboxPath)
          .then(() => true)
          .catch(() => false);
        if (!inboxExists) {
          await this.markCompleted(
            candidate.item.inboxFile,
            "missing",
            "inbox file missing",
          );
          continue;
        }

        await this.mutateQueueState((current) => {
          const next = { ...current };
          next.items = current.items.map((qi) => {
            if (qi.id !== candidate.item.id) return qi;
            return {
              ...qi,
              status: "running" as const,
              startedAt: nowIso(),
              lastAttemptAt: nowIso(),
              attempts: qi.attempts + 1,
              // Preserve the previous reason while running so retry profiling can
              // still use a meaningful hint if the processor returns "not ready"
              // without writing a more specific lastError.
              lastError: qi.lastError ?? null,
            };
          });
          return next;
        });

        this.activeExecutions.add(candidate.item.id);
        void this.executeCandidate(candidate.item)
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(
              "[agent-runtime] executeCandidate unhandled error (non-fatal)",
              msg,
            );
            void this.markCompleted(
              candidate.item.inboxFile,
              "failed",
              `unhandled_execution_error: ${msg}`,
            ).catch(() => undefined);
          })
          .finally(() => {
            this.activeExecutions.delete(candidate.item.id);
            void this.runnerTick().catch(() => undefined);
          });
      }
    } finally {
      this.ctx.queue.queueRunnerTickInFlight = false;
    }
  }

  async resetQueueOnReconnect(reason: string): Promise<QueueReconnectResetResult> {
    const normalizedReason =
      typeof reason === "string" && reason.trim().length > 0
        ? reason.trim()
        : "reconnect_reset";
    let scanned = 0;
    let cancelled = 0;
    let cancelledQueued = 0;
    let cancelledScheduled = 0;
    let cancelledRunning = 0;
    let skippedTerminal = 0;
    const cancelledInboxFiles = new Set<string>();
    const cancelledAt = nowIso();

    await this.mutateQueueState((current) => {
      const nextItems = current.items.map((item) => {
        scanned += 1;
        const hasCompletedAt =
          typeof item.completedAt === "string" && item.completedAt.trim().length > 0;
        if (hasCompletedAt || TERMINAL_QUEUE_STATUSES.has(item.status)) {
          skippedTerminal += 1;
          return item;
        }
        cancelled += 1;
        if (item.status === "queued") {
          cancelledQueued += 1;
          if (item.inboxFile.trim().length > 0) {
            cancelledInboxFiles.add(item.inboxFile.trim());
          }
        } else if (item.status === "scheduled") {
          cancelledScheduled += 1;
          if (item.inboxFile.trim().length > 0) {
            cancelledInboxFiles.add(item.inboxFile.trim());
          }
        } else if (item.status === "running") {
          cancelledRunning += 1;
        }
        return {
          ...item,
          status: "cancelled" as QueueItem["status"],
          forceNow: false,
          dueAt: null,
          startedAt: null,
          completedAt: cancelledAt,
          lastError: `cancelled_on_reconnect:${normalizedReason}`,
          scheduledBy: "reconnect_reset",
        };
      });
      if (cancelled === 0) return current;
      return {
        ...current,
        items: nextItems,
      };
    });

    let removedInboxFiles = 0;
    for (const inboxFile of cancelledInboxFiles) {
      if (path.basename(inboxFile) !== inboxFile) continue;
      const inboxPath = path.join(this.ctx.ipcPaths.inboxDir, inboxFile);
      const removed = await fs
        .unlink(inboxPath)
        .then(() => true)
        .catch(() => false);
      if (removed) removedInboxFiles += 1;
    }

    const result: QueueReconnectResetResult = {
      scanned,
      cancelled,
      cancelledQueued,
      cancelledScheduled,
      cancelledRunning,
      skippedTerminal,
      removedInboxFiles,
    };
    await this.ctx.memory
      .recordWrite({
        type: "directive_queue_reconnect_reset",
        at: nowIso(),
        reason: normalizedReason,
        ...result,
      })
      .catch(() => undefined);
    return result;
  }

  // -----------------------------------------------------------------------
  // Dispose
  // -----------------------------------------------------------------------

  dispose(): void {
    this.activeExecutions.clear();
  }

  private async recoverAbandonedRunningItems(): Promise<void> {
    const nowMs = Date.now();
    let recovered = 0;
    let failedTerminal = 0;
    await this.mutateQueueState((current) => {
      const nextItems = current.items.map((item) => {
        if (item.status !== "running") return item;
        if (this.activeExecutions.has(item.id)) return item;
        const startedAtMs = parseIsoToMs(item.startedAt);
        const lastAttemptAtMs = parseIsoToMs(item.lastAttemptAt);
        const referenceMs =
          typeof startedAtMs === "number" && Number.isFinite(startedAtMs)
            ? startedAtMs
            : typeof lastAttemptAtMs === "number" && Number.isFinite(lastAttemptAtMs)
              ? lastAttemptAtMs
              : null;
        if (
          typeof referenceMs === "number" &&
          Number.isFinite(referenceMs) &&
          nowMs - referenceMs < RUNNING_RECOVERY_MIN_AGE_MS
        ) {
          return item;
        }
        const attempts =
          typeof item.attempts === "number" &&
          Number.isFinite(item.attempts) &&
          item.attempts > 0
            ? Math.trunc(item.attempts)
            : 1;
        if (attempts >= NOT_READY_MAX_ATTEMPTS) {
          failedTerminal += 1;
          return {
            ...item,
            status: "failed" as QueueItem["status"],
            completedAt: nowIso(),
            startedAt: null,
            lastError: `max_retry_exceeded_during_recovery (${attempts} attempts): ${item.lastError ?? "running_item_abandoned"}`,
          };
        }
        recovered += 1;
        const retryDelaySeconds = computeNotReadyRequeueDelaySeconds(
          attempts,
          item.lastError,
        );
        return {
          ...item,
          status: "scheduled" as QueueItem["status"],
          forceNow: false,
          dueAt: new Date(nowMs + retryDelaySeconds * 1000).toISOString(),
          scheduledBy: "queue_running_recovery",
          startedAt: null,
          lastError: item.lastError ?? "running_item_recovered",
        };
      });
      if (recovered === 0 && failedTerminal === 0) return current;
      return {
        ...current,
        items: nextItems,
      };
    });
    if (recovered > 0 || failedTerminal > 0) {
      await this.ctx.memory.recordWrite({
        type: "directive_queue_running_recovered",
        at: nowIso(),
        recovered,
        failedTerminal,
      });
    }
  }

  private async executeCandidate(item: QueueItem): Promise<void> {
    try {
      await this.ctx
        .runMemoryCheckpoint({
          force: true,
          source: "queue_execution",
          allowAgentCompression: true,
        })
        .catch(() => undefined);

      const processed = await this.ctx.processCommandFile(item.inboxFile, {
        attempts: item.attempts,
        maxAttempts: NOT_READY_MAX_ATTEMPTS,
      });
      if (!processed) {
        let nextAttemptCount = 1;
        let nextDueAt = new Date(Date.now() + 5_000).toISOString();
        let preservedError = "not_ready";
        let exceededMaxAttempts = false;
        await this.mutateQueueState((current) => {
          const next = { ...current };
          next.items = current.items.map((qi) => {
            if (qi.id !== item.id) return qi;
            preservedError =
              typeof qi.lastError === "string" &&
              qi.lastError.trim().length > 0
                ? qi.lastError.trim()
                : "not_ready";
            nextAttemptCount =
              typeof qi.attempts === "number" &&
              Number.isFinite(qi.attempts) &&
              qi.attempts > 0
                ? Math.trunc(qi.attempts)
                : 1;
            if (nextAttemptCount >= NOT_READY_MAX_ATTEMPTS) {
              exceededMaxAttempts = true;
              return {
                ...qi,
                status: "failed" as QueueItem["status"],
                completedAt: nowIso(),
                lastError: `max_retry_exceeded (${nextAttemptCount} attempts): ${preservedError}`,
              };
            }
            const retryDelaySeconds = computeNotReadyRequeueDelaySeconds(
              nextAttemptCount,
              preservedError,
            );
            nextDueAt = new Date(
              Date.now() + retryDelaySeconds * 1000,
            ).toISOString();
            return {
              ...qi,
              status: "scheduled" as QueueItem["status"],
              forceNow: false,
              dueAt: nextDueAt,
              scheduledBy: "queue_not_ready_backoff",
              lastError: preservedError,
            };
          });
          return next;
        });
        if (exceededMaxAttempts) {
          await this.ctx.memory.recordWrite({
            type: "directive_queue_max_retry_exceeded",
            at: nowIso(),
            source: "queue_runner",
            directiveId: item.directiveId,
            inboxFile: item.inboxFile,
            error: preservedError,
            attempts: nextAttemptCount,
          });
          return;
        }
        const nextDueAtMs = parseIsoToMs(nextDueAt);
        const retryInSeconds =
          typeof nextDueAtMs === "number" && Number.isFinite(nextDueAtMs)
            ? Math.max(1, Math.round((nextDueAtMs - Date.now()) / 1000))
            : computeNotReadyRequeueDelaySeconds(nextAttemptCount, preservedError);
        const backoffProfile = resolveNotReadyBackoffProfile(preservedError);
        await this.ctx.memory.recordWrite({
          type: "directive_queue_not_ready_requeued",
          at: nowIso(),
          source: "queue_runner",
          directiveId: item.directiveId,
          inboxFile: item.inboxFile,
          error: preservedError,
          attempts: nextAttemptCount,
          retryInSeconds,
          backoffProfile,
        });
        return;
      }

      await this.ctx.memory.recordWrite({
        type: "directive_queue_executed",
        at: nowIso(),
        source: "queue_runner",
        directiveId: item.directiveId,
        inboxFile: item.inboxFile,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.markCompleted(item.inboxFile, "failed", message);
      await this.ctx.memory.recordWrite({
        type: "directive_queue_execution_failed",
        at: nowIso(),
        source: "queue_runner",
        directiveId: item.directiveId,
        inboxFile: item.inboxFile,
        error: message,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Private: queue state I/O with serialised mutations
  // -----------------------------------------------------------------------

  private async readQueueState(): Promise<QueueState> {
    const raw = await readJsonFile(this.ctx.ipcPaths.queueStatePath);
    return normalizeQueueState(raw);
  }

  private async writeQueueState(state: QueueState): Promise<QueueState> {
    const normalized = normalizeQueueState(state);
    normalized.updatedAt = nowIso();
    await writeJsonFile(this.ctx.ipcPaths.queueStatePath, normalized);
    return normalized;
  }

  private async mutateQueueState(
    mutate: (current: QueueState) => QueueState | Promise<QueueState>,
  ): Promise<QueueState> {
    let resolvedState: QueueState | null = null;
    let mutationErrorMessage: string | null = null;
    this.ctx.queue.queueStateMutation = this.ctx.queue.queueStateMutation
      .then(async () => {
        const current = await this.readQueueState();
        const nextCandidate = await mutate(current);
        if (!nextCandidate || nextCandidate === current) {
          resolvedState = current;
          return;
        }
        const next = normalizeQueueState(nextCandidate ?? current);
        resolvedState = await this.writeQueueState(next);
      })
      .catch((error: unknown) => {
        const mutationError =
          error instanceof Error ? error : new Error(String(error));
        mutationErrorMessage = mutationError.message;
        console.warn(
          "[agent-runtime] queue state mutation failed (non-fatal)",
          mutationError.message,
        );
      });
    await this.ctx.queue.queueStateMutation;
    if (mutationErrorMessage) {
      void this.ctx.memory
        .recordWrite({
          type: "queue_state_mutation_error",
          at: nowIso(),
          error: mutationErrorMessage,
        })
        .catch(() => undefined);
    }
    return resolvedState ?? (await this.readQueueState());
  }

  private async markCompleted(
    inboxFile: string,
    status: string,
    error: string | null,
  ): Promise<void> {
    const normalizedInboxFile =
      typeof inboxFile === "string" ? inboxFile.trim() : "";
    if (!normalizedInboxFile.length) return;
    await this.mutateQueueState((state) => {
      const next = { ...state };
      next.items = state.items.map((qi) => {
        if (qi.inboxFile !== normalizedInboxFile) return qi;
        return {
          ...qi,
          status: status as QueueItem["status"],
          completedAt: nowIso(),
          lastError:
            typeof error === "string" && error.trim().length > 0
              ? error.trim()
              : null,
        };
      });
      return next;
    });
  }

  // -----------------------------------------------------------------------
  // Private: deterministic planning
  // -----------------------------------------------------------------------

  private async planQueueDeterministic(
    reason: string,
  ): Promise<QueueState> {
    const queueConfig = this.ctx.kthxQueueConfig();
    const minSpacingSeconds = Math.max(10, queueConfig.minSpacingSeconds);
    const maxSpacingSeconds = Math.max(
      minSpacingSeconds,
      queueConfig.maxSpacingSeconds,
    );

    let planChanged = false;
    const state = await this.mutateQueueState((current) => {
      const pending = current.items
        .filter(
          (qi) => qi.status === "queued" || qi.status === "scheduled",
        )
        .filter((qi) => !qi.completedAt)
        .sort((a, b) => {
          if (a.forceNow !== b.forceNow) return a.forceNow ? -1 : 1;
          return a.createdAt < b.createdAt
            ? -1
            : a.createdAt > b.createdAt
              ? 1
              : 0;
        });

      const delays = computeDeterministicDelay({
        pendingItems: pending,
        minSpacingSeconds,
        maxSpacingSeconds,
      });

      const nowMs = Date.now();
      const next = { ...current };
      next.items = current.items.map((qi) => ({ ...qi }));
      for (const item of pending) {
        const target = next.items.find((qi) => qi.id === item.id);
        if (!target) continue;
        const dueAtMs =
          typeof target.dueAt === "string" && target.dueAt.trim().length > 0
            ? parseIsoToMs(target.dueAt)
            : null;
        const shouldPreserveNotReadyBackoff =
          target.status === "scheduled" &&
          target.scheduledBy === "queue_not_ready_backoff" &&
          typeof dueAtMs === "number" &&
          Number.isFinite(dueAtMs) &&
          dueAtMs > nowMs;
        const shouldKeepExistingSchedule =
          !shouldPreserveNotReadyBackoff &&
          target.status === "scheduled" &&
          typeof target.dueAt === "string" &&
          target.dueAt.trim().length > 0 &&
          target.scheduledBy === reason;
        if (shouldPreserveNotReadyBackoff || shouldKeepExistingSchedule) {
          continue;
        }
        const delaySeconds = delays.get(item.inboxFile) ?? 0;
        const dueAt = new Date(nowMs + delaySeconds * 1000).toISOString();
        if (
          target.status === "scheduled" &&
          target.dueAt === dueAt &&
          target.scheduledBy === reason
        ) {
          continue;
        }
        target.status = "scheduled";
        target.dueAt = dueAt;
        target.scheduledBy = reason;
        planChanged = true;
      }
      if (!planChanged) {
        return current;
      }
      next.lastPlanAt = nowIso();
      next.lastPlanSource = reason;
      return next;
    });

    if (planChanged) {
      await this.ctx.memory.recordWrite({
        type: "directive_queue_planned",
        at: nowIso(),
        reason,
        itemCount: state.items.length,
      });
    }

    return state;
  }
}
