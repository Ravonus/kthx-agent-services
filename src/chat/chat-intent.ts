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
  isCommandLikeChatAutoReply,
  sanitizeChatOpenClawDraftReply,
  parseChatOpenClawReply,
  buildIntentAndReplyPrompt,
  buildIntentAndReplyDrilldownPrompt,
  CHAT_INTENT_VALID,
  buildDirectMessageFallbackReply,
  buildHowAreYouReply,
  buildNaturalPresenceReply,
  buildThanksReply,
  isHowAreYouMessage,
  isNaturalPresenceCheckMessage,
  isThanksMessage,
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
  const replyToMessageIdRaw =
    typeof message.replyToMessageId === "string" ? message.replyToMessageId
    : typeof message.reply_to_message_id === "string" ? message.reply_to_message_id
    : "";
  const replyToMessageId = replyToMessageIdRaw.trim();
  const commandKind = typeof message.commandKind === "string" && message.commandKind.trim().length > 0
    ? message.commandKind.trim() : "none";
  const context = isRecord(value.context) ? value.context : null;
  const conversationIdRaw = typeof context?.conversationId === "string" ? context.conversationId
    : typeof message.conversationId === "string" ? message.conversationId : "";
  const channelIdRaw = typeof context?.channelId === "string" ? context.channelId
    : typeof message.channelId === "string" ? message.channelId : "";
  const conversationId = conversationIdRaw.trim();
  const channelId = channelIdRaw.trim();
  if (!conversationId.length && !channelId.length) return null;
  const author = messageEnvelope && isRecord(messageEnvelope.author) ? messageEnvelope.author : null;
  const metadata =
    (isRecord(message.metadata) ? message.metadata : null) ??
    (isRecord(messageEnvelope?.metadata) ? messageEnvelope.metadata : null);
  const serverIntentHint = isRecord(metadata?.agentIntentHint) ? metadata.agentIntentHint : null;
  const serverIntentCommand =
    typeof serverIntentHint?.command === "string" && serverIntentHint.command.trim().length > 0
      ? serverIntentHint.command.trim().toLowerCase()
      : null;
  const serverIntentActionFamily =
    typeof serverIntentHint?.actionFamily === "string" &&
      serverIntentHint.actionFamily.trim().length > 0
      ? serverIntentHint.actionFamily.trim().toLowerCase()
      : null;
  const serverIntentConfidence =
    typeof serverIntentHint?.confidence === "string" &&
      serverIntentHint.confidence.trim().length > 0
      ? serverIntentHint.confidence.trim().toLowerCase()
      : null;
  const authorMainUserId =
    typeof author?.mainUserId === "string" && author.mainUserId.trim().length > 0
      ? author.mainUserId.trim()
      : null;
  return {
    messageId, body,
    replyToMessageId: replyToMessageId.length > 0 ? replyToMessageId : null,
    topic: typeof value.topic === "string" ? value.topic : null,
    eventType: eventType || "message.created",
    conversationId: conversationId.length > 0 ? conversationId : null,
    channelId: channelId.length > 0 ? channelId : null,
    authorIsAgent: author?.isAgent === true,
    authorMainUserId,
    commandKind,
    authorDisplay: typeof author?.displayCache === "string" ? author.displayCache : "",
    authorHandle: typeof author?.handleCache === "string" ? author.handleCache : "",
    receivedAt: typeof value.at === "string" && value.at.trim().length > 0 ? value.at.trim() : nowIso(),
    serverIntentCommand,
    serverIntentActionFamily,
    serverIntentConfidence,
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

type SystemProbeReason =
  | "system_disclosure_request_blocked"
  | "system_disclosure_reply_blocked";

const LOW_CONFIDENCE_REPLY_PATTERNS: RegExp[] = [
  /\btell me what you want to do\b/iu,
  /\bwhat do you want help with\b/iu,
  /\btalk to me naturally\b/iu,
  /\bi saw your message\b/iu,
  /\bask me anything\b/iu,
  /\bi(?:'| a)m here.*\bwhat do you want\b/iu,
  /\bgreat choice\b/iu,
  /\bart direction\b/iu,
  /\bprepare the exact prompt flow\b/iu,
  /\bfor image\/carousel posts\b/iu,
];

const DEFERRED_FOLLOWUP_PATTERN =
  /\b(let me check|give me a sec|one sec|hold on|i(?:'|’)ll check|checking (?:that|now)|i(?:'|’)ll look into|i(?:'|’)ll dig)\b/iu;

const DEFERRED_REPLY_RESULT_PATTERN =
  /\b(found|looks like|error|failed|status|because|here(?:'|’)s|result|working|healthy|unhealthy|offline|online)\b/iu;

const SYSTEM_DISCLOSURE_REQUEST_PATTERN =
  /\b(runtime|bridge|openclaw|bot token|session token|agent key|directive|queue|mint|challenge|permission(?:s)?(?:\s+state)?|no_grant|health endpoint|port\s*\d{3,5}|api\/agent\/chat|websocket|socket\s+(?:status|server)|system prompt|developer message|internal (?:log|logs|debug)|debug (?:log|logs)|secret(?:s)?|credential(?:s)?)\b/iu;

const SYSTEM_DISCLOSURE_REPLY_PATTERN =
  /\b(runtime|bridge|openclaw|bot token|session token|agent key|directive|queue|mint|challenge|permission(?:s)?(?:\s+state)?|no_grant|port\s*\d{3,5}|api\/agent\/chat|websocket|socket\s+(?:status|server)|health check|subscribed to \d+ topics|system prompt|developer message|internal (?:log|logs|debug)|debug (?:log|logs)|secret(?:s)?|credential(?:s)?|edenai|playwright|chatgpt|subscription modal|no_media_url|invalid json|json parse)\b/iu;

const SYSTEM_DISCLOSURE_IDENTIFIER_PATTERN =
  /\b(userId|ownerId|agentId|directiveId|grantId|connectionId|chatUserId|sessionId)\b/u;

const STRUCTURED_INTERNAL_DUMP_PATTERN =
  /(?:^|[\s`])\{[\s\S]{0,600}"(?:type|directive|grant|token|status|payload|error|connectionId|agentId)"[\s\S]{0,600}\}/u;

const isSystemDisclosureRequest = (value: string): boolean =>
  SYSTEM_DISCLOSURE_REQUEST_PATTERN.test(value.trim().toLowerCase());

const isSystemDisclosureReply = (value: string): boolean => {
  const normalized = value.trim();
  if (!normalized.length) return false;
  if (SYSTEM_DISCLOSURE_REPLY_PATTERN.test(normalized.toLowerCase())) return true;
  if (SYSTEM_DISCLOSURE_IDENTIFIER_PATTERN.test(normalized)) return true;
  return STRUCTURED_INTERNAL_DUMP_PATTERN.test(normalized);
};

const buildSystemBoundaryReply = (
  entry: ChatInboxEntry,
  maxChars: number,
): string =>
  truncateChatReply(
    entry.channelId
      ? "I can't discuss internal runtime or account details in chat. I can still help with posts, replies, and content tasks."
      : "I can't share internal runtime or account details here. I can still help with posts, replies, and content tasks.",
    maxChars,
  );

const isLowConfidenceAutoReply = (
  candidate: IntentClassificationResult,
  userMessage: string,
): boolean => {
  const reply = candidate.reply.trim().toLowerCase();
  if (!reply.length) return true;
  if (LOW_CONFIDENCE_REPLY_PATTERNS.some((pattern) => pattern.test(reply))) {
    return true;
  }
  const user = userMessage.trim().toLowerCase();
  const userLooksActionable =
    /\b(generate|create|make|post|reply|comment|draft|image|video|gif|pdf|file|send|find|look|search|show)\b/iu.test(
      user,
    );
  const replyAsksToRestateRequest =
    /\b(tell me|let me know|share)\b[\s\S]{0,40}\b(what you want|what to do|details|art direction|direction)\b/iu.test(
      reply,
    );
  if (userLooksActionable && replyAsksToRestateRequest) return true;
  if (
    userLooksActionable &&
    DEFERRED_FOLLOWUP_PATTERN.test(reply) &&
    !DEFERRED_REPLY_RESULT_PATTERN.test(reply)
  ) {
    return true;
  }
  if (candidate.intent === "greeting" && user.split(/\s+/u).length >= 6) {
    return true;
  }
  return false;
};

const isLowValueStallReply = (replyText: string): boolean =>
  LOW_CONFIDENCE_REPLY_PATTERNS.some((pattern) =>
    pattern.test(replyText.trim().toLowerCase()),
  );

const parseIntentAndReplyFromPromptResult = (
  result: OpenClawPromptResponse,
): IntentClassificationResult => {
  const parsed = isRecord(result.parsed) ? result.parsed : null;
  const intentRaw =
    parsed && typeof parsed.intent === "string"
      ? parsed.intent.trim().toLowerCase()
      : null;
  let intent = intentRaw && CHAT_INTENT_VALID.has(intentRaw) ? intentRaw : null;
  let draftedReply =
    parsed &&
    typeof parsed.reply === "string" &&
    parsed.reply.trim().length > 0
      ? parsed.reply.trim()
      : parsed && typeof parsed.text === "string" && parsed.text.trim().length > 0
        ? parsed.text.trim()
        : "";
  if (typeof result.payloadText === "string") {
    if (!intent) {
      const match = /"intent"\s*:\s*"(\w+)"/u.exec(result.payloadText);
      if (match?.[1]) {
        const fallback = match[1].toLowerCase();
        if (CHAT_INTENT_VALID.has(fallback)) intent = fallback;
      }
    }
    if (!draftedReply.length) {
      const replyMatch = /"reply"\s*:\s*"([\s\S]*?)"/u.exec(result.payloadText);
      if (replyMatch?.[1]) draftedReply = replyMatch[1].trim();
    }
  }
  if (!draftedReply.length) draftedReply = parseChatOpenClawReply(result);
  return {
    intent,
    reply: sanitizeChatOpenClawDraftReply(draftedReply),
    rawReply: draftedReply,
  };
};

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
    const displaySource = author.displayCache ?? author.handleCache;
    const display = typeof displaySource === "string" && displaySource.trim().length > 0
      ? displaySource
      : "Unknown";
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
  return parseIntentAndReplyFromPromptResult(result);
};

const classifyIntentAndDraftReplyWithDrilldown = async (input: {
  entry: ChatInboxEntry;
  conversationHistory: unknown[];
  runOpenClawPrompt: (opts: { prompt: string; purpose: string }) => Promise<OpenClawPromptResponse | null>;
  drilldownContext: string;
}): Promise<IntentClassificationResult | null> => {
  const messageBody = input.entry.body.trim();
  if (!messageBody.length) return null;
  const historyLines: string[] = [];
  for (const item of input.conversationHistory) {
    if (!isRecord(item)) continue;
    const msg = isRecord(item.message) ? item.message : null;
    const author = isRecord(item.author) ? item.author : null;
    if (!msg || !author) continue;
    const displaySource = author.displayCache ?? author.handleCache;
    const display = typeof displaySource === "string" && displaySource.trim().length > 0
      ? displaySource
      : "Unknown";
    const body = typeof msg.body === "string" ? msg.body.trim() : "";
    if (!body.length) continue;
    historyLines.push(`${display}: ${body}`);
  }
  const authorName =
    input.entry.authorDisplay.length > 0
      ? input.entry.authorDisplay
      : input.entry.authorHandle.length > 0
        ? input.entry.authorHandle
        : "user";
  const contextType = input.entry.conversationId ? "dm" : "channel";
  const prompt = buildIntentAndReplyDrilldownPrompt({
    contextType,
    authorName,
    messageText: messageBody.slice(0, 360),
    conversationHistoryLines: historyLines,
    drilldownContext: input.drilldownContext,
  });
  const result = await input.runOpenClawPrompt({
    prompt,
    purpose: "chat_reply_drilldown",
  });
  if (!result) return null;
  return parseIntentAndReplyFromPromptResult(result);
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
    loadDrilldownContext?: (
      entry: ChatInboxEntry,
      conversationHistory: unknown[],
    ) => Promise<string | null>;
    reportSystemProbe?: (input: {
      entry: ChatInboxEntry;
      reason: SystemProbeReason;
    }) => Promise<void>;
  },
): Promise<string> => {
  const messageBody = entry.body.trim();
  if (!messageBody.length) return "";
  const maxChars = opts.maxChars;
  const directMessageFallbackReply = buildDirectMessageFallbackReply(
    entry,
    maxChars,
  );
  const conversationHistory = await opts.fetchConversationHistory(entry);

  if (isSystemDisclosureRequest(messageBody)) {
    await opts
      .reportSystemProbe?.({
        entry,
        reason: "system_disclosure_request_blocked",
      })
      .catch(() => undefined);
    await opts
      .recordWrite({
        type: "chat_runtime_reply_guarded",
        at: nowIso(),
        reason: "system_disclosure_request_blocked",
        messageId: entry.messageId,
        bodyPreview: toAnswerPreview(messageBody, 160),
      })
      .catch(() => undefined);
    return buildSystemBoundaryReply(entry, maxChars);
  }

  if (isNaturalPresenceCheckMessage(messageBody)) {
    const reply = buildNaturalPresenceReply(entry, maxChars);
    await opts
      .recordWrite({
        type: "chat_runtime_reply_canned",
        at: nowIso(),
        reason: "natural_presence_check",
        messageId: entry.messageId,
        bodyPreview: toAnswerPreview(messageBody, 140),
        replyPreview: toAnswerPreview(reply, 160),
      })
      .catch(() => undefined);
    return reply;
  }

  if (isHowAreYouMessage(messageBody)) {
    const reply = buildHowAreYouReply(entry, maxChars);
    await opts
      .recordWrite({
        type: "chat_runtime_reply_canned",
        at: nowIso(),
        reason: "how_are_you",
        messageId: entry.messageId,
        bodyPreview: toAnswerPreview(messageBody, 140),
        replyPreview: toAnswerPreview(reply, 160),
      })
      .catch(() => undefined);
    return reply;
  }

  if (isThanksMessage(messageBody)) {
    const reply = buildThanksReply(entry, maxChars);
    await opts
      .recordWrite({
        type: "chat_runtime_reply_canned",
        at: nowIso(),
        reason: "thanks",
        messageId: entry.messageId,
        bodyPreview: toAnswerPreview(messageBody, 140),
        replyPreview: toAnswerPreview(reply, 160),
      })
      .catch(() => undefined);
    return reply;
  }

  if (!opts.useOpenClaw) {
    await opts.recordWrite({
      type: "chat_runtime_reply_suppressed",
      at: nowIso(),
      reason: "openclaw_disabled",
      messageId: entry.messageId,
      bodyPreview: toAnswerPreview(messageBody, 140),
    }).catch(() => undefined);
    if (directMessageFallbackReply.length > 0) {
      await opts
        .recordWrite({
          type: "chat_runtime_reply_fallback",
          at: nowIso(),
          reason: "openclaw_disabled_dm_fallback",
          messageId: entry.messageId,
          bodyPreview: toAnswerPreview(messageBody, 140),
          replyPreview: toAnswerPreview(directMessageFallbackReply, 160),
        })
        .catch(() => undefined);
      return directMessageFallbackReply;
    }
    return "";
  }

  // Keep the first pass cheap; drilldown is reserved for weak or empty drafts.
  const decided = await classifyIntentAndDraftReply(
    entry,
    conversationHistory,
    opts.runOpenClawPrompt,
  );
  let replySuppressedForSystemDisclosure = false;
  const normalizeCandidate = (
    candidate: IntentClassificationResult | null,
  ): string | null => {
    if (!candidate) return null;
    let drafted = candidate.reply;
    if (!drafted.length && typeof candidate.rawReply === "string" && candidate.rawReply.trim().length > 0) {
      drafted = sanitizeChatOpenClawDraftReply(candidate.rawReply);
    }
    if (!drafted.length) return null;
    const normalized = truncateChatReply(drafted, maxChars);
    if (!normalized.length) return null;
    if (isSystemDisclosureReply(normalized)) {
      replySuppressedForSystemDisclosure = true;
      return null;
    }
    if (isCommandLikeChatAutoReply(normalized)) {
      const cleaned = sanitizeChatOpenClawDraftReply(normalized);
      if (cleaned.length > 0 && !isCommandLikeChatAutoReply(cleaned)) {
        const refined = truncateChatReply(cleaned, maxChars);
        if (isLowValueStallReply(refined)) return null;
        return refined;
      }
      return null;
    }
    if (isLowValueStallReply(normalized)) return null;
    return normalized;
  };

  const firstPassReply = normalizeCandidate(decided);
  const firstPassNeedsDrilldown = Boolean(
    decided &&
      firstPassReply &&
      (decided.intent === null || isLowConfidenceAutoReply(
        {
          intent: decided.intent,
          rawReply: decided.rawReply,
          reply: firstPassReply,
        },
        messageBody,
      )),
  );
  if (firstPassReply && !firstPassNeedsDrilldown) {
    return firstPassReply;
  }

  const shouldAttemptDrilldown = !firstPassReply || firstPassNeedsDrilldown;
  if (!shouldAttemptDrilldown) return directMessageFallbackReply;

  const drilldownContext = await opts.loadDrilldownContext
    ?.(
      entry,
      conversationHistory,
    )
    .catch(() => null);
  if (drilldownContext && drilldownContext.trim().length > 0) {
    await opts.recordWrite({
      type: "chat_runtime_reply_drilldown_attempted",
      at: nowIso(),
      messageId: entry.messageId,
      bodyPreview: toAnswerPreview(messageBody, 140),
      firstIntent: decided?.intent ?? null,
      firstRawPreview: decided ? toAnswerPreview(decided.rawReply, 160) : null,
      firstPassNeedsDrilldown,
    }).catch(() => undefined);
    const drilldown = await classifyIntentAndDraftReplyWithDrilldown({
      entry,
      conversationHistory,
      runOpenClawPrompt: opts.runOpenClawPrompt,
      drilldownContext,
    });
    const secondPassReply = normalizeCandidate(drilldown);
    if (secondPassReply) {
      return secondPassReply;
    }
  }

  if (replySuppressedForSystemDisclosure) {
    await opts
      .reportSystemProbe?.({
        entry,
        reason: "system_disclosure_reply_blocked",
      })
      .catch(() => undefined);
    await opts
      .recordWrite({
        type: "chat_runtime_reply_guarded",
        at: nowIso(),
        reason: "system_disclosure_reply_blocked",
        messageId: entry.messageId,
        bodyPreview: toAnswerPreview(messageBody, 160),
      })
      .catch(() => undefined);
    return buildSystemBoundaryReply(entry, maxChars);
  }

  if (firstPassReply) {
    await opts.recordWrite({
      type: "chat_runtime_reply_drilldown_fallback",
      at: nowIso(),
      messageId: entry.messageId,
      bodyPreview: toAnswerPreview(messageBody, 140),
      firstIntent: decided?.intent ?? null,
      replyPreview: toAnswerPreview(firstPassReply, 160),
    }).catch(() => undefined);
    return firstPassReply;
  }

  if (directMessageFallbackReply.length > 0) {
    await opts
      .recordWrite({
        type: "chat_runtime_reply_fallback",
        at: nowIso(),
        reason: decided ? "openclaw_unusable_after_drilldown_dm_fallback" : "openclaw_no_result_dm_fallback",
        messageId: entry.messageId,
        intent: decided?.intent ?? null,
        bodyPreview: toAnswerPreview(messageBody, 140),
        replyPreview: toAnswerPreview(directMessageFallbackReply, 160),
      })
      .catch(() => undefined);
    return directMessageFallbackReply;
  }

  await opts.recordWrite({
    type: "chat_runtime_reply_suppressed",
    at: nowIso(),
    reason: decided ? "openclaw_unusable_after_drilldown" : "openclaw_no_result",
    messageId: entry.messageId,
    intent: decided?.intent ?? null,
    bodyPreview: toAnswerPreview(messageBody, 140),
    rawPreview: decided ? toAnswerPreview(decided.rawReply, 160) : null,
  }).catch(() => undefined);
  return "";
};
