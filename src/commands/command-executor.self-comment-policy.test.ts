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

const createExecutor = (callAgentChatBridge: (payload: unknown) => Promise<unknown>) => {
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
      recordWrite: async () => undefined,
    },
    stateDb: null,
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

  it("prefers non-self comment targets over own top-level posts", async () => {
    const ownUserId = "agent-main-user";
    const otherUserId = "other-main-user";
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
      if (action === "browse_notifications") {
        return { items: [] };
      }
      if (action === "find_post") {
        const authorHandle = asNonEmptyString(rawPayload.authorHandle)
          ?.replace(/^@+/u, "")
          .toLowerCase();
        if (authorHandle === "kael" && rawPayload.latest === true) {
          return {
            post: {
              id: 100,
              postId: 100,
              author: { mainUserId: ownUserId },
            },
          };
        }
        const postId = asPositiveInt(rawPayload.postId);
        if (postId === 100) {
          return {
            post: {
              id: 100,
              postId: 100,
              author: { mainUserId: ownUserId },
            },
          };
        }
        if (postId === 200) {
          return {
            post: {
              id: 200,
              postId: 200,
              author: { mainUserId: otherUserId },
            },
          };
        }
      }
      if (action === "browse_unanswered_mentions") {
        return { items: [] };
      }
      if (action === "browse_top_engagers") {
        return { items: [] };
      }
      if (action === "browse_recent_actions") {
        return {
          items: [
            {
              id: 200,
              postId: 200,
              authorId: otherUserId,
            },
          ],
        };
      }
      if (action === "browse_comments") {
        return { comments: [] };
      }
      return { items: [] };
    });
    const executor = createExecutor(bridge);
    const invoker = executor as unknown as ResolveInvoker;

    const resolved = await invoker.resolveEngagementTargetForDirective({
      payload: {
        requestText: "Find a target to comment on.",
      },
      action: "comment",
      commandId: "cmd-self-comment-prefers-external",
    });

    expect(resolved).not.toBeNull();
    if (!resolved) return;
    expect(resolved.postId).toBe(200);
    expect(resolved.commentId).toBeNull();
  });

  it("allows self-post comment replies when a non-self parent comment exists", async () => {
    const ownUserId = "agent-main-user";
    const otherUserId = "other-main-user";
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
      if (action === "browse_notifications") {
        return { items: [] };
      }
      if (action === "find_post") {
        const authorHandle = asNonEmptyString(rawPayload.authorHandle)
          ?.replace(/^@+/u, "")
          .toLowerCase();
        if (authorHandle === "kael" && rawPayload.latest === true) {
          return {
            post: {
              id: 100,
              postId: 100,
              author: { mainUserId: ownUserId },
            },
          };
        }
        const postId = asPositiveInt(rawPayload.postId);
        if (postId === 100) {
          return {
            post: {
              id: 100,
              postId: 100,
              author: { mainUserId: ownUserId },
            },
          };
        }
      }
      if (action === "browse_unanswered_mentions") {
        return { items: [] };
      }
      if (action === "browse_top_engagers") {
        return { items: [] };
      }
      if (action === "browse_recent_actions") {
        return { items: [] };
      }
      if (action === "browse_comments") {
        const postId = asPositiveInt(rawPayload.postId);
        if (postId !== 100) return { comments: [] };
        return {
          comments: [
            {
              id: 501,
              postId: 100,
              authorId: ownUserId,
              createdAt: "2026-02-24T00:00:00.000Z",
            },
            {
              id: 502,
              postId: 100,
              authorId: otherUserId,
              createdAt: "2026-02-24T01:00:00.000Z",
            },
          ],
        };
      }
      return { items: [] };
    });
    const executor = createExecutor(bridge);
    const invoker = executor as unknown as ResolveInvoker;

    const resolved = await invoker.resolveEngagementTargetForDirective({
      payload: {
        requestText: "Reply to comments on my latest post thread.",
      },
      action: "comment",
      commandId: "cmd-self-comment-reply-path",
    });

    expect(resolved).not.toBeNull();
    if (!resolved) return;
    expect(resolved.postId).toBe(100);
    expect(resolved.commentId).toBe(502);
    expect(String(resolved.source)).toContain("comment_thread");
  });

  it("blocks own top-level comments when no reply target exists", async () => {
    const ownUserId = "agent-main-user";
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
      if (action === "browse_notifications") {
        return { items: [] };
      }
      if (action === "find_post") {
        const authorHandle = asNonEmptyString(rawPayload.authorHandle)
          ?.replace(/^@+/u, "")
          .toLowerCase();
        if (authorHandle === "kael" && rawPayload.latest === true) {
          return {
            post: {
              id: 100,
              postId: 100,
              author: { mainUserId: ownUserId },
            },
          };
        }
        const postId = asPositiveInt(rawPayload.postId);
        if (postId === 100) {
          return {
            post: {
              id: 100,
              postId: 100,
              author: { mainUserId: ownUserId },
            },
          };
        }
      }
      if (action === "browse_unanswered_mentions") {
        return { items: [] };
      }
      if (action === "browse_top_engagers") {
        return { items: [] };
      }
      if (action === "browse_recent_actions") {
        return { items: [] };
      }
      if (action === "browse_comments") {
        return {
          comments: [
            {
              id: 501,
              postId: 100,
              authorId: ownUserId,
              createdAt: "2026-02-24T00:00:00.000Z",
            },
          ],
        };
      }
      return { items: [] };
    });
    const executor = createExecutor(bridge);
    const invoker = executor as unknown as ResolveInvoker;

    await expect(
      invoker.resolveEngagementTargetForDirective({
        payload: {
          requestText: "Comment on my latest post.",
        },
        action: "comment",
        commandId: "cmd-self-comment-block-top-level",
      }),
    ).rejects.toThrow(/self_root_comment_filtered/iu);
  });

  it("does not query own latest post for generic comment requests", async () => {
    const ownUserId = "agent-main-user";
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
              id: 301,
              postId: 301,
              authorId: "other-main-user",
            },
          ],
        };
      }
      if (action === "find_post") {
        const postId = asPositiveInt(rawPayload.postId);
        if (postId === 301) {
          return {
            post: {
              id: 301,
              postId: 301,
              author: { mainUserId: "other-main-user" },
            },
          };
        }
      }
      if (action === "browse_comments") return { comments: [] };
      return { items: [] };
    });
    const executor = createExecutor(bridge);
    const invoker = executor as unknown as ResolveInvoker;

    const resolved = await invoker.resolveEngagementTargetForDirective({
      payload: {
        requestText: "Find something to comment on.",
      },
      action: "comment",
      commandId: "cmd-no-own-latest-for-generic-comment",
    });

    expect(resolved).not.toBeNull();
    if (!resolved) return;
    expect(resolved.postId).toBe(301);
    expect(
      bridge.mock.calls.some((call) => {
        const payload = call[0];
        if (!isRecord(payload)) return false;
        const action = asNonEmptyString(payload.action);
        const handle = asNonEmptyString(payload.authorHandle);
        return action === "find_post" && handle === "@kael";
      }),
    ).toBe(false);
  });

  it("filters out own posts for like target selection", async () => {
    const ownUserId = "agent-main-user";
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
              id: 401,
              postId: 401,
              authorId: ownUserId,
            },
            {
              id: 402,
              postId: 402,
              authorId: "other-main-user",
            },
          ],
        };
      }
      if (action === "find_post") {
        const postId = asPositiveInt(rawPayload.postId);
        if (postId === 401) {
          return {
            post: {
              id: 401,
              postId: 401,
              author: { mainUserId: ownUserId },
            },
          };
        }
        if (postId === 402) {
          return {
            post: {
              id: 402,
              postId: 402,
              author: { mainUserId: "other-main-user" },
            },
          };
        }
      }
      return { items: [] };
    });
    const executor = createExecutor(bridge);
    const invoker = executor as unknown as ResolveInvoker;

    const resolved = await invoker.resolveEngagementTargetForDirective({
      payload: {
        requestText: "Like a good post.",
      },
      action: "like",
      commandId: "cmd-like-filter-self",
    });

    expect(resolved).not.toBeNull();
    if (!resolved) return;
    expect(resolved.postId).toBe(402);
  });

  it("hydrates missing author ids before filtering self targets", async () => {
    const ownUserId = "agent-main-user";
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
              id: 902,
              postId: 902,
            },
            {
              id: 901,
              postId: 901,
            },
          ],
        };
      }
      if (action === "find_post") {
        const postId = asPositiveInt(rawPayload.postId);
        if (postId === 902) {
          return {
            post: {
              id: 902,
              postId: 902,
              author: { mainUserId: ownUserId },
            },
          };
        }
        if (postId === 901) {
          return {
            post: {
              id: 901,
              postId: 901,
              author: { mainUserId: "other-main-user" },
            },
          };
        }
      }
      return { items: [] };
    });
    const executor = createExecutor(bridge);
    const invoker = executor as unknown as ResolveInvoker;

    const resolved = await invoker.resolveEngagementTargetForDirective({
      payload: {
        requestText: "Like a relevant post.",
      },
      action: "like",
      commandId: "cmd-like-hydrate-missing-author",
    });

    expect(resolved).not.toBeNull();
    if (!resolved) return;
    expect(resolved.postId).toBe(901);
  });

  it("skips replies to the agent's own comment on own posts and falls back", async () => {
    const ownUserId = "agent-main-user";
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
              id: 100,
              postId: 100,
              commentId: 901,
              authorId: ownUserId,
            },
            {
              id: 200,
              postId: 200,
              authorId: "other-main-user",
            },
          ],
        };
      }
      if (action === "find_post") {
        const postId = asPositiveInt(rawPayload.postId);
        if (postId === 100) {
          return {
            post: {
              id: 100,
              postId: 100,
              author: { mainUserId: ownUserId },
            },
          };
        }
        if (postId === 200) {
          return {
            post: {
              id: 200,
              postId: 200,
              author: { mainUserId: "other-main-user" },
            },
          };
        }
      }
      if (action === "find_comment") {
        const postId = asPositiveInt(rawPayload.postId);
        const commentId = asPositiveInt(rawPayload.commentId);
        if (postId === 100 && commentId === 901) {
          return {
            comment: {
              id: 901,
              commentId: 901,
              postId: 100,
              author: {
                mainUserId: ownUserId,
              },
            },
          };
        }
      }
      return { items: [] };
    });
    const executor = createExecutor(bridge);
    const invoker = executor as unknown as ResolveInvoker;

    const resolved = await invoker.resolveEngagementTargetForDirective({
      payload: {
        requestText: "Reply to comments.",
      },
      action: "comment",
      commandId: "cmd-filter-self-own-comment-reply",
    });

    expect(resolved).not.toBeNull();
    if (!resolved) return;
    expect(resolved.postId).toBe(200);
  });

  it("blocks own-post self-comment replies when no fallback exists", async () => {
    const ownUserId = "agent-main-user";
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
              id: 100,
              postId: 100,
              commentId: 901,
              authorId: ownUserId,
            },
          ],
        };
      }
      if (action === "find_post") {
        const postId = asPositiveInt(rawPayload.postId);
        if (postId === 100) {
          return {
            post: {
              id: 100,
              postId: 100,
              author: { mainUserId: ownUserId },
            },
          };
        }
      }
      if (action === "find_comment") {
        const postId = asPositiveInt(rawPayload.postId);
        const commentId = asPositiveInt(rawPayload.commentId);
        if (postId === 100 && commentId === 901) {
          return {
            comment: {
              id: 901,
              commentId: 901,
              postId: 100,
              author: {
                mainUserId: ownUserId,
              },
            },
          };
        }
      }
      return { items: [] };
    });
    const executor = createExecutor(bridge);
    const invoker = executor as unknown as ResolveInvoker;

    await expect(
      invoker.resolveEngagementTargetForDirective({
        payload: {
          requestText: "Reply to comments.",
        },
        action: "comment",
        commandId: "cmd-block-self-own-comment-reply",
      }),
    ).rejects.toThrow(/self_own_comment_reply_filtered/iu);
  });
});
