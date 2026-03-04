import type WebSocket from "ws";

import { isRecord } from "../lib/guards.js";
import { nowIso } from "../lib/text.js";
import { requestRealtimeDisconnect } from "./chat-bridge-runtime-primitives.js";
import type { SubscriptionMode } from "./chat-bridge-runtime-primitives.js";

export const resolveBridgeAgentMainUserId = async (deps: {
  baseHttpUrl: string;
  agentProfileResolveCooldownMs: number;
  getBridgeAgentMainUserId: () => string | null;
  setBridgeAgentMainUserId: (value: string | null) => void;
  getLastAgentProfileResolveAtMs: () => number;
  setLastAgentProfileResolveAtMs: (value: number) => void;
  buildHeaders: (botToken: string | null) => Promise<Record<string, string>>;
}): Promise<string | null> => {
  const cachedAgentMainUserId = deps.getBridgeAgentMainUserId();
  if (cachedAgentMainUserId) return cachedAgentMainUserId;
  const nowMs = Date.now();
  if (
    nowMs - deps.getLastAgentProfileResolveAtMs() < deps.agentProfileResolveCooldownMs
  ) {
    return null;
  }
  deps.setLastAgentProfileResolveAtMs(nowMs);

  try {
    const response = await fetch(`${deps.baseHttpUrl}/api/agent/chat`, {
      method: "POST",
      headers: await deps.buildHeaders(null),
      body: JSON.stringify({ action: "agent_profile" }),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok || !isRecord(body) || body.ok !== true || !isRecord(body.data)) {
      return null;
    }
    const data = body.data;
    const agent = isRecord(data.agent) ? data.agent : null;
    const mainUserId = typeof agent?.mainUserId === "string" ? agent.mainUserId.trim() : "";
    if (!mainUserId.length) return null;
    deps.setBridgeAgentMainUserId(mainUserId);
    return mainUserId;
  } catch {
    return null;
  }
};

export const disconnectRealtimeOnAuthDrift = async (deps: {
  reason: string;
  viewerMainUserId: string | null;
  keyBoxAgentMainUserId: string | null;
  realtimeConnectionId: string | null;
  getBridgeAgentMainUserId: () => string | null;
  resolveBridgeAgentMainUserId: () => Promise<string | null>;
  appendBridgeEvent: (payload: Record<string, unknown>) => Promise<void>;
}): Promise<void> => {
  const resolvedUserId =
    deps.viewerMainUserId?.trim() ??
    deps.getBridgeAgentMainUserId()?.trim() ??
    (await deps.resolveBridgeAgentMainUserId())?.trim() ??
    deps.keyBoxAgentMainUserId?.trim() ??
    "";
  const connectionId = deps.realtimeConnectionId?.trim() ?? "";
  if (!resolvedUserId.length && !connectionId.length) {
    return;
  }

  const result = await requestRealtimeDisconnect({
    userId: resolvedUserId.length > 0 ? resolvedUserId : null,
    connectionId: connectionId.length > 0 ? connectionId : null,
    reason: deps.reason,
  });
  await deps.appendBridgeEvent({
    at: nowIso(),
    type: "realtime_disconnect_requested",
    reason: deps.reason,
    userId: resolvedUserId.length > 0 ? resolvedUserId : null,
    connectionId: connectionId.length > 0 ? connectionId : null,
    ok: result.ok,
    disconnected: result.disconnected,
    ...(result.error ? { error: result.error } : {}),
  });
};

export const requestModeSwitch = async (deps: {
  nextMode: SubscriptionMode;
  reason: string;
  idleEnabled: boolean;
  getDesiredMode: () => SubscriptionMode;
  setDesiredMode: (mode: SubscriptionMode) => void;
  appendBridgeEvent: (payload: Record<string, unknown>) => Promise<void>;
  updateStatus: (patch: Record<string, unknown>) => Promise<void>;
  getLastActivityAtIso: () => string;
  scheduleReconnect: (
    reason: string,
    options?: { baseDelayMs?: number; bumpAttempt?: boolean; force?: boolean },
  ) => Promise<void>;
  getActiveSocket: () => WebSocket | null;
}): Promise<void> => {
  if (!deps.idleEnabled && deps.nextMode !== "full") return;
  if (deps.getDesiredMode() === deps.nextMode) return;
  deps.setDesiredMode(deps.nextMode);

  await deps.appendBridgeEvent({
    at: nowIso(),
    type: "bridge_mode_switch_requested",
    mode: deps.nextMode,
    reason: deps.reason,
  });
  await deps.updateStatus({
    subscriptionMode: deps.nextMode,
    lastModeChangeAt: nowIso(),
    lastActivityAt: deps.getLastActivityAtIso(),
  });
  await deps.scheduleReconnect(`mode_switch:${deps.reason}`, {
    baseDelayMs: 120,
    bumpAttempt: false,
  });
  const socket = deps.getActiveSocket();
  if (
    socket &&
    (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING)
  ) {
    try {
      socket.close(1000, "mode_switch");
    } catch {
      // ignore
    }
  }
};

export const recordBridgeActivity = (deps: {
  reason: string;
  idleEnabled: boolean;
  getDesiredMode: () => SubscriptionMode;
  setLastActivityAtMs: (value: number) => void;
  appendBridgeEvent: (payload: Record<string, unknown>) => Promise<void>;
  updateStatus: (patch: Record<string, unknown>) => Promise<void>;
  getLastActivityAtIso: () => string;
  requestModeSwitch: (nextMode: SubscriptionMode, reason: string) => Promise<void>;
}): void => {
  deps.setLastActivityAtMs(Date.now());
  void deps
    .appendBridgeEvent({ at: nowIso(), type: "bridge_activity", reason: deps.reason })
    .catch(() => undefined);
  void deps.updateStatus({ lastActivityAt: deps.getLastActivityAtIso() });
  if (deps.idleEnabled && deps.getDesiredMode() === "idle_user_only") {
    void deps.requestModeSwitch("full", `activity:${deps.reason}`);
  }
};
