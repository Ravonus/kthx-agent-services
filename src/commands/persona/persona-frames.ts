/** Persona frame management, bootstrapping, and reference resolution. */
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";

import {
  asNonEmptyString,
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
  Command,
} from "../types.js";

import { PERSONA_REFERENCE_FRAME_ROLES } from "../types.js";

import {
  normalizePersonaSlug,
  isGenericPersonaSlug,
  isImageMimeType,
  shouldUsePersonaFrameReferences,
  resolvePersonaReferencePlan,
  resolveMainPersonaSlugFromBridge,
} from "./persona-resolution.js";
import {
  collectPersonaSeedReferenceInputs,
  collectAgentProfilePersonaSeedReferences,
  updatePersonaReferenceSnapshot,
  type PersonaFrameDeps,
  type CollectMediaReferenceInputsFn,
  type IsStreamPartArtifactReferenceFn,
  type ResolvePreferredMediaUrlFn,
  type GenerateAndUploadMediaFromPromptFn,
  type UploadBytesViaChunkRouteFn,
  type MapUploadResultFn,
  type TransformCustomAssetMediaFn,
} from "./persona-frame-context.js";
import {
  parsePersonaFrameRecords,
  getPersonaFrameRoleSortValue,
  sortPersonaFrames,
  pickPersonaFrameReferenceUrl,
  collectPersonaFrameReferences,
} from "./persona-frame-records.js";
import {
  normalizePersonaFrameRole,
  parseIsoOrNull,
} from "./persona-frame-parsing.js";

export {
  collectPersonaSeedReferenceInputs,
  collectAgentProfilePersonaSeedReferences,
  updatePersonaReferenceSnapshot,
  parsePersonaFrameRecords,
  getPersonaFrameRoleSortValue,
  sortPersonaFrames,
  pickPersonaFrameReferenceUrl,
  collectPersonaFrameReferences,
  normalizePersonaFrameRole,
  parseIsoOrNull,
};

export type {
  PersonaFrameDeps,
  CollectMediaReferenceInputsFn,
  IsStreamPartArtifactReferenceFn,
  ResolvePreferredMediaUrlFn,
  GenerateAndUploadMediaFromPromptFn,
  UploadBytesViaChunkRouteFn,
  MapUploadResultFn,
  TransformCustomAssetMediaFn,
};

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
