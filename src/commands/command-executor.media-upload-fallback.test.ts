import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { CommandExecutor } from "./command-executor.js";
import type { Command } from "../types/ipc.js";
import { isRecord } from "../lib/guards.js";

const tempDirs: string[] = [];

type ResolvedMediaUpload = {
  mediaUrl: string;
  mediaOriginalUrl: string;
  mediaOptimizedUrl: string;
  mediaType?: "image" | "video";
  mediaContentHash?: string;
  mediaIpfsCid?: string;
  mediaSizeBytes?: number;
};

type CommandExecutorInvoker = {
  resolveMediaUpload(input: {
    payload: Record<string, unknown>;
    keepOriginal?: boolean;
    promptFallbacks: Array<string | null>;
    command?: Command;
  }): Promise<ResolvedMediaUpload>;
  uploadResolvedMediaSource(
    source: string,
    options?: { keepOriginal?: boolean },
  ): Promise<ResolvedMediaUpload>;
  generateAndUploadMediaFromPrompt(
    prompt: string,
    options: unknown,
  ): Promise<ResolvedMediaUpload>;
};

const baseCommand = (): Command => ({
  id: "test-media-upload-fallback",
  createdAt: new Date().toISOString(),
  kind: "write.createPost",
  grantId: null,
  payload: {},
  sig: null,
  sourceDirectiveId: "test-media-upload-fallback",
  pendingDirectiveId: null,
  actionNonce: "nonce-media-upload-fallback",
  challenge: null,
  forceNow: true,
  runtimeSessionId: null,
  runtimeOrigin: "director_directive",
  runtimeSig: null,
});

const createExecutor = () => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-command-executor-media-fallback-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
  const uploadRemoteMutate = vi.fn(
    async (_input: Record<string, unknown>): Promise<unknown> => ({ ok: true }),
  );
  const uploadDataUriMutate = vi.fn(
    async (_input: Record<string, unknown>): Promise<unknown> => ({ ok: true }),
  );

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
        createPost: { mutate: noopMutate },
        createStory: { mutate: noopMutate },
        commentPost: { mutate: noopMutate },
        updateAvatar: { mutate: noopMutate },
        updateBanner: { mutate: noopMutate },
        votePost: { mutate: noopMutate },
        repostPost: { mutate: noopMutate },
        generate: { mutate: noopMutate },
        uploadDataUri: { mutate: uploadDataUriMutate },
        uploadRemote: { mutate: uploadRemoteMutate },
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

  return { executor, uploadRemoteMutate, uploadDataUriMutate };
};

describe("command executor media upload fallback", () => {
  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
  });

  it("skips non-media URL candidates and falls back to prompt generation", async () => {
    const { executor, uploadRemoteMutate, uploadDataUriMutate } = createExecutor();
    const invoker = executor as unknown as CommandExecutorInvoker;
    const generated: ResolvedMediaUpload = {
      mediaUrl: "https://cdn.example.com/generated/final.png",
      mediaOriginalUrl: "https://cdn.example.com/generated/final.png",
      mediaOptimizedUrl: "https://cdn.example.com/generated/final.png",
      mediaType: "image",
      mediaSizeBytes: 2048,
    };
    const generateAndUploadMediaFromPrompt = vi.fn(async () => generated);
    invoker.generateAndUploadMediaFromPrompt =
      generateAndUploadMediaFromPrompt as CommandExecutorInvoker["generateAndUploadMediaFromPrompt"];

    const result = await invoker.resolveMediaUpload({
      payload: {
        mediaUrl: "https://cdn.example.com/generated/artifact.json",
      },
      promptFallbacks: ["create a cat sticker"],
    });

    expect(result.mediaUrl).toBe(generated.mediaUrl);
    expect(generateAndUploadMediaFromPrompt).toHaveBeenCalledTimes(1);
    expect(uploadRemoteMutate).not.toHaveBeenCalled();
    expect(uploadDataUriMutate).not.toHaveBeenCalled();
  });

  it("skips non-media local files and falls back to prompt generation", async () => {
    const { executor, uploadRemoteMutate, uploadDataUriMutate } = createExecutor();
    const invoker = executor as unknown as CommandExecutorInvoker;
    const generated: ResolvedMediaUpload = {
      mediaUrl: "https://cdn.example.com/generated/final-local.png",
      mediaOriginalUrl: "https://cdn.example.com/generated/final-local.png",
      mediaOptimizedUrl: "https://cdn.example.com/generated/final-local.png",
      mediaType: "image",
      mediaSizeBytes: 4096,
    };
    const generateAndUploadMediaFromPrompt = vi.fn(async () => generated);
    invoker.generateAndUploadMediaFromPrompt =
      generateAndUploadMediaFromPrompt as CommandExecutorInvoker["generateAndUploadMediaFromPrompt"];

    const localFilePath = path.join(
      tempDirs[tempDirs.length - 1] ?? process.cwd(),
      "not-media.txt",
    );
    await fs.mkdir(path.dirname(localFilePath), { recursive: true });
    await fs.writeFile(localFilePath, "this is not media", "utf8");

    const result = await invoker.resolveMediaUpload({
      payload: {
        mediaUrl: localFilePath,
      },
      promptFallbacks: ["create a sunset photo"],
    });

    expect(result.mediaUrl).toBe(generated.mediaUrl);
    expect(generateAndUploadMediaFromPrompt).toHaveBeenCalledTimes(1);
    expect(uploadRemoteMutate).not.toHaveBeenCalled();
    expect(uploadDataUriMutate).not.toHaveBeenCalled();
  });

  it("normalizes data-uri mime from sniffed bytes before uploadDataUri mutate", async () => {
    const { executor, uploadDataUriMutate } = createExecutor();
    const invoker = executor as unknown as CommandExecutorInvoker;
    uploadDataUriMutate.mockResolvedValueOnce({
      url: "https://cdn.example.com/uploads/normalized.png",
      originalUrl: "https://cdn.example.com/uploads/normalized.png",
      optimizedUrl: "https://cdn.example.com/uploads/normalized.png",
      mediaType: "image",
    });
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+QboAAAAASUVORK5CYII=";
    const mismatchedDataUri = `data:text/plain;base64,${pngBase64}`;

    const result = await invoker.uploadResolvedMediaSource(mismatchedDataUri);

    expect(uploadDataUriMutate).toHaveBeenCalledTimes(1);
    const input = uploadDataUriMutate.mock.calls[0]?.[0];
    expect(isRecord(input)).toBe(true);
    if (!isRecord(input)) return;
    const sentDataUri = typeof input.dataUri === "string" ? input.dataUri : "";
    expect(sentDataUri.startsWith("data:image/png;base64,")).toBe(true);
    expect(sentDataUri.startsWith("data:text/plain;base64,")).toBe(false);
    expect(result.mediaType).toBe("image");
  });

  it("requeues media generation when prompt output has no final media url", async () => {
    const { executor } = createExecutor();
    const invoker = executor as unknown as CommandExecutorInvoker;
    invoker.generateAndUploadMediaFromPrompt = vi.fn(async () => {
      throw new Error("no_media_url");
    }) as CommandExecutorInvoker["generateAndUploadMediaFromPrompt"];

    await expect(
      invoker.resolveMediaUpload({
        payload: {},
        promptFallbacks: ["create a cinematic dragon render"],
        command: baseCommand(),
      }),
    ).rejects.toThrow(/media_generation_waiting_for_output:no_media_url/iu);
  });
});
