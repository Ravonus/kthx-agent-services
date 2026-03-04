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
});
