import { clearBotTokenState } from "./auth/bot-token.js";
import { trimEnv } from "./lib/env-parse.js";
import { isRecord } from "./lib/guards.js";
import { nowIso } from "./lib/text.js";
import {
  isAgentKeyBoxAuthFailureMessage,
  isBotTokenAuthFailureMessage,
  parseRetryAfterMs,
  summarizeBridgeIssues,
} from "./main-helpers.js";

export type BridgeClientsDeps = {
  chatApiBaseUrl: string;
  supervisorConnectionId: string | null;
  agentKey: string | null;
  getAgentKeyBox: () => string | null;
  getBotToken: () => Promise<string | null>;
  refreshAgentKeyBoxForAuth: (reason: string) => Promise<boolean>;
  attemptMint: (reason: string) => Promise<void>;
  recordWrite: (payload: unknown) => Promise<void>;
};

export type BridgeClients = {
  callAgentChatBridge: (payload: unknown) => Promise<unknown>;
  callAgentUploadChunk: (payload: unknown) => Promise<unknown>;
};

export const createBridgeClients = (deps: BridgeClientsDeps): BridgeClients => {
  const chatBridgeRateLimitRetryFallbackMs = Math.max(
    5_000,
    Number.parseInt(
      trimEnv("MG_CHAT_RUNTIME_BRIDGE_RATE_LIMIT_RETRY_FALLBACK_MS") ?? "15000",
      10,
    ) || 15_000,
  );
  const chatBridgeTokenAuthRetryMs = Math.max(
    1_000,
    Number.parseInt(
      trimEnv("MG_CHAT_RUNTIME_BRIDGE_TOKEN_AUTH_RETRY_MS") ?? "5000",
      10,
    ) || 5_000,
  );
  let chatBridgeRateLimitedUntilMs = 0;
  let chunkUploadRateLimitedUntilMs = 0;
  let bridgeAuthHaltReason: string | null = null;
  const callAgentChatBridge = async (payload: unknown): Promise<unknown> => {
    if (bridgeAuthHaltReason) {
      const refreshed = await deps.refreshAgentKeyBoxForAuth(
        "chat_bridge_halt_guard",
      ).catch(() => false);
      if (refreshed) {
        bridgeAuthHaltReason = null;
      }
    }
    if (bridgeAuthHaltReason) {
      throw new Error(
        `agent chat bridge disabled after unauthorized response: ${bridgeAuthHaltReason}`,
      );
    }
    const nowMs = Date.now();
    if (chatBridgeRateLimitedUntilMs > nowMs) {
      throw new Error(
        `agent chat bridge request rate-limited (${chatBridgeRateLimitedUntilMs - nowMs}ms remaining)`,
      );
    }
    let attemptedTokenRecovery = false;
    let attemptedAgentKeyRecovery = false;
    while (true) {
      const botToken = await deps.getBotToken();
      const activeAgentKeyBox = deps.getAgentKeyBox();
      const response = await fetch(`${deps.chatApiBaseUrl}/api/agent/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(activeAgentKeyBox
            ? { "x-agent-key-box": activeAgentKeyBox }
            : { "x-agent-key": deps.agentKey ?? "" }),
          ...(botToken ? { "x-bot-session-token": botToken } : {}),
          ...(deps.supervisorConnectionId
            ? { "x-realtime-connection-id": deps.supervisorConnectionId }
            : {}),
        },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (
        response.ok &&
        isRecord(body) &&
        body.ok === true
      ) {
        chatBridgeRateLimitedUntilMs = 0;
        return body.data;
      }
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfterMs({
          response,
          body,
          fallbackMs: chatBridgeRateLimitRetryFallbackMs,
        });
        chatBridgeRateLimitedUntilMs = Math.max(
          chatBridgeRateLimitedUntilMs,
          Date.now() + retryAfterMs,
        );
        const errorMessage =
          isRecord(body) && typeof body.error === "string"
            ? body.error
            : "Too many requests";
        throw new Error(
          `agent chat bridge request rate-limited: ${errorMessage} (retryAfterMs=${retryAfterMs})`,
        );
      }
      const errorMessage =
        isRecord(body) && typeof body.error === "string"
          ? body.error
          : `HTTP ${response.status}`;
      const bridgeIssuesSummary = summarizeBridgeIssues(body);
      const isTokenAuthFailure =
        response.status === 401 && isBotTokenAuthFailureMessage(errorMessage);
      const isAgentKeyAuthFailure =
        response.status === 401 && isAgentKeyBoxAuthFailureMessage(errorMessage);
      if (response.status === 401) {
        if (isTokenAuthFailure && !attemptedTokenRecovery) {
          attemptedTokenRecovery = true;
          clearBotTokenState("chat_bridge_token_auth_failure");
          await deps.attemptMint("chat_bridge_token_auth_failure").catch(
            () => undefined,
          );
          continue;
        }
        if (isTokenAuthFailure) {
          chatBridgeRateLimitedUntilMs = Math.max(
            chatBridgeRateLimitedUntilMs,
            Date.now() + chatBridgeTokenAuthRetryMs,
          );
          throw new Error(
            `agent chat bridge token auth failure: ${errorMessage} (retryAfterMs=${chatBridgeTokenAuthRetryMs})`,
          );
        }
        if (isAgentKeyAuthFailure && !attemptedAgentKeyRecovery) {
          attemptedAgentKeyRecovery = true;
          const refreshed = await deps.refreshAgentKeyBoxForAuth(
            "chat_bridge_agent_key_auth_failure",
          ).catch(() => false);
          if (refreshed) {
            continue;
          }
        }
        const ownerAction = isAgentKeyAuthFailure
          ? "Generate a reset link at /settings#agent-key-reset, redeem it once, and update MG_AGENT_KEY_BOX_FILE (or MG_AGENT_KEY_BOX)."
          : null;
        bridgeAuthHaltReason = errorMessage;
        await deps.recordWrite({
            type: "runtime_bridge_unauthorized_halt",
            at: nowIso(),
            endpoint: "/api/agent/chat",
            status: response.status,
            error: errorMessage,
            ...(ownerAction ? { ownerAction } : {}),
          })
          .catch(() => {});
        throw new Error(
          `agent chat bridge unauthorized: ${errorMessage}${ownerAction ? ` ${ownerAction}` : ""}`,
        );
      }
      throw new Error(
        `agent chat bridge request failed: ${errorMessage}${bridgeIssuesSummary ?? ""}`,
      );
    }
  };

  const callAgentUploadChunk = async (payload: unknown): Promise<unknown> => {
    if (bridgeAuthHaltReason) {
      const refreshed = await deps.refreshAgentKeyBoxForAuth(
        "chunk_upload_halt_guard",
      ).catch(() => false);
      if (refreshed) {
        bridgeAuthHaltReason = null;
      }
    }
    if (bridgeAuthHaltReason) {
      throw new Error(
        `agent chunk upload disabled after unauthorized response: ${bridgeAuthHaltReason}`,
      );
    }
    const nowMs = Date.now();
    if (chunkUploadRateLimitedUntilMs > nowMs) {
      throw new Error(
        `agent chunk upload request rate-limited (${chunkUploadRateLimitedUntilMs - nowMs}ms remaining)`,
      );
    }
    let attemptedTokenRecovery = false;
    let attemptedAgentKeyRecovery = false;
    while (true) {
      const botToken = await deps.getBotToken();
      const activeAgentKeyBox = deps.getAgentKeyBox();
      const response = await fetch(`${deps.chatApiBaseUrl}/api/agent/upload/chunk`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(activeAgentKeyBox
            ? { "x-agent-key-box": activeAgentKeyBox }
            : { "x-agent-key": deps.agentKey ?? "" }),
          ...(botToken ? { "x-bot-session-token": botToken } : {}),
          ...(deps.supervisorConnectionId
            ? { "x-realtime-connection-id": deps.supervisorConnectionId }
            : {}),
        },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (response.ok) {
        chunkUploadRateLimitedUntilMs = 0;
        return body;
      }
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfterMs({
          response,
          body,
          fallbackMs: chatBridgeRateLimitRetryFallbackMs,
        });
        chunkUploadRateLimitedUntilMs = Math.max(
          chunkUploadRateLimitedUntilMs,
          Date.now() + retryAfterMs,
        );
        const errorMessage =
          isRecord(body) && typeof body.error === "string"
            ? body.error
            : "Too many requests";
        throw new Error(
          `agent chunk upload request rate-limited: ${errorMessage} (retryAfterMs=${retryAfterMs})`,
        );
      }
      const errorMessage =
        isRecord(body) && typeof body.error === "string"
          ? body.error
          : `HTTP ${response.status}`;
      const isTokenAuthFailure =
        response.status === 401 && isBotTokenAuthFailureMessage(errorMessage);
      const isAgentKeyAuthFailure =
        response.status === 401 && isAgentKeyBoxAuthFailureMessage(errorMessage);
      if (response.status === 401) {
        if (isTokenAuthFailure && !attemptedTokenRecovery) {
          attemptedTokenRecovery = true;
          clearBotTokenState("chunk_upload_token_auth_failure");
          await deps.attemptMint("chunk_upload_token_auth_failure").catch(
            () => undefined,
          );
          continue;
        }
        if (isTokenAuthFailure) {
          chunkUploadRateLimitedUntilMs = Math.max(
            chunkUploadRateLimitedUntilMs,
            Date.now() + chatBridgeTokenAuthRetryMs,
          );
          throw new Error(
            `agent chunk upload token auth failure: ${errorMessage} (retryAfterMs=${chatBridgeTokenAuthRetryMs})`,
          );
        }
        if (isAgentKeyAuthFailure && !attemptedAgentKeyRecovery) {
          attemptedAgentKeyRecovery = true;
          const refreshed = await deps.refreshAgentKeyBoxForAuth(
            "chunk_upload_agent_key_auth_failure",
          ).catch(() => false);
          if (refreshed) {
            continue;
          }
        }
        const ownerAction = isAgentKeyAuthFailure
          ? "Generate a reset link at /settings#agent-key-reset, redeem it once, and update MG_AGENT_KEY_BOX_FILE (or MG_AGENT_KEY_BOX)."
          : null;
        bridgeAuthHaltReason = errorMessage;
        await deps.recordWrite({
            type: "runtime_bridge_unauthorized_halt",
            at: nowIso(),
            endpoint: "/api/agent/upload/chunk",
            status: response.status,
            error: errorMessage,
            ...(ownerAction ? { ownerAction } : {}),
          })
          .catch(() => {});
        throw new Error(
          `agent chunk upload unauthorized: ${errorMessage}${ownerAction ? ` ${ownerAction}` : ""}`,
        );
      }
      throw new Error(`agent chunk upload request failed: ${errorMessage}`);
    }
  };


  return {
    callAgentChatBridge,
    callAgentUploadChunk,
  };
};
