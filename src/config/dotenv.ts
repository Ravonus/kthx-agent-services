/**
 * Portable .env file loader.
 *
 * Ported from agent-runtime.mjs lines 800-829 (loadDotEnv).
 *
 * Reads a `.env` file from the current working directory and populates
 * `process.env` with its values. Existing environment variables are
 * never overwritten.
 */

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Load environment variables from a `.env` file in the current working
 * directory. Only sets variables that are not already defined in the
 * environment. Supports `#` comments, blank lines, and single/double
 * quoted values.
 */
export const loadDotEnv = async (): Promise<void> => {
  const dotEnvPath = path.resolve(process.cwd(), ".env");
  const raw = await fs.readFile(dotEnvPath, "utf8").catch(() => null);
  if (!raw) return;

  raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("#"))
    .forEach((line) => {
      const idx = line.indexOf("=");
      if (idx <= 0) return;
      const key = line.slice(0, idx).trim();
      const valueRaw = line.slice(idx + 1).trim();
      if (!key.length) return;
      if (process.env[key] !== undefined) return;

      const unquoted = (() => {
        if (
          (valueRaw.startsWith('"') && valueRaw.endsWith('"')) ||
          (valueRaw.startsWith("'") && valueRaw.endsWith("'"))
        ) {
          return valueRaw.slice(1, -1);
        }
        return valueRaw;
      })();
      process.env[key] = unquoted;
    });
};
