import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { CommandExecutor } from "./command-executor.js";
import type { Command } from "../types/ipc.js";
import { isRecord } from "../lib/guards.js";

const tempDirs: string[] = [];

const baseCommand = (): Command => ({
  id: "test-terminal-lifecycle",
  createdAt: new Date().toISOString(),
  kind: "brain.generateAndQueue",
  grantId: null,
  payload: {},
  sig: null,
  targetAgentId: "agent-test-1",
  sourceDirectiveId: "directive-test-1",
  pendingDirectiveId: null,
  actionNonce: "action-nonce-1",
  challenge: null,
  forceNow: true,
  runtimeSessionId: null,
  runtimeOrigin: "chat_command",
  runtimeSig: null,
});

type TerminalLifecycleInvoker = {
  finalizeCommandOutcome(input: {
    command: Command;
    outcome: {
      at: string;
      commandId: string;
      kind: string;
      grantId: string | null;
      ok: boolean;
      data?: unknown;
      error?: { message: string; code?: string };
    };
  }): Promise<void>;
};

const createExecutor = (deps: {
  callAgentChatBridge: (payload: unknown) => Promise<unknown>;
  recordWrite: (payload: unknown) => Promise<void>;
  ackDirectiveMutate: (payload: unknown) => Promise<unknown>;
}) => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-command-executor-terminal-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
      recordWrite: deps.recordWrite,
    },
    stateDb: null,
    trpc: {
      agent: {
        ackDirective: { mutate: deps.ackDirectiveMutate },
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
        authState: {
          query: async () => ({ userId: "agent-runtime-query-id" }),
        },
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
    callAgentChatBridge: deps.callAgentChatBridge,
    callAgentUploadChunk: null,
    runOpenClawPrompt: null,
  });
};

