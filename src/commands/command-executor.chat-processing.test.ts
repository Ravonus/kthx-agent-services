import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CommandExecutor } from "./command-executor.js";
import type { Command } from "../types/ipc.js";

const buildCommand = (overrides?: Partial<Command>): Command => ({
  id: "test-chat-processing",
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
  ...(overrides ?? {}),
});

const createExecutor = () => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-command-executor-chat-processing-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  return new CommandExecutor({
    config: {
      imageGenerateCmd: null,
      fileGenerateCmd: null,
      imageGenerateTimeoutMs: 45_000,
    },
    ipcPaths: {
      inboxDir: path.join(root, "inbox"),
      processedDir: path.join(root, "processed"),
      generatedDir: path.join(root, "generated"),
      queueStatePath: path.join(root, "queue-state.json"),
      resultsPath: path.join(root, "results.jsonl"),
    },
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
    callAgentChatBridge: null,
    callAgentUploadChunk: null,
    runOpenClawPrompt: null,
  });
};

type ProcessingInvoker = {
  resolveChatProcessingClientMessageId(command: Command): string | null;
};

type NonWriteChatCompletionOutcome = {
  at: string;
  commandId: string;
  kind: string;
  grantId: string | null;
  ok: boolean;
  data?: unknown;
  error?: {
    message: string;
    code?: string;
  };
};

type NonWriteChatCompletionInvoker = {
  buildNonWriteChatCompletion(input: {
    command: Command;
    outcome: NonWriteChatCompletionOutcome;
  }): { body: string; metadata: Record<string, unknown> } | null;
};

describe("command executor chat processing indicator", () => {
  it("does not emit processing message ids for conversational agent-decide chat requests", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as ProcessingInvoker;

    const id = invoker.resolveChatProcessingClientMessageId(
      buildCommand({
        payload: {
          sourceContext: "chat",
          chatContext: {
            commandName: "agent-decide",
            conversationId: "conv-1",
          },
        },
      }),
    );

    expect(id).toBeNull();
  });

  it("keeps processing message ids for explicit non-conversational chat commands", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as ProcessingInvoker;

    const id = invoker.resolveChatProcessingClientMessageId(
      buildCommand({
        payload: {
          sourceContext: "chat",
          chatContext: {
            commandName: "follow",
            conversationId: "conv-2",
          },
        },
      }),
    );

    expect(typeof id).toBe("string");
    expect(id?.startsWith("runtime_chat_progress_")).toBe(true);
  });

  it("suppresses command action preview metadata for conversational agent-decide completions", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as NonWriteChatCompletionInvoker;

    const completion = invoker.buildNonWriteChatCompletion({
      command: buildCommand({
        payload: {
          sourceContext: "chat",
          chatContext: {
            commandName: "agent-decide",
            conversationId: "conv-1",
          },
        },
      }),
      outcome: {
        at: new Date().toISOString(),
        commandId: "test-chat-processing",
        kind: "brain.generateAndQueue",
        grantId: null,
        ok: true,
        data: {
          chatCompletion: {
            body: "All done.",
            metadata: {
              actionPreview: {
                type: "command",
                status: "success",
              },
              extra: "kept",
            },
          },
        },
      },
    });

    expect(completion).not.toBeNull();
    if (!completion) return;
    expect(completion.body).toBe("All done.");
    expect(completion.metadata.actionPreview).toBeUndefined();
    expect(completion.metadata.extra).toBe("kept");
  });

  it("keeps command action preview metadata for explicit command completions", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as NonWriteChatCompletionInvoker;

    const completion = invoker.buildNonWriteChatCompletion({
      command: buildCommand({
        payload: {
          sourceContext: "chat",
          chatContext: {
            commandName: "follow",
            conversationId: "conv-2",
          },
        },
      }),
      outcome: {
        at: new Date().toISOString(),
        commandId: "test-chat-processing",
        kind: "brain.generateAndQueue",
        grantId: null,
        ok: false,
        error: {
          message: "Permission denied.",
          code: "not_granted",
        },
      },
    });

    expect(completion).not.toBeNull();
    if (!completion) return;
    expect(completion.body).toContain("follow");
    expect(completion.metadata.actionPreview).toBeTruthy();
  });
});
