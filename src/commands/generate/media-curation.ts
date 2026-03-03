/** Media prompt curation, normalization, and generator context helpers. */

import path from "node:path";
import fs from "node:fs/promises";

import type {
  GeneratedAssetType,
  MediaGenerationProgress,
  MediaGeneratorStreamFrame,
  ResolvedMediaUpload,
} from "../types.js";

import {
  asNonEmptyString,
  stripEmDashCharacters,
  isHttpUrl,
  isDataUri,
  isFileUrl,
  toUnknownArray,
} from "../helpers.js";

import {
  MEDIA_GENERATOR_DEFAULT_BASE_URL,
  MEDIA_FILE_RE,
  STREAM_PART_ARTIFACT_PATTERN,
  STREAM_PART_INDEX_PATTERN,
  TRANSIENT_MEDIA_ARTIFACT_FILENAME_PATTERN,
} from "../constants.js";

import { isRecord } from "../../lib/guards.js";
import { parseJsonFromMixedText } from "../../lib/parsing.js";

// ---------------------------------------------------------------------------
// normalizeCuratedMediaPrompt
// ---------------------------------------------------------------------------

export function normalizeCuratedMediaPrompt(value: string): string {
  const unfenced = value
    .replace(/^```(?:json|text|markdown)?\s*/iu, "")
    .replace(/```$/u, "")
    .trim();
  const unquoted = unfenced.replace(/^["'`]|["'`]$/gu, "").trim();
  const withoutLabel = unquoted.replace(
    /^(?:prompt|image prompt|media prompt)\s*:\s*/iu,
    "",
  );
  const withoutGenerationVerb = withoutLabel.replace(
    /^(?:please\s+)?(?:generate|create|make|draw|render)\s+(?:an?\s+)?(?:image|gif|avatar|file|video|audio|pdf|csv|code|markdown|md|txt)\s*(?:of|for)?\s*:?\s*/iu,
    "",
  );
  return stripEmDashCharacters(withoutGenerationVerb).trim();
}

// ---------------------------------------------------------------------------
// extractCuratedMediaPromptFromUnknown
// ---------------------------------------------------------------------------

export function extractCuratedMediaPromptFromUnknown(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.length) return null;
    const parsed = parseJsonFromMixedText(trimmed);
    if (parsed !== null && parsed !== value) {
      const fromParsed = extractCuratedMediaPromptFromUnknown(parsed);
      if (fromParsed) return fromParsed;
    }
    const normalized = normalizeCuratedMediaPrompt(trimmed);
    return normalized.length > 0 ? normalized : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const extracted = extractCuratedMediaPromptFromUnknown(entry);
      if (extracted) return extracted;
    }
    return null;
  }
  if (!isRecord(value)) return null;

  const directPromptKeys = [
    "prompt",
    "mediaPrompt",
    "imagePrompt",
    "filePrompt",
    "text",
    "output",
    "result",
    "content",
  ] as const;
  for (const key of directPromptKeys) {
    const extracted = extractCuratedMediaPromptFromUnknown(value[key]);
    if (extracted) return extracted;
  }
  return null;
}

// ---------------------------------------------------------------------------
// buildMediaPromptCurationRequest
// ---------------------------------------------------------------------------

