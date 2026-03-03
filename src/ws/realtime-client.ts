/**
 * WebSocket / tRPC client creation for the realtime agent connection.
 *
 * Ported from agent-runtime.mjs lines 3647-3715.
 */

import WebSocket from "ws";
import SuperJSON from "superjson";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";

import { jitterDelay } from "../lib/async.js";
import { trimEnv } from "../lib/env-parse.js";
import { isRecord } from "../lib/guards.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base reconnect delay steps (ms) before jitter is applied. */
const baseReconnectDelaysMs: readonly number[] = [
  1_000, 2_000, 5_000, 10_000, 30_000,
];

/**
 * Returns `true` when the transport state represents an active connection.
 */
export const isConnectedSocketState = (
  state: string | null,
): boolean => state === "connected" || state === "open";

// ---------------------------------------------------------------------------
// Runtime integrity
// ---------------------------------------------------------------------------

export interface RuntimeIntegrity {
  runtimeMd5?: string;
  runtimeSha256?: string;
  runtimeManifestMd5?: string;
  runtimeManifestSha256?: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RealtimeClientOptions {
  /** Full WebSocket URL (base -- connectionId will be appended as a query param). */
  baseWsUrl: string;
  /** Unique connection identifier for this runtime session. */
  connectionId: string;
  /** Client-side keep-alive interval (ms). */
  clientKeepAliveMs: number;
  /** Async getter for the current bot token (may return null). */
  getBotToken: () => Promise<string | null>;
  /** Optional async getter for the current agent key box (allows runtime self-heal updates). */
  getAgentKeyBox?: () => Promise<string | null>;
  /**
   * Optional async function that returns runtime integrity hashes.
   * When provided, the hashes are sent in `connectionParams`.
   */
  getRuntimeIntegrity?: () => Promise<RuntimeIntegrity | null>;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface RealtimeClientResult<TRouter extends AnyRouter> {
  wsClient: ReturnType<typeof createWSClient>;
  trpc: ReturnType<typeof createTRPCClient<TRouter>>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a `Record<string, string>` connection-params dict from the
 * available auth credentials and runtime integrity hashes.
 */
const buildConnectionParamsDict = async (
  options: RealtimeClientOptions,
): Promise<Record<string, string>> => {
  const botToken = await options.getBotToken();
  const resolvedAgentKeyBox =
    typeof options.getAgentKeyBox === "function"
      ? await options.getAgentKeyBox().catch(() => null)
      : null;
  const agentKeyBox = resolvedAgentKeyBox?.trim() ?? trimEnv("MG_AGENT_KEY_BOX");

  const runtimeIntegrity: RuntimeIntegrity | null =
    typeof options.getRuntimeIntegrity === "function"
      ? await options.getRuntimeIntegrity().catch(() => null)
      : null;

  if (!botToken && !agentKeyBox) {
    throw new Error(
      "Missing auth bootstrap. Set MG_BOT_SESSION_TOKEN or MG_AGENT_KEY_BOX (or MG_AGENT_KEY_BOX_FILE).",
    );
  }

  const params: Record<string, string> = {
    connectionId: options.connectionId,
  };

  if (botToken) {
    params.botSessionToken = botToken;
  }
  if (agentKeyBox) {
    params.agentKeyBox = agentKeyBox;
  }
  if (
    isRecord(runtimeIntegrity) &&
    typeof runtimeIntegrity.runtimeMd5 === "string"
  ) {
    params.runtimeMd5 = runtimeIntegrity.runtimeMd5;
  }
  if (
    isRecord(runtimeIntegrity) &&
    typeof runtimeIntegrity.runtimeSha256 === "string"
  ) {
    params.runtimeSha256 = runtimeIntegrity.runtimeSha256;
  }
  if (
    isRecord(runtimeIntegrity) &&
    typeof runtimeIntegrity.runtimeManifestMd5 === "string"
  ) {
    params.runtimeManifestMd5 = runtimeIntegrity.runtimeManifestMd5;
  }
  if (
    isRecord(runtimeIntegrity) &&
    typeof runtimeIntegrity.runtimeManifestSha256 === "string"
  ) {
    params.runtimeManifestSha256 = runtimeIntegrity.runtimeManifestSha256;
  }

  return params;
};

/**
 * Creates a tRPC-over-WebSocket client with keepalive, jittered reconnect
 * back-off, and dynamic `connectionParams` that provide auth credentials
 * and runtime integrity hashes on every (re)connect.
 *
 * The generic `TRouter` allows callers to supply their own AppRouter type
 * for end-to-end type safety without importing server code.
 */
export const createRealtimeClient = <TRouter extends AnyRouter>(
  options: RealtimeClientOptions,
): RealtimeClientResult<TRouter> => {
  const wsUrl = ((): string => {
    try {
      const url = new URL(options.baseWsUrl);
      url.searchParams.set("connectionId", options.connectionId);
      return url.toString();
    } catch {
      return options.baseWsUrl;
    }
  })();

  const wsClient = createWSClient({
    url: wsUrl,
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
    keepAlive: {
      enabled: true,
      intervalMs: options.clientKeepAliveMs,
      pongTimeoutMs: 5_000,
    },
    retryDelayMs: (attemptIndex: number): number => {
      const base =
        baseReconnectDelaysMs[
          Math.min(attemptIndex, baseReconnectDelaysMs.length - 1)
        ] ?? 30_000;
      return jitterDelay(base);
    },
    connectionParams: async (): Promise<Record<string, string>> =>
      buildConnectionParamsDict(options),
  });

  const trpc = createTRPCClient<TRouter>({
    links: [wsLink({ client: wsClient, transformer: SuperJSON })],
  });

  return { wsClient, trpc };
};
