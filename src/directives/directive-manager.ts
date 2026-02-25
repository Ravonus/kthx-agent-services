/**
 * DirectiveManager: lifecycle management for incoming director directives,
 * including deduplication, ACK tracking, staging to inbox, and queue
 * integration.
 *
 * Ported from agent-runtime.mjs lines 4037-4134 (dedup/ack helpers) and
 * lines 17574-17743 (handleDirectorDirective + promotePendingPlansToQueue).
 */

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";

import { isRecord } from "../lib/guards.js";
import { nowIso } from "../lib/text.js";
import { writeJsonFile, readJsonFile, readJsonMaybeIncomplete } from "../lib/fs.js";
import { computeCommandSignature } from "../lib/crypto.js";
import { applyTargetLock } from "../lib/command-target.js";
import type { Command } from "../types/ipc.js";
import type {
  DirectiveManagerLike,
  PendingDirectivePromotionInput,
  PendingDirectivePromotionResult,
} from "../runtime-context.js";
import {
  resolveForceNowFromPayload,
  resolveQueueClass,
} from "../queue/queue-state.js";
import {
  sealRuntimeStagedCommand,
  type CommandSealState,
} from "./command-seal.js";

export interface DirectiveManagerContext {
  config: {
    terminalTriggerOnly: boolean;
  };
  ipcPaths: {
    inboxDir: string;
    wakePath: string;
    pendingDir: string;
    currentDirectivePath: string;
    resultsPath: string;
  };
  memory: {
    recordWrite(payload: unknown): Promise<void>;
  };
  trpc: {
    agent?: {
      ackDirective?: {
        mutate(input: unknown): Promise<unknown>;
      };
    };
  } | null;
  commandSeal: CommandSealState;
  directive: DirectiveTrackingState;
  misc: {
    controlKey: string | null;
  };
  /** External hooks wired after construction. */
  ensureDirectiveInQueue: (opts: {
    directiveId: string;
    inboxFile: string;
    source: string;
    queueClass: string;
    forceNow: boolean;
    commandFingerprint?: string | undefined;
  }) => Promise<void>;
  planQueueWithOpenClaw: (opts: { source: string }) => Promise<unknown>;
  touchWake: (path: string) => Promise<void>;
}

export interface DirectiveTrackingState {
  pendingDirectives: unknown[];
  pendingPromotionPromise: Promise<PendingDirectivePromotionResult> | null;
  lastPendingPromotionAtMs: number;
  autoEnqueueMutation: Promise<void>;
  seenDirectiveNoncesById: Map<string, Set<string>>;
  completedDirectiveAcksById: Map<string, Map<string, unknown>>;
  directiveNonceById: Map<string, string>;
  directiveQueue: Promise<void>;
}

export interface DirectiveAckEntry {
  directiveId: string;
  status: string;
  kind: string | null;
  error: string | null;
  actionNonce: string | null;
  executionDigest: string | null;
  archivedAt: string | null;
}

const normalizeActionNonce = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const nonceToken = (value: unknown): string =>
  normalizeActionNonce(value) ?? "";

const FORCE_FLAG_RE = /(^|\s)(--force|-f)(?=\s|$)/iu;
const hasForceFlagToken = (value: unknown): boolean =>
  typeof value === "string" && FORCE_FLAG_RE.test(value.trim());

const isMentionDirectivePayload = (payload: unknown): boolean =>
  isRecord(payload) &&
  (typeof payload.mentionIntent === "string" ||
    isRecord(payload.mentionSource) ||
    isRecord(payload.mentionTarget) ||
    isRecord(payload.mentionCommand));

/** Directive-level forceNow detection (wraps payload-level from queue-state). */
const resolveForceNowFromDirective = (directive: unknown): boolean => {
  if (!isRecord(directive)) return false;
  if (directive.forceNow === true || directive.force === true) return true;
  if (hasForceFlagToken(directive.note) || hasForceFlagToken(directive.instruction)) return true;
  if (isMentionDirectivePayload(directive.payload)) return true;
  return resolveForceNowFromPayload(directive.payload);
};

const asPositiveInt = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
};

const QUEUED_PENDING_STATUSES = new Set([
  "queued_for_execution",
  "draft_waiting_execution",
]);

const TERMINAL_PENDING_STATUSES = new Set([
  "completed",
  "permission_denied",
  "no_executable_draft",
  "max_retry_exceeded",
]);

