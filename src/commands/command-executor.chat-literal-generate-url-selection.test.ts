import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { CommandExecutor } from "./command-executor.js";
import type { Command } from "../types/ipc.js";
import { isRecord } from "../lib/guards.js";

const tempDirs: string[] = [];

const baseCommand = (): Command => ({
  id: "test-chat-literal-generate-url-selection",
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

const createExecutor = (callAgentChatBridge: ((payload: unknown) => Promise<unknown>) | null) => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-command-executor-chat-literal-url-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  tempDirs.push(root);
  const ipcPaths = {
    inboxDir: path.join(root, "inbox"),
    processedDir: path.join(root, "processed"),
    generatedDir: path.join(root, "generated"),
    queueStatePath: path.join(root, "queue-state.json"),
    resultsPath: path.join(root, "results.jsonl"),
  };

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
    trpc: null,
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
    callAgentChatBridge,
    callAgentUploadChunk: null,
    runOpenClawPrompt: null,
  });
};

type CommandExecutorInvoker = {
  executeGenerateAndQueue(command: Command): Promise<unknown>;
  mapUploadResult(uploaded: unknown): {
    mediaUrl: string;
    mediaOriginalUrl?: string;
    mediaOptimizedUrl?: string;
  };
  extractMediaSourceFromParsedOutput: (
    parsed: unknown,
    requestDir: string,
    options?: { requireFinalStreamFrame?: boolean },
  ) => string | null;
  generateAndUploadMediaFromPrompt: (
    prompt: string,
    options: unknown,
  ) => Promise<{
    mediaUrl: string;
    mediaOriginalUrl?: string;
    mediaOptimizedUrl?: string;
    mediaType?: "image" | "video";
    mediaSizeBytes?: number;
  }>;
  saveGeneratedCustomAsset: (input: unknown) => Promise<{
    kind: "sticker";
    scope: "mine";
    name: string;
    id: number;
    url: string;
    mimeType: string;
  }>;
};

