/**
 * Encapsulates the mutable state and helper functions for managing
 * chat preview messages during a literal-generate flow (stream progress,
 * message editing, rebinding, etc.).
 */

import type { MediaGenerationProgress, MediaGeneratorStreamFrame } from "../types.js";
import {
  asNonEmptyString,
  isHttpUrl,
  isDataUri,
  callBridgeWithRateLimitRetry,
  toUnknownArray,
  extractBridgeMessageId,
} from "../helpers.js";
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";
import { sleep } from "../../lib/async.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_PROCESSING_STREAM_FRAME_DELTA = 3;
export const MAX_FINALIZE_STREAM_FRAMES = 1;
const MAX_PREVIEW_HTTP_URL_LENGTH = 2048;
const MAX_PREVIEW_DATA_URI_LENGTH = 12_000;

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

type ChatBridgeFn = (input: unknown) => Promise<unknown>;
type MemoryRecordWriteFn = (entry: unknown) => Promise<void>;
type IsStreamPartArtifactReferenceFn = (
  value: string | null | undefined,
) => boolean;

// ---------------------------------------------------------------------------
// StreamPreviewDeltaMetadata
// ---------------------------------------------------------------------------

export type StreamPreviewDeltaMetadata = {
  streamFrameDelta: MediaGeneratorStreamFrame[];
  streamFrameDeltaBaseCount: number;
  streamFrameCount: number;
  latestStreamFrameIndex: number;
  hasFinalStreamFrame: boolean;
  streamRevealProgress: number;
};

// ---------------------------------------------------------------------------
// Config & init options
// ---------------------------------------------------------------------------

export type ChatLiteralPreviewConfig = {
  previewClientMessageId: string;
  chatRoute: Record<string, unknown>;
  previewType: string;
  processingTitle: string;
  summary: string;
  processingBody: string;
  commandId: string;
};

export type ChatLiteralPreviewDeps = {
  callAgentChatBridge: ChatBridgeFn | null;
  memoryRecordWrite: MemoryRecordWriteFn;
  isStreamPartArtifactReference: IsStreamPartArtifactReferenceFn;
};

// ---------------------------------------------------------------------------
// Pure helpers (no state dependency)
// ---------------------------------------------------------------------------

export function sanitizePreviewUrlForChat(
  value: string | null | undefined,
): string | null {
  const normalized = asNonEmptyString(value);
  if (!normalized) return null;
  if (isHttpUrl(normalized)) {
    return normalized.length <= MAX_PREVIEW_HTTP_URL_LENGTH ? normalized : null;
  }
  if (isDataUri(normalized)) {
    return normalized.length <= MAX_PREVIEW_DATA_URI_LENGTH ? normalized : null;
  }
  return null;
}

export function compactStreamFramesForChat(
  frames: MediaGeneratorStreamFrame[],
  maxFrames: number,
): MediaGeneratorStreamFrame[] {
  const boundedMax = Math.max(1, Math.floor(maxFrames));
  const compacted: MediaGeneratorStreamFrame[] = [];
  for (const rawFrame of frames.slice(-boundedMax)) {
    const previewUrl = sanitizePreviewUrlForChat(rawFrame.previewUrl);
    if (
      !previewUrl &&
      rawFrame.isFinalStreamFrame !== true &&
      rawFrame.isStreamPart !== true
    ) {
      continue;
    }
    compacted.push({
      sourceFileName: rawFrame.sourceFileName,
      isStreamPart: rawFrame.isStreamPart === true,
      streamPartIndex:
        typeof rawFrame.streamPartIndex === "number" &&
        Number.isFinite(rawFrame.streamPartIndex)
          ? Math.max(0, Math.floor(rawFrame.streamPartIndex))
          : null,
      isFinalStreamFrame: rawFrame.isFinalStreamFrame === true,
      previewUrl,
      outputPath: null,
      metadataId: null,
      source: rawFrame.source,
    });
  }
  return compacted;
}

