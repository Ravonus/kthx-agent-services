/** Recursive extraction of action contract objects from unknown LLM output. */

import type { ActionContract } from "../types.js";

import {
  asNonEmptyString,
  asPositiveInt,
  truncateText,
} from "../helpers.js";

import { parseJsonFromMixedText } from "../../lib/parsing.js";
import { isRecord } from "../../lib/guards.js";
import { isTargetLockMatch } from "../../lib/command-target.js";

// ---------------------------------------------------------------------------
// extractActionContractFromUnknown
// ---------------------------------------------------------------------------

export function extractActionContractFromUnknown(input: {
  value: unknown;
  action: "comment" | "like" | "repost";
  expectedPostId: number;
  expectedCommentId: number | null;
  expectedTargetHash: string;
}): ActionContract | null {
  const parseFromRecord = (
    record: Record<string, unknown>,
  ): ActionContract | null => {
    const action =
      asNonEmptyString(record.action)?.toLowerCase() ?? input.action;
    if (action !== input.action) return null;
    if (typeof record.shouldExecute !== "boolean") return null;
    const target = isRecord(record.target) ? record.target : null;
    if (!target) return null;
    const postId = asPositiveInt(target.postId);
    if (postId !== input.expectedPostId) return null;
    const commentId =
      target.commentId === null ? null : asPositiveInt(target.commentId);
    if (commentId !== (input.expectedCommentId ?? null)) return null;
    const targetHashCandidate = asNonEmptyString(target.targetHash);
    if (
      targetHashCandidate !== null &&
      targetHashCandidate !== input.expectedTargetHash
    ) {
      return null;
    }
    const targetHash = targetHashCandidate ?? input.expectedTargetHash;
    const targetLockMatch = isTargetLockMatch({
      payload: {
        targetPostId: postId,
        targetCommentId: commentId,
        targetHash,
      },
      expected: {
        postId: input.expectedPostId,
        commentId: input.expectedCommentId,
        targetHash: input.expectedTargetHash,
      },
    });
    if (!targetLockMatch.ok) return null;
    const reason = truncateText(
      asNonEmptyString(record.reason) ?? "no_reason",
      120,
    );
    const body = asNonEmptyString(record.body);
    if (input.action === "comment" && !body) return null;
    return {
      action: input.action,
      target: {
        postId,
        commentId,
        targetHash,
      },
      body: body ?? null,
      reason,
      shouldExecute: record.shouldExecute,
    };
  };

  if (typeof input.value === "string") {
    const trimmed = input.value.trim();
    if (!trimmed.length) return null;
    const parsed = parseJsonFromMixedText(trimmed);
    if (parsed === null || parsed === input.value) return null;
    return extractActionContractFromUnknown({
      ...input,
      value: parsed,
    });
  }
  if (Array.isArray(input.value)) {
    for (const entry of input.value) {
      const parsed = extractActionContractFromUnknown({
        ...input,
        value: entry,
      });
      if (parsed) return parsed;
    }
    return null;
  }
  if (!isRecord(input.value)) return null;
  const direct = parseFromRecord(input.value);
  if (direct) return direct;
  for (const key of [
    "contract",
    "result",
    "output",
    "payload",
    "data",
    "content",
  ] as const) {
    const nested = extractActionContractFromUnknown({
      ...input,
      value: input.value[key],
    });
    if (nested) return nested;
  }
  return null;
}
