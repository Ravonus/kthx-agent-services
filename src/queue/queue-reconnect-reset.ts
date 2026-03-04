import fs from "node:fs/promises";
import path from "node:path";

import { nowIso } from "../lib/text.js";
import type { QueueReconnectResetResult } from "../runtime-context.js";
import type { QueueItem, QueueState } from "../types/ipc.js";

export type ResetQueueOnReconnectDeps = {
  mutateQueueState: (
    mutate: (current: QueueState) => QueueState | Promise<QueueState>,
  ) => Promise<QueueState>;
  terminalStatuses: Set<QueueItem["status"]>;
  inboxDir: string;
  recordWrite: (payload: Record<string, unknown>) => Promise<unknown>;
};

export const resetQueueOnReconnect = async (
  deps: ResetQueueOnReconnectDeps,
  reason: string,
): Promise<QueueReconnectResetResult> => {
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

  await deps.mutateQueueState((current) => {
    const nextItems = current.items.map((item) => {
      scanned += 1;
      const hasCompletedAt =
        typeof item.completedAt === "string" && item.completedAt.trim().length > 0;
      if (hasCompletedAt || deps.terminalStatuses.has(item.status)) {
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
    const inboxPath = path.join(deps.inboxDir, inboxFile);
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
  await deps
    .recordWrite({
      type: "directive_queue_reconnect_reset",
      at: nowIso(),
      reason: normalizedReason,
      ...result,
    })
    .catch(() => undefined);

  return result;
};
