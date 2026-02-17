/**
 * Text utility functions.
 *
 * Ported from agent-runtime.mjs:
 *   - line 36:        nowIso
 *   - lines 77-118:   escapeRegExpLiteral, normalizePublicTopicToken,
 *                      normalizePathSlashes, normalizeHexDigest
 *   - lines 1060-1110: sanitizeTerminalText, sanitizeChallengePromptText,
 *                       sanitizeChallengeAnswerText
 *   - lines 1063-1067: toAnswerPreview
 *   - lines 1462-1467: toShortLine
 */

// ---------------------------------------------------------------------------
// nowIso
// ---------------------------------------------------------------------------

/** Current wall-clock time as an ISO-8601 string. */
export const nowIso = (): string => new Date().toISOString();

// ---------------------------------------------------------------------------
// Regex / token helpers
// ---------------------------------------------------------------------------

/** Escape special regex characters so the string can be used as a literal. */
export const escapeRegExpLiteral = (value: string): string =>
  String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Normalize a user-supplied public topic token:
 *   - trim + lowercase
 *   - replace non-alphanumeric sequences with hyphens
 *   - strip leading/trailing hyphens
 *
 * Returns `null` when the result would be empty.
 */
export const normalizePublicTopicToken = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const token = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return token.length > 0 ? token : null;
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

import path from "node:path";

/** Convert OS-specific separators to forward slashes. */
export const normalizePathSlashes = (value: unknown): string =>
  typeof value === "string" ? value.split(path.sep).join("/") : "";

/**
 * Validate and normalize a hex digest (MD5 = 32 chars, SHA-256 = 64 chars).
 * Returns an empty string when the input is not a valid hex digest.
 */
export const normalizeHexDigest = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  return /^[a-f0-9]{32}$/u.test(trimmed) || /^[a-f0-9]{64}$/u.test(trimmed)
    ? trimmed
    : "";
};

// ---------------------------------------------------------------------------
// Terminal / challenge text sanitization
// ---------------------------------------------------------------------------

/**
 * Strip ANSI escape sequences, OSC sequences, and control characters so
 * that terminal output is safe to embed in logs or prompts.
 */
export const sanitizeTerminalText = (value: unknown): string => {
  if (typeof value !== "string") return "";
  let text = value;
  // OSC sequences (e.g. title setting)
  text = text.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, " ");
  // CSI sequences (e.g. colour, cursor movement)
  text = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, " ");
  // Two-character escape sequences
  text = text.replace(/\u001b[@-_]/gu, " ");
  // Remaining C0 control characters
  text = text.replace(/[\u0000-\u001f\u007f]/gu, " ");
  // Bare DEC private mode fragments left over
  text = text.replace(/\[\?[0-9;]*[A-Za-z]/gu, " ");
  // Stray OSC-like fragments
  text = text.replace(/\]\d+;[^\s]+/gu, " ");
  return text.replace(/\s+/gu, " ").trim();
};

/** Sanitize a challenge prompt before sending it to an LLM. */
export const sanitizeChallengePromptText = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return sanitizeTerminalText(value);
};

/**
 * Sanitize a challenge answer returned by an LLM, removing common
 * preamble artifacts, console command echoes, and question tokens.
 */
export const sanitizeChallengeAnswerText = (value: unknown): string => {
  const normalized = sanitizeTerminalText(value);
  if (!normalized.length) return "";
  let cleaned = normalized;
  cleaned = cleaned.replace(/^\[mint challenge [^\]]+\]\s*/iu, "");
  cleaned = cleaned.replace(/^\[[a-z_]+\s+[^\]]+\]\s*/iu, "");
  cleaned = cleaned.replace(/^type answer only\.?\s*/iu, "");
  cleaned = cleaned.replace(/^answer>\s*/iu, "");
  cleaned = cleaned.replace(/\s*answer>\s*/iu, " ");
  cleaned = cleaned.replace(/^agent>\s*/iu, "");
  cleaned = cleaned.replace(/^[A-Za-z]:\\[^>]*>\s*/u, "");
  cleaned = cleaned.replace(/\s*\[questiontoken:[^\]]+\]\s*$/iu, "");
  cleaned = cleaned.replace(/\bquestiontoken\s*=\s*[a-f0-9-]+\b/giu, "");
  cleaned = cleaned.replace(/\s+/gu, " ").trim();
  return cleaned;
};

// ---------------------------------------------------------------------------
// Preview / truncation helpers
// ---------------------------------------------------------------------------

/**
 * Return a short preview of a string, truncated with "..." if necessary.
 */
export const toAnswerPreview = (
  value: unknown,
  maxLength: number = 48,
): string => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed.length) return "";
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
};

/**
 * Collapse whitespace into a single space and truncate with an ellipsis
 * character if necessary.
 */
export const toShortLine = (
  value: unknown,
  maxLength: number = 140,
): string => {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized.length) return "";
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}\u2026`;
};
