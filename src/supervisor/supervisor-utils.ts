import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { jitterDelay } from "../lib/async.js";
import { trimEnv } from "../lib/env-parse.js";
import { isRecord } from "../lib/guards.js";
import { nowIso } from "../lib/text.js";

export type ParsedRun = {
  kind: "run";
  runtimeScript: string;
  runtimeArgs: string[];
  bridgeScript: string;
  healthScript: string;
  withBridge: boolean;
  withHealth: boolean;
  maxRestarts: number | null;
  keepBotTokenEnv: boolean;
  stripBotTokenEnv: boolean;
};

export type ParsedControl = { kind: "control"; action: string; target: string };
export type SupervisorControlRecord = {
  at: string;
  id: string;
  action: string;
  target: string;
  pid: number;
  source: string;
};

export type Parsed =
  | ParsedRun
  | ParsedControl
  | { kind: "help" }
  | { kind: "error"; message: string };

const MANAGED_NAMES = new Set(["runtime", "bridge", "health", "all"]);
export const ACTIONS = new Set([
  "status",
  "start",
  "stop",
  "restart",
  "shutdown",
  "update",
]);
export const BACKOFFS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const parseBoolEnv = (value: unknown): boolean =>
  typeof value === "string" && value.trim() === "1";

export const jitter = (ms: number): number => jitterDelay(ms, 0.25);

export const formatExit = (
  code: number | null,
  signal: string | null,
): string =>
  typeof signal === "string" && signal.length
    ? `signal=${signal}`
    : typeof code === "number"
      ? `code=${code}`
      : "code=<unknown>";

export const normalizeTarget = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return MANAGED_NAMES.has(normalized) ? normalized : null;
};

const getOpt = (args: string[], names: string | string[]): string | null => {
  for (const name of Array.isArray(names) ? names : [names]) {
    const idx = args.indexOf(name);
    if (idx === -1) continue;
    const value = args[idx + 1];
    if (
      typeof value === "string" &&
      value.trim().length > 0 &&
      !value.startsWith("--")
    ) {
      return value.trim();
    }
  }
  return null;
};

export const normalizeConnectionId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.length || trimmed.length > 200) return null;
  return /^[a-zA-Z0-9._:-]+$/u.test(trimmed) ? trimmed : null;
};

export const resolveStateDir = (): string => {
  const configured = trimEnv("MG_AGENT_STATE_DIR");
  if (configured) return path.resolve(configured);
  const home = trimEnv("MG_AGENT_HOME_DIR")
    ? path.resolve(trimEnv("MG_AGENT_HOME_DIR") ?? "kthx-agents")
    : path.resolve(process.cwd(), "kthx-agents");
  return path.resolve(home, "state");
};

export const resolveAgentHomeDir = (): string => {
  const configured = trimEnv("MG_AGENT_HOME_DIR");
  if (configured) return path.resolve(configured);
  return path.resolve(process.cwd(), "kthx-agents");
};

export const resolveKthxConfigPath = (homeDir: string): string => {
  const configured = trimEnv("MG_AGENT_KTHX_CONFIG_PATH");
  if (configured) return path.resolve(configured);
  return path.resolve(homeDir, "config.json");
};

export const debugPath = (stateDir: string, name: string): string =>
  path.join(stateDir, "ipc", "debug", name);

const persistedAgentKeyBoxPath = (stateDir: string): string =>
  path.join(stateDir, "ipc", "auth", "agent-key-box.json");

export const writeJsonSync = (filePath: string, payload: unknown): boolean => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
};

