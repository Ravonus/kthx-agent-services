import fs from "node:fs/promises";
import path from "node:path";

import { isRecord } from "../lib/guards.js";
import {
  DOC_CONTEXT_PATH_CANDIDATES,
  buildSystemDocExcerpt,
} from "./chat-manager-context-utils.js";
import type { LinkedOwnerIdentity } from "./chat-types.js";

export interface SystemDocContextState {
  cached: string | null;
  cachedAtMs: number;
  inFlight: Promise<string | null> | null;
}

export interface LinkedOwnerIdentityState {
  cached: LinkedOwnerIdentity | null;
  cachedAtMs: number;
  inFlight: Promise<LinkedOwnerIdentity | null> | null;
}

export const createSystemDocContextState = (): SystemDocContextState => ({
  cached: null,
  cachedAtMs: 0,
  inFlight: null,
});

export const createLinkedOwnerIdentityState = (): LinkedOwnerIdentityState => ({
  cached: null,
  cachedAtMs: 0,
  inFlight: null,
});

export const loadSystemDocContext = async (
  state: SystemDocContextState,
): Promise<string | null> => {
  const nowMs = Date.now();
  if (state.cached && nowMs - state.cachedAtMs < 5 * 60_000) {
    return state.cached;
  }
  if (state.inFlight) {
    return state.inFlight;
  }

  state.inFlight = (async () => {
    const excerpts: string[] = [];
    for (const candidate of DOC_CONTEXT_PATH_CANDIDATES) {
      try {
        const raw = await fs.readFile(candidate, "utf8");
        const excerpt = buildSystemDocExcerpt(path.basename(candidate), raw);
        if (excerpt.length > 0) excerpts.push(excerpt);
      } catch {
        continue;
      }
    }
    const combined = excerpts.join("\n\n").trim();
    const capped = combined.length > 0 ? combined.slice(0, 2600) : null;
    state.cached = capped;
    state.cachedAtMs = Date.now();
    return capped;
  })();

  try {
    return await state.inFlight;
  } finally {
    state.inFlight = null;
  }
};

export type LoadLinkedOwnerIdentityDeps = {
  callAgentChatBridge: (payload: Record<string, unknown>) => Promise<unknown>;
};

export const loadLinkedOwnerIdentity = async (
  deps: LoadLinkedOwnerIdentityDeps,
  state: LinkedOwnerIdentityState,
): Promise<LinkedOwnerIdentity | null> => {
  const nowMs = Date.now();
  if (state.cached && nowMs - state.cachedAtMs < 5 * 60_000) {
    return state.cached;
  }
  if (state.inFlight) {
    return state.inFlight;
  }

  state.inFlight = (async () => {
    try {
      const response = await deps.callAgentChatBridge({ action: "agent_profile" });
      if (!isRecord(response)) return null;
      const agent = isRecord(response.agent) ? response.agent : null;
      const owner = isRecord(response.owner) ? response.owner : null;
      if (!agent || !owner) return null;

      const agentMainUserId =
        typeof agent.mainUserId === "string" ? agent.mainUserId.trim() : "";
      const ownerMainUserId =
        typeof owner.mainUserId === "string" ? owner.mainUserId.trim() : "";
      const ownerHandleRaw =
        typeof owner.handle === "string" ? owner.handle.trim() : "";
      const ownerHandle = ownerHandleRaw.replace(/^@+/u, "").toLowerCase();
      if (!agentMainUserId.length || !ownerMainUserId.length || !ownerHandle.length) {
        return null;
      }

      const agentHandleRaw =
        typeof agent.handle === "string" ? agent.handle.trim() : "";
      const agentHandleNormalized = agentHandleRaw
        .replace(/^@+/u, "")
        .toLowerCase();
      const agentName =
        typeof agent.name === "string" && agent.name.trim().length > 0
          ? agent.name.trim()
          : null;
      const ownerName =
        typeof owner.name === "string" && owner.name.trim().length > 0
          ? owner.name.trim()
          : null;

      const parsed: LinkedOwnerIdentity = {
        agentMainUserId,
        agentHandle: agentHandleNormalized.length > 0 ? agentHandleNormalized : null,
        agentName,
        ownerMainUserId,
        ownerHandle,
        ownerName,
      };
      state.cached = parsed;
      state.cachedAtMs = Date.now();
      return parsed;
    } catch {
      return null;
    }
  })();

  try {
    return await state.inFlight;
  } finally {
    state.inFlight = null;
  }
};