describe("command executor chat literal delivery url selection", () => {
  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
  });

  it("prefers non-stream-part upload urls over part artifacts", () => {
    const executor = createExecutor(null);
    const invoker = executor as unknown as CommandExecutorInvoker;

    const mapped = invoker.mapUploadResult({
      url: "https://cdn.example.com/generated/final-sticker.png",
      originalUrl: "https://cdn.example.com/generated/final-sticker.png",
      optimizedUrl: "https://cdn.example.com/generated/partx.png",
    });

    expect(mapped.mediaUrl).toBe("https://cdn.example.com/generated/final-sticker.png");
    expect(mapped.mediaOriginalUrl).toBe("https://cdn.example.com/generated/final-sticker.png");
    expect(mapped.mediaOptimizedUrl).toBe("https://cdn.example.com/generated/final-sticker.png");
  });

  it("prefers stable upload urls over temp artifact urls", () => {
    const executor = createExecutor(null);
    const invoker = executor as unknown as CommandExecutorInvoker;

    const mapped = invoker.mapUploadResult({
      url: "https://cdn.example.com/generated/tmp-frame-003.png",
      originalUrl: "https://cdn.example.com/generated/ravonus-sticker-final.png",
      optimizedUrl: "https://cdn.example.com/generated/temp-ravonus-preview.png",
    });

    expect(mapped.mediaUrl).toBe("https://cdn.example.com/generated/ravonus-sticker-final.png");
    expect(mapped.mediaOriginalUrl).toBe("https://cdn.example.com/generated/ravonus-sticker-final.png");
    expect(mapped.mediaOptimizedUrl).toBe("https://cdn.example.com/generated/ravonus-sticker-final.png");
  });

  it("does not resolve temp stream artifacts when final frame is required", () => {
    const executor = createExecutor(null);
    const invoker = executor as unknown as CommandExecutorInvoker;

    const resolved = invoker.extractMediaSourceFromParsedOutput(
      {
        streamEvents: [
          {
            sourceFileName: "tmp_frame_001.png",
            outputPath: "https://cdn.example.com/generated/tmp_frame_001.png",
            isStreamPart: true,
          },
          {
            sourceFileName: "temp_frame_002.png",
            outputPath: "https://cdn.example.com/generated/temp_frame_002.png",
            streamPartIndex: 2,
          },
        ],
        observedOutputFiles: [
          "https://cdn.example.com/generated/tmp_frame_001.png",
          "https://cdn.example.com/generated/temp_frame_002.png",
        ],
        latestOutputPath: "https://cdn.example.com/generated/temp_frame_002.png",
      },
      process.cwd(),
      { requireFinalStreamFrame: true },
    );

    expect(resolved).toBeNull();
  });

  it("finalizes chat literal preview with the stable image url when saved asset url is partx", async () => {
    const command = baseCommand();
    const bridge = vi.fn(async (payload: unknown) => {
      if (!isRecord(payload)) {
        throw new Error("bridge payload must be an object");
      }
      const action = typeof payload.action === "string" ? payload.action : "";
      if (action === "send_message") {
        return {
          message: {
            id: "msg-preview-1",
            clientMessageId: payload.clientMessageId,
          },
        };
      }
      if (action === "edit_message") {
        return {
          message: {
            id: "msg-preview-1",
            clientMessageId: payload.clientMessageId,
          },
        };
      }
      if (action === "list_messages") {
        return {
          items: [
            {
              message: {
                id: "msg-preview-1",
                clientMessageId: `runtime_generate_${command.id}`,
              },
            },
          ],
        };
      }
      throw new Error(`unexpected bridge action: ${action}`);
    });

    const executor = createExecutor(bridge);
    const invoker = executor as unknown as CommandExecutorInvoker;
    invoker.generateAndUploadMediaFromPrompt = vi.fn(async () => ({
      mediaUrl: "https://cdn.example.com/generated/partx.png",
      mediaOriginalUrl: "https://cdn.example.com/generated/final-sticker.png",
      mediaOptimizedUrl: "https://cdn.example.com/generated/partx.png",
      mediaType: "image",
      mediaSizeBytes: 2048,
    }));
    invoker.saveGeneratedCustomAsset = vi.fn(async () => ({
      kind: "sticker",
      scope: "mine",
      name: "pepe_thumbsup",
      id: 42,
      url: "https://cdn.example.com/generated/partx.png",
      mimeType: "image/png",
    }));

    const outcome = await invoker.executeGenerateAndQueue({
      ...command,
      payload: {
        chatLiteralGenerate: true,
        generatedAssetType: "image",
        mediaPrompt: "Make me a sticker of a Pepe giving thumbs up",
        generatedCustomAssetSave: {
          kind: "sticker",
          scope: "mine",
          nameHint: "pepe_thumbsup",
        },
        chatContext: {
          conversationId: "conv-test",
        },
      },
    });

    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(true);

    const data = isRecord(outcome.data) ? outcome.data : null;
    expect(data).not.toBeNull();
    if (!data) return;
    expect(data.mediaUrl).toBe("https://cdn.example.com/generated/final-sticker.png");

    const editPayloads: Record<string, unknown>[] = [];
    for (const callArgs of bridge.mock.calls) {
      const payload = callArgs[0];
      if (!isRecord(payload) || payload.action !== "edit_message") continue;
      editPayloads.push(payload);
    }
    expect(editPayloads.length).toBeGreaterThan(0);
    const successEdit = [...editPayloads]
      .reverse()
      .find((payload) => Array.isArray(payload.attachments));
    expect(successEdit).toBeTruthy();
    if (!successEdit) return;

    const attachments = Array.isArray(successEdit.attachments)
      ? successEdit.attachments
      : [];
    const firstAttachment = attachments.length > 0 && isRecord(attachments[0])
      ? attachments[0]
      : null;
    expect(firstAttachment).not.toBeNull();
    if (!firstAttachment) return;
    expect(firstAttachment.url).toBe("https://cdn.example.com/generated/final-sticker.png");

    const metadata = isRecord(successEdit.metadata) ? successEdit.metadata : null;
    const actionPreview = metadata && isRecord(metadata.actionPreview)
      ? metadata.actionPreview
      : null;
    expect(actionPreview).not.toBeNull();
    if (!actionPreview) return;
    expect(actionPreview.previewUrl).toBe("https://cdn.example.com/generated/final-sticker.png");
  });
});
