import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseCsvEnv, trimEnv } from "../lib/env-parse.js";
import { isRecord } from "../lib/guards.js";
import {
  applyOpenClawBinaryToShellCommand,
  withOpenClawPathInEnv,
  type OpenClawBinaryResolution,
} from "./openclaw-binary.js";

const OPENCLAW_ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/gu;
const DEFAULT_MINT_CHALLENGE_TIMEOUT_MS = 20_000;
const DEFAULT_MINT_CHALLENGE_THINKING_LEVEL = "off";

const parseMintChallengeTimeoutMs = (): number => {
  const raw = trimEnv("MG_AGENT_MINT_CHALLENGE_OPENCLAW_TIMEOUT_MS");
  if (!raw) return DEFAULT_MINT_CHALLENGE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MINT_CHALLENGE_TIMEOUT_MS;
  return Math.max(5_000, Math.min(30_000, parsed));
};

export const MINT_CHALLENGE_TIMEOUT_MS = parseMintChallengeTimeoutMs();
export const MINT_CHALLENGE_THINKING_LEVEL = (() => {
  const raw = trimEnv("MG_AGENT_MINT_CHALLENGE_OPENCLAW_THINKING");
  if (!raw) return DEFAULT_MINT_CHALLENGE_THINKING_LEVEL;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0
    ? normalized
    : DEFAULT_MINT_CHALLENGE_THINKING_LEVEL;
})();

const parseBooleanEnv = (key: string, fallback: boolean): boolean => {
  const raw = trimEnv(key);
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const DEFAULT_MINT_CHALLENGE_ALLOWED_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
];

export const MINT_CHALLENGE_UTIL_ALLOWED_ENV_KEYS = (() => {
  const configured = parseCsvEnv("MG_AGENT_MINT_UTIL_ALLOWED_ENV_KEYS")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  if (configured.length > 0) return Array.from(new Set(configured));
  return DEFAULT_MINT_CHALLENGE_ALLOWED_ENV_KEYS;
})();

export const MINT_CHALLENGE_UTIL_INHERIT_NONE =
  (trimEnv("MG_AGENT_MINT_UTIL_ENV_INHERIT") ?? "none").toLowerCase() === "none";

export const MINT_CHALLENGE_UTIL_READONLY_CWD = parseBooleanEnv(
  "MG_AGENT_MINT_UTIL_READONLY_CWD",
  true,
);

export const applyMintChallengeExtraFlags = (command: string): string => {
  const extraFlags = trimEnv("MG_AGENT_MINT_UTIL_EXTRA_FLAGS");
  if (!extraFlags) return command;
  if (/\s-m\s/iu.test(command)) {
    return command.replace(/\s-m\s/iu, ` ${extraFlags} -m `);
  }
  return `${command} ${extraFlags}`;
};

