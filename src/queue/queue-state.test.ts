import { describe, expect, it } from "vitest";

import type { QueueItem } from "../types/ipc.js";
import { computeDeterministicDelay } from "./queue-state.js";

const baseItem = (input: {
  id: string;
  inboxFile: string;
  queueClass: string;
  createdAt: string;
  forceNow?: boolean;
}): QueueItem => ({
  id: input.id,
  directiveId: input.id,
  inboxFile: input.inboxFile,
  queueClass: input.queueClass,
  forceNow: input.forceNow === true,
  commandFingerprint: null,
  status: "queued",
  createdAt: input.createdAt,
  dueAt: null,
  attempts: 0,
  startedAt: null,
  completedAt: null,
  lastAttemptAt: null,
  lastError: null,
  scheduledBy: null,
});

describe("queue deterministic delay planning", () => {
  it("keeps backlog spacing practical even when minSpacingSeconds is large", () => {
    const items: QueueItem[] = [
      baseItem({
        id: "one",
        inboxFile: "a.json",
        queueClass: "post",
        createdAt: "2026-02-24T00:00:00.000Z",
      }),
      baseItem({
        id: "two",
        inboxFile: "b.json",
        queueClass: "post",
        createdAt: "2026-02-24T00:00:01.000Z",
      }),
      baseItem({
        id: "three",
        inboxFile: "c.json",
        queueClass: "story",
        createdAt: "2026-02-24T00:00:02.000Z",
      }),
      baseItem({
        id: "four",
        inboxFile: "d.json",
        queueClass: "media",
        createdAt: "2026-02-24T00:00:03.000Z",
      }),
      baseItem({
        id: "five",
        inboxFile: "e.json",
        queueClass: "comment",
        createdAt: "2026-02-24T00:00:04.000Z",
      }),
      baseItem({
        id: "six",
        inboxFile: "f.json",
        queueClass: "engagement",
        createdAt: "2026-02-24T00:00:05.000Z",
      }),
    ];

    const delays = computeDeterministicDelay({
      pendingItems: items,
      minSpacingSeconds: 120,
      maxSpacingSeconds: 1_800,
    });

    const ordered = ["a.json", "b.json", "c.json", "d.json", "e.json", "f.json"]
      .map((inboxFile) => delays.get(inboxFile))
      .filter((value): value is number => typeof value === "number");
    expect(ordered.length).toBe(6);
    expect(ordered[0]).toBe(0);
    for (let index = 1; index < ordered.length; index += 1) {
      expect(ordered[index]).toBeGreaterThanOrEqual(ordered[index - 1] ?? 0);
    }
    expect((ordered[1] ?? 0) - (ordered[0] ?? 0)).toBeLessThanOrEqual(40);
    expect((ordered[ordered.length - 1] ?? 0) - (ordered[0] ?? 0)).toBeLessThanOrEqual(260);
  });
});
