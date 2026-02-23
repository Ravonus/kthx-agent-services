import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

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

const createExecutor = () => {
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
});
