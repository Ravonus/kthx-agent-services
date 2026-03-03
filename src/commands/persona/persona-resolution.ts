/** Persona slug resolution and reference plan computation. */

import { isRecord } from "../../lib/guards.js";

import {
  asNonEmptyString,
  normalizeAgentProvenanceValue,
  inferMimeTypeFromUrl,
  parseDataUriPayload,
} from "../helpers.js";

import {
  DEFAULT_MAIN_PERSONA_SLUG,
  GENERIC_PERSONA_SLUGS,
  PERSONA_SELF_REFERENCE_PROMPT_PATTERN,
  PERSONA_REQUEST_PROMPT_PATTERN,
  PERSONA_CREATION_REQUEST_PROMPT_PATTERN,
  PERSONA_VARIANT_PATTERNS,
  NON_IMAGE_REFERENCE_EXTENSION_PATTERN,
} from "../constants.js";

import type {
  PersonaReferencePlan,
  PersonaFrameRole,
  Command,
} from "../types.js";

// ---------------------------------------------------------------------------
// Callback signatures for methods that still live on the class
// ---------------------------------------------------------------------------

/**
 * A function that resolves the requested generate-kinds from a payload.
 * Mirrors `CommandExecutor.resolveRequestedGenerateKinds`.
 */
export type ResolveRequestedGenerateKindsFn = (
  payload: Record<string, unknown>,
  defaultKind: string,
) => string[];

/**
 * Bridge lookup callback matching the cached bridge call on the executor.
 */
export type CallBridgeLookupCachedFn = (
  payload: Record<string, unknown>,
  ttlMs?: number,
) => Promise<{ value: unknown; cacheHit: boolean }>;

// ---------------------------------------------------------------------------
// normalizePersonaSlug
// ---------------------------------------------------------------------------

export function normalizePersonaSlug(value: unknown): string | null {
  const raw = asNonEmptyString(value);
  if (!raw) return null;
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 64);
  return normalized.length > 0 ? normalized : null;
}

// ---------------------------------------------------------------------------
// isGenericPersonaSlug
// ---------------------------------------------------------------------------

export function isGenericPersonaSlug(value: string | null): boolean {
  if (!value) return true;
  return GENERIC_PERSONA_SLUGS.has(value);
}

// ---------------------------------------------------------------------------
// extractPersonaPromptText
// ---------------------------------------------------------------------------