export function buildStreamPreviewMetadata(input: {
  frames: MediaGeneratorStreamFrame[];
  maxFrames: number;
  finalPreviewUrl?: string | null;
}): {
  streamFrames: MediaGeneratorStreamFrame[];
  streamFrameCount: number;
  latestStreamFrameIndex: number;
  hasFinalStreamFrame: boolean;
  streamRevealProgress: number;
} | null {
  const compacted = compactStreamFramesForChat(input.frames, input.maxFrames);
  const normalizedFinalPreviewUrl = sanitizePreviewUrlForChat(
    input.finalPreviewUrl,
  );
  const hasExplicitFinalPreviewFrame =
    normalizedFinalPreviewUrl !== null &&
    compacted.some(
      (entry) =>
        entry.isFinalStreamFrame &&
        typeof entry.previewUrl === "string" &&
        entry.previewUrl === normalizedFinalPreviewUrl,
    );
  if (normalizedFinalPreviewUrl && !hasExplicitFinalPreviewFrame) {
    compacted.push({
      sourceFileName: null,
      isStreamPart: false,
      streamPartIndex: null,
      isFinalStreamFrame: true,
      previewUrl: normalizedFinalPreviewUrl,
      outputPath: null,
      metadataId: null,
      source: "runtime.final",
    });
  }
  if (compacted.length === 0) return null;
  const hasFinalStreamFrame = compacted.some(
    (entry) => entry.isFinalStreamFrame,
  );
  const streamFrameCount = compacted.length;
  return {
    streamFrames: compacted,
    streamFrameCount,
    latestStreamFrameIndex: streamFrameCount - 1,
    hasFinalStreamFrame,
    streamRevealProgress: hasFinalStreamFrame
      ? 1
      : Math.min(
          0.92,
          Number((1 - Math.exp(-streamFrameCount * 0.45)).toFixed(3)),
        ),
  };
}

export function buildStreamPreviewDeltaMetadata(input: {
  frames: MediaGeneratorStreamFrame[];
  deltaBaseCount: number;
  maxDeltaFrames: number;
  finalPreviewUrl?: string | null;
}): {
  metadata: StreamPreviewDeltaMetadata;
  nextFrameCursor: number;
} | null {
  const boundedBaseCount = Math.max(0, Math.floor(input.deltaBaseCount));
  const normalizedFinalPreviewUrl = sanitizePreviewUrlForChat(
    input.finalPreviewUrl,
  );
  const sourceFrames = input.frames;
  const sourceFrameCount = sourceFrames.length;
  const deltaBaseCount = Math.max(
    0,
    Math.min(sourceFrameCount, boundedBaseCount),
  );
  const compactedDeltaFrames = compactStreamFramesForChat(
    sourceFrames.slice(deltaBaseCount),
    input.maxDeltaFrames,
  );
  const hasFinalFrameInSource = sourceFrames.some(
    (entry) => entry.isFinalStreamFrame,
  );
  const hasExplicitFinalPreviewFrameInSource =
    normalizedFinalPreviewUrl !== null &&
    sourceFrames.some(
      (entry) =>
        entry.isFinalStreamFrame &&
        typeof entry.previewUrl === "string" &&
        entry.previewUrl === normalizedFinalPreviewUrl,
    );
  if (
    normalizedFinalPreviewUrl &&
    !compactedDeltaFrames.some(
      (entry) =>
        entry.isFinalStreamFrame &&
        typeof entry.previewUrl === "string" &&
        entry.previewUrl === normalizedFinalPreviewUrl,
    )
  ) {
    compactedDeltaFrames.push({
      sourceFileName: null,
      isStreamPart: false,
      streamPartIndex: null,
      isFinalStreamFrame: true,
      previewUrl: normalizedFinalPreviewUrl,
      outputPath: null,
      metadataId: null,
      source: "runtime.final",
    });
  }
  const streamFrameCount =
    normalizedFinalPreviewUrl && !hasExplicitFinalPreviewFrameInSource
      ? sourceFrameCount + 1
      : sourceFrameCount;
  if (compactedDeltaFrames.length === 0 && streamFrameCount === 0) {
    return null;
  }
  const hasFinalStreamFrame =
    hasFinalFrameInSource || normalizedFinalPreviewUrl !== null;
  const revealBase = 1 - Math.exp(-streamFrameCount * 0.45);
  return {
    metadata: {
      streamFrameDelta: compactedDeltaFrames,
      streamFrameDeltaBaseCount: deltaBaseCount,
      streamFrameCount,
      latestStreamFrameIndex: Math.max(0, streamFrameCount - 1),
      hasFinalStreamFrame,
      streamRevealProgress: hasFinalStreamFrame
        ? 1
        : Math.min(0.92, Number(revealBase.toFixed(3))),
    },
    nextFrameCursor: sourceFrameCount,
  };
}

// ---------------------------------------------------------------------------
// Factory: createChatLiteralPreviewState
// ---------------------------------------------------------------------------

