import { describe, expect, it } from "vitest";

import {
  applyTargetLock,
  buildTargetHash,
  isTargetLockMatch,
  resolveTargetLock,
} from "./command-target.js";

describe("command-target", () => {
  it("stamps and validates a post-only target lock", () => {
    const payload: Record<string, unknown> = {};
    const target = applyTargetLock(payload, { postId: 42, commentId: null });
    expect(target.targetHash).toBe(buildTargetHash({ postId: 42, commentId: null }));
    expect(resolveTargetLock(payload)).toEqual({
      targetPostId: 42,
      targetCommentId: null,
      targetHash: target.targetHash,
    });
    expect(
      isTargetLockMatch({
        payload,
        expected: target,
      }),
    ).toEqual({ ok: true });
  });

  it("detects mismatched target hash", () => {
    const payload: Record<string, unknown> = {};
    const stamped = applyTargetLock(payload, { postId: 100, commentId: 7 });
    payload.targetHash = `${stamped.targetHash}_bad`;
    expect(
      isTargetLockMatch({
        payload,
        expected: stamped,
      }),
    ).toEqual({ ok: false, reason: "target_hash_mismatch" });
  });
});