const normalizePendingPromotionLimit = (value: unknown): number => {
  const parsed = asPositiveInt(value);
  if (!parsed) return 25;
  return Math.max(1, Math.min(100, parsed));
};

const resolveDirectiveTarget = (input: {
  kind: string;
  payload: Record<string, unknown> | null;
}): { postId: number; commentId: number | null } | null => {
  const payload = input.payload;
  if (!payload) return null;
  const normalizedKind = input.kind.trim().toLowerCase();
  const postId = asPositiveInt(payload.postId);
  const commentId =
    asPositiveInt(payload.commentId) ?? asPositiveInt(payload.parentId);
  if (
    normalizedKind === "write.commentpost" ||
    normalizedKind === "write.comment" ||
    normalizedKind === "write.like" ||
    normalizedKind === "write.votepost" ||
    normalizedKind === "write.repost" ||
    normalizedKind === "write.repostpost"
  ) {
    if (!postId) return null;
    return {
      postId,
      commentId:
        normalizedKind === "write.commentpost" || normalizedKind === "write.comment"
          ? commentId
          : null,
    };
  }
  if (normalizedKind === "brain.generateandqueue") {
    const goal =
      typeof payload.goal === "string" ? payload.goal.trim().toLowerCase() : "";
    if (!["comment", "like", "repost"].includes(goal)) return null;
    if (!postId) return null;
    return {
      postId,
      commentId: goal === "comment" ? commentId : null,
    };
  }
  return null;
};

export class DirectiveManager implements DirectiveManagerLike {
  private readonly ctx: DirectiveManagerContext;

  /** Set once the runtime wires the full handler (after bootstrap). */
  handleDirective: ((payload: unknown) => Promise<void>) | null = null;

  constructor(ctx: DirectiveManagerContext) {
    this.ctx = ctx;
  }

  markDirectiveSeen(directiveId: string, actionNonce?: unknown): void {
    if (typeof directiveId !== "string" || directiveId.trim().length === 0) return;
    const id = directiveId.trim();
    const token = nonceToken(actionNonce);
    let nonceSet = this.ctx.directive.seenDirectiveNoncesById.get(id);
    if (!(nonceSet instanceof Set)) {
      nonceSet = new Set();
      this.ctx.directive.seenDirectiveNoncesById.set(id, nonceSet);
    }
    nonceSet.add(token);
  }

  hasSeenDirective(directiveId: string, actionNonce?: unknown): boolean {
    if (typeof directiveId !== "string" || directiveId.trim().length === 0) return false;
    const id = directiveId.trim();
    const token = nonceToken(actionNonce);
    const nonceSet = this.ctx.directive.seenDirectiveNoncesById.get(id);
    if (!(nonceSet instanceof Set) || nonceSet.size === 0) return false;
    if (nonceSet.has(token)) return true;
    return token.length === 0 || nonceSet.has("");
  }

  rememberCompletedDirectiveAck(ackEntry: unknown): void {
    if (!isRecord(ackEntry)) return;
    const directiveId = typeof ackEntry.directiveId === "string" && ackEntry.directiveId.trim().length > 0
      ? ackEntry.directiveId.trim() : "";
    if (!directiveId.length) return;
    const strOr = (v: unknown, fallback: string | null): string | null =>
      typeof v === "string" && v.trim().length > 0 ? v.trim() : fallback;
    const normalizedEntry: DirectiveAckEntry = {
      directiveId,
      status: strOr(ackEntry.status, null) ?? "executed",
      kind: strOr(ackEntry.kind, null),
      error: strOr(ackEntry.error, null),
      actionNonce: normalizeActionNonce(ackEntry.actionNonce),
      executionDigest: strOr(ackEntry.executionDigest, null),
      archivedAt: strOr(ackEntry.archivedAt, null),
    };
    const token = nonceToken(normalizedEntry.actionNonce);
    let byNonce = this.ctx.directive.completedDirectiveAcksById.get(directiveId);
    if (!(byNonce instanceof Map)) {
      byNonce = new Map();
      this.ctx.directive.completedDirectiveAcksById.set(directiveId, byNonce);
    }
    const existing = byNonce.get(token) as DirectiveAckEntry | undefined;
    const existingAtMs = typeof existing?.archivedAt === "string" && existing.archivedAt.trim().length > 0
      ? Date.parse(existing.archivedAt) : Number.NaN;
    const nextAtMs = typeof normalizedEntry.archivedAt === "string" && normalizedEntry.archivedAt.trim().length > 0
      ? Date.parse(normalizedEntry.archivedAt) : Number.NaN;
    const shouldReplace = !existing ||
      (Number.isFinite(nextAtMs) && Number.isFinite(existingAtMs) ? nextAtMs >= existingAtMs : true);
    if (shouldReplace) byNonce.set(token, normalizedEntry);
    this.markDirectiveSeen(directiveId, normalizedEntry.actionNonce);
  }

