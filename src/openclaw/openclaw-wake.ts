/**
 * OpenClaw wake classification, normalization, and delivery helpers.
 *
 * Extracted from openclaw-manager.ts to keep individual files under 500 lines.
 * Ported from agent-runtime.mjs lines 7409-7730 (wake classification and batching).
 *
 * Pure functions module -- no class needed.
 */

import crypto from "node:crypto";

import { isRecord } from "../lib/guards.js";
import { nowIso } from "../lib/text.js";
import { hmacSha256Hex } from "../lib/crypto.js";
import { appendJsonLine } from "../lib/fs.js";

// ---------------------------------------------------------------------------
// Wake input type
// ---------------------------------------------------------------------------

export interface WakeInput {
  reason: string;
  topic: string;
  receivedAt: string;
  eventId: string | null;
  source: string | null;
  hint: string | null;
  inboxFiles?: string[];
}

// ---------------------------------------------------------------------------
// Wake classification
// ---------------------------------------------------------------------------

export interface WakeClassification {
  reason: string;
  eventId: string | null;
  source?: string;
}

export const classifyOpenClawWake = (envelope: unknown): WakeClassification | null => {
  if (!isRecord(envelope)) return null;
  const payload = isRecord(envelope.payload) ? envelope.payload : null;
  const topic = typeof envelope.topic === "string" ? envelope.topic : "";
  const type = typeof payload?.type === "string" ? (payload.type as string) : "";

  if (type === "director_directive") {
    const directive = isRecord(payload?.directive) ? payload.directive : null;
    const eventId = directive && typeof directive.id === "string" ? (directive.id as string) : null;
    const dPayload = isRecord(directive?.payload) ? directive.payload : null;
    const mentionSource = isRecord(dPayload?.mentionSource) ? dPayload.mentionSource : null;
    const mentionIntent = typeof dPayload?.mentionIntent === "string" && (dPayload.mentionIntent as string).trim().length > 0
      ? (dPayload.mentionIntent as string).trim().toLowerCase() : null;
    const normalizedIntent = mentionIntent === "image" ? "image"
      : mentionIntent === "request" ? "request"
        : mentionIntent === "reply" || mentionIntent === "message" ? "reply" : null;
    if (mentionSource || normalizedIntent === "image" || normalizedIntent === "request" || normalizedIntent === "reply") {
      return { reason: "mention_directive", eventId, source: normalizedIntent || "reply" };
    }
    return { reason: "director_directive", eventId };
  }
  if (type === "director_grant") {
    const grant = isRecord(payload?.grant) ? payload.grant : null;
    const eventId = grant && typeof grant.id === "string" ? (grant.id as string) : null;
    return { reason: "director_grant", eventId };
  }
  if (type === "director_credits_added") {
    const eventId = typeof payload?.creditId === "string" && (payload.creditId as string).trim().length > 0
      ? (payload.creditId as string).trim() : null;
    return { reason: "director_grant", eventId };
  }
  if (type === "agent_task" || topic.startsWith("owner:")) {
    const task = isRecord(payload?.task) ? payload.task : null;
    const eventId = task && typeof task.id === "string" ? (task.id as string) : null;
    return { reason: "owner_task", eventId };
  }
  if (topic === "notifications" || topic.endsWith(":notifications")) {
    const eventId = typeof payload?.id === "string" && (payload.id as string).trim().length > 0
      ? (payload.id as string).trim() : null;
    return { reason: "notifications", eventId };
  }
  const genericEventId = typeof payload?.id === "string" && (payload.id as string).trim().length > 0
    ? (payload.id as string).trim() : null;
  return { reason: "socket_event", eventId: genericEventId, source: type || topic || "unknown" };
};

// ---------------------------------------------------------------------------
// Wake input normalization
// ---------------------------------------------------------------------------

export const normalizeWakeInput = (payload: unknown): WakeInput | null => {
  if (!isRecord(payload)) return null;
  const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  if (!reason.length) return null;
  return {
    reason,
    topic: typeof payload.topic === "string" ? payload.topic.trim() : "runtime:unknown",
    receivedAt: typeof payload.receivedAt === "string" && (payload.receivedAt as string).trim().length > 0
      ? (payload.receivedAt as string).trim() : nowIso(),
    eventId: typeof payload.eventId === "string" && (payload.eventId as string).trim().length > 0
      ? (payload.eventId as string).trim() : null,
    source: typeof payload.source === "string" && (payload.source as string).trim().length > 0
      ? (payload.source as string).trim() : null,
    hint: typeof payload.hint === "string" && (payload.hint as string).trim().length > 0
      ? (payload.hint as string).trim() : null,
    ...(Array.isArray(payload.inboxFiles) ? { inboxFiles: payload.inboxFiles as string[] } : {}),
  };
};

// ---------------------------------------------------------------------------
// Wake debounce key
// ---------------------------------------------------------------------------

const EVENT_SCOPED_REASONS = new Set([
  "director_directive", "mention_directive", "director_grant",
  "socket_challenge_required", "terminal_prompt_required", "media_request_prepared",
]);

export const getWakeDebounceKey = (payload: WakeInput): string => {
  if (EVENT_SCOPED_REASONS.has(payload.reason) && payload.eventId) {
    return `${payload.reason}:${payload.eventId}`;
  }
  if (payload.reason === "socket_subscription_error") {
    return `${payload.reason}:${payload.topic}:${payload.source ?? "unknown"}`;
  }
  if (payload.reason === "socket_state_change") {
    return `${payload.reason}:${payload.source ?? "unknown"}`;
  }
  return payload.reason;
};

