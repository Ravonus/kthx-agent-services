import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";

export type CustomAssetKind = "emote" | "sticker" | "gif";

export type CustomAssetFitMode = "inside" | "cover" | "contain";

export type CustomAssetOutputFormat = "gif" | "webp" | "png" | "jpeg";

export type CustomAssetTransformSpec = {
  width?: number;
  height?: number;
  fit?: CustomAssetFitMode;
  rotateDeg?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  blur?: number;
  sharpen?: number;
  quality?: number;
  format?: CustomAssetOutputFormat;
};

export type PreparedCustomAssetMedia = {
  bytes: Buffer;
  mimeType: string;
  width: number | null;
  height: number | null;
  transformed: boolean;
  notes: string[];
};

const DOWNLOAD_TIMEOUT_MS = 25_000;
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;

const clampNumber = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const extFromMime = (mimeType: string): string => {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized === "image/png") return "png";
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  if (normalized === "video/mp4") return "mp4";
  if (normalized === "video/quicktime") return "mov";
  if (normalized === "video/webm") return "webm";
  return "bin";
};

const mimeFromFormat = (format: CustomAssetOutputFormat): string => {
  if (format === "gif") return "image/gif";
  if (format === "webp") return "image/webp";
  if (format === "png") return "image/png";
  return "image/jpeg";
};

const maxSideForKind = (kind: CustomAssetKind): number => {
  if (kind === "sticker") return 512;
  return 256;
};

const detectLikelyMime = (sourceMimeType: string, bytes: Buffer): string => {
  const normalized = sourceMimeType.trim().toLowerCase();
  if (normalized.length > 0 && normalized !== "application/octet-stream") {
    return normalized;
  }
  if (
    bytes.byteLength >= 6 &&
    (bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
      bytes.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.byteLength >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    bytes.byteLength >= 12 &&
    bytes.subarray(4, 8).toString("ascii") === "ftyp"
  ) {
    const brand = bytes.subarray(8, 12).toString("ascii").toLowerCase();
    if (brand === "mp41" || brand === "mp42" || brand === "isom") return "video/mp4";
    if (brand === "qt  ") return "video/quicktime";
  }
  return "application/octet-stream";
};

const parseDataUri = (value: string): { mimeType: string; bytes: Buffer } | null => {
  const match = /^data:([^;]+);base64,(.+)$/iu.exec(value.trim());
  if (!match) return null;
  const mimeType = match[1]?.trim().toLowerCase() ?? "";
  const base64Payload = match[2]?.trim() ?? "";
  if (!mimeType.length || !base64Payload.length) return null;
  try {
    const bytes = Buffer.from(base64Payload, "base64");
    if (!bytes.byteLength) return null;
    return { mimeType, bytes };
  } catch {
    return null;
  }
};

const loadSourceBytes = async (sourceUrl: string): Promise<{
  bytes: Buffer;
  sourceMimeType: string;
}> => {
  const trimmed = sourceUrl.trim();
  const parsedDataUri = parseDataUri(trimmed);
  if (parsedDataUri) {
    return {
      bytes: parsedDataUri.bytes,
      sourceMimeType: parsedDataUri.mimeType,
    };
  }

  if (/^https?:\/\//iu.test(trimmed)) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(trimmed, {
        redirect: "follow",
        signal: abortController.signal,
      });
      if (!response.ok) {
        throw new Error(`download_failed_http_${response.status}`);
      }
      const contentLengthRaw = response.headers.get("content-length");
      const contentLength = contentLengthRaw ? Number(contentLengthRaw) : null;
      if (
        typeof contentLength === "number" &&
        Number.isFinite(contentLength) &&
        contentLength > MAX_DOWNLOAD_BYTES
      ) {
        throw new Error("download_too_large");
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.byteLength) {
        throw new Error("download_empty");
      }
      if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
        throw new Error("download_too_large");
      }
      const sourceMimeType =
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ??
        "application/octet-stream";
      return { bytes, sourceMimeType };
    } finally {
      clearTimeout(timeout);
    }
  }

  const absolutePath = path.resolve(trimmed);
  const bytes = await fs.readFile(absolutePath);
  if (!bytes.byteLength) {
    throw new Error("source_file_empty");
  }
  return {
    bytes,
    sourceMimeType: "application/octet-stream",
  };
};

