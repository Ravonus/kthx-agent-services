/**
 * Agent service self-update helpers for supervisor.
 *
 * Supports:
 * - resolving agent-service repo root from runtime script path
 * - guarded git pull (optional dirty-worktree block)
 * - optional pnpm install/build pipeline
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import type { KthxUpdatesConfig } from "../types/config.js";

export type RunUpdateOptions = {
  updates: KthxUpdatesConfig;
  runtimeScriptPath: string;
};

export type RunUpdateResult = {
  ok: boolean;
  repoDir: string;
  error: string | null;
};

type RunCommandOptions = {
  cwd: string;
  timeoutMs: number;
  captureStdout?: boolean;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
};

type RunCommandResult = {
  ok: boolean;
  code: number | null;
  signal: string | null;
  stdout: string;
  error: string | null;
};

type PackageManagerCandidate = {
  command: string;
  args: string[];
  label: string;
};

const hasRepoMarkers = (dirPath: string): boolean => {
  const gitPath = path.join(dirPath, ".git");
  const pkgPath = path.join(dirPath, "package.json");
  return fs.existsSync(gitPath) && fs.existsSync(pkgPath);
};

const findRepoRoot = (startDir: string): string | null => {
  let current = path.resolve(startDir);
  for (;;) {
    if (hasRepoMarkers(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

export const resolveAgentServiceRepoDir = (options: {
  configuredRepoDir: string;
  runtimeScriptPath: string;
}): string => {
  const configured = options.configuredRepoDir.trim();
  if (configured.length > 0) {
    return path.resolve(configured);
  }

  const runtimeScriptAbs = path.resolve(options.runtimeScriptPath);
  const runtimeDir = path.dirname(runtimeScriptAbs);
  const candidates = [
    runtimeDir,
    path.dirname(runtimeDir),
    process.cwd(),
  ];
  for (const candidate of candidates) {
    const root = findRepoRoot(candidate);
    if (root) return root;
  }
  return path.resolve(process.cwd());
};

const runCommand = async (
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<RunCommandResult> =>
  new Promise<RunCommandResult>((resolve) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let stdout = "";
    let finished = false;

    const finish = (
      payload: Omit<RunCommandResult, "stdout"> & { stdout?: string },
    ): void => {
      if (finished) return;
      finished = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({
        stdout: payload.stdout ?? stdout,
        ok: payload.ok,
        code: payload.code,
        signal: payload.signal,
        error: payload.error,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: options.captureStdout ? ["ignore", "pipe", "inherit"] : "inherit",
        windowsHide: process.platform === "win32",
        shell: options.shell ?? false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finish({
        ok: false,
        code: null,
        signal: null,
        error: message,
      });
      return;
    }

    if (options.captureStdout && child.stdout) {
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      });
    }

    timeoutHandle = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        ok: false,
        code: null,
        signal: "SIGTERM",
        error: `timeout after ${options.timeoutMs}ms: ${command} ${args.join(" ")}`,
      });
    }, options.timeoutMs);

    child.on("error", (error) => {
      finish({
        ok: false,
        code: null,
        signal: null,
        error: error.message,
      });
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        finish({
          ok: true,
          code,
          signal,
          error: null,
        });
        return;
      }
      finish({
        ok: false,
        code,
        signal,
        error: `${command} ${args.join(" ")} failed (${typeof code === "number" ? `code=${code}` : `signal=${signal ?? "unknown"}`})`,
      });
    });
  });

const trimEnvValue = (name: string): string | null => {
  const value = process.env[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseBool = (raw: string | null, fallback: boolean): boolean => {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const resolvePathKey = (env: NodeJS.ProcessEnv): string => {
  const match = Object.keys(env).find(
    (key) => key.toLowerCase() === "path",
  );
  if (match) return match;
  return process.platform === "win32" ? "Path" : "PATH";
};

const normalizePathForComparison = (input: string): string =>
  process.platform === "win32" ? input.toLowerCase() : input;

const buildUpdateEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  const pathKey = resolvePathKey(env);
  const currentRaw = typeof env[pathKey] === "string" ? env[pathKey] : "";
  const current = currentRaw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const prepended: string[] = [];
  const extraPathRaw = trimEnvValue("MG_AGENT_UPDATE_PATH_PREPEND");
  if (extraPathRaw) {
    prepended.push(
      ...extraPathRaw
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    );
  }

  if (process.platform === "win32") {
    const appData =
      trimEnvValue("APPDATA") ??
      (trimEnvValue("USERPROFILE")
        ? path.join(trimEnvValue("USERPROFILE")!, "AppData", "Roaming")
        : null);
    if (appData) {
      prepended.push(path.join(appData, "npm"));
    }
  }

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...prepended, ...current]) {
    const key = normalizePathForComparison(path.resolve(entry));
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }

  env[pathKey] = merged.join(path.delimiter);
  return env;
};

const commandLooksMissing = (result: RunCommandResult): boolean => {
  if (!result.error) return false;
  const msg = result.error.toLowerCase();
  return (
    msg.includes("enoent") ||
    msg.includes("not found") ||
    msg.includes("is not recognized")
  );
};

const buildPackageManagerCandidates = (
  updates: KthxUpdatesConfig,
  args: string[],
): PackageManagerCandidate[] => {
  const configuredExecutable =
    trimEnvValue("MG_AGENT_UPDATE_PACKAGE_MANAGER_EXECUTABLE") ??
    updates.packageManagerExecutable.trim() ??
    "pnpm";
  const useNpmExecFallback = parseBool(
    trimEnvValue("MG_AGENT_UPDATE_PACKAGE_MANAGER_USE_NPM_EXEC_FALLBACK"),
    updates.packageManagerUseNpmExecFallback,
  );

  const specs: PackageManagerCandidate[] = [];
  const seen = new Set<string>();
  const push = (command: string, cmdArgs: string[], label: string): void => {
    const normalizedCommand = command.trim();
    if (!normalizedCommand) return;
    const key = `${normalizePathForComparison(normalizedCommand)}::${cmdArgs.join("\u0000")}`;
    if (seen.has(key)) return;
    seen.add(key);
    specs.push({ command: normalizedCommand, args: [...cmdArgs], label });
  };

  push(configuredExecutable, args, "configured");

  if (process.platform === "win32") {
    const appData =
      trimEnvValue("APPDATA") ??
      (trimEnvValue("USERPROFILE")
        ? path.join(trimEnvValue("USERPROFILE")!, "AppData", "Roaming")
        : null);
    if (appData) {
      push(
        path.join(appData, "npm", "pnpm.cmd"),
        args,
        "windows_appdata_pnpm_cmd",
      );
      push(
        path.join(appData, "npm", "pnpm.exe"),
        args,
        "windows_appdata_pnpm_exe",
      );
    }
  }

  if (useNpmExecFallback) {
    push("npm", ["exec", "--yes", "pnpm", ...args], "npm_exec_pnpm");
    push("npx", ["--yes", "pnpm", ...args], "npx_pnpm");
  }

  return specs;
};

const runPackageManagerTask = async (input: {
  updates: KthxUpdatesConfig;
  cwd: string;
  timeoutMs: number;
  args: string[];
  taskLabel: string;
  envOverrides?: Record<string, string>;
}): Promise<RunCommandResult> => {
  const env = {
    ...buildUpdateEnv(),
    ...(input.envOverrides ?? {}),
  };
  const candidates = buildPackageManagerCandidates(input.updates, input.args);
  let lastResult: RunCommandResult | null = null;

  for (const candidate of candidates) {
    const result = await runCommand(candidate.command, candidate.args, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      env,
      shell: process.platform === "win32",
    });
    if (result.ok) return result;

    lastResult = result;
    if (!commandLooksMissing(result)) {
      return {
        ...result,
        error:
          result.error ??
          `${candidate.command} ${candidate.args.join(" ")} failed`,
      };
    }
  }

  const attempts = candidates
    .map((candidate) => `${candidate.command} ${candidate.args.join(" ")} [${candidate.label}]`)
    .join(" | ");
  return {
    ok: false,
    code: lastResult?.code ?? null,
    signal: lastResult?.signal ?? null,
    stdout: lastResult?.stdout ?? "",
    error:
      lastResult?.error ??
      `${input.taskLabel} failed: no package manager command resolved (${attempts})`,
  };
};

export const runAgentServiceUpdate = async (
  options: RunUpdateOptions,
): Promise<RunUpdateResult> => {
  const repoDir = resolveAgentServiceRepoDir({
    configuredRepoDir: options.updates.repoDir,
    runtimeScriptPath: options.runtimeScriptPath,
  });

  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    return {
      ok: false,
      repoDir,
      error: `repo directory does not exist: ${repoDir}`,
    };
  }

  if (!options.updates.allowDirtyWorkingTree) {
    const dirty = await runCommand(
      "git",
      ["-C", repoDir, "status", "--porcelain"],
      {
        cwd: repoDir,
        timeoutMs: options.updates.timeoutMs,
        captureStdout: true,
      },
    );
    if (!dirty.ok) {
      return {
        ok: false,
        repoDir,
        error: dirty.error ?? "failed to inspect working tree status",
      };
    }
    if (dirty.stdout.trim().length > 0) {
      return {
        ok: false,
        repoDir,
        error: "working tree is dirty; set updates.allowDirtyWorkingTree=true to force update",
      };
    }
  }

  const pull = await runCommand(
    "git",
    [
      "-C",
      repoDir,
      "pull",
      "--ff-only",
      options.updates.remote,
      options.updates.branch,
    ],
    { cwd: repoDir, timeoutMs: options.updates.timeoutMs },
  );
  if (!pull.ok) {
    return { ok: false, repoDir, error: pull.error ?? "git pull failed" };
  }

  if (options.updates.runInstall) {
    const install = await runPackageManagerTask({
      updates: options.updates,
      cwd: repoDir,
      timeoutMs: options.updates.timeoutMs,
      args: ["install"],
      taskLabel: "install",
    });
    if (!install.ok) {
      return {
        ok: false,
        repoDir,
        error: install.error ?? "install failed",
      };
    }
  }

  if (options.updates.runBuild) {
    // DTS generation can fail on non-critical declaration issues; keep update
    // flow reliable by compiling JS artifacts only during supervisor updates.
    const build = await runPackageManagerTask({
      updates: options.updates,
      cwd: repoDir,
      timeoutMs: options.updates.timeoutMs,
      args: ["run", "build"],
      taskLabel: "build",
      envOverrides: { MG_AGENT_BUILD_DTS: "0" },
    });
    if (!build.ok) {
      return {
        ok: false,
        repoDir,
        error: build.error ?? "build failed",
      };
    }
  }

  return { ok: true, repoDir, error: null };
};
