import { describe, expect, it } from "vitest";

import { createWsTrackingState } from "../debug/ws-state.js";
import { SubscriptionManager } from "./subscription-manager.js";

const waitForResyncWrite = async (
  writes: unknown[],
): Promise<Record<string, unknown>> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const entry = writes.find(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        "type" in row &&
        (row as { type?: unknown }).type === "socket_subscription_resync",
    );
    if (entry && typeof entry === "object" && entry !== null) {
      return entry as Record<string, unknown>;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for socket_subscription_resync event");
};

describe("subscription manager reconnect reset", () => {
  it("runs local reconnect reset before resubscribe and records result", async () => {
    const writes: unknown[] = [];
    const manager = new SubscriptionManager({
      config: {
        subscribeGlobalFeed: false,
        subscribeActivityFeed: false,
        autoSubscribeLenses: false,
        lensRefreshMinMs: 60_000,
        heartbeatIntervalMs: 5_000,
        extraPublicTopics: [],
        extraUserTopics: [],
      },
      ws: createWsTrackingState(),
      misc: {
        subscriptionResyncRequested: false,
        subscriptionResyncReason: null,
        lastSubscriptionResyncAtMs: 0,
        lastSubscriptionRefreshAtMs: 0,
        lastWsOpenTransitionAtMs: 0,
      },
      auth: {
        agentKeyAuthBackoffUntilMs: 0,
      },
      memory: {
        recordWrite: async (payload: unknown) => {
          writes.push(payload);
        },
      },
      debugSnapshot: {
        auth: null,
        lastSubscriptionError: null,
      },
      trpc: null,
      writeDebugSnapshot: async () => undefined,
      markWsActivity: () => undefined,
      handleEnvelope: async () => undefined,
      authManager: null,
      runBackendCall: async (_label, fn) => fn(),
      resetLocalStateOnReconnect: async (reason: string) => ({
        reason,
        cancelled: 3,
      }),
    });

    manager.requestResync("unit_test_resync");
    const resyncWrite = await waitForResyncWrite(writes);
    manager.dispose();

    expect(resyncWrite.reason).toBe("unit_test_resync");
    expect(resyncWrite.reconnectResetError).toBeNull();
    expect(resyncWrite.reconnectResetResult).toEqual({
      reason: "unit_test_resync",
      cancelled: 3,
    });
  });

  it("records reconnect reset callback errors but still proceeds", async () => {
    const writes: unknown[] = [];
    const manager = new SubscriptionManager({
      config: {
        subscribeGlobalFeed: false,
        subscribeActivityFeed: false,
        autoSubscribeLenses: false,
        lensRefreshMinMs: 60_000,
        heartbeatIntervalMs: 5_000,
        extraPublicTopics: [],
        extraUserTopics: [],
      },
      ws: createWsTrackingState(),
      misc: {
        subscriptionResyncRequested: false,
        subscriptionResyncReason: null,
        lastSubscriptionResyncAtMs: 0,
        lastSubscriptionRefreshAtMs: 0,
        lastWsOpenTransitionAtMs: 0,
      },
      auth: {
        agentKeyAuthBackoffUntilMs: 0,
      },
      memory: {
        recordWrite: async (payload: unknown) => {
          writes.push(payload);
        },
      },
      debugSnapshot: {
        auth: null,
        lastSubscriptionError: null,
      },
      trpc: null,
      writeDebugSnapshot: async () => undefined,
      markWsActivity: () => undefined,
      handleEnvelope: async () => undefined,
      authManager: null,
      runBackendCall: async (_label, fn) => fn(),
      resetLocalStateOnReconnect: async () => {
        throw new Error("reset_failed");
      },
    });

    manager.requestResync("unit_test_resync_error");
    const resyncWrite = await waitForResyncWrite(writes);
    manager.dispose();

    expect(resyncWrite.reason).toBe("unit_test_resync_error");
    expect(resyncWrite.reconnectResetResult).toBeNull();
    expect(resyncWrite.reconnectResetError).toBe("reset_failed");
  });
});
