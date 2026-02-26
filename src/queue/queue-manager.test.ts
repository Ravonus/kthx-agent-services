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
  processCommandFile?: (inboxFile: string) => Promise<boolean>;
  queueRunnerConcurrency?: number;
}): Promise<{
  queueStatePath: string;
  inboxDir: string;
  manager: QueueManager;
}> => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-queue-manager-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  tempDirs.push(root);
  const inboxDir = path.join(root, "ipc", "inbox");
  await fs.mkdir(inboxDir, { recursive: true });
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
      queueRunnerConcurrency: input?.queueRunnerConcurrency ?? 2,
    },
    ipcPaths: {
      queueStatePath,
      inboxDir,
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
    processCommandFile:
      input?.processCommandFile ??
      (async () => true),
    runMemoryCheckpoint: async () => undefined,
  });

  return {
    queueStatePath,
    inboxDir,
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

  it("uses fast backoff for media generation setup deferrals instead of long stalls", async () => {
    const { queueStatePath, manager, inboxDir } = await createQueueManagerHarness({
      queueRunnerConcurrency: 1,
      processCommandFile: async () => false,
    });

    const state: QueueState = {
      updatedAt: "2026-02-24T00:00:00.000Z",
      runnerEnabled: true,
      lastPlanAt: null,
      lastPlanSource: null,
      items: [
        {
          id: "item-media-not-ready",
          directiveId: "directive-media-not-ready",
          inboxFile: "media-not-ready.json",
          queueClass: "media",
          forceNow: true,
          commandFingerprint: null,
          status: "queued",
          createdAt: "2026-02-24T00:00:00.000Z",
          dueAt: null,
          attempts: 8,
          startedAt: null,
          completedAt: null,
          lastAttemptAt: null,
          lastError: "image_generation_setup_required",
          scheduledBy: null,
        },
      ],
    };
    await fs.writeFile(queueStatePath, JSON.stringify(state, null, 2), "utf8");
    await fs.writeFile(path.join(inboxDir, "media-not-ready.json"), "{}", "utf8");

    await manager.runnerTick();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const nextRaw = JSON.parse(await fs.readFile(queueStatePath, "utf8")) as QueueState;
    const item = nextRaw.items.find((entry) => entry.id === "item-media-not-ready");
    expect(item).toBeDefined();
    if (!item) return;
    expect(item.status).toBe("scheduled");
    expect(item.scheduledBy).toBe("queue_not_ready_backoff");
    expect(item.lastError).toBe("image_generation_setup_required");
    expect(item.attempts).toBe(9);
    expect(typeof item.dueAt).toBe("string");
    if (typeof item.dueAt === "string") {
      const retryDelaySeconds = Math.max(0, Math.round((Date.parse(item.dueAt) - Date.now()) / 1000));
      expect(retryDelaySeconds).toBeLessThanOrEqual(30);
    }
  });

  it("recovers abandoned running items so queue drain can continue", async () => {
    const { queueStatePath, manager, inboxDir } = await createQueueManagerHarness({
      queueRunnerConcurrency: 1,
      processCommandFile: async () => false,
    });
    const runningStartedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const state: QueueState = {
      updatedAt: "2026-02-24T00:00:00.000Z",
      runnerEnabled: true,
      lastPlanAt: null,
      lastPlanSource: null,
      items: [
        {
          id: "item-stale-running",
          directiveId: "directive-stale-running",
          inboxFile: "stale-running.json",
          queueClass: "comment",
          forceNow: false,
          commandFingerprint: null,
          status: "running",
          createdAt: "2026-02-24T00:00:00.000Z",
          dueAt: null,
          attempts: 1,
          startedAt: runningStartedAt,
          completedAt: null,
          lastAttemptAt: runningStartedAt,
          lastError: "previous_attempt_stalled",
          scheduledBy: null,
        },
      ],
    };
    await fs.writeFile(queueStatePath, JSON.stringify(state, null, 2), "utf8");
    await fs.writeFile(path.join(inboxDir, "stale-running.json"), "{}", "utf8");

    await manager.runnerTick();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const nextRaw = JSON.parse(await fs.readFile(queueStatePath, "utf8")) as QueueState;
    const recovered = nextRaw.items.find((item) => item.id === "item-stale-running");
    expect(recovered).toBeDefined();
    if (!recovered) return;
    expect(recovered.status).toBe("scheduled");
    expect(typeof recovered.dueAt).toBe("string");
    expect(recovered.completedAt).toBeNull();
  });

  it("drains multiple force-now directives in created order without collapsing queued items", async () => {
    let queueStatePathRef = "";
    const processedOrder: string[] = [];
    const { queueStatePath, manager, inboxDir } = await createQueueManagerHarness({
      queueRunnerConcurrency: 1,
      minSpacingSeconds: 1,
      maxSpacingSeconds: 1,
      processCommandFile: async (inboxFile) => {
        processedOrder.push(inboxFile);
        const rawState = JSON.parse(await fs.readFile(queueStatePathRef, "utf8")) as QueueState;
        const nextState: QueueState = {
          ...rawState,
          items: rawState.items.map((item) =>
            item.inboxFile === inboxFile
              ? {
                  ...item,
                  status: "done",
                  completedAt: new Date().toISOString(),
                }
              : item,
          ),
        };
        await fs.writeFile(queueStatePathRef, JSON.stringify(nextState, null, 2), "utf8");
        return true;
      },
    });
    queueStatePathRef = queueStatePath;

    await fs.writeFile(path.join(inboxDir, "one.json"), "{}", "utf8");
    await fs.writeFile(path.join(inboxDir, "two.json"), "{}", "utf8");

    await manager.enqueue({
      directiveId: "directive-one",
      inboxFile: "one.json",
      queueClass: "comment",
      forceNow: true,
      commandFingerprint: "directive-one:nonce-1",
    });
    await manager.enqueue({
      directiveId: "directive-two",
      inboxFile: "two.json",
      queueClass: "comment",
      forceNow: true,
      commandFingerprint: "directive-two:nonce-1",
    });

    await manager.runnerTick();
    await new Promise((resolve) => setTimeout(resolve, 250));

    const state = JSON.parse(await fs.readFile(queueStatePath, "utf8")) as QueueState;
    expect(state.items).toHaveLength(2);
    expect(state.items.every((item) => item.completedAt !== null)).toBe(true);
    expect(processedOrder).toEqual(["one.json", "two.json"]);
  });

  it("keeps queue state isolated across manager instances", async () => {
    const first = await createQueueManagerHarness();
    const second = await createQueueManagerHarness();

    await first.manager.enqueue({
      directiveId: "directive-first",
      inboxFile: "first.json",
      queueClass: "post",
      forceNow: false,
      commandFingerprint: "directive-first:nonce-1",
    });
    await second.manager.enqueue({
      directiveId: "directive-second",
      inboxFile: "second.json",
      queueClass: "engagement",
      forceNow: true,
      commandFingerprint: "directive-second:nonce-1",
    });

    const firstState = JSON.parse(await fs.readFile(first.queueStatePath, "utf8")) as QueueState;
    const secondState = JSON.parse(await fs.readFile(second.queueStatePath, "utf8")) as QueueState;

    expect(firstState.items).toHaveLength(1);
    expect(secondState.items).toHaveLength(1);
    expect(firstState.items[0]?.directiveId).toBe("directive-first");
    expect(firstState.items[0]?.inboxFile).toBe("first.json");
    expect(secondState.items[0]?.directiveId).toBe("directive-second");
    expect(secondState.items[0]?.inboxFile).toBe("second.json");
  });

  it("cancels queued/scheduled/running items and removes queued inbox files on reconnect reset", async () => {
    const { queueStatePath, manager, inboxDir } = await createQueueManagerHarness();
    const queueState: QueueState = {
      updatedAt: "2026-02-24T00:00:00.000Z",
      runnerEnabled: true,
      lastPlanAt: null,
      lastPlanSource: null,
      items: [
        {
          id: "item-queued",
          directiveId: "directive-queued",
          inboxFile: "queued.json",
          queueClass: "post",
          forceNow: false,
          commandFingerprint: null,
          status: "queued",
          createdAt: "2026-02-24T00:00:00.000Z",
          dueAt: null,
          attempts: 0,
          startedAt: null,
          completedAt: null,
          lastAttemptAt: null,
          lastError: null,
          scheduledBy: null,
        },
        {
          id: "item-scheduled",
          directiveId: "directive-scheduled",
          inboxFile: "scheduled.json",
          queueClass: "media",
          forceNow: false,
          commandFingerprint: null,
          status: "scheduled",
          createdAt: "2026-02-24T00:00:01.000Z",
          dueAt: new Date(Date.now() + 60_000).toISOString(),
          attempts: 1,
          startedAt: null,
          completedAt: null,
          lastAttemptAt: "2026-02-24T00:00:10.000Z",
          lastError: "waiting_for_context",
          scheduledBy: "queue_runner_tick",
        },
        {
          id: "item-running",
          directiveId: "directive-running",
          inboxFile: "running.json",
          queueClass: "comment",
          forceNow: true,
          commandFingerprint: null,
          status: "running",
          createdAt: "2026-02-24T00:00:02.000Z",
          dueAt: null,
          attempts: 2,
          startedAt: "2026-02-24T00:00:20.000Z",
          completedAt: null,
          lastAttemptAt: "2026-02-24T00:00:20.000Z",
          lastError: null,
          scheduledBy: null,
        },
        {
          id: "item-done",
          directiveId: "directive-done",
          inboxFile: "done.json",
          queueClass: "post",
          forceNow: false,
          commandFingerprint: null,
          status: "done",
          createdAt: "2026-02-24T00:00:03.000Z",
          dueAt: null,
          attempts: 1,
          startedAt: "2026-02-24T00:00:30.000Z",
          completedAt: "2026-02-24T00:00:40.000Z",
          lastAttemptAt: "2026-02-24T00:00:30.000Z",
          lastError: null,
          scheduledBy: null,
        },
        {
          id: "item-cancelled",
          directiveId: "directive-cancelled",
          inboxFile: "cancelled.json",
          queueClass: "post",
          forceNow: false,
          commandFingerprint: null,
          status: "cancelled",
          createdAt: "2026-02-24T00:00:04.000Z",
          dueAt: null,
          attempts: 1,
          startedAt: null,
          completedAt: "2026-02-24T00:00:45.000Z",
          lastAttemptAt: null,
          lastError: "cancelled",
          scheduledBy: null,
        },
      ],
    };
    await fs.writeFile(queueStatePath, JSON.stringify(queueState, null, 2), "utf8");
    await fs.writeFile(path.join(inboxDir, "queued.json"), "{}", "utf8");
    await fs.writeFile(path.join(inboxDir, "scheduled.json"), "{}", "utf8");
    await fs.writeFile(path.join(inboxDir, "running.json"), "{}", "utf8");

    const result = await manager.resetQueueOnReconnect("socket_reconnect");
    expect(result.scanned).toBe(5);
    expect(result.cancelled).toBe(3);
    expect(result.cancelledQueued).toBe(1);
    expect(result.cancelledScheduled).toBe(1);
    expect(result.cancelledRunning).toBe(1);
    expect(result.skippedTerminal).toBe(2);
    expect(result.removedInboxFiles).toBe(2);

    const nextRaw = JSON.parse(await fs.readFile(queueStatePath, "utf8")) as QueueState;
    const queued = nextRaw.items.find((item) => item.id === "item-queued");
    const scheduled = nextRaw.items.find((item) => item.id === "item-scheduled");
    const running = nextRaw.items.find((item) => item.id === "item-running");
    expect(queued?.status).toBe("cancelled");
    expect(scheduled?.status).toBe("cancelled");
    expect(running?.status).toBe("cancelled");
    expect(queued?.scheduledBy).toBe("reconnect_reset");
    expect(scheduled?.scheduledBy).toBe("reconnect_reset");
    expect(running?.scheduledBy).toBe("reconnect_reset");
    expect(typeof queued?.completedAt).toBe("string");
    expect(typeof scheduled?.completedAt).toBe("string");
    expect(typeof running?.completedAt).toBe("string");

    const queuedExists = await fs
      .access(path.join(inboxDir, "queued.json"))
      .then(() => true)
      .catch(() => false);
    const scheduledExists = await fs
      .access(path.join(inboxDir, "scheduled.json"))
      .then(() => true)
      .catch(() => false);
    const runningExists = await fs
      .access(path.join(inboxDir, "running.json"))
      .then(() => true)
      .catch(() => false);
    expect(queuedExists).toBe(false);
    expect(scheduledExists).toBe(false);
    expect(runningExists).toBe(true);
  });
});
