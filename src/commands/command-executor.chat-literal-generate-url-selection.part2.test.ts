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


  it("allows generic chat literal image generation with legacy default persona lock hints", async () => {
    const command = baseCommand();
    const bridge = vi.fn(async (payload: unknown) => {
      if (!isRecord(payload)) {
        throw new Error("bridge payload must be an object");
      }
      const action = typeof payload.action === "string" ? payload.action : "";
      if (action === "send_message") {
        return {
          message: {
            id: "msg-generic-literal-1",
            clientMessageId: payload.clientMessageId,
          },
        };
      }
      if (action === "edit_message") {
        return {
          message: {
            id: "msg-generic-literal-1",
            clientMessageId: payload.clientMessageId,
          },
        };
      }
      if (action === "list_messages") {
        return {
          items: [
            {
              message: {
                id: "msg-generic-literal-1",
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
    invoker.generateAndUploadMediaFromPrompt = vi.fn(
      async () => ({
        mediaUrl: "https://cdn.example.com/generated/catdog-creepy-final.png",
        mediaOriginalUrl: "https://cdn.example.com/generated/catdog-creepy-final.png",
        mediaOptimizedUrl: "https://cdn.example.com/generated/catdog-creepy-final.png",
        mediaType: "image",
        mediaSizeBytes: 2048,
      }),
    ) as CommandExecutorInvoker["generateAndUploadMediaFromPrompt"];

    const outcome = await invoker.executeGenerateAndQueue({
      ...command,
      payload: {
        chatLiteralGenerate: true,
        generatedAssetType: "image",
        mediaPrompt: "Generate a realistic creepy cat-dog hybrid.",
        mediaPersona: "default",
        mediaPersonaLock: true,
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
    expect(data.mediaUrl).toBe("https://cdn.example.com/generated/catdog-creepy-final.png");
  });

  it("requeues chat literal generation when no final media url is produced", async () => {
    const command = baseCommand();
    const bridge = vi.fn(async (payload: unknown) => {
      if (!isRecord(payload)) {
        throw new Error("bridge payload must be an object");
      }
      const action = typeof payload.action === "string" ? payload.action : "";
      if (action === "send_message") {
        return {
          message: {
            id: "msg-generate-requeue-1",
            clientMessageId: payload.clientMessageId,
          },
        };
      }
      if (action === "edit_message") {
        return {
          message: {
            id: "msg-generate-requeue-1",
            clientMessageId: payload.clientMessageId,
          },
        };
      }
      if (action === "list_messages") {
        return {
          items: [
            {
              message: {
                id: "msg-generate-requeue-1",
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
    invoker.generateAndUploadMediaFromPrompt = vi.fn(async () => {
      throw new Error("no_media_url");
    }) as CommandExecutorInvoker["generateAndUploadMediaFromPrompt"];

    await expect(
      invoker.executeGenerateAndQueue({
        ...command,
        payload: {
          chatLiteralGenerate: true,
          generatedAssetType: "image",
          mediaPrompt: "Generate a dragon chained up.",
          chatContext: {
            conversationId: "conv-test",
          },
        },
      }),
    ).rejects.toThrow(/media_generation_waiting_for_output:no_media_url/iu);

    const editPayloads = bridge.mock.calls
      .map((call) => call[0])
      .filter(
        (payload): payload is Record<string, unknown> =>
          isRecord(payload) && payload.action === "edit_message",
      );
    expect(editPayloads.length).toBeGreaterThan(0);
    const lastEdit = editPayloads[editPayloads.length - 1];
    expect(isRecord(lastEdit?.metadata)).toBe(true);
    const metadata = isRecord(lastEdit?.metadata) ? lastEdit.metadata : null;
    const actionPreview = metadata && isRecord(metadata.actionPreview)
      ? metadata.actionPreview
      : null;
    expect(actionPreview).not.toBeNull();
    if (!actionPreview) return;
    expect(actionPreview.status).toBe("processing");
    expect(actionPreview.deferred).toBe(true);
    expect(actionPreview.deferredReason).toBe("media_generation_waiting_for_output:no_media_url");
  });

  it("fails chat literal generation without requeue on unsupported upload mime output", async () => {
    const command = baseCommand();
    const bridge = vi.fn(async (payload: unknown) => {
      if (!isRecord(payload)) {
        throw new Error("bridge payload must be an object");
      }
      const action = typeof payload.action === "string" ? payload.action : "";
      if (action === "send_message" || action === "edit_message") {
        return {
          message: {
            id: "msg-generate-failed-1",
            clientMessageId: payload.clientMessageId,
          },
        };
      }
      if (action === "list_messages") {
        return {
          items: [
            {
              message: {
                id: "msg-generate-failed-1",
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
    invoker.generateAndUploadMediaFromPrompt = vi.fn(async () => {
      throw new Error("Only image and video uploads are supported.");
    }) as CommandExecutorInvoker["generateAndUploadMediaFromPrompt"];

    const outcome = await invoker.executeGenerateAndQueue({
      ...command,
      payload: {
        chatLiteralGenerate: true,
        generatedAssetType: "image",
        mediaPrompt: "Generate a dragon chained up.",
        chatContext: {
          conversationId: "conv-test",
        },
      },
    });

    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(false);

    const editPayloads = bridge.mock.calls
      .map((call) => call[0])
      .filter(
        (payload): payload is Record<string, unknown> =>
          isRecord(payload) && payload.action === "edit_message",
      );
    expect(editPayloads.length).toBeGreaterThan(0);
    const lastEdit = editPayloads[editPayloads.length - 1];
    const metadata = isRecord(lastEdit?.metadata) ? lastEdit.metadata : null;
    const actionPreview =
      metadata && isRecord(metadata.actionPreview) ? metadata.actionPreview : null;
    expect(actionPreview).not.toBeNull();
    if (!actionPreview) return;
    expect(actionPreview.status).toBe("failed");
    expect(actionPreview.deferred).not.toBe(true);
  });

  it("fails chat literal generation without requeue when no generation activity was observed", async () => {
    const command = baseCommand();
    const bridge = vi.fn(async (payload: unknown) => {
      if (!isRecord(payload)) {
        throw new Error("bridge payload must be an object");
      }
      const action = typeof payload.action === "string" ? payload.action : "";
      if (action === "send_message" || action === "edit_message") {
        return {
          message: {
            id: "msg-generate-no-activity-1",
            clientMessageId: payload.clientMessageId,
          },
        };
      }
      if (action === "list_messages") {
        return {
          items: [
            {
              message: {
                id: "msg-generate-no-activity-1",
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
    invoker.generateAndUploadMediaFromPrompt = vi.fn(async () => {
      throw new Error("no_media_url_without_generation_activity");
    }) as CommandExecutorInvoker["generateAndUploadMediaFromPrompt"];

    const outcome = await invoker.executeGenerateAndQueue({
      ...command,
      payload: {
        chatLiteralGenerate: true,
        generatedAssetType: "image",
        mediaPrompt: "Generate a dragon chained up.",
        chatContext: {
          conversationId: "conv-test",
        },
      },
    });

    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(false);

    const editPayloads = bridge.mock.calls
      .map((call) => call[0])
      .filter(
        (payload): payload is Record<string, unknown> =>
          isRecord(payload) && payload.action === "edit_message",
      );
    expect(editPayloads.length).toBeGreaterThan(0);
    const lastEdit = editPayloads[editPayloads.length - 1];
    const metadata = isRecord(lastEdit?.metadata) ? lastEdit.metadata : null;
    const actionPreview =
      metadata && isRecord(metadata.actionPreview) ? metadata.actionPreview : null;
    expect(actionPreview).not.toBeNull();
    if (!actionPreview) return;
    expect(actionPreview.status).toBe("failed");
    expect(actionPreview.deferred).not.toBe(true);
  });
});
