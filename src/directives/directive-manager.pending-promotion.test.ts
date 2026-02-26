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

const createHarness = async (options?: {
  recordWrite?: (payload: unknown) => Promise<void>;
  trpc?: {
    agent?: {
      ackDirective?: {
        mutate?: (input: Record<string, unknown>) => Promise<unknown>;
      };
    };
  } | null;
}) => {
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
      recordWrite: options?.recordWrite ?? (async () => undefined),
    },
    trpc: options?.trpc ?? null,
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
    inboxDir,
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
    const { manager, inboxDir, pendingDir, ensureDirectiveInQueue } = await createHarness();
    const pendingPath = path.join(pendingDir, "pending-1.json");
    const basePendingDoc = {
      id: "pending-1",
      agentId: "agent-test-1",
      sourceKind: "brain.generateAndQueue",
      createdAt: new Date().toISOString(),
      status: "permission_denied",
      sourceDirectiveId: "directive-1",
      sourceDirectiveActionNonce: "nonce-1",
      grantId: "directive:directive-1",
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
    const stagedFilesAfterFirst = (await fs.readdir(inboxDir))
      .filter((entry) => entry.endsWith(".json"))
      .sort();
    expect(stagedFilesAfterFirst.length).toBe(1);
    const firstCommandRaw = await fs.readFile(
      path.join(inboxDir, stagedFilesAfterFirst[0]!),
      "utf8",
    );
    const firstCommand = JSON.parse(firstCommandRaw) as Record<string, unknown>;
    expect(firstCommand.sourceDirectiveId).toBe("directive-1");
    expect(firstCommand.pendingDirectiveId).toBe("pending-1");
    expect(firstCommand.actionNonce).toBe("nonce-1");
    expect(firstCommand.grantId).toBe("directive:directive-1");
    const firstPayload =
      firstCommand.payload && typeof firstCommand.payload === "object"
        ? (firstCommand.payload as Record<string, unknown>)
        : {};
    expect(firstPayload.sourceDirectiveId).toBe("directive-1");
    expect(firstPayload.sourceDirectiveActionNonce).toBe("nonce-1");
    expect(firstPayload.grantId).toBe("directive:directive-1");

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
    const stagedFilesAfterSecond = (await fs.readdir(inboxDir))
      .filter((entry) => entry.endsWith(".json"))
      .sort();
    expect(stagedFilesAfterSecond.length).toBe(2);
  });

  it("fails directives missing agent target instead of staging them", async () => {
    const writes: unknown[] = [];
    const ackDirectiveMutate = vi.fn(async () => ({ stored: true }));
    const { manager, inboxDir, ensureDirectiveInQueue } = await createHarness({
      recordWrite: async (payload: unknown) => {
        writes.push(payload);
      },
      trpc: {
        agent: {
          ackDirective: {
            mutate: ackDirectiveMutate,
          },
        },
      },
    });

    await manager.intake({
      id: "directive-missing-target",
      createdAt: new Date().toISOString(),
      kind: "brain.generateAndQueue",
      payload: { goal: "post", textBody: "hello" },
      actionNonce: "nonce-missing-target",
    });

    const stagedFiles = (await fs.readdir(inboxDir)).filter((entry) =>
      entry.endsWith(".json"),
    );
    expect(stagedFiles).toHaveLength(0);
    expect(ensureDirectiveInQueue).not.toHaveBeenCalled();
    expect(ackDirectiveMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        directiveId: "directive-missing-target",
        status: "failed",
        error: "directive_target_agent_missing",
      }),
    );
    const rejectionEvents = writes.filter(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "type" in entry &&
        (entry as { type?: unknown }).type ===
          "directive_rejected_missing_target_agent",
    );
    expect(rejectionEvents).toHaveLength(1);
  });

  it("marks pending directives without agentId as failed during promotion", async () => {
    const writes: unknown[] = [];
    const { manager, inboxDir, pendingDir, ensureDirectiveInQueue } = await createHarness({
      recordWrite: async (payload: unknown) => {
        writes.push(payload);
      },
    });
    const pendingPath = path.join(pendingDir, "pending-missing-target.json");
    await fs.writeFile(
      pendingPath,
      JSON.stringify(
        {
          id: "pending-missing-target",
          sourceKind: "brain.generateAndQueue",
          createdAt: new Date().toISOString(),
          status: "pending",
          sourceDirectiveId: "directive-missing-target",
          intent: { goal: "post", textBody: "hello" },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await manager.promoteFromPending({
      limit: 20,
      retryPermissionDenied: true,
      bypassCooldown: true,
      source: "test_missing_target",
    });
    expect(result.promoted).toBe(0);
    expect(result.skippedTerminal).toBe(1);
    expect(ensureDirectiveInQueue).not.toHaveBeenCalled();

    const stagedFiles = (await fs.readdir(inboxDir)).filter((entry) =>
      entry.endsWith(".json"),
    );
    expect(stagedFiles).toHaveLength(0);

    const pendingDocRaw = await fs.readFile(pendingPath, "utf8");
    const pendingDoc = JSON.parse(pendingDocRaw) as Record<string, unknown>;
    expect(pendingDoc.status).toBe("failed");
    expect(pendingDoc.error).toBe("directive_target_agent_missing");

    const rejectionEvents = writes.filter(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "type" in entry &&
        (entry as { type?: unknown }).type === "pending_rejected_missing_target_agent",
    );
    expect(rejectionEvents).toHaveLength(1);
  });
});