export function buildMediaPromptCurationRequest(input: {
  sourcePrompt: string;
  generatedAssetType: GeneratedAssetType;
  mode: string;
}): string {
  const assetLabel =
    input.generatedAssetType === "gif"
      ? "animated GIF"
      : input.generatedAssetType === "pdf"
        ? "PDF file"
        : input.generatedAssetType === "csv"
          ? "CSV file"
          : input.generatedAssetType === "code"
            ? "code file"
            : input.generatedAssetType === "md"
              ? "markdown file"
              : input.generatedAssetType === "txt"
                ? "text file"
                : input.generatedAssetType === "file"
                  ? "file"
                  : "image";
  const rules = [
    "- Do not include wrappers like \"Generate an image of\".",
    "- Do not mention social-app internals, APIs, tools, or instructions.",
    "- Keep it concrete, visual/technical, and production-ready.",
    "- Preserve user intent and style.",
  ];
  if (input.generatedAssetType === "gif") {
    rules.push(
      "- For GIF output include explicit animation direction and motion beats.",
      "- Include exact output size 256x256 and keep the main subject centered.",
      "- Favor a seamless loop and avoid tiny unreadable details.",
    );
  }
  return [
    "You are Clawdbot prompt-crafter for media/file generation.",
    `Target output type: ${assetLabel}.`,
    `Execution mode: ${input.mode}.`,
    "Rewrite the user request into one high-quality generator prompt.",
    "Return strict JSON only with exactly this shape: {\"prompt\":\"...\"}.",
    "Rules:",
    ...rules,
    `User request: ${input.sourcePrompt}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// resolveMediaGeneratorBaseUrl
// ---------------------------------------------------------------------------

export function resolveMediaGeneratorBaseUrl(): string | null {
  const explicit = asNonEmptyString(process.env.MG_AGENT_MEDIA_GENERATOR_BASE_URL);
  if (explicit) {
    return explicit.replace(/\/+$/u, "");
  }
  const portRaw = asNonEmptyString(process.env.PW_PORT);
  if (portRaw) {
    const port = Number.parseInt(portRaw, 10);
    if (Number.isFinite(port) && port > 0 && port <= 65535) {
      return `http://127.0.0.1:${port}`;
    }
  }
  return MEDIA_GENERATOR_DEFAULT_BASE_URL;
}

// ---------------------------------------------------------------------------
// extractMediaGeneratorContextId
// ---------------------------------------------------------------------------

export function extractMediaGeneratorContextId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const direct = asNonEmptyString(payload.contextId);
  if (direct) return direct;
  const context = isRecord(payload.context) ? payload.context : null;
  if (!context) return null;
  return asNonEmptyString(context.id);
}

// ---------------------------------------------------------------------------
// extractMediaGeneratorContextRecord
// ---------------------------------------------------------------------------

export function extractMediaGeneratorContextRecord(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  const nested = isRecord(payload.context) ? payload.context : null;
  if (nested) return nested;
  const hasContextShape =
    payload.status !== undefined ||
    payload.streamEvents !== undefined ||
    payload.savedFiles !== undefined ||
    payload.observedOutputFiles !== undefined;
  return hasContextShape ? payload : null;
}

// ---------------------------------------------------------------------------
// isTerminalMediaGeneratorStatus
// ---------------------------------------------------------------------------

export function isTerminalMediaGeneratorStatus(status: string | null): boolean {
  if (!status) return false;
  const normalized = status.trim().toLowerCase();
  return (
    normalized === "done" ||
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "success" ||
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "cancelled" ||
    normalized === "canceled"
  );
}

// ---------------------------------------------------------------------------
// mediaGenerationProgressFingerprint
// ---------------------------------------------------------------------------

export function mediaGenerationProgressFingerprint(progress: MediaGenerationProgress): string {
  return [
    progress.contextId ?? "",
    progress.contextStatus ?? "",
    progress.latestPreviewUrl ?? "",
    progress.streamFrameCount,
    progress.latestStreamFrameIndex ?? "",
    progress.hasFinalStreamFrame ? "1" : "0",
    progress.streamRevealProgress,
    progress.timedOut ? "1" : "0",
  ].join("|");
}

// ---------------------------------------------------------------------------
// resolveLocalReferencePath
// ---------------------------------------------------------------------------

export async function resolveLocalReferencePath(reference: string): Promise<string | null> {
  const trimmed = reference.trim();
  if (!trimmed.length) return null;

  if (isFileUrl(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      let candidatePath = decodeURIComponent(parsed.pathname);
      if (process.platform === "win32" && /^\/[a-zA-Z]:/u.test(candidatePath)) {
        candidatePath = candidatePath.slice(1);
      }
      const absolutePath = path.resolve(candidatePath);
      await fs.access(absolutePath);
      return absolutePath;
    } catch {
      return null;
    }
  }

  if (isHttpUrl(trimmed) || isDataUri(trimmed)) return null;
  const absolutePath = path.resolve(trimmed);
  const fileStat = await fs.stat(absolutePath).catch(() => null);
  if (!fileStat?.isFile()) return null;
  return absolutePath;
}

