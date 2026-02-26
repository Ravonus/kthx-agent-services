import { describe, expect, it } from "vitest";

import { runBackendCall } from "./runtime.js";
import type { RuntimeContext } from "./runtime-context.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const buildRuntimeContext = (connectionId: string): RuntimeContext =>
  ({
    config: {
      connectionId,
      backendSerializeRequests: true,
      backendRequestMinGapMs: 0,
      backendRequestMaxQueue: 32,
    },
  }) as unknown as RuntimeContext;

describe("runBackendCall", () => {
  it("serializes calls within the same runtime connection", async () => {
    const ctx = buildRuntimeContext("runtime-A");
    const sequence: string[] = [];

    const first = runBackendCall(
      "first",
      async () => {
        sequence.push("first:start");
        await sleep(90);
        sequence.push("first:end");
        return "first";
      },
      ctx,
    );

    const second = runBackendCall(
      "second",
      async () => {
        sequence.push("second:start");
        sequence.push("second:end");
        return "second";
      },
      ctx,
    );

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe("first");
    expect(secondResult).toBe("second");
    expect(sequence.indexOf("second:start")).toBeGreaterThan(
      sequence.indexOf("first:end"),
    );
  });

  it("does not serialize across different runtime connections", async () => {
    const slowCtx = buildRuntimeContext("runtime-slow");
    const fastCtx = buildRuntimeContext("runtime-fast");

    const slowCall = runBackendCall(
      "slow",
      async () => {
        await sleep(140);
        return "slow";
      },
      slowCtx,
    );

    const startedAt = Date.now();
    const fastResult = await runBackendCall(
      "fast",
      async () => "fast",
      fastCtx,
    );
    const elapsedMs = Date.now() - startedAt;

    expect(fastResult).toBe("fast");
    expect(elapsedMs).toBeLessThan(100);
    await slowCall;
  });
});

