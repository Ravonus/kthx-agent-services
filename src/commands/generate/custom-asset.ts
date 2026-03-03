/** Custom asset parsing, intent resolution, and naming helpers. */

import crypto from "node:crypto";

import type {
  GeneratedCustomAssetKind,
  GeneratedCustomAssetScope,
  GeneratedCustomAssetSaveIntent,
  GeneratedAssetType,
} from "../types.js";

import type { CustomAssetTransformSpec } from "../../media/custom-asset-transform.js";

import {
  asNonEmptyString,
  inferMimeTypeFromUrl,
} from "../helpers.js";

import { isRecord } from "../../lib/guards.js";

// ---------------------------------------------------------------------------
// parseGeneratedCustomAssetKind
// ---------------------------------------------------------------------------

export function parseGeneratedCustomAssetKind(
  value: unknown,
): GeneratedCustomAssetKind | null {
  const normalized = asNonEmptyString(value)?.toLowerCase() ?? "";
  if (normalized === "emote") return "emote";
  if (normalized === "sticker") return "sticker";
  if (normalized === "gif") return "gif";
  return null;
}

// ---------------------------------------------------------------------------
// parseGeneratedCustomAssetScope
// ---------------------------------------------------------------------------

export function parseGeneratedCustomAssetScope(
  value: unknown,
): GeneratedCustomAssetScope | null {
  const normalized = asNonEmptyString(value)?.toLowerCase() ?? "";
  if (normalized === "mine") return "mine";
  if (normalized === "group") return "group";
  if (normalized === "server") return "server";
  return null;
}

// ---------------------------------------------------------------------------
// parseGeneratedCustomAssetTransformSpec
// ---------------------------------------------------------------------------

export function parseGeneratedCustomAssetTransformSpec(
  payload: Record<string, unknown>,
): CustomAssetTransformSpec | undefined {
  const explicitRoot = isRecord(payload.generatedCustomAssetSave)
    ? payload.generatedCustomAssetSave
    : null;
  const explicitTransform = isRecord(explicitRoot?.transform)
    ? explicitRoot.transform
    : isRecord(payload.generatedCustomAssetTransform)
      ? payload.generatedCustomAssetTransform
      : null;
  if (!explicitTransform) return undefined;
  const parseNumeric = (
    value: unknown,
    clampMin: number,
    clampMax: number,
  ): number | undefined => {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return Math.max(clampMin, Math.min(clampMax, value));
  };
  const parseIntNumeric = (
    value: unknown,
    clampMin: number,
    clampMax: number,
  ): number | undefined => {
    const parsed = parseNumeric(value, clampMin, clampMax);
    return typeof parsed === "number" ? Math.floor(parsed) : undefined;
  };
  const fitRaw = asNonEmptyString(explicitTransform.fit)?.toLowerCase();
  const fit =
    fitRaw === "cover" || fitRaw === "contain" || fitRaw === "inside"
      ? fitRaw
      : undefined;
  const formatRaw = asNonEmptyString(explicitTransform.format)?.toLowerCase();
  const format =
    formatRaw === "gif" ||
    formatRaw === "webp" ||
    formatRaw === "png" ||
    formatRaw === "jpeg"
      ? formatRaw
      : undefined;
  const width = parseIntNumeric(explicitTransform.width, 16, 2048);
  const height = parseIntNumeric(explicitTransform.height, 16, 2048);
  const rotateDeg = parseNumeric(explicitTransform.rotateDeg, -360, 360);
  const brightness = parseNumeric(explicitTransform.brightness, 0.1, 3);
  const contrast = parseNumeric(explicitTransform.contrast, 0.2, 3);
  const saturation = parseNumeric(explicitTransform.saturation, 0, 3);
  const blur = parseNumeric(explicitTransform.blur, 0, 20);
  const sharpen = parseNumeric(explicitTransform.sharpen, 0, 10);
  const quality = parseIntNumeric(explicitTransform.quality, 30, 100);
  const spec: CustomAssetTransformSpec = {
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(fit ? { fit } : {}),
    ...(rotateDeg !== undefined ? { rotateDeg } : {}),
    ...(brightness !== undefined ? { brightness } : {}),
    ...(contrast !== undefined ? { contrast } : {}),
    ...(saturation !== undefined ? { saturation } : {}),
    ...(blur !== undefined ? { blur } : {}),
    ...(sharpen !== undefined ? { sharpen } : {}),
    ...(quality !== undefined ? { quality } : {}),
    ...(format ? { format } : {}),
  };
  if (Object.keys(spec).length === 0) return undefined;
  return spec;
}

// ---------------------------------------------------------------------------
// resolveGeneratedCustomAssetSaveIntent
// ---------------------------------------------------------------------------

