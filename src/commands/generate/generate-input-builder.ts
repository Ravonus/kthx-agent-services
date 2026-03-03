/** Generate input payload builder — assembles the core input record for media/content generation. */

import crypto from "node:crypto";

import type { Command } from "../../types/ipc.js";

import {
  asNonEmptyString,
  asPositiveInt,
  normalizeAgentProvenanceValue,
} from "../helpers.js";

import { resolveCommandSourceDirectiveId, resolveCommandSourceDirectiveActionNonce } from "../directives/resolution.js";
import { isChatOriginCommand } from "../write/chat-write-intent.js";
import { isPersonaMediaLockEnabled } from "../persona/persona-resolution.js";
import {
  mapGoalToGenerateKind,
  resolveRequestedGenerateKinds,
  resolveDirectiveScopeGenerateKinds,
  collectMediaReferenceInputs,
} from "./generate-input.js";

import { MAX_COLLECTED_REFERENCE_INPUTS } from "../constants.js";

import { isRecord } from "../../lib/guards.js";

// ---------------------------------------------------------------------------
// buildGenerateInput
// ---------------------------------------------------------------------------

export function buildGenerateInput(
  payload: Record<string, unknown>,
  command: Command,
): Record<string, unknown> {
  const isChatOrigin = isChatOriginCommand(command, payload);
  const context = isRecord(payload.context) ? payload.context : null;
  const goal =
    asNonEmptyString(payload.goal)?.toLowerCase() ??
    asNonEmptyString(payload.kind)?.toLowerCase() ??
    (isChatOrigin ? "media" : "story");
  const mappedKind = mapGoalToGenerateKind(goal);
  const requestedKinds = resolveRequestedGenerateKinds(payload, mappedKind);
  const scopedKinds = resolveDirectiveScopeGenerateKinds(payload);
  const mergedKinds = [...requestedKinds];
  for (const scopedKind of scopedKinds) {
    if (!mergedKinds.includes(scopedKind)) {
      mergedKinds.push(scopedKind);
    }
  }
  const personaMediaLock = isPersonaMediaLockEnabled(payload);
  const resolvedKindsBase = isChatOrigin
    ? mergedKinds.filter((kind) => kind !== "story")
    : mergedKinds;
  const resolvedKinds = personaMediaLock ? ["media"] : resolvedKindsBase;
  if (resolvedKinds.length === 0) {
    resolvedKinds.push(isChatOrigin ? "media" : mappedKind);
  }
  const primaryKind = resolvedKinds[0] ?? (isChatOrigin ? "media" : mappedKind);
  const scope = isRecord(payload.directiveScope) ? payload.directiveScope : null;
  const scopedTarget = scope && isRecord(scope.target) ? scope.target : null;
  const postId =
    asPositiveInt(payload.postId) ??
    asPositiveInt(payload.targetPostId) ??
    (scope
      ? asPositiveInt(scope.targetPostId) ??
        (scopedTarget ? asPositiveInt(scopedTarget.postId) : null)
      : null);
  const commentId =
    asPositiveInt(payload.commentId) ??
    asPositiveInt(payload.targetCommentId) ??
    (scope
      ? asPositiveInt(scope.targetCommentId) ??
        (scopedTarget ? asPositiveInt(scopedTarget.commentId) : null)
      : null);
  const count = asPositiveInt(payload.count);
  const topic =
    asNonEmptyString(payload.topic) ??
    asNonEmptyString(context?.topic) ??
    asNonEmptyString(payload.requestText) ??
    asNonEmptyString(payload.prompt) ??
    null;
  const mood =
    asNonEmptyString(payload.mood) ??
    asNonEmptyString(context?.mood);
  const collectStringArray = (
    value: unknown,
    max: number,
  ): string[] => {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const entry of value) {
      const normalized = asNonEmptyString(entry);
      if (!normalized) continue;
      out.push(normalized);
      if (out.length >= max) break;
    }
    return out;
  };
  const collectHandleArray = (
    value: unknown,
    max: number,
  ): string[] => {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry === "string") {
        const normalized = entry.trim().replace(/^@+/u, "").toLowerCase();
        if (!normalized.length) continue;
        out.push(normalized);
        if (out.length >= max) break;
        continue;
      }
      if (!isRecord(entry)) continue;
      const handle = asNonEmptyString(entry.handle);
      if (!handle) continue;
      out.push(handle.replace(/^@+/u, "").toLowerCase());
      if (out.length >= max) break;
    }
    return out;
  };
  const tags = Array.from(
    new Set(
      [
        ...collectStringArray(payload.tags, 24),
        ...collectStringArray(payload.mediaLabels, 24),
        ...collectStringArray(payload.labels, 24),
        ...collectStringArray(context?.tags, 24),
        ...collectStringArray(context?.mediaLabels, 24),
        ...collectStringArray(context?.labels, 24),
      ].map((entry) => entry.trim()),
    ),
  )
    .filter((entry) => entry.length > 0)
    .slice(0, 24);
  const taggedHandles = Array.from(
    new Set(
      [
        ...collectHandleArray(payload.taggedHandles, 24),
        ...collectHandleArray(payload.taggedUsers, 24),
        ...collectHandleArray(context?.taggedHandles, 24),
        ...collectHandleArray(context?.taggedUsers, 24),
      ],
    ),
  ).slice(0, 24);
  const mediaReferenceUrls = collectMediaReferenceInputs(payload, MAX_COLLECTED_REFERENCE_INPUTS).slice(0, 12);
  const mediaMode =
    asNonEmptyString(payload.mediaMode)?.toLowerCase() ??
    asNonEmptyString(context?.mediaMode)?.toLowerCase() ??
    null;
  const mediaPersona =
    asNonEmptyString(payload.mediaPersona) ??
    asNonEmptyString(payload.persona) ??
    asNonEmptyString(payload.personaName) ??
    asNonEmptyString(context?.mediaPersona) ??
    asNonEmptyString(context?.persona) ??
    asNonEmptyString(context?.personaName) ??
    null;
  const mediaPersonaStyleHint =
    asNonEmptyString(payload.mediaPersonaStyleHint) ??
    asNonEmptyString(payload.personaStyleHint) ??
    asNonEmptyString(context?.mediaPersonaStyleHint) ??
    asNonEmptyString(context?.personaStyleHint) ??
    null;
  const explicitVariationSeed = asNonEmptyString(payload.variationSeed);
  const directiveActionNonceSeed =
    asNonEmptyString(payload.sourceDirectiveActionNonce) ??
    command.actionNonce ??
    null;
  const variationSeed =
    explicitVariationSeed ??
    (directiveActionNonceSeed
      ? `${directiveActionNonceSeed}:${Date.now().toString(36)}:${crypto
          .randomUUID()
          .replaceAll("-", "")
          .slice(0, 8)}`
      : `${Date.now().toString(36)}_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`);
  const provenance = normalizeAgentProvenanceValue(payload.provenance);
  const sourceDirectiveId =
    resolveCommandSourceDirectiveId({ command, payload });
  const sourceDirectiveActionNonce =
    resolveCommandSourceDirectiveActionNonce({ command, payload });
  return {
    kind: primaryKind,
    ...(resolvedKinds.length > 0 ? { kinds: resolvedKinds } : {}),
    ...(count ? { count } : {}),
    ...(topic ? { topic } : {}),
    ...(mood ? { mood } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(mediaMode ? { mediaMode } : {}),
    ...(mediaPersona ? { mediaPersona } : {}),
    ...(mediaPersonaStyleHint ? { mediaPersonaStyleHint } : {}),
    ...(personaMediaLock ? { mediaPersonaLock: true } : {}),
    ...(taggedHandles.length > 0 ? { taggedHandles } : {}),
    ...(mediaReferenceUrls.length > 0 ? { mediaReferenceUrls } : {}),
    ...(variationSeed ? { variationSeed } : {}),
    ...(postId ? { postId } : {}),
    ...(commentId ? { commentId } : {}),
    ...(provenance ? { provenance } : {}),
    ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
    ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
    ...(command.grantId ? { grantId: command.grantId } : {}),
  };
}
