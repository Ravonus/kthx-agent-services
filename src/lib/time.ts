/**
 * Time helper utilities.
 *
 * Ported from agent-runtime.mjs lines 36, 1421-1467.
 */

import { nowIso } from "./text.js";

export const normalizeIso = (value: unknown): string => {
  if (typeof value !== "string") return nowIso();
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return nowIso();
  return new Date(ms).toISOString();
};

/** Parse an ISO-8601 string to epoch-ms, returning `null` on failure. */
export const parseIsoToMs = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
};

export const clampNumber = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
};

export const unique = <T>(values: T[]): T[] => Array.from(new Set(values));
