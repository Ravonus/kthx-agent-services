/** Persona frame management, bootstrapping, and reference resolution. */
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";

import {
  asNonEmptyString,
  asPositiveInt,
  normalizeInterestTagToken,
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

type ExternalPersonaTargetResolution = {
  resolution: PersonaReferenceResolution | null;
  suppressOwnPersona: boolean;
  source: string | null;
};

const normalizeHandle = (value: unknown): string | null => {
  const raw = asNonEmptyString(value);
  if (!raw) return null;
  const normalized = raw.trim().replace(/^@+/u, "").toLowerCase();
  return normalized.length > 0 ? normalized : null;
};

const HANDLE_MENTION_PATTERN = /(?:^|[^@\w])@([a-z0-9_][a-z0-9_.-]{0,31})/giu;
const EXTERNAL_PERSONA_AUTHOR_PATTERN =
  /\b(post author|comment author|the author|author)\b/iu;

const collectHandleCandidatesFromValue = (value: unknown, max: number): string[] => {
  if (!Array.isArray(value)) return [];
  const collected: string[] = [];
  for (const entry of value) {
    const directHandle = normalizeHandle(entry);
    if (directHandle) {
      collected.push(directHandle);
      if (collected.length >= max) break;
      continue;
    }
    if (!isRecord(entry)) continue;
    const nestedHandle = normalizeHandle(entry.handle);
    if (!nestedHandle) continue;
    collected.push(nestedHandle);
    if (collected.length >= max) break;
  }
  return collected;
};

const collectHandleMentionsFromText = (value: unknown, max: number): string[] => {
  const text = asNonEmptyString(value);
  if (!text) return [];
  const collected: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(HANDLE_MENTION_PATTERN)) {
    const normalized = normalizeHandle(match[1]);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    collected.push(normalized);
    if (collected.length >= max) break;
  }
  return collected;
};

function collectTargetHandleCandidates(payload: Record<string, unknown>): string[] {
  const context = isRecord(payload.context) ? payload.context : null;
  const collected = new Set<string>();
  const push = (value: unknown): void => {
    const normalized = normalizeHandle(value);
    if (!normalized) return;
    collected.add(normalized);
  };

  for (const handle of collectHandleCandidatesFromValue(payload.taggedHandles, 24)) {
    collected.add(handle);
  }
  for (const handle of collectHandleCandidatesFromValue(payload.taggedUsers, 24)) {
    collected.add(handle);
  }
  for (const handle of collectHandleCandidatesFromValue(context?.taggedHandles, 24)) {
    collected.add(handle);
  }
  for (const handle of collectHandleCandidatesFromValue(context?.taggedUsers, 24)) {
    collected.add(handle);
  }

  push(payload.targetHandle);
  push(payload.authorHandle);
  push(payload.postAuthorHandle);
  push(payload.commentAuthorHandle);
  push(context?.targetHandle);
  push(context?.authorHandle);
  push(context?.postAuthorHandle);
  push(context?.commentAuthorHandle);

  const promptFields: unknown[] = [
    payload.prompt,
    payload.mediaPrompt,
    payload.imagePrompt,
    context?.prompt,
    context?.mediaPrompt,
    context?.imagePrompt,
  ];
  for (const field of promptFields) {
    for (const handle of collectHandleMentionsFromText(field, 24)) {
      collected.add(handle);
    }
  }

  return [...collected].slice(0, 24);
}

