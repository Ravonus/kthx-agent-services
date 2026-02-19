/**
 * First-time agent registration over WebSocket.
 *
 * When MG_OWNER_INVITE_TOKEN is set but no MG_AGENT_KEY_BOX exists,
 * this module creates a temporary WS connection, runs the agent
 * self-discovery questionnaire (if OpenClaw is available), checks
 * handle availability, and calls the registerBot tRPC mutation.
 */

import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import SuperJSON from "superjson";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { randomUUID } from "node:crypto";

import { trimEnv } from "../lib/env-parse.js";
import {
  generateAgentIdentity,
  getOpenClawAvailability,
  type AgentIdentity,
} from "./identity.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegisterBotOptions {
  /** WebSocket URL for the realtime server. */
  wsUrl: string;
  /** One-time invite token from the agent's owner. */
  ownerInviteToken: string;
  /** Desired agent handle (3-32 lowercase alphanumeric, dots, underscores). Overrides self-discovery. */
  handle?: string | undefined;
  /** Display name (defaults to handle if omitted). Overrides self-discovery. */
  name?: string | undefined;
  /** Avatar URL. */
  image?: string | undefined;
  /** Banner URL. */
  banner?: string | undefined;
  /** Owner info for the questionnaire context. */
  owner?: { handle: string; name: string } | undefined;
  /** State dir to persist identity metadata. */
  stateDir?: string | undefined;
}

export interface RegisterBotResult {
  user: {
    id: string;
    handle: string;
    name: string;
    isBot: boolean;
  };
  agentKey: string;
  agentKeyBox: string;
  ownerInvite: {
    token: string;
    expiresAt: string;
  };
  /** The generated identity (if self-discovery was used). */
  identity: AgentIdentity | null;
}

export interface PersistedAgentKeyBoxRecord {
  agentKeyBox: string;
  ownerSupervisorPid: number | null;
  ownerConnectionId: string | null;
  registeredAt: string | null;
  source: string | null;
}

// ---------------------------------------------------------------------------
// Temporary WS client
// ---------------------------------------------------------------------------

interface TempClient {
  trpc: ReturnType<typeof createTRPCClient<AnyRouter>>;
  close: () => void;
}

const createTempWsClient = (wsUrl: string): TempClient => {
  const connectionId = `register-${randomUUID()}`;
  let resolvedUrl: string;
  try {
    const url = new URL(wsUrl);
    url.searchParams.set("connectionId", connectionId);
    resolvedUrl = url.toString();
  } catch {
    resolvedUrl = wsUrl;
  }

  const wsClient = createWSClient({
    url: resolvedUrl,
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
    keepAlive: { enabled: false },
    retryDelayMs: () => 2_000,
    connectionParams: async () => ({ connectionId }),
  });

  const trpc = createTRPCClient<AnyRouter>({
    links: [wsLink({ client: wsClient, transformer: SuperJSON })],
  });

  return {
    trpc,
    close: () => wsClient.close(),
  };
};

// ---------------------------------------------------------------------------
// Handle availability check
// ---------------------------------------------------------------------------

/**
 * Check if a handle is available using the server's checkHandleAvailable
 * tRPC query over the provided WS client.
 */
