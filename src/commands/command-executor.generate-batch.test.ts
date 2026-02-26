import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { CommandExecutor } from "./command-executor.js";
import type { Command } from "../types/ipc.js";
import { isRecord } from "../lib/guards.js";
import type { StateSqliteStore } from "../state/sqlite-state.js";

const tempDirs: string[] = [];

const baseCommand = (): Command => ({
  id: "test-generate-batch",
  createdAt: new Date().toISOString(),
  kind: "brain.generateAndQueue",
  grantId: null,
  payload: {},
  sig: null,
  sourceDirectiveId: "test-generate-batch",
  pendingDirectiveId: null,
  actionNonce: null,
  challenge: null,
  forceNow: true,
  runtimeSessionId: null,
  runtimeOrigin: "director_directive",
  runtimeSig: null,
});

const createLifecycleStateDbStub = () => {
  const lifecycleByKey = new Map<
    string,
    {
      state: string;
      updatedAt: string;
    }
  >();
  return {
    enabled: true,
    getCommandLifecycleByIdempotencyKey: (idempotencyKey: string) =>
      lifecycleByKey.get(idempotencyKey) ?? null,
    upsertCommandLifecycle: (payload: unknown) => {
      if (!isRecord(payload)) return;
      const idempotencyKey =
        typeof payload.idempotencyKey === "string"
          ? payload.idempotencyKey.trim()
          : "";
      if (!idempotencyKey.length) return;
      const state =
        typeof payload.state === "string" && payload.state.trim().length > 0
          ? payload.state.trim()
          : "queued";
      lifecycleByKey.set(idempotencyKey, {
        state,
        updatedAt: new Date().toISOString(),
      });
    },
  } as unknown as StateSqliteStore;
};

const createExecutor = (
  commentPostMutate: (input: unknown) => Promise<unknown>,
  stateDbOverride: StateSqliteStore | null = null,
) => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-command-executor-generate-batch-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  tempDirs.push(root);
  const ipcPaths = {
    inboxDir: path.join(root, "inbox"),
    processedDir: path.join(root, "processed"),
    generatedDir: path.join(root, "generated"),
    queueStatePath: path.join(root, "queue-state.json"),
    resultsPath: path.join(root, "results.jsonl"),
  };
  const noopMutate = async () => ({ ok: true });

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
    stateDb: stateDbOverride,
    trpc: {
      agent: {
        ackDirective: { mutate: noopMutate },
        createPost: { mutate: noopMutate },
        createStory: { mutate: noopMutate },
        commentPost: { mutate: commentPostMutate },
        updateAvatar: { mutate: noopMutate },
        updateBanner: { mutate: noopMutate },
        votePost: { mutate: noopMutate },
        repostPost: { mutate: noopMutate },
        generate: { mutate: noopMutate },
        uploadDataUri: { mutate: noopMutate },
        uploadRemote: { mutate: noopMutate },
      },
      realtime: {
        ackDirective: { mutate: noopMutate },
      },
    },
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
    callAgentChatBridge: null,
    callAgentUploadChunk: null,
    runOpenClawPrompt: null,
  });
};

describe("command executor generate batch execution", () => {
  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
  });

  it("continues through remaining drafts after one draft execution failure", async () => {
    let callCount = 0;
    const commentPost = vi.fn(async (input: unknown) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("simulated comment mutate failure");
      }
      return {
        ok: true,
        input,
      };
    });
    const executor = createExecutor(commentPost);
    const invoker = executor as unknown as {
      executeGenerateAndQueue(command: Command): Promise<unknown>;
    };

    const command: Command = {
      ...baseCommand(),
      payload: {
        goal: "comment",
        postId: 101,
        allowMultipleGeneratedDrafts: true,
        generateKinds: ["comment"],
        drafts: [
          {
            action: "comment",
            payload: {
              postId: 101,
              body: "First generated comment that should fail in mutator.",
            },
          },
          {
            action: "comment",
            payload: {
              postId: 102,
              body: "Second generated comment should still execute after failure.",
            },
          },
        ],
      },
    };

    const outcome = await invoker.executeGenerateAndQueue(command);
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(true);

    expect(commentPost).toHaveBeenCalledTimes(2);

    const data = isRecord(outcome.data) ? outcome.data : null;
    expect(data).not.toBeNull();
    if (!data) return;
    const executed = Array.isArray(data.executed) ? data.executed : [];
    const failedDrafts = Array.isArray(data.failedDrafts) ? data.failedDrafts : [];
    expect(executed.length).toBeGreaterThanOrEqual(1);
    expect(failedDrafts.length).toBe(1);
    const firstFailure = failedDrafts[0];
    expect(isRecord(firstFailure)).toBe(true);
    if (isRecord(firstFailure)) {
      expect(firstFailure.kind).toBe("write.commentpost");
      expect(String(firstFailure.reason ?? "")).toContain("simulated comment mutate failure");
    }
  });

  it("executes multiple generated comments on the same target when bodies differ", async () => {
    const commentPost = vi.fn(async (input: unknown) => ({
      ok: true,
      input,
    }));
    const executor = createExecutor(commentPost, createLifecycleStateDbStub());
    const invoker = executor as unknown as {
      executeGenerateAndQueue(command: Command): Promise<unknown>;
    };

    const command: Command = {
      ...baseCommand(),
      payload: {
        goal: "comment",
        postId: 101,
        allowMultipleGeneratedDrafts: true,
        generateKinds: ["comment"],
        drafts: [
          {
            action: "comment",
            payload: {
              postId: 101,
              body: "First unique generated comment.",
            },
          },
          {
            action: "comment",
            payload: {
              postId: 101,
              body: "Second unique generated comment.",
            },
          },
        ],
      },
    };

    const outcome = await invoker.executeGenerateAndQueue(command);
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(true);

    expect(commentPost).toHaveBeenCalledTimes(2);

    const data = isRecord(outcome.data) ? outcome.data : null;
    expect(data).not.toBeNull();
    if (!data) return;
    const executed = Array.isArray(data.executed) ? data.executed : [];
    const skippedDrafts = Array.isArray(data.skippedDrafts) ? data.skippedDrafts : [];
    const failedDrafts = Array.isArray(data.failedDrafts) ? data.failedDrafts : [];
    expect(executed.length).toBeGreaterThanOrEqual(2);
    expect(skippedDrafts.length).toBe(0);
    expect(failedDrafts.length).toBe(0);
  });

  it("limits directive-generated drafts to one by default", async () => {
    const commentPost = vi.fn(async (input: unknown) => ({
      ok: true,
      input,
    }));
    const executor = createExecutor(commentPost, createLifecycleStateDbStub());
    const invoker = executor as unknown as {
      executeGenerateAndQueue(command: Command): Promise<unknown>;
    };

    const command: Command = {
      ...baseCommand(),
      payload: {
        goal: "comment",
        postId: 101,
        generateKinds: ["comment"],
        drafts: [
          {
            action: "comment",
            payload: {
              postId: 101,
              body: "First generated comment.",
            },
          },
          {
            action: "comment",
            payload: {
              postId: 101,
              body: "Second generated comment that should be suppressed.",
            },
          },
        ],
      },
    };

    const outcome = await invoker.executeGenerateAndQueue(command);
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(true);
    expect(commentPost).toHaveBeenCalledTimes(1);
  });
});
