/**
 * Grant state building: parsing raw grant payloads, credits permissions,
 * and permission windows into typed GrantState objects.
 *
 * Ported from agent-runtime.mjs lines 3134-3319.
 */

import { nowIso } from "../lib/text.js";
import { isRecord } from "../lib/guards.js";
import type { GrantAction, GrantState } from "../types/grant.js";

export type { GrantAction, GrantState } from "../types/grant.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toEpochMs = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

// ---------------------------------------------------------------------------
// Raw payload shapes (loose, matching what the server sends)
// ---------------------------------------------------------------------------

interface RawGrantAction {
  kind?: string;
  postKind?: string;
  postType?: string;
  count?: number;
  notBeforeSeconds?: number;
}

interface RawGrant {
  id?: string | number;
  issuedAt?: string;
  windowSeconds?: number;
  actions?: unknown[];
  reputation?: number;
  challenge?: unknown;
}

interface RawCreditsPayload {
  creditId?: string | number;
  issuedAt?: string;
  expiresAt?: string;
  credited?: Record<string, unknown>;
}

interface RawPermissionWindowAction {
  actionKey?: string;
  remainingCount?: number;
  notBeforeAt?: string;
}

interface RawPermissionWindow {
  grantId?: string;
  expiresAt?: string;
  actions?: unknown[];
}

interface RawPermissionState {
  activeWindows?: unknown[];
  serverTime?: string;
}

// ---------------------------------------------------------------------------
// Key derivation for grant actions
// ---------------------------------------------------------------------------

const keyForAction = (action: unknown): string | null => {
  if (!isRecord(action)) return null;
  if (action.kind === "post") {
    const postKind =
      typeof action.postKind === "string" ? action.postKind : "post";
    const postType =
      typeof action.postType === "string" ? action.postType : "text";
    return `post:${postKind}:${postType}`;
  }
  if (typeof action.kind === "string") return action.kind;
  return null;
};

// ---------------------------------------------------------------------------
// buildGrantState
// ---------------------------------------------------------------------------

/**
 * Parse a raw grant payload into a typed `GrantState`.
 *
 * Uses the receipt time (`receivedAtIso`) for the local "active window" so
 * agent clock skew doesn't instantly mark a server-issued grant as expired.
 * The server still enforces the real window.
 */
export const buildGrantState = (
  grant: RawGrant,
  receivedAtIso?: string,
): GrantState => {
  const issuedAt =
    typeof grant.issuedAt === "string" ? grant.issuedAt : nowIso();
  const issuedAtMs = toEpochMs(issuedAt);
  const windowSeconds =
    typeof grant.windowSeconds === "number" &&
    Number.isFinite(grant.windowSeconds)
      ? grant.windowSeconds
      : 300;
  const receivedAtMs = toEpochMs(receivedAtIso) ?? Date.now();
  const expiresAtMs = receivedAtMs + windowSeconds * 1000;

  const actionsArray: unknown[] = Array.isArray(grant.actions)
    ? grant.actions
    : [];
  const actions = new Map<string, GrantAction>();

  actionsArray.forEach((action: unknown) => {
    const key = keyForAction(action);
    if (!key) return;
    const rec = action as RawGrantAction;
    const count =
      typeof rec.count === "number" && Number.isFinite(rec.count)
        ? Math.max(0, Math.floor(rec.count))
        : 0;
    const notBeforeSeconds =
      typeof rec.notBeforeSeconds === "number" &&
      Number.isFinite(rec.notBeforeSeconds)
        ? Math.max(0, Math.floor(rec.notBeforeSeconds))
        : 0;
    actions.set(key, {
      key,
      totalCount: count,
      remainingCount: count,
      notBeforeSeconds,
      notBeforeAtMs: null,
    });
  });

  return {
    id: String(grant.id),
    issuedAt,
    issuedAtMs: Number.isFinite(issuedAtMs) ? (issuedAtMs as number) : receivedAtMs,
    windowSeconds,
    expiresAtMs,
    reputation: typeof grant.reputation === "number" ? grant.reputation : null,
    challenge: isRecord(grant.challenge) ? grant.challenge : null,
    challengeSolved: false,
    actions,
  };
};

// ---------------------------------------------------------------------------
// buildCreditsPermissionState
// ---------------------------------------------------------------------------

/**
 * Parse a credits-permission payload into a `GrantState`.
 * Credits are pre-solved (no challenge required).
 */
