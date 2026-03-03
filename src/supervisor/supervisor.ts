/**
 * Standalone process supervisor for the Molkgram agent runtime and companion
 * processes (chat bridge, health web).
 *
 * Ported from agent-ws-supervisor.mjs.
 *
 * Spawns child processes, restarts them on crash with exponential backoff,
 * handles IPC messages (bot token set/clear, fatal errors), manages a
 * file-based control plane, and writes status snapshots.
 *
 * Usage:
 *   node supervisor.js --script ./runtime.js
 *   node supervisor.js --script ./runtime.js --with-bridge --with-health
 *   node supervisor.js --control status all
 *   node supervisor.js --control update all
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { loadDotEnv } from "../config/dotenv.js";
import { loadOrInitKthxConfig } from "../config/kthx.js";
import { trimEnv, parseIntEnv } from "../lib/env-parse.js";
import { isRecord } from "../lib/guards.js";
import { sleep, jitterDelay } from "../lib/async.js";
import { nowIso } from "../lib/text.js";
import { parseIsoToMs } from "../lib/time.js";
import type { KthxUpdatesConfig } from "../types/config.js";
import { runAgentServiceUpdate } from "./update-manager.js";

/* Types */
type ParsedRun = { kind: "run"; runtimeScript: string; runtimeArgs: string[]; bridgeScript: string; healthScript: string; withBridge: boolean; withHealth: boolean; maxRestarts: number | null; keepBotTokenEnv: boolean; stripBotTokenEnv: boolean };
type ParsedControl = { kind: "control"; action: string; target: string };
type Parsed = ParsedRun | ParsedControl | { kind: "help" } | { kind: "error"; message: string };
type ManagedEntry = { name: string; script: string; args: string[]; desiredState: "running" | "stopped"; restartCount: number; nextStartAtMs: number; proc: ChildProcess | null; stopRequested: boolean; immediateRestart: boolean; lastStartAt: string | null; lastExit: Record<string, unknown> | null; lastError: string | null; disabledReason: string | null };

/* Constants & helpers */
const MANAGED_NAMES = new Set(["runtime", "bridge", "health", "all"]);
const ACTIONS = new Set(["status", "start", "stop", "restart", "shutdown", "update"]);
const BACKOFFS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const parseBoolEnv = (v: unknown): boolean => typeof v === "string" && v.trim() === "1";
const jitter = (ms: number): number => jitterDelay(ms, 0.25);
const formatExit = (code: number | null, signal: string | null): string => typeof signal === "string" && signal.length ? `signal=${signal}` : typeof code === "number" ? `code=${code}` : "code=<unknown>";
const normalizeTarget = (v: unknown): string | null => { if (typeof v !== "string") return null; const n = v.trim().toLowerCase(); return MANAGED_NAMES.has(n) ? n : null; };
const getOpt = (args: string[], names: string | string[]): string | null => { for (const name of Array.isArray(names) ? names : [names]) { const idx = args.indexOf(name); if (idx === -1) continue; const val = args[idx + 1]; if (typeof val === "string" && val.trim().length > 0 && !val.startsWith("--")) return val.trim(); } return null; };
const normalizeConnectionId = (v: unknown): string | null => { if (typeof v !== "string") return null; const t = v.trim(); if (!t.length || t.length > 200) return null; return /^[a-zA-Z0-9._:-]+$/u.test(t) ? t : null; };

/* State-dir helpers (synchronous FS for supervisor resilience) */
const resolveStateDir = (): string => {
  const configured = trimEnv("MG_AGENT_STATE_DIR");
  if (configured) return path.resolve(configured);
  const home = trimEnv("MG_AGENT_HOME_DIR")
    ? path.resolve(trimEnv("MG_AGENT_HOME_DIR") ?? "kthx-agents")
    : path.resolve(process.cwd(), "kthx-agents");
  return path.resolve(home, "state");
};
const resolveAgentHomeDir = (): string => {
  const configured = trimEnv("MG_AGENT_HOME_DIR");
  if (configured) return path.resolve(configured);
  return path.resolve(process.cwd(), "kthx-agents");
};
const resolveKthxConfigPath = (homeDir: string): string => {
  const configured = trimEnv("MG_AGENT_KTHX_CONFIG_PATH");
  if (configured) return path.resolve(configured);
  return path.resolve(homeDir, "config.json");
};
const debugPath = (stateDir: string, name: string): string => path.join(stateDir, "ipc", "debug", name);
const persistedAgentKeyBoxPath = (stateDir: string): string =>
  path.join(stateDir, "ipc", "auth", "agent-key-box.json");
