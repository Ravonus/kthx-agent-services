/** Media upload via chunked route — start, append chunks, complete/abort. */

import type { ResolvedMediaUpload } from "../types.js";

import { mapUploadResult } from "./media-curation.js";
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

type UploadChunkFn = (input: unknown) => Promise<unknown>;
type MemoryWriter = { recordWrite(entry: unknown): Promise<void> };

// ---------------------------------------------------------------------------
// uploadBytesViaChunkRoute
// ---------------------------------------------------------------------------

export async function uploadBytesViaChunkRoute(
  deps: { callAgentUploadChunk: UploadChunkFn | null; memory: MemoryWriter },
  input: {
    bytes: Buffer;
    mimeType: string;
    filename: string;
    keepOriginal?: boolean;
  },
): Promise<ResolvedMediaUpload | null> {
  const callAgentUploadChunk = deps.callAgentUploadChunk;
  if (!callAgentUploadChunk) return null;
  const totalBytes = input.bytes.byteLength;
  if (!totalBytes) return null;
  let uploadId: string | null = null;
  try {
    const started = await callAgentUploadChunk({
      op: "start",
      filename: input.filename,
      mimeType: input.mimeType,
      totalBytes,
      keepOriginal: input.keepOriginal === true,
    });
    if (!isRecord(started) || typeof started.uploadId !== "string") {
      throw new Error("chunk_upload_start_invalid");
    }
    uploadId = started.uploadId.trim();
    if (!uploadId.length) {
      throw new Error("chunk_upload_start_missing_id");
    }
    const chunkMaxBytes =
      typeof started.chunkMaxBytes === "number" &&
      Number.isFinite(started.chunkMaxBytes)
        ? Math.max(64 * 1024, Math.floor(started.chunkMaxBytes))
        : 256 * 1024;
    let chunkIndex = 0;
    for (let offset = 0; offset < totalBytes; offset += chunkMaxBytes) {
      const end = Math.min(totalBytes, offset + chunkMaxBytes);
      const chunk = input.bytes.subarray(offset, end);
      await callAgentUploadChunk({
        op: "append",
        uploadId,
        chunkIndex,
        chunkBase64: chunk.toString("base64"),
      });
      chunkIndex += 1;
    }
    const completed = await callAgentUploadChunk({
      op: "complete",
      uploadId,
    });
    return mapUploadResult(completed);
  } catch (error: unknown) {
    await deps.memory
      .recordWrite({
        type: "chunk_upload_failed",
        at: nowIso(),
        filename: input.filename,
        sizeBytes: totalBytes,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    if (uploadId) {
      await callAgentUploadChunk({
        op: "abort",
        uploadId,
      })
        .catch(() => undefined);
    }
    return null;
  }
}
