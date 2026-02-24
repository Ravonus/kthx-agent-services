import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { CommandExecutor } from "./command-executor.js";
import type { Command } from "../types/ipc.js";
import { isRecord } from "../lib/guards.js";

const tempDirs: string[] = [];

const baseCommand = (
  overrides?: Partial<Command>,
): Command => ({
  id: "test-story-policy",
  createdAt: new Date().toISOString(),
  kind: "brain.generateAndQueue",
  grantId: null,
  payload: {},
  sig: null,
  sourceDirectiveId: "test-story-policy",
  pendingDirectiveId: null,
  actionNonce: null,
  challenge: null,
  forceNow: true,
  runtimeSessionId: null,
  runtimeOrigin: "director_directive",
  runtimeSig: null,
  ...(overrides ?? {}),
});

const createExecutor = (options?: {
  createStoryMutate?: (input: unknown) => Promise<unknown>;
  createPostMutate?: (input: unknown) => Promise<unknown>;
  generateMutate?: (input: unknown) => Promise<unknown>;
}) => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-command-executor-story-policy-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
        createPost: { mutate: options?.createPostMutate ?? noopMutate },
        createStory: { mutate: options?.createStoryMutate ?? noopMutate },
        commentPost: { mutate: noopMutate },
        updateAvatar: { mutate: noopMutate },
        updateBanner: { mutate: noopMutate },
        votePost: { mutate: noopMutate },
        repostPost: { mutate: noopMutate },
        generate: { mutate: options?.generateMutate ?? noopMutate },
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

type StoryPolicyInvoker = {
  executeGenerateAndQueue(command: Command): Promise<unknown>;
  executeWriteCreateStory(command: Command): Promise<unknown>;
  resolveMediaUpload: (input: unknown) => Promise<{
    mediaUrl: string;
    mediaOriginalUrl?: string;
    mediaOptimizedUrl?: string;
    mediaContentHash?: string;
    mediaIpfsCid?: string;
    mediaType?: "image" | "video";
    mediaSizeBytes?: number;
  }>;
};

