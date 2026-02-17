/**
 * Parsing utilities for JSON, commands, and director payloads.
 *
 * Ported from agent-runtime.mjs:
 *   - lines 460-558:   parseJsonFromMixedText, collectOpenClawEnvelopePayloadTexts,
 *                       unwrapOpenClawEnvelopePayload
 *   - lines 3054-3124: parseCommand, isDirectorGrantPayload,
 *                       isDirectorDirectivePayload, isDirectorCreditsPayload
 */

import crypto from "node:crypto";

import { isRecord } from "./guards.js";
import { nowIso } from "./text.js";
import type { Command } from "../types/ipc.js";
import type {
  DirectorGrantPayload,
  DirectorDirectivePayload,
  DirectorCreditsPayload,
} from "../types/grant.js";

// ---------------------------------------------------------------------------
// parseJsonFromMixedText
// ---------------------------------------------------------------------------

/**
 * Try to extract a JSON value from text that may contain markdown fences,
 * prose surrounding a JSON literal, or raw JSON.
 *
 * Returns `null` when no valid JSON can be found.
 */
export const parseJsonFromMixedText = (rawText: unknown): unknown => {
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (!text.length) return null;

  const tryParse = (candidate: unknown): unknown => {
    const trimmed = typeof candidate === "string" ? candidate.trim() : "";
    if (!trimmed.length) return null;
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  };

  // 1. Try direct parse
  const direct = tryParse(text);
  if (direct !== null) return direct;

  // 2. Try fenced code block (```json ... ``` or ``` ... ```)
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text);
  if (fenced && typeof fenced[1] === "string") {
    const parsed = tryParse(fenced[1]);
    if (parsed !== null) return parsed;
  }

  // 3. Try outermost array brackets
  const firstArrayStart = text.indexOf("[");
  const lastArrayEnd = text.lastIndexOf("]");
  if (firstArrayStart >= 0 && lastArrayEnd > firstArrayStart) {
    const parsed = tryParse(text.slice(firstArrayStart, lastArrayEnd + 1));
    if (parsed !== null) return parsed;
  }

  // 4. Try outermost object braces
  const firstObjStart = text.indexOf("{");
  const lastObjEnd = text.lastIndexOf("}");
  if (firstObjStart >= 0 && lastObjEnd > firstObjStart) {
    const parsed = tryParse(text.slice(firstObjStart, lastObjEnd + 1));
    if (parsed !== null) return parsed;
  }

  return null;
};

// ---------------------------------------------------------------------------
// OpenClaw envelope helpers
// ---------------------------------------------------------------------------

/**
 * Collect all non-empty `.payloads[].text` strings from an OpenClaw envelope
 * (checking both the top level and a `.result` sub-object).
 */
export const collectOpenClawEnvelopePayloadTexts = (
  parsed: unknown,
): string[] => {
  const texts: string[] = [];

  const collect = (container: unknown): void => {
    if (!isRecord(container)) return;
    const payloads = Array.isArray(container.payloads)
      ? container.payloads
      : [];
    for (const payload of payloads) {
      if (!isRecord(payload)) continue;
      const text =
        typeof payload.text === "string" && payload.text.trim().length > 0
          ? payload.text.trim()
          : "";
      if (text.length > 0) texts.push(text);
    }
  };

  collect(parsed);
  if (isRecord(parsed) && isRecord(parsed.result)) {
    collect(parsed.result);
  }

  return texts;
};

export type UnwrapResult = {
  parsed: unknown;
  envelope: Record<string, unknown> | null;
  payloadText: string | null;
};

/**
 * Given a parsed OpenClaw response, try to unwrap nested JSON from
 * `.payloads[].text`. Returns the innermost parsed value together with
 * the original envelope and joined payload text.
 */
