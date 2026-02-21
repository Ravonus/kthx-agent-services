import crypto from "node:crypto";

import { isRecord } from "./guards.js";

const toPositiveInt = (value: unknown): number | null => {
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

const toTrimmedString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export type CommandTarget = {
  postId: number;
  commentId: number | null;
  targetHash: string;
};

export const buildTargetHash = (input: {
  postId: number;
  commentId: number | null;
}): string =>
  crypto
    .createHash("sha256")
    .update(`${input.postId}:${input.commentId ?? 0}`)
    .digest("hex");

export const resolveTargetLock = (payload: unknown): {
  targetPostId: number | null;
  targetCommentId: number | null;
  targetHash: string | null;
} => {
  if (!isRecord(payload)) {
    return {
      targetPostId: null,
      targetCommentId: null,
      targetHash: null,
    };
  }
  return {
    targetPostId: toPositiveInt(payload.targetPostId),
    targetCommentId: toPositiveInt(payload.targetCommentId),
    targetHash: toTrimmedString(payload.targetHash),
  };
};

export const applyTargetLock = (payload: Record<string, unknown>, input: {
  postId: number;
  commentId: number | null;
}): CommandTarget => {
  const expectedHash = buildTargetHash({
    postId: input.postId,
    commentId: input.commentId,
  });
  payload.targetPostId = input.postId;
  payload.targetCommentId = input.commentId;
  payload.targetHash = expectedHash;
  return {
    postId: input.postId,
    commentId: input.commentId,
    targetHash: expectedHash,
  };
};

export const isTargetLockMatch = (input: {
  payload: Record<string, unknown>;
  expected: CommandTarget;
}): { ok: true } | { ok: false; reason: string } => {
  const lock = resolveTargetLock(input.payload);
  if (typeof lock.targetPostId === "number" && lock.targetPostId !== input.expected.postId) {
    return { ok: false, reason: "target_post_mismatch" };
  }
  if (
    typeof lock.targetCommentId === "number" &&
    lock.targetCommentId !== (input.expected.commentId ?? null)
  ) {
    return { ok: false, reason: "target_comment_mismatch" };
  }
  if (typeof lock.targetHash === "string" && lock.targetHash !== input.expected.targetHash) {
    return { ok: false, reason: "target_hash_mismatch" };
  }
  return { ok: true };
};