const writeJsonSync = (filePath: string, payload: unknown): boolean => { try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8"); return true; } catch { return false; } };

const appendDebug = (stateDir: string, payload: Record<string, unknown>): void => {
  try { const dir = debugPath(stateDir, ""); fs.mkdirSync(dir, { recursive: true }); const rec = { at: nowIso(), ...payload }; fs.appendFileSync(path.join(dir, "supervisor-exit.jsonl"), `${JSON.stringify(rec)}\n`, "utf8"); fs.writeFileSync(path.join(dir, "supervisor-exit-latest.json"), JSON.stringify(rec, null, 2), "utf8"); } catch { /* best-effort */ }
};
const writeBotSessionFile = (filePath: string, payload: unknown): boolean => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tempPath, filePath);
    } catch {
      fs.rmSync(tempPath, { force: true });
      return false;
    }
    return true;
  } catch {
    return false;
  }
};

const readPersistedAgentKeyBoxOwnerPid = (stateDir: string): number | null => {
  const filePath = persistedAgentKeyBoxPath(stateDir);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const pid = parsed.ownerSupervisorPid;
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) return pid;
    return null;
  } catch {
    return null;
  }
};

const readPersistedAgentKeyBoxForOwner = (
  stateDir: string,
  ownerSupervisorPid: number,
): string | null => {
  const filePath = persistedAgentKeyBoxPath(stateDir);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const persistedOwnerPid = parsed.ownerSupervisorPid;
    if (
      typeof persistedOwnerPid !== "number" ||
      !Number.isInteger(persistedOwnerPid) ||
      persistedOwnerPid !== ownerSupervisorPid
    ) {
      return null;
    }
    const keyBox =
      typeof parsed.agentKeyBox === "string" ? parsed.agentKeyBox.trim() : "";
    return keyBox.length > 0 ? keyBox : null;
  } catch {
    return null;
  }
};

const clearPersistedAgentKeyBoxFile = (stateDir: string, reason: string): void => {
  const filePath = persistedAgentKeyBoxPath(stateDir);
  try {
    if (!fs.existsSync(filePath)) return;
    fs.rmSync(filePath, { force: true });
    console.warn(`[supervisor] cleared persisted agent key-box (${reason})`);
  } catch {
    // best-effort
  }
};

/* Lock helpers */
type LockRecord = { pid: number; script: string | null; connectionId: string | null; startedAt: string | null };
const readLock = (lockPath: string): LockRecord | null => { try { if (!fs.existsSync(lockPath)) return null; const p = JSON.parse(fs.readFileSync(lockPath, "utf8")) as unknown; if (!isRecord(p)) return null; const pid = typeof p.pid === "number" && Number.isInteger(p.pid) ? p.pid : null; if (!pid) return null; return { pid, script: typeof p.script === "string" ? p.script : null, connectionId: typeof p.connectionId === "string" ? p.connectionId : null, startedAt: typeof p.startedAt === "string" ? p.startedAt : null }; } catch { return null; } };
const isPidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e: unknown) { return isRecord(e) && e.code === "EPERM"; } };
const acquireLock = (lockPath: string, payload: Record<string, unknown>): { ok: boolean; conflict: LockRecord | null } => {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2), { encoding: "utf8", flag: "wx" }); return { ok: true, conflict: null }; } catch (e: unknown) { if (isRecord(e) && e.code !== "EEXIST") return { ok: false, conflict: null }; const ex = readLock(lockPath); if (ex && isPidAlive(ex.pid) && ex.pid !== process.pid) return { ok: false, conflict: ex }; try { fs.rmSync(lockPath, { force: true }); } catch { /* retry */ } }
  }
  return { ok: false, conflict: readLock(lockPath) };
};

/* IPC message parsers */
const parseBotTokenMsg = (msg: unknown): { action: "set"; token: string; expiresAt: string | null } | { action: "clear"; reason: string } | null => {
  if (!isRecord(msg) || msg.type !== "mg_runtime_bot_token") return null;
  if (msg.action === "set") { const t = typeof msg.token === "string" ? msg.token.trim() : ""; if (!t) return null; return { action: "set", token: t, expiresAt: typeof msg.expiresAt === "string" && msg.expiresAt.trim().length ? msg.expiresAt.trim() : null }; }
  if (msg.action === "clear") return { action: "clear", reason: typeof msg.reason === "string" && msg.reason.trim().length ? msg.reason.trim() : "unknown" };
  return null;
};
const parseFatalMsg = (msg: unknown): { source: string; message: string; at: string | null; stack: string | null } | null => {
  if (!isRecord(msg) || msg.type !== "mg_runtime_fatal") return null;
  return { source: typeof msg.source === "string" && msg.source.trim().length ? msg.source.trim() : "unknown", message: typeof msg.message === "string" && msg.message.trim().length ? msg.message.trim() : "fatal error", at: typeof msg.at === "string" && msg.at.trim().length ? msg.at.trim() : null, stack: typeof msg.stack === "string" && msg.stack.trim().length ? msg.stack : null };
};