// ---------------------------------------------------------------------------
// isTransientMediaArtifactFileName
// ---------------------------------------------------------------------------

export function isTransientMediaArtifactFileName(value: string | null | undefined): boolean {
  const normalized = asNonEmptyString(value);
  if (!normalized) return false;
  const fileName = path.basename(normalized.trim());
  if (!fileName.length) return false;
  return (
    STREAM_PART_ARTIFACT_PATTERN.test(fileName) ||
    TRANSIENT_MEDIA_ARTIFACT_FILENAME_PATTERN.test(fileName)
  );
}

// ---------------------------------------------------------------------------
// isStreamPartArtifactReference
// ---------------------------------------------------------------------------

export function isStreamPartArtifactReference(value: string | null | undefined): boolean {
  const normalized = asNonEmptyString(value);
  if (!normalized) return false;
  if (isTransientMediaArtifactFileName(normalized)) return true;
  if (!isHttpUrl(normalized)) {
    return STREAM_PART_ARTIFACT_PATTERN.test(normalized);
  }
  try {
    const parsed = new URL(normalized);
    const decodedPath = decodeURIComponent(parsed.pathname);
    if (isTransientMediaArtifactFileName(path.posix.basename(decodedPath))) {
      return true;
    }
    for (const [key, rawValue] of parsed.searchParams.entries()) {
      if (/^(?:part|frame|chunk|tmp|temp|temporary|intermediate)$/iu.test(key)) {
        return true;
      }
      if (
        isTransientMediaArtifactFileName(rawValue) ||
        STREAM_PART_ARTIFACT_PATTERN.test(rawValue)
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return isTransientMediaArtifactFileName(normalized);
  }
}

// ---------------------------------------------------------------------------
// isFinalStreamFrameEntry
// ---------------------------------------------------------------------------

export function isFinalStreamFrameEntry(entry: Record<string, unknown>): boolean {
  const sourceFileName =
    asNonEmptyString(entry.sourceFileName) ??
    asNonEmptyString(entry.file_name);
  const isStreamPartFromName =
    sourceFileName !== null && isStreamPartArtifactReference(sourceFileName);
  return (
    entry.isFinalStreamFrame === true ||
    entry.streamIsFinalFrame === true ||
    (sourceFileName !== null && !isStreamPartFromName)
  );
}

// ---------------------------------------------------------------------------
// summarizeStreamEventsFinality
// ---------------------------------------------------------------------------

export function summarizeStreamEventsFinality(value: unknown): {
  hasEvents: boolean;
  hasFinalStreamFrame: boolean;
} {
  const events = toUnknownArray(value);
  if (events.length === 0) {
    return {
      hasEvents: false,
      hasFinalStreamFrame: false,
    };
  }
  let hasFinalStreamFrame = false;
  for (const rawEntry of events) {
    if (!isRecord(rawEntry)) continue;
    if (isFinalStreamFrameEntry(rawEntry)) {
      hasFinalStreamFrame = true;
      break;
    }
  }
  return {
    hasEvents: true,
    hasFinalStreamFrame,
  };
}

// ---------------------------------------------------------------------------
// resolvePreferredMediaUrl
// ---------------------------------------------------------------------------

export function resolvePreferredMediaUrl(
  ...values: Array<string | null | undefined>
): string | null {
  let fallback: string | null = null;
  for (const value of values) {
    const normalized = asNonEmptyString(value);
    if (!normalized) continue;
    fallback ??= normalized;
    if (!isStreamPartArtifactReference(normalized)) {
      return normalized;
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// mapUploadResult
// ---------------------------------------------------------------------------

export function mapUploadResult(uploaded: unknown): ResolvedMediaUpload {
  const data = isRecord(uploaded) ? uploaded : null;
  const mediaUrl = resolvePreferredMediaUrl(
    asNonEmptyString(data?.url),
    asNonEmptyString(data?.mediaUrl),
    asNonEmptyString(data?.originalUrl),
    asNonEmptyString(data?.optimizedUrl),
  );
  if (!mediaUrl) {
    throw new Error("no_media_url");
  }
  const mediaTypeRaw = asNonEmptyString(data?.mediaType)?.toLowerCase();
  const mediaType =
    mediaTypeRaw === "video"
      ? ("video" as const)
      : mediaTypeRaw === "image"
        ? ("image" as const)
        : undefined;
  const originalUrl =
    resolvePreferredMediaUrl(
      asNonEmptyString(data?.originalUrl),
      asNonEmptyString(data?.url),
      asNonEmptyString(data?.mediaUrl),
      asNonEmptyString(data?.optimizedUrl),
    ) ?? mediaUrl;
  const optimizedUrl =
    resolvePreferredMediaUrl(
      asNonEmptyString(data?.optimizedUrl),
      asNonEmptyString(data?.url),
      asNonEmptyString(data?.mediaUrl),
      asNonEmptyString(data?.originalUrl),
    ) ?? mediaUrl;
  const result: ResolvedMediaUpload = {
    mediaUrl,
    mediaOriginalUrl: originalUrl,
    mediaOptimizedUrl: optimizedUrl,
  };
  const contentHash = asNonEmptyString(data?.contentHash);
  const ipfsCid = asNonEmptyString(data?.ipfsCid);
  if (contentHash) result.mediaContentHash = contentHash;
  if (ipfsCid) result.mediaIpfsCid = ipfsCid;
  if (typeof data?.sizeBytes === "number" && Number.isFinite(data.sizeBytes)) {
    result.mediaSizeBytes = Math.max(1, Math.floor(data.sizeBytes));
  }
  if (mediaType) result.mediaType = mediaType;
  return result;
}

// ---------------------------------------------------------------------------
// parseMediaGenerationProgress
// ---------------------------------------------------------------------------

export function parseMediaGenerationProgress(
  payload: unknown,
  timedOut: boolean,
): MediaGenerationProgress {
  const context = extractMediaGeneratorContextRecord(payload);
  const contextId =
    extractMediaGeneratorContextId(payload) ??
    (context ? asNonEmptyString(context.id) : null);
  const contextStatus = context ? asNonEmptyString(context.status) : null;
  const streamEvents = context ? toUnknownArray(context.streamEvents) : [];
  const streamFrames: MediaGeneratorStreamFrame[] = [];
  let latestPreviewUrl: string | null = null;

  for (const rawEntry of streamEvents) {
    if (!isRecord(rawEntry)) continue;
    const sourceFileName =
      asNonEmptyString(rawEntry.sourceFileName) ??
      asNonEmptyString(rawEntry.file_name);
    const streamPartIndexFromName =
      sourceFileName && STREAM_PART_INDEX_PATTERN.test(sourceFileName)
        ? Number.parseInt(
            STREAM_PART_INDEX_PATTERN.exec(sourceFileName)?.[1] ?? "",
            10,
          )
        : null;
    const streamPartIndexRaw =
      typeof rawEntry.streamPartIndex === "number" &&
      Number.isFinite(rawEntry.streamPartIndex)
        ? Math.max(0, Math.floor(rawEntry.streamPartIndex))
        : streamPartIndexFromName !== null && Number.isFinite(streamPartIndexFromName)
          ? Math.max(0, Math.floor(streamPartIndexFromName))
          : null;
    const isStreamPartFromName =
      sourceFileName !== null && isStreamPartArtifactReference(sourceFileName);
    const isStreamPart =
      rawEntry.isStreamPart === true ||
      (typeof streamPartIndexRaw === "number" && Number.isFinite(streamPartIndexRaw)) ||
      isStreamPartFromName;
    const isFinalStreamFrame =
      rawEntry.isFinalStreamFrame === true ||
      rawEntry.streamIsFinalFrame === true ||
      (sourceFileName !== null && !isStreamPartFromName);
    const previewCandidate =
      asNonEmptyString(rawEntry.previewUrl) ??
      asNonEmptyString(rawEntry.url) ??
      asNonEmptyString(rawEntry.resolvedUrl) ??
      asNonEmptyString(rawEntry.fileUrl) ??
      asNonEmptyString(rawEntry.mediaUrl) ??
      asNonEmptyString(rawEntry.outputUrl) ??
      asNonEmptyString(rawEntry.downloadUrl) ??
      asNonEmptyString(rawEntry.dataUri);
    const previewUrl =
      previewCandidate &&
      (isHttpUrl(previewCandidate) || isDataUri(previewCandidate))
        ? previewCandidate
        : null;
    if (previewUrl) {
      latestPreviewUrl = previewUrl;
    }
    const outputPath =
      asNonEmptyString(rawEntry.outputPath) ??
      asNonEmptyString(rawEntry.savedOutputPath) ??
      asNonEmptyString(rawEntry.path);
    const metadataId = asNonEmptyString(rawEntry.metadataId);
    const source = asNonEmptyString(rawEntry.source);
    if (!previewUrl && !sourceFileName && !outputPath && !isStreamPart && !isFinalStreamFrame) {
      continue;
    }
    streamFrames.push({
      sourceFileName,
      isStreamPart,
      streamPartIndex:
        typeof streamPartIndexRaw === "number" && Number.isFinite(streamPartIndexRaw)
          ? streamPartIndexRaw
          : null,
      isFinalStreamFrame,
      previewUrl,
      outputPath,
      metadataId,
      source,
    });
  }

  const latestFromFinalFrame =
    [...streamFrames]
      .reverse()
      .find((entry) => entry.isFinalStreamFrame && typeof entry.previewUrl === "string")
      ?.previewUrl ?? null;
  const latestFromAnyFrame =
    [...streamFrames]
      .reverse()
      .map((entry) => entry.previewUrl)
      .find((entry): entry is string => typeof entry === "string" && entry.length > 0) ?? null;
  const latestPreview =
    latestFromFinalFrame ??
    latestFromAnyFrame ??
    latestPreviewUrl ??
    (context
      ? asNonEmptyString(context.latestPreviewUrl) ??
        asNonEmptyString(context.previewUrl)
      : null);
  const streamFrameCount = streamFrames.length;
  const hasFinalStreamFrame = streamFrames.some((entry) => entry.isFinalStreamFrame);
  const latestStreamFrameIndex = streamFrameCount > 0 ? streamFrameCount - 1 : null;
  const revealBase = 1 - Math.exp(-streamFrameCount * 0.45);
  const streamRevealProgress = hasFinalStreamFrame
    ? 1
    : Math.min(0.92, Number(revealBase.toFixed(3)));
  return {
    contextId,
    contextStatus,
    latestPreviewUrl: latestPreview,
    streamFrameCount,
    latestStreamFrameIndex,
    hasFinalStreamFrame,
    streamRevealProgress,
    streamFrames,
    timedOut,
  };
}

// ---------------------------------------------------------------------------
// findFirstMediaFile
// ---------------------------------------------------------------------------

export async function findFirstMediaFile(dirPath: string, maxDepth: number): Promise<string | null> {
  const walk = async (currentPath: string, depth: number): Promise<string | null> => {
    if (depth < 0) return null;
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    const fileEntries = entries.filter(
      (entry) => entry.isFile() && MEDIA_FILE_RE.test(entry.name),
    );
    const stableCandidates = fileEntries.filter(
      (entry) => !isStreamPartArtifactReference(entry.name),
    );
    const pickNewestPath = async (candidates: typeof fileEntries): Promise<string | null> => {
      if (candidates.length === 0) return null;
      const withMtime = await Promise.all(
        candidates.map(async (entry) => {
          const filePath = path.join(currentPath, entry.name);
          const stat = await fs.stat(filePath).catch(() => null);
          return {
            filePath,
            mtimeMs:
              stat && Number.isFinite(stat.mtimeMs)
                ? stat.mtimeMs
                : Number.NEGATIVE_INFINITY,
          };
        }),
      );
      withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return withMtime[0]?.filePath ?? null;
    };
    const stablePath = await pickNewestPath(stableCandidates);
    if (stablePath) return stablePath;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nested = await walk(path.join(currentPath, entry.name), depth - 1);
      if (nested) return nested;
    }
    return null;
  };
  return walk(dirPath, maxDepth);
}
