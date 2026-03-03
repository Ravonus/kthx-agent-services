/** Media source resolution — extracting, resolving, retrying, and materializing media references. */

import fs from "node:fs/promises";
import path from "node:path";

import {
  asNonEmptyString,
  isHttpUrl,
  isDataUri,
  toUnknownArray,
  parseDataUriPayload,
  inferMimeTypeFromUrl,
  extToMime,
  mimeToExt,
} from "../helpers.js";

import {
  isStreamPartArtifactReference,
  resolveLocalReferencePath,
  isTerminalMediaGeneratorStatus,
  findFirstMediaFile,
} from "./media-curation.js";

import { isUploadableMediaMimeType } from "../persona/persona-resolution.js";

import { MAX_MEDIA_REFERENCE_INPUTS } from "../constants.js";

import { isRecord } from "../../lib/guards.js";
import { parseJsonFromMixedText } from "../../lib/parsing.js";
import { sleep } from "../../lib/async.js";
import { ensureDir } from "../../lib/fs.js";

// ---------------------------------------------------------------------------
// extractMediaSourceFromParsedOutput
// ---------------------------------------------------------------------------

export function extractMediaSourceFromParsedOutput(
  parsed: unknown,
  requestDir: string,
  options?: {
    requireFinalStreamFrame?: boolean;
  },
): string | null {
  const requireFinalStreamFrame = options?.requireFinalStreamFrame === true;
  const resolveCandidate = (
    value: unknown,
    opts?: {
      allowStreamPart?: boolean;
    },
  ): string | null => {
    const candidate = asNonEmptyString(value);
    if (!candidate) return null;
    const allowStreamPart = opts?.allowStreamPart === true;
    if (!allowStreamPart && isStreamPartArtifactReference(candidate)) return null;
    if (isDataUri(candidate)) {
      const parsed = parseDataUriPayload(candidate);
      if (!parsed || !isUploadableMediaMimeType(parsed.mime)) {
        return null;
      }
      return candidate;
    }
    if (isHttpUrl(candidate)) {
      const inferredMime = inferMimeTypeFromUrl(candidate);
      if (
        inferredMime &&
        inferredMime !== "application/octet-stream" &&
        !isUploadableMediaMimeType(inferredMime)
      ) {
        return null;
      }
      return candidate;
    }
    const absolute = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(requestDir, candidate);
    const inferredMime = extToMime(absolute);
    if (
      inferredMime !== "application/octet-stream" &&
      !isUploadableMediaMimeType(inferredMime)
    ) {
      return null;
    }
    if (!allowStreamPart && isStreamPartArtifactReference(absolute)) return null;
    return absolute;
  };
  const scanArtifactArray = (value: unknown): string | null => {
    const items = toUnknownArray(value);
    if (items.length === 0) return null;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const entry = items[i];
      const direct = resolveCandidate(entry);
      if (direct) return direct;
      if (!isRecord(entry)) continue;
      const resolved = resolveCandidate(
        asNonEmptyString(entry.outputPath) ??
          asNonEmptyString(entry.savedOutputPath) ??
          asNonEmptyString(entry.path) ??
          asNonEmptyString(entry.lastOutputPath) ??
          asNonEmptyString(entry.lastOutputFile) ??
          asNonEmptyString(entry.latestOutputPath) ??
          asNonEmptyString(entry.latestOutputFile) ??
          asNonEmptyString(entry.fileUrl) ??
          asNonEmptyString(entry.mediaUrl) ??
          asNonEmptyString(entry.outputUrl) ??
          asNonEmptyString(entry.downloadUrl) ??
          asNonEmptyString(entry.resolvedUrl) ??
          asNonEmptyString(entry.url),
      );
      if (resolved) return resolved;
    }
    return null;
  };
  const arrayKeys = [
    "savedFiles",
    "observedOutputFiles",
    "files",
    "outputFiles",
  ];
  const hasStableArtifactArrays = (value: Record<string, unknown>): boolean => {
    for (const key of arrayKeys) {
      if (scanArtifactArray(value[key])) {
        return true;
      }
    }
    return false;
  };

  const hasTerminalStatus = (value: unknown): boolean =>
    isRecord(value) &&
    isTerminalMediaGeneratorStatus(asNonEmptyString(value.status));

  const resolveFromStreamEvents = (
    value: unknown,
  ): {
    resolved: string | null;
    hasEvents: boolean;
    hasFinalStreamFrame: boolean;
  } => {
    const events = toUnknownArray(value);
    if (events.length === 0) {
      return {
        resolved: null,
        hasEvents: false,
        hasFinalStreamFrame: false,
      };
    }
    const resolveFromEntry = (
      entry: Record<string, unknown>,
    ): {
      resolved: string | null;
      finalFramePreview: string | null;
      finalFrameRelaxed: string | null;
      isFinalStreamFrame: boolean;
    } => {
      const sourceFileName =
        asNonEmptyString(entry.sourceFileName) ??
        asNonEmptyString(entry.file_name);
      const isStreamPartFromName =
        sourceFileName !== null && isStreamPartArtifactReference(sourceFileName);
      const hasExplicitFinalStreamFrameFlag =
        entry.isFinalStreamFrame === true || entry.streamIsFinalFrame === true;
      const isFinalStreamFrame =
        hasExplicitFinalStreamFrameFlag ||
        (sourceFileName !== null && !isStreamPartFromName);
      const artifactCandidates: unknown[] = [
        entry.outputPath,
        entry.savedOutputPath,
        entry.path,
        entry.lastOutputPath,
        entry.lastOutputFile,
        entry.fileUrl,
        entry.mediaUrl,
        entry.outputUrl,
        entry.downloadUrl,
      ];
      for (const candidate of artifactCandidates) {
        const resolved = resolveCandidate(candidate);
        if (resolved) {
          return {
            resolved,
            finalFramePreview: null,
            finalFrameRelaxed: null,
            isFinalStreamFrame,
          };
        }
      }
      const finalFramePreviewCandidates: unknown[] =
        isFinalStreamFrame
          ? [
              entry.previewUrl,
              entry.resolvedUrl,
              entry.url,
              entry.dataUri,
            ]
          : [];
      for (const candidate of finalFramePreviewCandidates) {
        const resolved = resolveCandidate(candidate);
        if (resolved) {
          return {
            resolved: null,
            finalFramePreview: resolved,
            finalFrameRelaxed: null,
            isFinalStreamFrame,
          };
        }
      }
      if (requireFinalStreamFrame && hasExplicitFinalStreamFrameFlag) {
        for (const candidate of artifactCandidates) {
          const resolved = resolveCandidate(candidate, { allowStreamPart: true });
          if (resolved) {
            return {
              resolved: null,
              finalFramePreview: null,
              finalFrameRelaxed: resolved,
              isFinalStreamFrame,
            };
          }
        }
        for (const candidate of finalFramePreviewCandidates) {
          const resolved = resolveCandidate(candidate, { allowStreamPart: true });
          if (resolved) {
            return {
              resolved: null,
              finalFramePreview: null,
              finalFrameRelaxed: resolved,
              isFinalStreamFrame,
            };
          }
        }
      }
      return {
        resolved: null,
        finalFramePreview: null,
        finalFrameRelaxed: null,
        isFinalStreamFrame,
      };
    };
    let hasFinalStreamFrame = false;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const entry = events[i];
      if (!isRecord(entry)) continue;
      const resolved = resolveFromEntry(entry);
      if (resolved.isFinalStreamFrame) {
        hasFinalStreamFrame = true;
      }
      if (resolved.isFinalStreamFrame && resolved.resolved) {
        return {
          resolved: resolved.resolved,
          hasEvents: true,
          hasFinalStreamFrame,
        };
      }
      if (resolved.isFinalStreamFrame && resolved.finalFramePreview) {
        return {
          resolved: resolved.finalFramePreview,
          hasEvents: true,
          hasFinalStreamFrame,
        };
      }
      if (resolved.isFinalStreamFrame && resolved.finalFrameRelaxed) {
        return {
          resolved: resolved.finalFrameRelaxed,
          hasEvents: true,
          hasFinalStreamFrame,
        };
      }
    }
    if (requireFinalStreamFrame) {
      return {
        resolved: null,
        hasEvents: true,
        hasFinalStreamFrame,
      };
    }
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const entry = events[i];
      if (!isRecord(entry)) continue;
      const resolved = resolveFromEntry(entry);
      if (resolved.isFinalStreamFrame) {
        hasFinalStreamFrame = true;
      }
      if (resolved.resolved) {
        if (!resolved.isFinalStreamFrame && isHttpUrl(resolved.resolved)) {
          continue;
        }
        return {
          resolved: resolved.resolved,
          hasEvents: true,
          hasFinalStreamFrame,
        };
      }
    }
    return {
      resolved: null,
      hasEvents: true,
      hasFinalStreamFrame,
    };
  };

  if (!isRecord(parsed)) return null;
  const streamResolved = resolveFromStreamEvents(parsed.streamEvents);
  if (streamResolved.resolved) return streamResolved.resolved;
  const rootTerminalStatus = hasTerminalStatus(parsed);
  const parsedContext = isRecord(parsed.context) ? parsed.context : null;
  const hasStableRootArtifactArrays = hasStableArtifactArrays(parsed);
  const allowTopLevelFallback =
    !requireFinalStreamFrame ||
    !streamResolved.hasEvents ||
    streamResolved.hasFinalStreamFrame ||
    rootTerminalStatus ||
    hasTerminalStatus(parsedContext) ||
    hasStableRootArtifactArrays;
  const urlKeys = [
    "lastOutputPath",
    "latestOutputPath",
    "lastOutputFile",
    "latestOutputFile",
    "finalOutputPath",
    "finalOutputFile",
    "outputPath",
    "savedOutputPath",
    "savedPath",
    "url",
    "resolvedUrl",
    "mediaUrl",
    "outputUrl",
    "fileUrl",
    "downloadUrl",
    "imageUrl",
  ];
  if (allowTopLevelFallback) {
    for (const key of arrayKeys) {
      const resolved = scanArtifactArray(parsed[key]);
      if (resolved) return resolved;
    }
    for (const key of urlKeys) {
      const resolved = resolveCandidate(parsed[key]);
      if (resolved) return resolved;
    }
  }

  const context = parsedContext;
  if (context) {
    const contextStreamResolved = resolveFromStreamEvents(context.streamEvents);
    if (contextStreamResolved.resolved) return contextStreamResolved.resolved;
    const contextTerminalStatus = hasTerminalStatus(context);
    const hasStableContextArtifactArrays = hasStableArtifactArrays(context);
    const allowContextFallback =
      !requireFinalStreamFrame ||
      !contextStreamResolved.hasEvents ||
      contextStreamResolved.hasFinalStreamFrame ||
      contextTerminalStatus ||
      hasStableContextArtifactArrays;
    if (allowContextFallback) {
      for (const key of arrayKeys) {
        const resolved = scanArtifactArray(context[key]);
        if (resolved) return resolved;
      }
    }
    const keepAlive =
      allowContextFallback && isRecord(context.keepAlive) ? context.keepAlive : null;
    if (allowContextFallback && keepAlive) {
      for (const key of urlKeys) {
        const resolved = resolveCandidate(keepAlive[key]);
        if (resolved) return resolved;
      }
    }
    if (allowContextFallback) {
      for (const key of urlKeys) {
        const resolved = resolveCandidate(context[key]);
        if (resolved) return resolved;
      }
    }
  }

  if (Array.isArray(parsed.runs)) {
    for (const run of parsed.runs) {
      if (!isRecord(run)) continue;
      const runStreamResolved = resolveFromStreamEvents(run.streamEvents);
      if (runStreamResolved.resolved) return runStreamResolved.resolved;
      const runTerminalStatus = hasTerminalStatus(run);
      const hasStableRunArtifactArrays = hasStableArtifactArrays(run);
      const allowRunFallback =
        !requireFinalStreamFrame ||
        !runStreamResolved.hasEvents ||
        runStreamResolved.hasFinalStreamFrame ||
        runTerminalStatus ||
        hasStableRunArtifactArrays;
      if (allowRunFallback) {
        for (const key of arrayKeys) {
          const resolved = scanArtifactArray(run[key]);
          if (resolved) return resolved;
        }
        for (const key of urlKeys) {
          const resolved = resolveCandidate(run[key]);
          if (resolved) return resolved;
        }
      }
      const runContext = isRecord(run.context) ? run.context : null;
      if (runContext) {
        const runContextStreamResolved = resolveFromStreamEvents(runContext.streamEvents);
        if (runContextStreamResolved.resolved) return runContextStreamResolved.resolved;
        const runContextTerminalStatus = hasTerminalStatus(runContext);
        const hasStableRunContextArtifactArrays = hasStableArtifactArrays(runContext);
        const allowRunContextFallback =
          !requireFinalStreamFrame ||
          !runContextStreamResolved.hasEvents ||
          runContextStreamResolved.hasFinalStreamFrame ||
          runContextTerminalStatus ||
          hasStableRunContextArtifactArrays;
        if (allowRunContextFallback) {
          for (const key of arrayKeys) {
            const resolved = scanArtifactArray(runContext[key]);
            if (resolved) return resolved;
          }
        }
        const runKeepAlive = isRecord(runContext.keepAlive)
          ? runContext.keepAlive
          : null;
        if (allowRunContextFallback && runKeepAlive) {
          for (const key of urlKeys) {
            const resolved = resolveCandidate(runKeepAlive[key]);
            if (resolved) return resolved;
          }
        }
        if (allowRunContextFallback) {
          for (const key of urlKeys) {
            const resolved = resolveCandidate(runContext[key]);
            if (resolved) return resolved;
          }
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// resolveGeneratedMediaSource
// ---------------------------------------------------------------------------

export async function resolveGeneratedMediaSource(input: {
  requestDir: string;
  outputPath: string;
  stdout: string;
  requireFinalStreamFrame: boolean;
}): Promise<string | null> {
  const outputExists = await fs
    .access(input.outputPath)
    .then(() => true)
    .catch(() => false);
  if (outputExists) return input.outputPath;

  const parsed = parseJsonFromMixedText(input.stdout);
  const fromParsed = extractMediaSourceFromParsedOutput(
    parsed,
    input.requestDir,
    {
      requireFinalStreamFrame: input.requireFinalStreamFrame,
    },
  );
  if (fromParsed) return fromParsed;

  const discovered = await findFirstMediaFile(input.requestDir, 3);
  if (discovered) return discovered;
  return null;
}

// ---------------------------------------------------------------------------
// resolveGeneratedMediaSourceWithRetry
// ---------------------------------------------------------------------------

export async function resolveGeneratedMediaSourceWithRetry(input: {
  requestDir: string;
  outputPath: string;
  stdout: string;
  maxWaitMs: number;
  requireFinalStreamFrame?: boolean;
}): Promise<string | null> {
  const deadlineMs = Date.now() + Math.max(0, Math.floor(input.maxWaitMs));
  let lastMissingStableCandidate: string | null = null;
  do {
    const candidate = await resolveGeneratedMediaSource({
      requestDir: input.requestDir,
      outputPath: input.outputPath,
      stdout: input.stdout,
      requireFinalStreamFrame: input.requireFinalStreamFrame === true,
    });
    if (candidate) {
      if (isHttpUrl(candidate) || isDataUri(candidate)) {
        if (!isStreamPartArtifactReference(candidate)) {
          return candidate;
        }
      } else {
        const absolute = path.isAbsolute(candidate)
          ? candidate
          : path.resolve(input.requestDir, candidate);
        if (!isStreamPartArtifactReference(absolute)) {
          const exists = await fs
            .access(absolute)
            .then(() => true)
            .catch(() => false);
          if (exists) {
            return absolute;
          }
          lastMissingStableCandidate = absolute;
        }
      }
    }
    if (Date.now() >= deadlineMs) {
      return lastMissingStableCandidate;
    }
    await sleep(300);
  } while (true);
}

// ---------------------------------------------------------------------------
// materializeMediaReferenceFiles
// ---------------------------------------------------------------------------

export async function materializeMediaReferenceFiles(input: {
  requestDir: string;
  referenceInputs: string[];
  maxReferenceInputs?: number;
}): Promise<string[]> {
  const maxReferenceInputsRaw =
    typeof input.maxReferenceInputs === "number" &&
    Number.isFinite(input.maxReferenceInputs)
      ? Math.floor(input.maxReferenceInputs)
      : MAX_MEDIA_REFERENCE_INPUTS;
  const maxReferenceInputs = Math.max(
    0,
    Math.min(MAX_MEDIA_REFERENCE_INPUTS, maxReferenceInputsRaw),
  );
  if (maxReferenceInputs === 0 || input.referenceInputs.length === 0) return [];
  const refsDir = path.join(input.requestDir, "refs");
  await ensureDir(refsDir);
  const resolved: string[] = [];
  const seen = new Set<string>();

  const pushResolved = (value: string): void => {
    if (resolved.length >= maxReferenceInputs) return;
    const normalized = path.resolve(value);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    resolved.push(normalized);
  };

  for (const rawReference of input.referenceInputs) {
    if (resolved.length >= maxReferenceInputs) break;
    const reference = rawReference.trim();
    if (!reference.length) continue;

    const localPath = await resolveLocalReferencePath(reference);
    if (localPath) {
      pushResolved(localPath);
      continue;
    }

    if (isDataUri(reference)) {
      const parsed = parseDataUriPayload(reference);
      if (!parsed) continue;
      const targetPath = path.join(
        refsDir,
        `data-${resolved.length + 1}.${mimeToExt(parsed.mime)}`,
      );
      await fs
        .writeFile(targetPath, Buffer.from(parsed.data, "base64"))
        .then(() => pushResolved(targetPath))
        .catch(() => undefined);
      continue;
    }

    if (isHttpUrl(reference)) {
      try {
        const response = await fetch(reference);
        if (!response.ok) continue;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.byteLength) continue;
        const contentType =
          response.headers.get("content-type") ??
          inferMimeTypeFromUrl(reference) ??
          "application/octet-stream";
        const targetPath = path.join(
          refsDir,
          `remote-${resolved.length + 1}.${mimeToExt(contentType)}`,
        );
        await fs.writeFile(targetPath, bytes);
        pushResolved(targetPath);
      } catch {
        // best effort only for reference enrichment
      }
    }
  }

  return resolved;
}
