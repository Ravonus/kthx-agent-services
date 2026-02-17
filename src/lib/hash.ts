/**
 * Runtime hash collection utilities.
 *
 * Ported from agent-runtime.mjs lines 90-268.
 *
 * Used to compute a deterministic manifest of the agent runtime directory
 * so the server can verify the runtime has not been tampered with.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { normalizePathSlashes, normalizeHexDigest, nowIso } from "./text.js";

// ---------------------------------------------------------------------------
// Default sets
// ---------------------------------------------------------------------------

export const RUNTIME_HASH_DEFAULT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".mjs",
  ".js",
  ".cjs",
  ".json",
  ".md",
  ".ps1",
  ".sh",
]);

export const RUNTIME_HASH_DEFAULT_IGNORED_SEGMENTS: ReadonlySet<string> =
  new Set([".git", "node_modules", "state", "tmp", "temp", "logs"]);

// ---------------------------------------------------------------------------
// parseRuntimeHashExtensions
// ---------------------------------------------------------------------------

/**
 * Parse a user-supplied list of file extensions (from env CSV) into a Set.
 * Falls back to `RUNTIME_HASH_DEFAULT_EXTENSIONS` when the input is empty
 * or produces no valid entries.
 */
export const parseRuntimeHashExtensions = (
  rawValues: unknown,
): Set<string> => {
  const values = Array.isArray(rawValues) ? rawValues : [];
  if (!values.length) return new Set(RUNTIME_HASH_DEFAULT_EXTENSIONS);
  const normalized = (values as unknown[])
    .filter((v): v is string => typeof v === "string")
    .map((value) => value.trim().toLowerCase())
    .map((value) => (value.startsWith(".") ? value : `.${value}`))
    .filter((value) => /^[.a-z0-9_-]{2,16}$/u.test(value));
  return normalized.length
    ? new Set(normalized)
    : new Set(RUNTIME_HASH_DEFAULT_EXTENSIONS);
};

// ---------------------------------------------------------------------------
// isIgnoredHashPath
// ---------------------------------------------------------------------------

/**
 * Return `true` if any path segment belongs to the ignored set
 * (e.g. `node_modules`, `.git`).
 */
export const isIgnoredHashPath = (
  candidatePath: string,
  ignoredSegments: ReadonlySet<string>,
): boolean => {
  if (!candidatePath || !ignoredSegments || !ignoredSegments.size) return false;
  const normalized = normalizePathSlashes(candidatePath).toLowerCase();
  if (!normalized.length) return false;
  const segments = normalized.split("/").filter(Boolean);
  return segments.some((segment) => ignoredSegments.has(segment));
};

// ---------------------------------------------------------------------------
// toManifestPath
// ---------------------------------------------------------------------------

/**
 * Convert an absolute file path to a manifest-relative path using forward
 * slashes. Falls back to the absolute path (normalised) when the file is
 * outside `rootDir`.
 */
export const toManifestPath = (filePath: string, rootDir: string): string => {
  const absolute = path.resolve(filePath);
  const root = path.resolve(rootDir);
  const relative = normalizePathSlashes(path.relative(root, absolute));
  if (relative.length && !relative.startsWith("..")) {
    return relative;
  }
  return normalizePathSlashes(absolute);
};

// ---------------------------------------------------------------------------
// collectHashCandidateFiles
// ---------------------------------------------------------------------------

export type CollectHashOptions = {
  rootDir: string;
  extensions: ReadonlySet<string>;
  ignoredSegments: ReadonlySet<string>;
  maxFiles: number;
};

/**
 * Recursively walk `rootDir`, collecting file paths whose extensions match
 * the allowed set and whose path segments are not in the ignored set.
 * Files are sorted alphabetically within each directory and the total count
 * is capped at `maxFiles`.
 */
export const collectHashCandidateFiles = async ({
  rootDir,
  extensions,
  ignoredSegments,
  maxFiles,
}: CollectHashOptions): Promise<string[]> => {
  const resolvedRoot = path.resolve(rootDir);
  const files: string[] = [];

  const walk = async (dirPath: string): Promise<void> => {
    if (files.length >= maxFiles) return;
    if (isIgnoredHashPath(dirPath, ignoredSegments)) return;
    const entries = await fs
      .readdir(dirPath, { withFileTypes: true })
      .catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (!isIgnoredHashPath(entryPath, ignoredSegments)) {
          await walk(entryPath);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.size > 0 && !extensions.has(ext)) continue;
      files.push(entryPath);
    }
  };

  await walk(resolvedRoot);
  return files;
};

// ---------------------------------------------------------------------------
// File hash entry
// ---------------------------------------------------------------------------

