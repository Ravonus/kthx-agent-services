/**
 * Environment variable parsing utilities.
 *
 * Ported from agent-runtime.mjs lines 41-75.
 */

// ---------------------------------------------------------------------------
// trimEnv
// ---------------------------------------------------------------------------

/**
 * Read an environment variable, trim whitespace, and return `null` when
 * the result is empty.
 */
export const trimEnv = (key: string): string | null => {
  const value = process.env[key];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
};

// ---------------------------------------------------------------------------
// requiredEnv
// ---------------------------------------------------------------------------

/**
 * Like `trimEnv` but throws when the variable is missing or blank.
 */
export const requiredEnv = (key: string): string => {
  const value = trimEnv(key);
  if (!value) throw new Error(`Missing required env: ${key}`);
  return value;
};

// ---------------------------------------------------------------------------
// parseIntEnv
// ---------------------------------------------------------------------------

/**
 * Parse an environment variable as a base-10 integer, returning `fallback`
 * when the variable is missing or not a finite number.
 */
export const parseIntEnv = (key: string, fallback: number): number => {
  const raw = trimEnv(key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

// ---------------------------------------------------------------------------
// parseBoundedIntEnv
// ---------------------------------------------------------------------------

export type IntBounds = {
  min: number;
  max: number;
};

/**
 * Parse an environment variable as an integer clamped to `[bounds.min, bounds.max]`.
 * Returns `null` when the variable is missing or non-numeric.
 */
export const parseBoundedIntEnv = (
  key: string,
  bounds: IntBounds,
): number | null => {
  const raw = trimEnv(key);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(bounds.min, Math.min(bounds.max, parsed));
};

// ---------------------------------------------------------------------------
// parseCsvEnv
// ---------------------------------------------------------------------------

/**
 * Parse a comma-separated environment variable into a trimmed, non-empty
 * string array.
 */
export const parseCsvEnv = (key: string): string[] => {
  const raw = trimEnv(key);
  if (!raw) return [];
  return raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
};
