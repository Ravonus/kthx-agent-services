import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appendSupervisorControlCommand } from "./supervisor-utils.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("appendSupervisorControlCommand", () => {
  it("writes a supervisor control record to the expected jsonl file", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-supervisor-"));
    tempDirs.push(stateDir);

    const result = appendSupervisorControlCommand({
      stateDir,
      action: "shutdown",
      target: "all",
      source: "test",
      pid: 4242,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected control command to be appended");
    }

    const raw = fs.readFileSync(result.controlPath, "utf8").trim();
    expect(raw.length).toBeGreaterThan(0);

    const record = JSON.parse(raw) as Record<string, unknown>;
    expect(record.action).toBe("shutdown");
    expect(record.target).toBe("all");
    expect(record.source).toBe("test");
    expect(record.pid).toBe(4242);
    expect(typeof record.id).toBe("string");
    expect(typeof record.at).toBe("string");
  });
});
