/** Run a shell command with environment variables and timeout. */

import { spawn } from "node:child_process";

export async function runShellCommand(
  timeoutMs: number,
  command: string,
  extraEnv: Record<string, string>,
): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
  timedOut: boolean;
}> {
  return await new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...extraEnv,
      },
    });
    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 5_000);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutParts.push(String(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrParts.push(String(chunk));
    });
    child.on("error", (error: unknown) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      const message = error instanceof Error ? error.message : String(error);
      resolve({
        ok: false,
        stdout: stdoutParts.join(""),
        stderr: stderrParts.join(""),
        error: message,
        timedOut,
      });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        ok: code === 0 && !timedOut,
        stdout: stdoutParts.join(""),
        stderr: stderrParts.join(""),
        error: null,
        timedOut,
      });
    });
  });
}
