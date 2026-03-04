/** Grant lifecycle, permissions, cooldown, and action idempotency helpers. */

import crypto from "node:crypto";

import type {
  Command,
  CommandLifecycleState,
  OwnerCapabilityCooldown,
  RecentCommentTargetUsage,
  CommentTargetReuseDecision,
  AgentRouterLike,
  StateSqliteStore,
  CommandExecutorContext,
} from "../types.js";

import {
  asNonEmptyString,
  asPositiveInt,
  normalizeCommentText,
  buildExecutionDigest,
} from "../helpers.js";

import {
  ACTION_IDEMPOTENCY_IN_FLIGHT_WINDOW_MS,
  ACTION_REQUEUE_BACKOFF_MS,
  OWNER_CAPABILITY_COOLDOWN_MS,
  COMMENT_TARGET_REUSE_WINDOW_MS,
  COMMENT_TARGET_HISTORY_LIMIT,
  COMMENT_RECENCY_TRACKED_STATES,
} from "../constants.js";

import { parseGrantCandidatesFromPermissionState } from "../../grants/grant-state.js";
import { buildTargetHash } from "../../lib/command-target.js";
import { isRecord } from "../../lib/guards.js";

import {
  resolveCommandSourceDirectiveId,
} from "../directives/resolution.js";

import { RequeueCommandError } from "../types.js";

// ---------------------------------------------------------------------------
// grantActionKeysFor
// ---------------------------------------------------------------------------

export function grantActionKeysFor(
  action: "comment" | "like" | "repost",
): string[] {
  if (action === "comment") return ["comment", "write.commentPost"];
  if (action === "like") return ["like", "write.votePost"];
  return ["repost", "write.repostPost"];
}

// ---------------------------------------------------------------------------
// resolvePermissionWindowGrantIdForAction
// ---------------------------------------------------------------------------

export function resolvePermissionWindowGrantIdForAction(
  permissionState: unknown,
  action: "comment" | "like" | "repost",
): string | null {
  const candidates = parseGrantCandidatesFromPermissionState(permissionState);
  if (!candidates.length) return null;
  const nowMs = Date.now();
  const actionKeys = grantActionKeysFor(action);
  for (const candidate of candidates) {
    if (candidate.expiresAtMs <= nowMs) continue;
    for (const key of actionKeys) {
      const actionState = candidate.actions.get(key);
      if (!actionState || actionState.remainingCount <= 0) continue;
      const notBeforeAtMs =
        typeof actionState.notBeforeAtMs === "number" &&
        Number.isFinite(actionState.notBeforeAtMs)
          ? actionState.notBeforeAtMs
          : candidate.issuedAtMs + actionState.notBeforeSeconds * 1000;
      if (notBeforeAtMs > nowMs) continue;
      const grantId = candidate.id.trim();
      if (grantId.length > 0) return grantId;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// hasUsablePermissionWindowForAction
// ---------------------------------------------------------------------------

export function hasUsablePermissionWindowForAction(
  permissionState: unknown,
  action: "comment" | "like" | "repost",
): boolean {
  return (
    resolvePermissionWindowGrantIdForAction(permissionState, action) !== null
  );
}

// ---------------------------------------------------------------------------
// buildActionIdempotencyKey
// ---------------------------------------------------------------------------

export function buildActionIdempotencyKey(input: {
  command: Command;
  action: "comment" | "like" | "repost";
  postId: number;
  commentId: number | null;
  commentBody?: string | null;
}): string {
  const directiveId =
    resolveCommandSourceDirectiveId({
      command: input.command,
      payload: isRecord(input.command.payload) ? input.command.payload : null,
    }) ?? input.command.id;
  const targetHash = buildTargetHash({
    postId: input.postId,
    commentId: input.commentId,
  });
  const normalizedCommentBody =
    input.action === "comment" && typeof input.commentBody === "string"
      ? normalizeCommentText(input.commentBody)
      : "";
  const commentBodyHash =
    normalizedCommentBody.length > 0
      ? crypto
          .createHash("sha256")
          .update(normalizedCommentBody)
          .digest("hex")
      : null;
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        directiveId,
        actionNonce: input.command.actionNonce ?? "",
        action: input.action,
        targetHash,
        ...(input.action === "comment"
          ? {
              commentBodyHash,
            }
          : {}),
      }),
    )
    .digest("hex");
}

// ---------------------------------------------------------------------------
// buildPostActionIdempotencyKey
// ---------------------------------------------------------------------------

