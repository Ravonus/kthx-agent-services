/**
 * OpenClaw binary resolution and preflight checks.
 *
 * Provides a single path-resolution flow used by:
 * - OpenClawManager shell commands
 * - auth/identity questionnaire + availability checks
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { trimEnv } from "../lib/env-parse.js";

const OPENCLAW_COMMAND_NAME = "openclaw";
const OPENCLAW_TOKEN_PATTERN = /^openclaw(?:\.(?:cmd|exe|bat|ps1))?$/iu;
const SAFE_SHELL_TOKEN_PATTERN = /^[a-zA-Z0-9_./:\\-]+$/u;

const trimNonEmpty = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const stripOuterQuotes = (value: string): string => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const inner = trimmed.slice(1, -1).trim();
    return inner.length > 0 ? inner : trimmed;
  }
  return trimmed;
};

const expandHomePrefix = (
  value: string,
  env: NodeJS.ProcessEnv,
): string => {
  if (!value.startsWith("~")) return value;
  const homeDir = trimNonEmpty(env.HOME) ??
    trimNonEmpty(env.USERPROFILE) ??
    os.homedir();
  if (!homeDir) return value;
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
};

const looksPathLike = (value: string): boolean => {
  if (value.includes("/") || value.includes("\\")) return true;
  if (value.startsWith(".")) return true;
  return /^[a-zA-Z]:/u.test(value);
};

const splitPathEntries = (value: string | null | undefined): string[] => {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  return value
    .split(path.delimiter)
    .map((entry) => stripOuterQuotes(entry))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const isExecutableFile = (filePath: string, platform: NodeJS.Platform): boolean => {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === "win32") return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const pathLookupCandidates = (
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] => {
  if (platform !== "win32") return [command];
  const lower = command.toLowerCase();
  const hasKnownExt = [".exe", ".cmd", ".bat", ".com", ".ps1"].some((ext) =>
    lower.endsWith(ext)
  );
  if (hasKnownExt) return [command];
  const rawPathExt = trimNonEmpty(env.PATHEXT) ?? ".COM;.EXE;.BAT;.CMD;.PS1";
  const pathExts = rawPathExt
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (!pathExts.length) return [command];
  return pathExts.map((ext) => `${command}${ext}`);
};

const resolveFromPath = (options: {
  command: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  pathValue: string | null | undefined;
}): string | null => {
  const entries = splitPathEntries(options.pathValue ?? options.env.PATH);
  if (!entries.length) return null;
  const commandCandidates = pathLookupCandidates(
    options.command,
    options.platform,
    options.env,
  );
  for (const dirEntry of entries) {
    const expandedDir = expandHomePrefix(dirEntry, options.env);
    for (const commandCandidate of commandCandidates) {
      const fullPath = path.resolve(expandedDir, commandCandidate);
      if (isExecutableFile(fullPath, options.platform)) return fullPath;
    }
  }
  return null;
};

const normalizeCandidate = (value: string | null, env: NodeJS.ProcessEnv): string | null => {
  const trimmed = trimNonEmpty(value);
  if (!trimmed) return null;
  return expandHomePrefix(stripOuterQuotes(trimmed), env);
};

const quoteForShell = (token: string): string => {
  if (SAFE_SHELL_TOKEN_PATTERN.test(token)) return token;
  const escaped = token.replace(/(["\\$`])/gu, "\\$1");
  return `"${escaped}"`;
};

const getCommandTokenBaseName = (token: string): string =>
  path.basename(token).trim().toLowerCase();

export type OpenClawBinarySource =
  | "config.openclaw.binPath"
  | "env:MG_OPENCLAW_BIN"
  | "env:OPENCLAW_BIN"
  | "path_lookup"
  | "default";

export interface OpenClawBinaryResolution {
  command: string;
  shellToken: string;
  resolvedPath: string | null;
  source: OpenClawBinarySource;
  fromOverride: boolean;
  warning: string | null;
}

export interface ResolveOpenClawBinaryOptions {
  configuredBinPath?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pathValue?: string | null;
}

const buildResolution = (input: {
  command: string;
  resolvedPath: string | null;
  source: OpenClawBinarySource;
  fromOverride: boolean;
  warning?: string | null;
}): OpenClawBinaryResolution => ({
  command: input.command,
  shellToken: quoteForShell(input.resolvedPath ?? input.command),
  resolvedPath: input.resolvedPath,
  source: input.source,
  fromOverride: input.fromOverride,
  warning: input.warning ?? null,
});

export const resolveOpenClawBinary = (
  options?: ResolveOpenClawBinaryOptions,
): OpenClawBinaryResolution => {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;

  const configuredBin = normalizeCandidate(options?.configuredBinPath ?? null, env);
  if (configuredBin) {
    if (looksPathLike(configuredBin)) {
      const abs = path.isAbsolute(configuredBin)
        ? configuredBin
        : path.resolve(configuredBin);
      if (isExecutableFile(abs, platform)) {
        return buildResolution({
          command: abs,
          resolvedPath: abs,
          source: "config.openclaw.binPath",
          fromOverride: true,
        });
      }
      return buildResolution({
        command: abs,
        resolvedPath: null,
        source: "config.openclaw.binPath",
        fromOverride: true,
        warning: `configured openclaw.binPath does not exist or is not executable: ${abs}`,
      });
    }
    const fromPath = resolveFromPath({
      command: configuredBin,
      platform,
      env,
      pathValue: options?.pathValue,
    });
    return buildResolution({
      command: configuredBin,
      resolvedPath: fromPath,
      source: "config.openclaw.binPath",
      fromOverride: true,
      warning: fromPath
        ? null
        : `configured openclaw.binPath command was not found in PATH: ${configuredBin}`,
    });
  }

  const envOverrides: Array<{ key: "MG_OPENCLAW_BIN" | "OPENCLAW_BIN"; source: OpenClawBinarySource }> = [
    { key: "MG_OPENCLAW_BIN", source: "env:MG_OPENCLAW_BIN" },
    { key: "OPENCLAW_BIN", source: "env:OPENCLAW_BIN" },
  ];
  for (const override of envOverrides) {
    const rawValue = normalizeCandidate(trimEnv(override.key), env);
    if (!rawValue) continue;
    if (looksPathLike(rawValue)) {
      const abs = path.isAbsolute(rawValue) ? rawValue : path.resolve(rawValue);
      if (isExecutableFile(abs, platform)) {
        return buildResolution({
          command: abs,
          resolvedPath: abs,
          source: override.source,
          fromOverride: true,
        });
      }
      return buildResolution({
        command: abs,
        resolvedPath: null,
        source: override.source,
        fromOverride: true,
        warning: `${override.key} path does not exist or is not executable: ${abs}`,
      });
    }
    const fromPath = resolveFromPath({
      command: rawValue,
      platform,
      env,
      pathValue: options?.pathValue,
    });
    return buildResolution({
      command: rawValue,
      resolvedPath: fromPath,
      source: override.source,
      fromOverride: true,
      warning: fromPath
        ? null
        : `${override.key} command was not found in PATH: ${rawValue}`,
    });
  }

  const defaultFromPath = resolveFromPath({
    command: OPENCLAW_COMMAND_NAME,
    platform,
    env,
    pathValue: options?.pathValue,
  });
  if (defaultFromPath) {
    return buildResolution({
      command: defaultFromPath,
      resolvedPath: defaultFromPath,
      source: "path_lookup",
      fromOverride: false,
    });
  }
  return buildResolution({
    command: OPENCLAW_COMMAND_NAME,
    resolvedPath: null,
    source: "default",
    fromOverride: false,
    warning: "openclaw command not found in PATH",
  });
};

export const withOpenClawPathInEnv = (
  baseEnv: NodeJS.ProcessEnv,
  resolution: OpenClawBinaryResolution,
): NodeJS.ProcessEnv => {
  const resolvedPath = resolution.resolvedPath;
  if (!resolvedPath) return baseEnv;
  const binDir = path.dirname(resolvedPath);
  const currentPath = trimNonEmpty(baseEnv.PATH);
  const entries = splitPathEntries(currentPath);
  if (entries.some((entry) => path.resolve(entry) === path.resolve(binDir))) {
    return baseEnv;
  }
  const nextPath = currentPath
    ? `${binDir}${path.delimiter}${currentPath}`
    : binDir;
  return { ...baseEnv, PATH: nextPath };
};

export const applyOpenClawBinaryToShellCommand = (
  command: string,
  resolution: OpenClawBinaryResolution,
): string => {
  const raw = typeof command === "string" ? command : "";
  const match =
    /^(\s*)(?:"([^"]+)"|'([^']+)'|(\S+))([\s\S]*)$/u.exec(raw);
  if (!match) return raw;
  const prefix = match[1] ?? "";
  const token = (match[2] ?? match[3] ?? match[4] ?? "").trim();
  const rest = match[5] ?? "";
  if (!token.length) return raw;
  const base = getCommandTokenBaseName(token);
  if (!OPENCLAW_TOKEN_PATTERN.test(base)) return raw;
  return `${prefix}${resolution.shellToken}${rest}`;
};

export interface OpenClawBinaryProbeResult {
  ok: boolean;
  code: number | null;
  version: string | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

export const probeOpenClawBinary = async (
  resolution: OpenClawBinaryResolution,
  timeoutMs = 10_000,
): Promise<OpenClawBinaryProbeResult> =>
  new Promise<OpenClawBinaryProbeResult>((resolve) => {
    const child = spawn(resolution.command, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: withOpenClawPathInEnv({ ...process.env }, resolution),
      timeout: Math.max(1_000, timeoutMs),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      resolve({
        ok: false,
        code: null,
        version: null,
        stdout,
        stderr,
        error: error.message,
      });
    });
    child.on("close", (code: number | null) => {
      const versionLine = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? null;
      resolve({
        ok: code === 0,
        code: typeof code === "number" ? code : null,
        version: code === 0 ? versionLine : null,
        stdout,
        stderr,
        error: code === 0 ? null : null,
      });
    });
  });