export const buildMintChallengeSubprocessEnv = (
  resolution: OpenClawBinaryResolution,
): NodeJS.ProcessEnv => {
  const parentEnv = withOpenClawPathInEnv({ ...process.env }, resolution);
  if (!MINT_CHALLENGE_UTIL_INHERIT_NONE) return parentEnv;

  const env: NodeJS.ProcessEnv = {};
  const alwaysKeys = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "COMSPEC",
    "SYSTEMROOT",
    "WINDIR",
  ];
  for (const key of alwaysKeys) {
    const value = parentEnv[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  for (const key of MINT_CHALLENGE_UTIL_ALLOWED_ENV_KEYS) {
    const value = parentEnv[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
};

const stripEmptyAgentFlag = (command: string): string =>
  command
    .replace(/\s--agent\s+"__MG_AGENT_AUTO__"/giu, " ")
    .replace(/\s--agent\s+'__MG_AGENT_AUTO__'/giu, " ")
    .replace(/\s--agent\s+__MG_AGENT_AUTO__/giu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();

export const parseOpenClawAgentName = (value: unknown): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed.length || !/^[a-zA-Z0-9._-]{1,64}$/u.test(trimmed)) return null;
  return trimmed;
};

export const DEFAULT_RESPONSE_AGENT_MODEL = "anthropic/claude-haiku-4-5";

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export const listOutputIncludesAgent = (
  output: string | null | undefined,
  agentName: string,
): boolean => {
  const text = typeof output === "string" ? output : "";
  if (!text.trim().length) return false;
  const escapedName = escapeRegex(agentName);
  const patterns = [
    new RegExp(`\\b${escapedName}\\b`, "iu"),
    new RegExp(`name\\s*:\\s*${escapedName}\\b`, "iu"),
    new RegExp(`-\\s*(?:name\\s*:\\s*)?${escapedName}(?:\\s|$|\\()`, "iu"),
  ];
  return patterns.some((pattern) => pattern.test(text));
};

export const normalizeModelToken = (value: string): string | null => {
  const trimmed = value.trim().replace(/,$/u, "");
  if (!trimmed.length) return null;
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const inner = trimmed.slice(1, -1).trim();
    return inner.length > 0 ? inner : null;
  }
  const first = trimmed.split(/\s+/u)[0] ?? "";
  return first.length > 0 ? first : null;
};

export const resolveResponseAgentModelFromListOutput = (
  output: unknown,
  utilAgentName: string,
): string | null => {
  const text = typeof output === "string" ? output : "";
  if (!text.trim().length) return null;
  const lines = text.split(/\r?\n/u);
  type Entry = { name: string | null; isDefault: boolean; model: string | null };
  const entries: Entry[] = [];
  let current: Entry | null = null;
  const commitCurrent = () => {
    if (current) entries.push(current);
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.length) continue;
    const itemMatch =
      /^-\s*(?:name\s*:\s*)?([a-zA-Z0-9._-]+)\b(.*)$/iu.exec(line);
    if (itemMatch?.[1]) {
      commitCurrent();
      current = {
        name: itemMatch[1].trim(),
        isDefault: /\(default\)/iu.test(line),
        model: null,
      };
      const inlineModelMatch = /\bmodel\s*:\s*(.+)$/iu.exec(itemMatch[2] ?? "");
      if (inlineModelMatch?.[1]) {
        current.model = normalizeModelToken(inlineModelMatch[1]);
      }
      continue;
    }

    if (!current) continue;
    const nameMatch = /^name\s*:\s*([a-zA-Z0-9._-]+)\b/iu.exec(line);
    if (nameMatch?.[1]) {
      current.name = nameMatch[1].trim();
      if (/\(default\)/iu.test(line)) current.isDefault = true;
    }
    if (/^default\s*:\s*(?:true|yes|1)\b/iu.test(line)) {
      current.isDefault = true;
    }
    const modelMatch = /^model\s*:\s*(.+)$/iu.exec(line);
    if (modelMatch?.[1]) {
      current.model = normalizeModelToken(modelMatch[1]);
    }
  }
  commitCurrent();

  const nonUtilDefault = entries.find(
    (entry) =>
      entry.model !== null &&
      entry.isDefault &&
      entry.name !== null &&
      entry.name !== utilAgentName,
  );
  if (nonUtilDefault?.model) return nonUtilDefault.model;

  const nonUtilAny = entries.find(
    (entry) =>
      entry.model !== null &&
      entry.name !== null &&
      entry.name !== utilAgentName,
  );
  if (nonUtilAny?.model) return nonUtilAny.model;

  const anyModel = entries.find((entry) => entry.model !== null);
  if (anyModel?.model) return anyModel.model;

  const inlineModel = /\bmodel\s*:\s*([^\s,]+)/iu.exec(text);
  if (inlineModel?.[1]) return normalizeModelToken(inlineModel[1]);
  return null;
};

