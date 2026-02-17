/**
 * Main entry point for the agent runtime microservice.
 *
 * Ported from agent-runtime.mjs lines 3808-3955, 22340-22503.
 * Handles CLI parsing, dotenv loading, config creation, MemoryStore init,
 * IPC setup, WS client creation, RuntimeContext assembly, and
 * delegation to startRuntime().
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { loadDotEnv } from "./config/dotenv.js";
import { createRuntimeConfig } from "./config/runtime.js";
import { loadOrInitKthxConfig, normalizeKthxConfig } from "./config/kthx.js";
import { MemoryStore } from "./memory/store.js";
import { createIpcPaths, initIpc, resetExecutionArtifactsOnStart } from "./ipc/ipc-paths.js";
import { createRealtimeClient } from "./ws/realtime-client.js";
import { createRuntimeHashCollector } from "./lib/hash.js";
import { RuntimeContext } from "./runtime-context.js";
import { ConsoleManager } from "./console/console-manager.js";
import { startRuntime, runBackendCall } from "./runtime.js";
import { trimEnv } from "./lib/env-parse.js";
import { isRecord } from "./lib/guards.js";
import { nowIso } from "./lib/text.js";
import {
  getBotToken,
  notifySupervisorBotTokenSet,
  notifySupervisorFatal,
} from "./auth/bot-token.js";
import type { KthxConfig } from "./types/config.js";
import type { AnyRouter } from "@trpc/server";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const parseCli = (): { cmd: "run" | "help" } => {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    return { cmd: "help" };
  }
  return { cmd: "run" };
};

const printHelp = (): void => {
  console.log(`Molkgram Agent Runtime (TypeScript)

Usage:
  node dist/main.js          Start the agent runtime
  node dist/main.js --help   Show this help

Env:
  MG_REALTIME_WS_URL (required)
  MG_AGENT_KEY_BOX (required)
  MG_BOT_SESSION_TOKEN (optional)
  MG_AGENT_HOME_DIR (optional, default ./kthx-agents)
  MG_AGENT_STATE_DIR (optional)
  MG_AGENT_CONSOLE (optional, default 0)
  ... (see agent-runtime.mjs help for full env reference)
`);
};

// ---------------------------------------------------------------------------
// Fatal handler
// ---------------------------------------------------------------------------

let fatalExitInProgress = false;

const handleFatalExit = async (
  source: string,
  error: unknown,
): Promise<void> => {
  if (fatalExitInProgress) return;
  fatalExitInProgress = true;
  const message = error instanceof Error ? error.message : String(error);
  const stack =
    error instanceof Error && typeof error.stack === "string"
      ? error.stack
      : null;
  notifySupervisorFatal(
    stack !== null
      ? { source, message, stack }
      : { source, message },
  );
  try {
    process.stderr.write(
      `[agent-runtime] fatal(${source}): ${message}\n`,
    );
    if (stack) process.stderr.write(`${stack}\n`);
  } catch {
    // ignore stderr failures during fatal exit
  }
  process.exit(1);
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  await loadDotEnv();
  const cli = parseCli();
  if (cli.cmd === "help") {
    printHelp();
    return;
  }

  const hasInteractivePty = Boolean(
    process.stdin.isTTY && process.stdout.isTTY,
  );
  const requirePty =
    (trimEnv("MG_AGENT_RUNTIME_REQUIRE_PTY") ?? "0") === "1" ||
    (trimEnv("MG_AGENT_SUPERVISOR_REQUIRE_PTY") ?? "0") === "1";
  if (requirePty && !hasInteractivePty) {
    console.error(
      "[agent-runtime] Interactive PTY required (REQUIRE_PTY is enabled).",
    );
    process.exitCode = 2;
    return;
  }

  // -- Bootstrap token
  const bootstrapToken = await getBotToken();
  if (bootstrapToken) {
    notifySupervisorBotTokenSet({
      token: bootstrapToken,
      expiresAt: trimEnv("MG_BOT_SESSION_EXPIRES_AT") ?? null,
    });
  }

  // -- Config
  const config = createRuntimeConfig();
  const collectRuntimeHashes = createRuntimeHashCollector({
    runtimeFilePath: config.runtimeFilePath,
    rootDir: config.runtimeRootDir,
    maxFiles: config.runtimeHashMaxFiles,
    extensions: config.runtimeHashExtensions,
  });

  // -- KthxConfig
  const kthxConfigInfo = await loadOrInitKthxConfig({
    configPath: config.kthxConfigPath,
    homeDir: config.agentHomeDir,
  }).catch(() => null);
  const kthxConfig: KthxConfig = isRecord(kthxConfigInfo?.config)
    ? (kthxConfigInfo!.config as KthxConfig)
    : normalizeKthxConfig({}, config.agentHomeDir);

  // -- MemoryStore
  const memory = new MemoryStore({
    stateDir: config.stateDir,
    rotateBytes: config.rotateBytes,
    tailMaxBytes: config.tailMaxBytes,
    tailMaxLines: config.tailMaxLines,
  });
  await memory.init();
  await memory.recordWrite({
    type: "runtime_paths",
    at: nowIso(),
    agentHomeDir: config.agentHomeDir,
    stateDir: config.stateDir,
    kthxConfigPath: config.kthxConfigPath,
  });

  // -- IPC
  const ipcPaths = createIpcPaths(config.stateDir);
  await initIpc(ipcPaths);
  if (config.executionStateResetOnStart) {
    const resetSummary = await resetExecutionArtifactsOnStart(ipcPaths);
    await memory.recordWrite({
      type: "execution_state_reset_on_start",
      at: nowIso(),
      ...resetSummary,
    });
  }
  if (config.eventsResetOnStart) {
    const stat = await fs.stat(ipcPaths.eventsPath).catch(() => null);
    if (stat && stat.size > 0) {
      const archiveName = `${new Date()
        .toISOString()
        .replaceAll(":", "-")}__events.jsonl`;
      const archivePath = path.join(ipcPaths.eventsHistoryDir, archiveName);
      await fs
        .rename(ipcPaths.eventsPath, archivePath)
        .catch(async () => {
          await fs.copyFile(ipcPaths.eventsPath, archivePath).catch(() => {});
          await fs.rm(ipcPaths.eventsPath, { force: true }).catch(() => {});
        });
      await fs.writeFile(ipcPaths.eventsPath, "", "utf8").catch(() => {});
    }
  }

  // -- WS Client
  const { wsClient, trpc } = createRealtimeClient<AnyRouter>({
    baseWsUrl: config.realtimeWsUrl,
    connectionId: config.connectionId,
    clientKeepAliveMs: config.heartbeatIntervalMs,
    getBotToken,
    getRuntimeIntegrity: async () => {
      const hashes = await collectRuntimeHashes();
      return hashes;
    },
  });

  // -- RuntimeContext
  const ctx = new RuntimeContext({
    config,
    kthxConfig,
    memory,
    ipcPaths,
  });
  ctx.wsClient = wsClient;
  ctx.trpc = trpc;
  ctx.collectRuntimeHashes = collectRuntimeHashes;

  // -- OpenClaw env overrides
  ctx.openclaw.openClawWakeUrl = trimEnv("MG_OPENCLAW_WAKE_URL") ?? null;
  ctx.openclaw.openClawWakeKey = trimEnv("MG_OPENCLAW_WAKE_KEY") ?? null;
  ctx.misc.controlKey = trimEnv("MG_AGENT_CONTROL_KEY") ?? null;

  // -- Console manager (wired up but started by runtime.ts)
  const consoleManager = new ConsoleManager({
    ctx,
    hasInteractivePty,
    ensureSocketBotToken: async (_reason: string) => null,
    sendHeartbeat: async () => {
      await runBackendCall(
        "agent.heartbeat.mutate",
        () => (trpc as Record<string, any>)?.agent?.heartbeat?.mutate?.({}),
        ctx,
      );
    },
  });
  ctx.consoleManager = consoleManager;

  // -- Record runtime seal
  await memory.recordWrite({
    type: "runtime_command_seal_initialized",
    at: nowIso(),
    runtimeSessionId: ctx.commandSeal.runtimeCommandSessionId,
  });

  // -- Start
  await startRuntime({
    ctx,
    hasInteractivePty,
  });
};

// ---------------------------------------------------------------------------
// Top-level error handlers
// ---------------------------------------------------------------------------

process.on("uncaughtException", (error: unknown) => {
  void handleFatalExit("uncaughtException", error);
});

process.on("unhandledRejection", (error: unknown) => {
  const exitOnReject =
    (trimEnv("MG_AGENT_EXIT_ON_UNHANDLED_REJECTION") ?? "0") === "1";
  if (exitOnReject) {
    void handleFatalExit("unhandledRejection", error);
  }
});

void main().catch((error: unknown) => {
  void handleFatalExit("main", error);
});