export function buildPostActionIdempotencyKey(input: {
  command: Command;
  postType: "text" | "media";
  postKind: "post" | "thread";
}): string {
  const payload = isRecord(input.command.payload)
    ? input.command.payload
    : null;
  const directiveId =
    resolveCommandSourceDirectiveId({
      command: input.command,
      payload,
    }) ?? input.command.id;
  const actionNonce =
    asNonEmptyString(payload?.sourceDirectiveActionNonce) ??
    input.command.actionNonce ??
    "";
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        directiveId,
        actionNonce,
        action: "post",
        postType: input.postType,
        postKind: input.postKind,
      }),
    )
    .digest("hex");
}

// ---------------------------------------------------------------------------
// beginActionLifecycle
// ---------------------------------------------------------------------------

export function beginActionLifecycle(
  stateDb: StateSqliteStore | null | undefined,
  input: {
    command: Command;
    action: "comment" | "like" | "repost" | "post";
    idempotencyKey: string;
    target: {
      postId: number | null;
      commentId: number | null;
      targetHash: string;
    };
    state: CommandLifecycleState;
  },
): { allowed: boolean; reason: string; requeue: boolean } {
  if (!stateDb?.enabled) {
    return { allowed: true, reason: "state_db_disabled", requeue: false };
  }
  const existing = stateDb.getCommandLifecycleByIdempotencyKey(
    input.idempotencyKey,
  );
  if (existing) {
    if (existing.state === "acked") {
      return { allowed: false, reason: "already_acked", requeue: false };
    }
    const updatedAtMs = Date.parse(existing.updatedAt);
    if (
      existing.state === "requeue" &&
      Number.isFinite(updatedAtMs) &&
      Date.now() - updatedAtMs < ACTION_REQUEUE_BACKOFF_MS
    ) {
      return { allowed: false, reason: "requeue_backoff", requeue: true };
    }
    if (
      existing.state === "queued" ||
      existing.state === "context_ready" ||
      existing.state === "llm_running" ||
      existing.state === "action_running"
    ) {
      if (
        Number.isFinite(updatedAtMs) &&
        Date.now() - updatedAtMs < ACTION_IDEMPOTENCY_IN_FLIGHT_WINDOW_MS
      ) {
        return {
          allowed: false,
          reason: "already_in_flight",
          requeue: false,
        };
      }
    }
  }
  stateDb.upsertCommandLifecycle({
    commandId: input.command.id,
    directiveId:
      resolveCommandSourceDirectiveId({
        command: input.command,
        payload: isRecord(input.command.payload)
          ? input.command.payload
          : null,
      }) ?? input.command.id,
    action: input.action,
    targetPostId: input.target.postId,
    targetCommentId: input.target.commentId,
    targetHash: input.target.targetHash,
    idempotencyKey: input.idempotencyKey,
    state: input.state,
    attemptDelta: 1,
    sourceKind: input.command.kind,
    grantId: input.command.grantId,
    payload: input.command.payload,
  });
  return {
    allowed: true,
    reason: existing ? "retry" : "new",
    requeue: false,
  };
}

// ---------------------------------------------------------------------------
// updateActionLifecycle
// ---------------------------------------------------------------------------

export function updateActionLifecycle(
  stateDb: StateSqliteStore | null | undefined,
  input: {
    command: Command;
    action: "comment" | "like" | "repost" | "post";
    idempotencyKey: string;
    target: {
      postId: number | null;
      commentId: number | null;
      targetHash: string;
    };
    state: CommandLifecycleState;
    lastError?: string | null;
  },
): void {
  if (!stateDb?.enabled) return;
  stateDb.upsertCommandLifecycle({
    commandId: input.command.id,
    directiveId:
      resolveCommandSourceDirectiveId({
        command: input.command,
        payload: isRecord(input.command.payload)
          ? input.command.payload
          : null,
      }) ?? input.command.id,
    action: input.action,
    targetPostId: input.target.postId,
    targetCommentId: input.target.commentId,
    targetHash: input.target.targetHash,
    idempotencyKey: input.idempotencyKey,
    state: input.state,
    lastError: input.lastError ?? null,
    sourceKind: input.command.kind,
    grantId: input.command.grantId,
    payload: input.command.payload,
  });
}

// ---------------------------------------------------------------------------
// executeCreatePostMutationWithIdempotency
// ---------------------------------------------------------------------------

export async function executeCreatePostMutationWithIdempotency(
  stateDb: StateSqliteStore | null | undefined,
  agent: AgentRouterLike,
  input: {
    command: Command;
    postType: "text" | "media";
    postKind: "post" | "thread";
    mutationInput: Record<string, unknown>;
  },
): Promise<
  | {
      skipped: false;
      result: unknown;
    }
  | {
      skipped: true;
      reason: string;
    }
