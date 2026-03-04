import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { CommandExecutor } from "./command-executor.js";
import { isRecord } from "../lib/guards.js";

const tempDirs: string[] = [];

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const asPositiveInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;

const createExecutor = (
  callAgentChatBridge: (payload: unknown) => Promise<unknown>,
  options?: {
    stateDb?: unknown;
    memoryWrites?: unknown[];
  },
) => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-command-executor-self-comment-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  tempDirs.push(root);
  const ipcPaths = {
    inboxDir: path.join(root, "inbox"),
    processedDir: path.join(root, "processed"),
    generatedDir: path.join(root, "generated"),
    queueStatePath: path.join(root, "queue-state.json"),
    resultsPath: path.join(root, "results.jsonl"),
  };
  return new CommandExecutor({
    config: {
      imageGenerateCmd: null,
      fileGenerateCmd: null,
      imageGenerateTimeoutMs: 45_000,
    },
    ipcPaths,
    memory: {
      recordWrite: async (payload: unknown) => {
        options?.memoryWrites?.push(payload);
      },
    },
    stateDb: (options?.stateDb ?? null) as never,
    trpc: null,
    commandSeal: {
      runtimeCommandSessionId: "session-test",
      runtimeCommandSealKey: "seal-test",
      runtimeIssuedCommandIds: new Set<string>(),
      runtimeConsumedCommandIds: new Set<string>(),
    },
    controlKey: null,
    queue: {
      queueStateMutation: Promise.resolve(),
    },
    callAgentChatBridge,
    callAgentUploadChunk: null,
    runOpenClawPrompt: null,
  });
};

type ResolveInvoker = {
  resolveEngagementTargetForDirective(input: {
    payload: Record<string, unknown>;
    action: "comment" | "like" | "repost";
    commandId: string;
  }): Promise<{
    postId: number;
    commentId: number | null;
    authorId: string | null;
    source: string;
  } | null>;
};

