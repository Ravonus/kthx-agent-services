import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { CommandExecutor } from "./command-executor.js";
import type { Command } from "../types/ipc.js";
import { isRecord } from "../lib/guards.js";

const tempDirs: string[] = [];

const baseCommand = (): Command => ({
  id: "test-comment-fallback",
  createdAt: new Date().toISOString(),
  kind: "write.commentPost",
  grantId: null,
  payload: {},
  sig: null,
  sourceDirectiveId: "test-comment-fallback",
  pendingDirectiveId: null,
  actionNonce: null,
  challenge: null,
  forceNow: true,
  runtimeSessionId: null,
  runtimeOrigin: "director_directive",
  runtimeSig: null,
});

const createExecutor = (commentPostMutate: (input: unknown) => Promise<unknown>) => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-command-executor-comment-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
    stateDb: null,
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

describe("command executor comment fallback", () => {
  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
  });

  it("falls back to generated draft body when openclaw curation is unavailable", async () => {
    const commentPost = vi.fn(async (input: unknown) => ({
      ok: true,
      input,
    }));
    const executor = createExecutor(commentPost);
    const invoker = executor as unknown as {
      executeWriteComment(command: Command): Promise<unknown>;
    };

    const command: Command = {
      ...baseCommand(),
      payload: {
        postId: 77,
        body: "Love the practical breakdown on shipping fast and refining from feedback.",
      },
    };

    const outcome = await invoker.executeWriteComment(command);
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(true);

    expect(commentPost).toHaveBeenCalledTimes(1);
    const call = commentPost.mock.calls[0]?.[0];
    expect(isRecord(call)).toBe(true);
    if (!isRecord(call)) return;
    expect(call.postId).toBe(77);
    expect(call.body).toBe(
      "Love the practical breakdown on shipping fast and refining from feedback.",
    );
  });
});