  getCompletedDirectiveAck(directiveId: string, actionNonce?: unknown): DirectiveAckEntry | null {
    if (typeof directiveId !== "string" || !directiveId.trim().length) return null;
    const byNonce = this.ctx.directive.completedDirectiveAcksById.get(directiveId.trim());
    if (!(byNonce instanceof Map) || byNonce.size === 0) return null;
    const token = nonceToken(actionNonce);
    if (byNonce.has(token)) return (byNonce.get(token) as DirectiveAckEntry) ?? null;
    if (token.length > 0 && byNonce.has("")) return (byNonce.get("") as DirectiveAckEntry) ?? null;
    if (token.length === 0 && byNonce.size === 1) {
      const onlyValue = byNonce.values().next();
      return onlyValue.done ? null : (onlyValue.value as DirectiveAckEntry);
    }
    return null;
  }

  async intake(payload: unknown): Promise<void> {
    if (!isRecord(payload)) return;
    const directive = payload;
    const id = typeof directive.id === "string" ? directive.id.trim() : "";
    if (!id) return;

    const kind =
      typeof directive.kind === "string" ? directive.kind.trim() : "";
    const forceNow = resolveForceNowFromDirective(directive);
    const queueClass = resolveQueueClass({
      kind,
      payload: directive.payload ?? null,
    });
    const actionNonce =
      typeof directive.actionNonce === "string" &&
      directive.actionNonce.trim().length
        ? directive.actionNonce.trim()
        : null;

    if (actionNonce) {
      this.ctx.directive.directiveNonceById.set(id, actionNonce);
    }

    // Completed ACK dedup
    const completedAck = this.getCompletedDirectiveAck(id, actionNonce);
    if (completedAck) {
      this.markDirectiveSeen(id, actionNonce);
      await this.ackDirective({ directiveId: id, status: completedAck.status, kind: completedAck.kind, error: completedAck.error, actionNonce: completedAck.actionNonce ?? actionNonce, executionDigest: completedAck.executionDigest });
      await this.ctx.memory.recordWrite({ type: "directive_duplicate_suppressed", at: nowIso(), directiveId: id, kind, actionNonce: actionNonce ?? null, reason: "already_completed", completedStatus: completedAck.status });
      return;
    }
    // Session dedup
    if (this.hasSeenDirective(id, actionNonce)) {
      await this.ackDirective({ directiveId: id, status: "received", kind: kind || null, error: null, actionNonce });
      await this.ctx.memory.recordWrite({ type: "directive_duplicate_suppressed", at: nowIso(), directiveId: id, kind, actionNonce: actionNonce ?? null, reason: "already_seen_session" });
      return;
    }

    this.markDirectiveSeen(id, actionNonce);
    await this.ackDirective({
      directiveId: id,
      status: "received",
      kind: kind || null,
      error: null,
      actionNonce,
    });

    const createdAt = typeof directive.createdAt === "string" && directive.createdAt.trim().length
      ? (directive.createdAt as string).trim() : nowIso();
    const targetAgentId =
      typeof directive.agentId === "string" &&
      directive.agentId.trim().length > 0
        ? directive.agentId.trim()
        : null;
    const directiveGrantId = typeof directive.grantId === "string" && directive.grantId.trim().length
      ? (directive.grantId as string).trim() : null;
    const commandPayload = isRecord(directive.payload)
      ? ({ ...(directive.payload as Record<string, unknown>) } as Record<string, unknown>)
      : null;
    const target = resolveDirectiveTarget({ kind, payload: commandPayload });
    if (commandPayload && target) {
      applyTargetLock(commandPayload, target);
    }

    const baseCommand: Command = {
      id,
      createdAt,
      kind,
      grantId: directiveGrantId,
      payload: commandPayload,
      sig: null,
      targetAgentId,
      sourceDirectiveId: id,
      pendingDirectiveId: null,
      actionNonce,
      challenge: isRecord(directive.challenge)
        ? (directive.challenge as Record<string, unknown>)
        : null,
      forceNow,
      runtimeSessionId: null,
      runtimeOrigin: null,
      runtimeSig: null,
    };

    if (this.ctx.misc.controlKey) {
      baseCommand.sig = computeCommandSignature(
        this.ctx.misc.controlKey,
        baseCommand,
      );
    }

    const command = sealRuntimeStagedCommand(
      this.ctx.commandSeal,
      baseCommand,
      "director_directive",
    );

    const kindToken = kind.replace(/[^a-zA-Z0-9._-]/gu, "_");
    const fileName = `${new Date().toISOString().replaceAll(":", "-")}__${id}__${kindToken}.json`;
    const filePath = path.join(this.ctx.ipcPaths.inboxDir, fileName);
    await writeJsonFile(filePath, command);
    await this.ctx.touchWake(this.ctx.ipcPaths.wakePath);

    await this.ctx.memory.recordWrite({
      type: this.ctx.config.terminalTriggerOnly
        ? "directive_staged_waiting_terminal_run"
        : "directive_staged_for_queue_execution",
      at: nowIso(),
      directiveId: id,
      inboxPath: filePath,
      queueClass,
      forceNow,
    });

    const commandFingerprint = `${id}:${actionNonce ?? ""}:${kind}`;
    await this.ctx.ensureDirectiveInQueue({
      directiveId: id,
      inboxFile: path.basename(filePath),
      source: "director_directive",
      queueClass,
      forceNow,
      commandFingerprint,
    });
    await this.ctx.planQueueWithOpenClaw({ source: "directive_staged" }).catch(
      () => {},
    );
  }

