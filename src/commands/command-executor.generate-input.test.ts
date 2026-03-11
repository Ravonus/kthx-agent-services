import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { CommandExecutor } from "./command-executor.js";
import { buildPersonaLockedMediaFallbackDraft } from "./generate/generate-input.js";
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

describe("command executor generate input", () => {
  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
  });

  it("forwards visual generation context into agent.generate input", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as {
      buildGenerateInput(payload: Record<string, unknown>, command: Command): Record<string, unknown>;
    };

    const result = invoker.buildGenerateInput(
      {
        goal: "story",
        topic: "night market",
        mood: "electric",
        tags: ["night", "crew"],
        mediaLabels: ["selfie"],
        mediaMode: "group",
        mediaPersona: "streetwear creator",
        mediaPersonaStyleHint: "cinematic neon contrast",
        taggedHandles: ["@atlas.engine", "aurora.synth"],
        mediaReferenceUrls: [
          "https://cdn.example.com/reference-a.png",
          "https://cdn.example.com/reference-b.png",
        ],
        variationSeed: "seed-visual-1",
      },
      baseCommand(),
    );

    expect(result.kind).toBe("story");
    expect(result.mediaMode).toBe("group");
    expect(result.mediaPersona).toBe("streetwear creator");
    expect(result.mediaPersonaStyleHint).toBe("cinematic neon contrast");
    expect(result.variationSeed).toBe("seed-visual-1");
    expect(Array.isArray(result.tags)).toBe(true);
    if (Array.isArray(result.tags)) {
      expect(result.tags).toEqual(expect.arrayContaining(["night", "crew", "selfie"]));
    }
    expect(Array.isArray(result.taggedHandles)).toBe(true);
    if (Array.isArray(result.taggedHandles)) {
      expect(result.taggedHandles).toEqual(
        expect.arrayContaining(["atlas.engine", "aurora.synth"]),
      );
    }
    expect(Array.isArray(result.mediaReferenceUrls)).toBe(true);
    if (Array.isArray(result.mediaReferenceUrls)) {
      expect(result.mediaReferenceUrls).toEqual(
        expect.arrayContaining([
          "https://cdn.example.com/reference-a.png",
          "https://cdn.example.com/reference-b.png",
        ]),
      );
    }
  });

  it("falls back to payload context for topic, mood, and persona fields", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as {
      buildGenerateInput(payload: Record<string, unknown>, command: Command): Record<string, unknown>;
    };

    const result = invoker.buildGenerateInput(
      {
        goal: "story",
        context: {
          topic: "mountain sunrise",
          mood: "calm",
          mediaMode: "selfie",
          persona: "adventure traveler",
          personaStyleHint: "film grain and warm tones",
          mediaReferenceUrls: ["https://cdn.example.com/reference-c.png"],
        },
      },
      baseCommand(),
    );

    expect(result.topic).toBe("mountain sunrise");
    expect(result.mood).toBe("calm");
    expect(result.mediaMode).toBe("selfie");
    expect(result.mediaPersona).toBe("adventure traveler");
    expect(result.mediaPersonaStyleHint).toBe("film grain and warm tones");
    expect(Array.isArray(result.mediaReferenceUrls)).toBe(true);
    if (!Array.isArray(result.mediaReferenceUrls)) return;
    expect(result.mediaReferenceUrls).toEqual(
      expect.arrayContaining(["https://cdn.example.com/reference-c.png"]),
    );
    expect(isRecord(result)).toBe(true);
  });

  it("uses a stable variation seed for repeated retries of the same command", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as {
      buildGenerateInput(payload: Record<string, unknown>, command: Command): Record<string, unknown>;
    };
    const command = baseCommand();

    const first = invoker.buildGenerateInput(
      {
        goal: "media",
        topic: "quiet alley portrait",
      },
      command,
    );
    const second = invoker.buildGenerateInput(
      {
        goal: "media",
        topic: "quiet alley portrait",
      },
      command,
    );

    expect(first.variationSeed).toBe(second.variationSeed);
    expect(first.variationSeed).toBe("nonce-test-generate-input:media");
  });

  it("does not inject synthetic sourceDirectiveId for chat-origin generate input", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as {
      buildGenerateInput(payload: Record<string, unknown>, command: Command): Record<string, unknown>;
    };

    const result = invoker.buildGenerateInput(
      {
        goal: "media",
        prompt: "Create a reaction image for chat.",
      },
      chatCommand(),
    );

    expect("sourceDirectiveId" in result).toBe(false);
    expect("sourceDirectiveActionNonce" in result).toBe(false);
  });

  it("falls back to command id as sourceDirectiveId for directive runtime commands", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as {
      buildGenerateInput(payload: Record<string, unknown>, command: Command): Record<string, unknown>;
    };
    const command = directiveCommandWithoutSourceId();

    const result = invoker.buildGenerateInput(
      {
        goal: "media",
        prompt: "Create a directive-origin image.",
      },
      command,
    );

    expect(result.sourceDirectiveId).toBe(command.id);
    expect(result.sourceDirectiveActionNonce).toBe(command.actionNonce);
    expect(result.grantId).toBe(command.grantId);
  });

  it("overrides persona media references with tracked persona frames", async () => {
    const executor = createExecutor({
      personaFrames: [
        {
          id: 3,
          personaSlug: "realistic_core",
          frameRole: "fullbody",
          mediaUrl: "https://cdn.example.com/persona/fullbody.jpg",
          optimizedUrl: "https://cdn.example.com/persona/fullbody-opt.jpg",
          updatedAt: "2026-02-24T05:20:00.000Z",
        },
        {
          id: 1,
          personaSlug: "realistic_core",
          frameRole: "selfie",
          mediaUrl: "https://cdn.example.com/persona/selfie.jpg",
          optimizedUrl: "https://cdn.example.com/persona/selfie-opt.jpg",
          updatedAt: "2026-02-24T05:10:00.000Z",
        },
        {
          id: 2,
          personaSlug: "realistic_core",
          frameRole: "midshot",
          mediaUrl: "https://cdn.example.com/persona/midshot.jpg",
          optimizedUrl: "https://cdn.example.com/persona/midshot-opt.jpg",
          updatedAt: "2026-02-24T05:15:00.000Z",
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
        goal: "story",
        topic: "night city walk",
        mediaPersona: "realistic_core",
        mediaReferenceUrls: ["https://cdn.example.com/noise/unscoped-a.png"],
      },
      baseCommand(),
    );

    expect(Array.isArray(result.mediaReferenceUrls)).toBe(true);
    if (!Array.isArray(result.mediaReferenceUrls)) return;
    expect(result.mediaReferenceUrls).toEqual([
      "https://cdn.example.com/persona/selfie-opt.jpg",
      "https://cdn.example.com/persona/midshot-opt.jpg",
      "https://cdn.example.com/persona/fullbody-opt.jpg",
    ]);
  });

  it("accepts avif persona frame URLs without explicit mimeType", async () => {
    const executor = createExecutor({
      personaFrames: [
        {
          id: 501,
          personaSlug: "realistic_core",
          frameRole: "selfie",
          mediaUrl: "https://cdn.example.com/persona/selfie.avif",
          updatedAt: "2026-02-26T03:13:43.000Z",
        },
        {
          id: 502,
          personaSlug: "realistic_core",
          frameRole: "midshot",
          mediaUrl: "https://cdn.example.com/persona/midshot.avif",
          updatedAt: "2026-02-26T03:14:13.000Z",
        },
        {
          id: 503,
          personaSlug: "realistic_core",
          frameRole: "fullbody",
          mediaUrl: "https://cdn.example.com/persona/fullbody.avif",
          updatedAt: "2026-02-26T03:14:43.000Z",
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
        mediaPersona: "realistic_core",
        mediaPrompt: "Generate a realistic portrait with rain and city lights.",
      },
      baseCommand(),
    );

    expect(Array.isArray(result.mediaReferenceUrls)).toBe(true);
    if (!Array.isArray(result.mediaReferenceUrls)) return;
    expect(result.mediaReferenceUrls).toEqual([
      "https://cdn.example.com/persona/selfie.avif",
      "https://cdn.example.com/persona/midshot.avif",
      "https://cdn.example.com/persona/fullbody.avif",
    ]);
  });

  it("infers main persona references for selfie prompts when mediaPersona is generic", async () => {
    const executor = createExecutor({
      personaFrames: [
        {
          id: 11,
          personaSlug: "realistic_core",
          frameRole: "selfie",
          mediaUrl: "https://cdn.example.com/persona/main-selfie.jpg",
          optimizedUrl: "https://cdn.example.com/persona/main-selfie-opt.jpg",
          updatedAt: "2026-02-24T05:30:00.000Z",
        },
        {
          id: 12,
          personaSlug: "realistic_core",
          frameRole: "midshot",
          mediaUrl: "https://cdn.example.com/persona/main-midshot.jpg",
          optimizedUrl: "https://cdn.example.com/persona/main-midshot-opt.jpg",
          updatedAt: "2026-02-24T05:31:00.000Z",
        },
        {
          id: 13,
          personaSlug: "realistic_core",
          frameRole: "fullbody",
          mediaUrl: "https://cdn.example.com/persona/main-fullbody.jpg",
          optimizedUrl: "https://cdn.example.com/persona/main-fullbody-opt.jpg",
          updatedAt: "2026-02-24T05:32:00.000Z",
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
        mediaPersona: "default",
        mediaPrompt: "Create a selfie of yourself at sunset on a city rooftop.",
        mediaReferenceUrls: ["https://cdn.example.com/noise/temporary-ref.png"],
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
  });

  it("skips non-image persona frame artifacts and keeps valid persona frames", async () => {
    const executor = createExecutor({
      personaFrames: [
        {
          id: 41,
          personaSlug: "realistic_core",
          frameRole: "selfie",
          mediaUrl: "https://cdn.example.com/persona/selfie-latest.bin",
          optimizedUrl: "https://cdn.example.com/persona/selfie-latest.data",
          mimeType: "application/octet-stream",
          updatedAt: "2026-02-24T05:33:00.000Z",
        },
        {
          id: 40,
          personaSlug: "realistic_core",
          frameRole: "selfie",
          mediaUrl: "https://cdn.example.com/persona/selfie-stable.jpg",
          optimizedUrl: "https://cdn.example.com/persona/selfie-stable-opt.jpg",
          mimeType: "image/jpeg",
          updatedAt: "2026-02-24T05:30:00.000Z",
        },
        {
          id: 42,
          personaSlug: "realistic_core",
          frameRole: "midshot",
          mediaUrl: "https://cdn.example.com/persona/midshot-stable.jpg",
          optimizedUrl: "https://cdn.example.com/persona/midshot-stable-opt.jpg",
          mimeType: "image/jpeg",
          updatedAt: "2026-02-24T05:31:00.000Z",
        },
        {
          id: 43,
          personaSlug: "realistic_core",
          frameRole: "fullbody",
          mediaUrl: "https://cdn.example.com/persona/fullbody-stable.jpg",
          optimizedUrl: "https://cdn.example.com/persona/fullbody-stable-opt.jpg",
          mimeType: "image/jpeg",
          updatedAt: "2026-02-24T05:32:00.000Z",
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
        goal: "story",
        mediaPersona: "realistic_core",
        mediaPrompt: "Create a selfie with consistent identity.",
      },
      baseCommand(),
    );

    expect(Array.isArray(result.mediaReferenceUrls)).toBe(true);
    if (!Array.isArray(result.mediaReferenceUrls)) return;
    expect(result.mediaReferenceUrls).toEqual([
      "https://cdn.example.com/persona/selfie-stable-opt.jpg",
      "https://cdn.example.com/persona/midshot-stable-opt.jpg",
      "https://cdn.example.com/persona/fullbody-stable-opt.jpg",
    ]);
  });

  it("normalizes runtime auto provenance to AGENT_AUTONOMOUS", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as {
      buildGenerateInput(payload: Record<string, unknown>, command: Command): Record<string, unknown>;
    };

    const result = invoker.buildGenerateInput(
      {
        goal: "post",
        provenance: "runtime_auto_posting",
      },
      baseCommand(),
    );

    expect(result.provenance).toBe("AGENT_AUTONOMOUS");
  });

  it("forces media-only generate kinds when persona media lock is enabled", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as {
      buildGenerateInput(payload: Record<string, unknown>, command: Command): Record<string, unknown>;
    };

    const result = invoker.buildGenerateInput(
      {
        goal: "thread",
        topic: "quick update",
        mediaPersona: "selfie",
        mediaPersonaLock: true,
      },
      baseCommand(),
    );

    expect(result.kind).toBe("media");
    expect(result.mediaPersonaLock).toBe(true);
    expect(Array.isArray(result.kinds)).toBe(true);
    if (!Array.isArray(result.kinds)) return;
    expect(result.kinds).toEqual(["media"]);
  });

  it("rejects text-only post drafts from persona-locked execution", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as {
      isPersonaMediaCompatibleDraft(draft: {
        action: string;
        payload: Record<string, unknown>;
      }): boolean;
    };

    expect(
      invoker.isPersonaMediaCompatibleDraft({
        action: "post",
        payload: {
          caption: "shipping notes for today",
        },
      }),
    ).toBe(false);
    expect(
      invoker.isPersonaMediaCompatibleDraft({
        action: "post",
        payload: {
          postType: "media",
        },
      }),
    ).toBe(true);
    expect(
      invoker.isPersonaMediaCompatibleDraft({
        action: "post",
        payload: {
          generatedAssetType: "image",
        },
      }),
    ).toBe(true);
  });

  it("keeps persona fallback drafts scene-driven instead of forcing selfie mode", () => {
    const fallback = buildPersonaLockedMediaFallbackDraft({
      payload: {
        mediaPersonaLock: true,
        prompt: "Brass trumpet valves on a messy rehearsal table under tungsten light.",
      },
      drafts: [
        {
          action: "post",
          payload: {
            caption: "late rehearsal mess",
            textBody: "Brass trumpet valves on a messy rehearsal table under tungsten light.",
          },
        },
      ],
    });

    expect(fallback).not.toBeNull();
    if (!fallback || !isRecord(fallback.payload)) return;
    expect(fallback.payload.mediaPersonaLock).toBe(true);
    expect(fallback.payload.mediaMode).toBeUndefined();
    expect(fallback.payload.mediaPrompt).toBe(
      "Brass trumpet valves on a messy rehearsal table under tungsten light.",
    );
  });

  it("does not force persona references for generic chat literal persona locks", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as {
      resolvePersonaReferencePlan(
        payload: Record<string, unknown>,
        mainPersonaSlugRaw?: string | null,
        command?: Command | null,
      ): {
        enabled: boolean;
        source: string;
        targetPersonaSlug: string;
      };
    };

    const plan = invoker.resolvePersonaReferencePlan(
      {
        chatLiteralGenerate: true,
        mediaPersona: "default",
        mediaPersonaLock: true,
        mediaPrompt: "Generate a realistic creepy cat-dog hybrid.",
      },
      null,
      chatCommand(),
    );

    expect(plan.enabled).toBe(false);
    expect(plan.source).toBe("none");
  });

  it("does not infer a new variant persona unless prompt explicitly asks to create one", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as {
      resolvePersonaReferencePlan(
        payload: Record<string, unknown>,
        mainPersonaSlugRaw?: string | null,
        command?: Command | null,
      ): {
        enabled: boolean;
        source: string;
        targetPersonaSlug: string;
        allowNewPersonaCreation: boolean;
      };
    };

    const plan = invoker.resolvePersonaReferencePlan(
      {
        mediaPersona: "default",
        mediaPersonaLock: true,
        mediaPrompt: "Cinematic neon portrait in rainy streets.",
      },
      "realistic_core",
      baseCommand(),
    );

    expect(plan.enabled).toBe(true);
    expect(plan.targetPersonaSlug).toBe("realistic_core");
    expect(plan.allowNewPersonaCreation).toBe(false);
    expect(plan.source).not.toBe("inferred_variant");
  });

  it("allows inferred variant persona only when prompt explicitly asks to create a new persona", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as {
      resolvePersonaReferencePlan(
        payload: Record<string, unknown>,
        mainPersonaSlugRaw?: string | null,
        command?: Command | null,
      ): {
        enabled: boolean;
        source: string;
        targetPersonaSlug: string;
        allowNewPersonaCreation: boolean;
      };
    };

    const plan = invoker.resolvePersonaReferencePlan(
      {
        mediaPersona: "default",
        mediaPersonaLock: true,
        mediaPrompt: "Create a new persona first with cinematic neon styling.",
      },
      "realistic_core",
      baseCommand(),
    );

    expect(plan.enabled).toBe(true);
    expect(plan.targetPersonaSlug).toBe("realistic_core_cinematic");
    expect(plan.allowNewPersonaCreation).toBe(true);
    expect(plan.source).toBe("inferred_variant");
  });

  it("does not default non-autonomous write.createPost flows to persona references", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as {
      resolvePersonaReferencePlan(
        payload: Record<string, unknown>,
        mainPersonaSlugRaw?: string | null,
        command?: Command | null,
      ): {
        enabled: boolean;
        source: string;
        targetPersonaSlug: string;
      };
    };
    const writeCommand: Command = {
      ...baseCommand(),
      kind: "write.createPost",
    };

    const plan = invoker.resolvePersonaReferencePlan(
      {
        postType: "media",
        mediaPrompt: "Create a dramatic dragon render.",
        provenance: "SYSTEM_DIRECTIVE",
      },
      null,
      writeCommand,
    );

    expect(plan.enabled).toBe(false);
    expect(plan.source).toBe("none");
  });

  it("does not default autonomous media generation to persona frame references", async () => {
    const executor = createExecutor({
      personaFrames: [
        {
          id: 21,
          personaSlug: "realistic_core",
          frameRole: "selfie",
          mediaUrl: "https://cdn.example.com/persona/auto-selfie.jpg",
          optimizedUrl: "https://cdn.example.com/persona/auto-selfie-opt.jpg",
          updatedAt: "2026-02-24T06:10:00.000Z",
        },
        {
          id: 22,
          personaSlug: "realistic_core",
          frameRole: "midshot",
          mediaUrl: "https://cdn.example.com/persona/auto-midshot.jpg",
          optimizedUrl: "https://cdn.example.com/persona/auto-midshot-opt.jpg",
          updatedAt: "2026-02-24T06:11:00.000Z",
        },
        {
          id: 23,
          personaSlug: "realistic_core",
          frameRole: "fullbody",
          mediaUrl: "https://cdn.example.com/persona/auto-fullbody.jpg",
          optimizedUrl: "https://cdn.example.com/persona/auto-fullbody-opt.jpg",
          updatedAt: "2026-02-24T06:12:00.000Z",
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
        provenance: "runtime_auto_posting",
        mediaPrompt: "Street photo at dusk with ambient city lights.",
      },
      baseCommand(),
    );

    expect(result.mediaReferenceUrls).toBeUndefined();
  });

  it("defaults explicit selfie-mode autonomous media generation to persona frame references", async () => {
    const executor = createExecutor({
      personaFrames: [
        {
          id: 31,
          personaSlug: "realistic_core",
          frameRole: "selfie",
          mediaUrl: "https://cdn.example.com/persona/selfie-selfie.jpg",
          optimizedUrl: "https://cdn.example.com/persona/selfie-selfie-opt.jpg",
          updatedAt: "2026-02-24T07:10:00.000Z",
        },
        {
          id: 32,
          personaSlug: "realistic_core",
          frameRole: "midshot",
          mediaUrl: "https://cdn.example.com/persona/selfie-midshot.jpg",
          optimizedUrl: "https://cdn.example.com/persona/selfie-midshot-opt.jpg",
          updatedAt: "2026-02-24T07:11:00.000Z",
        },
        {
          id: 33,
          personaSlug: "realistic_core",
          frameRole: "fullbody",
          mediaUrl: "https://cdn.example.com/persona/selfie-fullbody.jpg",
          optimizedUrl: "https://cdn.example.com/persona/selfie-fullbody-opt.jpg",
          updatedAt: "2026-02-24T07:12:00.000Z",
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
        provenance: "runtime_auto_posting",
        mediaMode: "selfie",
        mediaPrompt: "A new candid mirror selfie before heading out.",
      },
      baseCommand(),
    );

    expect(Array.isArray(result.mediaReferenceUrls)).toBe(true);
    if (!Array.isArray(result.mediaReferenceUrls)) return;
    expect(result.mediaReferenceUrls).toEqual([
      "https://cdn.example.com/persona/selfie-selfie-opt.jpg",
      "https://cdn.example.com/persona/selfie-midshot-opt.jpg",
      "https://cdn.example.com/persona/selfie-fullbody-opt.jpg",
    ]);
  });

});
