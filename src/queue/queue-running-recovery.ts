import { nowIso } from "../lib/text.js";
import { parseIsoToMs } from "../lib/time.js";
import type { QueueItem, QueueState } from "../types/ipc.js";

export type RecoverAbandonedRunningItemsDeps = {
  activeExecutions: Set<string>;
  runningRecoveryMinAgeMs: number;
  maxAttempts: number;
  computeNotReadyRequeueDelaySeconds: (
    attempts: number,
    reason?: string | null,
  ) => number;
  mutateQueueState: (
    mutate: (current: QueueState) => QueueState | Promise<QueueState>,
  ) => Promise<QueueState>;
  recordWrite: (payload: Record<string, unknown>) => Promise<unknown>;
};

export const recoverAbandonedRunningItems = async (
  deps: RecoverAbandonedRunningItemsDeps,
): Promise<void> => {
  const nowMs = Date.now();
  let recovered = 0;
  let failedTerminal = 0;

  await deps.mutateQueueState((current) => {
    const nextItems = current.items.map((item) => {
      if (item.status !== "running") return item;
      if (deps.activeExecutions.has(item.id)) return item;

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
        nowMs - referenceMs < deps.runningRecoveryMinAgeMs
      ) {
        return item;
      }

      const attempts =
        typeof item.attempts === "number" &&
        Number.isFinite(item.attempts) &&
        item.attempts > 0
          ? Math.trunc(item.attempts)
          : 1;
      if (attempts >= deps.maxAttempts) {
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
      const retryDelaySeconds = deps.computeNotReadyRequeueDelaySeconds(
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
    await deps.recordWrite({
      type: "directive_queue_running_recovered",
      at: nowIso(),
      recovered,
      failedTerminal,
    });
  }
};
