/** Queue item state management and inbox file lifecycle helpers. */

import fs from "node:fs/promises";
import path from "node:path";

import type {
  Command,
  CommandExecutorContext,
  QueueState,
} from "../types.js";
import { nowIso } from "../../lib/text.js";
import { ensureDir, readJsonFile, writeJsonFile } from "../../lib/fs.js";
import { normalizeQueueState } from "../../queue/queue-state.js";

// ---------------------------------------------------------------------------
// markQueueItemNotReadyByInbox
// ---------------------------------------------------------------------------

export async function markQueueItemNotReadyByInbox(
  ctx: CommandExecutorContext,
  inboxFile: string,
  reason: string,
): Promise<void> {
  const normalizedInboxFile = inboxFile.trim();
  if (!normalizedInboxFile.length) return;
  const normalizedReason = reason.trim().length > 0 ? reason.trim() : "not_ready";

  ctx.queue.queueStateMutation = ctx.queue.queueStateMutation
    .then(async () => {
      const raw = await readJsonFile(ctx.ipcPaths.queueStatePath);
      const state = normalizeQueueState(raw);
      const updatedItems = state.items.map((item) => {
        if (item.inboxFile !== normalizedInboxFile) return item;
        return {
          ...item,
          lastError: normalizedReason,
        };
      });
      const next: QueueState = {
        ...state,
        updatedAt: nowIso(),
        items: updatedItems,
      };
      await writeJsonFile(ctx.ipcPaths.queueStatePath, next);
    })
    .catch(() => undefined);

  await ctx.queue.queueStateMutation;
}

// ---------------------------------------------------------------------------
// markQueueItemCompletedByInbox
// ---------------------------------------------------------------------------

export async function markQueueItemCompletedByInbox(
  ctx: CommandExecutorContext,
  inboxFile: string,
  status: "done" | "failed" | "missing",
  error: string | null,
): Promise<void> {
  const normalizedInboxFile = inboxFile.trim();
  if (!normalizedInboxFile.length) return;

  ctx.queue.queueStateMutation = ctx.queue.queueStateMutation
    .then(async () => {
      const raw = await readJsonFile(ctx.ipcPaths.queueStatePath);
      const state = normalizeQueueState(raw);
      const updatedItems = state.items.map((item) => {
        if (item.inboxFile !== normalizedInboxFile) return item;
        return {
          ...item,
          status,
          completedAt: nowIso(),
          lastError:
            typeof error === "string" && error.trim().length > 0
              ? error.trim()
              : null,
        };
      });
      const next: QueueState = {
        ...state,
        updatedAt: nowIso(),
        items: updatedItems,
      };
      await writeJsonFile(ctx.ipcPaths.queueStatePath, next);
    })
    .catch(() => undefined);

  await ctx.queue.queueStateMutation;
}

// ---------------------------------------------------------------------------
// moveInboxFileToProcessed
// ---------------------------------------------------------------------------

export async function moveInboxFileToProcessed(
  processedDir: string,
  filePath: string,
  statusSuffix: "done" | "failed" | "invalid" | "rejected",
): Promise<void> {
  const base = path.basename(filePath);
  const targetName = `${new Date().toISOString().replaceAll(":", "-")}__${statusSuffix}__${base}`;
  const targetPath = path.join(processedDir, targetName);
  await ensureDir(processedDir);
  await fs.rename(filePath, targetPath).catch(async () => {
    const bytes = await fs.readFile(filePath).catch(() => null);
    if (!bytes) return;
    await fs.writeFile(targetPath, bytes).catch(() => undefined);
    await fs.unlink(filePath).catch(() => undefined);
  });
}
