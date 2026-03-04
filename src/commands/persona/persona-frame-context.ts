import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";

import { asNonEmptyString } from "../helpers.js";
import {
  MAX_MEDIA_REFERENCE_INPUTS,
  REQUIRED_PERSONA_REFERENCE_FRAME_COUNT,
} from "../constants.js";

import type {
  CommandExecutorContext,
  AgentRouterLike,
  AgentMutator,
  AgentQuery,
  ResolvedMediaUpload,
} from "../types.js";

import {
  isLikelyImageReference,
  type CallBridgeLookupCachedFn,
  type ResolveRequestedGenerateKindsFn,
} from "./persona-resolution.js";

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
export type IsStreamPartArtifactReferenceFn = (
  value: string | null | undefined,
) => boolean;

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
