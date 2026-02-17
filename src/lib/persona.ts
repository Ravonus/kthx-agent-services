/**
 * Persona normalization utilities.
 *
 * Ported from agent-runtime.mjs lines 334-398.
 */

import { isRecord } from "./guards.js";

// ---------------------------------------------------------------------------
// PersonaDefinition type
// ---------------------------------------------------------------------------

export type PersonaDefinition = {
  name: string;
  aliases: string[];
  labels: string[];
  styleHint: string;
};

// ---------------------------------------------------------------------------
// Token normalization
// ---------------------------------------------------------------------------

export const normalizePersonaToken = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
};

export const normalizeMediaLabelTokens = (
  rawValue: unknown,
  fallback: unknown[] = [],
): string[] => {
  const values = Array.isArray(rawValue)
    ? rawValue
    : Array.isArray(fallback)
      ? fallback
      : [];
  const normalized: string[] = [];
  for (const value of values) {
    const token = normalizePersonaToken(value);
    if (!token.length) continue;
    normalized.push(token);
  }
  return Array.from(new Set(normalized)).slice(0, 24);
};

// ---------------------------------------------------------------------------
// Persona list normalization
// ---------------------------------------------------------------------------

export const normalizePersonaDefinitions = (
  rawValue: unknown,
  fallback: unknown,
): PersonaDefinition[] => {
  const source = Array.isArray(rawValue) ? rawValue : [];
  const fallbackList = Array.isArray(fallback) ? fallback : [];

  const toNormalized = (item: unknown): PersonaDefinition | null => {
    if (!isRecord(item)) return null;
    const name = normalizePersonaToken(item.name);
    if (!name.length) return null;
    const aliases = normalizeMediaLabelTokens(item.aliases);
    const labels = normalizeMediaLabelTokens(item.labels, [name]);

    const styleHintCandidate =
      typeof item.prompt === "string" && item.prompt.trim().length > 0
        ? item.prompt.trim()
        : typeof item.stylePrompt === "string" &&
            item.stylePrompt.trim().length > 0
          ? item.stylePrompt.trim()
          : typeof item.styleHint === "string" &&
              item.styleHint.trim().length > 0
            ? item.styleHint.trim()
            : "";

    return {
      name,
      aliases,
      labels: labels.length > 0 ? labels : [name],
      styleHint: styleHintCandidate,
    };
  };

  const byName = new Map<string, PersonaDefinition>();
  for (const item of source) {
    const parsed = toNormalized(item);
    if (!parsed || byName.has(parsed.name)) continue;
    byName.set(parsed.name, parsed);
  }
  if (byName.size === 0) {
    for (const item of fallbackList) {
      const parsed = toNormalized(item);
      if (!parsed || byName.has(parsed.name)) continue;
      byName.set(parsed.name, parsed);
    }
    return Array.from(byName.values()).slice(0, 32);
  }
  for (const item of fallbackList) {
    const parsed = toNormalized(item);
    if (!parsed || byName.has(parsed.name)) continue;
    byName.set(parsed.name, parsed);
  }
  return Array.from(byName.values()).slice(0, 32);
};

// ---------------------------------------------------------------------------
// Default templates
// ---------------------------------------------------------------------------

export const DEFAULT_IMAGE_COMMAND_TEMPLATE: string =
  'generateImage --sync --dir "{dir}" --files "{files}" "{prompt}"';

export const DEFAULT_OPENCLAW_PROMPT_TEMPLATE: string =
  'openclaw agent --agent "{agent}" --json --thinking medium -m "{prompt}"';

// ---------------------------------------------------------------------------
// Default persona definitions
// ---------------------------------------------------------------------------

export const DEFAULT_MEDIA_PERSONA_DEFINITIONS: PersonaDefinition[] = [
  {
    name: "default",
    aliases: ["general", "main"],
    labels: ["general"],
    styleHint: "",
  },
  {
    name: "real_me",
    aliases: ["selfie", "irl", "real me", "my face"],
    labels: ["selfie", "real_me"],
    styleHint: "",
  },
  {
    name: "virtual_me",
    aliases: ["avatar", "digital me", "virtual me"],
    labels: ["virtual_me", "avatar"],
    styleHint: "",
  },
  {
    name: "anime_persona",
    aliases: ["anime", "anime me", "manga", "chibi", "anime_style"],
    labels: ["anime_persona", "stylized_character", "creative_image"],
    styleHint: "",
  },
  {
    name: "creative_image",
    aliases: ["creative", "imaginative", "concept"],
    labels: ["creative_image", "stylized"],
    styleHint: "",
  },
  {
    name: "group_photo",
    aliases: ["group", "friends", "group photo", "team shot"],
    labels: ["group_photo", "group", "social"],
    styleHint: "",
  },
  {
    name: "activities",
    aliases: ["activity", "action", "outdoor", "lifestyle"],
    labels: ["activities", "activity", "lifestyle"],
    styleHint: "",
  },
];
