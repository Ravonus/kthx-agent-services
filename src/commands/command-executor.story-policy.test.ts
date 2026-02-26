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

type StoryPolicyInvoker = {
  executeGenerateAndQueue(command: Command): Promise<unknown>;
  executeWriteCreateStory(command: Command): Promise<unknown>;
  executeWriteCreatePost(command: Command): Promise<unknown>;
  executeChatLiteralGenerate(
    command: Command,
    payload: Record<string, unknown>,
  ): Promise<unknown>;
  resolveMediaUpload: (input: unknown) => Promise<{
    mediaUrl: string;
    mediaOriginalUrl?: string;
    mediaOptimizedUrl?: string;
    mediaContentHash?: string;
    mediaIpfsCid?: string;
    mediaType?: "image" | "video";
    mediaSizeBytes?: number;
  }>;
  buildGenerateInputWithRuntimeContext: (
    payload: Record<string, unknown>,
    command: Command,
  ) => Promise<Record<string, unknown>>;
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

  it("blocks agent-decide chat requests when the user explicitly asks to make a story", async () => {
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
          goal: "chat",
          chatContext: {
            commandName: "agent-decide",
            commandArgs: ["make me a story about tonight"],
            commandRawArgs: "make me a story about tonight",
            originalMessage: "make me a story about tonight",
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

  it("redirects non-explicit chat-origin story writes to chat literal generation", async () => {
    const createStoryMutate = vi.fn(async () => ({
      story: { id: 42 },
    }));
    const executor = createExecutor({ createStoryMutate });
    const invoker = executor as unknown as StoryPolicyInvoker;
    const literalGenerateSpy = vi.fn(async () => ({
      at: new Date().toISOString(),
      commandId: "test-story-policy",
      kind: "write.createStory",
      grantId: null,
      ok: true,
      data: {
        mode: "chat_literal_generate",
      },
    }));
    invoker.executeChatLiteralGenerate = literalGenerateSpy;

    const outcome = await invoker.executeWriteCreateStory(
      baseCommand({
        kind: "write.createStory",
        runtimeOrigin: "chat_command",
        payload: {
          sourceContext: "chat",
          mediaPrompt: "refresh this with a transparent background",
          chatContext: {
            commandName: "agent-decide",
            commandArgs: ["send the updated sticker to chat"],
            commandRawArgs: "send the updated sticker to chat",
            originalMessage: "send the updated sticker to chat",
            conversationId: "conv-policy",
          },
        },
      }),
    );

    expect(createStoryMutate).toHaveBeenCalledTimes(0);
    expect(literalGenerateSpy).toHaveBeenCalledTimes(1);
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(true);
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

  it("strips persona carryover media fields and generates fresh media for posts", async () => {
    const createPostMutate = vi.fn(async (input: unknown) => ({
      post: {
        id: 109,
        input,
      },
    }));
    const runOpenClawPrompt = vi.fn(
      async (_input: { prompt: string; purpose: string }) => ({
        parsed: {
          caption: "Stormlight portrait",
          mediaPrompt:
            "Muted stormlight portrait on a wet rooftop, reflective puddles, distant skyline bokeh",
        },
        payloadText: "",
        raw: "",
        agentName: null,
        envelope: null,
      }),
    );
    const executor = createExecutor({ createPostMutate, runOpenClawPrompt });
    const invoker = executor as unknown as StoryPolicyInvoker;
    const capturedResolveInputs: unknown[] = [];
    let resolvedCount = 0;
    invoker.resolveMediaUpload = vi.fn(async (input: unknown) => {
      capturedResolveInputs.push(input);
      resolvedCount += 1;
      return {
        mediaUrl: `https://cdn.example.com/generated/new-post-${resolvedCount}.png`,
        mediaOriginalUrl: `https://cdn.example.com/generated/new-post-${resolvedCount}-original.png`,
        mediaOptimizedUrl: `https://cdn.example.com/generated/new-post-${resolvedCount}.png`,
        mediaType: "image",
        mediaSizeBytes: 4096 + resolvedCount,
      };
    }) as StoryPolicyInvoker["resolveMediaUpload"];

    const stalePersonaUrl = "https://cdn.example.com/persona/selfie-existing.png";
    const outcome = await invoker.executeWriteCreatePost(
      baseCommand({
        kind: "write.createPost",
        sourceDirectiveId: null,
        runtimeOrigin: "chat_command",
        payload: {
          postType: "media",
          mediaPrompt: "Dramatic portrait in a rainy neon alley with cinematic tension",
          mediaPersona: "realistic_core",
          mediaPersonaLock: true,
          mediaUrl: stalePersonaUrl,
          mediaItems: [{ mediaUrl: stalePersonaUrl }],
          recentGeneratedAsset: {
            type: "persona",
            href: stalePersonaUrl,
            summary: "existing persona frame",
          },
        },
      }),
    );

    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(true);

    expect(capturedResolveInputs.length).toBeGreaterThan(0);
    for (const capturedInput of capturedResolveInputs) {
      expect(isRecord(capturedInput)).toBe(true);
      if (!isRecord(capturedInput)) continue;
      const sanitizedPayload = isRecord(capturedInput.payload)
        ? capturedInput.payload
        : null;
      expect(sanitizedPayload).not.toBeNull();
      if (!sanitizedPayload) continue;
      expect(sanitizedPayload.mediaUrl).toBeUndefined();
      expect(sanitizedPayload.mediaItems).toBeUndefined();
      expect(sanitizedPayload.recentGeneratedAsset).toBeUndefined();
    }

    expect(createPostMutate).toHaveBeenCalledTimes(1);
    const createPostInput = createPostMutate.mock.calls[0]?.[0];
    expect(isRecord(createPostInput)).toBe(true);
    if (isRecord(createPostInput)) {
      expect(createPostInput.mediaUrl).not.toBe(stalePersonaUrl);
    }
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
    let outcome: unknown = null;
    try {
      outcome = await invoker.executeGenerateAndQueue(
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
    } catch {
      // RequeueCommandError from draft execution is acceptable here — the
      // test only cares about the generate input, not the write outcome.
    }

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
    if (isRecord(outcome)) {
      const error = isRecord(outcome.error) ? outcome.error : null;
      expect(error?.code).not.toBe("story_chat_disabled");
    }
  });

  it("does not block agent-decide chat requests when planner payload drifts to story", async () => {
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
                  textBody: "Handled as a normal chat request.",
                },
              },
            ],
          },
        ],
      };
    });
    const executor = createExecutor({ generateMutate });
    const invoker = executor as unknown as StoryPolicyInvoker;
    let outcome: unknown = null;
    try {
      outcome = await invoker.executeGenerateAndQueue(
        baseCommand({
          runtimeOrigin: "chat_command",
          payload: {
            sourceContext: "chat",
            goal: "story",
            generateKind: "story",
            chatContext: {
              commandName: "agent-decide",
              commandArgs: ["bafkreifdi4aeaodix7qoxu6vcngb76w"],
              commandRawArgs: "bafkreifdi4aeaodix7qoxu6vcngb76w",
              originalMessage: "bafkreifdi4aeaodix7qoxu6vcngb76w",
              conversationId: "conv-policy",
            },
          },
        }),
      );
    } catch {
      // RequeueCommandError from draft execution is acceptable here.
    }

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
    if (isRecord(outcome)) {
      const error = isRecord(outcome.error) ? outcome.error : null;
      expect(error?.code).not.toBe("story_chat_disabled");
    }
  });

  it("does not treat story words in internal prompt fields as explicit chat story requests", async () => {
    const generateMutate = vi.fn(async () => ({
      items: [
        {
          drafts: [
            {
              action: "post",
              payload: {
                postType: "text",
                textBody: "Handled as normal chat follow-up.",
              },
            },
          ],
        },
      ],
    }));
    const executor = createExecutor({ generateMutate });
    const invoker = executor as unknown as StoryPolicyInvoker;
    let outcome: unknown = null;
    try {
      outcome = await invoker.executeGenerateAndQueue(
        baseCommand({
          runtimeOrigin: "chat_command",
          payload: {
            sourceContext: "chat",
            goal: "chat",
            prompt: "internal story planning field",
            instruction: "internal story planning field",
            topic: "internal story planning field",
            chatContext: {
              commandName: "agent-decide",
              commandArgs: ["send the latest sticker with no background"],
              commandRawArgs: "send the latest sticker with no background",
              originalMessage: "send the latest sticker with no background",
              conversationId: "conv-policy",
            },
          },
        }),
      );
    } catch {
      // RequeueCommandError from draft execution is acceptable here.
    }

    expect(generateMutate).toHaveBeenCalledTimes(1);
    if (isRecord(outcome)) {
      const error = isRecord(outcome.error) ? outcome.error : null;
      expect(error?.code).not.toBe("story_chat_disabled");
    }
  });

  it("redirects non-explicit chat media drafts to literal generation instead of posting", async () => {
    const createPostMutate = vi.fn(async () => ({
      post: { id: 101 },
    }));
    const executor = createExecutor({ createPostMutate });
    const invoker = executor as unknown as StoryPolicyInvoker;
    const literalGenerateSpy = vi.fn(async () => ({
      at: new Date().toISOString(),
      commandId: "test-story-policy",
      kind: "brain.generateAndQueue",
      grantId: null,
      ok: true,
      data: {
        mode: "chat_literal_generate",
      },
    }));
    invoker.executeChatLiteralGenerate = literalGenerateSpy;

    const outcome = await invoker.executeGenerateAndQueue(
      baseCommand({
        runtimeOrigin: "chat_command",
        payload: {
          sourceContext: "chat",
          goal: "chat",
          prompt: "generare a cat dog but make it realism and a bit creepy",
          chatContext: {
            commandName: "agent-decide",
            commandArgs: ["generare a cat dog but make it realism and a bit creepy"],
            commandRawArgs: "generare a cat dog but make it realism and a bit creepy",
            originalMessage: "generare a cat dog but make it realism and a bit creepy",
            conversationId: "conv-policy",
          },
          drafts: [
            {
              action: "post",
              payload: {
                postType: "media",
                mediaPrompt: "realistic creepy cat-dog hybrid portrait",
                caption: "cat-dog study",
              },
            },
          ],
        },
      }),
    );

    expect(createPostMutate).toHaveBeenCalledTimes(0);
    expect(literalGenerateSpy).toHaveBeenCalledTimes(1);
    const literalPayload = literalGenerateSpy.mock.calls[0]?.[1];
    expect(isRecord(literalPayload)).toBe(true);
    if (isRecord(literalPayload)) {
      expect(literalPayload.chatLiteralGenerate).toBe(true);
      expect(literalPayload.goal).toBe("media");
      expect(literalPayload.mediaPrompt).toBe("realistic creepy cat-dog hybrid portrait");
    }
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(true);
  });

  it("does not execute non-explicit chat write drafts", async () => {
    const createPostMutate = vi.fn(async () => ({
      post: { id: 102 },
    }));
    const executor = createExecutor({ createPostMutate });
    const invoker = executor as unknown as StoryPolicyInvoker;
    const literalGenerateSpy = vi.fn(async () => ({
      at: new Date().toISOString(),
      commandId: "test-story-policy",
      kind: "brain.generateAndQueue",
      grantId: null,
      ok: true,
      data: {
        mode: "chat_literal_generate",
      },
    }));
    invoker.executeChatLiteralGenerate = literalGenerateSpy;

    const outcome = await invoker.executeGenerateAndQueue(
      baseCommand({
        runtimeOrigin: "chat_command",
        payload: {
          sourceContext: "chat",
          goal: "chat",
          prompt: "brainstorm three options",
          chatContext: {
            commandName: "agent-decide",
            commandArgs: ["brainstorm three options"],
            commandRawArgs: "brainstorm three options",
            originalMessage: "brainstorm three options",
            conversationId: "conv-policy",
          },
          drafts: [
            {
              action: "comment",
              payload: {
                postId: 101,
                body: "Option A: keep it concise.",
              },
            },
          ],
        },
      }),
    );

    expect(createPostMutate).toHaveBeenCalledTimes(0);
    expect(literalGenerateSpy).toHaveBeenCalledTimes(1);
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(true);
  });

  it("requeues directive generation when persona setup prerequisites are incomplete", async () => {
    const generateMutate = vi.fn(async () => ({
      items: [],
    }));
    const executor = createExecutor({ generateMutate });
    const invoker = executor as unknown as StoryPolicyInvoker;
    invoker.buildGenerateInputWithRuntimeContext = vi.fn(async () => {
      throw new Error("persona_reference_setup_required:realistic_core");
    }) as StoryPolicyInvoker["buildGenerateInputWithRuntimeContext"];

    await expect(
      invoker.executeGenerateAndQueue(
        baseCommand({
          runtimeOrigin: "director_directive",
          payload: {
            goal: "media",
            mediaPrompt: "Create a chained dragon scene.",
            mediaPersona: "realistic_core",
          },
        }),
      ),
    ).rejects.toThrow(/persona_reference_setup_required:realistic_core/iu);
    expect(generateMutate).toHaveBeenCalledTimes(0);
  });
});
