import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { CommandExecutor } from "./command-executor.js";
import type { Command } from "../types/ipc.js";
import { isRecord } from "../lib/guards.js";
import type { StateSqliteStore } from "../state/sqlite-state.js";

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
  stateDb?: StateSqliteStore | null;
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
    stateDb: options?.stateDb ?? null,
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
    const literalPayload = (literalGenerateSpy.mock.calls[0] as unknown[] | undefined)?.[1];
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

  it("applies chat write gating to directive runtime items with chat source context", async () => {
    const createPostMutate = vi.fn(async () => ({
      post: { id: 777 },
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
        runtimeOrigin: "director_directive",
        payload: {
          sourceContext: "chat",
          goal: "chat",
          prompt: "my qnap giving me some issues but yeah getting the infra setup still",
          chatContext: {
            commandName: "agent-decide",
            commandArgs: [
              "my qnap giving me some issues but yeah getting the infra setup still",
            ],
            commandRawArgs:
              "my qnap giving me some issues but yeah getting the infra setup still",
            originalMessage:
              "my qnap giving me some issues but yeah getting the infra setup still",
            conversationId: "conv-policy",
          },
          drafts: [
            {
              action: "post",
              payload: {
                postType: "media",
                mediaPrompt: "A dark NAS rack room lit by one status LED.",
                caption: "infra night",
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

  it("blocks explicit chat write drafts when actor is not the owner", async () => {
    const createPostMutate = vi.fn(async () => ({
      post: { id: 778 },
    }));
    const executor = createExecutor({ createPostMutate });
    const invoker = executor as unknown as StoryPolicyInvoker;

    const outcome = await invoker.executeGenerateAndQueue(
      baseCommand({
        runtimeOrigin: "director_directive",
        payload: {
          sourceContext: "chat",
          goal: "chat",
          explicitPublishRequested: true,
          explicitPublishVerbDetected: true,
          requireExplicitPublishVerb: false,
          chatContext: {
            commandName: "post",
            commandArgs: ["post"],
            conversationId: "conv-policy",
            actorMainUserId: "main-user-outsider",
            ownerMainUserId: "main-user-owner",
          },
          drafts: [
            {
              action: "post",
              payload: {
                postType: "text",
                textBody: "Please publish this.",
              },
            },
          ],
        },
      }),
    );

    expect(createPostMutate).toHaveBeenCalledTimes(0);
    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(false);
    const error = isRecord(outcome.error) ? outcome.error : null;
    expect(error).not.toBeNull();
    if (!error) return;
    expect(error.code).toBe("chat_write_owner_only");
  });

  it("dedupes createpost retries by action nonce to prevent duplicate publishes", async () => {
    const createPostMutate = vi.fn(async () => ({
      post: { id: 779 },
    }));
    const runOpenClawPrompt = vi.fn(
      async (_input: { prompt: string; purpose: string }) => ({
        parsed: {
          caption: "Infra update",
          textBody: "Infrastructure progress update with concrete status details.",
        },
        payloadText: "",
        raw: "",
        agentName: null,
        envelope: null,
      }),
    );
    const stateDb = createLifecycleStateDbStub();
    const executor = createExecutor({
      createPostMutate,
      stateDb,
      runOpenClawPrompt,
    });
    const invoker = executor as unknown as StoryPolicyInvoker;
    const command = baseCommand({
      kind: "write.createPost",
      runtimeOrigin: "director_directive",
      actionNonce: "action-nonce-dedupe",
      payload: {
        sourceContext: "chat",
        postType: "text",
        textBody: "draft seed to curate before publish",
        sourceDirectiveId: "directive-dedupe-1",
        sourceDirectiveActionNonce: "action-nonce-dedupe",
        chatContext: {
          commandName: "post",
          commandArgs: ["post"],
          conversationId: "conv-policy",
          actorMainUserId: "main-user-owner",
          ownerMainUserId: "main-user-owner",
        },
      },
    });

    const first = await invoker.executeWriteCreatePost(command);
    const second = await invoker.executeWriteCreatePost(command);

    expect(createPostMutate).toHaveBeenCalledTimes(1);
    expect(isRecord(first)).toBe(true);
    if (isRecord(first)) {
      expect(first.ok).toBe(true);
    }
    expect(isRecord(second)).toBe(true);
    if (!isRecord(second)) return;
    expect(second.ok).toBe(true);
    const secondData = isRecord(second.data) ? second.data : null;
    expect(secondData).not.toBeNull();
    if (!secondData) return;
    expect(secondData.skipped).toBe(true);
    expect(secondData.decision).toBe("already_acked");
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
