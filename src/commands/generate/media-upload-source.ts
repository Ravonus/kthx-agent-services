/** Upload resolved media source — data URIs, HTTP URLs, and local files. */

import path from "node:path";
import fs from "node:fs/promises";

import type { ResolvedMediaUpload } from "../types.js";

import {
  isDataUri,
  isHttpUrl,
  parseDataUriPayload,
  sniffMimeTypeFromBytes,
  mimeToExt,
  extToMime,
  inferMimeTypeFromUrl,
} from "../helpers.js";
import { isUploadableMediaMimeType } from "../persona/persona-resolution.js";
import { nowIso } from "../../lib/text.js";

import { mapUploadResult } from "./media-curation.js";
import { uploadBytesViaChunkRoute } from "./media-upload.js";

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

type MemoryWriter = { recordWrite(entry: unknown): Promise<void> };
type UploadDataUriFn = (input: { dataUri: string; keepOriginal?: boolean }) => Promise<unknown>;
type UploadRemoteFn = (input: { url: string; keepOriginal?: boolean }) => Promise<unknown>;
type UploadChunkFn = (input: unknown) => Promise<unknown>;

// ---------------------------------------------------------------------------
// uploadResolvedMediaSource
// ---------------------------------------------------------------------------

export async function uploadResolvedMediaSource(
  deps: {
    memory: MemoryWriter;
    callAgentUploadChunk: UploadChunkFn | null;
    uploadDataUri: UploadDataUriFn;
    uploadRemote: UploadRemoteFn;
  },
  source: string,
  options?: { keepOriginal?: boolean },
): Promise<ResolvedMediaUpload> {
  const keepOriginal = options?.keepOriginal === true;
  const trimmed = source.trim();
  if (isDataUri(trimmed)) {
    const parsed = parseDataUriPayload(trimmed);
    if (!parsed) {
      throw new Error("invalid_data_uri");
    }
    const bytes = Buffer.from(parsed.data, "base64");
    if (!bytes.byteLength) {
      throw new Error("media_source_empty");
    }
    const parsedMime = parsed.mime.trim().toLowerCase();
    const sniffedMime = sniffMimeTypeFromBytes(bytes);
    const resolvedMime =
      isUploadableMediaMimeType(parsedMime)
        ? parsedMime
        : isUploadableMediaMimeType(sniffedMime)
          ? sniffedMime!
          : parsedMime;
    if (!isUploadableMediaMimeType(resolvedMime)) {
      throw new Error(`unsupported_media_payload_mime:${parsedMime}`);
    }
    const normalizedDataUri =
      resolvedMime === parsedMime
        ? trimmed
        : `data:${resolvedMime};base64,${bytes.toString("base64")}`;
    const uploadedByChunk = await uploadBytesViaChunkRoute(
      { callAgentUploadChunk: deps.callAgentUploadChunk, memory: deps.memory },
      {
        bytes,
        mimeType: resolvedMime,
        filename: `upload-${Date.now()}.${mimeToExt(resolvedMime)}`,
        keepOriginal,
      },
    );
    if (uploadedByChunk) return uploadedByChunk;
    const uploaded = await deps.uploadDataUri({
      dataUri: normalizedDataUri,
      keepOriginal,
    });
    return mapUploadResult(uploaded);
  }
  if (isHttpUrl(trimmed)) {
    const inferredMime = inferMimeTypeFromUrl(trimmed);
    if (
      inferredMime &&
      inferredMime !== "application/octet-stream" &&
      !isUploadableMediaMimeType(inferredMime)
    ) {
      throw new Error(`unsupported_media_payload_mime:${inferredMime}`);
    }
    try {
      const uploaded = await deps.uploadRemote({
        url: trimmed,
        keepOriginal,
      });
      return mapUploadResult(uploaded);
    } catch (remoteError: unknown) {
      await deps.memory
        .recordWrite({
          type: "remote_upload_failed",
          at: nowIso(),
          url: trimmed,
          keepOriginal,
          error: remoteError instanceof Error ? remoteError.message : String(remoteError),
        })
        .catch(() => undefined);
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20_000);
        const response = await fetch(trimmed, {
          signal: controller.signal,
          headers: {
            accept: "image/*,video/*;q=0.9,*/*;q=0.1",
            "user-agent": "MoltgramMediaFetcher/1.0",
          },
        }).finally(() => {
          clearTimeout(timeout);
        });
        if (response.ok) {
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.byteLength > 0) {
            const headerMime = response.headers.get("content-type");
            const mimeRaw =
              headerMime && headerMime.trim().length > 0
                ? headerMime
                : inferMimeTypeFromUrl(trimmed) ?? "application/octet-stream";
            const mime = mimeRaw.split(";", 1)[0]?.trim() ?? "application/octet-stream";
            if (!isUploadableMediaMimeType(mime)) {
              throw new Error(`unsupported_media_payload_mime:${mime}`);
            }
            const parsedUrl = new URL(trimmed);
            const baseName = path.basename(parsedUrl.pathname).trim();
            const filename =
              baseName.length > 0
                ? baseName
                : `upload-${Date.now()}.${mimeToExt(mime)}`;
            const uploadedByChunk = await uploadBytesViaChunkRoute(
              { callAgentUploadChunk: deps.callAgentUploadChunk, memory: deps.memory },
              {
                bytes,
                mimeType: mime,
                filename,
                keepOriginal,
              },
            );
            if (uploadedByChunk) {
              await deps.memory
                .recordWrite({
                  type: "remote_upload_fallback_succeeded",
                  at: nowIso(),
                  url: trimmed,
                  keepOriginal,
                  fallback: "chunk",
                })
                .catch(() => undefined);
              return uploadedByChunk;
            }
            const dataUri = `data:${mime};base64,${bytes.toString("base64")}`;
            const uploaded = await deps.uploadDataUri({
              dataUri,
              keepOriginal,
            });
            await deps.memory
              .recordWrite({
                type: "remote_upload_fallback_succeeded",
                at: nowIso(),
                url: trimmed,
                keepOriginal,
                fallback: "data_uri",
              })
              .catch(() => undefined);
            return mapUploadResult(uploaded);
          }
        }
      } catch (fallbackError: unknown) {
        await deps.memory
          .recordWrite({
            type: "remote_upload_fallback_failed",
            at: nowIso(),
            url: trimmed,
            keepOriginal,
            error:
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          })
          .catch(() => undefined);
      }
      throw remoteError;
    }
  }
  const localPath = path.resolve(trimmed);
  const bytes = await fs.readFile(localPath);
  if (!bytes.byteLength) {
    throw new Error("media_source_empty");
  }
  const mimeByExt = extToMime(localPath);
  const mime =
    mimeByExt === "application/octet-stream"
      ? sniffMimeTypeFromBytes(bytes) ?? mimeByExt
      : mimeByExt;
  if (!isUploadableMediaMimeType(mime)) {
    throw new Error(`unsupported_media_payload_mime:${mime}`);
  }
  const uploadedByChunk = await uploadBytesViaChunkRoute(
    { callAgentUploadChunk: deps.callAgentUploadChunk, memory: deps.memory },
    {
      bytes,
      mimeType: mime,
      filename: path.basename(localPath) || `upload-${Date.now()}.${mimeToExt(mime)}`,
      keepOriginal,
    },
  );
  if (uploadedByChunk) return uploadedByChunk;
  const dataUri = `data:${mime};base64,${bytes.toString("base64")}`;
  const uploaded = await deps.uploadDataUri({
    dataUri,
    keepOriginal,
  });
  return mapUploadResult(uploaded);
}
