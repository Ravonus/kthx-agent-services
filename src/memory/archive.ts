/**
 * Archive management: gzip, index, rotate, list, read, and weighted pick.
 *
 * Ported from agent-runtime.mjs lines 1329-1656.
 */

import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline";
import { createGzip, createGunzip } from "node:zlib";

import type { ArchiveIndex, MemoryEnvelope } from "~/types/memory.js";
import { isRecord } from "~/lib/guards.js";
import { ensureDir, readJsonFile, writeJsonFile } from "~/lib/fs-helpers.js";
import { nowIso } from "~/lib/time.js";
import { parseMemoryEnvelope, extractKeysFromPayload } from "./extract.js";

// ---------------------------------------------------------------------------
// gzipFile
// ---------------------------------------------------------------------------

export const gzipFile = async ({
  srcPath,
  destPath,
}: {
  srcPath: string;
  destPath: string;
}): Promise<void> => {
  await ensureDir(path.dirname(destPath));
  await pipeline(
    createReadStream(srcPath),
    createGzip({ level: 6 }),
    createWriteStream(destPath),
  );
};

// ---------------------------------------------------------------------------
// buildArchiveIndex
// ---------------------------------------------------------------------------

export const buildArchiveIndex = async ({
  stream,
  archiveBasename,
  jsonlPath,
}: {
  stream: string;
  archiveBasename: string;
  jsonlPath: string;
}): Promise<ArchiveIndex> => {
  const types = new Map<string, number>();
  const postIds = new Set<number>();
  const commentIds = new Set<number>();
  let receivedAtMin: string | null = null;
  let receivedAtMax: string | null = null;
  let eventCount = 0;

  const rl = createInterface({
    input: createReadStream(jsonlPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed.length) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const env = parseMemoryEnvelope(parsed);
    if (!env) continue;
    eventCount += 1;

    if (receivedAtMin === null || env.receivedAt < receivedAtMin) {
      receivedAtMin = env.receivedAt;
    }
    if (receivedAtMax === null || env.receivedAt > receivedAtMax) {
      receivedAtMax = env.receivedAt;
    }

    const keys = extractKeysFromPayload(env.payload);
    if (keys.type) types.set(keys.type, (types.get(keys.type) ?? 0) + 1);
    if (keys.postId) postIds.add(keys.postId);
    if (keys.commentId) commentIds.add(keys.commentId);
  }

  const typesObj: Record<string, number> = {};
  Array.from(types.entries()).forEach(([key, value]) => {
    typesObj[key] = value;
  });

  return {
    version: 1,
    stream,
    archiveBasename,
    createdAt: nowIso(),
    receivedAtMin,
    receivedAtMax,
    eventCount,
    postIds: Array.from(postIds).sort((a, b) => a - b),
    commentIds: Array.from(commentIds).sort((a, b) => a - b),
    types: typesObj,
  };
};

// ---------------------------------------------------------------------------
// archiveBasename (timestamp-based)
// ---------------------------------------------------------------------------

export const createArchiveBasename = (): string =>
  nowIso().replace(/[:.]/gu, "-");

// ---------------------------------------------------------------------------
// archiveJsonl
// ---------------------------------------------------------------------------

export const archiveJsonl = async ({
  stream,
  stateDir,
  activePath,
  archiveBasename: basename,
}: {
  stream: string;
  stateDir: string;
  activePath: string;
  archiveBasename: string;
}): Promise<{ gzPath: string; indexPath: string } | null> => {
  const stat = await fs.stat(activePath).catch(() => null);
  if (!stat || stat.size <= 0) return null;

  const streamDir = path.join(stateDir, "archive", stream);
  await ensureDir(streamDir);

  const jsonlPath = path.join(streamDir, `${basename}.jsonl`);
  const gzPath = path.join(streamDir, `${basename}.jsonl.gz`);
  const indexPath = path.join(streamDir, `${basename}.index.json`);

  await fs.rename(activePath, jsonlPath);
  await fs.writeFile(activePath, "", "utf8");

  const index = await buildArchiveIndex({
    stream,
    archiveBasename: basename,
    jsonlPath,
  });
  await writeJsonFile(indexPath, index);

  await gzipFile({ srcPath: jsonlPath, destPath: gzPath });
  await fs.rm(jsonlPath).catch(() => {
    /* best-effort */
  });

  return { gzPath, indexPath };
};

// ---------------------------------------------------------------------------
// listArchiveIndexes
// ---------------------------------------------------------------------------

export const listArchiveIndexes = async ({
  stateDir,
  stream,
}: {
  stateDir: string;
  stream: string;
}): Promise<ArchiveIndex[]> => {
  const streamDir = path.join(stateDir, "archive", stream);
  const entries = await fs.readdir(streamDir).catch(() => []);
  const indexFiles = entries
    .filter((name) => name.endsWith(".index.json"))
    .map((name) => path.join(streamDir, name));

  const indexes: ArchiveIndex[] = [];
  for (const filePath of indexFiles) {
    const parsed = await readJsonFile(filePath);
    if (!isRecord(parsed) || parsed.version !== 1) continue;
    if (parsed.stream !== stream) continue;
    indexes.push(parsed as ArchiveIndex);
  }

  indexes.sort((a, b) => {
    const aMax = a.receivedAtMax ?? "";
    const bMax = b.receivedAtMax ?? "";
    return aMax < bMax ? 1 : aMax > bMax ? -1 : 0;
  });
  return indexes;
};

// ---------------------------------------------------------------------------
// findArchiveGzPath
// ---------------------------------------------------------------------------

export const findArchiveGzPath = ({
  stateDir,
  stream,
  archiveBasename,
}: {
  stateDir: string;
  stream: string;
  archiveBasename: string;
}): string =>
  path.join(stateDir, "archive", stream, `${archiveBasename}.jsonl.gz`);

// ---------------------------------------------------------------------------
// readEventsFromGzArchive
// ---------------------------------------------------------------------------

export const readEventsFromGzArchive = async ({
  gzPath,
  filter,
  maxEvents,
}: {
  gzPath: string;
  filter: (env: MemoryEnvelope) => boolean;
  maxEvents: number;
}): Promise<MemoryEnvelope[]> => {
  const handle = await fs.open(gzPath, "r").catch(() => null);
  if (!handle) return [];
  await handle.close();

  const stream = createReadStream(gzPath).pipe(createGunzip());
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const results: MemoryEnvelope[] = [];
  for await (const line of rl) {
    if (results.length >= maxEvents) break;
    const trimmed = line.trim();
    if (!trimmed.length) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const env = parseMemoryEnvelope(parsed);
    if (!env) continue;
    if (!filter(env)) continue;
    results.push(env);
  }
  return results;
};

// ---------------------------------------------------------------------------
// pickWeightedArchiveBasenames
// ---------------------------------------------------------------------------

export const pickWeightedArchiveBasenames = (
  indexes: ArchiveIndex[],
  maxPicks: number,
): string[] => {
  if (!indexes.length || maxPicks <= 0) return [];
  const nowMs = Date.now();

  const weights = indexes.map((index) => {
    const maxAt = index.receivedAtMax
      ? Date.parse(index.receivedAtMax)
      : NaN;
    const ageDays = Number.isFinite(maxAt)
      ? Math.max(0, (nowMs - maxAt) / (1000 * 60 * 60 * 24))
      : 999;
    const recency = 1 / (1 + ageDays);
    const activity = Math.log(1 + Math.max(0, index.eventCount ?? 0));
    return Math.max(0, recency * (0.6 + 0.4 * activity));
  });

  const picks: string[] = [];
  const remaining = indexes.map((index, i) => ({
    index,
    weight: weights[i] ?? 0,
  }));

  while (picks.length < maxPicks && remaining.length) {
    const total = remaining.reduce((sum, item) => sum + item.weight, 0);
    const threshold = Math.random() * (total || remaining.length);
    let acc = 0;
    const first = remaining[0];
    if (!first) break;
    let chosen = first;
    for (const item of remaining) {
      acc += total ? item.weight : 1;
      if (acc >= threshold) {
        chosen = item;
        break;
      }
    }
    picks.push(chosen.index.archiveBasename);
    const idx = remaining.findIndex(
      (item) =>
        item.index.archiveBasename === chosen.index.archiveBasename,
    );
    if (idx >= 0) remaining.splice(idx, 1);
  }

  return picks;
};
