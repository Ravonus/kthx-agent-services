/**
 * WebSocket state tracking: deriving effective connection state,
 * building debug snapshots, and tracking activity timestamps.
 *
 * Ported from agent-runtime.mjs lines 4222-4436.
 *
 * NOTE: Functions that in the original source accessed closure variables
 * (e.g. `lastWsTransportState`, `lastWsActivityAt`) are re-designed here
 * to accept a narrow context interface so they remain pure and avoid
 * circular dependencies on RuntimeContext.
 */

import fs from "node:fs/promises";

import { nowIso } from "../lib/text.js";
import type { IpcPaths } from "../types/ipc.js";

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
// Types
// ---------------------------------------------------------------------------

/**
 * Represents the "ws" block inside the debug snapshot.
 */
export interface WsDebugBlock {
  state: string;
  transportState: string;
  at: string | null;
  activityAt: string | null;
  activitySource: string | null;
}

/**
 * Full debug snapshot that is persisted to disk.
 */
export interface DebugSnapshot {
  updatedAt: string;
  ws: WsDebugBlock;
  auth: Record<string, unknown> | null;
  permission: Record<string, unknown> | null;
  publish: Record<string, unknown> | null;
  lastSubscriptionError: Record<string, unknown> | null;
  lastUnauthorized: Record<string, unknown> | null;
  lastHeartbeatError: Record<string, unknown> | null;
  lastEnvelopeAt: string | null;
  runtimeIntegrity: Record<string, unknown> | null;
}

/**
 * Mutable WS tracking state that callers own and pass into the helpers.
 */
export interface WsTrackingState {
  lastWsState: string | null;
  lastWsTransportState: string | null;
  lastWsStateAt: string | null;
  lastWsActivityAt: string | null;
  lastWsActivitySource: string | null;
  lastWsSnapshotWriteAtMs: number;
  wsPendingSinceIso: string | null;
}

/**
 * Narrow context interface for functions that need config + ipcPaths + ws state.
 * Avoids importing a full RuntimeContext and prevents circular deps.
 */
export interface WsStateContext {
  ws: WsTrackingState;
  config: {
    wsActivityStaleMs: number;
  };
  ipcPaths: IpcPaths;
  debugSnapshot: DebugSnapshot;
}

// ---------------------------------------------------------------------------
// State checks
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the transport state represents an active connection.
 */
export const isConnectedSocketState = (
  state: string | null,
): boolean => state === "connected" || state === "open";

/**
 * Derive the effective WebSocket state from the transport state and
 * recent activity timestamps.
 *
 * - If the transport reports "connected" or "open", effective state is "open".
 * - Otherwise, if there was recent activity within `wsActivityStaleMs`,
 *   we still consider it "open".
 * - Falls back to the raw transport state, or "unknown".
 */
export const resolveEffectiveWsState = (
  transportState: string | null,
  lastActivityAt: string | null,
  wsActivityStaleMs: number,
): string => {
  if (isConnectedSocketState(transportState)) return "open";

  if (typeof lastActivityAt === "string") {
    const lastActivityMs = toEpochMs(lastActivityAt);
    if (
      typeof lastActivityMs === "number" &&
      Number.isFinite(lastActivityMs) &&
      Date.now() - lastActivityMs <= wsActivityStaleMs
    ) {
      return "open";
    }
  }

  if (
    typeof transportState === "string" &&
    transportState.length > 0
  ) {
    return transportState;
  }

  return "unknown";
};

// ---------------------------------------------------------------------------
// Debug snapshot
// ---------------------------------------------------------------------------

/**
 * Creates a fresh, empty debug snapshot with all fields initialised to
 * their default values.
 */
export const createDebugSnapshot = (): DebugSnapshot => ({
  updatedAt: nowIso(),
  ws: {
    state: "unknown",
    transportState: "unknown",
    at: null,
    activityAt: null,
    activitySource: null,
  },
  auth: null,
  permission: null,
  publish: null,
  lastSubscriptionError: null,
  lastUnauthorized: null,
  lastHeartbeatError: null,
  lastEnvelopeAt: null,
  runtimeIntegrity: null,
});

/**
 * Creates a fresh, empty WS tracking state.
 */
export const createWsTrackingState = (): WsTrackingState => ({
  lastWsState: null,
  lastWsTransportState: null,
  lastWsStateAt: null,
  lastWsActivityAt: null,
  lastWsActivitySource: null,
  lastWsSnapshotWriteAtMs: 0,
  wsPendingSinceIso: null,
});

