/**
 * Chat intent classification, auto-reply building, and inbox entry
 * normalization helpers for the ChatManager.
 *
 * Extracted from chat-manager.ts to keep individual files under 500 lines.
 * Ported from agent-runtime.mjs lines 5815-6267 (intent routing, contextual
 * fallback, inbox normalization).
 *
 * Pure functions + stateless helpers module.
 */

import { isRecord } from "../lib/guards.js";
import { nowIso, toAnswerPreview } from "../lib/text.js";
import type { ChatInboxEntry } from "./chat-reply.js";
import {
  truncateChatReply,
  isStatusQuery,
  isContentReferenceMessage,
  isNaturalPresenceCheckMessage,
  isDirectiveBoundaryActionRequest,
  isHowAreYouMessage,
  isThanksMessage,
  isCommandLikeChatAutoReply,
  sanitizeChatOpenClawDraftReply,
  parseChatOpenClawReply,
  buildNaturalPresenceReply,
  buildNaturalChatFallbackReply,
  buildDirectiveBoundaryReply,
  buildIntentAndReplyPrompt,
  CHAT_INTENT_VALID,
} from "./chat-reply.js";

// ---------------------------------------------------------------------------
// Inbox entry normalization
// ---------------------------------------------------------------------------

export const normalizeInboxEntry = (value: unknown): ChatInboxEntry | null => {
  if (!isRecord(value)) return null;
  const eventType = typeof value.eventType === "string" ? value.eventType.trim() : "";
  if (eventType.length > 0 && eventType !== "message.created") return null;
  const messageEnvelope = isRecord(value.message) ? value.message : null;
  const message = messageEnvelope && isRecord(messageEnvelope.message) ? messageEnvelope.message : null;
  if (!message) return null;
  const messageId = typeof message.id === "string" && message.id.trim().length > 0 ? message.id.trim() : "";
  if (!messageId.length) return null;
  const body = typeof message.body === "string" && message.body.trim().length > 0 ? message.body.trim() : "";
  if (!body.length) return null;
  const commandKind = typeof message.commandKind === "string" && message.commandKind.trim().length > 0
    ? message.commandKind.trim() : "none";
  const context = isRecord(value.context) ? value.context : null;
  const conversationIdRaw = typeof context?.conversationId === "string" ? context.conversationId
    : typeof message.conversationId === "string" ? message.conversationId : "";
  const channelIdRaw = typeof context?.channelId === "string" ? context.channelId
    : typeof message.channelId === "string" ? message.channelId : "";
  const conversationId = (conversationIdRaw as string).trim();
  const channelId = (channelIdRaw as string).trim();
  if (!conversationId.length && !channelId.length) return null;
  const author = messageEnvelope && isRecord(messageEnvelope.author) ? messageEnvelope.author : null;
  return {
    messageId, body,
    topic: typeof value.topic === "string" ? value.topic : null,
    eventType: eventType || "message.created",
    conversationId: conversationId.length > 0 ? conversationId : null,
    channelId: channelId.length > 0 ? channelId : null,
    authorIsAgent: author?.isAgent === true,
    commandKind,
    authorDisplay: typeof author?.displayCache === "string" ? (author.displayCache as string) : "",
    authorHandle: typeof author?.handleCache === "string" ? (author.handleCache as string) : "",
    receivedAt: typeof value.at === "string" && value.at.trim().length > 0 ? value.at.trim() : nowIso(),
  };
};

// ---------------------------------------------------------------------------
// Intent classification result
// ---------------------------------------------------------------------------

export interface IntentClassificationResult {
  intent: string | null;
  reply: string;
  rawReply: string;
}

// ---------------------------------------------------------------------------
// OpenClaw prompt response (narrow type for this module)
// ---------------------------------------------------------------------------