  async promoteFromPending(
    input?: PendingDirectivePromotionInput,
  ): Promise<PendingDirectivePromotionResult> {
    if (this.ctx.directive.pendingPromotionPromise) {
      return this.ctx.directive.pendingPromotionPromise;
    }
    const limit = normalizePendingPromotionLimit(input?.limit);
    if (
      input?.bypassCooldown !== true &&
      Date.now() - this.ctx.directive.lastPendingPromotionAtMs < 3_000
    ) {
      return {
        scanned: 0,
        promoted: 0,
        skippedPermissionDenied: 0,
        skippedTerminal: 0,
        skippedAlreadySeen: 0,
        skippedQueued: 0,
        limit,
      };
    }
    this.ctx.directive.pendingPromotionPromise = this.doPromoteFromPending(input).finally(() => {
      this.ctx.directive.pendingPromotionPromise = null;
    });
    return this.ctx.directive.pendingPromotionPromise;
  }

  dispose(): void { /* No timers to clear. */ }

  private async ackDirective(opts: {
    directiveId: string; status: string; kind: string | null;
    error: string | null; actionNonce?: string | null; executionDigest?: string | null;
  }): Promise<void> {
    if (!this.ctx.trpc) return;
    try {
      const ackDirectiveMutator = this.ctx.trpc.agent?.ackDirective;
      if (!ackDirectiveMutator || typeof ackDirectiveMutator.mutate !== "function") {
        return;
      }
      await ackDirectiveMutator.mutate({
        directiveId: opts.directiveId, status: opts.status,
        kind: opts.kind ?? undefined, error: opts.error ?? undefined,
        actionNonce: opts.actionNonce ?? undefined, executionDigest: opts.executionDigest ?? undefined,
      });
    } catch { /* Non-fatal: best-effort ACK. */ }
  }

