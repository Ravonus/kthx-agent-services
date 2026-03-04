import type { PersonaFrameRole } from "../types.js";
import { asNonEmptyString } from "../helpers.js";

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

export function parseIsoOrNull(value: unknown): string | null {
  const text = asNonEmptyString(value);
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}