/* Argument parsing */
const parseArgs = (argv: string[]): Parsed => {
  const rest = argv.slice(2);
  if (rest.includes("--help") || rest.includes("-h")) return { kind: "help" };

  const keepBotTokenEnv = rest.includes("--keep-bot-token-env");
  const stripBotTokenEnv = rest.includes("--strip-bot-token-env");
  const withAll = rest.includes("--all");
  const withBridge = withAll || rest.includes("--with-bridge") || parseBoolEnv(process.env.MG_AGENT_SUPERVISOR_ENABLE_BRIDGE);
  const withHealth = withAll || rest.includes("--with-health") || parseBoolEnv(process.env.MG_AGENT_SUPERVISOR_ENABLE_HEALTH_WEB);

  const ctlIdx = rest.indexOf("--control");
  if (ctlIdx !== -1) {
    const actionRaw = rest[ctlIdx + 1];
    const action = typeof actionRaw === "string" ? actionRaw.trim().toLowerCase() : "";
    if (!ACTIONS.has(action)) return { kind: "error", message: "Control action must be one of: status | start | stop | restart | shutdown | update" };
    const target = action === "status" || action === "shutdown"
      ? normalizeTarget(rest[ctlIdx + 2] ?? "all")
      : normalizeTarget(rest[ctlIdx + 2] ?? "");
    if (!target) return { kind: "error", message: "Control target must be one of: runtime | bridge | health | all" };
    if (action === "shutdown" && target !== "all") return { kind: "error", message: "Control target for shutdown must be: all" };
    if (action === "update" && target !== "all") return { kind: "error", message: "Control target for update must be: all" };
    return { kind: "control", action, target };
  }

  const runtimeScript = getOpt(rest, ["--runtime-script", "--script"]);
  if (!runtimeScript) return { kind: "error", message: "Missing --script <path-to-runtime-script>" };

  const bridgeScript = getOpt(rest, "--bridge-script") ?? path.resolve(process.cwd(), "kthx-agents", "scripts", "agent-chat-bridge.mjs");
  const healthScript = getOpt(rest, "--health-script") ?? path.resolve(process.cwd(), "kthx-agents", "scripts", "agent-health-web.mjs");

  const passthroughIdx = rest.indexOf("--");
  const runtimeArgs = passthroughIdx === -1 ? [] : rest.slice(passthroughIdx + 1);

  const maxRestartsRaw = getOpt(rest, "--max-restarts");
  const maxRestarts = maxRestartsRaw ? Number.parseInt(maxRestartsRaw, 10) : null;

  return {
    kind: "run",
    runtimeScript,
    runtimeArgs,
    bridgeScript,
    healthScript,
    withBridge,
    withHealth,
    maxRestarts: typeof maxRestarts === "number" && Number.isFinite(maxRestarts) && maxRestarts >= 0 ? maxRestarts : null,
    keepBotTokenEnv,
    stripBotTokenEnv,
  };
};

