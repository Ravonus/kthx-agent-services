/**
 * Filesystem utility functions.
 *
 * Ported from agent-runtime.mjs lines 1172-1260 (ensureDir, appendJsonLine,
 * readLastJsonLines, readJsonFile, writeJsonFile) and lines 3032-3051
 * (readJsonMaybeIncomplete).
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { JsonReadResult, JsonReadStatus } from "../types/ipc.js";

// ---------------------------------------------------------------------------
// ensureDir
// ---------------------------------------------------------------------------

/** Create a directory (and any missing parents) if it does not already exist. */
export const ensureDir = async (dirPath: string): Promise<void> => {
  await fs.mkdir(dirPath, { recursive: true });
};

// ---------------------------------------------------------------------------
// appendJsonLine
// ---------------------------------------------------------------------------

/**
 * Append a single JSON-stringified line (with trailing newline) to a file,
 * creating parent directories as needed.
 */
export const appendJsonLine = async (
  filePath: string,
  payload: unknown,
): Promise<void> => {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
};

// ---------------------------------------------------------------------------
// readLastJsonLines
// ---------------------------------------------------------------------------

export type ReadLastJsonLinesOptions = {
  filePath: string;
  maxLines: number;
  maxBytes: number;
};

/**
 * Read the last N JSON lines from a JSONL file by seeking to
 * `stat.size - maxBytes` and then taking the final `maxLines` parsed rows.
 */
export const readLastJsonLines = async ({
  filePath,
  maxLines,
  maxBytes,
}: ReadLastJsonLinesOptions): Promise<unknown[]> => {
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
      .filter((value): value is unknown => value !== null);
  } finally {
    await handle.close();
  }
};

// ---------------------------------------------------------------------------
// readJsonFile
// ---------------------------------------------------------------------------

/**
 * Safely read and parse a JSON file. Returns `null` on any filesystem or
 * parse error (ENOENT, invalid JSON, etc.).
 */
export const readJsonFile = async (filePath: string): Promise<unknown> => {
  const raw = await fs.readFile(filePath, "utf8").catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// writeJsonFile
// ---------------------------------------------------------------------------

/**
 * Write a value as pretty-printed JSON, creating parent directories as needed.
 */
export const writeJsonFile = async (
  filePath: string,
  payload: unknown,
): Promise<void> => {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
};

// ---------------------------------------------------------------------------
// writeJsonLines
// ---------------------------------------------------------------------------

/**
 * Overwrite a file with an array of JSON-stringified lines.
 */
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

// ---------------------------------------------------------------------------
// readJsonMaybeIncomplete
// ---------------------------------------------------------------------------

/**
 * Read a JSON file that may still be in the process of being written.
 *
 * Returns a discriminated status:
 *   - `"ok"`        -> successfully parsed
 *   - `"missing"`   -> file does not exist (ENOENT)
 *   - `"not_ready"` -> file is empty or invalid JSON less than 60 s old
 *   - `"invalid"`   -> file contains invalid JSON and is older than 60 s
 */
export const readJsonMaybeIncomplete = async (
  filePath: string,
): Promise<JsonReadResult> => {
  const raw = await fs.readFile(filePath, "utf8").catch((error: unknown) => {
    const code =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as Record<string, unknown>).code === "string"
        ? (error as Record<string, unknown>).code
        : null;
    if (code === "ENOENT") return null;
    throw error;
  });

  if (raw === null) return { status: "missing" as JsonReadStatus, value: null };
  if (!raw.trim().length)
    return { status: "not_ready" as JsonReadStatus, value: null };

  try {
    const parsed: unknown = JSON.parse(raw);
    return { status: "ok" as JsonReadStatus, value: parsed };
  } catch {
    const stat = await fs.stat(filePath).catch(() => null);
    const ageMs = stat ? Date.now() - stat.mtimeMs : 0;
    if (ageMs > 60_000)
      return { status: "invalid" as JsonReadStatus, value: null };
    return { status: "not_ready" as JsonReadStatus, value: null };
  }
};