describe("command executor story policy", () => {
  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
  });

  it("blocks chat-origin generate requests that explicitly ask for stories", async () => {
    const generateMutate = vi.fn(async () => ({
      items: [],
    }));
    const executor = createExecutor({ generateMutate });
    const invoker = executor as unknown as StoryPolicyInvoker;
    const outcome = await invoker.executeGenerateAndQueue(
      baseCommand({
        runtimeOrigin: "chat_command",
        payload: {
          sourceContext: "chat",
          goal: "story",
          generateKind: "story",
          chatContext: {
            commandName: "generate",
            commandArgs: ["story"],
            conversationId: "conv-policy",
          },
        },
      }),
    );

    expect(generateMutate).toHaveBeenCalledTimes(0);
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(false);
    const error = isRecord(outcome.error) ? outcome.error : null;
    expect(error).not.toBeNull();
    if (!error) return;
    expect(error.code).toBe("story_chat_disabled");
  });

  it("blocks chat-origin generate requests that ask for stories via plural aliases", async () => {
    const generateMutate = vi.fn(async () => ({
      items: [],
    }));
    const executor = createExecutor({ generateMutate });
    const invoker = executor as unknown as StoryPolicyInvoker;
    const outcome = await invoker.executeGenerateAndQueue(
      baseCommand({
        runtimeOrigin: "chat_command",
        payload: {
          sourceContext: "chat",
          chatContext: {
            commandName: "stories",
            commandArgs: ["stories"],
            conversationId: "conv-policy",
          },
        },
      }),
    );

    expect(generateMutate).toHaveBeenCalledTimes(0);
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(false);
    const error = isRecord(outcome.error) ? outcome.error : null;
    expect(error).not.toBeNull();
    if (!error) return;
    expect(error.code).toBe("story_chat_disabled");
  });

  it("blocks chat literal-generate flows when the request is story-oriented", async () => {
    const executor = createExecutor();
    const invoker = executor as unknown as StoryPolicyInvoker;
    const outcome = await invoker.executeGenerateAndQueue(
      baseCommand({
        runtimeOrigin: "chat_command",
        payload: {
          sourceContext: "chat",
          chatLiteralGenerate: true,
          prompt: "Generate a story post image",
          chatContext: {
            commandName: "story",
            commandArgs: ["story"],
            conversationId: "conv-policy",
          },
        },
      }),
    );

    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(false);
    const error = isRecord(outcome.error) ? outcome.error : null;
    expect(error).not.toBeNull();
    if (!error) return;
    expect(error.code).toBe("story_chat_disabled");
  });

  it("blocks direct chat-origin write.createStory commands", async () => {
    const createStoryMutate = vi.fn(async () => ({
      story: { id: 42 },
    }));
    const executor = createExecutor({ createStoryMutate });
    const invoker = executor as unknown as StoryPolicyInvoker;
    const outcome = await invoker.executeWriteCreateStory(
      baseCommand({
        kind: "write.createStory",
        runtimeOrigin: "chat_command",
        payload: {
          sourceContext: "chat",
          mediaPrompt: "Make a cool story image",
          chatContext: {
            commandName: "story",
            commandArgs: ["story"],
            conversationId: "conv-policy",
          },
        },
      }),
    );

    expect(createStoryMutate).toHaveBeenCalledTimes(0);
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(false);
    const error = isRecord(outcome.error) ? outcome.error : null;
    expect(error).not.toBeNull();
    if (!error) return;
    expect(error.code).toBe("story_chat_disabled");
  });

  it("strips carryover media fields and generates fresh media for directive stories", async () => {
    const createStoryMutate = vi.fn(async (input: unknown) => ({
      story: {
        id: 91,
        input,
      },
    }));
    const executor = createExecutor({ createStoryMutate });
    const invoker = executor as unknown as StoryPolicyInvoker;
    let capturedResolveInput: unknown = null;
    invoker.resolveMediaUpload = vi.fn(async (input: unknown) => {
      capturedResolveInput = input;
      return {
        mediaUrl: "https://cdn.example.com/generated/new-story.png",
        mediaOriginalUrl: "https://cdn.example.com/generated/new-story-original.png",
        mediaOptimizedUrl: "https://cdn.example.com/generated/new-story.png",
        mediaType: "image",
        mediaSizeBytes: 2048,
      };
    }) as StoryPolicyInvoker["resolveMediaUpload"];

    const outcome = await invoker.executeWriteCreateStory(
      baseCommand({
        kind: "write.createStory",
        runtimeOrigin: "director_directive",
        payload: {
          sourceDirectiveId: "directive-1",
          mediaPrompt: "A sunrise city skyline with candid social energy",
          caption: "Morning check-in",
          mediaUrl: "https://cdn.example.com/chat/generated-user-image.png",
          mediaItems: [
            { mediaUrl: "https://cdn.example.com/chat/generated-user-image.png" },
          ],
          recentGeneratedAsset: {
            type: "image",
            href: "https://cdn.example.com/chat/generated-user-image.png",
            summary: "user-requested sticker",
          },
        },
      }),
    );

    expect(isRecord(capturedResolveInput)).toBe(true);
    if (!isRecord(capturedResolveInput)) return;
    const sanitizedPayload = isRecord(capturedResolveInput.payload)
      ? capturedResolveInput.payload
      : null;
    expect(sanitizedPayload).not.toBeNull();
    if (!sanitizedPayload) return;
    expect(sanitizedPayload.mediaUrl).toBeUndefined();
    expect(sanitizedPayload.mediaItems).toBeUndefined();
    expect(sanitizedPayload.recentGeneratedAsset).toBeUndefined();

    expect(createStoryMutate).toHaveBeenCalledTimes(1);
    const createStoryInput = createStoryMutate.mock.calls[0]?.[0];
    expect(isRecord(createStoryInput)).toBe(true);
    if (isRecord(createStoryInput)) {
      expect(createStoryInput.mediaUrl).toBe("https://cdn.example.com/generated/new-story.png");
    }

    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(true);
  });

  it("allows directive-origin story writes even when chat metadata is attached", async () => {
    const createStoryMutate = vi.fn(async () => ({
      story: { id: 55 },
    }));
    const executor = createExecutor({ createStoryMutate });
    const invoker = executor as unknown as StoryPolicyInvoker;
    invoker.resolveMediaUpload = vi.fn(async () => ({
      mediaUrl: "https://cdn.example.com/generated/story-directive.png",
      mediaOriginalUrl: "https://cdn.example.com/generated/story-directive-original.png",
      mediaOptimizedUrl: "https://cdn.example.com/generated/story-directive.png",
      mediaType: "image",
      mediaSizeBytes: 4096,
    })) as StoryPolicyInvoker["resolveMediaUpload"];

    const outcome = await invoker.executeWriteCreateStory(
      baseCommand({
        kind: "write.createStory",
        runtimeOrigin: "director_directive",
        payload: {
          sourceContext: "chat",
          chatContext: {
            commandName: "story",
            commandArgs: ["story"],
            conversationId: "conv-policy",
          },
          mediaPrompt: "Directive-owned story generation",
        },
      }),
    );

    expect(createStoryMutate).toHaveBeenCalledTimes(1);
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(true);
  });

  it("does not default chat goal payloads to story generation", async () => {
    let capturedGenerateInput: unknown = null;
    const generateMutate = vi.fn(async (input: unknown) => {
      capturedGenerateInput = input;
      return {
      items: [
        {
          drafts: [
            {
              action: "post",
              payload: {
                postType: "text",
                textBody: "Chat request acknowledged.",
              },
            },
          ],
        },
      ],
      };
    });
    const executor = createExecutor({ generateMutate });
    const invoker = executor as unknown as StoryPolicyInvoker;
    const outcome = await invoker.executeGenerateAndQueue(
      baseCommand({
        runtimeOrigin: "chat_command",
        payload: {
          sourceContext: "chat",
          goal: "chat",
          chatContext: {
            commandName: "agent-decide",
            commandArgs: ["why"],
            conversationId: "conv-policy",
          },
        },
      }),
    );

    expect(generateMutate).toHaveBeenCalledTimes(1);
    const generateInput = capturedGenerateInput;
    expect(isRecord(generateInput)).toBe(true);
    if (isRecord(generateInput)) {
      expect(generateInput.kind).toBe("media");
      const kinds: unknown[] = Array.isArray(generateInput.kinds)
        ? (generateInput.kinds as unknown[])
        : [];
      expect(kinds).not.toContain("story");
    }
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    const error = isRecord(outcome.error) ? outcome.error : null;
    expect(error?.code).not.toBe("story_chat_disabled");
  });
});
