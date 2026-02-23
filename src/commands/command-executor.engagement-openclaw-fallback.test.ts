import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { CommandExecutor } from "./command-executor.js";
import type { Command } from "../types/ipc.js";
import { isRecord } from "../lib/guards.js";

type OpenClawPromptResult = {
  parsed: unknown;
  raw: string;
  agentName: string | null;
  payloadText: string | null;
  envelope: Record<string, unknown> | null;
};

type OpenClawPromptFn = (payload: {
  prompt: string;
  purpose: string;
}) => Promise<OpenClawPromptResult | null>;

const tempDirs: string[] = [];

const baseCommand = (kind: Command["kind"]): Command => ({
  id: `test-${kind}-${Date.now().toString(36)}`,
  createdAt: new Date().toISOString(),
  kind,
  grantId: null,
  payload: {},
  sig: null,
  sourceDirectiveId: "test-directive",
  pendingDirectiveId: null,
  actionNonce: null,
  challenge: null,
  forceNow: true,
  runtimeSessionId: null,
  runtimeOrigin: "director_directive",
  runtimeSig: null,
});

const createExecutor = (input: {
  votePostMutate?: (payload: unknown) => Promise<unknown>;
  repostPostMutate?: (payload: unknown) => Promise<unknown>;
  runOpenClawPrompt?: OpenClawPromptFn | null;
}) => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-command-executor-engagement-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
        commentPost: { mutate: noopMutate },
        updateAvatar: { mutate: noopMutate },
        updateBanner: { mutate: noopMutate },
        votePost: { mutate: input.votePostMutate ?? noopMutate },
        repostPost: { mutate: input.repostPostMutate ?? noopMutate },
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
    runOpenClawPrompt: input.runOpenClawPrompt ?? null,
  });
};

describe("command executor engagement openclaw fallback", () => {
  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
  });

  it("executes like writes when openclaw is unavailable", async () => {
    const votePost = vi.fn(async (payload: unknown) => ({
      ok: true,
      payload,
    }));
    const executor = createExecutor({
      votePostMutate: votePost,
      runOpenClawPrompt: null,
    });
    const invoker = executor as unknown as {
      executeWriteVote(command: Command): Promise<unknown>;
    };

    const command: Command = {
      ...baseCommand("write.votePost"),
      payload: {
        postId: 77,
        vote: 1,
      },
    };

    const outcome = await invoker.executeWriteVote(command);
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(true);

    expect(votePost).toHaveBeenCalledTimes(1);
    const call = votePost.mock.calls[0]?.[0];
    expect(isRecord(call)).toBe(true);
    if (!isRecord(call)) return;
    expect(call.postId).toBe(77);
    expect(call.vote).toBe(1);
  });

  it("executes repost writes when openclaw decision call errors", async () => {
    const repostPost = vi.fn(async (payload: unknown) => ({
      ok: true,
      payload,
    }));
    const runOpenClawPromptMock = vi.fn(
      async (_payload: { prompt: string; purpose: string }): Promise<OpenClawPromptResult | null> => {
      throw new Error("openclaw unavailable");
    });
    const runOpenClawPrompt: OpenClawPromptFn = runOpenClawPromptMock;
    const executor = createExecutor({
      repostPostMutate: repostPost,
      runOpenClawPrompt,
    });
    const invoker = executor as unknown as {
      executeWriteRepost(command: Command): Promise<unknown>;
    };

    const command: Command = {
      ...baseCommand("write.repostPost"),
      payload: {
        postId: 91,
        repost: 1,
      },
    };

    const outcome = await invoker.executeWriteRepost(command);
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(true);

    expect(runOpenClawPromptMock).toHaveBeenCalledTimes(1);
    expect(repostPost).toHaveBeenCalledTimes(1);
    const call = repostPost.mock.calls[0]?.[0];
    expect(isRecord(call)).toBe(true);
    if (!isRecord(call)) return;
    expect(call.postId).toBe(91);
    expect(call.repost).toBe(1);
  });
});
