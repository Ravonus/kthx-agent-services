/**
 * Cryptographic utility functions.
 *
 * Ported from agent-runtime.mjs:
 *   - lines 979-1007:  getRuntimeAttestation (Ed25519 signing)
 *   - lines 2757-2794: stableStringify, hmacSha256Hex,
 *                       computeCommandSignature, computeChallengeAnswerSignature
 */

import crypto from "node:crypto";

import { trimEnv } from "./env-parse.js";
import { nowIso } from "./text.js";

// ---------------------------------------------------------------------------
// Attestation identity (module-level singleton, lazily initialised)
// ---------------------------------------------------------------------------

type AttestationIdentity = {
  runtimeId: string;
  appVersion: string;
  privateKey: crypto.KeyObject;
  publicKeyB64: string;
};

let runtimeAttestationIdentity: AttestationIdentity | null = null;

// ---------------------------------------------------------------------------
// RuntimeAttestation return type
// ---------------------------------------------------------------------------

export type RuntimeAttestation = {
  runtimeId: string;
  appVersion: string;
  publicKey: string;
  signature: string;
  timestampMs: number;
};

// ---------------------------------------------------------------------------
// getRuntimeAttestation
// ---------------------------------------------------------------------------

/**
 * Generate (or reuse) an Ed25519 key pair and sign a
 * `connectionId.runtimeId.timestampMs.appVersion` payload.
 *
 * The key pair is generated once per process and cached.
 */
export const getRuntimeAttestation = (
  connectionId: string,
): RuntimeAttestation => {
  if (!runtimeAttestationIdentity) {
    const pair = crypto.generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ format: "der", type: "spki" });
    const publicKeyRaw = publicKey.subarray(publicKey.length - 32);
    runtimeAttestationIdentity = {
      runtimeId: trimEnv("MG_RUNTIME_ID") ?? `rt_${crypto.randomUUID()}`,
      appVersion: trimEnv("MG_RUNTIME_VERSION") ?? "agent-runtime.mjs",
      privateKey: pair.privateKey,
      publicKeyB64: publicKeyRaw.toString("base64url"),
    };
  }

  const timestampMs = Date.now();
  const payload = [
    connectionId,
    runtimeAttestationIdentity.runtimeId,
    String(timestampMs),
    runtimeAttestationIdentity.appVersion,
  ].join(".");

  const signature = crypto
    .sign(
      null,
      Buffer.from(payload, "utf8"),
      runtimeAttestationIdentity.privateKey,
    )
    .toString("base64url");

  return {
    runtimeId: runtimeAttestationIdentity.runtimeId,
    appVersion: runtimeAttestationIdentity.appVersion,
    publicKey: runtimeAttestationIdentity.publicKeyB64,
    signature,
    timestampMs,
  };
};

/** Reset the cached attestation identity (useful for tests). */
export const resetAttestationIdentity = (): void => {
  runtimeAttestationIdentity = null;
};

// ---------------------------------------------------------------------------
// stableStringify
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialisation: object keys are sorted lexicographically
 * at every depth so that the output is identical regardless of insertion order.
 */
export const stableStringify = (value: unknown): string => {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean")
    return JSON.stringify(value);
  if (t !== "object") return JSON.stringify(null);
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",");
  return `{${body}}`;
};

// ---------------------------------------------------------------------------
// hmacSha256Hex
// ---------------------------------------------------------------------------

/** Compute an HMAC-SHA-256 digest and return the result as a lowercase hex string. */
export const hmacSha256Hex = (key: string, message: string): string =>
  crypto.createHmac("sha256", key).update(message).digest("hex");

// ---------------------------------------------------------------------------
// Command / challenge signature helpers
// ---------------------------------------------------------------------------

export type CommandSignatureInput = {
  id: string;
  createdAt: string;
  kind: string;
  grantId?: string | null;
  payload?: unknown;
};

/**
 * Compute the HMAC-SHA-256 signature for an outgoing command, using the
 * agent control key as the HMAC secret.
 */
export const computeCommandSignature = (
  controlKey: string,
  command: CommandSignatureInput,
): string => {
  const toSign = stableStringify({
    id: command.id,
    createdAt: command.createdAt,
    kind: command.kind,
    grantId: command.grantId ?? null,
    payload: command.payload ?? null,
  });
  return hmacSha256Hex(controlKey, toSign);
};

export type ChallengeAnswerSignatureInput = {
  token: string;
  promptType: string;
  challengeId?: string | null;
  answer: string;
};

/**
 * Compute the HMAC-SHA-256 signature for a challenge answer submission.
 */
export const computeChallengeAnswerSignature = (
  controlKey: string,
  payload: ChallengeAnswerSignatureInput,
): string => {
  const toSign = stableStringify({
    token: payload.token,
    promptType: payload.promptType,
    challengeId: payload.challengeId ?? null,
    answer: payload.answer,
  });
  return hmacSha256Hex(controlKey, toSign);
};
