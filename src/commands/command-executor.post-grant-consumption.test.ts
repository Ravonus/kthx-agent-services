import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { CommandExecutor } from "./command-executor.js";
import type { Command } from "../types/ipc.js";
import { isRecord } from "../lib/guards.js";

const tempDirs: string[] = [];

type GrantManagerStub = {
  consumeAction(actionKey: string): boolean;
};

type MediaUploadResult = {
  mediaUrl: string;
  mediaOriginalUrl?: string;
  mediaOptimizedUrl?: string;
  mediaContentHash?: string;
  mediaIpfsCid?: string;
  mediaType?: "image" | "video";
  mediaSizeBytes?: number;
};

type ExecutorInvoker = {
  executeWriteCreatePost(command: Command): Promise<unknown>;
  executeWriteCreateStory(command: Command): Promise<unknown>;
  resolveMediaUpload: (input: unknown) => Promise<MediaUploadResult>;
};

const createCommand = (overrides?: Partial<Command>): Command => ({
  id: `grant-consume-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  createdAt: new Date().toISOString(),
  kind: "write.createPost",
  grantId: "grant-post-consume",
  payload: {},
  sig: null,
  sourceDirectiveId: null,
  pendingDirectiveId: null,
  actionNonce: "action-nonce-grant-consume",
  challenge: null,
  forceNow: true,
  runtimeSessionId: null,
  runtimeOrigin: "manual",
  runtimeSig: null,
  ...(overrides ?? {}),
});

const createExecutor = (options?: {
  createPostMutate?: (input: unknown) => Promise<unknown>;
  createStoryMutate?: (input: unknown) => Promise<unknown>;
  grantManager?: GrantManagerStub | null;
  runOpenClawPrompt?: (input: {
    prompt: string;
    purpose: string;
  }) => Promise<{
    parsed: unknown;
    raw: string;
    agentName: string | null;
    payloadText: string | null;
    envelope: Record<string, unknown> | null;
  } | null>;
}) => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-command-executor-post-grants-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
    grantManager: options?.grantManager ?? null,
    stateDb: null,
    trpc: {
      agent: {
        ackDirective: { mutate: noopMutate },
        createPost: { mutate: options?.createPostMutate ?? noopMutate },
        createStory: { mutate: options?.createStoryMutate ?? noopMutate },
        commentPost: { mutate: noopMutate },
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
    runOpenClawPrompt: options?.runOpenClawPrompt ?? null,
  });
};

describe("command executor post grant consumption", () => {
  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
  });

  it("consumes the text-post grant after a successful text publish", async () => {
    const createPostMutate = vi.fn(async (input: unknown) => ({
      id: 101,
      ...(isRecord(input) ? input : {}),
    }));
    const consumeAction = vi.fn((actionKey: string): boolean => true);
    const runOpenClawPrompt = vi.fn(
      async (input: { prompt: string; purpose: string }) => {
        if (input.purpose === "post_draft_decision") {
          return {
            parsed: {
              focus: "post a small personal update",
              targetKind: "self",
              useTargetContext: false,
              includeTaggedHandles: [],
              reason: "use a fresh angle",
            },
            raw: "",
            agentName: null,
            payloadText: "",
            envelope: null,
          };
        }
        if (input.purpose === "post_draft_curation") {
          return {
            parsed: {
              caption: "Quiet reset",
              textBody: "Night air feels lighter now.",
            },
            raw: "",
            agentName: null,
            payloadText: "",
            envelope: null,
          };
        }
        return null;
      },
    );
    const executor = createExecutor({
      createPostMutate,
      grantManager: { consumeAction },
      runOpenClawPrompt,
    });
    const invoker = executor as unknown as ExecutorInvoker;

    const outcome = await invoker.executeWriteCreatePost(
      createCommand({
        sourceDirectiveId: "directive-grant-consume-text",
        runtimeOrigin: "director_directive",
        payload: {
          requestText: "Share a quick late-night mood.",
          postType: "text",
          kind: "post",
          textBody: "Seed text that should get curated.",
        },
      }),
    );

    expect(createPostMutate).toHaveBeenCalledTimes(1);
    expect(consumeAction).toHaveBeenCalledTimes(1);
    expect(consumeAction).toHaveBeenCalledWith("post:post:text");
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(true);
  });

  it("falls back to the credited post key when a media publish succeeds", async () => {
    const createPostMutate = vi.fn(async (input: unknown) => ({
      id: 202,
      ...(isRecord(input) ? input : {}),
    }));
    const consumeAction = vi.fn((actionKey: string): boolean => {
      return actionKey === "post:post:text";
    });
    const runOpenClawPrompt = vi.fn(
      async (input: { prompt: string; purpose: string }) => {
        if (input.purpose === "post_draft_decision") {
          return {
            parsed: {
              focus: "share a candid scene",
              targetKind: "scene",
              useTargetContext: false,
              includeTaggedHandles: [],
              reason: "pick a visual change of pace",
            },
            raw: "",
            agentName: null,
            payloadText: "",
            envelope: null,
          };
        }
        if (input.purpose === "post_draft_curation") {
          return {
            parsed: {
              caption: "Coffee break window seat",
              mediaPrompt: "cozy window seat portrait with scattered notebooks and warm morning light",
            },
            raw: "",
            agentName: null,
            payloadText: "",
            envelope: null,
          };
        }
        return null;
      },
    );
    const executor = createExecutor({
      createPostMutate,
      grantManager: { consumeAction },
      runOpenClawPrompt,
    });
    const invoker = executor as unknown as ExecutorInvoker;
    invoker.resolveMediaUpload = async (_input: unknown): Promise<MediaUploadResult> => ({
      mediaUrl: "https://cdn.example.com/generated/post-grant-media.png",
      mediaOriginalUrl: "https://cdn.example.com/generated/post-grant-media.png",
      mediaOptimizedUrl: "https://cdn.example.com/generated/post-grant-media.png",
      mediaType: "image",
      mediaSizeBytes: 2048,
    });

    const outcome = await invoker.executeWriteCreatePost(
      createCommand({
        sourceDirectiveId: "directive-grant-consume-media",
        runtimeOrigin: "director_directive",
        payload: {
          requestText: "Make a casual social post.",
          postType: "media",
          kind: "post",
          mediaPrompt: "sunlit cafe snapshot with a laptop and notes",
        },
      }),
    );

    expect(createPostMutate).toHaveBeenCalledTimes(1);
    expect(consumeAction.mock.calls.map(([actionKey]) => actionKey)).toEqual([
      "post:post:media",
      "post:post:text",
    ]);
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(true);
  });

  it("consumes the story grant after a successful story publish", async () => {
    const createStoryMutate = vi.fn(async (input: unknown) => ({
      id: 303,
      ...(isRecord(input) ? input : {}),
    }));
    const consumeAction = vi.fn((actionKey: string): boolean => true);
    const executor = createExecutor({
      createStoryMutate,
      grantManager: { consumeAction },
    });
    const invoker = executor as unknown as ExecutorInvoker;
    invoker.resolveMediaUpload = async (_input: unknown): Promise<MediaUploadResult> => ({
      mediaUrl: "https://cdn.example.com/generated/story-grant-media.png",
      mediaType: "image",
    });

    const outcome = await invoker.executeWriteCreateStory(
      createCommand({
        kind: "write.createStory",
        grantId: "grant-story-consume",
        payload: {
          caption: "Late-night check-in",
          mediaPrompt: "late-night city walk with soft neon reflections",
        },
      }),
    );

    expect(createStoryMutate).toHaveBeenCalledTimes(1);
    expect(consumeAction).toHaveBeenCalledTimes(1);
    expect(consumeAction).toHaveBeenCalledWith("story");
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(true);
  });
});
