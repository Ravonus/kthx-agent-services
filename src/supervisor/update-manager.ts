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
};

type RunCommandResult = {
  ok: boolean;
  code: number | null;
  signal: string | null;
  stdout: string;
  error: string | null;
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
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.captureStdout ? ["ignore", "pipe", "inherit"] : "inherit",
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let stdout = "";
    let finished = false;

    if (options.captureStdout && child.stdout) {
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      });
    }

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
    const install = await runCommand(
      "pnpm",
      ["install"],
      { cwd: repoDir, timeoutMs: options.updates.timeoutMs },
    );
    if (!install.ok) {
      return {
        ok: false,
        repoDir,
        error: install.error ?? "pnpm install failed",
      };
    }
  }

  if (options.updates.runBuild) {
    const build = await runCommand(
      "pnpm",
      ["run", "build"],
      { cwd: repoDir, timeoutMs: options.updates.timeoutMs },
    );
    if (!build.ok) {
      return {
        ok: false,
        repoDir,
        error: build.error ?? "pnpm run build failed",
      };
    }
  }

  return { ok: true, repoDir, error: null };
};
