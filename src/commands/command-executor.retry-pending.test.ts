import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CommandExecutor } from "./command-executor.js";
import { isRecord } from "../lib/guards.js";
import type { Command } from "../types/ipc.js";

const baseCommand = (): Command => ({
  id: "test-retry-pending",
  createdAt: new Date().toISOString(),
  kind: "brain.retryPending",
  grantId: null,
  payload: {},
  sig: null,
  sourceDirectiveId: "test-retry-pending",
  pendingDirectiveId: null,
  actionNonce: null,
  challenge: null,
  forceNow: true,
  runtimeSessionId: null,
  runtimeOrigin: "director_directive",
  runtimeSig: null,
});

const createExecutor = (input: {
  promotePendingDirectives: (payload: {
    limit: number;
    retryPermissionDenied: boolean;
    bypassCooldown?: boolean;
    source?: string;
  }) => Promise<{
    scanned: number;
    promoted: number;
    skippedPermissionDenied: number;
    skippedTerminal: number;
    skippedAlreadySeen: number;
    skippedQueued: number;
    limit: number;
  }>;
  generateMutate?: (payload: unknown) => Promise<unknown>;
}) => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-command-executor-retry-pending-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const ipcPaths = {
    inboxDir: path.join(root, "inbox"),
    processedDir: path.join(root, "processed"),
    generatedDir: path.join(root, "generated"),
    queueStatePath: path.join(root, "queue-state.json"),
    resultsPath: path.join(root, "results.jsonl"),
  };
  const noopMutate = async () => ({ ok: true });
  const generateMutate =
    input.generateMutate ??
    (async () => {
      throw new Error("generate should not run for brain.retryPending");
    });
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
        generate: { mutate: generateMutate },
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
    promotePendingDirectives: input.promotePendingDirectives,
  });
};

describe("command executor retry pending", () => {
  it("routes brain.retryPending through pending promotion instead of generate", async () => {
    const promotePendingDirectives = vi.fn(async () => ({
      scanned: 5,
      promoted: 2,
      skippedPermissionDenied: 1,
      skippedTerminal: 1,
      skippedAlreadySeen: 1,
      skippedQueued: 0,
      limit: 20,
    }));
    const generateMutate = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({
      promotePendingDirectives,
      generateMutate,
    });
    const invoker = executor as unknown as {
      executeCommand(command: Command): Promise<{ processed: boolean; outcome: unknown }>;
    };

    const result = await invoker.executeCommand({
      ...baseCommand(),
      payload: {
        limit: 20,
        retryPermissionDenied: true,
      },
    });

    expect(result.processed).toBe(true);
    expect(promotePendingDirectives).toHaveBeenCalledTimes(1);
    expect(promotePendingDirectives).toHaveBeenCalledWith({
      limit: 20,
      retryPermissionDenied: true,
      bypassCooldown: true,
      source: "brain_retry_pending",
    });
    expect(generateMutate).toHaveBeenCalledTimes(0);

    expect(isRecord(result.outcome)).toBe(true);
    if (!isRecord(result.outcome)) return;
    expect(result.outcome["ok"]).toBe(true);
    const data = isRecord(result.outcome["data"]) ? result.outcome["data"] : null;
    expect(data).not.toBeNull();
    if (!data) return;
    const retryData = isRecord(data["retryPending"]) ? data["retryPending"] : null;
    expect(retryData).not.toBeNull();
    if (!retryData) return;
    expect(retryData["promoted"]).toBe(2);
    const completion = isRecord(data["chatCompletion"]) ? data["chatCompletion"] : null;
    expect(typeof completion?.["body"]).toBe("string");
    expect(String(completion?.["body"] ?? "")).toContain("Queued 2 pending directives");
  });
});