export function extractPersonaPromptText(payload: Record<string, unknown>): string {
  const context = isRecord(payload.context) ? payload.context : null;
  const fields: unknown[] = [
    payload.requestText,
    payload.topic,
    payload.prompt,
    payload.mediaPrompt,
    payload.imagePrompt,
    payload.instruction,
    payload.caption,
    payload.textBody,
    context?.requestText,
    context?.topic,
    context?.prompt,
    context?.mediaPrompt,
    context?.imagePrompt,
    context?.instruction,
    context?.caption,
    context?.textBody,
  ];
  const lines: string[] = [];
  for (const field of fields) {
    const text = asNonEmptyString(field);
    if (!text) continue;
    lines.push(text);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// resolvePersonaVariantKeyFromPrompt
// ---------------------------------------------------------------------------

export function resolvePersonaVariantKeyFromPrompt(promptText: string): string | null {
  const normalized = promptText.trim().toLowerCase();
  if (!normalized.length) return null;
  for (const variant of PERSONA_VARIANT_PATTERNS) {
    if (variant.pattern.test(normalized)) {
      return variant.key;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// resolveExplicitPersonaVariantKey
// ---------------------------------------------------------------------------

export function resolveExplicitPersonaVariantKey(
  payload: Record<string, unknown>,
): string | null {
  const context = isRecord(payload.context) ? payload.context : null;
  const variantRaw =
    asNonEmptyString(payload.mediaPersonaVariant) ??
    asNonEmptyString(payload.personaVariant) ??
    asNonEmptyString(context?.mediaPersonaVariant) ??
    asNonEmptyString(context?.personaVariant) ??
    null;
  if (!variantRaw) return null;
  const normalized = variantRaw.trim().toLowerCase().replace(/[\s-]+/gu, "_");
  if (!normalized.length) return null;
  if (!/^[a-z0-9_]{1,40}$/u.test(normalized)) return null;
  return normalized;
}

// ---------------------------------------------------------------------------
// isExplicitNewPersonaRequest
// ---------------------------------------------------------------------------

export function isExplicitNewPersonaRequest(payload: Record<string, unknown>): boolean {
  const context = isRecord(payload.context) ? payload.context : null;
  if (
    payload.createPersona === true ||
    payload.newPersona === true ||
    payload.createNewPersona === true ||
    context?.createPersona === true ||
    context?.newPersona === true ||
    context?.createNewPersona === true
  ) {
    return true;
  }
  const promptText = extractPersonaPromptText(payload);
  if (!promptText.length) return false;
  return PERSONA_CREATION_REQUEST_PROMPT_PATTERN.test(promptText);
}

// ---------------------------------------------------------------------------
// resolvePersonaSelectionStrategy
// ---------------------------------------------------------------------------

export function resolvePersonaSelectionStrategy(
  payload: Record<string, unknown>,
): string | null {
  const selection = isRecord(payload.personaSelection) ? payload.personaSelection : null;
  const context = isRecord(payload.context) ? payload.context : null;
  const contextSelection = isRecord(context?.personaSelection)
    ? context.personaSelection
    : null;
  return (
    asNonEmptyString(selection?.strategy)?.trim().toLowerCase() ??
    asNonEmptyString(contextSelection?.strategy)?.trim().toLowerCase() ??
    null
  );
}

// ---------------------------------------------------------------------------
// isPersonaMediaLockEnabled
// ---------------------------------------------------------------------------

export function isPersonaMediaLockEnabled(payload: Record<string, unknown>): boolean {
  const context = isRecord(payload.context) ? payload.context : null;
  const keys = [
    "mediaPersonaLock",
    "personaLock",
    "forcePersona",
    "forcePersonaReference",
    "enforcePersona",
  ] as const;
  for (const key of keys) {
    if (payload[key] === true || context?.[key] === true) {
      return true;
    }
  }
  return resolvePersonaSelectionStrategy(payload) === "pinned";
}

// ---------------------------------------------------------------------------
// isMediaLikePayloadForPersona
// ---------------------------------------------------------------------------

export function isMediaLikePayloadForPersona(
  payload: Record<string, unknown>,
  command: Command | null,
  resolveRequestedGenerateKinds: ResolveRequestedGenerateKindsFn,
): boolean {
  const commandKind = command?.kind.trim().toLowerCase() ?? "";
  if (
    commandKind === "write.createstory" ||
    commandKind === "write.updateavatar" ||
    commandKind === "write.updatebanner"
  ) {
    return true;
  }
  if (commandKind === "write.createpost") {
    const postType = asNonEmptyString(payload.postType)?.toLowerCase();
    if (postType === "text") return false;
    return true;
  }
  const context = isRecord(payload.context) ? payload.context : null;
  const postType =
    asNonEmptyString(payload.postType)?.toLowerCase() ??
    asNonEmptyString(context?.postType)?.toLowerCase() ??
    "";
  if (postType === "media") return true;
  if (postType === "text") return false;

  const generatedAssetType =
    asNonEmptyString(payload.generatedAssetType)?.toLowerCase() ??
    asNonEmptyString(context?.generatedAssetType)?.toLowerCase() ??
    "";
  if (generatedAssetType === "image" || generatedAssetType === "gif") return true;

  const mediaPrompt =
    asNonEmptyString(payload.mediaPrompt) ??
    asNonEmptyString(payload.imagePrompt) ??
    asNonEmptyString(context?.mediaPrompt) ??
    asNonEmptyString(context?.imagePrompt);
  if (mediaPrompt) return true;

  const requestedKinds = resolveRequestedGenerateKinds(payload, "chat");
  return requestedKinds.some(
    (kind) => kind === "media" || kind === "multi_media" || kind === "story",
  );
}

// ---------------------------------------------------------------------------
// shouldDefaultPersonaReferences
// ---------------------------------------------------------------------------

export function shouldDefaultPersonaReferences(
  payload: Record<string, unknown>,
  command: Command | null,
  resolveRequestedGenerateKinds: ResolveRequestedGenerateKindsFn,
): boolean {
  const context = isRecord(payload.context) ? payload.context : null;
  const commandKind = command?.kind.trim().toLowerCase() ?? "";
  const explicitCandidates: unknown[] = [
    payload.mediaPersona,
    payload.persona,
    payload.personaName,
    context?.mediaPersona,
    context?.persona,
    context?.personaName,
  ];
  let explicitPersonaSlug: string | null = null;
  for (const candidate of explicitCandidates) {
    const normalized = normalizePersonaSlug(candidate);
    if (!normalized) continue;
    explicitPersonaSlug = normalized;
    break;
  }
  const genericExplicitPersona =
    explicitPersonaSlug !== null && isGenericPersonaSlug(explicitPersonaSlug);
  const chatLiteralGenerate =
    payload.chatLiteralGenerate === true ||
    payload.chatLiteralGenerate === "true" ||
    context?.chatLiteralGenerate === true ||
    context?.chatLiteralGenerate === "true";
  const avatarOrBannerRequest =
    payload.avatarRequest === true ||
    payload.bannerRequest === true ||
    context?.avatarRequest === true ||
    context?.bannerRequest === true;
  const personaMediaLockEnabled = isPersonaMediaLockEnabled(payload);
  if (
    personaMediaLockEnabled &&
    !(chatLiteralGenerate && !avatarOrBannerRequest && genericExplicitPersona)
  ) {
    return true;
  }
  if (!isMediaLikePayloadForPersona(payload, command, resolveRequestedGenerateKinds)) {
    return false;
  }
  if (
    commandKind === "write.updateavatar" ||
    payload.avatarRequest === true ||
    context?.avatarRequest === true
  ) {
    return true;
  }
  const provenance =
    normalizeAgentProvenanceValue(payload.provenance) ??
    normalizeAgentProvenanceValue(context?.provenance);
  return provenance === "AGENT_AUTONOMOUS";
}

// ---------------------------------------------------------------------------
// resolvePersonaReferencePlan
// ---------------------------------------------------------------------------

export function resolvePersonaReferencePlan(
  payload: Record<string, unknown>,
  mainPersonaSlugRaw: string | null = null,
  command: Command | null = null,
  resolveRequestedGenerateKinds: ResolveRequestedGenerateKindsFn,
): PersonaReferencePlan {
  const context = isRecord(payload.context) ? payload.context : null;
  const explicitCandidates: unknown[] = [
    payload.mediaPersona,
    payload.persona,
    payload.personaName,
    context?.mediaPersona,
    context?.persona,
    context?.personaName,
  ];
  let explicitPersonaSlug: string | null = null;
  for (const candidate of explicitCandidates) {
    const normalized = normalizePersonaSlug(candidate);
    if (!normalized) continue;
    explicitPersonaSlug = normalized;
    break;
  }
  const nonGenericExplicitSlug =
    explicitPersonaSlug && !isGenericPersonaSlug(explicitPersonaSlug)
      ? explicitPersonaSlug
      : null;
  const explicitGenericPersonaRequested =
    explicitPersonaSlug === "persona" ||
    explicitPersonaSlug === "selfie" ||
    explicitPersonaSlug === "self" ||
    explicitPersonaSlug === "me" ||
    explicitPersonaSlug === "myself";
  const personaMediaLock = isPersonaMediaLockEnabled(payload);
  const promptText = extractPersonaPromptText(payload);
  const selfIntent = PERSONA_SELF_REFERENCE_PROMPT_PATTERN.test(promptText);
  const personaIntent = selfIntent || PERSONA_REQUEST_PROMPT_PATTERN.test(promptText);
  const explicitNewPersonaRequest = isExplicitNewPersonaRequest(payload);
  const explicitVariantKey = resolveExplicitPersonaVariantKey(payload);
  const promptVariantKey = resolvePersonaVariantKeyFromPrompt(promptText);
  const variantKey =
    explicitVariantKey ??
    (explicitNewPersonaRequest ? promptVariantKey : null);
  const mainPersonaSlug =
    normalizePersonaSlug(mainPersonaSlugRaw) ?? DEFAULT_MAIN_PERSONA_SLUG;
  const shouldDefault = shouldDefaultPersonaReferences(
    payload,
    command,
    resolveRequestedGenerateKinds,
  );

  if (nonGenericExplicitSlug) {
    return {
      enabled: true,
      mainPersonaSlug,
      targetPersonaSlug: nonGenericExplicitSlug,
      source: "explicit",
      explicitPersonaSlug: nonGenericExplicitSlug,
      variantKey,
      allowNewPersonaCreation: explicitNewPersonaRequest,
    };
  }

  if (!personaIntent && !explicitGenericPersonaRequested && !shouldDefault) {
    return {
      enabled: false,
      mainPersonaSlug,
      targetPersonaSlug: mainPersonaSlug,
      source: "none",
      explicitPersonaSlug: explicitPersonaSlug,
      variantKey: null,
      allowNewPersonaCreation: false,
    };
  }

  const inferredVariantSlug =
    explicitNewPersonaRequest && variantKey
      ? normalizePersonaSlug(`${mainPersonaSlug}_${variantKey}`)
      : null;
  const targetPersonaSlug = inferredVariantSlug ?? mainPersonaSlug;
  return {
    enabled: true,
    mainPersonaSlug,
    targetPersonaSlug,
    source:
      inferredVariantSlug
        ? "inferred_variant"
        : personaMediaLock
          ? "forced_lock"
          : shouldDefault
            ? "default_media"
            : "inferred_main",
    explicitPersonaSlug,
    variantKey,
    allowNewPersonaCreation: explicitNewPersonaRequest,
  };
}

// ---------------------------------------------------------------------------
// shouldUsePersonaFrameReferences
// ---------------------------------------------------------------------------

export function shouldUsePersonaFrameReferences(plan: PersonaReferencePlan): boolean {
  if (!plan.enabled) return false;
  return !isGenericPersonaSlug(plan.targetPersonaSlug);
}

// ---------------------------------------------------------------------------
// isImageMimeType
// ---------------------------------------------------------------------------

export function isImageMimeType(value: string | null | undefined): boolean {
  const normalized = asNonEmptyString(value)?.trim().toLowerCase() ?? "";
  return normalized.startsWith("image/");
}

// ---------------------------------------------------------------------------
// isUploadableMediaMimeType
// ---------------------------------------------------------------------------

export function isUploadableMediaMimeType(value: string | null | undefined): boolean {
  const normalized = asNonEmptyString(value)?.trim().toLowerCase() ?? "";
  return normalized.startsWith("image/") || normalized.startsWith("video/");
}

// ---------------------------------------------------------------------------
// isLikelyImageReference
// ---------------------------------------------------------------------------

export function isLikelyImageReference(
  value: string | null | undefined,
  fallbackMimeType: string | null = null,
): boolean {
  const normalized = asNonEmptyString(value);
  if (!normalized) return false;
  const parsedDataUri = parseDataUriPayload(normalized);
  if (parsedDataUri) {
    return isImageMimeType(parsedDataUri.mime);
  }
  const inferredMime = inferMimeTypeFromUrl(normalized);
  if (inferredMime && isImageMimeType(inferredMime)) return true;
  if (inferredMime && inferredMime !== "application/octet-stream") return false;
  if (NON_IMAGE_REFERENCE_EXTENSION_PATTERN.test(normalized)) return false;
  if (isImageMimeType(fallbackMimeType)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// resolveMainPersonaSlugFromBridge
// ---------------------------------------------------------------------------

export async function resolveMainPersonaSlugFromBridge(
  ctx: { callAgentChatBridge: ((payload: unknown) => Promise<unknown>) | null },
  callBridgeLookupCached: CallBridgeLookupCachedFn,
): Promise<string | null> {
  if (!ctx.callAgentChatBridge) return null;
  try {
    const profileResult = await callBridgeLookupCached({
      action: "agent_profile",
    });
    const profileRecord = isRecord(profileResult.value) ? profileResult.value : null;
    const agentRecord =
      profileRecord && isRecord(profileRecord.agent) ? profileRecord.agent : null;
    const candidateValues: unknown[] = [
      agentRecord?.mainPersonaSlug,
      agentRecord?.mainRealismPersonaSlug,
      profileRecord?.mainPersonaSlug,
      profileRecord?.mainRealismPersonaSlug,
    ];
    for (const candidate of candidateValues) {
      const normalized = normalizePersonaSlug(candidate);
      if (normalized) return normalized;
    }
  } catch {
    // best-effort lookup only
  }
  return null;
}
