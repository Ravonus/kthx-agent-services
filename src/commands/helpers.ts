/**
 * Module-level helper functions for the command executor.
 * Pure functions with no class dependency.
 */

import crypto from "node:crypto";
import path from "node:path";

import { isRecord } from "../lib/guards.js";
import { sleep } from "../lib/async.js";
import { nowIso } from "../lib/text.js";

import {
  AGENT_PROVENANCE_VALUES,
  BRIDGE_RATE_LIMIT_MESSAGE_RE,
  COMMENT_TOKEN_STOP_WORDS,
  RETRY_AFTER_MS_RE,
  RETRY_REMAINING_MS_RE,
} from "./constants.js";
import type {
  GeneratedAssetType,
  ProfileCropSpec,
  Command,
} from "./types.js";

// ---------------------------------------------------------------------------
// URL / URI helpers
// ---------------------------------------------------------------------------

export const isHttpUrl = (value: string): boolean => /^https?:\/\//iu.test(value.trim());
export const isDataUri = (value: string): boolean => /^data:/iu.test(value.trim());
export const isFileUrl = (value: string): boolean => /^file:\/\//iu.test(value.trim());

export const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export const stripEmptyFilesFlag = (command: string, token: string): string => {
  const escaped = escapeRegex(token);
  return command
    .replace(new RegExp(`\\s--files\\s+"${escaped}"`, "giu"), " ")
    .replace(new RegExp(`\\s--files\\s+'${escaped}'`, "giu"), " ")
    .replace(new RegExp(`\\s--files\\s+${escaped}`, "giu"), " ")
    .replace(new RegExp(`\\s-f\\s+"${escaped}"`, "giu"), " ")
    .replace(new RegExp(`\\s-f\\s+'${escaped}'`, "giu"), " ")
    .replace(new RegExp(`\\s-f\\s+${escaped}`, "giu"), " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
};

// ---------------------------------------------------------------------------
// String normalization
// ---------------------------------------------------------------------------

export const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const normalizeAgentProvenanceValue = (value: unknown): string | null => {
  const raw = asNonEmptyString(value);
  if (!raw) return null;
  const normalized = raw.replace(/[-\s]+/gu, "_").toUpperCase();
  if (AGENT_PROVENANCE_VALUES.has(normalized)) return normalized;
  if (
    normalized === "RUNTIME_AUTO_POSTING" ||
    normalized === "RUNTIME_AUTO_CREDIT" ||
    normalized === "AUTO_POSTING" ||
    normalized === "AUTO_CREDIT" ||
    normalized === "AUTO" ||
    normalized === "AUTONOMOUS"
  ) {
    return "AGENT_AUTONOMOUS";
  }
  if (normalized === "USER" || normalized === "DIRECTED") return "USER_DIRECTED";
  if (normalized === "SYSTEM" || normalized === "DIRECTIVE") return "SYSTEM_DIRECTIVE";
  if (normalized === "RESEARCH") return "RESEARCH_ASSISTED";
  return null;
};

export const normalizeInterestTagToken = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^#+/u, "")
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return normalized.length >= 2 ? normalized : null;
};

export const asPositiveInt = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0) return null;
  return Math.floor(value);
};

// ---------------------------------------------------------------------------
// MIME type helpers
// ---------------------------------------------------------------------------

export const extToMime = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".avif") return "image/avif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".csv") return "text/csv";
  if (ext === ".md") return "text/markdown";
  if (ext === ".txt") return "text/plain";
  if (ext === ".json") return "application/json";
  if (ext === ".js") return "text/javascript";
  return "application/octet-stream";
};

export const sniffMimeTypeFromBytes = (bytes: Buffer): string | null => {
  if (bytes.byteLength < 4) return null;
  if (
    bytes.byteLength >= 6 &&
    (bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
      bytes.subarray(0, 6).toString("ascii") === "GIF89a")
  ) return "image/gif";
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.byteLength >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";
  if (bytes.byteLength >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("ascii");
    if (brand === "avif" || brand === "avis") return "image/avif";
    return "video/mp4";
  }
  if (bytes.byteLength >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
    return "video/webm";
  if (bytes.byteLength >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-")
    return "application/pdf";
  const head = bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) {
    if (head.includes("<svg")) return "image/svg+xml";
  }
  return null;
};

export const mimeToExt = (mime: string): string => {
  const normalized = mime.trim().toLowerCase();
  if (normalized === "image/png") return "png";
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/avif") return "avif";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/svg+xml") return "svg";
  if (normalized === "video/mp4") return "mp4";
  if (normalized === "video/quicktime") return "mov";
  if (normalized === "video/webm") return "webm";
  if (normalized === "application/pdf") return "pdf";
  if (normalized === "text/csv") return "csv";
  if (normalized === "text/markdown") return "md";
  if (normalized === "text/plain") return "txt";
  if (normalized === "application/json") return "json";
  if (normalized === "text/javascript") return "js";
  return "bin";
};

