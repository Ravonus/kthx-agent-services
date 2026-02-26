import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { CommandExecutor } from "./command-executor.js";
import type { Command } from "../types/ipc.js";

const tempDirs: string[] = [];

type ResolvedMediaUpload = {
  mediaUrl: string;
  mediaOriginalUrl?: string;
  mediaOptimizedUrl?: string;
  mediaType?: "image" | "video";
  mediaSizeBytes?: number;
};

type OpenClawPromptResult = {
  parsed: unknown;
  raw: string;
  agentName: string | null;
  payloadText: string | null;
  envelope: Record<string, unknown> | null;
};

type CommandExecutorInvoker = {
  generateAndUploadMediaFromPrompt(
    prompt: string,
    opts?: {
      generatedAssetType?: "image" | "gif" | "pdf" | "csv" | "code" | "file" | "txt" | "md";
      mode?: string;
      referenceInputs?: string[];
      maxReferenceInputs?: number;
      keepOriginal?: boolean;
      commandId?: string | null;
      skipPromptCuration?: boolean;
    },
  ): Promise<ResolvedMediaUpload>;
  resolveMediaUpload(input: {
    payload: Record<string, unknown>;
    keepOriginal?: boolean;
    promptFallbacks: Array<string | null>;
    command?: Command;
    skipPromptCuration?: boolean;
  }): Promise<ResolvedMediaUpload>;
  runMediaGeneratorViaHttp(input: {
    prompt: string;
    generatedAssetType: "image" | "gif" | "pdf" | "csv" | "code" | "file" | "txt" | "md";
    requestDir: string;
    referenceFiles: string[];
    timeoutMs: number;
    stream: boolean;
  }): Promise<{ payload: unknown; timedOut: boolean } | null>;
  uploadResolvedMediaSource(
    source: string,
    options?: { keepOriginal?: boolean },
  ): Promise<ResolvedMediaUpload>;
};

const baseDirectiveCommand = (): Command => ({
  id: "test-directive-media-prompt-lock",
  createdAt: new Date().toISOString(),
  kind: "write.createPost",
  grantId: null,
  payload: {},
  sig: null,
  sourceDirectiveId: "test-directive-media-prompt-lock",
  pendingDirectiveId: null,
  actionNonce: "nonce-directive-media-prompt-lock",
  challenge: null,
  forceNow: true,
  runtimeSessionId: null,
  runtimeOrigin: "director_directive",
  runtimeSig: null,
});

const createExecutor = (
  runOpenClawPrompt?: ((input: { prompt: string; purpose: string }) => Promise<OpenClawPromptResult | null>) | null,
) => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-command-executor-media-prompt-lock-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
      imageGenerateCmd: "echo noop",
      fileGenerateCmd: "echo noop",
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
    runOpenClawPrompt: runOpenClawPrompt ?? null,
  });
};

describe("command executor media prompt lock", () => {
  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
  });

  it("reuses the same curated media prompt across retries for a command", async () => {
    const runOpenClawPrompt = vi.fn(
      async (_input: { prompt: string; purpose: string }) =>
        ({
          parsed: { prompt: "locked curated prompt" },
          raw: "{\"prompt\":\"locked curated prompt\"}",
          agentName: null,
          payloadText: "{\"prompt\":\"locked curated prompt\"}",
          envelope: null,
        }) satisfies OpenClawPromptResult,
    );
    const executor = createExecutor(runOpenClawPrompt);
    const invoker = executor as unknown as CommandExecutorInvoker;
    const runMediaGeneratorViaHttp = vi.fn(
      async (input: {
        prompt: string;
      }) =>
        ({
          payload: {
            savedFiles: ["https://cdn.example.com/generated/final.png"],
          },
          timedOut: false,
        }) as { payload: unknown; timedOut: boolean },
    );
    const uploadResolvedMediaSource = vi.fn(
      async (source: string): Promise<ResolvedMediaUpload> => ({
        mediaUrl: source,
        mediaOriginalUrl: source,
        mediaOptimizedUrl: source,
        mediaType: "image",
      }),
    );
    invoker.runMediaGeneratorViaHttp =
      runMediaGeneratorViaHttp as CommandExecutorInvoker["runMediaGeneratorViaHttp"];
    invoker.uploadResolvedMediaSource =
      uploadResolvedMediaSource as CommandExecutorInvoker["uploadResolvedMediaSource"];

    await invoker.generateAndUploadMediaFromPrompt("dragon in chains", {
      commandId: "cmd-lock-1",
      mode: "write_media_generate",
      generatedAssetType: "image",
    });
    await invoker.generateAndUploadMediaFromPrompt("dragon in chains", {
      commandId: "cmd-lock-1",
      mode: "write_media_generate",
      generatedAssetType: "image",
    });

    expect(runOpenClawPrompt).toHaveBeenCalledTimes(1);
    expect(runMediaGeneratorViaHttp).toHaveBeenCalledTimes(2);
    const firstCall = runMediaGeneratorViaHttp.mock.calls[0]?.[0];
    const secondCall = runMediaGeneratorViaHttp.mock.calls[1]?.[0];
    expect(firstCall?.prompt).toBe("locked curated prompt");
    expect(secondCall?.prompt).toBe("locked curated prompt");
  });

  it("skips media prompt curation for directive-linked resolveMediaUpload", async () => {
    const runOpenClawPrompt = vi.fn(
      async (_input: { prompt: string; purpose: string }) =>
        ({
          parsed: { prompt: "should-not-run" },
          raw: "{\"prompt\":\"should-not-run\"}",
          agentName: null,
          payloadText: "{\"prompt\":\"should-not-run\"}",
          envelope: null,
        }) satisfies OpenClawPromptResult,
    );
    const executor = createExecutor(runOpenClawPrompt);
    const invoker = executor as unknown as CommandExecutorInvoker;
    const runMediaGeneratorViaHttp = vi.fn(
      async (input: {
        prompt: string;
      }) =>
        ({
          payload: {
            savedFiles: ["https://cdn.example.com/generated/directive-final.png"],
          },
          timedOut: false,
        }) as { payload: unknown; timedOut: boolean },
    );
    const uploadResolvedMediaSource = vi.fn(
      async (source: string): Promise<ResolvedMediaUpload> => ({
        mediaUrl: source,
        mediaOriginalUrl: source,
        mediaOptimizedUrl: source,
        mediaType: "image",
      }),
    );
    invoker.runMediaGeneratorViaHttp =
      runMediaGeneratorViaHttp as CommandExecutorInvoker["runMediaGeneratorViaHttp"];
    invoker.uploadResolvedMediaSource =
      uploadResolvedMediaSource as CommandExecutorInvoker["uploadResolvedMediaSource"];

    await invoker.resolveMediaUpload({
      payload: {},
      promptFallbacks: ["single locked directive prompt"],
      command: baseDirectiveCommand(),
    });

    expect(runOpenClawPrompt).toHaveBeenCalledTimes(0);
    expect(runMediaGeneratorViaHttp).toHaveBeenCalledTimes(1);
    const call = runMediaGeneratorViaHttp.mock.calls[0]?.[0];
    expect(call?.prompt).toBe("single locked directive prompt");
  });
});
