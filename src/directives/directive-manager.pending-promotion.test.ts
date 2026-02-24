import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { DirectiveManager } from "./directive-manager.js";
import type { CommandSealState } from "./command-seal.js";

const tempDirs: string[] = [];

const createCommandSealState = (): CommandSealState => ({
  runtimeCommandSessionId: "session-test",
  runtimeCommandSealKey: "seal-test",
  runtimeIssuedCommandIds: new Set<string>(),
  runtimeConsumedCommandIds: new Set<string>(),
});

const createHarness = async () => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-directive-manager-pending-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  tempDirs.push(root);
  const inboxDir = path.join(root, "ipc", "inbox");
  const pendingDir = path.join(root, "ipc", "pending");
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(pendingDir, { recursive: true });

  const ensureDirectiveInQueue = vi.fn(async () => undefined);
  const planQueueWithOpenClaw = vi.fn(async () => null);
  const touchWake = vi.fn(async () => undefined);

  const manager = new DirectiveManager({
    config: {
      terminalTriggerOnly: false,
    },
    ipcPaths: {
      inboxDir,
      wakePath: path.join(root, "ipc", "wake"),
      pendingDir,
      currentDirectivePath: path.join(root, "ipc", "current-directive.json"),
      resultsPath: path.join(root, "ipc", "results.jsonl"),
    },
    memory: {
      recordWrite: async () => undefined,
    },
    trpc: null,
    commandSeal: createCommandSealState(),
    directive: {
      pendingDirectives: [],
      pendingPromotionPromise: null,
      lastPendingPromotionAtMs: 0,
      autoEnqueueMutation: Promise.resolve(),
      seenDirectiveNoncesById: new Map(),
      completedDirectiveAcksById: new Map(),
      directiveNonceById: new Map(),
      directiveQueue: Promise.resolve(),
    },
    misc: {
      controlKey: null,
    },
    ensureDirectiveInQueue,
    planQueueWithOpenClaw,
    touchWake,
  });

  return {
    manager,
    pendingDir,
    ensureDirectiveInQueue,
  };
};

describe("directive manager pending promotion", () => {
  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
  });

  it("re-promotes permission-denied pending directives when retry is requested", async () => {
    const { manager, pendingDir, ensureDirectiveInQueue } = await createHarness();
    const pendingPath = path.join(pendingDir, "pending-1.json");
    const basePendingDoc = {
      id: "pending-1",
      sourceKind: "brain.generateAndQueue",
      createdAt: new Date().toISOString(),
      status: "permission_denied",
      intent: {
        goal: "comment",
        postId: 42,
      },
    };
    await fs.writeFile(pendingPath, JSON.stringify(basePendingDoc, null, 2), "utf8");

    const first = await manager.promoteFromPending({
      limit: 20,
      retryPermissionDenied: true,
      bypassCooldown: true,
      source: "test_run_1",
    });
    expect(first.promoted).toBe(1);
    expect(first.skippedAlreadySeen).toBe(0);
    expect(ensureDirectiveInQueue).toHaveBeenCalledTimes(1);

    await fs.writeFile(
      pendingPath,
      JSON.stringify(
        {
          ...basePendingDoc,
          status: "permission_denied",
          updatedAt: new Date(Date.now() + 1_000).toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    const second = await manager.promoteFromPending({
      limit: 20,
      retryPermissionDenied: true,
      bypassCooldown: true,
      source: "test_run_2",
    });
    expect(second.promoted).toBe(1);
    expect(second.skippedAlreadySeen).toBe(0);
    expect(ensureDirectiveInQueue).toHaveBeenCalledTimes(2);
  });
});
