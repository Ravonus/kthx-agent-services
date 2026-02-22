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
import { readJsonFile, writeJsonFile } from "../lib/fs.js";
import type { QueueItem, QueueState } from "../types/ipc.js";
import type { QueueManagerLike } from "../runtime-context.js";
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
    opts?: { interactiveRl?: unknown },
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

// ---------------------------------------------------------------------------
// Internal ISO parsing helper
// ---------------------------------------------------------------------------

const parseIsoToMs = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
};

const NOT_READY_MIN_REQUEUE_DELAY_SECONDS = 2;
const NOT_READY_MAX_REQUEUE_DELAY_SECONDS = 300;

const computeNotReadyRequeueDelaySeconds = (attempts: number): number => {
  const normalizedAttempts =
    Number.isFinite(attempts) && attempts > 0 ? Math.trunc(attempts) : 1;
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
              lastError: null,
            };
          });
          return next;
        });

        this.activeExecutions.add(candidate.item.id);
        void this.executeCandidate(candidate.item)
          .catch(() => undefined)
          .finally(() => {
            this.activeExecutions.delete(candidate.item.id);
          });
      }
    } finally {
      this.ctx.queue.queueRunnerTickInFlight = false;
    }
  }

  // -----------------------------------------------------------------------
  // Dispose
  // -----------------------------------------------------------------------

  dispose(): void {
    this.activeExecutions.clear();
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

      const processed = await this.ctx.processCommandFile(item.inboxFile);
      if (!processed) {
        let nextAttemptCount = 1;
        let nextDueAt = new Date(Date.now() + 5_000).toISOString();
        let preservedError = "not_ready";
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
            const retryDelaySeconds = computeNotReadyRequeueDelaySeconds(
              nextAttemptCount,
            );
            nextDueAt = new Date(
              Date.now() + retryDelaySeconds * 1000,
            ).toISOString();
            return {
              ...qi,
              status: "scheduled" as QueueItem["status"],
              dueAt: nextDueAt,
              scheduledBy: "queue_not_ready_backoff",
              lastError: preservedError,
            };
          });
          return next;
        });
        const nextDueAtMs = parseIsoToMs(nextDueAt);
        const retryInSeconds =
          typeof nextDueAtMs === "number" && Number.isFinite(nextDueAtMs)
            ? Math.max(1, Math.round((nextDueAtMs - Date.now()) / 1000))
            : computeNotReadyRequeueDelaySeconds(nextAttemptCount);
        await this.ctx.memory.recordWrite({
          type: "directive_queue_not_ready_requeued",
          at: nowIso(),
          source: "queue_runner",
          directiveId: item.directiveId,
          inboxFile: item.inboxFile,
          error: preservedError,
          attempts: nextAttemptCount,
          retryInSeconds,
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
        console.warn(
          "[agent-runtime] queue state mutation failed (non-fatal)",
          error instanceof Error ? error.message : error,
        );
      });
    await this.ctx.queue.queueStateMutation;
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
        const shouldKeepExistingSchedule =
          target.status === "scheduled" &&
          typeof target.dueAt === "string" &&
          target.dueAt.trim().length > 0 &&
          target.scheduledBy === reason;
        if (shouldKeepExistingSchedule) {
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
