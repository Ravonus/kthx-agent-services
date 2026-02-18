/**
 * startRuntime(): lifecycle orchestration for the agent runtime.
 *
 * Ported from agent-runtime.mjs lines 9481-22480.
 * Sets up WS subscriptions, heartbeat intervals, queue runner,
 * chat polling, memory checkpoint, and shutdown handlers.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { RuntimeContext } from "./runtime-context.js";
import { isRecord } from "./lib/guards.js";
import { nowIso } from "./lib/text.js";
import { appendJsonLine } from "./lib/fs.js";
import { getBotToken } from "./auth/bot-token.js";
import {
  markWsActivity,
  refreshWsDebugSnapshot,
  writeDebugSnapshot,
} from "./debug/ws-state.js";
import { isConnectedSocketState } from "./ws/realtime-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RuntimeDeps {
  ctx: RuntimeContext;
  hasInteractivePty: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toEpochMs = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

const touchWake = async (wakePath: string): Promise<void> => {
  await fs
    .writeFile(wakePath, nowIso(), "utf8")
    .catch(() => {});
};

// ---------------------------------------------------------------------------
// Backend call serialization gate
// ---------------------------------------------------------------------------

let backendRequestInFlight = false;
let backendRequestQueueDepth = 0;
let lastBackendCallAtMs = 0;

export const runBackendCall = async <T>(
  label: string,
  fn: () => Promise<T>,
  ctx?: RuntimeContext,
): Promise<T> => {
  const serialize = ctx?.config.backendSerializeRequests ?? true;
  const minGapMs = ctx?.config.backendRequestMinGapMs ?? 250;
  const maxQueue = ctx?.config.backendRequestMaxQueue ?? 100;

  if (serialize) {
    if (backendRequestInFlight && backendRequestQueueDepth >= maxQueue) {
      throw new Error(`Backend request queue full (${maxQueue}): ${label}`);
    }
    while (backendRequestInFlight) {
      backendRequestQueueDepth += 1;
      await new Promise<void>((r) => setTimeout(r, 50));
      backendRequestQueueDepth -= 1;
    }
    const gap = Date.now() - lastBackendCallAtMs;
    if (gap < minGapMs) {
      await new Promise<void>((r) => setTimeout(r, minGapMs - gap));
    }
  }

  backendRequestInFlight = true;
  try {
    const result = await fn();
    lastBackendCallAtMs = Date.now();
    return result;
  } finally {
    backendRequestInFlight = false;
  }
};

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

const sendHeartbeat = async (ctx: RuntimeContext): Promise<void> => {
  let token = await getBotToken();
  if (!token) {
    // Attempt to mint a bot token if one is not available
    if (ctx.mintManager) {
      await ctx.mintManager.attemptMint("heartbeat_no_token").catch(() => {});
      token = await getBotToken();
    }
    if (!token) return;
  }
  try {
    await runBackendCall(
      "agent.heartbeat.mutate",
      () => (ctx.trpc as Record<string, any>)?.agent?.heartbeat?.mutate?.({}),
      ctx,
    );
    markWsActivity(ctx.wsStateContext, "heartbeat");
    ctx.debugSnapshot.lastHeartbeatError = null;
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error);
    ctx.debugSnapshot.lastHeartbeatError = {
      at: nowIso(),
      code: null,
      message,
    };
    await ctx.memory.recordWrite({
      type: "heartbeat_failed",
      at: nowIso(),
      error: message,
    });
  }
  await writeDebugSnapshot(ctx.ipcPaths, ctx.debugSnapshot);
};

// ---------------------------------------------------------------------------
// Event persistence
// ---------------------------------------------------------------------------

const appendEvent = async (
  ctx: RuntimeContext,
  event: unknown,
): Promise<void> => {
  const line = isRecord(event) ? event : { type: "unknown", at: nowIso() };
  ctx.misc.eventsPersistQueue = ctx.misc.eventsPersistQueue.then(async () => {
    await appendJsonLine(ctx.ipcPaths.eventsPath, line);
    ctx.misc.eventsLineCount += 1;
    if (ctx.misc.eventsLineCount > ctx.config.currentEventsMaxLines) {
      const raw = await fs
        .readFile(ctx.ipcPaths.eventsPath, "utf8")
        .catch(() => "");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      const keep = lines.slice(-ctx.config.currentEventsMaxLines);
      await fs.writeFile(ctx.ipcPaths.eventsPath, keep.join("\n") + "\n", "utf8");
      ctx.misc.eventsLineCount = keep.length;
    }
  });
  await ctx.misc.eventsPersistQueue;
};

// ---------------------------------------------------------------------------
// Write result to IPC
// ---------------------------------------------------------------------------

const writeResult = async (
  ctx: RuntimeContext,
  result: Record<string, unknown>,
): Promise<void> => {
  await appendJsonLine(ctx.ipcPaths.resultsPath, result);
  const outboxPath = path.join(
    ctx.ipcPaths.outboxDir,
    `${String(result.commandId ?? "unknown")}.json`,
  );
  await fs
    .writeFile(outboxPath, JSON.stringify(result, null, 2), "utf8")
    .catch(() => {});
  await touchWake(ctx.ipcPaths.wakePath);
};

// ---------------------------------------------------------------------------
// WS transport state handler
// ---------------------------------------------------------------------------

const handleTransportStateChange = (
  ctx: RuntimeContext,
  transportState: string,
): void => {
  const previousState = ctx.ws.lastWsTransportState;
  ctx.ws.lastWsTransportState = transportState;

  if (isConnectedSocketState(transportState)) {
    ctx.ws.wsPendingSinceIso = null;
    if (!isConnectedSocketState(previousState)) {
      ctx.misc.lastWsOpenTransitionAtMs = Date.now();
    }
  } else if (
    transportState === "pending" &&
    !ctx.ws.wsPendingSinceIso
  ) {
    ctx.ws.wsPendingSinceIso = nowIso();
  }

  const activityResult = markWsActivity(ctx.wsStateContext, `transport:${transportState}`);

  if (activityResult.stateChanged) {
    void ctx.memory.recordWrite({
      type: "ws_state_changed",
      at: nowIso(),
      previousState: activityResult.previousState,
      newState: activityResult.effectiveState,
      transportState,
    });
  }
};

// ---------------------------------------------------------------------------
// startRuntime
// ---------------------------------------------------------------------------

export const startRuntime = async (deps: RuntimeDeps): Promise<void> => {
  const { ctx } = deps;
  const intervals: ReturnType<typeof setInterval>[] = [];

  // -- Initial heartbeat
  await sendHeartbeat(ctx);
  await ctx.subscriptionManager?.bootstrap().catch(() => {});

  // -- Heartbeat interval
  intervals.push(
    setInterval(() => {
      void sendHeartbeat(ctx);
    }, ctx.config.heartbeatIntervalMs),
  );

  // -- WS pending watchdog
  intervals.push(
    setInterval(() => {
      void (async () => {
        if (ctx.ws.lastWsTransportState !== "pending") return;
        const pendingMs = toEpochMs(ctx.ws.wsPendingSinceIso);
        if (
          typeof pendingMs !== "number" ||
          Date.now() - pendingMs < ctx.config.wsPendingWatchdogMs
        ) {
          return;
        }
        const lastActivity = toEpochMs(ctx.ws.lastWsActivityAt);
        if (
          typeof lastActivity === "number" &&
          Date.now() - lastActivity <= ctx.config.wsActivityStaleMs
        ) {
          return;
        }
        await ctx.memory.recordWrite({
          type: "ws_pending_watchdog_reconnect",
          at: nowIso(),
          pendingSince: ctx.ws.wsPendingSinceIso,
          lastActivityAt: ctx.ws.lastWsActivityAt,
        });
        await ctx.authManager?.refreshIfNeeded();
      })().catch(() => {});
    }, 15_000),
  );

  // -- Temporal memory refresh interval
  intervals.push(
    setInterval(() => {
      void ctx.memory
        .refreshTemporalContext({ force: false, allowAgentCompression: false })
        .catch(() => {});
    }, ctx.config.memoryCompressionIntervalMs),
  );

  // -- Queue runner interval
  const queueTickMs = (() => {
    const queueConfig = isRecord(ctx.kthxConfig.queue)
      ? ctx.kthxConfig.queue
      : null;
    const tick =
      queueConfig &&
      typeof queueConfig.runnerTickMs === "number"
        ? queueConfig.runnerTickMs
        : 1000;
    return Math.max(250, Math.floor(tick as number));
  })();

  intervals.push(
    setInterval(() => {
      if (
        !ctx.queueManager?.isRunnerEnabled() ||
        ctx.queue.queueRunnerTickInFlight
      ) {
        return;
      }
      ctx.queue.queueRunnerTickInFlight = true;
      void ctx.queueManager
        .runnerTick()
        .catch(() => {})
        .finally(() => {
          ctx.queue.queueRunnerTickInFlight = false;
        });
    }, queueTickMs),
  );

  // -- Chat inbox poll interval
  let chatInterval: ReturnType<typeof setInterval> | null = null;
  if (ctx.config.chatRuntimeEnabled) {
    await ctx.memory.recordWrite({
      type: "chat_runtime_auto_reply_enabled",
      at: nowIso(),
      pollMs: ctx.config.chatRuntimePollMs,
    });
    void ctx.chatManager?.pollInbox().catch(() => {});
    chatInterval = setInterval(() => {
      void ctx.chatManager?.pollInbox().catch(() => {});
    }, ctx.config.chatRuntimePollMs);
  }

  // -- Queue runner initial state
  const queueConfig = isRecord(ctx.kthxConfig.queue)
    ? ctx.kthxConfig.queue
    : null;
  const queueEnabled = ctx.config.terminalTriggerOnly
    ? false
    : (queueConfig as Record<string, unknown> | null)?.autoRun !== false;
  ctx.queueManager?.setRunnerEnabled(queueEnabled);

  await ctx.memory.recordWrite({
    type: queueEnabled
      ? "inbox_auto_drain_enabled"
      : "inbox_auto_drain_disabled",
    at: nowIso(),
    reason: queueEnabled
      ? "app_queue_runner_enabled"
      : ctx.config.terminalTriggerOnly
        ? "terminal_only_enforced"
        : "queue_runner_disabled_by_config",
  });

  // -- Console
  ctx.consoleManager?.start();

  // -- Shutdown
  const shutdown = async (): Promise<void> => {
    intervals.forEach((i) => clearInterval(i));
    if (chatInterval) clearInterval(chatInterval);
    ctx.consoleManager?.dispose();
    ctx.chatManager?.dispose();
    ctx.queueManager?.dispose();
    ctx.subscriptionManager?.dispose();
    ctx.authManager?.dispose();
    ctx.mintManager?.dispose();
    ctx.grantManager?.dispose();
    ctx.openClawManager?.dispose();
    ctx.directiveManager?.dispose();
    ctx.eventsManager?.dispose();
    await ctx.memory.flushViewState().catch(() => {});
    await ctx.memory.flushMoodState().catch(() => {});
    await ctx.memory.flushTemporalContext().catch(() => {});
    try {
      (ctx.wsClient as any)?.close?.();
    } catch {
      // ignore
    }
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  // Keep process alive
  await new Promise(() => {});
};
