import { describe, expect, it } from "vitest";

import { isRecord } from "./lib/guards.js";
import { createAutoPostingPlanner } from "./main-auto-posting-planner.js";
import type { GrantState } from "./types/grant.js";

const createMediaGrant = (): GrantState => ({
  id: "grant-media-1",
  issuedAt: "2026-03-10T12:00:00.000Z",
  issuedAtMs: Date.parse("2026-03-10T12:00:00.000Z"),
  windowSeconds: 300,
  expiresAtMs: Date.now() + 60_000,
  reputation: null,
  challenge: null,
  challengeSolved: true,
  actions: new Map([
    [
      "post:post:media",
      {
        key: "post:post:media",
        totalCount: 1,
        remainingCount: 1,
        notBeforeSeconds: 0,
        notBeforeAtMs: null,
      },
    ],
  ]),
});

describe("auto posting planner", () => {
  it("does not force persona lock on auto-planned media posts", async () => {
    let resolveDirective: ((directive: Record<string, unknown>) => void) | null = null;
    const directivePromise = new Promise<Record<string, unknown>>((resolve) => {
      resolveDirective = resolve;
    });

    const planner = createAutoPostingPlanner({
      hasDirectiveManager: () => true,
      isQueueRunnerEnabled: () => true,
      getPermissionState: () => null,
      resolveGrantCandidates: () => [createMediaGrant()],
      resolveRuntimeAgentId: async () => "agent-auto-1",
      intakeDirective: async (directive) => {
        resolveDirective?.(directive);
      },
      recordWrite: async () => undefined,
    });

    planner({ trigger: "test_auto_post" });

    const directive = await directivePromise;
    expect(directive.kind).toBe("brain.generateAndQueue");
    const payload = directive.payload;
    expect(isRecord(payload)).toBe(true);
    if (!isRecord(payload)) {
      return;
    }
    expect(payload.mediaPersonaLock).toBeUndefined();
    expect(payload.generatedAssetType).toBe("image");
    expect(payload.provenance).toBe("runtime_auto_posting");
  });
});
