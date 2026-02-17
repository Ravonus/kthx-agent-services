/**
 * GrantManager: active grant lifecycle management.
 *
 * Holds the current active grant in memory, handles grant expiry checks,
 * action consumption with notBefore enforcement, and persists grant
 * state to disk for external tooling visibility.
 *
 * Ported from agent-runtime.mjs lines 3962 (activeGrant variable),
 * 6506-6528 (canUsePostingGrantNow), and 8011-8056 (grant/credit
 * handling in handleEnvelope).
 */

import fs from "node:fs/promises";

import { nowIso } from "../lib/text.js";
import { isRecord } from "../lib/guards.js";
import { writeJsonFile } from "../lib/fs-helpers.js";
import type { GrantState, GrantAction } from "../types/grant.js";
import type { GrantManagerLike } from "../runtime-context.js";

// ---------------------------------------------------------------------------
// Narrow context interface
// ---------------------------------------------------------------------------

/**
 * Narrow context that GrantManager needs to operate.
 * Avoids importing RuntimeContext directly to prevent circular deps.
 */
export interface GrantManagerContext {
  ipcPaths: {
    latestDirectorGrantPath: string;
    wakePath: string;
  };
  memory: {
    recordWrite(payload: unknown): Promise<void>;
  };
}

// ---------------------------------------------------------------------------
// Touch wake helper
// ---------------------------------------------------------------------------

/**
 * Touch the wake sentinel file to signal external watchers that new work
 * may be available. Non-fatal on error.
 */
const touchWake = async (wakePath: string): Promise<void> => {
  const now = new Date();
  await fs.utimes(wakePath, now, now).catch(async () => {
    await fs.writeFile(wakePath, "", "utf8").catch(() => {});
  });
};

// ---------------------------------------------------------------------------
// GrantManager
// ---------------------------------------------------------------------------

/**
 * Well-known posting action keys. Used by `canUsePostingGrantNow` to
 * determine whether the current grant allows immediate posting.
 */
const POSTING_ACTION_KEYS: readonly string[] = [
  "write.createPost",
  "write.createStory",
  "write.commentPost",
  "post:post:text",
  "post:post:media",
  "post:thread:text",
  "post:thread:media",
  "schedule:create",
] as const;

export class GrantManager implements GrantManagerLike {
  private readonly ctx: GrantManagerContext;

  /** The currently active grant, or `null` when no grant is active. */
  private activeGrant: GrantState | null = null;

  constructor(ctx: GrantManagerContext) {
    this.ctx = ctx;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Replace the active grant. Persists the grant to disk and records a
   * memory write for auditability. Pass `null` to clear the active grant.
   */
  setActiveGrant(grant: GrantState | null): void {
    this.activeGrant = grant;
  }

  /** Return the currently active grant, or `null`. */
  getActiveGrant(): GrantState | null {
    return this.activeGrant;
  }

  /**
   * Try to consume one use of the given action key from the active grant.
   *
   * Returns `true` when the action was successfully consumed (the grant
   * is still valid, the action exists with remaining count, and the
   * notBefore window has passed).  Returns `false` otherwise.
   */
  consumeAction(actionKey: string): boolean {
    if (!this.activeGrant) return false;
    if (this.isGrantExpired()) return false;

    const action = this.activeGrant.actions.get(actionKey);
    if (!action || action.remainingCount <= 0) return false;

    if (!this.isActionReady(action)) return false;

    action.remainingCount -= 1;

    // Record the notBefore timestamp for the *next* use of this action.
    if (action.notBeforeSeconds > 0) {
      action.notBeforeAtMs = Date.now() + action.notBeforeSeconds * 1000;
    }

    return true;
  }

  /**
   * Returns `true` when the active grant has expired according to the
   * local clock.
   */
  isGrantExpired(): boolean {
    if (!this.activeGrant) return true;
    return Date.now() > this.activeGrant.expiresAtMs;
  }

  /**
   * Returns `true` when at least one posting action on the active grant
   * is immediately available (has remaining count and the notBefore
   * window has passed).
   */
  canUsePostingGrantNow(): boolean {
    if (!this.activeGrant) return false;
    if (this.isGrantExpired()) return false;

    return POSTING_ACTION_KEYS.some((actionKey) => {
      const action = this.activeGrant!.actions.get(actionKey);
      if (!action || action.remainingCount <= 0) return false;
      return this.isActionReady(action);
    });
  }

  /**
   * Persist the active grant (from a director_grant push) to disk and
   * record the event in memory.
   */
  async persistDirectorGrant(
    grantPayload: Record<string, unknown>,
    receivedAt: string,
  ): Promise<void> {
    await writeJsonFile(this.ctx.ipcPaths.latestDirectorGrantPath, {
      receivedAt,
      grant: grantPayload,
    });
    await touchWake(this.ctx.ipcPaths.wakePath);

    if (this.activeGrant) {
      await this.ctx.memory.recordWrite({
        type: "grant_window_opened",
        at: nowIso(),
        grantId: this.activeGrant.id,
      });
    }
  }

  /**
   * Persist a credits-based grant to disk and record the event in memory.
   */
  async persistCreditsGrant(
    creditPayload: Record<string, unknown>,
    receivedAt: string,
  ): Promise<void> {
    const creditId =
      isRecord(creditPayload) && typeof creditPayload.creditId === "string"
        ? creditPayload.creditId
        : null;
    const issuedAt =
      isRecord(creditPayload) && typeof creditPayload.issuedAt === "string"
        ? creditPayload.issuedAt
        : receivedAt;
    const expiresAt =
      isRecord(creditPayload) && typeof creditPayload.expiresAt === "string"
        ? creditPayload.expiresAt
        : this.activeGrant
          ? new Date(this.activeGrant.expiresAtMs).toISOString()
          : null;
    const credited =
      isRecord(creditPayload) && isRecord(creditPayload.credited)
        ? creditPayload.credited
        : null;

    await writeJsonFile(this.ctx.ipcPaths.latestDirectorGrantPath, {
      receivedAt,
      credit: {
        creditId,
        issuedAt,
        expiresAt,
        credited,
      },
    });
    await touchWake(this.ctx.ipcPaths.wakePath);

    if (this.activeGrant) {
      await this.ctx.memory.recordWrite({
        type: "credit_window_opened",
        at: nowIso(),
        grantId: this.activeGrant.id,
      });
    }
  }

  /** No-op cleanup; GrantManager holds no timers. */
  dispose(): void {
    this.activeGrant = null;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Returns `true` when the notBefore window for the given action has
   * passed (or was never set).
   */
  private isActionReady(action: GrantAction): boolean {
    const notBeforeMs =
      typeof action.notBeforeAtMs === "number" &&
      Number.isFinite(action.notBeforeAtMs)
        ? action.notBeforeAtMs
        : this.activeGrant
          ? this.activeGrant.issuedAtMs + action.notBeforeSeconds * 1000
          : 0;
    return Date.now() >= notBeforeMs;
  }
}
