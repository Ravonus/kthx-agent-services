import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { QueueManager } from "./queue-manager.js";
import type { QueueState } from "../types/ipc.js";

const tempDirs: string[] = [];

const createQueueManagerHarness = async (input?: {
  minSpacingSeconds?: number;
  maxSpacingSeconds?: number;
}): Promise<{
  queueStatePath: string;
  manager: QueueManager;
}> => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-queue-manager-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  tempDirs.push(root);
  await fs.mkdir(path.join(root, "ipc", "inbox"), { recursive: true });
  const queueStatePath = path.join(root, "ipc", "queue-state.json");
  const initialState: QueueState = {
    updatedAt: "2026-02-24T00:00:00.000Z",
    runnerEnabled: true,
    items: [],
    lastPlanAt: null,
    lastPlanSource: null,
  };
  await fs.writeFile(queueStatePath, JSON.stringify(initialState, null, 2), "utf8");

  const manager = new QueueManager({
    config: {
      terminalTriggerOnly: false,
      queueRunnerConcurrency: 2,
    },
    ipcPaths: {
      queueStatePath,
      inboxDir: path.join(root, "ipc", "inbox"),
      wakePath: path.join(root, "ipc", "wake"),
    },
    kthxQueueConfig: () => ({
      minSpacingSeconds: input?.minSpacingSeconds ?? 120,
      maxSpacingSeconds: input?.maxSpacingSeconds ?? 1_800,
      llmScheduleMinItems: 2,
    }),
    memory: {
      recordWrite: async () => undefined,
    },
    queue: {
      queueRunnerEnabled: true,
      queueRunnerTickInFlight: false,
      queueStateMutation: Promise.resolve(),
    },
    processCommandFile: async () => true,
    runMemoryCheckpoint: async () => undefined,
  });

  return {
    queueStatePath,
    manager,
  };
};

type QueuePlanInvoker = {
  planQueueDeterministic(reason: string): Promise<QueueState>;
};

describe("queue manager planning", () => {
  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
  });

  it("preserves not-ready backoff schedules while planning other queue items", async () => {
    const { queueStatePath, manager } = await createQueueManagerHarness();
    const notReadyDueAt = new Date(Date.now() + 60_000).toISOString();
    const state: QueueState = {
      updatedAt: "2026-02-24T00:00:00.000Z",
      runnerEnabled: true,
      lastPlanAt: null,
      lastPlanSource: null,
      items: [
        {
          id: "item-not-ready",
          directiveId: "directive-not-ready",
          inboxFile: "one.json",
          queueClass: "comment",
          forceNow: false,
          commandFingerprint: null,
          status: "scheduled",
          createdAt: "2026-02-24T00:00:00.000Z",
          dueAt: notReadyDueAt,
          attempts: 2,
          startedAt: null,
          completedAt: null,
          lastAttemptAt: "2026-02-24T00:00:20.000Z",
          lastError: "waiting_for_context",
          scheduledBy: "queue_not_ready_backoff",
        },
        {
          id: "item-queued",
          directiveId: "directive-queued",
          inboxFile: "two.json",
          queueClass: "engagement",
          forceNow: false,
          commandFingerprint: null,
          status: "queued",
          createdAt: "2026-02-24T00:00:01.000Z",
          dueAt: null,
          attempts: 0,
          startedAt: null,
          completedAt: null,
          lastAttemptAt: null,
          lastError: null,
          scheduledBy: null,
        },
      ],
    };
    await fs.writeFile(queueStatePath, JSON.stringify(state, null, 2), "utf8");

    const invoker = manager as unknown as QueuePlanInvoker;
    await invoker.planQueueDeterministic("queue_runner_tick");

    const nextRaw = JSON.parse(await fs.readFile(queueStatePath, "utf8")) as QueueState;
    const preserved = nextRaw.items.find((item) => item.id === "item-not-ready");
    const planned = nextRaw.items.find((item) => item.id === "item-queued");
    expect(preserved).toBeDefined();
    expect(planned).toBeDefined();
    if (!preserved || !planned) return;
    expect(preserved.dueAt).toBe(notReadyDueAt);
    expect(preserved.scheduledBy).toBe("queue_not_ready_backoff");
    expect(planned.status).toBe("scheduled");
    expect(planned.scheduledBy).toBe("queue_runner_tick");
    expect(typeof planned.dueAt).toBe("string");
  });
});
