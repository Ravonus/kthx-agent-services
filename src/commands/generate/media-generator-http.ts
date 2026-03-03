/** HTTP-based media generation — start request, poll for completion, emit progress. */

import type { GeneratedAssetType, MediaGenerationProgress } from "../types.js";

import { sleep } from "../../lib/async.js";
import { nowIso } from "../../lib/text.js";
import { asNonEmptyString, toUnknownArray } from "../helpers.js";
import { isRecord } from "../../lib/guards.js";

import {
  resolveMediaGeneratorBaseUrl,
  extractMediaGeneratorContextId,
  extractMediaGeneratorContextRecord,
  isTerminalMediaGeneratorStatus,
  parseMediaGenerationProgress,
  mediaGenerationProgressFingerprint,
  isStreamPartArtifactReference,
} from "./media-curation.js";

import { extractMediaSourceFromParsedOutput } from "./media-source.js";

import {
  MEDIA_GENERATOR_POLL_MS,
  MEDIA_GENERATOR_OPEN_TIMEOUT_MS,
} from "../constants.js";

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

type MemoryWriter = { recordWrite(entry: unknown): Promise<void> };

// ---------------------------------------------------------------------------
// runMediaGeneratorViaHttp
// ---------------------------------------------------------------------------

export async function runMediaGeneratorViaHttp(
  deps: { memory: MemoryWriter },
  input: {
    prompt: string;
    generatedAssetType: GeneratedAssetType;
    requestDir: string;
    referenceFiles: string[];
    timeoutMs: number;
    stream: boolean;
    onProgress?: ((progress: MediaGenerationProgress) => Promise<void> | void) | undefined;
  },
): Promise<{ payload: unknown; timedOut: boolean } | null> {
  const baseUrl = resolveMediaGeneratorBaseUrl();
  if (!baseUrl) return null;
  const useFileGenerator = input.generatedAssetType !== "image";
  const streamEnabled = !useFileGenerator && input.stream === true;
  const requiresFinalStreamFrame = streamEnabled;
  const requestBody: Record<string, unknown> = {
    prompt: input.prompt,
    command: useFileGenerator ? "generateFile" : "generateImage",
    mode: useFileGenerator ? "file" : "image",
    stream: streamEnabled,
    sync: false,
    count: 1,
    dir: input.requestDir,
  };
  if (input.referenceFiles.length > 0) {
    requestBody.files = input.referenceFiles;
  }
  if (useFileGenerator) {
    requestBody.type = input.generatedAssetType === "gif" ? "gif" : "file";
  }

  const hasFinalArtifactInList = (value: unknown): boolean => {
    const items = toUnknownArray(value);
    for (const item of items) {
      const direct =
        asNonEmptyString(item) ??
        (isRecord(item)
          ? asNonEmptyString(item.outputPath) ??
            asNonEmptyString(item.savedOutputPath) ??
            asNonEmptyString(item.path) ??
            asNonEmptyString(item.fileUrl) ??
            asNonEmptyString(item.mediaUrl) ??
            asNonEmptyString(item.outputUrl) ??
            asNonEmptyString(item.downloadUrl) ??
            asNonEmptyString(item.url)
          : null);
      if (!direct) continue;
      if (!isStreamPartArtifactReference(direct)) return true;
    }
    return false;
  };

  const controller = new AbortController();
  const openTimeout = setTimeout(
    () => controller.abort(),
    Math.max(5_000, Math.min(MEDIA_GENERATOR_OPEN_TIMEOUT_MS, input.timeoutMs)),
  );
  let payload: unknown = null;
  try {
    const response = await fetch(`${baseUrl}/open`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const text = await response.text();
    payload = text.length > 0 ? (JSON.parse(text) as unknown) : null;
    if (!response.ok) {
      await deps.memory
        .recordWrite({
          type: "media_generation_service_http_failed",
          at: nowIso(),
          status: response.status,
          generatedAssetType: input.generatedAssetType,
        })
        .catch(() => undefined);
      return null;
    }
  } catch (error: unknown) {
    await deps.memory
      .recordWrite({
        type: "media_generation_service_unavailable",
        at: nowIso(),
        generatedAssetType: input.generatedAssetType,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    return null;
  } finally {
    clearTimeout(openTimeout);
  }

  const emitProgress = async (
    progressPayload: unknown,
    timedOut: boolean,
    previousFingerprint: string | null,
  ): Promise<string | null> => {
    if (!input.onProgress) return previousFingerprint;
    const progress = parseMediaGenerationProgress(progressPayload, timedOut);
    const fingerprint = mediaGenerationProgressFingerprint(progress);
    if (fingerprint === previousFingerprint) return previousFingerprint;
    try {
      await input.onProgress(progress);
    } catch {
      // Ignore progress callback failures.
    }
    return fingerprint;
  };

  let latestPayload: unknown = payload;
  let latestFingerprint: string | null = await emitProgress(
    latestPayload,
    false,
    null,
  );
  const contextId = extractMediaGeneratorContextId(payload);
  if (!contextId) {
    return { payload: latestPayload, timedOut: false };
  }

  const deadlineMs = Date.now() + Math.max(5_000, input.timeoutMs);
  while (Date.now() <= deadlineMs) {
    try {
      const response = await fetch(
        `${baseUrl}/context?id=${encodeURIComponent(contextId)}`,
      );
      const text = await response.text();
      const contextPayload = text.length > 0 ? (JSON.parse(text) as unknown) : null;
      if (!response.ok) {
        await sleep(MEDIA_GENERATOR_POLL_MS);
        continue;
      }
      latestPayload = contextPayload;
      const progress = parseMediaGenerationProgress(contextPayload, false);
      latestFingerprint = await emitProgress(latestPayload, false, latestFingerprint);
      const context = extractMediaGeneratorContextRecord(contextPayload);
      const status = context ? asNonEmptyString(context.status) : null;
      const savedFiles = toUnknownArray(context?.savedFiles);
      const observedOutputFiles = toUnknownArray(context?.observedOutputFiles);
      const savedFilesCount = savedFiles.length;
      const observedOutputFilesCount = observedOutputFiles.length;
      const hasArtifacts = savedFilesCount > 0 || observedOutputFilesCount > 0;
      const hasFinalStreamFrame = progress.hasFinalStreamFrame;
      const hasFinalStreamArtifact = progress.streamFrames.some(
        (frame) =>
          frame.isFinalStreamFrame &&
          typeof frame.outputPath === "string" &&
          frame.outputPath.trim().length > 0,
      );
      const hasFinalArtifactFile =
        hasFinalArtifactInList(savedFiles) || hasFinalArtifactInList(observedOutputFiles);
      const resolvedCandidate =
        extractMediaSourceFromParsedOutput(contextPayload, input.requestDir, {
          requireFinalStreamFrame: requiresFinalStreamFrame,
        }) ?? null;
      const hasTerminalStatus = isTerminalMediaGeneratorStatus(status);
      const generationReady = requiresFinalStreamFrame
        ? hasFinalStreamFrame ||
          hasFinalStreamArtifact ||
          hasFinalArtifactFile ||
          Boolean(resolvedCandidate) ||
          hasTerminalStatus
        : useFileGenerator
          ? hasArtifacts || hasTerminalStatus
          : Boolean(resolvedCandidate);
      if (generationReady) {
        return { payload: latestPayload, timedOut: false };
      }
    } catch {
      // keep polling until timeout
    }
    await sleep(MEDIA_GENERATOR_POLL_MS);
  }

  latestFingerprint = await emitProgress(latestPayload, true, latestFingerprint);
  return {
    payload: latestPayload,
    timedOut: true,
  };
}