export function createChatLiteralPreviewState(
  deps: ChatLiteralPreviewDeps,
  config: ChatLiteralPreviewConfig,
  initialState?: {
    previewMessageCreateAttempted?: boolean | undefined;
  },
) {
  // -- Mutable state --------------------------------------------------------
  let previewMessageId: string | null = null;
  let previewMessageCreateAttempted =
    initialState?.previewMessageCreateAttempted ?? false;
  let previewProgressFingerprint = "";
  let previewProgressUpdatedAtMs = 0;
  let latestMediaProgress: MediaGenerationProgress | null = null;
  let previewStreamFrameCursor = 0;
  let previewLookupBackoffUntilMs = 0;
  let previewLastEditError: string | null = null;

  // -- Closure helpers referencing config -----------------------------------

  const buildProcessingActionPreview = (input?: {
    progress?: MediaGenerationProgress;
    streamDeltaMetadata?: StreamPreviewDeltaMetadata | null;
  }) => ({
    type: config.previewType,
    status: "processing",
    title: config.processingTitle,
    summary: config.summary,
    streamSessionId: config.previewClientMessageId,
    ...(input?.progress?.latestPreviewUrl
      ? {
          previewUrl: sanitizePreviewUrlForChat(
            input.progress.latestPreviewUrl,
          ),
        }
      : {}),
    ...(input?.streamDeltaMetadata ?? {}),
  });

  // -- resolveChatDeliveryUrl -----------------------------------------------

  const resolveChatDeliveryUrl = (
    ...values: Array<string | null | undefined>
  ): string | null => {
    let fallback: string | null = null;
    for (const value of values) {
      const normalized = sanitizePreviewUrlForChat(value);
      if (!normalized) continue;
      fallback ??= normalized;
      if (!deps.isStreamPartArtifactReference(normalized)) {
        return normalized;
      }
    }
    return fallback;
  };

  // -- snapshotStreamFrames -------------------------------------------------

  const snapshotStreamFrames = (): MediaGeneratorStreamFrame[] => {
    const progress = latestMediaProgress;
    return progress && Array.isArray(progress.streamFrames)
      ? progress.streamFrames
      : [];
  };

  // -- maybeResolvePreviewMessageId -----------------------------------------

  const maybeResolvePreviewMessageId = async (
    force: boolean,
  ): Promise<string | null> => {
    if (previewMessageId) return previewMessageId;
    const callAgentChatBridge = deps.callAgentChatBridge;
    if (!callAgentChatBridge) return null;
    const nowMs = Date.now();
    if (!force && nowMs < previewLookupBackoffUntilMs) {
      return null;
    }
    previewLookupBackoffUntilMs = nowMs + 800;
    try {
      const listed = await callBridgeWithRateLimitRetry({
        call: () =>
          callAgentChatBridge({
            action: "list_messages",
            ...config.chatRoute,
            limit: 80,
          }),
        maxAttempts: force ? 4 : 2,
        fallbackDelayMs: 220,
      });
      const data = isRecord(listed) ? listed : null;
      const items = data ? toUnknownArray(data.items) : [];
      for (const rawItem of items) {
        if (!isRecord(rawItem)) continue;
        const message = isRecord(rawItem.message) ? rawItem.message : null;
        if (!message) continue;
        const messageId = asNonEmptyString(message.id);
        const clientMessageId = asNonEmptyString(message.clientMessageId);
        if (!messageId || !clientMessageId) continue;
        if (
          clientMessageId === config.previewClientMessageId ||
          clientMessageId.startsWith(`${config.previewClientMessageId}_`)
        ) {
          previewMessageId = messageId;
          return previewMessageId;
        }
      }
    } catch {
      return null;
    }
    return null;
  };

  // -- tryEditPreviewMessage ------------------------------------------------

  const tryEditPreviewMessage = async (input: {
    body: string;
    attachments?: Array<{
      url: string;
      mimeType: string;
      sizeBytes: number;
      metadata?: Record<string, unknown>;
    }>;
    metadata: Record<string, unknown>;
    kind: "processing" | "success" | "failed";
  }): Promise<boolean> => {
    const callAgentChatBridge = deps.callAgentChatBridge;
    if (!callAgentChatBridge) return false;
    const runEdit = async (): Promise<string | null> => {
      const resolvedPreviewMessageId =
        previewMessageId ??
        (input.kind === "processing"
          ? await maybeResolvePreviewMessageId(false)
          : await maybeResolvePreviewMessageId(true));
      const callEdit = async (payload: Record<string, unknown>) =>
        callBridgeWithRateLimitRetry({
          call: () => callAgentChatBridge(payload),
          maxAttempts: input.kind === "processing" ? 4 : 8,
          fallbackDelayMs: input.kind === "processing" ? 220 : 420,
        });
      try {
        const editedByClientMessageId = await callEdit({
          action: "edit_message",
          clientMessageId: config.previewClientMessageId,
          ...config.chatRoute,
          body: input.body,
          ...(input.attachments ? { attachments: input.attachments } : {}),
          metadata: input.metadata,
        });
        const editedByClientMessageIdResolved = extractBridgeMessageId(
          editedByClientMessageId,
        );
        if (editedByClientMessageIdResolved) {
          return editedByClientMessageIdResolved;
        }
        const resolvedAfterClientEdit =
          previewMessageId ??
          (input.kind === "processing"
            ? await maybeResolvePreviewMessageId(false)
            : await maybeResolvePreviewMessageId(true));
        return resolvedAfterClientEdit ?? resolvedPreviewMessageId ?? null;
      } catch (clientEditError: unknown) {
        if (!resolvedPreviewMessageId) {
          throw clientEditError;
        }
        const editedByMessageId = await callEdit({
          action: "edit_message",
          messageId: resolvedPreviewMessageId,
          ...config.chatRoute,
          body: input.body,
          ...(input.attachments ? { attachments: input.attachments } : {}),
          metadata: input.metadata,
        });
        return (
          extractBridgeMessageId(editedByMessageId) ??
          resolvedPreviewMessageId
        );
      }
    };
    try {
      const editedMessageId = await runEdit();
      previewLastEditError = null;
      previewMessageId = editedMessageId ?? previewMessageId;
      previewMessageId ??= await maybeResolvePreviewMessageId(true);
      return true;
    } catch (firstError: unknown) {
      previewLastEditError =
        firstError instanceof Error ? firstError.message : String(firstError);
      previewMessageId = null;
      await maybeResolvePreviewMessageId(true);
      try {
        const editedMessageId = await runEdit();
        previewLastEditError = null;
        previewMessageId = editedMessageId ?? previewMessageId;
        previewMessageId ??= await maybeResolvePreviewMessageId(true);
        return true;
      } catch (retryError: unknown) {
        previewLastEditError =
          retryError instanceof Error
            ? retryError.message
            : String(retryError);
        await deps
          .memoryRecordWrite({
            type: "chat_literal_generate_preview_edit_failed",
            at: nowIso(),
            commandId: config.commandId,
            kind: input.kind,
            message:
              retryError instanceof Error
                ? retryError.message
                : String(retryError),
          })
          .catch(() => undefined);
        return false;
      }
    }
  };

  // -- rebindPreviewMessageId -----------------------------------------------

  const rebindPreviewMessageId = async (): Promise<boolean> => {
    const callAgentChatBridge = deps.callAgentChatBridge;
    if (!callAgentChatBridge) return false;
    try {
      const rebound = await callBridgeWithRateLimitRetry({
        call: () =>
          callAgentChatBridge({
            action: "send_message",
            clientMessageId: config.previewClientMessageId,
            ...config.chatRoute,
            body: config.processingBody,
            format: "markdown",
            metadata: {
              automated: true,
              sourceContext: "CHAT",
              actionPreview: latestMediaProgress
                ? buildProcessingActionPreview({
                    progress: latestMediaProgress,
                  })
                : buildProcessingActionPreview(),
            },
          }),
        maxAttempts: 8,
        fallbackDelayMs: 420,
      });
      previewMessageCreateAttempted = true;
      previewMessageId =
        extractBridgeMessageId(rebound) ?? previewMessageId;
      previewMessageId ??= await maybeResolvePreviewMessageId(true);
      return Boolean(previewMessageId);
    } catch (error: unknown) {
      previewLastEditError =
        error instanceof Error ? error.message : String(error);
      await deps
        .memoryRecordWrite({
          type: "chat_literal_generate_preview_rebind_failed",
          at: nowIso(),
          commandId: config.commandId,
          message: previewLastEditError,
        })
        .catch(() => undefined);
      return false;
    }
  };

  // -- sendOrEditPreviewMessage ---------------------------------------------

  const sendOrEditPreviewMessage = async (input: {
    body: string;
    attachments?: Array<{
      url: string;
      mimeType: string;
      sizeBytes: number;
      metadata?: Record<string, unknown>;
    }>;
    metadata: Record<string, unknown>;
    kind: "processing" | "success" | "failed";
  }): Promise<boolean> => {
    const callAgentChatBridge = deps.callAgentChatBridge;
    if (!callAgentChatBridge) return false;
    const sendFreshPreviewMessage = async (
      attachments?: Array<{
        url: string;
        mimeType: string;
        sizeBytes: number;
        metadata?: Record<string, unknown>;
      }>,
    ): Promise<boolean> => {
      if (previewMessageCreateAttempted) return false;
      previewMessageCreateAttempted = true;
      try {
        const created = await callBridgeWithRateLimitRetry({
          call: () =>
            callAgentChatBridge({
              action: "send_message",
              clientMessageId: config.previewClientMessageId,
              ...config.chatRoute,
              body: input.body,
              format: "markdown",
              ...(attachments ? { attachments } : {}),
              metadata: input.metadata,
            }),
          maxAttempts: input.kind === "processing" ? 4 : 8,
          fallbackDelayMs: input.kind === "processing" ? 220 : 420,
        });
        previewMessageId ??= extractBridgeMessageId(created);
        if (!previewMessageId) {
          for (
            let attempt = 0;
            attempt < 5 && !previewMessageId;
            attempt += 1
          ) {
            if (attempt > 0) {
              await sleep(90 + attempt * 70);
            }
            previewMessageId ??= await maybeResolvePreviewMessageId(true);
          }
        }
        return true;
      } catch (error: unknown) {
        previewMessageCreateAttempted = false;
        throw error;
      }
    };
    if (
      previewMessageId ||
      previewMessageCreateAttempted ||
      input.kind !== "processing"
    ) {
      const edited = await tryEditPreviewMessage(input);
      if (edited) {
        return true;
      }
      if (input.kind !== "processing") {
        const rebound = await rebindPreviewMessageId();
        if (rebound) {
          const editedAfterRebind = await tryEditPreviewMessage(input);
          if (editedAfterRebind) {
            return true;
          }
        }
        if (!previewMessageCreateAttempted) {
          return sendFreshPreviewMessage(input.attachments);
        }
        return false;
      }
    }
    const sent = await sendFreshPreviewMessage(input.attachments);
    if (!sent) {
      await maybeResolvePreviewMessageId(true);
    }
    return sent;
  };

  // -- emitStreamProgress ---------------------------------------------------

  const emitStreamProgress = async (
    progress: MediaGenerationProgress,
  ): Promise<void> => {
    latestMediaProgress = progress;
    if (!previewMessageCreateAttempted) return;
    if (!previewMessageId) {
      await maybeResolvePreviewMessageId(false);
    }
    const nowMs = Date.now();
    if (nowMs - previewProgressUpdatedAtMs < 260) return;
    const fingerprint = [
      progress.contextId ?? "",
      progress.contextStatus ?? "",
      progress.latestPreviewUrl ?? "",
      progress.streamFrameCount,
      progress.latestStreamFrameIndex ?? "",
      progress.hasFinalStreamFrame ? "1" : "0",
      progress.streamRevealProgress,
      progress.timedOut ? "1" : "0",
    ].join("|");
    if (fingerprint === previewProgressFingerprint) return;
    previewProgressFingerprint = fingerprint;
    previewProgressUpdatedAtMs = nowMs;
    const streamDelta = buildStreamPreviewDeltaMetadata({
      frames: progress.streamFrames,
      deltaBaseCount: previewStreamFrameCursor,
      maxDeltaFrames: MAX_PROCESSING_STREAM_FRAME_DELTA,
    });
    const edited = await tryEditPreviewMessage({
      kind: "processing",
      body: config.processingBody,
      metadata: {
        automated: true,
        sourceContext: "CHAT",
        actionPreview: buildProcessingActionPreview({
          progress,
          streamDeltaMetadata: streamDelta?.metadata ?? null,
        }),
      },
    });
    if (!edited) return;
    if (streamDelta) {
      previewStreamFrameCursor = Math.max(
        previewStreamFrameCursor,
        streamDelta.nextFrameCursor,
      );
    }
  };

  // -- Public API -----------------------------------------------------------

  return {
    // Pure helpers (also useful from the main generate function)
    sanitizePreviewUrlForChat,
    buildProcessingActionPreview,
    resolveChatDeliveryUrl,
    snapshotStreamFrames,

    // Bridge-dependent methods
    sendOrEditPreviewMessage,
    emitStreamProgress,

    // State getters
    get previewMessageId() {
      return previewMessageId;
    },
    get latestMediaProgress() {
      return latestMediaProgress;
    },
    get previewStreamFrameCursor() {
      return previewStreamFrameCursor;
    },
    get previewLastEditError() {
      return previewLastEditError;
    },
  };
}

// Convenience type for the returned state object
export type ChatLiteralPreviewStateHandle = ReturnType<
  typeof createChatLiteralPreviewState
>;