export const unwrapOpenClawEnvelopePayload = (
  parsed: unknown,
): UnwrapResult => {
  if (!isRecord(parsed)) {
    return { parsed, envelope: null, payloadText: null };
  }

  const payloadTexts = collectOpenClawEnvelopePayloadTexts(parsed);
  if (payloadTexts.length === 0) {
    return { parsed, envelope: null, payloadText: null };
  }

  const payloadText = payloadTexts.join("\n\n").trim();
  if (!payloadText.length) {
    return { parsed, envelope: null, payloadText: null };
  }

  const nestedParsed = parseJsonFromMixedText(payloadText);
  if (nestedParsed !== null) {
    return { parsed: nestedParsed, envelope: parsed, payloadText };
  }

  return {
    parsed: { text: payloadText },
    envelope: parsed,
    payloadText,
  };
};

// ---------------------------------------------------------------------------
// parseCommand
// ---------------------------------------------------------------------------

/**
 * Validate and normalize a raw command object into a typed `Command`.
 * Returns `null` when the input is not a valid command shape.
 */
export const parseCommand = (value: unknown): Command | null => {
  if (!isRecord(value)) return null;
  const kind = typeof value.kind === "string" ? value.kind.trim() : "";
  if (!kind.length) return null;

  const id =
    typeof value.id === "string" && value.id.trim().length
      ? value.id.trim()
      : crypto.randomUUID();
  const createdAt =
    typeof value.createdAt === "string" && value.createdAt.trim().length
      ? value.createdAt.trim()
      : nowIso();
  const grantId =
    typeof value.grantId === "string" && value.grantId.trim().length
      ? value.grantId.trim()
      : null;
  const sig =
    typeof value.sig === "string" && value.sig.trim().length
      ? value.sig.trim()
      : null;
  const sourceDirectiveId =
    typeof value.sourceDirectiveId === "string" &&
    value.sourceDirectiveId.trim().length
      ? value.sourceDirectiveId.trim()
      : null;
  const pendingDirectiveId =
    typeof value.pendingDirectiveId === "string" &&
    value.pendingDirectiveId.trim().length
      ? value.pendingDirectiveId.trim()
      : null;
  const actionNonce =
    typeof value.actionNonce === "string" && value.actionNonce.trim().length
      ? value.actionNonce.trim()
      : null;
  const challenge = isRecord(value.challenge) ? value.challenge : null;
  const forceNow = value.forceNow === true;
  const runtimeSessionId =
    typeof value.runtimeSessionId === "string" &&
    value.runtimeSessionId.trim().length
      ? value.runtimeSessionId.trim()
      : null;
  const runtimeOrigin =
    typeof value.runtimeOrigin === "string" &&
    value.runtimeOrigin.trim().length
      ? value.runtimeOrigin.trim()
      : null;
  const runtimeSig =
    typeof value.runtimeSig === "string" && value.runtimeSig.trim().length
      ? value.runtimeSig.trim()
      : null;

  return {
    id,
    createdAt,
    kind,
    grantId,
    payload: isRecord(value.payload) ? value.payload : null,
    sig,
    sourceDirectiveId,
    pendingDirectiveId,
    actionNonce,
    challenge,
    forceNow,
    runtimeSessionId,
    runtimeOrigin,
    runtimeSig,
  };
};

// ---------------------------------------------------------------------------
// Director payload type guards
// ---------------------------------------------------------------------------

/** Check whether a push payload is a director grant. */
export const isDirectorGrantPayload = (
  payload: unknown,
): payload is DirectorGrantPayload =>
  isRecord(payload) &&
  payload.type === "director_grant" &&
  isRecord(payload.grant) &&
  typeof (payload.grant as Record<string, unknown>).id === "string";

/** Check whether a push payload is a director directive. */
export const isDirectorDirectivePayload = (
  payload: unknown,
): payload is DirectorDirectivePayload =>
  isRecord(payload) &&
  payload.type === "director_directive" &&
  isRecord(payload.directive) &&
  typeof (payload.directive as Record<string, unknown>).id === "string" &&
  typeof (payload.directive as Record<string, unknown>).kind === "string";

/** Check whether a push payload is a director credits notification. */
export const isDirectorCreditsPayload = (
  payload: unknown,
): payload is DirectorCreditsPayload =>
  isRecord(payload) &&
  payload.type === "director_credits_added" &&
  typeof payload.creditId === "string";
