import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { CommandExecutor } from "./command-executor.js";
import type { Command } from "../types/ipc.js";
import { isRecord } from "../lib/guards.js";

const tempDirs: string[] = [];

const directiveCommandWithoutSourceId = (): Command => ({
  id: "directive-fallback-write-create-post-1",
  createdAt: new Date().toISOString(),
  kind: "write.createPost",
  grantId: "directive:directive-fallback-write-create-post-1",
  payload: {},
  sig: null,
  sourceDirectiveId: null,
  pendingDirectiveId: null,
  actionNonce: "action-nonce-fallback-1",
  challenge: null,
  forceNow: true,
  runtimeSessionId: null,
  runtimeOrigin: "director_directive",
  runtimeSig: null,
});

type WriteCreatePostInvoker = {
  executeWriteCreatePost(command: Command): Promise<unknown>;
};

const createExecutor = () => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-command-executor-directive-source-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  tempDirs.push(root);
  const ipcPaths = {
    inboxDir: path.join(root, "inbox"),
    processedDir: path.join(root, "processed"),
    generatedDir: path.join(root, "generated"),
    queueStatePath: path.join(root, "queue-state.json"),
    resultsPath: path.join(root, "results.jsonl"),
  };
  const createPostMutate = vi.fn(async (input: unknown) => ({
    id: 321,
    ...(isRecord(input) ? input : {}),
  }));
  const runOpenClawPrompt = vi.fn(async () => ({
    parsed: {
      caption: "Directive fallback caption",
      textBody: "Directive fallback body that passes curation checks.",
    },
    payloadText: "",
    raw: "",
  }));
  const noopMutate = async () => ({ ok: true });
  const executor = new CommandExecutor({
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
        createPost: { mutate: createPostMutate },
        createStory: { mutate: noopMutate },
        commentPost: { mutate: noopMutate },
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
    runOpenClawPrompt,
  });
  return { executor, createPostMutate };
};

describe("command executor directive source fallback for writes", () => {
  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
  });

  it("uses command.id as sourceDirectiveId for directive write.createPost commands", async () => {
    const { executor, createPostMutate } = createExecutor();
    const invoker = executor as unknown as WriteCreatePostInvoker;
    const command: Command = {
      ...directiveCommandWithoutSourceId(),
      payload: {
        postType: "text",
        kind: "post",
        textBody: "Directive post body",
      },
    };

    const outcome = await invoker.executeWriteCreatePost(command);
    expect(createPostMutate).toHaveBeenCalledTimes(1);
    const createInput = createPostMutate.mock.calls[0]?.[0];
    expect(isRecord(createInput)).toBe(true);
    if (!isRecord(createInput)) return;
    expect(createInput.sourceDirectiveId).toBe(command.id);
    expect(createInput.sourceDirectiveActionNonce).toBe(command.actionNonce);
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(true);
  });
});