export interface OpenClawPromptResponse {
  parsed: unknown;
  raw: string;
  agentName: string | null;
  payloadText: string | null;
  envelope: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Intent classification via OpenClaw
// ---------------------------------------------------------------------------

export const classifyIntentAndDraftReply = async (
  entry: ChatInboxEntry,
  conversationHistory: unknown[],
  runOpenClawPrompt: (opts: { prompt: string; purpose: string }) => Promise<OpenClawPromptResponse | null>,
): Promise<IntentClassificationResult | null> => {
  const messageBody = entry.body.trim();
  if (!messageBody.length) return null;
  let lastAgentMessage: string | null = null;
  const historyLines: string[] = [];
  for (const item of conversationHistory) {
    if (!isRecord(item)) continue;
    const msg = isRecord(item.message) ? item.message : null;
    const author = isRecord(item.author) ? item.author : null;
    if (!msg || !author) continue;
    const display = (author.displayCache || author.handleCache || "Unknown") as string;
    const body = typeof msg.body === "string" ? msg.body.trim() : "";
    if (!body.length) continue;
    historyLines.push(`${display}: ${body}`);
  }
  if (historyLines.length > 0) {
    for (let i = historyLines.length - 1; i >= 0; i -= 1) {
      const candidate = historyLines[i];
      if (!candidate) continue;
      const lower = candidate.toLowerCase();
      if (lower.startsWith("you:") || lower.startsWith("clawd")) {
        lastAgentMessage = candidate.slice(candidate.indexOf(":") + 1).trim().slice(0, 200);
        break;
      }
    }
  }
  const authorName = entry.authorDisplay.length > 0 ? entry.authorDisplay
    : entry.authorHandle.length > 0 ? entry.authorHandle : "user";
  const contextType = entry.conversationId ? "dm" : "channel";
  const prompt = buildIntentAndReplyPrompt({
    contextType, authorName, messageText: messageBody.slice(0, 300),
    lastAgentMessage, conversationHistoryLines: historyLines.slice(-10),
  });
  const result = await runOpenClawPrompt({ prompt, purpose: "chat_reply" });
  if (!result) return null;
  const parsed = isRecord(result.parsed) ? result.parsed : null;
  const intentRaw = parsed && typeof parsed.intent === "string" ? parsed.intent.trim().toLowerCase() : null;
  let intent = intentRaw && CHAT_INTENT_VALID.has(intentRaw) ? intentRaw : null;
  let draftedReply = parsed && typeof parsed.reply === "string" && parsed.reply.trim().length > 0
    ? parsed.reply.trim()
    : parsed && typeof parsed.text === "string" && parsed.text.trim().length > 0 ? parsed.text.trim() : "";
  if (typeof result.payloadText === "string") {
    if (!intent) {
      const match = result.payloadText.match(/"intent"\s*:\s*"(\w+)"/u);
      if (match?.[1]) { const fallback = match[1].toLowerCase(); if (CHAT_INTENT_VALID.has(fallback)) intent = fallback; }
    }
    if (!draftedReply.length) {
      const replyMatch = result.payloadText.match(/"reply"\s*:\s*"([\s\S]*?)"/u);
      if (replyMatch?.[1]) draftedReply = replyMatch[1].trim();
    }
  }
  if (!draftedReply.length) draftedReply = parseChatOpenClawReply(result);
  return { intent, reply: sanitizeChatOpenClawDraftReply(draftedReply), rawReply: draftedReply };
};

// ---------------------------------------------------------------------------
// Route by classified intent
// ---------------------------------------------------------------------------

export const routeByIntent = (intent: string, entry: ChatInboxEntry, maxChars: number): string | null => {
  if (intent === "greeting") return buildNaturalPresenceReply(entry, maxChars);
  if (intent === "action_request") return buildDirectiveBoundaryReply(maxChars);
  if (intent === "content_reference") {
    return truncateChatReply("I can help with that. Which post or comment are you referring to? Give me an @handle or describe it.", maxChars);
  }
  return null;
};

// ---------------------------------------------------------------------------
// Contextual fallback reply
// ---------------------------------------------------------------------------

export const buildContextualFallback = (
  entry: ChatInboxEntry,
  conversationHistory: unknown[],
  maxChars: number,
): string => {
  const userBody = entry.body.trim().toLowerCase();
  if (isHowAreYouMessage(userBody)) {
    return truncateChatReply(
      entry.channelId ? "Doing well and online. What do you want help with?" : "Doing well and here. What are you working on right now?",
      maxChars,
    );
  }
  if (isThanksMessage(entry.body)) {
    return truncateChatReply(
      entry.channelId ? "Anytime. Tag me when you want me to jump in." : "Anytime. I'm here when you need me.",
      maxChars,
    );
  }
  if (conversationHistory.length > 1) {
    const reversed = [...conversationHistory].reverse();
    const lastAgentMsg = reversed.find((item) => {
      if (!isRecord(item)) return false;
      const author = isRecord(item.author) ? item.author : null;
      return author?.isAgent === true;
    });
    if (lastAgentMsg && isRecord(lastAgentMsg)) {
      const agentBody = isRecord(lastAgentMsg.message) && typeof lastAgentMsg.message.body === "string"
        ? (lastAgentMsg.message.body as string).trim() : "";
      if (agentBody.includes("?")) {
        if (/\b(repl(?:y|ying)|post|comment|gradient|image|photo)\b/iu.test(userBody)) {
          return truncateChatReply("Got it, thanks for clarifying. I'll handle that as you described.", maxChars);
        }
        if (/\b(yes|yeah|yep|yup|sure|ok|okay|correct|right|exactly|no|nah|nope|not)\b/iu.test(userBody)) {
          return truncateChatReply("Understood. I'll take that into account.", maxChars);
        }
        return truncateChatReply("Got it, thanks for the clarification. Let me work on that for you.", maxChars);
      }
      if (agentBody.length > 0) return truncateChatReply("Got it. What would you like me to do next?", maxChars);
    }
  }
  return buildNaturalChatFallbackReply(entry, maxChars);
};

// ---------------------------------------------------------------------------
// Build auto-reply orchestrator
// ---------------------------------------------------------------------------

export const buildAutoReply = async (
  entry: ChatInboxEntry,
  opts: {
    maxChars: number;
    useOpenClaw: boolean;
    recordWrite: (payload: unknown) => Promise<void>;
    runOpenClawPrompt: (opts: { prompt: string; purpose: string }) => Promise<OpenClawPromptResponse | null>;
    fetchConversationHistory: (entry: ChatInboxEntry) => Promise<unknown[]>;
  },
): Promise<string> => {
  const messageBody = entry.body.trim();
  if (!messageBody.length) return "";
  const maxChars = opts.maxChars;

  // Fast-path: status query
  if (isStatusQuery(messageBody)) {
    return truncateChatReply("Runtime status: checking... (status queries are handled by the runtime bridge).", maxChars);
  }
  const isContentRef = isContentReferenceMessage(messageBody);
  const isPresence = !isContentRef && isNaturalPresenceCheckMessage(messageBody);
  const isDirective = !isContentRef && !isPresence && isDirectiveBoundaryActionRequest(messageBody);
  if (isPresence) return buildNaturalPresenceReply(entry, maxChars);
  if (isDirective) return buildDirectiveBoundaryReply(maxChars);
  if (isContentRef) {
    return truncateChatReply("I can help with that. Which post or comment are you referring to? Give me an @handle or describe it.", maxChars);
  }

  const conversationHistory = await opts.fetchConversationHistory(entry);

  if (!opts.useOpenClaw) {
    await opts.recordWrite({ type: "chat_runtime_reply_fallback_used", at: nowIso(), reason: "openclaw_disabled", messageId: entry.messageId, bodyPreview: toAnswerPreview(messageBody, 140) }).catch(() => undefined);
    return buildContextualFallback(entry, conversationHistory, maxChars);
  }

  const decided = await classifyIntentAndDraftReply(entry, conversationHistory, opts.runOpenClawPrompt);
  if (!decided) {
    await opts.recordWrite({ type: "chat_runtime_reply_fallback_used", at: nowIso(), reason: "openclaw_no_result", messageId: entry.messageId, bodyPreview: toAnswerPreview(messageBody, 140) }).catch(() => undefined);
    return buildContextualFallback(entry, conversationHistory, maxChars);
  }
  if (decided.intent) {
    const routed = routeByIntent(decided.intent, entry, maxChars);
    if (routed) return routed;
  }
  let drafted = decided.reply;
  if (!drafted.length && typeof decided.rawReply === "string" && decided.rawReply.trim().length > 0) {
    drafted = sanitizeChatOpenClawDraftReply(decided.rawReply);
  }
  if (!drafted.length) {
    await opts.recordWrite({ type: "chat_runtime_reply_fallback_used", at: nowIso(), reason: "openclaw_empty_reply", messageId: entry.messageId, intent: decided.intent, bodyPreview: toAnswerPreview(messageBody, 140), rawPreview: toAnswerPreview(decided.rawReply, 140) }).catch(() => undefined);
    return buildContextualFallback(entry, conversationHistory, maxChars);
  }
  const normalized = truncateChatReply(drafted, maxChars);
  if (isDirectiveBoundaryActionRequest(normalized)) return buildDirectiveBoundaryReply(maxChars);
  if (isCommandLikeChatAutoReply(normalized)) {
    const cleaned = sanitizeChatOpenClawDraftReply(normalized);
    if (cleaned.length > 0 && !isCommandLikeChatAutoReply(cleaned)) return truncateChatReply(cleaned, maxChars);
    await opts.recordWrite({ type: "chat_runtime_reply_fallback_used", at: nowIso(), reason: "openclaw_command_like_reply", messageId: entry.messageId, intent: decided.intent, bodyPreview: toAnswerPreview(messageBody, 140), rawPreview: toAnswerPreview(drafted, 160) }).catch(() => undefined);
    return buildContextualFallback(entry, conversationHistory, maxChars);
  }
  return normalized;
};