const extractTextFromUnknownChunk = (value: unknown): string => {
  if (typeof value === "string") {
    const normalized = value.replace(OPENCLAW_ANSI_PATTERN, "").replaceAll("\r", "");
    return normalized.length > 0 ? normalized : "";
  }
  if (!isRecord(value)) return "";
  for (const field of ["delta", "text", "reply", "content", "message", "outputText", "assistant"]) {
    const candidate = value[field];
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  if (Array.isArray(value.choices)) {
    for (const choice of value.choices) {
      if (!isRecord(choice)) continue;
      const delta = isRecord(choice.delta) ? choice.delta : null;
      if (delta && typeof delta.content === "string" && (delta.content as string).length > 0) {
        return delta.content as string;
      }
      if (typeof choice.text === "string" && (choice.text as string).length > 0) {
        return choice.text as string;
      }
    }
  }
  return "";
};

export const parseOpenClawStdoutDelta = (chunk: unknown): string => {
  const normalized =
    typeof chunk === "string"
      ? chunk.replace(OPENCLAW_ANSI_PATTERN, "").replaceAll("\r", "")
      : "";
  if (!normalized.length) return "";

  const lines = normalized
    .split(/\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (!lines.length) return "";

  let extracted = "";
  let parsedAnyJson = false;
  for (const line of lines) {
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        const parsed: unknown = JSON.parse(line);
        parsedAnyJson = true;
        extracted += extractTextFromUnknownChunk(parsed);
        continue;
      } catch {
        // not json
      }
    }
    if (/^\[(?:info|debug|event|tool|json|status)\]/iu.test(line)) continue;
    extracted += line;
    if (!line.endsWith(" ")) extracted += " ";
  }
  return parsedAnyJson ? extracted : normalized;
};

export const resolveAgentFromListOutput = (output: unknown): string | null => {
  const text = typeof output === "string" ? output : "";
  if (!text.trim().length) return null;
  const tokenPattern = /[a-zA-Z0-9._-]+/u;
  const defaultInlinePatterns = [
    /-\s*(?:name\s*:\s*)?([a-zA-Z0-9._-]+)\s*\(default\)/iu,
    /\bname\s*:\s*([a-zA-Z0-9._-]+)\s*\(default\)/iu,
  ];
  for (const pattern of defaultInlinePatterns) {
    const match = pattern.exec(text);
    if (match?.[1]?.trim().length) return match[1].trim();
  }

  const blockDefaultMatch =
    /-\s*name\s*:\s*([a-zA-Z0-9._-]+)[\s\S]{0,200}?\bdefault\s*:\s*(?:true|yes|1)\b/iu.exec(
      text,
    );
  if (blockDefaultMatch?.[1]?.trim().length) return blockDefaultMatch[1].trim();

  let currentName: string | null = null;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.length) continue;
    const listNameMatch = /^-\s*(?:name\s*:\s*)?([a-zA-Z0-9._-]+)\b/iu.exec(line);
    if (listNameMatch?.[1]) {
      currentName = listNameMatch[1];
      if (/\(default\)/iu.test(line)) return currentName;
      continue;
    }
    const nameMatch = /^name\s*:\s*([a-zA-Z0-9._-]+)\b/iu.exec(line);
    if (nameMatch?.[1]) {
      currentName = nameMatch[1];
      if (/\(default\)/iu.test(line)) return currentName;
      continue;
    }
    if (currentName && /^default\s*:\s*(?:true|yes|1)\b/iu.test(line)) {
      return currentName;
    }
    if (currentName && /^-\s*/u.test(line) && !tokenPattern.test(line)) {
      currentName = null;
    }
  }

  const agentsInlineMatch = /Agents:\s*-\s*(?:name\s*:\s*)?([a-zA-Z0-9._-]+)/iu.exec(text);
  if (agentsInlineMatch?.[1]?.trim().length) return agentsInlineMatch[1].trim();
  const firstNameFieldMatch = /-\s*name\s*:\s*([a-zA-Z0-9._-]+)/iu.exec(text);
  if (firstNameFieldMatch?.[1]?.trim().length) return firstNameFieldMatch[1].trim();
  const firstMatch = /-\s*([a-zA-Z0-9._-]+)/u.exec(text);
  if (firstMatch?.[1]?.trim().length) return firstMatch[1].trim();
  return null;
};

