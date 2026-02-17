/**
 * AuthManager: handles UNAUTHORIZED events and token refresh flows.
 *
 * Tracks unauthorized streaks, debounces refresh attempts, and coordinates
 * with the WS client to trigger reconnection after auth state changes.
 *
 * Ported from agent-runtime.mjs lines 8329-8391 (refreshAuthAndReconnect,
 * noteUnauthorized) and lines 9561-9566 (getAuthStateValue).
 */

import { nowIso } from "../lib/text.js";
import { isRecord } from "../lib/guards.js";
import {
  clearBotTokenState,
} from "./bot-token.js";
import type { AuthManagerLike, AuthTrackingState } from "../runtime-context.js";
import type { DebugSnapshot } from "../debug/ws-state.js";

// ---------------------------------------------------------------------------
// Narrow context interface
// ---------------------------------------------------------------------------

/**
 * Narrow context that AuthManager needs to operate.
 * Avoids importing RuntimeContext directly to prevent circular deps.
 */
export interface AuthManagerContext {
  auth: AuthTrackingState;
  config: {
    connectionId: string;
  };
  debugSnapshot: DebugSnapshot;
  memory: {
    recordWrite(payload: unknown): Promise<void>;
  };
  misc: {
    subscriptionResyncRequested: boolean;
    subscriptionResyncReason: string | null;
    lastSubscriptionRefreshAtMs: number;
  };
  /** WS client handle; may be null during early bootstrap. */
  wsClient: {
    activeConnection: {
      close(): Promise<void>;
    };
  } | null;
  /** Callback to persist the debug snapshot to disk. */
  writeDebugSnapshot(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a tRPC error message from an unknown error value.
 */
const getTrpcErrorMessage = (error: unknown): string | null => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return null;
};

/**
 * Returns `true` when the error message indicates a bot token that is
 * permanently invalid (not just expired).
 */
const isBotTokenHardInvalidMessage = (message: string | null): boolean => {
  const normalized =
    typeof message === "string" && message.trim().length > 0
      ? message.trim().toLowerCase()
      : "";
  if (!normalized.length) return false;
  return (
    normalized.includes("bot token invalid") ||
    normalized.includes("bot token expired") ||
    normalized.includes("bot token missing") ||
    normalized.includes("bound to a different connectionid") ||
    normalized.includes("not bound to an agent")
  );
};

// ---------------------------------------------------------------------------
// AuthManager
// ---------------------------------------------------------------------------

/**
 * Minimum gap (ms) between consecutive auth refresh attempts.
 */
const AUTH_REFRESH_MIN_GAP_MS = 10_000;

/**
 * If the last UNAUTHORIZED was more than this many ms ago, the streak resets.
 */
const UNAUTHORIZED_STREAK_RESET_MS = 180_000;

export class AuthManager implements AuthManagerLike {
  private readonly ctx: AuthManagerContext;

  constructor(ctx: AuthManagerContext) {
    this.ctx = ctx;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Called when the runtime receives an UNAUTHORIZED error from any tRPC
   * procedure (heartbeat, command execution, subscription, etc.).
   *
   * Tracks a streak counter, decides whether to invalidate the cached
   * bot token, updates the debug snapshot, and triggers a reconnection.
   */
  async handleUnauthorized(reason: string = "unknown", error: unknown = null): Promise<void> {
    const nowMs = Date.now();

    // Reset streak if enough time has passed since the last UNAUTHORIZED.
    if (nowMs - this.ctx.auth.lastUnauthorizedAtMs > UNAUTHORIZED_STREAK_RESET_MS) {
      this.ctx.auth.unauthorizedStreak = 0;
    }
    this.ctx.auth.lastUnauthorizedAtMs = nowMs;

    const errorMessage = error ? getTrpcErrorMessage(error) : null;

    const shouldTrackStreak =
      reason === "heartbeat_unauthorized" || reason === "command_unauthorized";
    if (shouldTrackStreak) {
      this.ctx.auth.unauthorizedStreak += 1;
    }

    // Hard-invalidate the token after 2+ consecutive heartbeat UNAUTHORIZED
    // responses with a hard-invalid message.
    const invalidateToken =
      reason === "heartbeat_unauthorized" &&
      isBotTokenHardInvalidMessage(errorMessage) &&
      this.ctx.auth.unauthorizedStreak >= 2;

    await this.ctx.memory.recordWrite({
      type: "auth_unauthorized",
      reason,
      at: nowIso(),
      streak: this.ctx.auth.unauthorizedStreak,
      invalidateToken,
      ...(errorMessage ? { error: errorMessage } : {}),
    });

    this.ctx.debugSnapshot.lastUnauthorized = {
      at: nowIso(),
      reason,
      streak: this.ctx.auth.unauthorizedStreak,
      invalidateToken,
      ...(errorMessage ? { error: errorMessage } : {}),
    };
    await this.ctx.writeDebugSnapshot();

    await this.refreshAndReconnect(reason, { invalidateToken });

    if (invalidateToken) {
      this.ctx.auth.unauthorizedStreak = 0;
    }
  }

  /**
   * Proactively refresh auth if conditions warrant it (e.g. after a
   * subscription unauthorized error). Debounced to avoid hammering.
   */
  async refreshIfNeeded(): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - this.ctx.misc.lastSubscriptionRefreshAtMs < 20_000) return;
    this.ctx.misc.lastSubscriptionRefreshAtMs = nowMs;
    await this.refreshAndReconnect("subscription_unauthorized_refresh", {
      invalidateToken: false,
    });
  }

  /**
   * Derives the current auth state from the debug snapshot.
   * Returns `"ok"`, `"pending"`, `"unauthorized"`, or `"unknown"`.
   */
  getAuthStateValue(): string {
    if (
      isRecord(this.ctx.debugSnapshot.auth) &&
      typeof this.ctx.debugSnapshot.auth.state === "string"
    ) {
      return this.ctx.debugSnapshot.auth.state;
    }
    return "unknown";
  }

  /** No-op cleanup; AuthManager holds no timers or external handles. */
  dispose(): void {
    // intentionally empty
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Core auth refresh: optionally invalidate the cached bot token, request
   * a subscription resync, and close the active WS connection so the
   * client reconnects with fresh auth params.
   */
  private async refreshAndReconnect(
    reason: string,
    options: { invalidateToken: boolean },
  ): Promise<void> {
    const nowMs = Date.now();
    if (this.ctx.auth.authRefreshInFlight) return;
    if (nowMs - this.ctx.auth.lastAuthRefreshAtMs < AUTH_REFRESH_MIN_GAP_MS) return;

    this.ctx.auth.authRefreshInFlight = true;
    this.ctx.auth.lastAuthRefreshAtMs = nowMs;

    if (options.invalidateToken) {
      clearBotTokenState("auth_refresh_invalidate");
    }

    await this.ctx.memory.recordWrite({
      type: "auth_refresh",
      reason,
      at: nowIso(),
      invalidateToken: options.invalidateToken,
    });

    this.ctx.misc.subscriptionResyncRequested = true;
    this.ctx.misc.subscriptionResyncReason = `auth_refresh:${reason}`;

    if (this.ctx.wsClient) {
      await this.ctx.wsClient.activeConnection.close().catch(() => {});
    }

    this.ctx.auth.authRefreshInFlight = false;
  }
}
