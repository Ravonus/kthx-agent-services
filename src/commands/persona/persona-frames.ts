/** Persona frame management, bootstrapping, and reference resolution. */

import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";

import {
  asNonEmptyString,
  asPositiveInt,
  truncateText,
  inferMimeTypeFromUrl,
} from "../helpers.js";

import {
  MAX_MEDIA_REFERENCE_INPUTS,
  REQUIRED_PERSONA_REFERENCE_FRAME_COUNT,
  PERSONA_REFERENCE_MAX_SIDE,
  PERSONA_REFERENCE_JPEG_QUALITY,
} from "../constants.js";

import type {
  PersonaFrameRecord,
  PersonaFrameRole,
  PersonaReferencePlan,
  PersonaReferenceResolution,
  ResolvedMediaUpload,
  CommandExecutorContext,
  AgentRouterLike,
  AgentMutator,
  AgentQuery,
  Command,
} from "../types.js";

import { PERSONA_REFERENCE_FRAME_ROLES } from "../types.js";

import {
  normalizePersonaSlug,
  isGenericPersonaSlug,
  isLikelyImageReference,
  isImageMimeType,
  shouldUsePersonaFrameReferences,
  resolvePersonaReferencePlan,
  resolveMainPersonaSlugFromBridge,
  type CallBridgeLookupCachedFn,
  type ResolveRequestedGenerateKindsFn,
} from "./persona-resolution.js";

// ---------------------------------------------------------------------------
// Callback signatures for methods that still live on the class
// ---------------------------------------------------------------------------

/**
 * Matches `CommandExecutor.collectMediaReferenceInputs`.
 */
export type CollectMediaReferenceInputsFn = (
  payload: Record<string, unknown>,
  options: { includeRecentGeneratedAsset: boolean },
) => string[];

/**
 * Matches `CommandExecutor.isStreamPartArtifactReference`.
 */
export type IsStreamPartArtifactReferenceFn = (value: string | null | undefined) => boolean;

/**
 * Matches `CommandExecutor.resolvePreferredMediaUrl`.
 */
export type ResolvePreferredMediaUrlFn = (
  ...values: Array<string | null | undefined>
) => string | null;

/**
 * Matches `CommandExecutor.generateAndUploadMediaFromPrompt`.
 */
export type GenerateAndUploadMediaFromPromptFn = (
  prompt: string,
  options: {
    generatedAssetType: string;
    mode: string;
    referenceInputs: string[];
    keepOriginal: boolean;
    commandId: string;
  },
) => Promise<ResolvedMediaUpload>;

/**
 * Matches `CommandExecutor.uploadBytesViaChunkRoute`.
 */
export type UploadBytesViaChunkRouteFn = (input: {
  bytes: Buffer;
  mimeType: string;
  filename: string;
  keepOriginal: boolean;
}) => Promise<ResolvedMediaUpload | null>;

/**
 * Matches `CommandExecutor.mapUploadResult`.
 */
export type MapUploadResultFn = (uploaded: unknown) => ResolvedMediaUpload;

/**
 * Transform spec matching the custom-asset-transform module.
 */
export type TransformCustomAssetMediaFn = (input: {
  sourceUrl: string;
  sourceMimeType: string;
  kind: string;
  spec: {
    width: number;
    height: number;
    fit: string;
    format: string;
    quality: number;
  };
}) => Promise<{ bytes: Buffer; mimeType: string } | null>;

// ---------------------------------------------------------------------------
// Shared deps bundle passed into most frame-management functions
// ---------------------------------------------------------------------------

export type PersonaFrameDeps = {
  ctx: CommandExecutorContext;
  agent: () => AgentRouterLike;
  agentQueryOptional: (name: string) => AgentQuery | null;
  agentMutatorOptional: (name: string) => AgentMutator | null;
  callBridgeLookupCached: CallBridgeLookupCachedFn;
  collectMediaReferenceInputs: CollectMediaReferenceInputsFn;
  isStreamPartArtifactReference: IsStreamPartArtifactReferenceFn;
  resolvePreferredMediaUrl: ResolvePreferredMediaUrlFn;
  generateAndUploadMediaFromPrompt: GenerateAndUploadMediaFromPromptFn;
  uploadBytesViaChunkRoute: UploadBytesViaChunkRouteFn;
  mapUploadResult: MapUploadResultFn;
  transformCustomAssetMedia: TransformCustomAssetMediaFn;
  resolveRequestedGenerateKinds: ResolveRequestedGenerateKindsFn;
};