/* Control mode */
const runControlMode = (parsed: ParsedControl): void => {
  const stateDir = resolveStateDir();
  const controlPath = debugPath(stateDir, "supervisor-control.jsonl");
  const statusPath = debugPath(stateDir, "supervisor-status.json");

  if (parsed.action === "status") {
    try {
      const raw = fs.readFileSync(statusPath, "utf8");
      console.log(raw);
    } catch {
      console.error(`[supervisor] status unavailable. Expected ${statusPath}`);
      process.exitCode = 2;
    }
    return;
  }

  try {
    fs.mkdirSync(path.dirname(controlPath), { recursive: true });
    const record = {
      at: nowIso(),
      id: `ctl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      action: parsed.action,
      target: parsed.target,
      pid: process.pid,
      source: "cli",
    };
    fs.appendFileSync(controlPath, `${JSON.stringify(record)}\n`, "utf8");
    console.log(`[supervisor] queued ${parsed.action} ${parsed.target}`);
  } catch {
    console.error(`[supervisor] failed to append control command at ${controlPath}`);
    process.exitCode = 2;
  }
};

/* Main supervisor loop */
const main = async (): Promise<void> => {
  await loadDotEnv();

  const parsed = parseArgs(process.argv);
  if (parsed.kind === "help") {
    console.log(
      "agent-ws-supervisor --script <path> [--with-bridge] [--with-health] [--all] [--control <action> <target>] (actions: status|start|stop|restart|shutdown|update)",
    );
    return;
  }
  if (parsed.kind === "error") { console.error(`[supervisor] ${parsed.message}`); process.exitCode = 2; return; }
  if (parsed.kind === "control") { runControlMode(parsed); return; }

  const POLL_MS = 500;
  const TOKEN_EXPIRY_SKEW = parseIntEnv("MG_AGENT_BOT_TOKEN_EXPIRY_SKEW_MS", 15_000);
  const hasInteractivePty = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  const stateDir = resolveStateDir();
  const homeDir = resolveAgentHomeDir();
  const kthxConfigPath = resolveKthxConfigPath(homeDir);
  const botTokenPath = path.join(stateDir, "ipc", "auth", "bot-session.json");
  const connIdPath = debugPath(stateDir, "supervisor.connection-id");
  const controlPath = debugPath(stateDir, "supervisor-control.jsonl");
  const statusPath = debugPath(stateDir, "supervisor-status.json");
  const lockPath = debugPath(stateDir, "supervisor.lock.json");

  const kthxConfigInfo = await loadOrInitKthxConfig({
    configPath: kthxConfigPath,
    homeDir,
  }).catch(() => null);
  const updatesConfig: KthxUpdatesConfig = kthxConfigInfo?.config?.updates ?? {
    enabled: true,
    autoUpdateOnStart: true,
    restartAfterUpdate: true,
    haltOnFailure: false,
    repoDir: "",
    remote: "origin",
    branch: "main",
    allowDirtyWorkingTree: false,
    runInstall: true,
    runBuild: true,
    packageManagerExecutable: "pnpm",
    packageManagerUseNpmExecFallback: true,
    timeoutMs: 300_000,
  };

  // Resolve stable connection id
  const configuredConnId = normalizeConnectionId(process.env.MG_REALTIME_CONNECTION_ID);
  let runtimeConnId: string;
  if (configuredConnId) {
    runtimeConnId = configuredConnId;
  } else {
    try {
      const persisted = fs.existsSync(connIdPath) ? normalizeConnectionId(fs.readFileSync(connIdPath, "utf8")) : null;
      runtimeConnId = persisted ?? `agent-supervisor-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    } catch {
      runtimeConnId = `agent-supervisor-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
    try { fs.mkdirSync(path.dirname(connIdPath), { recursive: true }); fs.writeFileSync(connIdPath, `${runtimeConnId}\n`, "utf8"); } catch { /* best-effort */ }
  }

  // Acquire lock
  const lockResult = acquireLock(lockPath, { pid: process.pid, script: path.resolve(parsed.runtimeScript), connectionId: runtimeConnId, startedAt: nowIso(), cwd: process.cwd() });
  if (!lockResult.ok) {
    if (lockResult.conflict) console.error(`[supervisor] another supervisor is already running (pid=${lockResult.conflict.pid})`);
    else console.error("[supervisor] unable to acquire lock");
    process.exitCode = 2;
    return;
  }

  const persistedOwnerPid = readPersistedAgentKeyBoxOwnerPid(stateDir);
  if (persistedOwnerPid !== process.pid) {
    clearPersistedAgentKeyBoxFile(
      stateDir,
      persistedOwnerPid
        ? `owner_pid_mismatch owner=${persistedOwnerPid} current=${process.pid}`
        : "owner_pid_missing_or_legacy",
    );
  }

  // Build managed process entries
  const entries: { name: string; script: string; args: string[]; enabled: boolean }[] = [
    { name: "runtime", script: path.resolve(parsed.runtimeScript), args: parsed.runtimeArgs, enabled: true },
    { name: "bridge", script: path.resolve(parsed.bridgeScript), args: [], enabled: parsed.withBridge },
    { name: "health", script: path.resolve(parsed.healthScript), args: [], enabled: parsed.withHealth },
  ];

  const managed = new Map<string, ManagedEntry>();
  for (const e of entries) {
    if (!e.enabled) continue;
    const exists = fs.existsSync(e.script);
    if (!exists) console.warn(`[supervisor] ${e.name} script not found; disabled (${e.script})`);
    managed.set(e.name, {
      name: e.name, script: e.script, args: e.args,
      desiredState: exists ? "running" : "stopped",
      restartCount: 0, nextStartAtMs: exists ? Date.now() : Infinity,
      proc: null, stopRequested: false, immediateRestart: false,
      lastStartAt: null, lastExit: null, lastError: exists ? null : "script_missing",
      disabledReason: exists ? null : "script_missing",
    });
  }

  if (!managed.has("runtime")) { console.error("[supervisor] runtime process is required."); process.exitCode = 2; return; }

  // State
  let stopping = false;
  let botToken: string | null = null;
  let botTokenExpiresAt: string | null = null;
  let fatalExitCode: number | null = null;
  let controlReadOffset = 0;
  let updateRequested = false;
  let updateInProgress = false;
  let updateRestartTargets: string[] = [];
  let lastUpdateAt: string | null = null;
  let lastUpdateStatus: "idle" | "success" | "failed" | "running" = "idle";
  let lastUpdateError: string | null = null;
  const seenControlIds = new Set<string>();

  try {
    if (fs.existsSync(controlPath)) controlReadOffset = fs.statSync(controlPath).size;
  } catch { /* ignore */ }

  appendDebug(stateDir, { type: "supervisor_boot", connectionId: runtimeConnId, managedProcesses: Array.from(managed.keys()) });
  writeBotSessionFile(botTokenPath, { updatedAt: nowIso(), source: "agent-ws-supervisor", token: null, expiresAt: null, connectionId: runtimeConnId, state: "cleared", reason: "supervisor_boot" });

  // Status writer
  const writeStatus = (reason: string): void => {
    writeJsonSync(statusPath, {
      updatedAt: nowIso(), reason, pid: process.pid, connectionId: runtimeConnId,
      botToken: { present: typeof botToken === "string" && botToken.length > 0, expiresAt: botTokenExpiresAt },
      updates: {
        enabled: updatesConfig.enabled,
        autoUpdateOnStart: updatesConfig.autoUpdateOnStart,
        restartAfterUpdate: updatesConfig.restartAfterUpdate,
        inProgress: updateInProgress,
        requested: updateRequested,
        lastUpdateAt,
        lastUpdateStatus,
        lastUpdateError,
      },
      processes: Array.from(managed.values()).map((m) => ({
        name: m.name, script: m.script, pid: m.proc?.pid ?? null,
        desiredState: m.desiredState, running: Boolean(m.proc), restartCount: m.restartCount,
        lastStartAt: m.lastStartAt, lastExit: m.lastExit, lastError: m.lastError,
        disabledReason: m.disabledReason, stopRequested: m.stopRequested,
      })),
    });
  };

  // Stop / restart helpers
  const stopEntry = (entry: ManagedEntry, reason: string): void => {
    if (!entry.proc || entry.stopRequested) return;
    entry.stopRequested = true;
    console.warn(`[supervisor] stopping ${entry.name} (${reason})`);
    try { entry.proc.kill("SIGTERM"); } catch { /* ignore */ }
  };

  const runConfiguredUpdate = async (reason: string): Promise<boolean> => {
    if (!updatesConfig.enabled) {
      console.log("[supervisor] update skipped: updates.enabled=false");
      return true;
    }

    updateInProgress = true;
    lastUpdateStatus = "running";
    lastUpdateError = null;
    writeStatus(`update_started:${reason}`);
    console.log(
      `[supervisor] running update reason=${reason} remote=${updatesConfig.remote} branch=${updatesConfig.branch}`,
    );

    const result = await runAgentServiceUpdate({
      updates: updatesConfig,
      runtimeScriptPath: parsed.runtimeScript,
    });
    updateInProgress = false;
    lastUpdateAt = nowIso();

    if (!result.ok) {
      lastUpdateStatus = "failed";
      lastUpdateError = result.error;
      console.error(`[supervisor] update failed: ${result.error ?? "unknown error"}`);
      writeStatus("update_failed");
      return false;
    }

    lastUpdateStatus = "success";
    lastUpdateError = null;
    console.log(`[supervisor] update complete repo=${result.repoDir}`);
    writeStatus("update_success");
    return true;
  };

  const requestUpdate = (reason: string): void => {
    if (!updatesConfig.enabled) {
      console.log("[supervisor] update request ignored: updates.enabled=false");
      return;
    }
    if (updateRequested || updateInProgress) {
      console.log("[supervisor] update already pending/in-progress");
      return;
    }
    updateRequested = true;
    updateRestartTargets = Array.from(managed.values())
      .filter((entry) => entry.desiredState === "running")
      .map((entry) => entry.name);
    for (const entry of managed.values()) {
      entry.desiredState = "stopped";
      entry.nextStartAtMs = Infinity;
      stopEntry(entry, `update_requested:${reason}`);
    }
    writeStatus(`update_requested:${reason}`);
  };

  const applyControl = (action: string, target: string): void => {
    if (action === "shutdown") {
      stopping = true;
      for (const e of managed.values()) { e.desiredState = "stopped"; e.nextStartAtMs = Infinity; stopEntry(e, "shutdown"); }
      writeStatus("control_shutdown");
      return;
    }
    if (action === "update") {
      requestUpdate("control");
      return;
    }
    const targets = target === "all" ? Array.from(managed.values()) : (managed.has(target) ? [managed.get(target)!] : []);
    for (const e of targets) {
      if (action === "stop") { e.desiredState = "stopped"; e.nextStartAtMs = Infinity; stopEntry(e, "stop"); }
      else if (action === "start") { e.desiredState = "running"; e.disabledReason = null; e.immediateRestart = true; e.nextStartAtMs = Date.now(); if (!e.proc) e.stopRequested = false; }
      else if (action === "restart") { e.desiredState = "running"; e.disabledReason = null; e.immediateRestart = true; e.nextStartAtMs = Date.now(); if (e.proc) stopEntry(e, "restart"); else e.stopRequested = false; }
    }
    writeStatus(`control_${action}`);
  };

  // Poll control file
  const pollControl = (): void => {
    try {
      if (!fs.existsSync(controlPath)) return;
      const size = fs.statSync(controlPath).size;
      if (size <= controlReadOffset) { if (size < controlReadOffset) controlReadOffset = 0; return; }
      const fd = fs.openSync(controlPath, "r");
      try {
        const buf = Buffer.alloc(size - controlReadOffset);
        fs.readSync(fd, buf, 0, buf.length, controlReadOffset);
        controlReadOffset = size;
        for (const line of buf.toString("utf8").split(/\r?\n/u).map((l) => l.trim()).filter((l) => l.length > 0)) {
          try {
            const obj = JSON.parse(line) as unknown;
            if (!isRecord(obj)) continue;
            const id = typeof obj.id === "string" ? obj.id : null;
            if (id && seenControlIds.has(id)) continue;
            if (id) seenControlIds.add(id);
            const action = typeof obj.action === "string" ? obj.action.trim().toLowerCase() : "";
            const target = normalizeTarget(obj.target ?? "all");
            if (!ACTIONS.has(action) || !target) continue;
            console.log(`[supervisor] control action=${action} target=${target}`);
            applyControl(action, target);
          } catch { /* skip bad lines */ }
        }
      } finally { fs.closeSync(fd); }
    } catch { /* best-effort */ }
  };

  // Build child environment
  const buildChildEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    env.MG_REALTIME_CONNECTION_ID = runtimeConnId;
    env.MG_AGENT_SUPERVISOR_PID = String(process.pid);
    if (!env.MG_AGENT_HOME_DIR?.trim()) env.MG_AGENT_HOME_DIR = path.resolve(process.cwd(), "kthx-agents");
    if (!env.MG_AGENT_STATE_DIR?.trim()) env.MG_AGENT_STATE_DIR = path.join(env.MG_AGENT_HOME_DIR!, "state");
    return env;
  };

  const prepareRuntimeEnv = (env: NodeJS.ProcessEnv): { ok: boolean; error?: string } => {
    if (!env.MG_AGENT_CONSOLE?.trim()) env.MG_AGENT_CONSOLE = hasInteractivePty ? "1" : "0";
    // Single writer for bot-session token file to avoid runtime/supervisor races.
    if (!env.MG_AGENT_BOT_SESSION_FILE_WRITER?.trim()) env.MG_AGENT_BOT_SESSION_FILE_WRITER = "supervisor";

    if (!env.MG_AGENT_KEY_BOX?.trim()) {
      const persistedKeyBox = readPersistedAgentKeyBoxForOwner(stateDir, process.pid);
      if (persistedKeyBox) {
        env.MG_AGENT_KEY_BOX = persistedKeyBox;
        console.log("[supervisor] Loaded MG_AGENT_KEY_BOX from persisted state for runtime bootstrap");
      }
    }

    const hasInviteToken = Boolean(env.MG_OWNER_INVITE_TOKEN?.trim());
    const hasKeyAuthSource = Boolean(env.MG_AGENT_KEY_BOX?.trim() || env.MG_AGENT_KEY?.trim());
    if (hasInviteToken && hasKeyAuthSource) {
      delete env.MG_OWNER_INVITE_TOKEN;
      delete env.MG_OWNER_HANDLE;
      delete env.MG_OWNER_NAME;
      console.log(
        "[supervisor] Ignoring MG_OWNER_INVITE_TOKEN because key auth is already available.",
      );
    }

    const forward = parsed.stripBotTokenEnv ? false : parsed.keepBotTokenEnv;
    if (!forward) { delete env.MG_BOT_SESSION_TOKEN; delete env.MG_BOT_SESSION_EXPIRES_AT; }

    // Reuse in-memory token if available and not expired
    if (botToken && !parsed.stripBotTokenEnv) {
      const exMs = parseIsoToMs(botTokenExpiresAt);
      if (typeof exMs === "number" && Date.now() + TOKEN_EXPIRY_SKEW >= exMs) {
        botToken = null; botTokenExpiresAt = null;
      } else {
        env.MG_BOT_SESSION_TOKEN = botToken;
        if (botTokenExpiresAt) env.MG_BOT_SESSION_EXPIRES_AT = botTokenExpiresAt;
        console.log("[supervisor] reusing in-memory bot session token");
      }
    }

    if (!env.MG_AGENT_KEY_BOX?.trim() && !env.MG_AGENT_KEY?.trim()) {
      // Allow startup without MG_AGENT_KEY_BOX when MG_OWNER_INVITE_TOKEN is set.
      // The runtime will handle first-time registration and obtain the key itself.
      if (!env.MG_OWNER_INVITE_TOKEN?.trim()) {
        return { ok: false, error: "[supervisor] missing agent auth (set MG_AGENT_KEY_BOX / MG_AGENT_KEY, or MG_OWNER_INVITE_TOKEN for first-time registration)" };
      }
      console.log("[supervisor] MG_AGENT_KEY_BOX not set — runtime will attempt first-time registration via MG_OWNER_INVITE_TOKEN");
    }
    return { ok: true };
  };

  const scheduleRestart = (entry: ManagedEntry, reason: string): void => {
    if (entry.immediateRestart) { entry.immediateRestart = false; entry.nextStartAtMs = Date.now(); return; }
    if (parsed.maxRestarts !== null && entry.restartCount > parsed.maxRestarts) {
      entry.desiredState = "stopped"; entry.nextStartAtMs = Infinity;
      entry.lastError = `max_restarts_reached(${parsed.maxRestarts})`;
      console.warn(`[supervisor] ${entry.name} max restarts reached`);
      return;
    }
    const idx = Math.min(Math.max(entry.restartCount - 1, 0), BACKOFFS_MS.length - 1);
    const delay = jitter(BACKOFFS_MS[idx] ?? 30_000);
    entry.nextStartAtMs = Date.now() + delay;
    console.warn(`[supervisor] ${entry.name} restart in ${delay}ms (${reason})`);
  };

  // Spawn a managed process
  const startProcess = (entry: ManagedEntry): void => {
    if (entry.proc || entry.desiredState !== "running" || stopping) return;
    if (!Number.isFinite(entry.nextStartAtMs) || Date.now() < entry.nextStartAtMs) return;
    if (!fs.existsSync(entry.script)) {
      entry.desiredState = "stopped"; entry.disabledReason = "script_missing";
      entry.lastError = `script_not_found:${entry.script}`;
      writeStatus("script_missing"); return;
    }

    const childEnv = buildChildEnv();
    if (entry.name === "runtime") {
      const result = prepareRuntimeEnv(childEnv);
      if (!result.ok) { fatalExitCode = 2; stopping = true; entry.lastError = result.error ?? "env_error"; console.error(result.error); return; }
    }

    const canReadStdin = entry.name === "runtime" && (hasInteractivePty || childEnv.MG_AGENT_CONSOLE_ALLOW_NON_TTY?.trim() === "1");
    const proc = spawn(process.execPath, [entry.script, ...entry.args], {
      stdio: [canReadStdin ? "inherit" : "ignore", "inherit", "inherit", "ipc"],
      env: childEnv,
    });
    entry.proc = proc;
    entry.stopRequested = false;
    entry.lastStartAt = nowIso();
    entry.lastError = null;
    entry.disabledReason = null;
    console.log(`[supervisor] starting ${entry.name} ${entry.script}`);
    appendDebug(stateDir, { type: "child_started", process: entry.name, pid: proc.pid ?? null, restartCount: entry.restartCount, connectionId: runtimeConnId });
    writeStatus("child_started");

    // IPC messages from runtime
    proc.on("message", (msg: unknown) => {
      if (entry.name !== "runtime") return;
      const fatal = parseFatalMsg(msg);
      if (fatal) {
        console.error(`[supervisor] runtime fatal source=${fatal.source} message=${fatal.message}`);
        if (fatal.stack) console.error(fatal.stack);
        appendDebug(stateDir, { type: "child_runtime_fatal_ipc", ...fatal, connectionId: runtimeConnId });
        return;
      }
      const tokenMsg = parseBotTokenMsg(msg);
      if (!tokenMsg) return;
      if (tokenMsg.action === "set") {
        const exMs = parseIsoToMs(tokenMsg.expiresAt);
        if (typeof exMs === "number" && Date.now() + TOKEN_EXPIRY_SKEW >= exMs) { botToken = null; botTokenExpiresAt = null; return; }
        botToken = tokenMsg.token; botTokenExpiresAt = tokenMsg.expiresAt;
        writeBotSessionFile(botTokenPath, { updatedAt: nowIso(), source: "agent-ws-supervisor", token: botToken, expiresAt: botTokenExpiresAt, connectionId: runtimeConnId, state: "active" });
        writeStatus("bot_token_set");
      } else {
        botToken = null; botTokenExpiresAt = null;
        writeBotSessionFile(botTokenPath, { updatedAt: nowIso(), source: "agent-ws-supervisor", token: null, expiresAt: null, connectionId: runtimeConnId, state: "cleared", reason: tokenMsg.reason });
        console.warn(`[supervisor] cleared bot session token (${tokenMsg.reason})`);
        writeStatus("bot_token_cleared");
      }
    });

    proc.once("exit", (code, signal) => {
      entry.proc = null; entry.stopRequested = false; entry.restartCount += 1;
      const summary = formatExit(code, signal);
      entry.lastExit = { at: nowIso(), code, signal, summary };
      console.warn(`[supervisor] ${entry.name} exited (${summary})`);
      appendDebug(stateDir, { type: "child_exited", process: entry.name, code, signal, summary, connectionId: runtimeConnId });
      if (!stopping && entry.desiredState === "running") scheduleRestart(entry, "exit");
      writeStatus("child_exited");
    });

    proc.once("error", (err) => {
      entry.lastError = err instanceof Error ? err.message : String(err);
      writeStatus("child_error");
    });
  };

  // Signal handling
  const onSignal = (sig: string): void => {
    stopping = true;
    console.warn(`[supervisor] received ${sig}; stopping managed processes`);
    for (const e of managed.values()) { e.desiredState = "stopped"; e.nextStartAtMs = Infinity; stopEntry(e, sig); }
    writeStatus("signal_stop");
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  // Main loop
  try {
    writeStatus("boot");
    if (updatesConfig.enabled && updatesConfig.autoUpdateOnStart) {
      const updateOk = await runConfiguredUpdate("startup_auto");
      if (!updateOk && updatesConfig.haltOnFailure) {
        fatalExitCode = 2;
        stopping = true;
      }
    }
    while (true) {
      if (!stopping) pollControl();
      if (updateRequested && !updateInProgress) {
        const allStopped = Array.from(managed.values()).every((entry) => !entry.proc);
        if (allStopped) {
          updateRequested = false;
          const updateOk = await runConfiguredUpdate("control");
          if (!updateOk && updatesConfig.haltOnFailure) {
            fatalExitCode = 2;
            stopping = true;
          }
          if (updatesConfig.restartAfterUpdate && !stopping) {
            for (const name of updateRestartTargets) {
              const entry = managed.get(name);
              if (!entry) continue;
              entry.desiredState = "running";
              entry.immediateRestart = true;
              entry.nextStartAtMs = Date.now();
              entry.stopRequested = false;
            }
          }
          updateRestartTargets = [];
          writeStatus("update_cycle_finished");
        }
      }
      for (const e of managed.values()) {
        if (e.desiredState !== "running") { stopEntry(e, "desired_stopped"); continue; }
        if (!e.proc) startProcess(e);
      }
      if (stopping && Array.from(managed.values()).every((e) => !e.proc)) break;
      await sleep(POLL_MS);
    }
  } finally {
    writeBotSessionFile(botTokenPath, { updatedAt: nowIso(), source: "agent-ws-supervisor", token: null, expiresAt: null, connectionId: runtimeConnId, state: "cleared", reason: "supervisor_exit" });
    try { const lock = readLock(lockPath); if (!lock || lock.pid === process.pid) fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ }
    writeStatus("shutdown");
  }

  if (typeof fatalExitCode === "number" && fatalExitCode > 0) process.exitCode = fatalExitCode;
};

await main();