async function collectBridgeTargetHandleCandidates(
  payload: Record<string, unknown>,
  deps: Pick<PersonaFrameDeps, "ctx" | "callBridgeLookupCached">,
): Promise<string[]> {
  if (!deps.ctx.callAgentChatBridge) return [];
  const postId =
    asPositiveInt(payload.postId) ??
    asPositiveInt(payload.targetPostId) ??
    (isRecord(payload.directiveScope) && isRecord(payload.directiveScope.target)
      ? asPositiveInt(payload.directiveScope.target.postId)
      : null);
  const commentId =
    asPositiveInt(payload.commentId) ??
    asPositiveInt(payload.targetCommentId) ??
    (isRecord(payload.directiveScope) && isRecord(payload.directiveScope.target)
      ? asPositiveInt(payload.directiveScope.target.commentId)
      : null);

  const handles = new Set<string>();
  const push = (value: unknown): void => {
    const normalized = normalizeHandle(value);
    if (!normalized) return;
    handles.add(normalized);
  };

  if (postId && commentId) {
    try {
      const commentLookup = await deps.callBridgeLookupCached({
        action: "find_comment",
        postId,
        commentId,
      });
      const commentRoot = isRecord(commentLookup.value) ? commentLookup.value : null;
      const commentRecord =
        commentRoot && isRecord(commentRoot.data) ? commentRoot.data : commentLookup.value;
      const author =
        isRecord(commentRecord) && isRecord(commentRecord.author)
          ? commentRecord.author
          : null;
      if (author) {
        push(author.handle);
      } else if (isRecord(commentRecord)) {
        push(commentRecord.authorHandle);
      }
    } catch {
      // best effort only
    }
  }

  if (postId) {
    try {
      const postLookup = await deps.callBridgeLookupCached({
        action: "find_post",
        postId,
      });
      const postLookupRoot = isRecord(postLookup.value) ? postLookup.value : null;
      const postRoot =
        postLookupRoot && isRecord(postLookupRoot.data)
          ? postLookupRoot.data
          : postLookup.value;
      const postRecord = isRecord(postRoot) && isRecord(postRoot.post)
        ? postRoot.post
        : postRoot;
      const author =
        isRecord(postRecord) && isRecord(postRecord.author)
          ? postRecord.author
          : null;
      if (author) {
        push(author.handle);
      } else if (isRecord(postRecord)) {
        push(postRecord.authorHandle);
      }
    } catch {
      // best effort only
    }
  }

  return [...handles];
}

async function resolveOwnAgentHandleFromBridge(
  deps: Pick<PersonaFrameDeps, "ctx" | "callBridgeLookupCached">,
): Promise<string | null> {
  if (!deps.ctx.callAgentChatBridge) return null;
  try {
    const profileLookup = await deps.callBridgeLookupCached({
      action: "agent_profile",
    });
    const root = isRecord(profileLookup.value) ? profileLookup.value : null;
    const data = root && isRecord(root.data) ? root.data : profileLookup.value;
    const agent = isRecord(data) && isRecord(data.agent) ? data.agent : null;
    return normalizeHandle(agent?.handle);
  } catch {
    return null;
  }
}