export function resolveGeneratedCustomAssetSaveIntent(
  payload: Record<string, unknown>,
  sourcePrompt: string,
): GeneratedCustomAssetSaveIntent | null {
  const explicit = isRecord(payload.generatedCustomAssetSave)
    ? payload.generatedCustomAssetSave
    : null;
  if (explicit) {
    if (explicit.disabled === true || explicit.enabled === false) {
      return null;
    }
    const explicitKind = parseGeneratedCustomAssetKind(explicit.kind);
    const explicitScope =
      parseGeneratedCustomAssetScope(explicit.scope) ?? "mine";
    if (explicitKind) {
      return {
        kind: explicitKind,
        scope: explicitScope,
        nameHint: asNonEmptyString(explicit.nameHint),
      };
    }
  }

  const normalized = sourcePrompt.trim().toLowerCase();
  if (!normalized.length) return null;
  const inferredScope: GeneratedCustomAssetScope =
    /\b(?:group|conversation|this group)\b/iu.test(normalized)
      ? "group"
      : /\b(?:server|guild|channel|this server)\b/iu.test(normalized)
        ? "server"
        : "mine";
  const kindCandidates: Array<{
    kind: GeneratedCustomAssetKind;
    index: number;
  }> = [
    { kind: "emote" as const, index: normalized.search(/\bemote(?:s)?\b/iu) },
    { kind: "sticker" as const, index: normalized.search(/\bsticker(?:s)?\b/iu) },
    { kind: "gif" as const, index: normalized.search(/\bgif(?:s)?\b/iu) },
  ].filter((entry) => entry.index >= 0);
  kindCandidates.sort((a, b) => a.index - b.index);
  const inferredKind = kindCandidates[0]?.kind ?? null;

  const hasSaveVerb = /\b(?:attach|add|save|store|put|set)\b/iu.test(normalized);
  const hasTargetHint = /\b(?:to|as|in|into|for)\b/iu.test(normalized);
  if (hasSaveVerb && hasTargetHint && inferredKind) {
    return { kind: inferredKind, scope: inferredScope, nameHint: null };
  }

  const hasGenerateVerb = /\b(?:generate|create|make|render|draw|design)\b/iu.test(
    normalized,
  );
  if (hasGenerateVerb && inferredKind) {
    return { kind: inferredKind, scope: inferredScope, nameHint: null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// buildGeneratedCustomAssetName
// ---------------------------------------------------------------------------

export function buildGeneratedCustomAssetName(input: {
  kind: GeneratedCustomAssetKind;
  sourcePrompt: string;
  nameHint: string | null;
}): string {
  const maxLen = input.kind === "gif" ? 64 : 32;
  const normalized = (input.nameHint ?? input.sourcePrompt)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/gu, " ")
    .replace(/[\s-]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, maxLen);
  if (normalized.length >= 2) return normalized;
  return `${input.kind}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// resolveGeneratedAssetServerId
// ---------------------------------------------------------------------------

export function resolveGeneratedAssetServerId(payload: Record<string, unknown>): string | null {
  const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
  return (
    asNonEmptyString(payload.serverId) ??
    asNonEmptyString(payload.chatServerId) ??
    asNonEmptyString(payload.targetServerId) ??
    asNonEmptyString(chatContext?.serverId)
  );
}

// ---------------------------------------------------------------------------
// resolveGeneratedAssetType
// ---------------------------------------------------------------------------

export function resolveGeneratedAssetType(value: unknown): GeneratedAssetType {
  const normalized = asNonEmptyString(value)?.toLowerCase() ?? "image";
  if (normalized === "gif") return "gif";
  if (normalized === "pdf") return "pdf";
  if (normalized === "csv") return "csv";
  if (normalized === "code") return "code";
  if (normalized === "file") return "file";
  if (normalized === "txt") return "txt";
  if (normalized === "md") return "md";
  return "image";
}

// ---------------------------------------------------------------------------
// resolveGeneratedAttachmentMimeType
// ---------------------------------------------------------------------------

export function resolveGeneratedAttachmentMimeType(input: {
  generatedAssetType: GeneratedAssetType;
  mediaUrl: string;
  mediaType?: "image" | "video";
}): string {
  const fromUrl = inferMimeTypeFromUrl(input.mediaUrl);
  if (fromUrl && fromUrl !== "application/octet-stream") return fromUrl;
  if (input.generatedAssetType === "gif") return "image/gif";
  if (input.generatedAssetType === "pdf") return "application/pdf";
  if (input.generatedAssetType === "csv") return "text/csv";
  if (input.generatedAssetType === "md") return "text/markdown";
  if (input.generatedAssetType === "txt") return "text/plain";
  if (input.generatedAssetType === "code") return "text/plain";
  if (input.mediaType === "video") return "video/mp4";
  return "image/png";
}
