/** Custom asset save — transform, upload, and persist generated custom assets (stickers, GIFs). */

import type { Command } from "../../types/ipc.js";
import type {
  GeneratedCustomAssetKind,
  GeneratedCustomAssetSaveIntent,
  GeneratedCustomAssetSaveResult,
  ResolvedMediaUpload,
} from "../types.js";
import type { CustomAssetTransformSpec } from "../../media/custom-asset-transform.js";

import { transformCustomAssetMedia } from "../../media/custom-asset-transform.js";
import { asNonEmptyString, mimeToExt, truncateText } from "../helpers.js";
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";

import {
  parseGeneratedCustomAssetTransformSpec,
  resolveGeneratedAssetServerId,
  buildGeneratedCustomAssetName,
} from "./custom-asset.js";

import { mapUploadResult } from "./media-curation.js";
import { uploadBytesViaChunkRoute } from "./media-upload.js";

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

type MemoryWriter = { recordWrite(entry: unknown): Promise<void> };
type UploadDataUriFn = (input: { dataUri: string; keepOriginal?: boolean }) => Promise<unknown>;
type UploadChunkFn = (input: unknown) => Promise<unknown>;
type ChatBridgeFn = (input: unknown) => Promise<unknown>;

// ---------------------------------------------------------------------------
// prepareGeneratedCustomAssetForSave
// ---------------------------------------------------------------------------