  private async doPromoteFromPending(
    input?: PendingDirectivePromotionInput,
  ): Promise<PendingDirectivePromotionResult> {
    const entries = await fs.readdir(this.ctx.ipcPaths.pendingDir).catch(() => []);
    const jsonEntries = entries.filter((e) => e.endsWith(".json")).sort();
    const limit = normalizePendingPromotionLimit(input?.limit);
    if (!jsonEntries.length) {
      return {
        scanned: 0,
        promoted: 0,
        skippedPermissionDenied: 0,
        skippedTerminal: 0,
        skippedAlreadySeen: 0,
        skippedQueued: 0,
        limit,
      };
    }
    const retryPermissionDenied = input?.retryPermissionDenied === true;
    let examined = 0;
    let promoted = 0;
    let skippedPermissionDenied = 0;
    let skippedTerminal = 0;
    let skippedAlreadySeen = 0;
    let skippedQueued = 0;
    for (const entry of jsonEntries) {
      if (examined >= limit) break;
      const pendingPath = path.join(this.ctx.ipcPaths.pendingDir, entry);
      const raw = await readJsonMaybeIncomplete(pendingPath);
      if (raw.status !== "ok" || !isRecord(raw.value)) continue;
      const pendingDoc = raw.value;
      const pendingId = typeof pendingDoc.id === "string" && pendingDoc.id.trim().length > 0
        ? pendingDoc.id.trim() : path.basename(entry, ".json");
      if (!pendingId.length) continue;
      examined += 1;
      const pendingStatus =
        typeof pendingDoc.status === "string"
          ? pendingDoc.status.trim().toLowerCase()
          : "";
      if (pendingStatus === "permission_denied" && !retryPermissionDenied) {
        skippedPermissionDenied += 1;
        continue;
      }
      if (pendingStatus.length > 0 && QUEUED_PENDING_STATUSES.has(pendingStatus)) {
        skippedQueued += 1;
        continue;
      }
      if (
        pendingStatus.length > 0 &&
        TERMINAL_PENDING_STATUSES.has(pendingStatus) &&
        !(pendingStatus === "permission_denied" && retryPermissionDenied)
      ) {
        skippedTerminal += 1;
        continue;
      }
      const sourceKind = typeof pendingDoc.sourceKind === "string" && pendingDoc.sourceKind.trim().length > 0
        ? pendingDoc.sourceKind.trim() : "brain.retryPending";
      const sourcePayload = isRecord(pendingDoc.intent) ? pendingDoc.intent : {};
      const queueClass = resolveQueueClass({ kind: sourceKind, payload: sourcePayload });
      const forceNow = resolveForceNowFromPayload(sourcePayload);
      const createdAt = typeof pendingDoc.createdAt === "string" && pendingDoc.createdAt.trim().length > 0
        ? pendingDoc.createdAt.trim() : nowIso();
      const pendingTargetAgentId =
        typeof pendingDoc.agentId === "string" && pendingDoc.agentId.trim().length > 0
          ? pendingDoc.agentId.trim()
          : null;
      const baseCommand: Command = {
        id: pendingId, createdAt, kind: sourceKind, grantId: null,
        payload: sourcePayload as Record<string, unknown>, sig: null,
        targetAgentId: pendingTargetAgentId,
        sourceDirectiveId: pendingId, pendingDirectiveId: pendingId,
        actionNonce: null, challenge: null, forceNow,
        runtimeSessionId: null, runtimeOrigin: null, runtimeSig: null,
      };
      if (this.ctx.misc.controlKey) {
        baseCommand.sig = computeCommandSignature(this.ctx.misc.controlKey, baseCommand);
      }
      const command = sealRuntimeStagedCommand(this.ctx.commandSeal, baseCommand, "pending_promotion");
      const kindToken = sourceKind.replace(/[^a-zA-Z0-9._-]/gu, "_");
      const fileName = `${new Date().toISOString().replaceAll(":", "-")}__${pendingId}__${kindToken}.json`;
      const filePath = path.join(this.ctx.ipcPaths.inboxDir, fileName);
      await writeJsonFile(filePath, command);
      await this.ctx.touchWake(this.ctx.ipcPaths.wakePath);
      await this.ctx.ensureDirectiveInQueue({
        directiveId: pendingId, inboxFile: path.basename(filePath),
        source: "pending_promotion", queueClass, forceNow,
      });
      const latestPending = await readJsonFile(pendingPath);
      if (isRecord(latestPending)) {
        const rec = latestPending as Record<string, unknown>;
        rec.status = "queued_for_execution";
        rec.updatedAt = nowIso();
        rec.lastAutoEnqueueReason = "pending_promoted_to_queue";
        if (retryPermissionDenied && "permissionDenied" in rec) {
          delete rec.permissionDenied;
        }
        await writeJsonFile(pendingPath, latestPending).catch(() => {});
      }
      promoted += 1;
    }
    this.ctx.directive.lastPendingPromotionAtMs = Date.now();
    await this.ctx.memory.recordWrite({
      type: "pending_promoted_to_queue",
      at: nowIso(),
      source: input?.source ?? "promote_from_pending",
      promoted,
      examined,
      limit,
      retryPermissionDenied,
      skippedPermissionDenied,
      skippedTerminal,
      skippedAlreadySeen,
      skippedQueued,
    });
    return {
      scanned: examined,
      promoted,
      skippedPermissionDenied,
      skippedTerminal,
      skippedAlreadySeen,
      skippedQueued,
      limit,
    };
  }
}