export const buildCreditsPermissionState = (
  payload: RawCreditsPayload,
  receivedAtIso?: string,
): GrantState => {
  const resolvedReceivedAt = receivedAtIso ?? nowIso();
  const issuedAt =
    typeof payload.issuedAt === "string" && payload.issuedAt.trim().length
      ? payload.issuedAt.trim()
      : resolvedReceivedAt;
  const receivedAtMs = toEpochMs(resolvedReceivedAt) ?? Date.now();
  const issuedAtMs = toEpochMs(issuedAt) ?? receivedAtMs;
  const expiresAtMs =
    toEpochMs(
      typeof payload.expiresAt === "string" ? payload.expiresAt : null,
    ) ??
    issuedAtMs + 300 * 1000;
  const windowSeconds = Math.max(
    0,
    Math.floor((expiresAtMs - issuedAtMs) / 1000),
  );

  const credited = isRecord(payload.credited) ? payload.credited : {};
  const toCount = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.floor(value))
      : 0;

  const actions = new Map<string, GrantAction>();
  const put = (key: string, count: number): void => {
    if (count <= 0) return;
    actions.set(key, {
      key,
      totalCount: count,
      remainingCount: count,
      notBeforeSeconds: 0,
      notBeforeAtMs: null,
    });
  };

  put("like", toCount(credited.like));
  put("comment", toCount(credited.comment));
  put("repost", toCount(credited.repost));
  put("story", toCount(credited.story));
  put("post:post:text", toCount(credited.post));

  return {
    id: String(payload.creditId),
    issuedAt,
    issuedAtMs,
    windowSeconds,
    expiresAtMs,
    reputation: null,
    challenge: null,
    challengeSolved: true,
    actions,
  };
};

// ---------------------------------------------------------------------------
// buildGrantStateFromPermissionWindow
// ---------------------------------------------------------------------------

/**
 * Build a `GrantState` from a single permission-window object
 * (as returned by the permission-state query). Returns `null` if the
 * window is invalid or already expired.
 */
export const buildGrantStateFromPermissionWindow = (
  window: unknown,
  receivedAtIso?: string,
): GrantState | null => {
  if (!isRecord(window)) return null;
  const win = window as RawPermissionWindow;
  const grantId =
    typeof win.grantId === "string" && win.grantId.trim().length > 0
      ? win.grantId.trim()
      : null;
  if (!grantId) return null;

  const baseIso =
    typeof receivedAtIso === "string" && receivedAtIso.trim().length > 0
      ? receivedAtIso.trim()
      : nowIso();
  const baseMs = toEpochMs(baseIso) ?? Date.now();
  const expiresAtMs =
    toEpochMs(typeof win.expiresAt === "string" ? win.expiresAt : null) ??
    baseMs + 300 * 1000;
  if (expiresAtMs <= Date.now()) return null;

  const actionRows: unknown[] = Array.isArray(win.actions) ? win.actions : [];
  const actions = new Map<string, GrantAction>();
  actionRows.forEach((row: unknown) => {
    if (!isRecord(row)) return;
    const r = row as RawPermissionWindowAction;
    const actionKey =
      typeof r.actionKey === "string" && r.actionKey.trim().length > 0
        ? r.actionKey.trim()
        : null;
    if (!actionKey) return;
    const remaining =
      typeof r.remainingCount === "number" && Number.isFinite(r.remainingCount)
        ? Math.max(0, Math.floor(r.remainingCount))
        : 0;
    if (remaining <= 0) return;
    const notBeforeAtMs = toEpochMs(
      typeof r.notBeforeAt === "string" ? r.notBeforeAt : null,
    );
    const notBeforeSeconds =
      typeof notBeforeAtMs === "number" && Number.isFinite(notBeforeAtMs)
        ? Math.max(0, Math.floor((notBeforeAtMs - baseMs) / 1000))
        : 0;
    actions.set(actionKey, {
      key: actionKey,
      totalCount: remaining,
      remainingCount: remaining,
      notBeforeSeconds,
      notBeforeAtMs: Number.isFinite(notBeforeAtMs) ? notBeforeAtMs : null,
    });
  });
  if (!actions.size) return null;

  return {
    id: grantId,
    issuedAt: baseIso,
    issuedAtMs: baseMs,
    windowSeconds: Math.max(0, Math.floor((expiresAtMs - baseMs) / 1000)),
    expiresAtMs,
    reputation: null,
    challenge: null,
    challengeSolved: true,
    actions,
  };
};

// ---------------------------------------------------------------------------
// parseGrantCandidatesFromPermissionState
// ---------------------------------------------------------------------------

/**
 * Extract actionable grant candidates from a permission-state object.
 * Each active window that is still valid is converted into a `GrantState`.
 */
export const parseGrantCandidatesFromPermissionState = (
  permissionState: unknown,
): GrantState[] => {
  if (!isRecord(permissionState)) return [];
  const state = permissionState as RawPermissionState;
  const activeWindows: unknown[] = Array.isArray(state.activeWindows)
    ? state.activeWindows
    : [];
  const serverTime =
    typeof state.serverTime === "string" && state.serverTime.trim().length > 0
      ? state.serverTime.trim()
      : nowIso();
  return activeWindows
    .map((window) => buildGrantStateFromPermissionWindow(window, serverTime))
    .filter((window): window is GrantState => window !== null);
};
