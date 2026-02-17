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
  MemoryEnvelope,
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
}: {
  stream: StreamName;
  maxAgeDays: number;
  stateDir: string;
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
}: {
  retentionConfig: KthxRetentionConfig;
  streamPaths: StreamPathMap;
  tailMaxBytes: number;
  stateDir: string;
  moodState: MoodState;
}): Promise<{
  result: RetentionCleanupResult | null;
  moodDirty: boolean;
  updatedMoodState: MoodState;
}> => {
  if (!isRecord(retentionConfig) || retentionConfig.enabled !== true)
    return { result: null, moodDirty: false, updatedMoodState: moodState };

  const streamRetentionMap: Record<string, number> = {
    notifications: retentionConfig.notifications?.days ?? 3,
    feed: retentionConfig.posts?.days ?? 90,
    activity: retentionConfig.interactions?.days ?? 14,
    likes: retentionConfig.interactions?.days ?? 14,
    reposts: retentionConfig.interactions?.days ?? 14,
    comments: retentionConfig.interactions?.days ?? 14,
    views: retentionConfig.interactions?.days ?? 14,
    writes: Math.max(
      retentionConfig.commands?.days ?? 7,
      retentionConfig.system?.days ?? 7,
    ),
    errors: retentionConfig.system?.days ?? 7,
  };

  const activeResults: PruneResult[] = [];
  const archiveResults: ArchivePruneResult[] = [];

  for (const stream of Object.keys(streamRetentionMap)) {
    const result = await pruneStreamByRetention({
      stream: stream as StreamName,
      retentionConfig,
      streamPaths,
      tailMaxBytes,
    });
    activeResults.push(result);

    const maxDays = streamRetentionMap[stream] ?? 7;
    const archiveResult = await pruneArchivesByRetention({
      stream: stream as StreamName,
      maxAgeDays: maxDays,
      stateDir,
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
    },
    moodDirty,
    updatedMoodState,
  };
};