> {
  const idempotencyKey = buildPostActionIdempotencyKey({
    command: input.command,
    postType: input.postType,
    postKind: input.postKind,
  });
  const target = {
    postId: null,
    commentId: null,
    targetHash: crypto
      .createHash("sha256")
      .update(idempotencyKey)
      .digest("hex"),
  };
  const dedupe = beginActionLifecycle(stateDb, {
    command: input.command,
    action: "post",
    idempotencyKey,
    target,
    state: "action_running",
  });
  if (!dedupe.allowed) {
    if (dedupe.requeue) {
      throw new RequeueCommandError(
        `post_waiting_for_backoff:${dedupe.reason}`,
      );
    }
    return {
      skipped: true,
      reason: dedupe.reason,
    };
  }

  try {
    const result = await agent.createPost.mutate(input.mutationInput);
    updateActionLifecycle(stateDb, {
      command: input.command,
      action: "post",
      idempotencyKey,
      target,
      state: "acked",
      lastError: null,
    });
    return {
      skipped: false,
      result,
    };
  } catch (error: unknown) {
    if (error instanceof RequeueCommandError) {
      updateActionLifecycle(stateDb, {
        command: input.command,
        action: "post",
        idempotencyKey,
        target,
        state: "requeue",
        lastError: error.message,
      });
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    updateActionLifecycle(stateDb, {
      command: input.command,
      action: "post",
      idempotencyKey,
      target,
      state: "failed",
      lastError: message,
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// ownerCapabilityCooldownKey
// ---------------------------------------------------------------------------

export function ownerCapabilityCooldownKey(input: {
  action: "comment" | "like" | "repost";
  targetHash: string;
}): string {
  return `${input.action}:${input.targetHash}`;
}

// ---------------------------------------------------------------------------
// registerOwnerCapabilityCooldown
// ---------------------------------------------------------------------------

export function registerOwnerCapabilityCooldown(
  ownerCapabilityDeniedByTarget: Map<string, OwnerCapabilityCooldown>,
  input: {
    action: "comment" | "like" | "repost";
    targetHash: string;
    reason: string;
  },
): void {
  const key = ownerCapabilityCooldownKey(input);
  ownerCapabilityDeniedByTarget.set(key, {
    untilMs: Date.now() + OWNER_CAPABILITY_COOLDOWN_MS,
    reason: input.reason,
  });
}

// ---------------------------------------------------------------------------
// resolveOwnerCapabilityCooldown
// ---------------------------------------------------------------------------

export function resolveOwnerCapabilityCooldown(
  ownerCapabilityDeniedByTarget: Map<string, OwnerCapabilityCooldown>,
  input: {
    action: "comment" | "like" | "repost";
    targetHash: string;
  },
): OwnerCapabilityCooldown | null {
  const key = ownerCapabilityCooldownKey(input);
  const entry = ownerCapabilityDeniedByTarget.get(key);
  if (!entry) return null;
  if (!Number.isFinite(entry.untilMs) || entry.untilMs <= Date.now()) {
    ownerCapabilityDeniedByTarget.delete(key);
    return null;
  }
  return entry;
}

// ---------------------------------------------------------------------------
// isOwnerCapabilityDeniedError
// ---------------------------------------------------------------------------

export function isOwnerCapabilityDeniedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /owner capability denied/iu.test(error.message);
}

// ---------------------------------------------------------------------------
// isNoTargetDiscoveryFailure
// ---------------------------------------------------------------------------

export function isNoTargetDiscoveryFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /engagement_target_unavailable:no_targets_discovered/iu.test(
    error.message,
  );
}

// ---------------------------------------------------------------------------
// listRecentCommentTargetUsage
// ---------------------------------------------------------------------------

export function listRecentCommentTargetUsage(
  stateDb: StateSqliteStore | null | undefined,
): RecentCommentTargetUsage[] {
  if (!stateDb?.enabled) return [];
  const rows = stateDb.getRecentCommandLifecycle(COMMENT_TARGET_HISTORY_LIMIT);
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const nowMs = Date.now();
  const cutoffMs = nowMs - COMMENT_TARGET_REUSE_WINDOW_MS;
  const recent: RecentCommentTargetUsage[] = [];
  for (const row of rows) {
    const action = asNonEmptyString(row.action)?.toLowerCase() ?? "";
    if (action !== "comment") continue;
    const state = row.state;
    if (!COMMENT_RECENCY_TRACKED_STATES.has(state)) continue;
    const postId =
      typeof row.targetPostId === "number" && Number.isFinite(row.targetPostId)
        ? Math.floor(row.targetPostId)
        : null;
    if (!postId || postId <= 0) continue;
    const updatedAtMs = Date.parse(row.updatedAt);
    if (!Number.isFinite(updatedAtMs) || updatedAtMs < cutoffMs) continue;
    const commentId =
      typeof row.targetCommentId === "number" &&
      Number.isFinite(row.targetCommentId)
        ? Math.floor(row.targetCommentId)
        : null;
    let postSnapshotHash: string | null = null;
    if (
      typeof row.payloadJson === "string" &&
      row.payloadJson.trim().length > 0
    ) {
      try {
        const parsed = JSON.parse(row.payloadJson) as unknown;
        if (isRecord(parsed)) {
          postSnapshotHash =
            asNonEmptyString(parsed.targetPostSnapshotHash) ??
            asNonEmptyString(parsed.postSnapshotHash) ??
            null;
        }
      } catch {
        // best effort parse only
      }
    }
    recent.push({
      commandId: row.commandId,
      postId,
      commentId,
      state,
      updatedAtMs,
      postSnapshotHash,
    });
  }
  return recent;
}

// ---------------------------------------------------------------------------
// isReplySignalCommentSource
// ---------------------------------------------------------------------------

export function isReplySignalCommentSource(source: string): boolean {
  const normalized = source.trim().toLowerCase();
  if (!normalized.length) return false;
  return (
    normalized.includes("comment_thread") ||
    normalized.includes("unanswered_mention") ||
    normalized.includes("notifications_unread")
  );
}

// ---------------------------------------------------------------------------
// decideCommentTargetReuse
// ---------------------------------------------------------------------------

export function decideCommentTargetReuse(
  stateDb: StateSqliteStore | null | undefined,
  input: {
    commandId: string;
    postId: number;
    commentId: number | null;
    postSnapshotHash: string | null;
    source: string;
    recentUsage?: RecentCommentTargetUsage[];
  },
): CommentTargetReuseDecision {
  const recentUsage =
    input.recentUsage ?? listRecentCommentTargetUsage(stateDb);
  if (recentUsage.length === 0) {
    return {
      allow: true,
      reason: "no_recent_comment_targets",
      recentMatch: null,
    };
  }
  const samePostRows = recentUsage.filter(
    (entry) =>
      entry.postId === input.postId && entry.commandId !== input.commandId,
  );
  if (samePostRows.length === 0) {
    return {
      allow: true,
      reason: "post_not_recently_commented",
      recentMatch: null,
    };
  }
  const latestSamePost = samePostRows[0] ?? null;
  const snapshotChanged =
    Boolean(input.postSnapshotHash) &&
    Boolean(latestSamePost) &&
    Boolean(latestSamePost?.postSnapshotHash) &&
    latestSamePost?.postSnapshotHash !== input.postSnapshotHash;
  if (typeof input.commentId === "number" && input.commentId > 0) {
    const sameParent = samePostRows.find(
      (entry) => entry.commentId === input.commentId,
    );
    if (sameParent) {
      return {
        allow: false,
        reason: "comment_parent_already_replied_recently",
        recentMatch: sameParent,
      };
    }
    if (snapshotChanged) {
      return {
        allow: true,
        reason: "post_snapshot_changed",
        recentMatch: latestSamePost,
      };
    }
    if (!isReplySignalCommentSource(input.source)) {
      return {
        allow: false,
        reason: "post_recently_commented_without_reply_signal",
        recentMatch: samePostRows[0] ?? null,
      };
    }
    return {
      allow: true,
      reason: "new_parent_comment_target_from_reply_signal",
      recentMatch: null,
    };
  }
  if (snapshotChanged) {
    return {
      allow: true,
      reason: "post_snapshot_changed",
      recentMatch: latestSamePost,
    };
  }
  if (input.source.startsWith("own_latest")) {
    return {
      allow: true,
      reason: "own_latest_needs_thread_hydration",
      recentMatch: null,
    };
  }
  return {
    allow: false,
    reason: "post_recently_commented",
    recentMatch: samePostRows[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// isRecoverableDraftGrantErrorMessage
// ---------------------------------------------------------------------------

export function isRecoverableDraftGrantErrorMessage(
  message: string,
): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized.length) return false;
  return (
    normalized.includes("owner capability denied: no_grant") ||
    normalized.includes(
      "owner capability denied: missing_grant_id_with_active_window",
    ) ||
    normalized.includes("permission denied for requested write") ||
    normalized.includes("forbidden:no_grant") ||
    normalized.includes("forbidden:exhausted") ||
    normalized.includes("forbidden:not_ready")
  );
}

// ---------------------------------------------------------------------------
// isRecoverableDraftExecutionError
// ---------------------------------------------------------------------------

export function isRecoverableDraftExecutionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof RequeueCommandError) return false;
  return isRecoverableDraftGrantErrorMessage(error.message);
}

// ---------------------------------------------------------------------------
// isRecoverableDraftSkipDecision
// ---------------------------------------------------------------------------

export function isRecoverableDraftSkipDecision(
  decision: string | null,
): boolean {
  if (!decision) return false;
  return isRecoverableDraftGrantErrorMessage(decision);
}

export { preflightGrantForAction } from "./grants-preflight.js";