export async function prepareGeneratedCustomAssetForSave(
  deps: {
    memory: MemoryWriter;
    callAgentUploadChunk: UploadChunkFn | null;
    uploadDataUri: UploadDataUriFn;
  },
  input: {
    command: Command;
    payload: Record<string, unknown>;
    sourcePrompt: string;
    sourceUrl: string;
    sourceMimeType: string;
    intent: GeneratedCustomAssetSaveIntent;
  },
): Promise<{
  mediaUrl: string;
  mimeType: string;
  width: number | undefined;
  height: number | undefined;
  isAnimated: boolean | undefined;
  transformNotes: string[];
}> {
  const fallbackMimeType = input.sourceMimeType;
  const transformSpec = parseGeneratedCustomAssetTransformSpec(input.payload);
  try {
    const transformed = await transformCustomAssetMedia({
      sourceUrl: input.sourceUrl,
      sourceMimeType: input.sourceMimeType,
      kind: input.intent.kind,
      ...(transformSpec ? { spec: transformSpec } : {}),
    });
    if (!transformed?.bytes?.byteLength) {
      return {
        mediaUrl: input.sourceUrl,
        mimeType: fallbackMimeType,
        width: undefined,
        height: undefined,
        isAnimated:
          input.intent.kind === "gif" || fallbackMimeType.trim().toLowerCase() === "image/gif"
            ? true
            : undefined,
        transformNotes: ["transform_skipped_empty_output"],
      };
    }

    const fileExt = mimeToExt(transformed.mimeType);
    const uploadFilename = `${input.intent.kind}-${Date.now()}.${fileExt}`;
    const chunkUploaded = await uploadBytesViaChunkRoute(
      { callAgentUploadChunk: deps.callAgentUploadChunk, memory: deps.memory },
      {
        bytes: transformed.bytes,
        mimeType: transformed.mimeType,
        filename: uploadFilename,
      },
    );
    const uploaded =
      chunkUploaded ??
      mapUploadResult(
        await deps.uploadDataUri({
          dataUri: `data:${transformed.mimeType};base64,${transformed.bytes.toString("base64")}`,
        }),
      );
    const transformedMime = transformed.mimeType.trim().toLowerCase();
    return {
      mediaUrl: uploaded.mediaUrl,
      mimeType: transformedMime || fallbackMimeType,
      width:
        typeof transformed.width === "number" && Number.isFinite(transformed.width)
          ? transformed.width
          : undefined,
      height:
        typeof transformed.height === "number" && Number.isFinite(transformed.height)
          ? transformed.height
          : undefined,
      isAnimated:
        input.intent.kind === "gif" || transformedMime === "image/gif" ? true : undefined,
      transformNotes: transformed.notes,
    };
  } catch (error: unknown) {
    await deps.memory
      .recordWrite({
        type: "generated_custom_asset_transform_failed",
        at: nowIso(),
        commandId: input.command.id,
        kind: input.intent.kind,
        sourcePrompt: truncateText(input.sourcePrompt, 220),
        sourceUrl: input.sourceUrl,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    return {
      mediaUrl: input.sourceUrl,
      mimeType: fallbackMimeType,
      width: undefined,
      height: undefined,
      isAnimated:
        input.intent.kind === "gif" || fallbackMimeType.trim().toLowerCase() === "image/gif"
          ? true
          : undefined,
      transformNotes: ["transform_failed_fallback_source"],
    };
  }
}

// ---------------------------------------------------------------------------
// saveGeneratedCustomAsset
// ---------------------------------------------------------------------------

export async function saveGeneratedCustomAsset(
  deps: {
    memory: MemoryWriter;
    callAgentChatBridge: ChatBridgeFn;
    callAgentUploadChunk: UploadChunkFn | null;
    uploadDataUri: UploadDataUriFn;
  },
  input: {
    command: Command;
    payload: Record<string, unknown>;
    intent: GeneratedCustomAssetSaveIntent;
    sourcePrompt: string;
    mediaUrl: string;
    mimeType: string;
    chatTarget: { conversationId?: string; channelId?: string };
  },
): Promise<GeneratedCustomAssetSaveResult> {
  if (input.intent.scope === "group" && !input.chatTarget.conversationId) {
    throw new Error("group_custom_asset_requires_conversation_context");
  }

  const serverId = resolveGeneratedAssetServerId(input.payload);
  if (input.intent.scope === "server" && !serverId) {
    throw new Error("server_custom_asset_requires_server_id");
  }

  const name = buildGeneratedCustomAssetName({
    kind: input.intent.kind,
    sourcePrompt: input.sourcePrompt,
    nameHint: input.intent.nameHint,
  });

  const prepared = await prepareGeneratedCustomAssetForSave(
    {
      memory: deps.memory,
      callAgentUploadChunk: deps.callAgentUploadChunk,
      uploadDataUri: deps.uploadDataUri,
    },
    {
      command: input.command,
      payload: input.payload,
      sourcePrompt: input.sourcePrompt,
      sourceUrl: input.mediaUrl,
      sourceMimeType: input.mimeType,
      intent: input.intent,
    },
  );

  const result = await deps.callAgentChatBridge({
    action: "save_custom_asset",
    kind: input.intent.kind,
    scope: input.intent.scope,
    name,
    url: prepared.mediaUrl,
    ...(input.intent.kind === "gif" ? { previewUrl: prepared.mediaUrl } : {}),
    mimeType: prepared.mimeType,
    ...(prepared.width !== undefined ? { width: prepared.width } : {}),
    ...(prepared.height !== undefined ? { height: prepared.height } : {}),
    ...(prepared.isAnimated !== undefined
      ? { isAnimated: prepared.isAnimated }
      : {}),
    ...(input.chatTarget.conversationId
      ? { conversationId: input.chatTarget.conversationId }
      : {}),
    ...(serverId ? { serverId } : {}),
  });

  if (prepared.transformNotes.length > 0) {
    await deps.memory
      .recordWrite({
        type: "generated_custom_asset_saved",
        at: nowIso(),
        commandId: input.command.id,
        kind: input.intent.kind,
        scope: input.intent.scope,
        sourceUrl: input.mediaUrl,
        savedUrl: prepared.mediaUrl,
        transformNotes: prepared.transformNotes,
      })
      .catch(() => undefined);
  }

  const resultRecord = isRecord(result) ? result : null;
  const savedRecord = resultRecord && isRecord(resultRecord.saved)
    ? resultRecord.saved
    : null;
  const id =
    savedRecord && typeof savedRecord.id === "number" && Number.isFinite(savedRecord.id)
      ? Math.floor(savedRecord.id)
      : null;
  return {
    kind: input.intent.kind,
    scope: input.intent.scope,
    name,
    id,
    url: asNonEmptyString(savedRecord?.url),
    mimeType: asNonEmptyString(savedRecord?.mimeType)?.toLowerCase() ?? null,
  };
}