export type FileHashEntry = {
  absolutePath: string;
  path: string;
  md5: string;
  sha256: string;
  bytes: number;
};

export type ManifestFileEntry = {
  path: string;
  md5: string;
  sha256: string;
  bytes: number;
};

export type RuntimeHashManifest = {
  runtimePath: string;
  runtimeMd5: string;
  runtimeSha256: string;
  manifestMd5: string;
  manifestSha256: string;
  generatedAt: string;
  files: ManifestFileEntry[];
};

// ---------------------------------------------------------------------------
// createRuntimeHashCollector
// ---------------------------------------------------------------------------

export type RuntimeHashCollectorOptions = {
  runtimeFilePath: string;
  rootDir: string;
  maxFiles: number;
  extensions: ReadonlySet<string>;
};

type HashCacheEntry = {
  size: number;
  mtimeMs: number;
  md5: string;
  sha256: string;
};

/**
 * Create a closure that, when called, walks the runtime directory and
 * produces a deterministic manifest of file hashes.
 *
 * File hashes are cached by (size, mtime) so that unchanged files are not
 * re-read on subsequent invocations.
 */
export const createRuntimeHashCollector = ({
  runtimeFilePath,
  rootDir,
  maxFiles,
  extensions,
}: RuntimeHashCollectorOptions): (() => Promise<RuntimeHashManifest | null>) => {
  const hashCache = new Map<string, HashCacheEntry>();
  const resolvedRuntimeFilePath = path.resolve(runtimeFilePath);
  const resolvedRootDir = path.resolve(rootDir);

  const hashFile = async (
    filePath: string,
  ): Promise<HashCacheEntry | null> => {
    const resolvedPath = path.resolve(filePath);
    const stat = await fs.stat(resolvedPath).catch(() => null);
    if (!stat || !stat.isFile()) return null;
    const cached = hashCache.get(resolvedPath);
    if (
      cached &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs
    ) {
      return cached;
    }
    const content = await fs.readFile(resolvedPath);
    const next: HashCacheEntry = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      md5: crypto.createHash("md5").update(content).digest("hex"),
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    };
    hashCache.set(resolvedPath, next);
    return next;
  };

  return async (): Promise<RuntimeHashManifest | null> => {
    const candidates = await collectHashCandidateFiles({
      rootDir: resolvedRootDir,
      extensions,
      ignoredSegments: RUNTIME_HASH_DEFAULT_IGNORED_SEGMENTS,
      maxFiles: Math.max(1, maxFiles),
    });
    if (!candidates.includes(resolvedRuntimeFilePath)) {
      candidates.unshift(resolvedRuntimeFilePath);
    }
    const uniqueCandidates = Array.from(
      new Set(candidates.map((value) => path.resolve(value))),
    ).slice(0, Math.max(1, maxFiles));

    const fileEntries: FileHashEntry[] = [];
    for (const filePath of uniqueCandidates) {
      const hashed = await hashFile(filePath).catch(() => null);
      if (!hashed) continue;
      const md5 = normalizeHexDigest(hashed.md5);
      const sha256 = normalizeHexDigest(hashed.sha256);
      if (!md5 || !sha256) continue;
      fileEntries.push({
        absolutePath: path.resolve(filePath),
        path: toManifestPath(filePath, resolvedRootDir),
        md5,
        sha256,
        bytes: Math.max(0, Math.floor(hashed.size)),
      });
    }

    if (!fileEntries.length) {
      return null;
    }

    fileEntries.sort((a, b) => a.path.localeCompare(b.path));

    const runtimeEntry =
      fileEntries.find(
        (entry) => entry.absolutePath === resolvedRuntimeFilePath,
      ) ??
      fileEntries.find((entry) =>
        normalizePathSlashes(entry.path).endsWith("/agent-runtime.mjs"),
      ) ??
      fileEntries[0];
    if (!runtimeEntry) return null;

    const manifestPayload: ManifestFileEntry[] = fileEntries.map((entry) => ({
      path: entry.path,
      md5: entry.md5,
      sha256: entry.sha256,
      bytes: entry.bytes,
    }));
    const manifestRaw = JSON.stringify(manifestPayload);
    const manifestMd5 = crypto
      .createHash("md5")
      .update(manifestRaw)
      .digest("hex");
    const manifestSha256 = crypto
      .createHash("sha256")
      .update(manifestRaw)
      .digest("hex");

    return {
      runtimePath: runtimeEntry.path,
      runtimeMd5: runtimeEntry.md5,
      runtimeSha256: runtimeEntry.sha256,
      manifestMd5,
      manifestSha256,
      generatedAt: nowIso(),
      files: manifestPayload,
    };
  };
};