export const inferMimeTypeFromUrl = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  try {
    const parsed = new URL(trimmed);
    return extToMime(parsed.pathname);
  } catch {
    return extToMime(trimmed);
  }
};

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export const truncateText = (value: string, maxChars: number): string => {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(8, maxChars - 1))}…`;
};

export const stripEmDashCharacters = (value: string): string =>
  value.replace(/[—–]/gu, "-");

// ---------------------------------------------------------------------------
// Rate limit & retry
// ---------------------------------------------------------------------------

export const normalizeDelayMs = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
};

export const parseRetryDelayFromMessage = (value: string): number | null => {
  const retryAfterMatch = RETRY_AFTER_MS_RE.exec(value);
  if (retryAfterMatch?.[1]) {
    const parsed = Number.parseInt(retryAfterMatch[1], 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  const remainingMatch = RETRY_REMAINING_MS_RE.exec(value);
  if (remainingMatch?.[1]) {
    const parsed = Number.parseInt(remainingMatch[1], 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
};

export const extractStatusCode = (
  value: Record<string, unknown> | null,
  depth = 0,
): number | null => {
  if (!value || depth > 4) return null;
  const directStatus = normalizeDelayMs(value.status);
  if (directStatus !== null) return directStatus;
  const directStatusCode = normalizeDelayMs(value.statusCode);
  if (directStatusCode !== null) return directStatusCode;
  const directHttpStatus = normalizeDelayMs(value.httpStatus);
  if (directHttpStatus !== null) return directHttpStatus;
  const nestedCause = isRecord(value.cause) ? value.cause : null;
  if (nestedCause) {
    const nestedStatus = extractStatusCode(nestedCause, depth + 1);
    if (nestedStatus !== null) return nestedStatus;
  }
  return null;
};

export const extractRetryAfterMs = (
  value: Record<string, unknown> | null,
  depth = 0,
): number | null => {
  if (!value || depth > 4) return null;
  const direct =
    normalizeDelayMs(value.retryAfterMs) ??
    normalizeDelayMs(value.retry_after_ms) ??
    normalizeDelayMs(value.retryAfter);
  if (direct !== null) return direct;
  if (typeof value.message === "string") {
    const fromMessage = parseRetryDelayFromMessage(value.message);
    if (fromMessage !== null) return fromMessage;
  }
  const nestedCause = isRecord(value.cause) ? value.cause : null;
  if (nestedCause) {
    const nested = extractRetryAfterMs(nestedCause, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
};

export const isBridgeRateLimitedError = (error: unknown): boolean => {
  if (error instanceof Error) {
    const record = error as Error & { status?: unknown; cause?: unknown };
    if (normalizeDelayMs(record.status) === 429) return true;
    const nestedStatus = extractStatusCode(
      isRecord(record.cause) ? record.cause : null,
    );
    if (nestedStatus === 429) return true;
    return BRIDGE_RATE_LIMIT_MESSAGE_RE.test(error.message);
  }
  if (isRecord(error)) {
    const status = extractStatusCode(error);
    if (status === 429) return true;
    const message =
      typeof error.message === "string"
        ? error.message
        : typeof error.error === "string"
          ? error.error
          : null;
    return message ? BRIDGE_RATE_LIMIT_MESSAGE_RE.test(message) : false;
  }
  if (typeof error === "string") {
    return BRIDGE_RATE_LIMIT_MESSAGE_RE.test(error);
  }
  return false;
};

export const resolveBridgeRetryDelayMs = (
  error: unknown,
  fallbackMs: number,
  attempt: number,
): number => {
  const maxDelayMs = 20_000;
  const fromError = extractRetryAfterMs(isRecord(error) ? error : null);
  if (fromError !== null) {
    return Math.min(maxDelayMs, Math.max(120, fromError + attempt * 50));
  }
  if (error instanceof Error) {
    const fromMessage = parseRetryDelayFromMessage(error.message);
    if (fromMessage !== null) {
      return Math.min(maxDelayMs, Math.max(120, fromMessage + attempt * 50));
    }
  }
  return Math.min(maxDelayMs, Math.max(120, fallbackMs + attempt * 120));
};

export const callBridgeWithRateLimitRetry = async <T>(input: {
  call: () => Promise<T>;
  maxAttempts: number;
  fallbackDelayMs: number;
}): Promise<T> => {
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts));
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await input.call();
    } catch (error: unknown) {
      lastError = error;
      if (attempt >= maxAttempts - 1 || !isBridgeRateLimitedError(error)) {
        throw error;
      }
      const delayMs = resolveBridgeRetryDelayMs(error, input.fallbackDelayMs, attempt);
      await sleep(delayMs);
    }
  }
  throw (lastError instanceof Error ? lastError : new Error("bridge_retry_exhausted"));
};

// ---------------------------------------------------------------------------
// Misc utilities
// ---------------------------------------------------------------------------

export const toUnknownArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

export const extractBridgeMessageId = (value: unknown): string | null => {
  const fromRecord = (
    record: Record<string, unknown>,
    depth: number,
  ): string | null => {
    if (depth > 8) return null;
    const message = isRecord(record.message) ? record.message : null;
    const nestedMessageId = message
      ? asNonEmptyString(message.id) ??
        asNonEmptyString(message.messageId) ??
        asNonEmptyString(message.message_id)
      : null;
    if (nestedMessageId) return nestedMessageId;
    const directMessageId =
      asNonEmptyString(record.messageId) ?? asNonEmptyString(record.message_id);
    if (directMessageId) return directMessageId;
    const directId = asNonEmptyString(record.id);
    if (directId) return directId;
    for (const key of ["primary", "data", "result", "payload", "response"] as const) {
      const nested = isRecord(record[key]) ? record[key] : null;
      if (!nested) continue;
      const resolved = fromRecord(nested, depth + 1);
      if (resolved) return resolved;
    }
    return null;
  };
  if (!isRecord(value)) return null;
  return fromRecord(value, 0);
};

export const isMissingFileError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const code =
    typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code?: unknown }).code)
      : "";
  if (code.toUpperCase() === "ENOENT") return true;
  return /enoent|no such file or directory/iu.test(error.message);
};

export const constrainGifPromptTo256 = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.length) return trimmed;
  if (/\b256\s*[x×]\s*256\b/iu.test(trimmed)) return trimmed;
  return `${trimmed}. Exact output size: 256x256. Keep subject centered, motion readable, and loop-friendly.`;
};

export const outputExtensionForGeneratedAssetType = (
  generatedAssetType: GeneratedAssetType,
): string => {
  if (generatedAssetType === "image") return "png";
  if (generatedAssetType === "gif") return "gif";
  if (generatedAssetType === "pdf") return "pdf";
  if (generatedAssetType === "csv") return "csv";
  if (generatedAssetType === "md") return "md";
  if (generatedAssetType === "txt") return "txt";
  if (generatedAssetType === "code") return "js";
  return "bin";
};

// ---------------------------------------------------------------------------
// Comment text analysis
// ---------------------------------------------------------------------------

export const normalizeCommentText = (value: string): string =>
  value.trim().replace(/\s+/gu, " ").toLowerCase();

export const tokenizeCommentText = (value: string): string[] =>
  normalizeCommentText(value)
    .replace(/[^a-z0-9\s]/gu, " ")
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 2 &&
        token.length <= 24 &&
        !COMMENT_TOKEN_STOP_WORDS.has(token) &&
        !/^\d+$/u.test(token),
    );

export const computeTokenOverlapRatio = (candidate: string, reference: string): number => {
  const candidateTokens = Array.from(new Set(tokenizeCommentText(candidate)));
  if (candidateTokens.length === 0) return 0;
  const referenceTokens = new Set(tokenizeCommentText(reference));
  if (referenceTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of candidateTokens) {
    if (referenceTokens.has(token)) overlap += 1;
  }
  return overlap / candidateTokens.length;
};

export const hasLongNormalizedPhraseOverlap = (
  candidate: string,
  reference: string,
): boolean => {
  const normalizedCandidate = normalizeCommentText(candidate);
  const normalizedReference = normalizeCommentText(reference);
  if (normalizedCandidate.length < 18 || normalizedReference.length < 18) return false;
  const [shorter, longer] =
    normalizedCandidate.length <= normalizedReference.length
      ? [normalizedCandidate, normalizedReference]
      : [normalizedReference, normalizedCandidate];
  if (shorter.length < 18) return false;
  return longer.includes(shorter);
};

// ---------------------------------------------------------------------------
// Profile crop specs
// ---------------------------------------------------------------------------

const roundNorm = (value: number): number =>
  Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
const roundValue = (value: number): number =>
  Math.round(value * 1000) / 1000;

export const buildProfileCropSpec = (target: "avatar" | "banner"): ProfileCropSpec => {
  if (target === "avatar") {
    return {
      target,
      outputAspect: 1,
      focalPoint: { x: 0.5, y: 0.42 },
      safeZone: { x: 0.18, y: 0.16, width: 0.64, height: 0.64 },
      avoidEdges: { top: 0.08, right: 0.08, bottom: 0.08, left: 0.08 },
      guidance:
        "Keep the face/primary subject in the center 64% square and avoid placing key details near the outer 8% edge (circular crop loss).",
    };
  }
  return {
    target,
    outputAspect: 3,
    focalPoint: { x: 0.5, y: 0.38 },
    safeZone: { x: 0.08, y: 0.18, width: 0.84, height: 0.64 },
    textSafeZone: { x: 0.12, y: 0.24, width: 0.76, height: 0.48 },
    avoidEdges: { top: 0.1, right: 0.08, bottom: 0.1, left: 0.08 },
    guidance:
      "Keep core visuals inside the center safe zone (84% x 64%) and reserve top/bottom edges; put text/logo inside the text-safe band.",
  };
};

export const normalizeProfileCropSpec = (spec: ProfileCropSpec): ProfileCropSpec => ({
  ...spec,
  outputAspect: roundValue(spec.outputAspect),
  focalPoint: {
    x: roundNorm(spec.focalPoint.x),
    y: roundNorm(spec.focalPoint.y),
  },
  safeZone: {
    x: roundNorm(spec.safeZone.x),
    y: roundNorm(spec.safeZone.y),
    width: roundNorm(spec.safeZone.width),
    height: roundNorm(spec.safeZone.height),
  },
  avoidEdges: {
    top: roundNorm(spec.avoidEdges.top),
    right: roundNorm(spec.avoidEdges.right),
    bottom: roundNorm(spec.avoidEdges.bottom),
    left: roundNorm(spec.avoidEdges.left),
  },
  ...(spec.textSafeZone
    ? {
        textSafeZone: {
          x: roundNorm(spec.textSafeZone.x),
          y: roundNorm(spec.textSafeZone.y),
          width: roundNorm(spec.textSafeZone.width),
          height: roundNorm(spec.textSafeZone.height),
        },
      }
    : {}),
});

export const buildProfileCropPromptHint = (spec: ProfileCropSpec): string => {
  if (spec.target === "avatar") {
    return [
      "Crop-safe avatar composition requirements:",
      "- Single clear subject, forward-facing, upper-center focus.",
      "- Keep the subject inside the center 64% safe square.",
      "- Leave the outer 8% edge clean to survive circular crop masking.",
    ].join("\n");
  }
  return [
    "Crop-safe banner composition requirements:",
    "- Compose for a 3:1 banner frame with focal point slightly above center.",
    "- Keep essential visuals inside the center safe zone (84% x 64%).",
    "- Keep top/bottom 10% and side 8% relatively clean for variable viewport crops.",
    "- Keep text/logo inside the inner text-safe zone.",
  ].join("\n");
};

// ---------------------------------------------------------------------------
// Data URI parsing
// ---------------------------------------------------------------------------

export const parseDataUriPayload = (
  value: string,
): { mime: string; data: string } | null => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("data:")) return null;
  const commaIndex = trimmed.indexOf(",");
  if (commaIndex <= "data:".length) return null;
  const metadataRaw = trimmed.slice("data:".length, commaIndex).trim();
  const data = trimmed.slice(commaIndex + 1).trim();
  if (!metadataRaw.length || !data.length) return null;
  const metadataParts = metadataRaw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const mime = metadataParts[0]?.toLowerCase() ?? "";
  if (!mime.length || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(mime)) return null;
  const hasBase64 = metadataParts
    .slice(1)
    .some((part) => part.toLowerCase() === "base64");
  if (!hasBase64) return null;
  return { mime, data };
};

// ---------------------------------------------------------------------------
// Execution digest
// ---------------------------------------------------------------------------

export const buildExecutionDigest = (command: Command, ok: boolean, error: string | null): string =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        id: command.id,
        kind: command.kind,
        ok,
        error,
        at: nowIso(),
      }),
    )
    .digest("hex");
