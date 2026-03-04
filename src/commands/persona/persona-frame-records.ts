import { isRecord } from "../../lib/guards.js";
import { asNonEmptyString, asPositiveInt } from "../helpers.js";
import {
  REQUIRED_PERSONA_REFERENCE_FRAME_COUNT,
} from "../constants.js";
import type { PersonaFrameRecord, PersonaFrameRole } from "../types.js";
import { PERSONA_REFERENCE_FRAME_ROLES } from "../types.js";
import {
  normalizePersonaSlug,
  isLikelyImageReference,
} from "./persona-resolution.js";
import {
  normalizePersonaFrameRole,
  parseIsoOrNull,
} from "./persona-frame-parsing.js";
import type { IsStreamPartArtifactReferenceFn } from "./persona-frame-context.js";

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

export function getPersonaFrameRoleSortValue(frameRole: PersonaFrameRole): number {
  const index = PERSONA_REFERENCE_FRAME_ROLES.indexOf(frameRole);
  return index >= 0 ? index : PERSONA_REFERENCE_FRAME_ROLES.length + 1;
}

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
