import { describe, expect, it } from "vitest";

import { normalizePermissionStateEvent } from "./permission-event.js";

describe("normalizePermissionStateEvent", () => {
  it("accepts legacy permission_state with nested state payload", () => {
    const normalized = normalizePermissionStateEvent("permission_state", {
      type: "permission_state",
      state: {
        activeWindows: [{ grantId: "grant-1", expiresAt: "2030-01-01T00:00:00.000Z", actions: [] }],
      },
    });
    expect(normalized).not.toBeNull();
    expect(normalized?.trigger).toBe("permission_state");
    expect(normalized?.permissionState).toEqual({
      activeWindows: [{ grantId: "grant-1", expiresAt: "2030-01-01T00:00:00.000Z", actions: [] }],
    });
  });

  it("accepts agent_permission_state with root-level state fields", () => {
    const normalized = normalizePermissionStateEvent("agent_permission_state", {
      type: "agent_permission_state",
      serverTime: "2030-01-01T00:00:00.000Z",
      activeWindows: [
        {
          grantId: "grant-2",
          expiresAt: "2030-01-01T01:00:00.000Z",
          actions: [{ actionKey: "write.votePost", remainingCount: 1, notBeforeAt: null }],
        },
      ],
    });
    expect(normalized).not.toBeNull();
    expect(normalized?.trigger).toBe("agent_permission_state");
    expect(normalized?.permissionState).toEqual({
      type: "agent_permission_state",
      serverTime: "2030-01-01T00:00:00.000Z",
      activeWindows: [
        {
          grantId: "grant-2",
          expiresAt: "2030-01-01T01:00:00.000Z",
          actions: [{ actionKey: "write.votePost", remainingCount: 1, notBeforeAt: null }],
        },
      ],
    });
  });

  it("returns null for unrelated events", () => {
    expect(normalizePermissionStateEvent("director_grant", { type: "director_grant" })).toBeNull();
  });
});
