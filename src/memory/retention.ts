/**
 * Retention cleanup: prune active streams and old archives by age.
 *
 * Ported from agent-runtime.mjs lines 1833-1953
 * (pruneStreamByRetention, pruneArchivesByRetention, runRetentionCleanup).
 *
 * Extracted from MemoryStore to keep the store file under 500 lines.
 * These functions operate on a MemoryStore instance passed as `store`.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type {
  ArchiveIndex,
  StreamName,
  StreamPathMap,
  MoodState,
  PruneResult,
  ArchivePruneResult,
  RetentionCleanupResult,
} from "~/types/memory.js";
import type { KthxRetentionConfig } from "~/types/config.js";
import { isRecord } from "~/lib/guards.js";
import { readLastJsonLines, writeJsonLines } from "~/lib/fs-helpers.js";
import { parseMemoryEnvelope, classifyRetentionCategory } from "./extract.js";
import { listArchiveIndexes } from "./archive.js";

export type ArchiveDeleteGuard = (input: {
  stream: StreamName;
  index: ArchiveIndex;
}) => Promise<boolean> | boolean;

// ---------------------------------------------------------------------------
// pruneStreamByRetention
// ---------------------------------------------------------------------------

export const pruneStreamByRetention = async ({
  stream,
  retentionConfig,
  streamPaths,
  tailMaxBytes,
}: {
  stream: StreamName;
  retentionConfig: KthxRetentionConfig;
  streamPaths: StreamPathMap;
  tailMaxBytes: number;
}): Promise<PruneResult> => {
  if (!retentionConfig || retentionConfig.enabled !== true)
    return { pruned: 0, kept: 0, stream };
  const activePath = streamPaths[stream];
  if (!activePath) return { pruned: 0, kept: 0, stream };

  const stat = await fs.stat(activePath).catch(() => null);
  if (!stat || stat.size <= 0) return { pruned: 0, kept: 0, stream };

  const items = await readLastJsonLines({
    filePath: activePath,
    maxLines: 50_000,
    maxBytes: Math.max(tailMaxBytes, 8_000_000),
  });
  if (!items.length) return { pruned: 0, kept: 0, stream };

  const nowMs = Date.now();
  const kept: unknown[] = [];
  let pruned = 0;

  for (const raw of items) {
    const env = parseMemoryEnvelope(raw);
    if (!env) {
      kept.push(raw);
      continue;
    }
    const category = classifyRetentionCategory(env, stream);
    if (!category) {
      kept.push(raw);
      continue;
    }
    const categoryConfig = retentionConfig[
      category as keyof Omit<
        KthxRetentionConfig,
        "enabled" | "intervalMinutes"
      >
    ] as { days: number } | undefined;
    if (!categoryConfig || typeof categoryConfig.days !== "number") {
      kept.push(raw);
      continue;
    }
    const maxAgeMs = categoryConfig.days * 24 * 60 * 60 * 1000;
    const eventMs = Date.parse(env.receivedAt);
    if (!Number.isFinite(eventMs) || nowMs - eventMs > maxAgeMs) {
      pruned += 1;
    } else {
      kept.push(raw);
    }
  }

  if (pruned > 0) {
    await writeJsonLines(activePath, kept);
  }
  return { pruned, kept: kept.length, stream };
};

// ---------------------------------------------------------------------------
// pruneArchivesByRetention
// ---------------------------------------------------------------------------

export const pruneArchivesByRetention = async ({
  stream,
  maxAgeDays,
  stateDir,
  shouldRemove,
}: {
  stream: StreamName;
  maxAgeDays: number;
  stateDir: string;
  shouldRemove?: ArchiveDeleteGuard;
}): Promise<ArchivePruneResult> => {
  if (maxAgeDays <= 0) return { removed: 0, stream };
  const indexes = await listArchiveIndexes({ stateDir, stream });
  if (!indexes.length) return { removed: 0, stream };

  const nowMs = Date.now();
  const cutoffMs = maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const index of indexes) {
    const maxAtMs = index.receivedAtMax
      ? Date.parse(index.receivedAtMax)
      : NaN;
    if (!Number.isFinite(maxAtMs)) continue;
    if (nowMs - maxAtMs <= cutoffMs) continue;
    if (shouldRemove) {
      const allowed = await shouldRemove({ stream, index });
      if (allowed !== true) continue;
    }

    const streamDir = path.join(stateDir, "archive", stream);
    const gzPath = path.join(
      streamDir,
      `${index.archiveBasename}.jsonl.gz`,
    );
    const indexPath = path.join(
      streamDir,
      `${index.archiveBasename}.index.json`,
    );
    await fs.rm(gzPath).catch(() => undefined);
    await fs.rm(indexPath).catch(() => undefined);
    removed += 1;
  }
  return { removed, stream };
};

// ---------------------------------------------------------------------------
// runRetentionCleanup
// ---------------------------------------------------------------------------

export const runRetentionCleanup = async ({
  retentionConfig,
  streamPaths,
  tailMaxBytes,
  stateDir,
  moodState,
  streamRetentionMap,
  archiveDeleteGuard,
  longTermCompactions = 0,
}: {
  retentionConfig: KthxRetentionConfig;
  streamPaths: StreamPathMap;
  tailMaxBytes: number;
  stateDir: string;
  moodState: MoodState;
  streamRetentionMap?: Partial<Record<StreamName, number>>;
  archiveDeleteGuard?: ArchiveDeleteGuard;
  longTermCompactions?: number;
}): Promise<{
  result: RetentionCleanupResult | null;
  moodDirty: boolean;
  updatedMoodState: MoodState;
}> => {
  if (!isRecord(retentionConfig) || retentionConfig.enabled !== true)
    return { result: null, moodDirty: false, updatedMoodState: moodState };

  const effectiveStreamRetentionMap: Record<StreamName, number> = {
    notifications: retentionConfig.notifications?.days ?? 365,
    feed: retentionConfig.posts?.days ?? 365,
    activity: retentionConfig.interactions?.days ?? 365,
    likes: retentionConfig.interactions?.days ?? 365,
    reposts: retentionConfig.interactions?.days ?? 365,
    comments: retentionConfig.interactions?.days ?? 365,
    views: retentionConfig.interactions?.days ?? 365,
    writes: Math.max(
      retentionConfig.commands?.days ?? 365,
      retentionConfig.system?.days ?? 365,
    ),
    errors: retentionConfig.system?.days ?? 365,
    director: retentionConfig.system?.days ?? 365,
    memory_activity: retentionConfig.system?.days ?? 365,
    tags: retentionConfig.posts?.days ?? 365,
    story_replies: retentionConfig.interactions?.days ?? 365,
  };
  if (streamRetentionMap) {
    for (const [stream, days] of Object.entries(streamRetentionMap)) {
      if (!Number.isFinite(days) || days <= 0) continue;
      if (!(stream in effectiveStreamRetentionMap)) continue;
      effectiveStreamRetentionMap[stream as StreamName] = Math.floor(days);
    }
  }

  const activeResults: PruneResult[] = [];
  const archiveResults: ArchivePruneResult[] = [];

  for (const stream of Object.keys(effectiveStreamRetentionMap)) {
    const streamName = stream as StreamName;
    const result = await pruneStreamByRetention({
      stream: streamName,
      retentionConfig,
      streamPaths,
      tailMaxBytes,
    });
    activeResults.push(result);

    const maxDays = effectiveStreamRetentionMap[streamName] ?? 365;
    const archiveResult = await pruneArchivesByRetention({
      stream: streamName,
      maxAgeDays: maxDays,
      stateDir,
      ...(archiveDeleteGuard ? { shouldRemove: archiveDeleteGuard } : {}),
    });
    archiveResults.push(archiveResult);
  }

  const moodMaxDays = retentionConfig.moods?.days ?? 30;
  const moodCutoffMs = Date.now() - moodMaxDays * 24 * 60 * 60 * 1000;
  let moodPruned = 0;
  let moodDirty = false;
  const updatedMoodState = { ...moodState };

  if (Array.isArray(updatedMoodState.recentSignals)) {
    const before = updatedMoodState.recentSignals.length;
    updatedMoodState.recentSignals =
      updatedMoodState.recentSignals.filter((signal) => {
        const atMs = Date.parse(signal?.at);
        return Number.isFinite(atMs) && atMs >= moodCutoffMs;
      });
    moodPruned = before - updatedMoodState.recentSignals.length;
    if (moodPruned > 0) {
      moodDirty = true;
    }
  }

  return {
    result: {
      active: activeResults,
      archives: archiveResults,
      moodSignalsPruned: moodPruned,
      longTermCompactions,
    },
    moodDirty,
    updatedMoodState,
  };
};