describe("command executor terminal lifecycle", () => {
  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
  });

  it("edits the literal-preview card and records ack_terminal lifecycle checkpoint with correlation fields", async () => {
    const bridge = vi.fn(async (payload: unknown) => {
      if (!isRecord(payload)) {
        throw new Error("bridge payload must be an object");
      }
      if (payload.action !== "edit_message") {
        throw new Error(`unexpected bridge action: ${String(payload.action)}`);
      }
      return {
        message: {
          id: "msg-terminal-1",
          clientMessageId: payload.clientMessageId,
        },
      };
    });
    const writes: unknown[] = [];
    const recordWrite = vi.fn(async (payload: unknown) => {
      writes.push(payload);
    });
    const ackDirectiveMutate = vi.fn(async () => ({
      stored: true,
    }));
    const executor = createExecutor({
      callAgentChatBridge: bridge,
      recordWrite,
      ackDirectiveMutate,
    });
    const invoker = executor as unknown as TerminalLifecycleInvoker;
    const command = {
      ...baseCommand(),
      payload: {
        sourceContext: "CHAT",
        chatLiteralGenerate: true,
        chatContext: {
          conversationId: "conv-terminal-1",
          clientMessageId: "client-message-1",
          messageId: "message-1",
          processingClientMessageId: "preview-message-1",
        },
      },
    } satisfies Command;
    await invoker.finalizeCommandOutcome({
      command,
      outcome: {
        at: new Date().toISOString(),
        commandId: command.id,
        kind: command.kind,
        grantId: command.grantId,
        ok: true,
        data: {
          mode: "chat_literal_generate",
          chatDeliveryHandled: false,
          chatDeliveryCheckpointRecorded: false,
          chatCompletion: {
            body: "Done. Delivery completed.",
            metadata: {
              automated: true,
              sourceContext: "CHAT",
            },
          },
        },
      },
    });

    expect(bridge).toHaveBeenCalledTimes(1);
    const editPayload = bridge.mock.calls[0]?.[0];
    expect(isRecord(editPayload)).toBe(true);
    if (!isRecord(editPayload)) return;
    expect(editPayload.action).toBe("edit_message");
    expect(editPayload.clientMessageId).toBe("preview-message-1");
    expect(editPayload.conversationId).toBe("conv-terminal-1");

    const checkpoints = writes.filter(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) && entry.type === "command_execution_checkpoint",
    );
    const chatDeliveryCheckpoint = checkpoints.find(
      (entry) => entry.stage === "chat_delivery",
    );
    expect(chatDeliveryCheckpoint).toBeTruthy();
    if (!chatDeliveryCheckpoint) return;
    expect(chatDeliveryCheckpoint.status).toBe("ok");
    expect(chatDeliveryCheckpoint.agentId).toBe("agent-test-1");
    expect(chatDeliveryCheckpoint.directiveId).toBe("directive-test-1");
    expect(chatDeliveryCheckpoint.requestOrigin).toBe("chat");
    expect(chatDeliveryCheckpoint.clientMessageId).toBe("client-message-1");
    expect(chatDeliveryCheckpoint.messageId).toBe("message-1");
    expect(chatDeliveryCheckpoint.chatContext).toEqual({
      conversationId: "conv-terminal-1",
      channelId: null,
    });

    const ackTerminalCheckpoint = checkpoints.find(
      (entry) => entry.stage === "ack_terminal",
    );
    expect(ackTerminalCheckpoint).toBeTruthy();
    if (!ackTerminalCheckpoint) return;
    expect(ackTerminalCheckpoint.status).toBe("ok");
    expect(ackDirectiveMutate).toHaveBeenCalledTimes(1);
  });

  it("does not ack directives for non-directive commands", async () => {
    const recordWrite = vi.fn(async () => undefined);
    const ackDirectiveMutate = vi.fn(async () => ({ stored: true }));
    const executor = createExecutor({
      callAgentChatBridge: async () => ({ ok: true }),
      recordWrite,
      ackDirectiveMutate,
    });
    const invoker = executor as unknown as TerminalLifecycleInvoker;
    const command = {
      ...baseCommand(),
      sourceDirectiveId: null,
      pendingDirectiveId: null,
      actionNonce: null,
      payload: {
        sourceContext: "CHAT",
      },
    } satisfies Command;
    await invoker.finalizeCommandOutcome({
      command,
      outcome: {
        at: new Date().toISOString(),
        commandId: command.id,
        kind: command.kind,
        grantId: command.grantId,
        ok: true,
        data: {
          mode: "chat",
        },
      },
    });

    expect(ackDirectiveMutate).not.toHaveBeenCalled();
  });

  it("acks directive runtime commands by falling back to command id when sourceDirectiveId is missing", async () => {
    const writes: unknown[] = [];
    const recordWrite = vi.fn(async (payload: unknown) => {
      writes.push(payload);
    });
    const ackDirectiveMutate = vi.fn(async () => ({ stored: true }));
    const executor = createExecutor({
      callAgentChatBridge: async () => ({ ok: true }),
      recordWrite,
      ackDirectiveMutate,
    });
    const invoker = executor as unknown as TerminalLifecycleInvoker;
    const command = {
      ...baseCommand(),
      id: "directive-fallback-ack-1",
      sourceDirectiveId: null,
      pendingDirectiveId: null,
      runtimeOrigin: "director_directive",
      payload: {
        sourceContext: "DIRECTIVE",
      },
    } satisfies Command;

    await invoker.finalizeCommandOutcome({
      command,
      outcome: {
        at: new Date().toISOString(),
        commandId: command.id,
        kind: command.kind,
        grantId: command.grantId,
        ok: true,
      },
    });

    expect(ackDirectiveMutate).toHaveBeenCalledTimes(1);
    expect(ackDirectiveMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        directiveId: command.id,
        status: "executed",
      }),
    );
    const checkpoints = writes.filter(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) && entry.type === "command_execution_checkpoint",
    );
    const ackTerminalCheckpoint = checkpoints.find(
      (entry) => entry.stage === "ack_terminal",
    );
    expect(ackTerminalCheckpoint).toBeTruthy();
    if (!ackTerminalCheckpoint) return;
    expect(ackTerminalCheckpoint.directiveId).toBe(command.id);
    expect(ackTerminalCheckpoint.sourceDirectiveId).toBe(command.id);
  });
});
