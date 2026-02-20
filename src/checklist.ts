/**
 * Agent checklist utility.
 *
 * Validates common runtime setup issues before boot:
 * - required env vars / URL shape
 * - auth bootstrap sources (keybox/key/invite/persisted keybox)
 * - OpenClaw binary resolution + probe
 * - image generation command configuration + executable resolution
 * - key runtime state files (bot-session, supervisor-status, chat status)
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { loadDotEnv } from "./config/dotenv.js";
import { trimEnv } from "./lib/env-parse.js";
import { isRecord } from "./lib/guards.js";
import {
  probeOpenClawBinary,
  resolveOpenClawBinary,
} from "./openclaw/openclaw-binary.js";

type CheckStatus = "ok" | "warn" | "fail";

type CheckResult = {
  status: CheckStatus;
  label: string;
  message: string;
};

const DEFAULT_IMAGE_COMMAND_TEMPLATE =
  'generateImage --sync --dir "{dir}" --files "{files}" "{prompt}"';

const CHECK_ORDER: ReadonlyArray<CheckStatus> = ["fail", "warn", "ok"];

const statusTag = (status: CheckStatus): string => {
  if (status === "ok") return "[OK]";
  if (status === "warn") return "[WARN]";
  return "[FAIL]";
};

const parseIsoMs = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseFirstCommandToken = (command: string): string | null => {
  const match = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(command);
  const token = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
  return token.length > 0 ? token : null;
};

const looksPathLike = (value: string): boolean =>
  value.includes("/") || value.includes("\\") || value.startsWith(".");

const splitPathEntries = (value: string | null | undefined): string[] => {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  return value
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const isExecutableFile = (candidatePath: string): boolean => {
  try {
    const stat = fs.statSync(candidatePath);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    fs.accessSync(candidatePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const commandCandidates = (token: string): string[] => {
  if (process.platform !== "win32") return [token];
  const lower = token.toLowerCase();
  if (/\.(?:exe|cmd|bat|com|ps1)$/u.test(lower)) return [token];
  const pathExt = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1";
  const extensions = pathExt
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (!extensions.length) return [token];
  return extensions.map((ext) => `${token}${ext.toLowerCase()}`);
};

const resolveCommandOnPath = (token: string): string | null => {
  const entries = splitPathEntries(process.env.PATH);
  if (!entries.length) return null;
  const candidates = commandCandidates(token);
  for (const dir of entries) {
    for (const candidate of candidates) {
      const fullPath = path.resolve(dir, candidate);
      if (isExecutableFile(fullPath)) return fullPath;
    }
  }
  return null;
};

const readJsonFile = async (targetPath: string): Promise<unknown | null> => {
  const raw = await fsp.readFile(targetPath, "utf8").catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

const resolveDefaultHomeDir = (): string => {
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, "kthx-agents"),
    path.resolve(cwd, "..", "kthx-agents"),
    path.resolve(cwd, "..", "..", "kthx-agents"),
    path.resolve(cwd, "..", "..", "..", "kthx-agents"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
};

const addResult = (
  results: CheckResult[],
  status: CheckStatus,
  label: string,
  message: string,
): void => {
  results.push({ status, label, message });
};

const printResults = (results: ReadonlyArray<CheckResult>): void => {
  for (const status of CHECK_ORDER) {
    for (const row of results.filter((entry) => entry.status === status)) {
      process.stdout.write(`${statusTag(row.status)} ${row.label}: ${row.message}\n`);
    }
  }
};

const main = async (): Promise<number> => {
  await loadDotEnv();

  const results: CheckResult[] = [];

  const defaultHomeDir = resolveDefaultHomeDir();
  const homeDir = trimEnv("MG_AGENT_HOME_DIR")
    ? path.resolve(trimEnv("MG_AGENT_HOME_DIR") ?? defaultHomeDir)
    : defaultHomeDir;
  const stateDir = trimEnv("MG_AGENT_STATE_DIR")
    ? path.resolve(trimEnv("MG_AGENT_STATE_DIR") ?? path.join(homeDir, "state"))
    : path.join(homeDir, "state");
  const kthxConfigPath = trimEnv("MG_AGENT_KTHX_CONFIG_PATH")
    ? path.resolve(
        trimEnv("MG_AGENT_KTHX_CONFIG_PATH") ?? path.join(homeDir, "config.json"),
      )
    : path.join(homeDir, "config.json");

  process.stdout.write("[agent-checklist] validating runtime prerequisites\n");
  process.stdout.write(`[agent-checklist] homeDir=${homeDir}\n`);
  process.stdout.write(`[agent-checklist] stateDir=${stateDir}\n`);
  process.stdout.write(`[agent-checklist] kthxConfigPath=${kthxConfigPath}\n`);

  // Realtime URL
  const realtimeWsUrl = trimEnv("MG_REALTIME_WS_URL");
  if (!realtimeWsUrl) {
    addResult(
      results,
      "fail",
      "MG_REALTIME_WS_URL",
      "Missing. Set ws://<host>:4100/trpc",
    );
  } else {
    try {
      const url = new URL(realtimeWsUrl);
      const protocolOk = url.protocol === "ws:" || url.protocol === "wss:";
      const trpcPathOk = url.pathname.endsWith("/trpc");
      if (!protocolOk) {
        addResult(
          results,
          "fail",
          "MG_REALTIME_WS_URL",
          `Invalid protocol (${url.protocol}). Use ws:// or wss://`,
        );
      } else if (!trpcPathOk) {
        addResult(
          results,
          "fail",
          "MG_REALTIME_WS_URL",
          `Missing /trpc path (${url.pathname})`,
        );
      } else {
        addResult(
          results,
          "ok",
          "MG_REALTIME_WS_URL",
          `${url.origin}${url.pathname}`,
        );
      }
    } catch {
      addResult(
        results,
        "fail",
        "MG_REALTIME_WS_URL",
        `Not a valid URL: ${realtimeWsUrl}`,
      );
    }
  }

  // Chat HTTP URL
  const chatHttpBase = trimEnv("MG_CHAT_HTTP_BASE_URL");
  if (!chatHttpBase) {
    addResult(
      results,
      "warn",
      "MG_CHAT_HTTP_BASE_URL",
      "Not set. Runtime can infer from realtime URL, but explicit value is recommended.",
    );
  } else {
    try {
      const parsed = new URL(chatHttpBase);
      const protocolOk =
        parsed.protocol === "http:" || parsed.protocol === "https:";
      if (!protocolOk) {
        addResult(
          results,
          "fail",
          "MG_CHAT_HTTP_BASE_URL",
          `Invalid protocol (${parsed.protocol}). Use http:// or https://`,
        );
      } else {
        addResult(
          results,
          "ok",
          "MG_CHAT_HTTP_BASE_URL",
          `${parsed.origin}${parsed.pathname}`,
        );
      }
    } catch {
      addResult(
        results,
        "fail",
        "MG_CHAT_HTTP_BASE_URL",
        `Not a valid URL: ${chatHttpBase}`,
      );
    }
  }

  // Config
  const configExists = fs.existsSync(kthxConfigPath);
  if (!configExists) {
    addResult(
      results,
      "warn",
      "kthx config",
      "Missing config.json (runtime will create defaults on boot).",
    );
  } else {
    addResult(results, "ok", "kthx config", "config file present.");
  }
  const rawKthxConfig = configExists ? await readJsonFile(kthxConfigPath) : null;
  if (configExists && rawKthxConfig === null) {
    addResult(
      results,
      "fail",
      "kthx config",
      "config file exists but is invalid JSON.",
    );
  }

  const openClawConfig = isRecord(rawKthxConfig) && isRecord(rawKthxConfig.openclaw)
    ? rawKthxConfig.openclaw
    : null;
  const configuredOpenClawBinPath =
    openClawConfig && typeof openClawConfig.binPath === "string"
      ? openClawConfig.binPath
      : null;
  const imageConfig = isRecord(rawKthxConfig) && isRecord(rawKthxConfig.image)
    ? rawKthxConfig.image
    : null;
  const configImageCommand =
    imageConfig && typeof imageConfig.commandTemplate === "string"
      ? imageConfig.commandTemplate.trim()
      : "";

  // Auth sources
  const keyBoxEnv = trimEnv("MG_AGENT_KEY_BOX");
  const keyBoxFileEnv = trimEnv("MG_AGENT_KEY_BOX_FILE");
  const agentKeyEnv = trimEnv("MG_AGENT_KEY");
  const ownerInviteToken = trimEnv("MG_OWNER_INVITE_TOKEN");
  const persistedKeyBoxPath = path.join(stateDir, "ipc", "auth", "agent-key-box.json");
  const persistedKeyBoxJson = await readJsonFile(persistedKeyBoxPath);
  const persistedKeyBox =
    isRecord(persistedKeyBoxJson) &&
    typeof persistedKeyBoxJson.agentKeyBox === "string" &&
    persistedKeyBoxJson.agentKeyBox.trim().length > 0
      ? persistedKeyBoxJson.agentKeyBox.trim()
      : "";

  if (keyBoxFileEnv) {
    const keyBoxFilePath = path.resolve(keyBoxFileEnv);
    const raw = await fsp.readFile(keyBoxFilePath, "utf8").catch(() => null);
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!trimmed.length) {
      addResult(
        results,
        "fail",
        "MG_AGENT_KEY_BOX_FILE",
        `Configured but empty/unreadable: ${keyBoxFilePath}`,
      );
    } else {
      addResult(
        results,
        "ok",
        "MG_AGENT_KEY_BOX_FILE",
        `Loaded key-box from ${keyBoxFilePath}`,
      );
    }
  }

  const authSources: string[] = [];
  if (keyBoxEnv) authSources.push("env:MG_AGENT_KEY_BOX");
  if (agentKeyEnv) authSources.push("env:MG_AGENT_KEY");
  if (ownerInviteToken) authSources.push("env:MG_OWNER_INVITE_TOKEN");
  if (persistedKeyBox) authSources.push(`file:${persistedKeyBoxPath}`);
  if (authSources.length > 0) {
    addResult(
      results,
      "ok",
      "auth bootstrap",
      `Sources detected: ${authSources.join(", ")}`,
    );
  } else {
    addResult(
      results,
      "fail",
      "auth bootstrap",
      "No auth source found. Provide MG_AGENT_KEY_BOX / MG_AGENT_KEY / MG_OWNER_INVITE_TOKEN.",
    );
  }

  // OpenClaw binary
  const openClawResolution = resolveOpenClawBinary({
    configuredBinPath: configuredOpenClawBinPath,
  });
  const openClawProbe = await probeOpenClawBinary(openClawResolution, 8_000);
  if (!openClawProbe.ok) {
    addResult(
      results,
      "fail",
      "OpenClaw",
      `Probe failed (source=${openClawResolution.source}, command=${openClawResolution.command})`,
    );
  } else {
    addResult(
      results,
      "ok",
      "OpenClaw",
      `Ready (${openClawProbe.version ?? "version unknown"}; source=${openClawResolution.source})`,
    );
  }
  if (openClawResolution.warning) {
    addResult(results, "warn", "OpenClaw", openClawResolution.warning);
  }

  // Image generation command
  const envImageCommand = trimEnv("MG_AGENT_IMAGE_GENERATE_CMD");
  const imageCommand =
    envImageCommand ??
    (configImageCommand.length > 0
      ? configImageCommand
      : DEFAULT_IMAGE_COMMAND_TEMPLATE);
  if (!imageCommand.trim().length) {
    addResult(
      results,
      "fail",
      "image generation command",
      "No command configured (MG_AGENT_IMAGE_GENERATE_CMD / kthx image.commandTemplate).",
    );
  } else {
    const token = parseFirstCommandToken(imageCommand);
    if (!token) {
      addResult(
        results,
        "fail",
        "image generation command",
        "Could not parse command token from image command template.",
      );
    } else if (token.includes("{") || token.startsWith("$") || token.startsWith("%")) {
      addResult(
        results,
        "warn",
        "image generation command",
        `Command token is dynamic (${token}); executable check skipped.`,
      );
    } else {
      let resolvedExecutable: string | null = null;
      if (looksPathLike(token)) {
        const abs = path.isAbsolute(token) ? token : path.resolve(token);
        resolvedExecutable = isExecutableFile(abs) ? abs : null;
      } else {
        resolvedExecutable = resolveCommandOnPath(token);
      }
      if (!resolvedExecutable) {
        addResult(
          results,
          "fail",
          "image generation command",
          `Executable not found for token: ${token}`,
        );
      } else {
        addResult(
          results,
          "ok",
          "image generation command",
          `Template wired and executable resolved: ${resolvedExecutable}`,
        );
      }
    }
  }

  // Bot session file
  const botSessionPath = path.join(stateDir, "ipc", "auth", "bot-session.json");
  const botSessionJson = await readJsonFile(botSessionPath);
  if (!botSessionJson) {
    addResult(
      results,
      "warn",
      "bot-session.json",
      "Missing or unreadable (runtime/supervisor may not be running yet).",
    );
  } else if (!isRecord(botSessionJson)) {
    addResult(
      results,
      "warn",
      "bot-session.json",
      "Invalid JSON payload.",
    );
  } else {
    const token =
      typeof botSessionJson.token === "string" ? botSessionJson.token.trim() : "";
    const expiresAt =
      typeof botSessionJson.expiresAt === "string"
        ? botSessionJson.expiresAt
        : null;
    const expiresAtMs = parseIsoMs(expiresAt);
    if (!token.length) {
      addResult(
        results,
        "warn",
        "bot-session.json",
        "No active bot token in file.",
      );
    } else if (typeof expiresAtMs === "number" && Date.now() >= expiresAtMs) {
      addResult(
        results,
        "warn",
        "bot-session.json",
        `Token present but expired at ${expiresAt}.`,
      );
    } else {
      addResult(
        results,
        "ok",
        "bot-session.json",
        expiresAt
          ? `Active token present (expiresAt=${expiresAt}).`
          : "Active token present.",
      );
    }
  }

  // Supervisor status
  const supervisorStatusPath = path.join(stateDir, "ipc", "debug", "supervisor-status.json");
  const supervisorStatusJson = await readJsonFile(supervisorStatusPath);
  if (!supervisorStatusJson || !isRecord(supervisorStatusJson)) {
    addResult(
      results,
      "warn",
      "supervisor status",
      "Missing or unreadable supervisor-status.json.",
    );
  } else {
    const processes = Array.isArray(supervisorStatusJson.processes)
      ? supervisorStatusJson.processes
      : [];
    const runtime = processes.find(
      (proc) => isRecord(proc) && proc.name === "runtime",
    );
    const runtimeRunning =
      isRecord(runtime) && typeof runtime.running === "boolean"
        ? runtime.running
        : false;
    if (runtimeRunning) {
      addResult(results, "ok", "supervisor runtime", "runtime is running.");
    } else {
      addResult(
        results,
        "warn",
        "supervisor runtime",
        "runtime is not marked running.",
      );
    }
  }

  // Chat status
  const chatStatusPath = path.join(stateDir, "ipc", "chat", "status.json");
  const chatStatusJson = await readJsonFile(chatStatusPath);
  if (!chatStatusJson || !isRecord(chatStatusJson)) {
    addResult(
      results,
      "warn",
      "chat status",
      "Missing or unreadable chat/status.json.",
    );
  } else {
    const connected =
      typeof chatStatusJson.connected === "boolean"
        ? chatStatusJson.connected
        : false;
    const topics =
      Array.isArray(chatStatusJson.subscribedTopics) &&
      chatStatusJson.subscribedTopics.every((topic) => typeof topic === "string")
        ? chatStatusJson.subscribedTopics.length
        : 0;
    if (connected) {
      addResult(
        results,
        "ok",
        "chat bridge",
        `connected=true, topics=${topics}`,
      );
    } else {
      addResult(
        results,
        "warn",
        "chat bridge",
        `connected=false, topics=${topics}`,
      );
    }
  }

  printResults(results);

  const okCount = results.filter((entry) => entry.status === "ok").length;
  const warnCount = results.filter((entry) => entry.status === "warn").length;
  const failCount = results.filter((entry) => entry.status === "fail").length;
  process.stdout.write(
    `[agent-checklist] summary ok=${okCount} warn=${warnCount} fail=${failCount}\n`,
  );
  if (failCount > 0) {
    process.stdout.write("[agent-checklist] checklist failed.\n");
    return 1;
  }
  process.stdout.write("[agent-checklist] checklist passed.\n");
  return 0;
};

const code = await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[agent-checklist] fatal: ${message}\n`);
  return 2;
});
process.exitCode = code;
