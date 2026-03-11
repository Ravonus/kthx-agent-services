import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { CommandExecutor } from "./command-executor.js";
import type { Command } from "../types/ipc.js";
import { isRecord } from "../lib/guards.js";

const tempDirs: string[] = [];

const baseCommand = (): Command => ({
  id: "test-generate-input",
  createdAt: new Date().toISOString(),
  kind: "brain.generateAndQueue",
  grantId: null,
  payload: {},
  sig: null,
  sourceDirectiveId: "test-generate-input",
  pendingDirectiveId: null,
  actionNonce: "nonce-test-generate-input",
  challenge: null,
  forceNow: true,
  runtimeSessionId: null,
  runtimeOrigin: "director_directive",
  runtimeSig: null,
});

const chatCommand = (): Command => ({
  id: "test-generate-input-chat",
  createdAt: new Date().toISOString(),
  kind: "brain.generateAndQueue",
  grantId: null,
  payload: {},
  sig: null,
  sourceDirectiveId: null,
  pendingDirectiveId: null,
  actionNonce: null,
  challenge: null,
  forceNow: true,
  runtimeSessionId: null,
  runtimeOrigin: "chat_command",
  runtimeSig: null,
});

const directiveCommandWithoutSourceId = (): Command => ({
  id: "test-generate-input-directive-fallback",
  createdAt: new Date().toISOString(),
  kind: "brain.generateAndQueue",
  grantId: "directive:test-generate-input-directive-fallback",
  payload: {},
  sig: null,
  sourceDirectiveId: null,
  pendingDirectiveId: null,
  actionNonce: "nonce-test-generate-input-directive-fallback",
  challenge: null,
  forceNow: true,
  runtimeSessionId: null,
  runtimeOrigin: "director_directive",
  runtimeSig: null,
});

const createExecutor = (options?: {
  personaFrames?: unknown[];
  upsertPersonaMutate?: (input: unknown) => Promise<unknown>;
  listProfilePersonasQuery?: (input: unknown) => Promise<unknown>;
  callAgentChatBridge?: (payload: unknown) => Promise<unknown>;
}) => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-command-executor-generate-input-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
  const listPersonaFrames = async () => options?.personaFrames ?? [];
  const listProfilePersonas =
    options?.listProfilePersonasQuery ?? (async () => ({ mainPersonaSlug: null, items: [] }));

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
        votePost: { mutate: noopMutate },
        repostPost: { mutate: noopMutate },
        generate: { mutate: noopMutate },
        uploadDataUri: { mutate: noopMutate },
        uploadRemote: { mutate: noopMutate },
        listPersonas: { query: async () => [] },
        upsertPersona: { mutate: options?.upsertPersonaMutate ?? noopMutate },
        listPersonaFrames: { query: listPersonaFrames },
        upsertPersonaFrame: { mutate: noopMutate },
      },
      realtime: {
        ackDirective: { mutate: noopMutate },
      },
      user: {
        listProfilePersonas: { query: listProfilePersonas },
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
    callAgentChatBridge: options?.callAgentChatBridge ?? null,
    callAgentUploadChunk: null,
    runOpenClawPrompt: null,
  });
};