// ---------------------------------------------------------------------------
// Wake body building
// ---------------------------------------------------------------------------

export const buildWakeBody = (payload: WakeInput, stateDir: string): Record<string, unknown> => ({
  type: "mg_wake",
  requestId: crypto.randomUUID(),
  reason: payload.reason,
  topic: payload.topic,
  receivedAt: payload.receivedAt,
  eventId: payload.eventId ?? null,
  stateDir,
  ...(typeof payload.hint === "string" && payload.hint.trim().length > 0 ? { hint: payload.hint.trim() } : {}),
  ...(Array.isArray(payload.inboxFiles) ? { inboxFiles: payload.inboxFiles } : {}),
  ...(typeof payload.source === "string" && payload.source.trim().length > 0 ? { source: payload.source.trim() } : {}),
});

export const buildBatchWakeBody = (
  selected: WakeInput[],
  stateDir: string,
  batchMs: number,
): Record<string, unknown> => {
  const reasons = Array.from(new Set(selected.map((item) => item.reason)));
  const lastItem = selected[selected.length - 1];
  return {
    type: "mg_wake",
    requestId: crypto.randomUUID(),
    reason: "actionable_batch",
    topic: "runtime:wake_batch",
    receivedAt: lastItem?.receivedAt ?? nowIso(),
    eventId: null,
    stateDir,
    reasons,
    events: selected.map((item) => ({
      reason: item.reason, topic: item.topic, receivedAt: item.receivedAt,
      eventId: item.eventId ?? null, source: item.source ?? null, hint: item.hint ?? null,
    })),
    hint: `${selected.length} actionable wakes batched over ${batchMs}ms`,
  };
};

// ---------------------------------------------------------------------------
// Actionable wake check
// ---------------------------------------------------------------------------

const REQUIRED_REASONS = new Set([
  "director_directive", "mention_directive", "director_grant",
  "socket_challenge_required", "terminal_prompt_required",
  "socket_subscription_error", "terminal_run_required", "directive_completed",
]);

export const isActionableWake = (
  payload: WakeInput,
  opts: {
    includeMediaPrepared: boolean;
    includeSocketStateChange: boolean;
    lastSocketWakeConnectivity: boolean | null;
  },
): { actionable: boolean; nextSocketConnectivity: boolean | null } => {
  let nextConnectivity = opts.lastSocketWakeConnectivity;
  if (payload.reason === "socket_event") return { actionable: false, nextSocketConnectivity: nextConnectivity };
  if (REQUIRED_REASONS.has(payload.reason)) return { actionable: true, nextSocketConnectivity: nextConnectivity };
  if (payload.reason === "media_request_prepared") {
    return { actionable: opts.includeMediaPrepared, nextSocketConnectivity: nextConnectivity };
  }
  if (payload.reason === "socket_state_change") {
    if (!opts.includeSocketStateChange) return { actionable: false, nextSocketConnectivity: nextConnectivity };
    const state = payload.source ?? "";
    const connected = state === "connected" || state === "open";
    if (opts.lastSocketWakeConnectivity === null) {
      nextConnectivity = connected;
      return { actionable: false, nextSocketConnectivity: nextConnectivity };
    }
    if (opts.lastSocketWakeConnectivity === connected) return { actionable: false, nextSocketConnectivity: nextConnectivity };
    nextConnectivity = connected;
    return { actionable: true, nextSocketConnectivity: nextConnectivity };
  }
  return { actionable: false, nextSocketConnectivity: nextConnectivity };
};

// ---------------------------------------------------------------------------
// Wake delivery
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export const deliverWakeBody = async (
  bodyPayload: unknown,
  opts: {
    hookRequestsPath: string;
    hookWakePath: string;
    wakeUrl: string | null;
    wakeKey: string | null;
    touchWake: (path: string) => Promise<void>;
  },
): Promise<void> => {
  await appendJsonLine(opts.hookRequestsPath, { at: nowIso(), wake: bodyPayload }).catch((error: unknown) => {
    console.warn("[agent-runtime] hook request append failed (non-fatal)", error instanceof Error ? error.message : error);
  });
  await opts.touchWake(opts.hookWakePath);
  if (!opts.wakeUrl) return;
  const rawBody = JSON.stringify(bodyPayload);
  const retryDelaysMs = [250, 1000, 5000];
  let lastError: unknown = null;
  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.wakeKey) {
      const ts = String(Date.now());
      headers["x-mg-wake-ts"] = ts;
      headers["x-mg-wake-sig"] = hmacSha256Hex(opts.wakeKey, `${ts}.${rawBody}`);
    }
    try {
      const response = await fetch(opts.wakeUrl, { method: "POST", headers, body: rawBody });
      if (response.ok) return;
      lastError = new Error(`wake receiver returned ${response.status}`);
    } catch (error: unknown) {
      lastError = error;
    }
    const delay = retryDelaysMs[attempt];
    if (attempt < retryDelaysMs.length - 1 && typeof delay === "number") await sleep(delay);
  }
  console.warn("[agent-runtime] OpenClaw wake POST failed (non-fatal)", lastError instanceof Error ? lastError.message : lastError);
};
