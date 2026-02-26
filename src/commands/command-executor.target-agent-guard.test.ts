import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { CommandExecutor } from "./command-executor.js";
import { isRecord } from "../lib/guards.js";

const tempDirs: string[] = [];

const createExecutor = (deps: {
  recordWrite: (payload: unknown) => Promise<void>;
  authStateQuery: () => Promise<unknown>;
}) => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-command-executor-target-guard-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
  return {
    root,
    ipcPaths,
    executor: new CommandExecutor({
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
          authState: {
            query: deps.authStateQuery,
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
      callAgentChatBridge: null,
      callAgentUploadChunk: null,
      runOpenClawPrompt: null,
    }),
  };
};

describe("command executor target-agent guard", () => {
  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
  });

  it("does not execute a targeted command when runtime agent identity is unresolved", async () => {
    const writes: unknown[] = [];
    const recordWrite = vi.fn(async (payload: unknown) => {
      writes.push(payload);
    });
    const { executor, ipcPaths } = createExecutor({
      recordWrite,
      authStateQuery: async () => ({}),
    });

    await fs.mkdir(ipcPaths.inboxDir, { recursive: true });
    const fileName = "target-guard.json";
    await fs.writeFile(
      path.join(ipcPaths.inboxDir, fileName),
      `${JSON.stringify(
        {
          id: "target-guard-command-1",
          createdAt: new Date().toISOString(),
          kind: "write.createPost",
          payload: { textBody: "hello" },
          targetAgentId: "agent-target-123",
          sourceDirectiveId: "directive-target-123",
          actionNonce: "nonce-target-123",
          forceNow: true,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const processed = await executor.processCommandFile(fileName);
    expect(processed).toBe(false);

    const mismatchEntries = writes.filter(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) &&
        entry.type === "inbox_command_target_agent_identity_unknown",
    );
    expect(mismatchEntries).toHaveLength(1);
    expect(mismatchEntries[0]?.reason).toBe(
      "target_agent_identity_unknown:agent-target-123",
    );
  });

  it("fails directive-scoped commands that are missing targetAgentId", async () => {
    const writes: unknown[] = [];
    const recordWrite = vi.fn(async (payload: unknown) => {
      writes.push(payload);
    });
    const { executor, ipcPaths } = createExecutor({
      recordWrite,
      authStateQuery: async () => ({ userId: "agent-runtime-1" }),
    });

    await fs.mkdir(ipcPaths.inboxDir, { recursive: true });
    const fileName = "directive-missing-target.json";
    await fs.writeFile(
      path.join(ipcPaths.inboxDir, fileName),
      `${JSON.stringify(
        {
          id: "directive-missing-target-1",
          createdAt: new Date().toISOString(),
          kind: "write.createPost",
          payload: { textBody: "hello" },
          sourceDirectiveId: "directive-missing-target-1",
          runtimeOrigin: "director_directive",
          actionNonce: "nonce-missing-target-1",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const processed = await executor.processCommandFile(fileName);
    expect(processed).toBe(true);

    const missingEntries = writes.filter(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) && entry.type === "inbox_command_target_agent_missing",
    );
    expect(missingEntries).toHaveLength(1);
    expect(missingEntries[0]?.reason).toBe("directive_target_agent_missing");
  });
});
