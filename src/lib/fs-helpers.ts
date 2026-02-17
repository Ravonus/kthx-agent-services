/**
 * File system helper utilities.
 *
 * Ported from agent-runtime.mjs lines 1172-1254.
 */

import fs from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

export const ensureDir = async (dirPath: string): Promise<void> => {
  await fs.mkdir(dirPath, { recursive: true });
};

// ---------------------------------------------------------------------------
// JSON file I/O
// ---------------------------------------------------------------------------

export const readJsonFile = async (filePath: string): Promise<unknown> => {
  const raw = await fs.readFile(filePath, "utf8").catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

export const writeJsonFile = async (
  filePath: string,
  payload: unknown,
): Promise<void> => {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
};

// ---------------------------------------------------------------------------
// JSONL file I/O
// ---------------------------------------------------------------------------

export const appendJsonLine = async (
  filePath: string,
  payload: unknown,
): Promise<void> => {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
};

export const writeJsonLines = async (
  filePath: string,
  rows: unknown[],
): Promise<void> => {
  await ensureDir(path.dirname(filePath));
  const body =
    Array.isArray(rows) && rows.length
      ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
      : "";
  await fs.writeFile(filePath, body, "utf8");
};

/**
 * Read the last N lines of a JSONL file, parsing each as JSON.
 * Reads at most `maxBytes` from the end of the file.
 */
export const readLastJsonLines = async ({
  filePath,
  maxLines,
  maxBytes,
}: {
  filePath: string;
  maxLines: number;
  maxBytes: number;
}): Promise<unknown[]> => {
  const handle = await fs.open(filePath, "r").catch(() => null);
  if (!handle) return [];
  try {
    const stat = await handle.stat();
    if (stat.size <= 0) return [];
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString("utf8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    const tail = lines.slice(-maxLines);
    return tail
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return null;
        }
      })
      .filter((item): item is unknown => item !== null);
  } finally {
    await handle.close();
  }
};
