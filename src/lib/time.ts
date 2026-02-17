/**
 * Time and string helper utilities.
 *
 * Ported from agent-runtime.mjs lines 36, 1421-1467.
 */

export const nowIso = (): string => new Date().toISOString();

export const normalizeIso = (value: unknown): string => {
  if (typeof value !== "string") return nowIso();
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return nowIso();
  return new Date(ms).toISOString();
};

export const toShortLine = (value: unknown, maxLength = 140): string => {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized.length) return "";
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}\u2026`;
};

export const clampNumber = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
};

export const unique = <T>(values: T[]): T[] => Array.from(new Set(values));
