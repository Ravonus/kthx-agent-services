import type { BridgeCallError as BridgeCallErrorType } from "./chat-bridge-runtime-primitives.js";
import {
  BridgeCallError,
  isAgentKeyAuthFailureMessage,
  isBotTokenInvalidMessage,
  isBridgeCallError,
  isMissingBotTokenError,
  parseRetryAfterMs,
  payloadRequiresBotToken,
} from "./chat-bridge-runtime-primitives.js";

export type BridgeCallMutableState = {
  preferredTokenSource: string | null;
  preferredTokenValue: string | null;
  bridgeRateLimitedUntilMs: number;
  bridgeRateLimitedReason: string | null;
};

export const executeBridgeCall = async (
  deps: {
    baseHttpUrl: string;
    state: BridgeCallMutableState;
    resolveBotTokenCandidates: () => Promise<Array<{ source: string; token: string | null }>>;
    buildHeaders: (botToken: string | null) => Promise<Record<string, string>>;
    disconnectOnAuthDrift: () => ((reason: string) => Promise<void>) | null;
    haltReconnects: () => ((reason: string) => Promise<void>) | null;
    refreshAgentKeyBox: (reason: string) => Promise<boolean>;
    rejectedBotTokenValues: Set<string>;
    rateLimitedRetryFallbackMs: number;
  },
  payload: Record<string, unknown>,
): Promise<unknown> => {
  const nowMs = Date.now();
  if (deps.state.bridgeRateLimitedUntilMs > nowMs) {
    throw new BridgeCallError(
      deps.state.bridgeRateLimitedReason ?? "bridge call is rate limited",
      {
        status: 429,
        retryAfterMs: deps.state.bridgeRateLimitedUntilMs - nowMs,
        tokenSource: deps.state.preferredTokenSource,
      },
    );
  }

  const candidates = await deps.resolveBotTokenCandidates();
  const requiresBotToken = payloadRequiresBotToken(payload);
  if (requiresBotToken && candidates.length === 0) {
    const disconnectOnAuthDrift = deps.disconnectOnAuthDrift();
    if (disconnectOnAuthDrift) {
      await disconnectOnAuthDrift("chat_bridge_missing_bot_token");
    }
    throw new BridgeCallError(
      "Bot token missing. Provide x-bot-session-token. (tokenSource=none)",
      { status: 401, tokenSource: "none" },
    );
  }

  const attempts: Array<{ source: string; token: string | null }> = [...candidates];
  if (!requiresBotToken || attempts.length === 0) {
    attempts.push({ source: "none", token: null });
  }

  let lastError: BridgeCallErrorType | null = null;
  let attemptedAgentKeyRefresh = false;

  for (let index = 0; index < attempts.length; index++) {
    const candidate = attempts[index]!;
    const response = await fetch(`${deps.baseHttpUrl}/api/agent/chat`, {
      method: "POST",
      headers: await deps.buildHeaders(candidate.token),
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (
      response.ok &&
      typeof body === "object" &&
      body !== null &&
      (body as Record<string, unknown>).ok === true
    ) {
      deps.state.preferredTokenSource = candidate.source;
      deps.state.preferredTokenValue = candidate.token;
      deps.state.bridgeRateLimitedUntilMs = 0;
      deps.state.bridgeRateLimitedReason = null;
      return (body as Record<string, unknown>).data;
    }

    const errorMessage =
      typeof body === "object" &&
      body !== null &&
      typeof (body as Record<string, unknown>).error === "string"
        ? ((body as Record<string, unknown>).error as string)
        : `HTTP ${response.status}`;

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs({
        response,
        body,
        fallbackMs: deps.rateLimitedRetryFallbackMs,
      });
      deps.state.bridgeRateLimitedUntilMs = Math.max(
        deps.state.bridgeRateLimitedUntilMs,
        Date.now() + retryAfterMs,
      );
      deps.state.bridgeRateLimitedReason = errorMessage;
      throw new BridgeCallError(`${errorMessage} (tokenSource=${candidate.source})`, {
        status: 429,
        retryAfterMs,
        tokenSource: candidate.source,
      });
    }

    const isMissingToken = isMissingBotTokenError(errorMessage);
    const isTokenMismatch = isBotTokenInvalidMessage(errorMessage);
    if (response.status === 401 && (isMissingToken || isTokenMismatch)) {
      const authDriftReason = isMissingToken
        ? "chat_bridge_missing_bot_token"
        : "chat_bridge_invalid_bot_token";
      const disconnectOnAuthDrift = deps.disconnectOnAuthDrift();
      if (disconnectOnAuthDrift) {
        await disconnectOnAuthDrift(authDriftReason);
      }
    }

    const isTerminalAgentAuthFailure =
      response.status === 401 && !isMissingToken && !isTokenMismatch;
    const isAgentKeyAuthFailure =
      response.status === 401 && isAgentKeyAuthFailureMessage(errorMessage);
    if (isAgentKeyAuthFailure && !attemptedAgentKeyRefresh) {
      attemptedAgentKeyRefresh = true;
      const refreshed = await deps.refreshAgentKeyBox("bridge_agent_key_auth_failure");
      if (refreshed) {
        index -= 1;
        continue;
      }
    }

    if (isTerminalAgentAuthFailure) {
      const ownerAction = isAgentKeyAuthFailure
        ? "Generate a new reset link at /settings#agent-key-reset, redeem it once, and update MG_AGENT_KEY_BOX_FILE (or MG_AGENT_KEY_BOX)."
        : null;
      if (ownerAction) {
        console.warn(`[chat-bridge] ${ownerAction}`);
      }
      const disconnectOnAuthDrift = deps.disconnectOnAuthDrift();
      if (disconnectOnAuthDrift) {
        await disconnectOnAuthDrift("chat_bridge_unauthorized");
      }
      const haltReconnects = deps.haltReconnects();
      if (haltReconnects) {
        await haltReconnects(
          `bridge_unauthorized: ${errorMessage} (tokenSource=${candidate.source})${ownerAction ? ` ${ownerAction}` : ""}`,
        );
      }
      throw new BridgeCallError(`${errorMessage} (tokenSource=${candidate.source})`, {
        status: response.status,
        tokenSource: candidate.source,
      });
    }

    lastError = new BridgeCallError(`${errorMessage} (tokenSource=${candidate.source})`, {
      status: response.status,
      tokenSource: candidate.source,
    });

    if (isTokenMismatch && typeof candidate.token === "string" && candidate.token.trim().length > 0) {
      deps.rejectedBotTokenValues.add(candidate.token);
      if (deps.state.preferredTokenValue === candidate.token) {
        deps.state.preferredTokenValue = null;
        deps.state.preferredTokenSource = null;
      }
    }
    if (response.status === 401 && index < attempts.length - 1) {
      if (isTokenMismatch || isMissingToken) continue;
    }
    if (response.status === 401) {
      throw lastError;
    }
    throw lastError;
  }

  throw lastError ?? new Error("unknown_bridge_error");
};