// ---------------------------------------------------------------------------
// collectPersonaSeedReferenceInputs
// ---------------------------------------------------------------------------

export function collectPersonaSeedReferenceInputs(
  input: {
    payload: Record<string, unknown>;
    fallbackReferenceInputs: string[];
  },
  deps: Pick<
    PersonaFrameDeps,
    "collectMediaReferenceInputs" | "isStreamPartArtifactReference"
  >,
): string[] {
  const directInputs = deps.collectMediaReferenceInputs(input.payload, {
    includeRecentGeneratedAsset: false,
  });
  const deduped = new Set<string>();
  const push = (value: string | null | undefined): void => {
    const normalized = asNonEmptyString(value);
    if (!normalized || deps.isStreamPartArtifactReference(normalized)) return;
    if (!isLikelyImageReference(normalized)) return;
    deduped.add(normalized);
  };
  for (const entry of directInputs) push(entry);
  for (const entry of input.fallbackReferenceInputs) push(entry);

  const recent = isRecord(input.payload.recentGeneratedAsset)
    ? input.payload.recentGeneratedAsset
    : null;
  const recentType = asNonEmptyString(recent?.type)?.toLowerCase() ?? "";
  if (recentType === "persona" || recentType === "avatar") {
    push(asNonEmptyString(recent?.href));
    push(asNonEmptyString(recent?.url));
    push(asNonEmptyString(recent?.imageUrl));
    push(asNonEmptyString(recent?.mediaUrl));
  }
  return [...deduped].slice(0, MAX_MEDIA_REFERENCE_INPUTS);
}

// ---------------------------------------------------------------------------
// collectAgentProfilePersonaSeedReferences
// ---------------------------------------------------------------------------