describe("command executor generate input", () => {
  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
  });


  it("suppresses creating missing non-main persona unless prompt explicitly requests new persona creation", async () => {
    const upsertPersonaMutate = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      upsertPersonaMutate,
      personaFrames: [
        {
          id: 201,
          personaSlug: "realistic_core",
          frameRole: "selfie",
          mediaUrl: "https://cdn.example.com/persona/main-selfie.jpg",
          optimizedUrl: "https://cdn.example.com/persona/main-selfie-opt.jpg",
          updatedAt: "2026-02-24T06:40:00.000Z",
        },
        {
          id: 202,
          personaSlug: "realistic_core",
          frameRole: "midshot",
          mediaUrl: "https://cdn.example.com/persona/main-midshot.jpg",
          optimizedUrl: "https://cdn.example.com/persona/main-midshot-opt.jpg",
          updatedAt: "2026-02-24T06:41:00.000Z",
        },
        {
          id: 203,
          personaSlug: "realistic_core",
          frameRole: "fullbody",
          mediaUrl: "https://cdn.example.com/persona/main-fullbody.jpg",
          optimizedUrl: "https://cdn.example.com/persona/main-fullbody-opt.jpg",
          updatedAt: "2026-02-24T06:42:00.000Z",
        },
      ],
    });
    const invoker = executor as unknown as {
      buildGenerateInputWithRuntimeContext(
        payload: Record<string, unknown>,
        command: Command,
      ): Promise<Record<string, unknown>>;
    };

    const result = await invoker.buildGenerateInputWithRuntimeContext(
      {
        goal: "media",
        mediaPersona: "rare_alt",
        mediaPersonaLock: true,
        mediaPrompt: "Moody rooftop portrait with rain reflections and city bokeh.",
      },
      baseCommand(),
    );

    expect(Array.isArray(result.mediaReferenceUrls)).toBe(true);
    if (!Array.isArray(result.mediaReferenceUrls)) return;
    expect(result.mediaReferenceUrls).toEqual([
      "https://cdn.example.com/persona/main-selfie-opt.jpg",
      "https://cdn.example.com/persona/main-midshot-opt.jpg",
      "https://cdn.example.com/persona/main-fullbody-opt.jpg",
    ]);
    expect(upsertPersonaMutate).toHaveBeenCalledTimes(0);
  });

  it("attempts creating a new non-main persona when prompt explicitly asks for new persona creation", async () => {
    const upsertPersonaMutate = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      upsertPersonaMutate,
      personaFrames: [
        {
          id: 301,
          personaSlug: "realistic_core",
          frameRole: "selfie",
          mediaUrl: "https://cdn.example.com/persona/main-selfie.jpg",
          optimizedUrl: "https://cdn.example.com/persona/main-selfie-opt.jpg",
          updatedAt: "2026-02-24T06:50:00.000Z",
        },
        {
          id: 302,
          personaSlug: "realistic_core",
          frameRole: "midshot",
          mediaUrl: "https://cdn.example.com/persona/main-midshot.jpg",
          optimizedUrl: "https://cdn.example.com/persona/main-midshot-opt.jpg",
          updatedAt: "2026-02-24T06:51:00.000Z",
        },
        {
          id: 303,
          personaSlug: "realistic_core",
          frameRole: "fullbody",
          mediaUrl: "https://cdn.example.com/persona/main-fullbody.jpg",
          optimizedUrl: "https://cdn.example.com/persona/main-fullbody-opt.jpg",
          updatedAt: "2026-02-24T06:52:00.000Z",
        },
      ],
    });
    const invoker = executor as unknown as {
      buildGenerateInputWithRuntimeContext(
        payload: Record<string, unknown>,
        command: Command,
      ): Promise<Record<string, unknown>>;
    };

    await invoker.buildGenerateInputWithRuntimeContext(
      {
        goal: "media",
        mediaPersona: "rare_alt",
        mediaPersonaLock: true,
        mediaPrompt:
          "Create a new persona first called rare_alt, then render a cinematic portrait.",
      },
      baseCommand(),
    );

    expect(upsertPersonaMutate).toHaveBeenCalledTimes(1);
  });

  it("prefers tagged agent persona frames over the local agent persona", async () => {
    const executor = createExecutor({
      personaFrames: [
        {
          id: 401,
          personaSlug: "realistic_core",
          frameRole: "selfie",
          mediaUrl: "https://cdn.example.com/persona/local-selfie.jpg",
          optimizedUrl: "https://cdn.example.com/persona/local-selfie-opt.jpg",
          updatedAt: "2026-02-24T07:00:00.000Z",
        },
        {
          id: 402,
          personaSlug: "realistic_core",
          frameRole: "midshot",
          mediaUrl: "https://cdn.example.com/persona/local-midshot.jpg",
          optimizedUrl: "https://cdn.example.com/persona/local-midshot-opt.jpg",
          updatedAt: "2026-02-24T07:01:00.000Z",
        },
        {
          id: 403,
          personaSlug: "realistic_core",
          frameRole: "fullbody",
          mediaUrl: "https://cdn.example.com/persona/local-fullbody.jpg",
          optimizedUrl: "https://cdn.example.com/persona/local-fullbody-opt.jpg",
          updatedAt: "2026-02-24T07:02:00.000Z",
        },
      ],
      listProfilePersonasQuery: async (input) => {
        expect(input).toEqual({ handle: "kael" });
        return {
          mainPersonaSlug: "realistic_core",
          items: [
            {
              slug: "realistic_core",
              frames: [
                {
                  id: 501,
                  frameRole: "selfie",
                  mediaUrl: "https://cdn.example.com/persona/kael-selfie.jpg",
                  optimizedUrl: "https://cdn.example.com/persona/kael-selfie-opt.jpg",
                  updatedAt: "2026-02-24T07:10:00.000Z",
                },
                {
                  id: 502,
                  frameRole: "midshot",
                  mediaUrl: "https://cdn.example.com/persona/kael-midshot.jpg",
                  optimizedUrl: "https://cdn.example.com/persona/kael-midshot-opt.jpg",
                  updatedAt: "2026-02-24T07:11:00.000Z",
                },
                {
                  id: 503,
                  frameRole: "fullbody",
                  mediaUrl: "https://cdn.example.com/persona/kael-fullbody.jpg",
                  optimizedUrl: "https://cdn.example.com/persona/kael-fullbody-opt.jpg",
                  updatedAt: "2026-02-24T07:12:00.000Z",
                },
              ],
            },
          ],
        };
      },
    });
    const invoker = executor as unknown as {
      buildGenerateInputWithRuntimeContext(
        payload: Record<string, unknown>,
        command: Command,
      ): Promise<Record<string, unknown>>;
    };

    const result = await invoker.buildGenerateInputWithRuntimeContext(
      {
        goal: "media",
        targetKind: "person",
        taggedHandles: ["@kael"],
        mediaPrompt: "Kael at a library table under warm reading lamps.",
      },
      baseCommand(),
    );

    expect(result.mediaReferenceUrls).toEqual([
      "https://cdn.example.com/persona/kael-selfie-opt.jpg",
      "https://cdn.example.com/persona/kael-midshot-opt.jpg",
      "https://cdn.example.com/persona/kael-fullbody-opt.jpg",
    ]);
  });

  it("suppresses local persona fallback when a tagged agent has no complete persona frames", async () => {
    const executor = createExecutor({
      personaFrames: [
        {
          id: 601,
          personaSlug: "realistic_core",
          frameRole: "selfie",
          mediaUrl: "https://cdn.example.com/persona/local-selfie.jpg",
          optimizedUrl: "https://cdn.example.com/persona/local-selfie-opt.jpg",
          updatedAt: "2026-02-24T07:20:00.000Z",
        },
        {
          id: 602,
          personaSlug: "realistic_core",
          frameRole: "midshot",
          mediaUrl: "https://cdn.example.com/persona/local-midshot.jpg",
          optimizedUrl: "https://cdn.example.com/persona/local-midshot-opt.jpg",
          updatedAt: "2026-02-24T07:21:00.000Z",
        },
        {
          id: 603,
          personaSlug: "realistic_core",
          frameRole: "fullbody",
          mediaUrl: "https://cdn.example.com/persona/local-fullbody.jpg",
          optimizedUrl: "https://cdn.example.com/persona/local-fullbody-opt.jpg",
          updatedAt: "2026-02-24T07:22:00.000Z",
        },
      ],
      listProfilePersonasQuery: async () => ({
        mainPersonaSlug: "realistic_core",
        items: [
          {
            slug: "realistic_core",
            frames: [
              {
                id: 701,
                frameRole: "selfie",
                mediaUrl: "https://cdn.example.com/persona/kael-selfie.jpg",
                optimizedUrl: "https://cdn.example.com/persona/kael-selfie-opt.jpg",
                updatedAt: "2026-02-24T07:30:00.000Z",
              },
            ],
          },
        ],
      }),
    });
    const invoker = executor as unknown as {
      buildGenerateInputWithRuntimeContext(
        payload: Record<string, unknown>,
        command: Command,
      ): Promise<Record<string, unknown>>;
    };

    const result = await invoker.buildGenerateInputWithRuntimeContext(
      {
        goal: "media",
        targetKind: "person",
        taggedHandles: ["kael"],
        mediaPrompt: "Kael opening a stack of mail in a hallway.",
      },
      baseCommand(),
    );

    expect(result.mediaReferenceUrls).toBeUndefined();
  });

  it("prefers a topic-matched external agent persona before falling back to main", async () => {
    const executor = createExecutor({
      listProfilePersonasQuery: async (input) => {
        expect(input).toEqual({ handle: "kael" });
        return {
          mainPersonaSlug: "realistic_core",
          items: [
            {
              slug: "realistic_core",
              labels: ["realistic_core", "persona_reference"],
              weight: 5,
              frames: [
                {
                  id: 741,
                  frameRole: "selfie",
                  mediaUrl: "https://cdn.example.com/persona/kael-main-selfie.jpg",
                  optimizedUrl: "https://cdn.example.com/persona/kael-main-selfie-opt.jpg",
                  updatedAt: "2026-02-24T07:50:00.000Z",
                },
                {
                  id: 742,
                  frameRole: "midshot",
                  mediaUrl: "https://cdn.example.com/persona/kael-main-midshot.jpg",
                  optimizedUrl: "https://cdn.example.com/persona/kael-main-midshot-opt.jpg",
                  updatedAt: "2026-02-24T07:51:00.000Z",
                },
                {
                  id: 743,
                  frameRole: "fullbody",
                  mediaUrl: "https://cdn.example.com/persona/kael-main-fullbody.jpg",
                  optimizedUrl: "https://cdn.example.com/persona/kael-main-fullbody-opt.jpg",
                  updatedAt: "2026-02-24T07:52:00.000Z",
                },
              ],
            },
            {
              slug: "trail_runner",
              labels: ["hiking", "outdoors", "trail"],
              weight: 7,
              frames: [
                {
                  id: 751,
                  frameRole: "selfie",
                  mediaUrl: "https://cdn.example.com/persona/kael-trail-selfie.jpg",
                  optimizedUrl: "https://cdn.example.com/persona/kael-trail-selfie-opt.jpg",
                  updatedAt: "2026-02-24T07:55:00.000Z",
                },
                {
                  id: 752,
                  frameRole: "midshot",
                  mediaUrl: "https://cdn.example.com/persona/kael-trail-midshot.jpg",
                  optimizedUrl: "https://cdn.example.com/persona/kael-trail-midshot-opt.jpg",
                  updatedAt: "2026-02-24T07:56:00.000Z",
                },
                {
                  id: 753,
                  frameRole: "fullbody",
                  mediaUrl: "https://cdn.example.com/persona/kael-trail-fullbody.jpg",
                  optimizedUrl: "https://cdn.example.com/persona/kael-trail-fullbody-opt.jpg",
                  updatedAt: "2026-02-24T07:57:00.000Z",
                },
              ],
            },
          ],
        };
      },
    });
    const invoker = executor as unknown as {
      buildGenerateInputWithRuntimeContext(
        payload: Record<string, unknown>,
        command: Command,
      ): Promise<Record<string, unknown>>;
    };

    const result = await invoker.buildGenerateInputWithRuntimeContext(
      {
        goal: "media",
        targetKind: "person",
        taggedHandles: ["kael"],
        tags: ["hiking", "outdoors"],
        mediaPrompt: "Kael hiking along a windy alpine trail at sunrise.",
      },
      baseCommand(),
    );

    expect(result.mediaReferenceUrls).toEqual([
      "https://cdn.example.com/persona/kael-trail-selfie-opt.jpg",
      "https://cdn.example.com/persona/kael-trail-midshot-opt.jpg",
      "https://cdn.example.com/persona/kael-trail-fullbody-opt.jpg",
    ]);
  });

  it("does not force external persona references for a scene prompt that only tags someone in text", async () => {
    const executor = createExecutor({
      listProfilePersonasQuery: async () => ({
        mainPersonaSlug: "realistic_core",
        items: [
          {
            slug: "realistic_core",
            frames: [
              {
                id: 771,
                frameRole: "selfie",
                mediaUrl: "https://cdn.example.com/persona/kael-selfie.jpg",
                optimizedUrl: "https://cdn.example.com/persona/kael-selfie-opt.jpg",
                updatedAt: "2026-02-24T08:20:00.000Z",
              },
            ],
          },
        ],
      }),
    });
    const invoker = executor as unknown as {
      buildGenerateInputWithRuntimeContext(
        payload: Record<string, unknown>,
        command: Command,
      ): Promise<Record<string, unknown>>;
    };

    const result = await invoker.buildGenerateInputWithRuntimeContext(
      {
        goal: "media",
        targetKind: "scene",
        taggedHandles: ["kael"],
        caption: "trail recap with @kael",
        mediaPrompt: "Fog moving through pine trees above a damp mountain trail.",
      },
      baseCommand(),
    );

    expect(result.mediaReferenceUrls).toBeUndefined();
  });

  it("resolves external persona frames from @handle mentions in the media prompt", async () => {
    const executor = createExecutor({
      personaFrames: [
        {
          id: 801,
          personaSlug: "realistic_core",
          frameRole: "selfie",
          mediaUrl: "https://cdn.example.com/persona/local-selfie.jpg",
          optimizedUrl: "https://cdn.example.com/persona/local-selfie-opt.jpg",
          updatedAt: "2026-02-24T08:00:00.000Z",
        },
        {
          id: 802,
          personaSlug: "realistic_core",
          frameRole: "midshot",
          mediaUrl: "https://cdn.example.com/persona/local-midshot.jpg",
          optimizedUrl: "https://cdn.example.com/persona/local-midshot-opt.jpg",
          updatedAt: "2026-02-24T08:01:00.000Z",
        },
        {
          id: 803,
          personaSlug: "realistic_core",
          frameRole: "fullbody",
          mediaUrl: "https://cdn.example.com/persona/local-fullbody.jpg",
          optimizedUrl: "https://cdn.example.com/persona/local-fullbody-opt.jpg",
          updatedAt: "2026-02-24T08:02:00.000Z",
        },
      ],
      listProfilePersonasQuery: async (input) => {
        expect(input).toEqual({ handle: "kael" });
        return {
          mainPersonaSlug: "realistic_core",
          items: [
            {
              slug: "realistic_core",
              frames: [
                {
                  id: 901,
                  frameRole: "selfie",
                  mediaUrl: "https://cdn.example.com/persona/kael-prompt-selfie.jpg",
                  optimizedUrl: "https://cdn.example.com/persona/kael-prompt-selfie-opt.jpg",
                  updatedAt: "2026-02-24T08:10:00.000Z",
                },
                {
                  id: 902,
                  frameRole: "midshot",
                  mediaUrl: "https://cdn.example.com/persona/kael-prompt-midshot.jpg",
                  optimizedUrl: "https://cdn.example.com/persona/kael-prompt-midshot-opt.jpg",
                  updatedAt: "2026-02-24T08:11:00.000Z",
                },
                {
                  id: 903,
                  frameRole: "fullbody",
                  mediaUrl: "https://cdn.example.com/persona/kael-prompt-fullbody.jpg",
                  optimizedUrl: "https://cdn.example.com/persona/kael-prompt-fullbody-opt.jpg",
                  updatedAt: "2026-02-24T08:12:00.000Z",
                },
              ],
            },
          ],
        };
      },
    });
    const invoker = executor as unknown as {
      buildGenerateInputWithRuntimeContext(
        payload: Record<string, unknown>,
        command: Command,
      ): Promise<Record<string, unknown>>;
    };

    const result = await invoker.buildGenerateInputWithRuntimeContext(
      {
        goal: "media",
        targetKind: "person",
        mediaPrompt: "@kael checking maps in a sunlit train station.",
      },
      baseCommand(),
    );

    expect(result.mediaReferenceUrls).toEqual([
      "https://cdn.example.com/persona/kael-prompt-selfie-opt.jpg",
      "https://cdn.example.com/persona/kael-prompt-midshot-opt.jpg",
      "https://cdn.example.com/persona/kael-prompt-fullbody-opt.jpg",
    ]);
  });

  it("uses the target post author handle when no explicit tagged handle is present", async () => {
    const callAgentChatBridge = vi.fn(async (payload: unknown) => {
      if (!isRecord(payload)) return null;
      if (payload.action === "find_post") {
        return {
          data: {
            id: 42,
            author: {
              handle: "kael",
            },
          },
        };
      }
      return null;
    });
    const executor = createExecutor({
      listProfilePersonasQuery: async (input) => {
        expect(input).toEqual({ handle: "kael" });
        return {
          mainPersonaSlug: "realistic_core",
          items: [
            {
              slug: "realistic_core",
              frames: [
                {
                  id: 801,
                  frameRole: "selfie",
                  mediaUrl: "https://cdn.example.com/persona/kael-post-selfie.jpg",
                  optimizedUrl: "https://cdn.example.com/persona/kael-post-selfie-opt.jpg",
                  updatedAt: "2026-02-24T07:40:00.000Z",
                },
                {
                  id: 802,
                  frameRole: "midshot",
                  mediaUrl: "https://cdn.example.com/persona/kael-post-midshot.jpg",
                  optimizedUrl: "https://cdn.example.com/persona/kael-post-midshot-opt.jpg",
                  updatedAt: "2026-02-24T07:41:00.000Z",
                },
                {
                  id: 803,
                  frameRole: "fullbody",
                  mediaUrl: "https://cdn.example.com/persona/kael-post-fullbody.jpg",
                  optimizedUrl: "https://cdn.example.com/persona/kael-post-fullbody-opt.jpg",
                  updatedAt: "2026-02-24T07:42:00.000Z",
                },
              ],
            },
          ],
        };
      },
      callAgentChatBridge,
    });
    const invoker = executor as unknown as {
      buildGenerateInputWithRuntimeContext(
        payload: Record<string, unknown>,
        command: Command,
      ): Promise<Record<string, unknown>>;
    };

    const result = await invoker.buildGenerateInputWithRuntimeContext(
      {
        goal: "media",
        targetKind: "person",
        postId: 42,
        mediaPrompt: "A candid shot of the post author in a narrow bookstore aisle.",
      },
      baseCommand(),
    );

    expect(callAgentChatBridge).toHaveBeenCalledWith({
      action: "find_post",
      postId: 42,
    });
    expect(result.mediaReferenceUrls).toEqual([
      "https://cdn.example.com/persona/kael-post-selfie-opt.jpg",
      "https://cdn.example.com/persona/kael-post-midshot-opt.jpg",
      "https://cdn.example.com/persona/kael-post-fullbody-opt.jpg",
    ]);
  });
});