export const enforceMintChallengeFastThinking = (command: string): string => {
  const normalized = command.trim();
  if (!normalized.length) return command;
  const tokenMatch =
    /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(normalized);
  const commandToken =
    (tokenMatch?.[1] ?? tokenMatch?.[2] ?? tokenMatch?.[3] ?? "").trim();
  const commandBase = commandToken ? path.basename(commandToken).toLowerCase() : "";
  const isOpenClawCommand =
    /^openclaw(?:\.(?:cmd|exe|bat|ps1))?$/iu.test(commandBase);
  if (!isOpenClawCommand) return command;
  const desiredThinking = MINT_CHALLENGE_THINKING_LEVEL.trim();
  if (!desiredThinking.length) return command;
  if (/\s--thinking\s+\S+/iu.test(command)) {
    return command.replace(/\s--thinking\s+\S+/iu, ` --thinking ${desiredThinking}`);
  }
  if (/\s-m\s/iu.test(command)) {
    return command.replace(/\s-m\s/iu, ` --thinking ${desiredThinking} -m `);
  }
  return `${command} --thinking ${desiredThinking}`;
};

export const resolveTemplateCommand = (
  template: string,
  agentName: string | null,
  config: { agentHomeDir: string; stateDir: string; kthxConfigPath: string },
  binary: OpenClawBinaryResolution,
  extraReplacements?: Record<string, string>,
): string => {
  let raw = template;
  if (extraReplacements) {
    for (const [key, value] of Object.entries(extraReplacements)) {
      raw = raw.replaceAll(key, value.replaceAll('"', '\\"'));
    }
  }
  raw = raw
    .replaceAll("{agent}", (agentName ?? "__MG_AGENT_AUTO__").replaceAll('"', '\\"'))
    .replaceAll("{home}", config.agentHomeDir.replaceAll('"', '\\"'))
    .replaceAll(
      "{workspace_root}",
      path.dirname(config.agentHomeDir).replaceAll('"', '\\"'),
    )
    .replaceAll("{state}", config.stateDir.replaceAll('"', '\\"'))
    .replaceAll("{config}", config.kthxConfigPath.replaceAll('"', '\\"'));
  raw = applyOpenClawBinaryToShellCommand(raw, binary);
  return stripEmptyAgentFlag(raw);
};

export const writeUtilAgentWorkspace = async (
  agentHomeDir: string,
  agentName: string,
): Promise<void> => {
  const dir = path.join(path.dirname(agentHomeDir), agentName);
  await fs.mkdir(dir, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(dir, "SOUL.md"),
      "You are a stateless utility agent. No persona. Answer prompts directly. Never write to memory. No web search unless prompt requires it.",
      "utf8",
    ),
    fs.writeFile(
      path.join(dir, "AGENTS.md"),
      "Stateless utility agent. Respond to the prompt. Do not write memory files or heartbeats.",
      "utf8",
    ),
    fs.writeFile(path.join(dir, "HEARTBEAT.md"), "HEARTBEAT_OK\n", "utf8"),
    fs.writeFile(
      path.join(dir, "IDENTITY.md"),
      `- **Name:** ${agentName}\n- **Role:** Utility agent\n- **Emoji:** 🔧`,
      "utf8",
    ),
    fs.rm(path.join(dir, "BOOTSTRAP.md"), { force: true }),
    fs.rm(path.join(dir, "USER.md"), { force: true }),
  ]);
};

export const prepareMintUtilTempCwd = async (): Promise<string | null> => {
  if (!MINT_CHALLENGE_UTIL_READONLY_CWD) return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "molkgram-mint-util-"));
  await fs.chmod(dir, 0o555).catch(() => {});
  return dir;
};

export const cleanupMintUtilTempCwd = async (
  tempCwd: string | null,
): Promise<void> => {
  if (!tempCwd) return;
  await fs.chmod(tempCwd, 0o755).catch(() => {});
  await fs.rm(tempCwd, { recursive: true, force: true }).catch(() => {});
};