describe("command executor self-comment policy", () => {
  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
  });


  it("filters recent comment targets and falls back to a different post", async () => {
    const ownUserId = "agent-main-user";
    const recentAt = new Date().toISOString();
    const bridge = vi.fn(async (rawPayload: unknown) => {
      if (!isRecord(rawPayload)) return { items: [] };
      const action = asNonEmptyString(rawPayload.action);
      if (!action) return { items: [] };
      if (action === "agent_profile") {
        return {
          agent: {
            mainUserId: ownUserId,
            handle: "kael",
          },
        };
      }
      if (action === "browse_notifications") return { items: [] };
      if (action === "browse_unanswered_mentions") return { items: [] };
      if (action === "browse_top_engagers") return { items: [] };
      if (action === "browse_recent_actions") {
        return {
          items: [
            {
              id: 200,
              postId: 200,
              authorId: "other-main-user-a",
            },
            {
              id: 201,
              postId: 201,
              authorId: "other-main-user-b",
            },
          ],
        };
      }
      if (action === "find_post") {
        const postId = asPositiveInt(rawPayload.postId);
        if (postId === 200) {
          return {
            post: {
              id: 200,
              postId: 200,
              author: { mainUserId: "other-main-user-a" },
            },
          };
        }
        if (postId === 201) {
          return {
            post: {
              id: 201,
              postId: 201,
              author: { mainUserId: "other-main-user-b" },
            },
          };
        }
      }
      return { items: [] };
    });
    const executor = createExecutor(bridge, {
      stateDb: {
        enabled: true,
        getRecentCommandLifecycle: () => [
          {
            commandId: "recent-comment-1",
            action: "comment",
            state: "acked",
            targetPostId: 200,
            targetCommentId: null,
            updatedAt: recentAt,
          },
        ],
      },
    });
    const invoker = executor as unknown as ResolveInvoker;

    const resolved = await invoker.resolveEngagementTargetForDirective({
      payload: {
        requestText: "Find a target to comment on.",
      },
      action: "comment",
      commandId: "cmd-filter-recent-comment-post",
    });

    expect(resolved).not.toBeNull();
    if (!resolved) return;
    expect(resolved.postId).toBe(201);
  });

  it("allows new reply-signal comment targets on recently visited posts", async () => {
    const ownUserId = "agent-main-user";
    const recentAt = new Date().toISOString();
    const bridge = vi.fn(async (rawPayload: unknown) => {
      if (!isRecord(rawPayload)) return { items: [] };
      const action = asNonEmptyString(rawPayload.action);
      if (!action) return { items: [] };
      if (action === "agent_profile") {
        return {
          agent: {
            mainUserId: ownUserId,
            handle: "kael",
          },
        };
      }
      if (action === "browse_notifications") return { items: [] };
      if (action === "browse_unanswered_mentions") {
        return {
          items: [
            {
              targetType: "post",
              targetId: 350,
              targetCommentId: 9902,
            },
          ],
        };
      }
      if (action === "browse_top_engagers") return { items: [] };
      if (action === "browse_recent_actions") return { items: [] };
      if (action === "find_post") {
        const postId = asPositiveInt(rawPayload.postId);
        if (postId === 350) {
          return {
            post: {
              id: 350,
              postId: 350,
              author: { mainUserId: "other-main-user" },
            },
          };
        }
      }
      return { items: [] };
    });
    const executor = createExecutor(bridge, {
      stateDb: {
        enabled: true,
        getRecentCommandLifecycle: () => [
          {
            commandId: "recent-comment-mention",
            action: "comment",
            state: "acked",
            targetPostId: 350,
            targetCommentId: 9901,
            updatedAt: recentAt,
          },
        ],
      },
    });
    const invoker = executor as unknown as ResolveInvoker;

    const resolved = await invoker.resolveEngagementTargetForDirective({
      payload: {
        requestText: "Reply to mentions.",
      },
      action: "comment",
      commandId: "cmd-allow-reply-signal-recent-post",
    });

    expect(resolved).not.toBeNull();
    if (!resolved) return;
    expect(resolved.postId).toBe(350);
    expect(resolved.commentId).toBe(9902);
    expect(resolved.source).toContain("unanswered_mention");
  });

  it("fails when all comment candidates are blocked by recent target reuse", async () => {
    const ownUserId = "agent-main-user";
    const recentAt = new Date().toISOString();
    const bridge = vi.fn(async (rawPayload: unknown) => {
      if (!isRecord(rawPayload)) return { items: [] };
      const action = asNonEmptyString(rawPayload.action);
      if (!action) return { items: [] };
      if (action === "agent_profile") {
        return {
          agent: {
            mainUserId: ownUserId,
            handle: "kael",
          },
        };
      }
      if (action === "browse_notifications") return { items: [] };
      if (action === "browse_unanswered_mentions") return { items: [] };
      if (action === "browse_top_engagers") return { items: [] };
      if (action === "browse_recent_actions") {
        return {
          items: [
            {
              id: 777,
              postId: 777,
              authorId: "other-main-user",
            },
          ],
        };
      }
      if (action === "find_post") {
        const postId = asPositiveInt(rawPayload.postId);
        if (postId === 777) {
          return {
            post: {
              id: 777,
              postId: 777,
              author: { mainUserId: "other-main-user" },
            },
          };
        }
      }
      return { items: [] };
    });
    const executor = createExecutor(bridge, {
      stateDb: {
        enabled: true,
        getRecentCommandLifecycle: () => [
          {
            commandId: "recent-comment-repeat",
            action: "comment",
            state: "acked",
            targetPostId: 777,
            targetCommentId: null,
            updatedAt: recentAt,
          },
        ],
      },
    });
    const invoker = executor as unknown as ResolveInvoker;

    await expect(
      invoker.resolveEngagementTargetForDirective({
        payload: {
          requestText: "Comment somewhere.",
        },
        action: "comment",
        commandId: "cmd-recent-comment-target-blocked",
      }),
    ).rejects.toThrow(/recent_comment_target_reuse_blocked/iu);
  });

  it("allows revisiting a recent post when the snapshot hash changed", async () => {
    const ownUserId = "agent-main-user";
    const recentAt = new Date().toISOString();
    const bridge = vi.fn(async (rawPayload: unknown) => {
      if (!isRecord(rawPayload)) return { items: [] };
      const action = asNonEmptyString(rawPayload.action);
      if (!action) return { items: [] };
      if (action === "agent_profile") {
        return {
          agent: {
            mainUserId: ownUserId,
            handle: "kael",
          },
        };
      }
      if (action === "browse_notifications") return { items: [] };
      if (action === "browse_unanswered_mentions") return { items: [] };
      if (action === "browse_top_engagers") return { items: [] };
      if (action === "browse_recent_actions") {
        return {
          items: [
            {
              id: 888,
              postId: 888,
              authorId: "other-main-user",
              postSnapshotHash: "snapshot-new",
            },
          ],
        };
      }
      if (action === "find_post") {
        const postId = asPositiveInt(rawPayload.postId);
        if (postId === 888) {
          return {
            post: {
              id: 888,
              postId: 888,
              author: { mainUserId: "other-main-user" },
              postSnapshotHash: "snapshot-new",
            },
          };
        }
      }
      return { items: [] };
    });
    const executor = createExecutor(bridge, {
      stateDb: {
        enabled: true,
        getRecentCommandLifecycle: () => [
          {
            commandId: "recent-comment-snapshot",
            action: "comment",
            state: "acked",
            targetPostId: 888,
            targetCommentId: null,
            updatedAt: recentAt,
            payloadJson: JSON.stringify({
              targetPostSnapshotHash: "snapshot-old",
            }),
          },
        ],
      },
    });
    const invoker = executor as unknown as ResolveInvoker;

    const resolved = await invoker.resolveEngagementTargetForDirective({
      payload: {
        requestText: "Find something to comment on.",
      },
      action: "comment",
      commandId: "cmd-allow-snapshot-change",
    });

    expect(resolved).not.toBeNull();
    if (!resolved) return;
    expect(resolved.postId).toBe(888);
  });

  it("blocks revisiting a recent post when the snapshot hash is unchanged", async () => {
    const ownUserId = "agent-main-user";
    const recentAt = new Date().toISOString();
    const bridge = vi.fn(async (rawPayload: unknown) => {
      if (!isRecord(rawPayload)) return { items: [] };
      const action = asNonEmptyString(rawPayload.action);
      if (!action) return { items: [] };
      if (action === "agent_profile") {
        return {
          agent: {
            mainUserId: ownUserId,
            handle: "kael",
          },
        };
      }
      if (action === "browse_notifications") return { items: [] };
      if (action === "browse_unanswered_mentions") return { items: [] };
      if (action === "browse_top_engagers") return { items: [] };
      if (action === "browse_recent_actions") {
        return {
          items: [
            {
              id: 889,
              postId: 889,
              authorId: "other-main-user",
              postSnapshotHash: "snapshot-same",
            },
          ],
        };
      }
      if (action === "find_post") {
        const postId = asPositiveInt(rawPayload.postId);
        if (postId === 889) {
          return {
            post: {
              id: 889,
              postId: 889,
              author: { mainUserId: "other-main-user" },
              postSnapshotHash: "snapshot-same",
            },
          };
        }
      }
      return { items: [] };
    });
    const executor = createExecutor(bridge, {
      stateDb: {
        enabled: true,
        getRecentCommandLifecycle: () => [
          {
            commandId: "recent-comment-snapshot-same",
            action: "comment",
            state: "acked",
            targetPostId: 889,
            targetCommentId: null,
            updatedAt: recentAt,
            payloadJson: JSON.stringify({
              targetPostSnapshotHash: "snapshot-same",
            }),
          },
        ],
      },
    });
    const invoker = executor as unknown as ResolveInvoker;

    await expect(
      invoker.resolveEngagementTargetForDirective({
        payload: {
          requestText: "Comment somewhere.",
        },
        action: "comment",
        commandId: "cmd-block-snapshot-unchanged",
      }),
    ).rejects.toThrow(/recent_comment_target_reuse_blocked/iu);
  });

  it("blocks repeated own-post thread replies when there is no new external reply", async () => {
    const ownUserId = "agent-main-user";
    const recentAt = new Date().toISOString();
    const bridge = vi.fn(async (rawPayload: unknown) => {
      if (!isRecord(rawPayload)) return { items: [] };
      const action = asNonEmptyString(rawPayload.action);
      if (!action) return { items: [] };
      if (action === "agent_profile") {
        return {
          agent: {
            mainUserId: ownUserId,
            handle: "kael",
          },
        };
      }
      if (action === "browse_notifications") return { items: [] };
      if (action === "browse_unanswered_mentions") return { items: [] };
      if (action === "browse_top_engagers") return { items: [] };
      if (action === "browse_recent_actions") return { items: [] };
      if (action === "find_post") {
        const authorHandle = asNonEmptyString(rawPayload.authorHandle)
          ?.replace(/^@+/u, "")
          .toLowerCase();
        if (authorHandle === "kael" && rawPayload.latest === true) {
          return {
            post: {
              id: 410,
              postId: 410,
              author: { mainUserId: ownUserId },
            },
          };
        }
        const postId = asPositiveInt(rawPayload.postId);
        if (postId === 410) {
          return {
            post: {
              id: 410,
              postId: 410,
              author: { mainUserId: ownUserId },
            },
          };
        }
      }
      if (action === "browse_comments") {
        return {
          comments: [
            {
              id: 9101,
              postId: 410,
              authorId: "external-user",
              createdAt: "2026-02-24T03:00:00.000Z",
            },
          ],
        };
      }
      if (action === "find_comment") {
        const postId = asPositiveInt(rawPayload.postId);
        const commentId = asPositiveInt(rawPayload.commentId);
        if (postId === 410 && commentId === 9101) {
          return {
            comment: {
              id: 9101,
              postId: 410,
              author: {
                mainUserId: "external-user",
              },
            },
          };
        }
      }
      return { items: [] };
    });
    const executor = createExecutor(bridge, {
      stateDb: {
        enabled: true,
        getRecentCommandLifecycle: () => [
          {
            commandId: "recent-own-thread-comment",
            action: "comment",
            state: "acked",
            targetPostId: 410,
            targetCommentId: 9101,
            updatedAt: recentAt,
          },
        ],
      },
    });
    const invoker = executor as unknown as ResolveInvoker;

    await expect(
      invoker.resolveEngagementTargetForDirective({
        payload: {
          requestText: "Reply to comments on my latest post.",
        },
        action: "comment",
        commandId: "cmd-block-repeated-own-thread-reply",
      }),
    ).rejects.toThrow(/recent_comment_target_reuse_blocked/iu);
  });

  it("allows own-post thread replies when a new external reply arrives", async () => {
    const ownUserId = "agent-main-user";
    const recentAt = new Date().toISOString();
    const bridge = vi.fn(async (rawPayload: unknown) => {
      if (!isRecord(rawPayload)) return { items: [] };
      const action = asNonEmptyString(rawPayload.action);
      if (!action) return { items: [] };
      if (action === "agent_profile") {
        return {
          agent: {
            mainUserId: ownUserId,
            handle: "kael",
          },
        };
      }
      if (action === "browse_notifications") return { items: [] };
      if (action === "browse_unanswered_mentions") return { items: [] };
      if (action === "browse_top_engagers") return { items: [] };
      if (action === "browse_recent_actions") return { items: [] };
      if (action === "find_post") {
        const authorHandle = asNonEmptyString(rawPayload.authorHandle)
          ?.replace(/^@+/u, "")
          .toLowerCase();
        if (authorHandle === "kael" && rawPayload.latest === true) {
          return {
            post: {
              id: 420,
              postId: 420,
              author: { mainUserId: ownUserId },
            },
          };
        }
        const postId = asPositiveInt(rawPayload.postId);
        if (postId === 420) {
          return {
            post: {
              id: 420,
              postId: 420,
              author: { mainUserId: ownUserId },
            },
          };
        }
      }
      if (action === "browse_comments") {
        return {
          comments: [
            {
              id: 9202,
              postId: 420,
              authorId: "external-user",
              createdAt: "2026-02-24T04:00:00.000Z",
            },
          ],
        };
      }
      if (action === "find_comment") {
        const postId = asPositiveInt(rawPayload.postId);
        const commentId = asPositiveInt(rawPayload.commentId);
        if (postId === 420 && commentId === 9202) {
          return {
            comment: {
              id: 9202,
              postId: 420,
              author: {
                mainUserId: "external-user",
              },
            },
          };
        }
      }
      return { items: [] };
    });
    const executor = createExecutor(bridge, {
      stateDb: {
        enabled: true,
        getRecentCommandLifecycle: () => [
          {
            commandId: "recent-own-thread-previous",
            action: "comment",
            state: "acked",
            targetPostId: 420,
            targetCommentId: 9201,
            updatedAt: recentAt,
          },
        ],
      },
    });
    const invoker = executor as unknown as ResolveInvoker;

    const resolved = await invoker.resolveEngagementTargetForDirective({
      payload: {
        requestText: "Reply to comments on my latest post.",
      },
      action: "comment",
      commandId: "cmd-allow-new-own-thread-reply",
    });

    expect(resolved).not.toBeNull();
    if (!resolved) return;
    expect(resolved.postId).toBe(420);
    expect(resolved.commentId).toBe(9202);
    expect(resolved.source).toContain("comment_thread");
  });
});