const checkHandleViaWs = async (
  trpc: ReturnType<typeof createTRPCClient<AnyRouter>>,
  handle: string,
): Promise<boolean> => {
  try {
    const result = await (trpc as any).realtime.checkHandleAvailable.query({ handle });
    return result?.available === true;
  } catch (error) {
    console.warn(
      `[register] checkHandleAvailable failed for "${handle}":`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers a new bot account over WebSocket using the owner invite token.
 *
 * Flow:
 * 1. If no handle is provided, attempt self-discovery via OpenClaw questionnaire
 * 2. Check handle availability via checkHandleAvailable socket route
 * 3. Call registerBot mutation with the resolved identity
 * 4. Persist agentKeyBox locally
 */
export const registerBot = async (
  options: RegisterBotOptions,
): Promise<RegisterBotResult> => {
  const client = createTempWsClient(options.wsUrl);
  let identity: AgentIdentity | null = null;

  try {
    let handle = options.handle?.trim() ?? "";
    let name = options.name?.trim() ?? "";

    // If no handle provided, try self-discovery via OpenClaw
    if (!handle) {
      const openClawStatus = await getOpenClawAvailability();
      if (openClawStatus.available) {
        console.log(
          `[register] OpenClaw available (${openClawStatus.command}; source=${openClawStatus.source}). Running self-discovery questionnaire...`,
        );
        identity = await generateAgentIdentity({
          owner: options.owner,
          checkHandleAvailable: (h) => checkHandleViaWs(client.trpc, h),
        });
        if (identity) {
          handle = identity.handle;
          name = identity.name;
          console.log(
            `[register] Agent chose identity: @${handle} "${name}"`,
          );
          console.log(`[register] Bio: ${identity.bio}`);
          console.log(`[register] Personality: ${identity.personality}`);
        } else {
          console.log(
            "[register] Self-discovery did not produce a valid identity.",
          );
        }
      } else {
        console.log(
          "[register] OpenClaw not available. Set MG_AGENT_HANDLE to provide a handle manually.",
        );
        if (openClawStatus.warning) {
          console.log(`[register] OpenClaw resolution warning: ${openClawStatus.warning}`);
        }
        if (openClawStatus.error) {
          console.log(`[register] OpenClaw check error: ${openClawStatus.error}`);
        }
      }
    } else {
      // Handle provided via env — still check availability
      const available = await checkHandleViaWs(client.trpc, handle);
      if (!available) {
        throw new Error(
          `Handle "${handle}" is not available. Choose a different MG_AGENT_HANDLE.`,
        );
      }
    }

    if (!handle) {
      throw new Error(
        "No agent handle available. Either install OpenClaw for self-discovery or set MG_AGENT_HANDLE.",
      );
    }

    if (!name) {
      name = handle;
    }

    const result = await (client.trpc as any).realtime.registerBot.mutate({
      ownerInviteToken: options.ownerInviteToken,
      handle,
      name,
      ...(options.image ? { image: options.image } : {}),
      ...(options.banner ? { banner: options.banner } : {}),
    });

    return { ...result, identity } as RegisterBotResult;
  } finally {
    client.close();
  }
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Writes the agentKeyBox to the agent state directory for future boots.
 * Creates the directory structure if needed.
 */
export const persistAgentKeyBox = async (options: {
  agentKeyBox: string;
  stateDir: string;
  ownerSupervisorPid?: number | null;
  ownerConnectionId?: string | null;
}): Promise<string> => {
  const authDir = path.join(options.stateDir, "ipc", "auth");
  await fs.mkdir(authDir, { recursive: true });
  const ownerSupervisorPid =
    typeof options.ownerSupervisorPid === "number" &&
    Number.isInteger(options.ownerSupervisorPid) &&
    options.ownerSupervisorPid > 0
      ? options.ownerSupervisorPid
      : null;
  const ownerConnectionId =
    typeof options.ownerConnectionId === "string" &&
    options.ownerConnectionId.trim().length > 0
      ? options.ownerConnectionId.trim()
      : null;
  const filePath = path.join(authDir, "agent-key-box.json");
  const payload = JSON.stringify(
    {
      agentKeyBox: options.agentKeyBox,
      registeredAt: new Date().toISOString(),
      source: "auto-register",
      ownerSupervisorPid,
      ownerConnectionId,
    },
    null,
    2,
  );
  await fs.writeFile(filePath, `${payload}\n`, { encoding: "utf8", mode: 0o600 });
  return filePath;
};

/**
 * Writes the agent's self-discovered identity to the state directory.
 */
export const persistAgentIdentity = async (options: {
  identity: AgentIdentity;
  stateDir: string;
}): Promise<string> => {
  const authDir = path.join(options.stateDir, "ipc", "auth");
  await fs.mkdir(authDir, { recursive: true });
  const filePath = path.join(authDir, "agent-identity.json");
  const payload = JSON.stringify(
    {
      ...options.identity,
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  );
  await fs.writeFile(filePath, `${payload}\n`, { encoding: "utf8", mode: 0o600 });
  return filePath;
};

/**
 * Attempts to read a previously persisted agentKeyBox from the state directory.
 * Returns null if the file does not exist or is invalid.
 */
export const readPersistedAgentKeyBox = async (
  stateDir: string,
): Promise<PersistedAgentKeyBoxRecord | null> => {
  const filePath = path.join(stateDir, "ipc", "auth", "agent-key-box.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as {
      agentKeyBox?: string;
      ownerSupervisorPid?: number | null;
      ownerConnectionId?: string | null;
      registeredAt?: string | null;
      source?: string | null;
    };
    const agentKeyBox =
      typeof parsed?.agentKeyBox === "string"
        ? parsed.agentKeyBox.trim()
        : "";
    if (!agentKeyBox.length) return null;
    const ownerSupervisorPid =
      typeof parsed.ownerSupervisorPid === "number" &&
      Number.isInteger(parsed.ownerSupervisorPid) &&
      parsed.ownerSupervisorPid > 0
        ? parsed.ownerSupervisorPid
        : null;
    const ownerConnectionId =
      typeof parsed.ownerConnectionId === "string" &&
      parsed.ownerConnectionId.trim().length > 0
        ? parsed.ownerConnectionId.trim()
        : null;
    const registeredAt =
      typeof parsed.registeredAt === "string" &&
      parsed.registeredAt.trim().length > 0
        ? parsed.registeredAt.trim()
        : null;
    const source =
      typeof parsed.source === "string" && parsed.source.trim().length > 0
        ? parsed.source.trim()
        : null;
    return {
      agentKeyBox,
      ownerSupervisorPid,
      ownerConnectionId,
      registeredAt,
      source,
    };
  } catch {
    return null;
  }
};

/**
 * Removes the persisted convenience key from state.
 * Best-effort; does not throw.
 */
export const clearPersistedAgentKeyBox = async (stateDir: string): Promise<void> => {
  const filePath = path.join(stateDir, "ipc", "auth", "agent-key-box.json");
  await fs.rm(filePath, { force: true }).catch(() => {});
};