/**
 * Build the `ws` block of the debug snapshot from the current tracking state.
 */
export const refreshWsDebugSnapshot = (
  ctx: WsStateContext,
  force: boolean = false,
): void => {
  const effectiveState = resolveEffectiveWsState(
    ctx.ws.lastWsTransportState,
    ctx.ws.lastWsActivityAt,
    ctx.config.wsActivityStaleMs,
  );

  ctx.debugSnapshot.ws = {
    state: effectiveState,
    transportState: ctx.ws.lastWsTransportState ?? "unknown",
    at: ctx.ws.lastWsStateAt,
    activityAt: ctx.ws.lastWsActivityAt,
    activitySource: ctx.ws.lastWsActivitySource,
  };

  const nowMs = Date.now();
  if (force || nowMs - ctx.ws.lastWsSnapshotWriteAtMs >= 5_000) {
    ctx.ws.lastWsSnapshotWriteAtMs = nowMs;
    void writeDebugSnapshot(ctx.ipcPaths, ctx.debugSnapshot);
  }
};

// ---------------------------------------------------------------------------
// Activity tracking
// ---------------------------------------------------------------------------

export interface MarkWsActivityResult {
  /** The new effective state after marking activity. */
  effectiveState: string;
  /** The previous effective state before this call. */
  previousState: string | null;
  /** `true` when the effective state changed. */
  stateChanged: boolean;
  /** ISO timestamp of the activity. */
  activityAt: string;
}

/**
 * Record a WebSocket activity event, update tracking state, and refresh
 * the debug snapshot.  Returns information about any state transition.
 */
export const markWsActivity = (
  ctx: WsStateContext,
  source: string,
): MarkWsActivityResult => {
  const activityAt = nowIso();
  ctx.ws.lastWsActivityAt = activityAt;
  ctx.ws.lastWsActivitySource = source;

  const previousState = ctx.ws.lastWsState;
  const nextState = resolveEffectiveWsState(
    ctx.ws.lastWsTransportState,
    ctx.ws.lastWsActivityAt,
    ctx.config.wsActivityStaleMs,
  );
  const stateChanged = previousState !== nextState;
  ctx.ws.lastWsState = nextState;
  ctx.ws.lastWsStateAt = activityAt;

  if (nextState === "open") {
    ctx.ws.wsPendingSinceIso = null;
  }

  refreshWsDebugSnapshot(ctx, stateChanged);

  return {
    effectiveState: nextState,
    previousState,
    stateChanged,
    activityAt,
  };
};

// ---------------------------------------------------------------------------
// Disk persistence
// ---------------------------------------------------------------------------

/**
 * Write the debug snapshot JSON to disk (non-fatal on error).
 */
export const writeDebugSnapshot = async (
  ipcPaths: IpcPaths,
  snapshot: DebugSnapshot,
): Promise<void> => {
  snapshot.updatedAt = nowIso();
  await fs
    .writeFile(
      ipcPaths.latestDebugPath,
      JSON.stringify(snapshot, null, 2),
      "utf8",
    )
    .catch(() => {});
};

// ---------------------------------------------------------------------------
// Readiness helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the runtime socket is fully ready:
 * WS is open, auth is "ok", and user subscriptions are ready.
 *
 * Because `getAuthStateValue` and `userSubscriptionsReady` depend on deep
 * runtime context, this function accepts them as callbacks so the caller
 * can wire them in without creating circular deps.
 */
export const runtimeSocketReady = (
  lastWsState: string | null,
  getAuthStateValue: () => string,
  userSubscriptionsReady: () => boolean,
): boolean =>
  lastWsState === "open" &&
  getAuthStateValue() === "ok" &&
  userSubscriptionsReady();

/**
 * Returns a human-readable string explaining why the runtime socket is
 * not yet ready, or `"ready"` when it is.
 */
export const runtimeSocketReadinessReason = (
  lastWsState: string | null,
  getAuthStateValue: () => string,
  userSubscriptionsReady: () => boolean,
): string => {
  if (lastWsState !== "open") return "ws_not_open";
  const authState = getAuthStateValue();
  if (authState !== "ok") return `auth_${authState}`;
  if (!userSubscriptionsReady()) return "user_subscriptions_not_ready";
  return "ready";
};