const runFfmpeg = async (args: string[]): Promise<boolean> =>
  await new Promise((resolve) => {
    const ffmpegBin = process.env.MG_AGENT_FFMPEG_BIN?.trim() || "ffmpeg";
    const child = spawn(ffmpegBin, args, {
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });

const transformVideo = async (input: {
  bytes: Buffer;
  sourceMimeType: string;
  kind: CustomAssetKind;
  spec: CustomAssetTransformSpec;
}): Promise<PreparedCustomAssetMedia | null> => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mg-asset-video-"));
  try {
    const inExt = extFromMime(input.sourceMimeType) || "bin";
    const inPath = path.join(tmpDir, `input.${inExt}`);
    await fs.writeFile(inPath, input.bytes);

    const maxSide = clampNumber(
      Math.max(input.spec.width ?? 0, input.spec.height ?? 0) || maxSideForKind(input.kind),
      32,
      2048,
    );

    if (input.kind === "gif") {
      const outPath = path.join(tmpDir, "output.gif");
      const ok = await runFfmpeg([
        "-y",
        "-i",
        inPath,
        "-vf",
        `fps=12,scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease:flags=lanczos`,
        outPath,
      ]);
      if (!ok) return null;
      const outBytes = await fs.readFile(outPath).catch(() => null);
      if (!outBytes?.byteLength) return null;
      return {
        bytes: outBytes,
        mimeType: "image/gif",
        width: null,
        height: null,
        transformed: true,
        notes: ["video_to_gif"],
      };
    }

    const framePath = path.join(tmpDir, "frame.png");
    const extracted = await runFfmpeg([
      "-y",
      "-i",
      inPath,
      "-vf",
      `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease:flags=lanczos`,
      "-frames:v",
      "1",
      framePath,
    ]);
    if (!extracted) return null;
    const frameBytes = await fs.readFile(framePath).catch(() => null);
    if (!frameBytes?.byteLength) return null;
    return {
      bytes: frameBytes,
      mimeType: "image/png",
      width: null,
      height: null,
      transformed: true,
      notes: ["video_to_static_frame"],
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

const chooseOutputFormat = (input: {
  kind: CustomAssetKind;
  spec: CustomAssetTransformSpec;
  sourceMimeType: string;
  isAnimated: boolean;
}): CustomAssetOutputFormat => {
  if (input.spec.format) return input.spec.format;
  if (input.kind === "gif") return "gif";
  if (input.isAnimated || input.sourceMimeType === "image/gif") return "gif";
  return "webp";
};

export const transformCustomAssetMedia = async (input: {
  sourceUrl: string;
  sourceMimeType: string;
  kind: CustomAssetKind;
  spec?: CustomAssetTransformSpec;
}): Promise<PreparedCustomAssetMedia | null> => {
  const spec = input.spec ?? {};
  const loaded = await loadSourceBytes(input.sourceUrl);
  const sourceMimeType = detectLikelyMime(
    input.sourceMimeType || loaded.sourceMimeType,
    loaded.bytes,
  );
  const notes: string[] = [];

  if (sourceMimeType.startsWith("video/")) {
    const transformedVideo = await transformVideo({
      bytes: loaded.bytes,
      sourceMimeType,
      kind: input.kind,
      spec,
    });
    if (transformedVideo) {
      return transformedVideo;
    }
    return {
      bytes: loaded.bytes,
      mimeType: sourceMimeType,
      width: null,
      height: null,
      transformed: false,
      notes: ["video_transform_unavailable"],
    };
  }

  if (!sourceMimeType.startsWith("image/")) {
    return {
      bytes: loaded.bytes,
      mimeType: sourceMimeType,
      width: null,
      height: null,
      transformed: false,
      notes: ["unsupported_source_mime"],
    };
  }

  const inputSharp = sharp(loaded.bytes, {
    animated: true,
    pages: -1,
    failOn: "none",
  });
  const metadata = await inputSharp.metadata().catch(() => null);
  const isAnimated = (metadata?.pages ?? 1) > 1 || sourceMimeType === "image/gif";

  const maxSide = maxSideForKind(input.kind);
  const resizeWidthRaw = spec.width ?? null;
  const resizeHeightRaw = spec.height ?? null;
  const resizeWidth =
    resizeWidthRaw && Number.isFinite(resizeWidthRaw)
      ? clampNumber(Math.floor(resizeWidthRaw), 16, 2048)
      : undefined;
  const resizeHeight =
    resizeHeightRaw && Number.isFinite(resizeHeightRaw)
      ? clampNumber(Math.floor(resizeHeightRaw), 16, 2048)
      : undefined;

  const sourceWidth = metadata?.width ?? null;
  const sourceHeight = metadata?.height ?? null;
  const exceedsDefaultMax =
    typeof sourceWidth === "number" &&
    typeof sourceHeight === "number" &&
    (sourceWidth > maxSide || sourceHeight > maxSide);

  const targetWidth = resizeWidth ?? (exceedsDefaultMax ? maxSide : undefined);
  const targetHeight = resizeHeight ?? (exceedsDefaultMax ? maxSide : undefined);

  let pipeline = sharp(loaded.bytes, {
    animated: isAnimated,
    pages: -1,
    failOn: "none",
  });
  if (targetWidth || targetHeight) {
    const fitMode: keyof sharp.FitEnum =
      spec.fit === "cover" || spec.fit === "contain" ? spec.fit : "inside";
    pipeline = pipeline.resize({
      ...(targetWidth ? { width: targetWidth } : {}),
      ...(targetHeight ? { height: targetHeight } : {}),
      fit: fitMode,
      withoutEnlargement: true,
    });
    notes.push("resized");
  }

  if (typeof spec.rotateDeg === "number" && Number.isFinite(spec.rotateDeg)) {
    pipeline = pipeline.rotate(spec.rotateDeg);
    notes.push("rotated");
  }

  const brightness =
    typeof spec.brightness === "number" && Number.isFinite(spec.brightness)
      ? clampNumber(spec.brightness, 0.1, 3)
      : 1;
  const saturation =
    typeof spec.saturation === "number" && Number.isFinite(spec.saturation)
      ? clampNumber(spec.saturation, 0, 3)
      : 1;
  if (brightness !== 1 || saturation !== 1) {
    pipeline = pipeline.modulate({
      brightness,
      saturation,
    });
    notes.push("modulate");
  }

  if (typeof spec.contrast === "number" && Number.isFinite(spec.contrast)) {
    const contrast = clampNumber(spec.contrast, 0.2, 3);
    const intercept = 128 - 128 * contrast;
    pipeline = pipeline.linear(contrast, intercept);
    notes.push("contrast");
  }

  if (typeof spec.blur === "number" && Number.isFinite(spec.blur) && spec.blur > 0) {
    pipeline = pipeline.blur(clampNumber(spec.blur, 0.1, 20));
    notes.push("blur");
  }

  if (
    typeof spec.sharpen === "number" &&
    Number.isFinite(spec.sharpen) &&
    spec.sharpen > 0
  ) {
    pipeline = pipeline.sharpen(clampNumber(spec.sharpen, 0.1, 10));
    notes.push("sharpen");
  }

  const outputFormat = chooseOutputFormat({
    kind: input.kind,
    spec,
    sourceMimeType,
    isAnimated,
  });
  const quality = clampNumber(
    typeof spec.quality === "number" && Number.isFinite(spec.quality)
      ? spec.quality
      : 82,
    30,
    100,
  );

  if (outputFormat === "gif") {
    pipeline = pipeline.gif({
      effort: 4,
    });
  } else if (outputFormat === "webp") {
    pipeline = pipeline.webp({
      quality,
      effort: 4,
      alphaQuality: 90,
    });
  } else if (outputFormat === "png") {
    pipeline = pipeline.png({
      compressionLevel: 9,
    });
  } else {
    pipeline = pipeline.jpeg({
      quality,
      chromaSubsampling: "4:4:4",
    });
  }
  notes.push(`format:${outputFormat}`);

  const transformed = await pipeline
    .toBuffer({ resolveWithObject: true })
    .catch(() => null);
  if (!transformed?.data?.byteLength) {
    return {
      bytes: loaded.bytes,
      mimeType: sourceMimeType,
      width: sourceWidth,
      height: sourceHeight,
      transformed: false,
      notes: [...notes, "transform_failed"],
    };
  }

  return {
    bytes: transformed.data,
    mimeType: mimeFromFormat(outputFormat),
    width: typeof transformed.info.width === "number" ? transformed.info.width : null,
    height: typeof transformed.info.height === "number" ? transformed.info.height : null,
    transformed: true,
    notes,
  };
};