export async function collectAgentProfilePersonaSeedReferences(
  deps: Pick<
    PersonaFrameDeps,
    "ctx" | "callBridgeLookupCached" | "isStreamPartArtifactReference"
  >,
): Promise<string[]> {
  if (!deps.ctx.callAgentChatBridge) return [];
  try {
    const response = await deps.callBridgeLookupCached({
      action: "agent_profile",
    });
    const root = isRecord(response.value) ? response.value : null;
    if (!root) return [];
    const agent = isRecord(root.agent) ? root.agent : null;
    const profile = isRecord(root.profile) ? root.profile : null;
    const config = isRecord(root.config) ? root.config : null;
    const urls = new Set<string>();
    const push = (value: unknown): void => {
      const direct = asNonEmptyString(value);
      if (direct) {
        urls.add(direct);
        return;
      }
      if (!isRecord(value)) return;
      const nestedUrl =
        asNonEmptyString(value.url) ??
        asNonEmptyString(value.href) ??
        asNonEmptyString(value.imageUrl) ??
        asNonEmptyString(value.mediaUrl) ??
        asNonEmptyString(value.mediaOptimizedUrl) ??
        asNonEmptyString(value.optimizedUrl) ??
        null;
      if (nestedUrl) urls.add(nestedUrl);
    };
    for (const source of [root, agent, profile, config]) {
      if (!source) continue;
      push(source.avatarUrl);
      push(source.profileImageUrl);
      push(source.imageUrl);
      push(source.photoUrl);
      push(source.profilePhotoUrl);
      push(source.pfpUrl);
      push(source.avatar);
      push(source.image);
      push(source.photo);
      push(source.mediaOptimizedUrl);
      push(source.optimizedUrl);
    }
    return [...urls]
      .filter(
        (entry) =>
          !deps.isStreamPartArtifactReference(entry) &&
          isLikelyImageReference(entry),
      )
      .slice(0, MAX_MEDIA_REFERENCE_INPUTS);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// updatePersonaReferenceSnapshot
// ---------------------------------------------------------------------------

export function updatePersonaReferenceSnapshot(
  input: {
    mainPersonaSlug: string;
    personaSlug: string;
    source: string;
    frameReferences: string[];
    builtFrames: boolean;
    variantKey: string | null;
  },
  ctx: CommandExecutorContext,
): void {
  const stateDb = ctx.stateDb;
  if (!stateDb?.enabled) return;
  const scope = "runtime.persona.references";
  const existing = stateDb.getSnapshot<Record<string, unknown>>(scope);
  const previousPersonas = isRecord(existing) && isRecord(existing.personas)
    ? existing.personas
    : {};
  const nextPersonas: Record<string, unknown> = {
    ...previousPersonas,
    [input.personaSlug]: {
      mainPersonaSlug: input.mainPersonaSlug,
      source: input.source,
      frameCount: input.frameReferences.length,
      frameReferences: input.frameReferences.slice(0, REQUIRED_PERSONA_REFERENCE_FRAME_COUNT),
      builtFrames: input.builtFrames,
      variantKey: input.variantKey,
      updatedAt: nowIso(),
    },
  };
  if (!isRecord(nextPersonas[input.mainPersonaSlug])) {
    nextPersonas[input.mainPersonaSlug] = {
      mainPersonaSlug: input.mainPersonaSlug,
      source: "main_persona",
      frameCount: input.frameReferences.length,
      frameReferences: input.frameReferences.slice(0, REQUIRED_PERSONA_REFERENCE_FRAME_COUNT),
      builtFrames: input.builtFrames,
      variantKey: null,
      updatedAt: nowIso(),
    };
  }
  stateDb.upsertSnapshot({
    scope,
    visibility: "private",
    data: {
      mainPersonaSlug: input.mainPersonaSlug,
      updatedAt: nowIso(),
      personas: nextPersonas,
    },
  });
}

// ---------------------------------------------------------------------------
// normalizePersonaFrameRole
// ---------------------------------------------------------------------------

export function normalizePersonaFrameRole(value: unknown): PersonaFrameRole | null {
  const normalized = asNonEmptyString(value)?.toLowerCase() ?? "";
  if (normalized === "selfie") return "selfie";
  if (normalized === "midshot" || normalized === "halfbody" || normalized === "half_body") {
    return "midshot";
  }
  if (
    normalized === "fullbody" ||
    normalized === "full_body" ||
    normalized === "full" ||
    normalized === "fullshot" ||
    normalized === "full_shot"
  ) {
    return "fullbody";
  }
  return null;
}

// ---------------------------------------------------------------------------
// parseIsoOrNull
// ---------------------------------------------------------------------------

export function parseIsoOrNull(value: unknown): string | null {
  const text = asNonEmptyString(value);
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

// ---------------------------------------------------------------------------
// parsePersonaFrameRecords
// ---------------------------------------------------------------------------

export function parsePersonaFrameRecords(value: unknown): PersonaFrameRecord[] {
  const asRows = (input: unknown): unknown[] => {
    if (Array.isArray(input)) return input;
    if (isRecord(input) && Array.isArray(input.frames)) return input.frames;
    return [];
  };
  const records: PersonaFrameRecord[] = [];
  for (const rawEntry of asRows(value)) {
    if (!isRecord(rawEntry)) continue;
    const idRaw =
      asPositiveInt(rawEntry.id) ??
      (typeof rawEntry.id === "number" && Number.isFinite(rawEntry.id)
        ? Math.max(1, Math.floor(rawEntry.id))
        : null);
    const personaSlug = normalizePersonaSlug(rawEntry.personaSlug);
    const frameRole = normalizePersonaFrameRole(rawEntry.frameRole);
    const mediaUrl = asNonEmptyString(rawEntry.mediaUrl);
    if (!idRaw || !personaSlug || !frameRole || !mediaUrl) continue;
    const width =
      typeof rawEntry.width === "number" && Number.isFinite(rawEntry.width)
        ? Math.max(1, Math.floor(rawEntry.width))
        : null;
    const height =
      typeof rawEntry.height === "number" && Number.isFinite(rawEntry.height)
        ? Math.max(1, Math.floor(rawEntry.height))
        : null;
    const sizeBytes =
      typeof rawEntry.sizeBytes === "number" && Number.isFinite(rawEntry.sizeBytes)
        ? Math.max(1, Math.floor(rawEntry.sizeBytes))
        : null;
    records.push({
      id: idRaw,
      personaSlug,
      frameRole,
      mediaUrl,
      originalUrl: asNonEmptyString(rawEntry.originalUrl),
      optimizedUrl: asNonEmptyString(rawEntry.optimizedUrl),
      mimeType: asNonEmptyString(rawEntry.mimeType),
      width,
      height,
      sizeBytes,
      sourcePrompt: asNonEmptyString(rawEntry.sourcePrompt),
      sourceCommandId: asNonEmptyString(rawEntry.sourceCommandId),
      createdAt: parseIsoOrNull(rawEntry.createdAt),
      updatedAt: parseIsoOrNull(rawEntry.updatedAt),
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// getPersonaFrameRoleSortValue
// ---------------------------------------------------------------------------

export function getPersonaFrameRoleSortValue(frameRole: PersonaFrameRole): number {
  const index = PERSONA_REFERENCE_FRAME_ROLES.indexOf(frameRole);
  return index >= 0 ? index : PERSONA_REFERENCE_FRAME_ROLES.length + 1;
}

// ---------------------------------------------------------------------------
// sortPersonaFrames
// ---------------------------------------------------------------------------

export function sortPersonaFrames(frames: PersonaFrameRecord[]): PersonaFrameRecord[] {
  return [...frames].sort((left, right) => {
    const roleDelta =
      getPersonaFrameRoleSortValue(left.frameRole) -
      getPersonaFrameRoleSortValue(right.frameRole);
    if (roleDelta !== 0) return roleDelta;
    const leftUpdated = left.updatedAt ? Date.parse(left.updatedAt) : 0;
    const rightUpdated = right.updatedAt ? Date.parse(right.updatedAt) : 0;
    if (leftUpdated !== rightUpdated) return rightUpdated - leftUpdated;
    return right.id - left.id;
  });
}

// ---------------------------------------------------------------------------
// pickPersonaFrameReferenceUrl
// ---------------------------------------------------------------------------

export function pickPersonaFrameReferenceUrl(
  frame: PersonaFrameRecord,
  isStreamPartArtifactReference: IsStreamPartArtifactReferenceFn,
): string | null {
  const candidates = [frame.optimizedUrl, frame.mediaUrl, frame.originalUrl];
  for (const candidate of candidates) {
    const normalized = asNonEmptyString(candidate);
    if (!normalized) continue;
    if (isStreamPartArtifactReference(normalized)) continue;
    if (!isLikelyImageReference(normalized, frame.mimeType)) continue;
    return normalized;
  }
  return null;
}

// ---------------------------------------------------------------------------
// collectPersonaFrameReferences
// ---------------------------------------------------------------------------

export function collectPersonaFrameReferences(
  frames: PersonaFrameRecord[],
  isStreamPartArtifactReference: IsStreamPartArtifactReferenceFn,
): string[] {
  const ordered = sortPersonaFrames(frames);
  const seen = new Set<string>();
  const collected: string[] = [];
  for (const role of PERSONA_REFERENCE_FRAME_ROLES) {
    const matches = ordered.filter((frame) => frame.frameRole === role);
    for (const match of matches) {
      const selected = pickPersonaFrameReferenceUrl(match, isStreamPartArtifactReference);
      if (!selected || seen.has(selected)) continue;
      seen.add(selected);
      collected.push(selected);
      break;
    }
  }
  return collected.slice(0, REQUIRED_PERSONA_REFERENCE_FRAME_COUNT);
}

// ---------------------------------------------------------------------------
// listPersonaFramesFromServer
// ---------------------------------------------------------------------------

export async function listPersonaFramesFromServer(
  personaSlug: string,
  deps: Pick<
    PersonaFrameDeps,
    "ctx" | "agentQueryOptional" | "isStreamPartArtifactReference"
  >,
): Promise<PersonaFrameRecord[]> {
  const listFrames = deps.agentQueryOptional("listPersonaFrames");
  if (!listFrames) return [];
  try {
    const response = await listFrames.query({ personaSlug });
    const parsed = parsePersonaFrameRecords(response).filter(
      (frame) => frame.personaSlug === personaSlug,
    );
    return sortPersonaFrames(parsed);
  } catch (error: unknown) {
    await deps.ctx.memory
      .recordWrite({
        type: "persona_frame_list_failed",
        at: nowIso(),
        personaSlug,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    return [];
  }
}

// ---------------------------------------------------------------------------
// ensurePersonaDefinitionForFrames
// ---------------------------------------------------------------------------

export async function ensurePersonaDefinitionForFrames(
  personaSlug: string,
  payload: Record<string, unknown>,
  deps: Pick<PersonaFrameDeps, "ctx" | "agentQueryOptional" | "agentMutatorOptional">,
): Promise<void> {
  const listPersonas = deps.agentQueryOptional("listPersonas");
  const upsertPersona = deps.agentMutatorOptional("upsertPersona");
  if (!upsertPersona) return;
  let personaExists = false;
  if (listPersonas) {
    try {
      const listedRaw = await listPersonas.query();
      const listed = Array.isArray(listedRaw)
        ? listedRaw
        : isRecord(listedRaw) && Array.isArray(listedRaw.personas)
          ? listedRaw.personas
          : [];
      personaExists = listed.some((entry) => {
        if (!isRecord(entry)) return false;
        return normalizePersonaSlug(entry.slug) === personaSlug;
      });
    } catch {
      personaExists = false;
    }
  }
  if (personaExists) return;
  const styleHint =
    asNonEmptyString(payload.mediaPersonaStyleHint) ??
    asNonEmptyString(payload.personaStyleHint) ??
    null;
  const displayName =
    personaSlug
      .split("_")
      .map((part) =>
        part.length > 0
          ? `${part.charAt(0).toUpperCase()}${part.slice(1)}`
          : "",
      )
      .join(" ")
      .trim() || "Persona";
  try {
    await upsertPersona.mutate({
      slug: personaSlug,
      name: displayName,
      labels: [personaSlug, "persona_reference", "realistic_reference"],
      weight: 100,
      isActive: true,
      ...(styleHint ? { styleHint } : {}),
    });
  } catch (error: unknown) {
    await deps.ctx.memory
      .recordWrite({
        type: "persona_definition_upsert_failed",
        at: nowIso(),
        personaSlug,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// buildPersonaReferencePrompt
// ---------------------------------------------------------------------------

export function buildPersonaReferencePrompt(input: {
  personaSlug: string;
  frameRole: PersonaFrameRole;
  payload: Record<string, unknown>;
}): string {
  const styleHint =
    asNonEmptyString(input.payload.mediaPersonaStyleHint) ??
    asNonEmptyString(input.payload.personaStyleHint) ??
    null;
  const sourcePrompt =
    asNonEmptyString(input.payload.mediaPrompt) ??
    asNonEmptyString(input.payload.prompt) ??
    asNonEmptyString(input.payload.topic) ??
    null;
  const frameInstruction =
    input.frameRole === "selfie"
      ? "Selfie reference frame: chest-up portrait, direct eye contact, neutral expression, natural lighting."
      : input.frameRole === "midshot"
        ? "Midshot reference frame: waist-up framing, clear body proportions, neutral pose, realistic streetwear details."
        : "Fullbody reference frame: full-body standing pose, realistic proportions, plain uncluttered background.";
  const continuityLine =
    "Keep identity continuity with existing persona references (same face, age range, skin tone, hair, and body proportions).";
  const realismLine =
    "Photorealistic style only. No anime, no cartoon, no painterly treatment.";
  return [
    `Build a persistent persona reference image for slug "${input.personaSlug}".`,
    frameInstruction,
    continuityLine,
    realismLine,
    "Single subject only. Keep image clean, sharp, and unoccluded.",
    styleHint ? `Style hint: ${styleHint}` : null,
    sourcePrompt ? `Persona context: ${truncateText(sourcePrompt, 220)}` : null,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join("\n");
}

// ---------------------------------------------------------------------------
// compressPersonaReferenceImage
// ---------------------------------------------------------------------------

export async function compressPersonaReferenceImage(
  input: {
    sourceUrl: string;
    sourceMimeType: string | null;
    personaSlug: string;
    frameRole: PersonaFrameRole;
  },
  deps: Pick<
    PersonaFrameDeps,
    "agent" | "uploadBytesViaChunkRoute" | "mapUploadResult" | "transformCustomAssetMedia"
  >,
): Promise<ResolvedMediaUpload | null> {
  const transformed = await deps.transformCustomAssetMedia({
    sourceUrl: input.sourceUrl,
    sourceMimeType: input.sourceMimeType ?? "image/png",
    kind: "sticker",
    spec: {
      width: PERSONA_REFERENCE_MAX_SIDE,
      height: PERSONA_REFERENCE_MAX_SIDE,
      fit: "inside",
      format: "jpeg",
      quality: PERSONA_REFERENCE_JPEG_QUALITY,
    },
  }).catch(() => null);
  if (!transformed?.bytes?.byteLength) return null;
  const fileName = `persona-${input.personaSlug}-${input.frameRole}-${Date.now()}.jpg`;
  const uploadedByChunk = await deps.uploadBytesViaChunkRoute({
    bytes: transformed.bytes,
    mimeType: transformed.mimeType,
    filename: fileName,
    keepOriginal: false,
  });
  if (uploadedByChunk) return uploadedByChunk;
  const dataUri = `data:${transformed.mimeType};base64,${transformed.bytes.toString("base64")}`;
  const uploaded = await deps.agent().uploadDataUri.mutate({
    dataUri,
    keepOriginal: false,
  });
  return deps.mapUploadResult(uploaded);
}

// ---------------------------------------------------------------------------
// upsertPersonaFrameRecord
// ---------------------------------------------------------------------------

export async function upsertPersonaFrameRecord(
  input: {
    personaSlug: string;
    frameRole: PersonaFrameRole;
    media: ResolvedMediaUpload;
    sourcePrompt: string;
    sourceCommandId: string;
  },
  deps: Pick<
    PersonaFrameDeps,
    "ctx" | "agentMutatorOptional" | "resolvePreferredMediaUrl"
  >,
): Promise<boolean> {
  const upsertFrame = deps.agentMutatorOptional("upsertPersonaFrame");
  if (!upsertFrame) return false;
  try {
    const canonicalMediaUrl =
      deps.resolvePreferredMediaUrl(
        input.media.mediaOptimizedUrl,
        input.media.mediaUrl,
        input.media.mediaOriginalUrl,
      ) ?? input.media.mediaUrl;
    const canonicalOptimizedUrl =
      deps.resolvePreferredMediaUrl(
        input.media.mediaOptimizedUrl,
        canonicalMediaUrl,
        input.media.mediaUrl,
        input.media.mediaOriginalUrl,
      ) ?? canonicalMediaUrl;
    const canonicalOriginalUrl = deps.resolvePreferredMediaUrl(
      input.media.mediaOriginalUrl,
      input.media.mediaUrl,
      canonicalMediaUrl,
    );
    const mimeType =
      inferMimeTypeFromUrl(canonicalOptimizedUrl) ??
      inferMimeTypeFromUrl(canonicalOriginalUrl ?? canonicalMediaUrl) ??
      "image/jpeg";
    await upsertFrame.mutate({
      personaSlug: input.personaSlug,
      frameRole: input.frameRole,
      mediaUrl: canonicalMediaUrl,
      ...(canonicalOriginalUrl
        ? { originalUrl: canonicalOriginalUrl }
        : {}),
      ...(canonicalOptimizedUrl
        ? { optimizedUrl: canonicalOptimizedUrl }
        : {}),
      mimeType,
      ...(typeof input.media.mediaSizeBytes === "number" &&
      Number.isFinite(input.media.mediaSizeBytes)
        ? { sizeBytes: Math.max(1, Math.floor(input.media.mediaSizeBytes)) }
        : {}),
      sourcePrompt: truncateText(input.sourcePrompt, 2000),
      sourceCommandId: input.sourceCommandId,
    });
    return true;
  } catch (error: unknown) {
    await deps.ctx.memory
      .recordWrite({
        type: "persona_frame_upsert_failed",
        at: nowIso(),
        personaSlug: input.personaSlug,
        frameRole: input.frameRole,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    return false;
  }
}

// ---------------------------------------------------------------------------
// bootstrapPersonaReferenceFrames
// ---------------------------------------------------------------------------

export async function bootstrapPersonaReferenceFrames(
  input: {
    personaSlug: string;
    payload: Record<string, unknown>;
    command: Command;
    existingFrames: PersonaFrameRecord[];
    seedReferences?: string[];
  },
  deps: PersonaFrameDeps,
): Promise<{ frames: PersonaFrameRecord[]; builtFrames: boolean }> {
  let builtFrames = false;
  await ensurePersonaDefinitionForFrames(input.personaSlug, input.payload, deps);
  const existingRoles = new Set<PersonaFrameRole>(
    input.existingFrames.map((frame) => frame.frameRole),
  );
  const referenceInputs = Array.from(
    new Set([
      ...(Array.isArray(input.seedReferences) ? input.seedReferences : []),
      ...collectPersonaFrameReferences(
        input.existingFrames,
        deps.isStreamPartArtifactReference,
      ),
    ]),
  ).slice(0, MAX_MEDIA_REFERENCE_INPUTS);
  for (const frameRole of PERSONA_REFERENCE_FRAME_ROLES) {
    if (existingRoles.has(frameRole)) continue;
    const sourcePrompt = buildPersonaReferencePrompt({
      personaSlug: input.personaSlug,
      frameRole,
      payload: input.payload,
    });
    try {
      const generated = await deps.generateAndUploadMediaFromPrompt(sourcePrompt, {
        generatedAssetType: "image",
        mode: "persona_reference_bootstrap",
        referenceInputs,
        keepOriginal: false,
        commandId: input.command.id,
      });
      const compressed =
        (await compressPersonaReferenceImage(
          {
            sourceUrl: generated.mediaOptimizedUrl ?? generated.mediaUrl,
            sourceMimeType:
              inferMimeTypeFromUrl(generated.mediaOptimizedUrl ?? generated.mediaUrl) ??
              inferMimeTypeFromUrl(generated.mediaOriginalUrl ?? generated.mediaUrl),
            personaSlug: input.personaSlug,
            frameRole,
          },
          deps,
        ).catch(() => null)) ?? null;
      const media = compressed ?? generated;
      const upserted = await upsertPersonaFrameRecord(
        {
          personaSlug: input.personaSlug,
          frameRole,
          media,
          sourcePrompt,
          sourceCommandId: input.command.id,
        },
        deps,
      );
      if (upserted) {
        builtFrames = true;
      }
      const frameReference =
        deps.resolvePreferredMediaUrl(
          media.mediaOptimizedUrl,
          media.mediaUrl,
          media.mediaOriginalUrl,
        ) ?? null;
      if (
        frameReference &&
        !deps.isStreamPartArtifactReference(frameReference) &&
        !referenceInputs.includes(frameReference)
      ) {
        referenceInputs.push(frameReference);
      }
      await deps.ctx.memory
        .recordWrite({
          type: "persona_frame_bootstrapped",
          at: nowIso(),
          commandId: input.command.id,
          personaSlug: input.personaSlug,
          frameRole,
          mediaUrl: frameReference ?? media.mediaUrl,
          compressed: Boolean(compressed),
        })
        .catch(() => undefined);
    } catch (error: unknown) {
      await deps.ctx.memory
        .recordWrite({
          type: "persona_frame_bootstrap_failed",
          at: nowIso(),
          commandId: input.command.id,
          personaSlug: input.personaSlug,
          frameRole,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
    }
  }
  const refreshed = await listPersonaFramesFromServer(input.personaSlug, deps);
  return { frames: refreshed, builtFrames };
}

// ---------------------------------------------------------------------------
// resolvePersonaFrameReferences
// ---------------------------------------------------------------------------

export async function resolvePersonaFrameReferences(
  input: {
    payload: Record<string, unknown>;
    command: Command;
    fallbackReferenceInputs: string[];
  },
  deps: PersonaFrameDeps,
): Promise<PersonaReferenceResolution> {
  const resolvedMainPersonaSlug = await resolveMainPersonaSlugFromBridge(
    deps.ctx,
    deps.callBridgeLookupCached,
  );
  const plan = resolvePersonaReferencePlan(
    input.payload,
    resolvedMainPersonaSlug,
    input.command,
    deps.resolveRequestedGenerateKinds,
  );
  if (!shouldUsePersonaFrameReferences(plan)) {
    return {
      personaSlug: null,
      frameReferences: input.fallbackReferenceInputs.slice(0, MAX_MEDIA_REFERENCE_INPUTS),
      builtFrames: false,
      mainPersonaSlug: null,
      source: null,
    };
  }
  const localSeedReferences = collectPersonaSeedReferenceInputs(
    {
      payload: input.payload,
      fallbackReferenceInputs: input.fallbackReferenceInputs,
    },
    deps,
  );
  const profileSeedReferences = await collectAgentProfilePersonaSeedReferences(deps);
  const seedReferences = Array.from(
    new Set([...profileSeedReferences, ...localSeedReferences]),
  ).slice(0, MAX_MEDIA_REFERENCE_INPUTS);
  const mainPersonaSlug = plan.mainPersonaSlug;
  const requestedPersonaSlug = plan.targetPersonaSlug;
  let targetPersonaSlug = requestedPersonaSlug;
  let builtFrames = false;
  let mainFrames: PersonaFrameRecord[] = [];
  let mainFrameReferences: string[] = [];
  if (requestedPersonaSlug !== mainPersonaSlug) {
    mainFrames = await listPersonaFramesFromServer(mainPersonaSlug, deps);
    mainFrameReferences = collectPersonaFrameReferences(
      mainFrames,
      deps.isStreamPartArtifactReference,
    );
    if (mainFrameReferences.length < REQUIRED_PERSONA_REFERENCE_FRAME_COUNT) {
      const bootstrappedMain = await bootstrapPersonaReferenceFrames(
        {
          personaSlug: mainPersonaSlug,
          payload: input.payload,
          command: input.command,
          existingFrames: mainFrames,
          seedReferences,
        },
        deps,
      );
      mainFrames = bootstrappedMain.frames;
      mainFrameReferences = collectPersonaFrameReferences(
        mainFrames,
        deps.isStreamPartArtifactReference,
      );
      builtFrames = builtFrames || bootstrappedMain.builtFrames;
    }
  }

  let frames =
    requestedPersonaSlug === mainPersonaSlug
      ? mainFrames.length > 0
        ? mainFrames
        : await listPersonaFramesFromServer(requestedPersonaSlug, deps)
      : await listPersonaFramesFromServer(requestedPersonaSlug, deps);
  let targetFrameReferences = collectPersonaFrameReferences(
    frames,
    deps.isStreamPartArtifactReference,
  );
  if (
    requestedPersonaSlug !== mainPersonaSlug &&
    targetFrameReferences.length < REQUIRED_PERSONA_REFERENCE_FRAME_COUNT &&
    !plan.allowNewPersonaCreation
  ) {
    targetPersonaSlug = mainPersonaSlug;
    frames = mainFrames.length > 0
      ? mainFrames
      : await listPersonaFramesFromServer(mainPersonaSlug, deps);
    mainFrames = frames;
    mainFrameReferences = collectPersonaFrameReferences(
      mainFrames,
      deps.isStreamPartArtifactReference,
    );
    targetFrameReferences = mainFrameReferences;
    await deps.ctx.memory
      .recordWrite({
        type: "persona_reference_new_persona_suppressed",
        at: nowIso(),
        commandId: input.command.id,
        requestedPersonaSlug,
        mainPersonaSlug,
        source: plan.source,
        reason: "missing_target_frames_without_explicit_new_persona_request",
      })
      .catch(() => undefined);
  }
  if (targetFrameReferences.length < REQUIRED_PERSONA_REFERENCE_FRAME_COUNT) {
    const bootstrapSeedReferences = Array.from(
      new Set([
        ...mainFrameReferences,
        ...seedReferences,
      ]),
    ).slice(0, MAX_MEDIA_REFERENCE_INPUTS);
    const bootstrapped = await bootstrapPersonaReferenceFrames(
      {
        personaSlug: targetPersonaSlug,
        payload: input.payload,
        command: input.command,
        existingFrames: frames,
        seedReferences: bootstrapSeedReferences,
      },
      deps,
    );
    frames = bootstrapped.frames;
    targetFrameReferences = collectPersonaFrameReferences(
      frames,
      deps.isStreamPartArtifactReference,
    );
    builtFrames = builtFrames || bootstrapped.builtFrames;
  }
  if (targetPersonaSlug === mainPersonaSlug) {
    mainFrameReferences = targetFrameReferences;
  }

  const frameReferences =
    targetFrameReferences.length >= REQUIRED_PERSONA_REFERENCE_FRAME_COUNT
      ? targetFrameReferences.slice(0, REQUIRED_PERSONA_REFERENCE_FRAME_COUNT)
      : Array.from(
          new Set([...targetFrameReferences, ...mainFrameReferences]),
        ).slice(0, REQUIRED_PERSONA_REFERENCE_FRAME_COUNT);
  await deps.ctx.memory
    .recordWrite({
      type: "persona_reference_resolution",
      at: nowIso(),
      commandId: input.command.id,
      personaSlug: targetPersonaSlug,
      requestedPersonaSlug,
      mainPersonaSlug,
      source: plan.source,
      explicitPersonaSlug: plan.explicitPersonaSlug,
      variantKey: plan.variantKey,
      allowNewPersonaCreation: plan.allowNewPersonaCreation,
      builtFrames,
      targetFrameCount: targetFrameReferences.length,
      mainFrameCount: mainFrameReferences.length,
      resolvedFrameCount: frameReferences.length,
      seedReferenceCount: seedReferences.length,
    })
    .catch(() => undefined);
  updatePersonaReferenceSnapshot(
    {
      mainPersonaSlug,
      personaSlug: targetPersonaSlug,
      source: plan.source,
      frameReferences,
      builtFrames,
      variantKey: plan.variantKey,
    },
    deps.ctx,
  );

  return {
    personaSlug: targetPersonaSlug,
    frameReferences,
    builtFrames,
    mainPersonaSlug,
    source: plan.source,
  };
}
