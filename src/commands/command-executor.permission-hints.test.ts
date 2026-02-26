import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Command } from "../types/ipc.js";
import { isRecord } from "../lib/guards.js";

const tempDirs: string[] = [];

const baseCommand = (): Command => ({
  id: "test-generate-permission-hints",
  createdAt: new Date().toISOString(),
  kind: "brain.generateAndQueue",
  grantId: null,
  payload: {},
  sig: null,
  sourceDirectiveId: "test-generate-permission-hints",
  pendingDirectiveId: null,
  actionNonce: "nonce-test-generate-permission-hints",
  challenge: null,
  forceNow: true,
  runtimeSessionId: null,
  runtimeOrigin: "director_directive",
  runtimeSig: null,
});

type ExecutorCtor = typeof import("./command-executor.js").CommandExecutor;
let CommandExecutorCtor: ExecutorCtor;

const createExecutor = (generateMutate: (input: unknown) => Promise<unknown>) => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-command-executor-permission-hints-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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

  return new CommandExecutorCtor({
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
        votePost: { mutate: noopMutate },
        repostPost: { mutate: noopMutate },
        generate: { mutate: generateMutate },
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

describe("command executor permission hint filters", () => {
  beforeEach(async () => {
    process.env.MG_AGENT_ENFORCE_PERMISSION_HINT_FILTERS = "1";
    vi.resetModules();
    ({ CommandExecutor: CommandExecutorCtor } = await import("./command-executor.js"));
  });

  afterEach(() => {
    delete process.env.MG_AGENT_ENFORCE_PERMISSION_HINT_FILTERS;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
  });

  it("does not apply permission hint filtering for directive-linked commands", async () => {
    const generateMutate = vi.fn(async () => ({
      items: [
        {
          drafts: [],
        },
      ],
    }));
    const executor = createExecutor(generateMutate);
    const invoker = executor as unknown as {
      executeGenerateAndQueue(command: Command): Promise<unknown>;
    };
    const command: Command = {
      ...baseCommand(),
      payload: {
        goal: "media",
        kind: "media",
        permissionState: {
          can: {
            postMedia: false,
            postText: false,
            story: false,
            comment: false,
            like: false,
            repost: false,
            imageGenerate: false,
            textGenerate: false,
          },
        },
      },
    };

    const outcome = await invoker.executeGenerateAndQueue(command);
    expect(generateMutate).toHaveBeenCalledTimes(1);
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(false);
    expect(String(outcome.error?.code ?? "")).not.toBe("no_permitted_generate_kind");
  });

  it("still applies permission hint filtering for non-directive commands", async () => {
    const generateMutate = vi.fn(async () => ({
      items: [
        {
          drafts: [],
        },
      ],
    }));
    const executor = createExecutor(generateMutate);
    const invoker = executor as unknown as {
      executeGenerateAndQueue(command: Command): Promise<unknown>;
    };
    const command: Command = {
      ...baseCommand(),
      sourceDirectiveId: null,
      actionNonce: null,
      runtimeOrigin: "chat",
      payload: {
        goal: "media",
        kind: "media",
        permissionState: {
          can: {
            postMedia: false,
            postText: false,
            story: false,
            comment: false,
            like: false,
            repost: false,
            imageGenerate: false,
            textGenerate: false,
          },
        },
      },
    };

    const outcome = await invoker.executeGenerateAndQueue(command);
    expect(generateMutate).toHaveBeenCalledTimes(0);
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(false);
    expect(String(outcome.error?.code ?? "")).toBe("no_permitted_generate_kind");
  });
});

