import fs from "node:fs/promises";
import path from "node:path";

import { trimEnv } from "./lib/env-parse.js";
import {
  registerBot,
  clearPersistedAgentKeyBox,
  persistAgentKeyBox,
  persistAgentIdentity,
  readPersistedAgentKeyBox,
} from "./auth/register.js";

export type AgentAuthBootstrapDeps = {
  config: {
    stateDir: string;
    realtimeWsUrl: string;
  };
  supervisorPid: number | null;
  supervisorConnectionId: string | null;
  agentKey: string | null;
};

export type AgentAuthBootstrapResult = {
  agentKey: string | null;
  getAgentKeyBox: () => string | null;
  refreshAgentKeyBoxFromLocalSources: (
    reason: string,
    options?: { allowPersisted?: boolean },
  ) => Promise<{
    ok: boolean;
    changed: boolean;
    source: string | null;
  }>;
};

export const bootstrapAgentAuth = async (
  deps: AgentAuthBootstrapDeps,
): Promise<AgentAuthBootstrapResult> => {
  const config = deps.config;
  const supervisorPid = deps.supervisorPid;
  const supervisorConnectionId = deps.supervisorConnectionId;
  const agentKey = deps.agentKey;
  let agentKeyBox: string | null = null;
const readOwnedPersistedAgentKeyBox = async (): Promise<string | null> => {
  if (agentKey) return null;
  const persisted = await readPersistedAgentKeyBox(config.stateDir);
  if (!persisted) return null;
  const ownedByCurrentSupervisor =
    typeof supervisorPid === "number" &&
    persisted.ownerSupervisorPid === supervisorPid;
  if (ownedByCurrentSupervisor) {
    return persisted.agentKeyBox;
  }
  await clearPersistedAgentKeyBox(config.stateDir);
  console.log(
    "[agent-runtime] Ignored stale persisted agentKeyBox; cleared because supervisor PID did not match.",
  );
  return null;
};

const resolveAgentKeyBoxFromSources = async (options: {
  allowPersisted: boolean;
}): Promise<{ keyBox: string | null; source: string | null }> => {
  const envKeyBox = trimEnv("MG_AGENT_KEY_BOX");
  if (envKeyBox && envKeyBox.trim().length > 0) {
    return {
      keyBox: envKeyBox.trim(),
      source: "env:MG_AGENT_KEY_BOX",
    };
  }

  const keyBoxFile = trimEnv("MG_AGENT_KEY_BOX_FILE");
  if (keyBoxFile && keyBoxFile.trim().length > 0) {
    const resolvedPath = path.resolve(keyBoxFile);
    const raw = await fs.readFile(resolvedPath, "utf8").catch(() => null);
    const fileKeyBox = typeof raw === "string" ? raw.trim() : "";
    if (fileKeyBox.length > 0) {
      return {
        keyBox: fileKeyBox,
        source: `file:${resolvedPath}`,
      };
    }
  }

  if (options.allowPersisted) {
    const persistedKeyBox = await readOwnedPersistedAgentKeyBox();
    if (persistedKeyBox && persistedKeyBox.trim().length > 0) {
      return {
        keyBox: persistedKeyBox.trim(),
        source: "persisted:state",
      };
    }
  }

  return { keyBox: null, source: null };
};

const applyResolvedAgentKeyBox = async (input: {
  keyBox: string;
  source: string | null;
  reason: string;
}): Promise<{ changed: boolean; source: string | null }> => {
  const normalized = input.keyBox.trim();
  if (!normalized.length) return { changed: false, source: input.source };
  const changed = normalized !== (agentKeyBox ?? "");
  agentKeyBox = normalized;
  process.env.MG_AGENT_KEY_BOX = normalized;
  if (changed && typeof supervisorPid === "number") {
    const savedPath = await persistAgentKeyBox({
      agentKeyBox: normalized,
      stateDir: config.stateDir,
      ownerSupervisorPid: supervisorPid,
      ownerConnectionId: supervisorConnectionId,
    }).catch(() => null);
    if (savedPath) {
      console.log(
        `[agent-runtime] Persisted refreshed agentKeyBox to ${savedPath} (reason=${input.reason}).`,
      );
    }
  }
  if (changed) {
    console.log(
      `[agent-runtime] Loaded agentKeyBox from ${input.source ?? "unknown"} (reason=${input.reason}).`,
    );
  }
  return { changed, source: input.source };
};

const refreshAgentKeyBoxFromLocalSources = async (
  reason: string,
  options: { allowPersisted?: boolean } = {},
): Promise<{
  ok: boolean;
  changed: boolean;
  source: string | null;
}> => {
  const resolved = await resolveAgentKeyBoxFromSources({
    allowPersisted: options.allowPersisted ?? true,
  });
  if (!resolved.keyBox) {
    return { ok: false, changed: false, source: resolved.source };
  }
  const applied = await applyResolvedAgentKeyBox({
    keyBox: resolved.keyBox,
    source: resolved.source,
    reason,
  });
  return {
    ok: true,
    changed: applied.changed,
    source: applied.source,
  };
};

await refreshAgentKeyBoxFromLocalSources("startup_bootstrap", {
  allowPersisted: true,
});

const clearOwnerInviteEnv = (reason: string) => {
  const hadInviteToken = Boolean(trimEnv("MG_OWNER_INVITE_TOKEN"));
  delete process.env.MG_OWNER_INVITE_TOKEN;
  delete process.env.MG_OWNER_HANDLE;
  delete process.env.MG_OWNER_NAME;
  if (hadInviteToken) {
    console.log(
      `[agent-runtime] Cleared MG_OWNER_INVITE_TOKEN from runtime env (${reason}).`,
    );
  }
};

if (agentKeyBox || agentKey) {
  clearOwnerInviteEnv("key_auth_already_available");
}

// First-time registration via owner invite token
const ownerInviteToken = trimEnv("MG_OWNER_INVITE_TOKEN");
if (!agentKeyBox && !agentKey && ownerInviteToken) {
  const handle = trimEnv("MG_AGENT_HANDLE") ?? undefined;
  const agentName = trimEnv("MG_AGENT_NAME") ?? undefined;
  const ownerHandle = trimEnv("MG_OWNER_HANDLE") ?? undefined;
  const ownerName = trimEnv("MG_OWNER_NAME") ?? undefined;

  if (handle) {
    console.log(
      `[agent-runtime] No agentKeyBox found. Registering as @${handle} via owner invite token...`,
    );
  } else {
    console.log(
      "[agent-runtime] No agentKeyBox found. Starting self-discovery registration via owner invite token...",
    );
  }

  const result = await registerBot({
    wsUrl: config.realtimeWsUrl,
    ownerInviteToken,
    handle,
    name: agentName,
    owner:
      ownerHandle && ownerName
        ? { handle: ownerHandle, name: ownerName }
        : undefined,
  });
  agentKeyBox = result.agentKeyBox.trim();
  process.env.MG_AGENT_KEY_BOX = agentKeyBox;

  // Persist credentials for future boots
  if (typeof supervisorPid === "number") {
    const savedPath = await persistAgentKeyBox({
      agentKeyBox,
      stateDir: config.stateDir,
      ownerSupervisorPid: supervisorPid,
      ownerConnectionId: supervisorConnectionId,
    });
    console.log(
      `[agent-runtime] Registration complete. agentKeyBox saved to ${savedPath} (owned by supervisor pid ${supervisorPid}).`,
    );
  } else {
    console.log(
      "[agent-runtime] Registration complete. Skipped convenience key persistence because runtime is not owned by a supervisor PID.",
    );
  }
  console.log(
    `[agent-runtime] Registered as @${result.user.handle} (id: ${result.user.id})`,
  );

  // Persist identity metadata if self-discovery was used
  if (result.identity) {
    const identityPath = await persistAgentIdentity({
      identity: result.identity,
      stateDir: config.stateDir,
    });
    console.log(`[agent-runtime] Agent identity saved to ${identityPath}`);
  }

  console.log(
    "[agent-runtime] You can remove MG_OWNER_INVITE_TOKEN from your env — it has been consumed.",
  );
  clearOwnerInviteEnv("registration_complete");
}

if (!agentKeyBox && !agentKey) {
  throw new Error(
    "Missing agent auth. Set MG_AGENT_KEY_BOX (or MG_AGENT_KEY_BOX_FILE), MG_AGENT_KEY, or MG_OWNER_INVITE_TOKEN for first-time registration.",
  );
}
  return {
    agentKey,
    getAgentKeyBox: () => agentKeyBox,
    refreshAgentKeyBoxFromLocalSources,
  };
};
