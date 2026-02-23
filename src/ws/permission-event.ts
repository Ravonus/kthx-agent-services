import { isRecord } from "../lib/guards.js";

export type NormalizedPermissionStateEvent = {
  trigger: "permission_state" | "agent_permission_state";
  permissionState: Record<string, unknown>;
};

export const normalizePermissionStateEvent = (
  eventType: string,
  payload: unknown,
): NormalizedPermissionStateEvent | null => {
  if (eventType !== "permission_state" && eventType !== "agent_permission_state") {
    return null;
  }
  if (!isRecord(payload)) {
    return null;
  }
  const nestedState = isRecord(payload.state) ? payload.state : null;
  if (nestedState) {
    return {
      trigger: eventType,
      permissionState: nestedState,
    };
  }
  if (eventType === "agent_permission_state") {
    return {
      trigger: eventType,
      permissionState: payload,
    };
  }
  return null;
};