export const appendDebug = (
  stateDir: string,
  payload: Record<string, unknown>,
): void => {
  try {
    const dir = debugPath(stateDir, "");
    fs.mkdirSync(dir, { recursive: true });
    const record = { at: nowIso(), ...payload };
    fs.appendFileSync(
      path.join(dir, "supervisor-exit.jsonl"),
      `${JSON.stringify(record)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "supervisor-exit-latest.json"),
      JSON.stringify(record, null, 2),
      "utf8",
    );
  } catch {
    // best-effort
  }
};

export const writeBotSessionFile = (
  filePath: string,
  payload: unknown,
): boolean => {
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

export const readPersistedAgentKeyBoxOwnerPid = (stateDir: string): number | null => {
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

export const readPersistedAgentKeyBoxForOwner = (
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

export const clearPersistedAgentKeyBoxFile = (
  stateDir: string,
  reason: string,
): void => {
  const filePath = persistedAgentKeyBoxPath(stateDir);
  try {
    if (!fs.existsSync(filePath)) return;
    fs.rmSync(filePath, { force: true });
    console.warn(`[supervisor] cleared persisted agent key-box (${reason})`);
  } catch {
    // best-effort
  }
};

type LockRecord = {
  pid: number;
  script: string | null;
  connectionId: string | null;
  startedAt: string | null;
};

export const readLock = (lockPath: string): LockRecord | null => {
  try {
    if (!fs.existsSync(lockPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as unknown;
    if (!isRecord(parsed)) return null;
    const pid =
      typeof parsed.pid === "number" && Number.isInteger(parsed.pid)
        ? parsed.pid
        : null;
    if (!pid) return null;
    return {
      pid,
      script: typeof parsed.script === "string" ? parsed.script : null,
      connectionId:
        typeof parsed.connectionId === "string" ? parsed.connectionId : null,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
    };
  } catch {
    return null;
  }
};

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return isRecord(error) && error.code === "EPERM";
  }
};

export const acquireLock = (
  lockPath: string,
  payload: Record<string, unknown>,
): { ok: boolean; conflict: LockRecord | null } => {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2), {
        encoding: "utf8",
        flag: "wx",
      });
      return { ok: true, conflict: null };
    } catch (error: unknown) {
      if (isRecord(error) && error.code !== "EEXIST") {
        return { ok: false, conflict: null };
      }
      const existing = readLock(lockPath);
      if (existing && isPidAlive(existing.pid) && existing.pid !== process.pid) {
        return { ok: false, conflict: existing };
      }
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        // retry
      }
    }
  }
  return { ok: false, conflict: readLock(lockPath) };
};

export const parseBotTokenMsg = (
  msg: unknown,
):
  | { action: "set"; token: string; expiresAt: string | null }
  | { action: "clear"; reason: string }
  | null => {
  if (!isRecord(msg) || msg.type !== "mg_runtime_bot_token") return null;
  if (msg.action === "set") {
    const token = typeof msg.token === "string" ? msg.token.trim() : "";
    if (!token) return null;
    return {
      action: "set",
      token,
      expiresAt:
        typeof msg.expiresAt === "string" && msg.expiresAt.trim().length
          ? msg.expiresAt.trim()
          : null,
    };
  }
  if (msg.action === "clear") {
    return {
      action: "clear",
      reason:
        typeof msg.reason === "string" && msg.reason.trim().length
          ? msg.reason.trim()
          : "unknown",
    };
  }
  return null;
};

export const parseFatalMsg = (
  msg: unknown,
): { source: string; message: string; at: string | null; stack: string | null } | null => {
  if (!isRecord(msg) || msg.type !== "mg_runtime_fatal") return null;
  return {
    source:
      typeof msg.source === "string" && msg.source.trim().length
        ? msg.source.trim()
        : "unknown",
    message:
      typeof msg.message === "string" && msg.message.trim().length
        ? msg.message.trim()
        : "fatal error",
    at: typeof msg.at === "string" && msg.at.trim().length ? msg.at.trim() : null,
    stack:
      typeof msg.stack === "string" && msg.stack.trim().length ? msg.stack : null,
  };
};

export const parseArgs = (argv: string[]): Parsed => {
  const rest = argv.slice(2);
  if (rest.includes("--help") || rest.includes("-h")) return { kind: "help" };

  const keepBotTokenEnv = rest.includes("--keep-bot-token-env");
  const stripBotTokenEnv = rest.includes("--strip-bot-token-env");
  const withAll = rest.includes("--all");
  const withBridge =
    withAll ||
    rest.includes("--with-bridge") ||
    parseBoolEnv(process.env.MG_AGENT_SUPERVISOR_ENABLE_BRIDGE);
  const withHealth =
    withAll ||
    rest.includes("--with-health") ||
    parseBoolEnv(process.env.MG_AGENT_SUPERVISOR_ENABLE_HEALTH_WEB);

  const ctlIdx = rest.indexOf("--control");
  if (ctlIdx !== -1) {
    const actionRaw = rest[ctlIdx + 1];
    const action =
      typeof actionRaw === "string" ? actionRaw.trim().toLowerCase() : "";
    if (!ACTIONS.has(action)) {
      return {
        kind: "error",
        message:
          "Control action must be one of: status | start | stop | restart | shutdown | update",
      };
    }
    const target =
      action === "status" || action === "shutdown"
        ? normalizeTarget(rest[ctlIdx + 2] ?? "all")
        : normalizeTarget(rest[ctlIdx + 2] ?? "");
    if (!target) {
      return {
        kind: "error",
        message: "Control target must be one of: runtime | bridge | health | all",
      };
    }
    if (action === "shutdown" && target !== "all") {
      return {
        kind: "error",
        message: "Control target for shutdown must be: all",
      };
    }
    if (action === "update" && target !== "all") {
      return {
        kind: "error",
        message: "Control target for update must be: all",
      };
    }
    return { kind: "control", action, target };
  }

  const runtimeScript = getOpt(rest, ["--runtime-script", "--script"]);
  if (!runtimeScript) {
    return {
      kind: "error",
      message: "Missing --script <path-to-runtime-script>",
    };
  }

  const bridgeScript =
    getOpt(rest, "--bridge-script") ??
    path.resolve(process.cwd(), "kthx-agents", "scripts", "agent-chat-bridge.mjs");
  const healthScript =
    getOpt(rest, "--health-script") ??
    path.resolve(process.cwd(), "kthx-agents", "scripts", "agent-health-web.mjs");

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
    maxRestarts:
      typeof maxRestarts === "number" &&
      Number.isFinite(maxRestarts) &&
      maxRestarts >= 0
        ? maxRestarts
        : null,
    keepBotTokenEnv,
    stripBotTokenEnv,
  };
};

export const runControlMode = (parsed: ParsedControl): void => {
  const stateDir = resolveStateDir();
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

  const queued = appendSupervisorControlCommand({
    stateDir,
    action: parsed.action,
    target: parsed.target,
    source: "cli",
  });
  if (queued.ok) {
    console.log(`[supervisor] queued ${parsed.action} ${parsed.target}`);
    return;
  }
  console.error(
    `[supervisor] failed to append control command at ${queued.controlPath}`,
  );
  process.exitCode = 2;
};

export const appendSupervisorControlCommand = ({
  stateDir = resolveStateDir(),
  action,
  target,
  source,
  pid = process.pid,
}: {
  stateDir?: string;
  action: string;
  target: string;
  source: string;
  pid?: number;
}):
  | { ok: true; controlPath: string; record: SupervisorControlRecord }
  | { ok: false; controlPath: string } => {
  const controlPath = debugPath(stateDir, "supervisor-control.jsonl");
  try {
    fs.mkdirSync(path.dirname(controlPath), { recursive: true });
    const record: SupervisorControlRecord = {
      at: nowIso(),
      id: `ctl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      action,
      target,
      pid,
      source,
    };
    fs.appendFileSync(controlPath, `${JSON.stringify(record)}\n`, "utf8");
    return { ok: true, controlPath, record };
  } catch {
    return { ok: false, controlPath };
  }
};