async function listProfilePersonaFramesByHandleFromServer(
  handle: string,
  payload: Record<string, unknown>,
  deps: Pick<PersonaFrameDeps, "ctx" | "userQueryOptional" | "isStreamPartArtifactReference">,
): Promise<{ personaSlug: string | null; frameReferences: string[] }> {
  const listProfilePersonas = deps.userQueryOptional("listProfilePersonas");
  if (!listProfilePersonas) {
    return { personaSlug: null, frameReferences: [] };
  }
  try {
    const response = await listProfilePersonas.query({ handle });
    const root = isRecord(response) ? response : null;
    const mainPersonaSlug = normalizePersonaSlug(root?.mainPersonaSlug);
    const items = root && Array.isArray(root.items) ? root.items : [];
    const matchTokens = collectExternalPersonaMatchTokens(payload);
    const parsed = items
      .map((entry) => {
        if (!isRecord(entry)) return null;
        const slug = normalizePersonaSlug(entry.slug);
        if (!slug) return null;
        const labels = Array.isArray(entry.labels)
          ? entry.labels
              .map((label) => asNonEmptyString(label))
              .filter((label): label is string => Boolean(label))
          : [];
        const weight =
          typeof entry.weight === "number" && Number.isFinite(entry.weight)
            ? entry.weight
            : 0;
        const framesRaw = Array.isArray(entry.frames) ? entry.frames : [];
        const frames = parsePersonaFrameRecords({
          frames: framesRaw.map((frame) =>
            isRecord(frame)
              ? {
                  ...frame,
                  personaSlug: slug,
                }
              : frame,
          ),
        }).filter((frame) => frame.personaSlug === slug);
        const frameReferences = collectPersonaFrameReferences(
          frames,
          deps.isStreamPartArtifactReference,
        );
        return {
          slug,
          labels,
          frameReferences,
          frameCount: frames.length,
          weight,
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          slug: string;
          labels: string[];
          frameReferences: string[];
          frameCount: number;
          weight: number;
        } => Boolean(entry),
      );

    const selected =
      [...parsed].sort((left, right) => {
        const leftComplete =
          left.frameReferences.length >= REQUIRED_PERSONA_REFERENCE_FRAME_COUNT ? 1 : 0;
        const rightComplete =
          right.frameReferences.length >= REQUIRED_PERSONA_REFERENCE_FRAME_COUNT ? 1 : 0;
        if (rightComplete !== leftComplete) {
          return rightComplete - leftComplete;
        }
        const leftOverlap = countExternalPersonaLabelOverlap(left.labels, matchTokens);
        const rightOverlap = countExternalPersonaLabelOverlap(right.labels, matchTokens);
        if (rightOverlap !== leftOverlap) {
          return rightOverlap - leftOverlap;
        }
        const leftIsMain = left.slug === mainPersonaSlug ? 1 : 0;
        const rightIsMain = right.slug === mainPersonaSlug ? 1 : 0;
        if (rightIsMain !== leftIsMain) {
          return rightIsMain - leftIsMain;
        }
        if (right.frameReferences.length !== left.frameReferences.length) {
          return right.frameReferences.length - left.frameReferences.length;
        }
        if (right.frameCount !== left.frameCount) {
          return right.frameCount - left.frameCount;
        }
        return right.weight - left.weight;
      })[0] ??
      null;

    if (!selected) {
      return { personaSlug: null, frameReferences: [] };
    }
    return {
      personaSlug: selected.slug,
      frameReferences: selected.frameReferences,
    };
  } catch (error: unknown) {
    await deps.ctx.memory
      .recordWrite({
        type: "persona_reference_external_lookup_failed",
        at: nowIso(),
        handle,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    return { personaSlug: null, frameReferences: [] };
  }
}

async function resolveExternalPersonaFrameReferences(
  input: {
    payload: Record<string, unknown>;
    plan: PersonaReferencePlan;
  },
  deps: Pick<
    PersonaFrameDeps,
    "ctx" | "userQueryOptional" | "isStreamPartArtifactReference" | "callBridgeLookupCached"
  >,
): Promise<ExternalPersonaTargetResolution> {
  const explicitPersonaSlug = input.plan.explicitPersonaSlug;
  if (
    input.plan.allowNewPersonaCreation ||
    (explicitPersonaSlug && !isGenericPersonaSlug(explicitPersonaSlug))
  ) {
    return {
      resolution: null,
      suppressOwnPersona: false,
      source: null,
    };
  }

  const payloadHandles = collectTargetHandleCandidates(input.payload);
  const bridgeHandles = await collectBridgeTargetHandleCandidates(input.payload, deps);
  const ownAgentHandle = await resolveOwnAgentHandleFromBridge(deps);
  const handles = Array.from(
    new Set([...payloadHandles, ...bridgeHandles]),
  )
    .filter((handle) => handle !== ownAgentHandle)
    .slice(0, 8);
  if (handles.length === 0) {
    return {
      resolution: null,
      suppressOwnPersona: false,
      source: null,
    };
  }

  const listProfilePersonas = deps.userQueryOptional("listProfilePersonas");
  if (!listProfilePersonas) {
    return {
      resolution: null,
      suppressOwnPersona: false,
      source: null,
    };
  }
  if (!shouldUseExternalPersonaFrames(input.payload, payloadHandles, bridgeHandles)) {
    return {
      resolution: null,
      suppressOwnPersona: false,
      source: null,
    };
  }

  for (const handle of handles) {
    const external = await listProfilePersonaFramesByHandleFromServer(
      handle,
      input.payload,
      deps,
    );
    if (
      external.personaSlug &&
      external.frameReferences.length >= REQUIRED_PERSONA_REFERENCE_FRAME_COUNT
    ) {
      await deps.ctx.memory
        .recordWrite({
          type: "persona_reference_external_selected",
          at: nowIso(),
          handle,
          personaSlug: external.personaSlug,
          frameReferenceCount: external.frameReferences.length,
        })
        .catch(() => undefined);
      return {
        resolution: {
          personaSlug: external.personaSlug,
          frameReferences: external.frameReferences,
          builtFrames: false,
          mainPersonaSlug: external.personaSlug,
          source: `external_handle:${handle}`,
        },
        suppressOwnPersona: false,
        source: `external_handle:${handle}`,
      };
    }
  }

  await deps.ctx.memory
    .recordWrite({
      type: "persona_reference_external_missing",
      at: nowIso(),
      handles,
      reason: "no_target_handle_with_complete_persona_frames",
    })
    .catch(() => undefined);
  return {
    resolution: null,
    suppressOwnPersona: true,
    source: "external_handle_missing_frames",
  };
}

const collectExternalPersonaMatchTokensFromArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const tokens = new Set<string>();
  for (const entry of value) {
    const normalized = normalizeInterestTagToken(entry);
    if (normalized) {
      tokens.add(normalized);
    }
  }
  return [...tokens];
};

const collectExternalPersonaMatchTokensFromText = (value: unknown): string[] => {
  const text = asNonEmptyString(value);
  if (!text) return [];
  const tokens = new Set<string>();
  for (const rawToken of text.split(/[^a-z0-9_]+/iu)) {
    const normalized = normalizeInterestTagToken(rawToken);
    if (normalized) {
      tokens.add(normalized);
    }
  }
  return [...tokens];
};

const collectExternalPersonaMatchTokens = (payload: Record<string, unknown>): string[] => {
  const context = isRecord(payload.context) ? payload.context : null;
  const tokens = new Set<string>();
  const pushArray = (value: unknown): void => {
    for (const token of collectExternalPersonaMatchTokensFromArray(value)) {
      tokens.add(token);
    }
  };
  const pushText = (value: unknown): void => {
    for (const token of collectExternalPersonaMatchTokensFromText(value)) {
      tokens.add(token);
    }
  };

  [
    payload.tags,
    payload.mediaLabels,
    payload.labels,
    context?.tags,
    context?.mediaLabels,
    context?.labels,
  ].forEach((value) => pushArray(value));

  [
    payload.mediaPrompt,
    payload.imagePrompt,
    payload.prompt,
    payload.topic,
    context?.mediaPrompt,
    context?.imagePrompt,
    context?.prompt,
    context?.topic,
  ].forEach((value) => pushText(value));

  return [...tokens].slice(0, 24);
};

const collectExternalPersonaLabelTokens = (labels: string[]): Set<string> => {
  const tokens = new Set<string>();
  for (const label of labels) {
    for (const part of label.split(/[^a-z0-9_]+/iu)) {
      const normalized = normalizeInterestTagToken(part);
      if (normalized) {
        tokens.add(normalized);
      }
    }
  }
  return tokens;
};

const countExternalPersonaLabelOverlap = (
  labels: string[],
  matchTokens: string[],
): number => {
  if (labels.length === 0 || matchTokens.length === 0) return 0;
  const labelTokens = collectExternalPersonaLabelTokens(labels);
  let overlap = 0;
  for (const token of matchTokens) {
    if (labelTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap;
};

const resolveExternalPersonaTargetKind = (
  payload: Record<string, unknown>,
): "self" | "person" | "post" | "topic" | "scene" | null => {
  const context = isRecord(payload.context) ? payload.context : null;
  const normalized =
    asNonEmptyString(payload.targetKind)?.trim().toLowerCase() ??
    asNonEmptyString(context?.targetKind)?.trim().toLowerCase() ??
    null;
  if (
    normalized === "self" ||
    normalized === "person" ||
    normalized === "post" ||
    normalized === "topic" ||
    normalized === "scene"
  ) {
    return normalized;
  }
  return null;
};

const resolveExternalPersonaMediaMode = (payload: Record<string, unknown>): string | null => {
  const context = isRecord(payload.context) ? payload.context : null;
  return (
    asNonEmptyString(payload.mediaMode)?.trim().toLowerCase() ??
    asNonEmptyString(context?.mediaMode)?.trim().toLowerCase() ??
    null
  );
};

const collectVisualPromptFields = (payload: Record<string, unknown>): unknown[] => {
  const context = isRecord(payload.context) ? payload.context : null;
  return [
    payload.prompt,
    payload.mediaPrompt,
    payload.imagePrompt,
    context?.prompt,
    context?.mediaPrompt,
    context?.imagePrompt,
  ];
};

const hasVisualPromptHandleMention = (payload: Record<string, unknown>): boolean =>
  collectVisualPromptFields(payload).some(
    (value) => collectHandleMentionsFromText(value, 1).length > 0,
  );

const hasExternalAuthorReferencePrompt = (payload: Record<string, unknown>): boolean =>
  collectVisualPromptFields(payload).some((value) => {
    const text = asNonEmptyString(value);
    return text ? EXTERNAL_PERSONA_AUTHOR_PATTERN.test(text) : false;
  });

const shouldUseExternalPersonaFrames = (
  payload: Record<string, unknown>,
  payloadHandles: string[],
  bridgeHandles: string[],
): boolean => {
  const targetKind = resolveExternalPersonaTargetKind(payload);
  const mediaMode = resolveExternalPersonaMediaMode(payload);
  const hasAnyHandleSignals = payloadHandles.length > 0 || bridgeHandles.length > 0;
  if (!hasAnyHandleSignals) return false;
  if (hasVisualPromptHandleMention(payload)) return true;
  if (targetKind === "person") return true;
  if (mediaMode === "group") return true;
  if (bridgeHandles.length > 0 && hasExternalAuthorReferencePrompt(payload)) return true;
  return false;
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
  const payloadContext = isRecord(payload.context) ? payload.context : null;
  const styleHint =
    asNonEmptyString(payload.mediaPersonaStyleHint) ??
    asNonEmptyString(payload.personaStyleHint) ??
    asNonEmptyString(payloadContext?.mediaPersonaStyleHint) ??
    asNonEmptyString(payloadContext?.personaStyleHint) ??
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
  const payloadContext = isRecord(input.payload.context) ? input.payload.context : null;
  const styleHint =
    asNonEmptyString(input.payload.mediaPersonaStyleHint) ??
    asNonEmptyString(input.payload.personaStyleHint) ??
    asNonEmptyString(payloadContext?.mediaPersonaStyleHint) ??
    asNonEmptyString(payloadContext?.personaStyleHint) ??
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
  const externalTargetResolution = await resolveExternalPersonaFrameReferences(
    {
      payload: input.payload,
      plan,
    },
    deps,
  );
  if (externalTargetResolution.resolution) {
    return externalTargetResolution.resolution;
  }
  if (externalTargetResolution.suppressOwnPersona) {
    return {
      personaSlug: null,
      frameReferences: [],
      builtFrames: false,
      mainPersonaSlug: null,
      source: externalTargetResolution.source,
    };
  }
  if (!shouldUsePersonaFrameReferences(plan)) {
    return {
      personaSlug: null,
      frameReferences: plan.enabled
        ? input.fallbackReferenceInputs.slice(0, MAX_MEDIA_REFERENCE_INPUTS)
        : [],
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
