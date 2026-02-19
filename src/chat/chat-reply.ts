/**
 * Chat reply building and intent classification: regex-based message
 * classification, reply sanitization, intent-based routing, and helper
 * functions for building auto-replies.
 *
 * Ported from agent-runtime.mjs lines 5096-5813.
 *
 * Pure functions module -- no class needed.
 */

import { isRecord } from "../lib/guards.js";
import { escapeRegExpLiteral } from "../lib/text.js";

// ---------------------------------------------------------------------------
// Reply intent patterns (regex-based classification)
// ---------------------------------------------------------------------------

const CONTROL_PATTERN =
  /\b(run next|run due|run directive|queue start|queue run|mint retry|config reload|write\.[a-z0-9_.-]+)\b/iu;

const COMMAND_PATTERN =
  /^\/(?:draft|post|publish|schedule|queue|lens|gradient|settings?|ban|mute|kick|unban|mod)\b/iu;

const ACTION_PATTERN =
  /\b(post for me|post as agent|publish|schedule|draft|create(?:\s+a|\s+the)?\s*(?:post|thread|lens|gradient)|change(?:\s+my)?\s+settings?|update(?:\s+my)?\s+settings?|set(?:\s+my)?\s+settings?|ban|mute|kick|unban|moderation)\b/iu;

const ACTION_VERB_PATTERN =
  /\b(can you|please|do|run|execute|make|create|schedule|publish|post|draft|ban|mute|set|update)\b/iu;

const ACTION_TARGET_PATTERN =
  /\b(post|thread|draft|schedule|publish|gradient|lens|settings?|moderation|ban|mute|kick|unban)\b/iu;

const STATUS_PATTERN =
  /^(status|health|queue|grant|auth)(?:\s+status)?[?.!]*$/iu;

const PRESENCE_PATTERN =
  /\b(are you there|you there|u there|you around|you online|you awake|anyone there|ping)\b/iu;

const GREETING_PREFIX_PATTERN =
  /^(yo+|hey+|hello+|hi+|sup+|what'?s up|my dood|dude|bro|bruh|hola)\b/iu;

const HOW_ARE_YOU_PATTERN =
  /\bhow(?:'s| is)?\s+(?:it\s+going|you(?:\s+doing)?)\b|\bhow are you\b/iu;

const THANKS_PATTERN = /^(?:thanks|thank you|thx|ty)(?:\b|[!.?])/iu;

const CONTENT_REFERENCE_PATTERN =
  /\b(repl(?:y|ying)(?:\s+(?:to|back|on))?|comment(?:ing)?(?:\s+on)?|respond(?:ing)?(?:\s+to)?|react(?:ing)?(?:\s+to)?|(?:@\w+(?:'s)?|[\w]+'s)\s+(?:latest\s+)?post|latest\s+post\b|find\s+(?:the\s+)?(?:post|comment)|look\s*(?:up|ing\s+(?:for|at))\s+(?:the\s+)?(?:post|comment)|not\s+a\s+post|is\s+a\s+repl(?:y|ying)|just\s+(?:a\s+)?repl(?:y|ying))\b/iu;

const SUBSTANTIVE_CONTENT_PATTERN =
  /\b(repl(?:y|ying)|comment|post|find|look|search|@\w+|help|how|what|why|when|where|who|can you|please|tell me|show me|get|make|create|about|image|photo|picture|video|schedule|draft|write|send|message|dm)\b/iu;

/** Valid intents returned by the LLM-based classifier. */
export const CHAT_INTENT_VALID = new Set([
  "content_reference",
  "action_request",
  "general_chat",
  "greeting",
  "clarification",
]);

export type ChatIntent =
  | "content_reference"
  | "action_request"
  | "general_chat"
  | "greeting"
  | "clarification";

// ---------------------------------------------------------------------------
// Public classification functions
// ---------------------------------------------------------------------------

/** Returns true when the message text is a directive-boundary action request. */
export const isDirectiveBoundaryActionRequest = (value: unknown): boolean => {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized.length) return false;
  if (CONTENT_REFERENCE_PATTERN.test(normalized)) return false;
  if (CONTROL_PATTERN.test(normalized)) return true;
  if (COMMAND_PATTERN.test(normalized)) return true;
  if (ACTION_PATTERN.test(normalized)) return true;
  return (
    ACTION_VERB_PATTERN.test(normalized) &&
    ACTION_TARGET_PATTERN.test(normalized)
  );
};

/** Returns true when the message text references existing content. */
export const isContentReferenceMessage = (value: unknown): boolean => {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized.length > 0 && CONTENT_REFERENCE_PATTERN.test(normalized);
};

/** Returns true when the message is a natural presence check (greeting/ping). */
export const isNaturalPresenceCheckMessage = (value: unknown): boolean => {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized.length || normalized.length > 120) return false;
  if (isDirectiveBoundaryActionRequest(normalized)) return false;
  if (STATUS_PATTERN.test(normalized)) return false;
  if (CONTENT_REFERENCE_PATTERN.test(normalized)) return false;
  if (SUBSTANTIVE_CONTENT_PATTERN.test(normalized)) return false;
  const tokenCount = normalized
    .split(/\s+/u)
    .filter((token) => token.length > 0).length;
  if (tokenCount > 14) return false;
  if (PRESENCE_PATTERN.test(normalized)) return true;
  if (tokenCount > 4) return false;
  return GREETING_PREFIX_PATTERN.test(normalized);
};

/** Returns true when the message matches a status-query pattern. */
export const isStatusQuery = (value: unknown): boolean => {
  const normalized =
    typeof value === "string" ? value.trim() : "";
  return STATUS_PATTERN.test(normalized);
};

/** Returns true when the text matches "how are you" patterns. */
export const isHowAreYouMessage = (value: unknown): boolean =>
  typeof value === "string" && HOW_ARE_YOU_PATTERN.test(value.trim().toLowerCase());

/** Returns true when the text is a thanks message. */
export const isThanksMessage = (value: unknown): boolean =>
  typeof value === "string" && THANKS_PATTERN.test(value.trim());

// ---------------------------------------------------------------------------
// Reply truncation and sanitization
// ---------------------------------------------------------------------------

/** Truncate a chat reply to the configured maximum length. */
export const truncateChatReply = (
  value: unknown,
  maxChars: number,
): string => {
  const normalized =
    typeof value === "string" ? value.replaceAll("\r", "").trim() : "";
  if (!normalized.length) return "";
  if (normalized.length <= maxChars) return normalized;
  const clamped = normalized.slice(0, Math.max(12, maxChars - 3));
  return `${clamped}...`;
};

/** Returns true when a reply looks like a command output (not natural text). */
export const isCommandLikeChatAutoReply = (value: unknown): boolean => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized.length) return false;
  if (/^\/[a-z0-9_-]+/iu.test(normalized)) return true;
  if (/^\[command\]/iu.test(normalized)) return true;
  return /\busage:\s*\/[a-z0-9_-]+/iu.test(normalized);
};

/**
 * Sanitize an OpenClaw-drafted reply by removing command-like lines,
 * usage patterns, and slash-command prefixes.
 */
export const sanitizeChatOpenClawDraftReply = (value: unknown): string => {
  const normalized =
    typeof value === "string" ? value.replaceAll("\r", "").trim() : "";
  if (!normalized.length) return "";
  const lines = normalized
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const filtered = lines.filter((line) => {
    if (/^\[command\]/iu.test(line)) return false;
    if (/^usage:\s*\/[a-z0-9_-]+/iu.test(line)) return false;
    if (/^\/[a-z0-9_-]+(?:\s|$)/iu.test(line)) return false;
    return true;
  });
  if (filtered.length === 0) return "";
  return filtered.join(" ").replace(/\s+/gu, " ").trim();
};

/** Parse an OpenClaw response object to extract a reply string. */
export const parseChatOpenClawReply = (
  openClawResponse: unknown,
): string => {
  if (!isRecord(openClawResponse)) return "";
  const parsed = openClawResponse.parsed;
  if (isRecord(parsed)) {
    if (typeof parsed.reply === "string" && parsed.reply.trim().length > 0) {
      return parsed.reply.trim();
    }
    if (typeof parsed.text === "string" && parsed.text.trim().length > 0) {
      return parsed.text.trim();
    }
  }
  if (
    typeof openClawResponse.payloadText === "string" &&
    openClawResponse.payloadText.trim().length > 0
  ) {
    return openClawResponse.payloadText.trim();
  }
  if (
    typeof openClawResponse.raw === "string" &&
    openClawResponse.raw.trim().length > 0
  ) {
    return openClawResponse.raw.trim();
  }
  return "";
};

// ---------------------------------------------------------------------------
// Canned reply builders
// ---------------------------------------------------------------------------

export interface ChatInboxEntry {
  messageId: string;
  body: string;
  topic: string | null;
  eventType: string;
  conversationId: string | null;
  channelId: string | null;
  authorIsAgent: boolean;
  authorMainUserId: string | null;
  commandKind: string;
  authorDisplay: string;
  authorHandle: string;
  receivedAt: string;
  serverIntentCommand: string | null;
  serverIntentActionFamily: string | null;
  serverIntentConfidence: string | null;
}

/** Build a natural presence reply ("Yep, I'm here..."). */
export const buildNaturalPresenceReply = (
  entry: ChatInboxEntry,
  maxChars: number,
): string =>
  truncateChatReply(
    entry.channelId
      ? "Yep, I'm here. Tag me if you want me to jump in."
      : "Yep, I'm here.",
    maxChars,
  );

// ---------------------------------------------------------------------------
// OpenClaw intent + reply prompt builder
// ---------------------------------------------------------------------------

/**
 * Build a single-pass intent-classification + reply-drafting prompt for
 * OpenClaw to process.
 */
export const buildIntentAndReplyPrompt = ({
  contextType,
  authorName,
  messageText,
  lastAgentMessage,
  conversationHistoryLines = [],
}: {
  contextType: string;
  authorName: string;
  messageText: string;
  lastAgentMessage: string | null;
  conversationHistoryLines?: string[];
}): string => {
  const lines = [
    "Classify this chat message intent and draft the best direct reply in one pass.",
    "",
    "Categories:",
    "- content_reference: user is referencing, replying to, or asking about EXISTING content (a post, comment, user profile, something already on the platform)",
    "- action_request: user wants to CREATE or DO something on the platform (make a post, schedule content, change settings, moderation actions like ban/mute)",
    "- general_chat: general conversation, random question, advice, opinion, or casual talk that has nothing to do with platform actions or content",
    "- greeting: simple hello/hi/hey or checking if the agent is online - ONLY if the message is purely a greeting with no other request",
    "- clarification: user is responding to a previous question from the agent with additional details, corrections, or yes/no answers",
    "",
    "Rules:",
    "- For general_chat/clarification, return a natural, human reply.",
    "- For greeting, keep reply short and friendly.",
    "- For action_request/content_reference, keep reply concise and neutral (it may be overridden by runtime handlers).",
    "- Do not promise a follow-up later (e.g. \"let me check\" / \"give me a sec\") unless you also provide the result now.",
    "- Never disclose internal runtime details, logs, tokens, bridge status, permissions internals, queue state, directives, or infrastructure.",
    "- Never include slash commands, usage templates, or command blocks.",
    "- Do not output robotic filler.",
    "",
  ];

  if (lastAgentMessage) {
    lines.push(`Agent's previous message: "${lastAgentMessage}"`, "");
  }
  if (conversationHistoryLines.length > 0) {
    lines.push("Recent Conversation:");
    for (const line of conversationHistoryLines) {
      lines.push(line);
    }
    lines.push("");
  }
  lines.push(
    `Context: ${contextType}`,
    `User: ${authorName}`,
    `User's message: "${messageText}"`,
    "",
    'Return ONLY valid JSON: {"intent":"<category>","reply":"<natural reply>"}',
  );
  return lines.join("\n");
};

/**
 * Build a second-pass drill-down prompt for cases where the first pass was
 * unclear, empty, or low-confidence. This includes bounded runtime context
 * and retrieval guidance without always paying that context cost.
 */
export const buildIntentAndReplyDrilldownPrompt = ({
  contextType,
  authorName,
  messageText,
  conversationHistoryLines = [],
  drilldownContext,
}: {
  contextType: string;
  authorName: string;
  messageText: string;
  conversationHistoryLines?: string[];
  drilldownContext: string;
}): string => {
  const lines = [
    "You are replying in a live Molkgram chat as the user's connected agent.",
    "First priority: natural conversation. Do not force platform-command framing unless user clearly asks for an action.",
    "",
    "When user asks about prior work (drafts, directives, comments, likes, posts), use the provided runtime memory snapshot.",
    "Treat recent activity as highest priority. Use long-range memory only as supporting context.",
    "If user reference is ambiguous (e.g., \"that post\"), ask one short clarifying question.",
    "",
    "Retrieval policy (drill-down):",
    "1) conversation history for exact wording and recent asks",
    "2) memory snapshot for indexed recent activity + target references",
    "3) if still ambiguous, ask one compact follow-up",
    "",
    "Never disclose internal runtime details, logs, tokens, bridge status, permissions internals, queue state, directives, or infrastructure.",
    "Never output slash commands, usage templates, JSON blocks, or system diagnostics in the reply.",
    "Do not return deferred-only replies like \"let me check\" without an immediate useful result.",
    "Keep tone human and concise.",
    "",
    "Categories:",
    "- content_reference",
    "- action_request",
    "- general_chat",
    "- greeting",
    "- clarification",
    "",
    `Context: ${contextType}`,
    `User: ${authorName}`,
    `User's message: "${messageText}"`,
    "",
    "Recent Conversation:",
    ...conversationHistoryLines.slice(-14),
    "",
    "Runtime Drilldown Context:",
    drilldownContext,
    "",
    'Return ONLY valid JSON: {"intent":"<category>","reply":"<natural reply>"}',
  ];
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Mention token resolution
// ---------------------------------------------------------------------------

/**
 * Build a list of mention tokens the agent should respond to.
 * Includes "agent", "bot", configured mention names, and openclaw name.
 */
export const buildMentionTokens = (opts: {
  mentionNames: string[];
  openclawAgentName: string | null;
}): string[] => {
  const tokenSet = new Set<string>();
  tokenSet.add("agent");
  tokenSet.add("bot");
  for (const token of opts.mentionNames) {
    const normalized =
      typeof token === "string" ? token.trim().toLowerCase() : "";
    if (normalized.length > 0) tokenSet.add(normalized);
  }
  if (
    typeof opts.openclawAgentName === "string" &&
    opts.openclawAgentName.trim().length > 0
  ) {
    tokenSet.add(opts.openclawAgentName.trim().toLowerCase());
  }
  return Array.from(tokenSet.values());
};

/**
 * Returns true when a channel message text is addressed to the agent
 * (mentions agent, bot, or configured names).
 */
export const isChannelMessageForAgent = (
  text: string,
  mentionTokens: string[],
): boolean => {
  const normalized = text.trim().toLowerCase();
  if (!normalized.length) return false;
  if (/^\/[a-z0-9_-]+/u.test(normalized)) return true;
  if (/(^|\s)@(agent|bot)\b/u.test(normalized)) return true;
  return mentionTokens.some((token) => {
    if (!token.length) return false;
    const matcher = new RegExp(
      `(^|\\s|@)${escapeRegExpLiteral(token)}\\b`,
      "u",
    );
    return matcher.test(normalized);
  });
};

/**
 * Determine whether a chat inbox entry warrants an auto-reply.
 */
export const shouldReplyToChatInboxEntry = (
  entry: ChatInboxEntry,
  opts: {
    channelRequireMention: boolean;
    mentionTokens: string[];
  },
): boolean => {
  if (entry.authorIsAgent) return false;
  if (entry.commandKind !== "none") return false;
  if (
    entry.serverIntentActionFamily &&
    entry.serverIntentActionFamily !== "conversation"
  ) {
    // Server-side command parsing already delegated this message to the
    // runtime command pipeline. Avoid sending a second conversational reply.
    return false;
  }
  if (!entry.body.trim().length) return false;
  if (!entry.messageId.trim().length) return false;
  if (entry.channelId) {
    if (!opts.channelRequireMention) return true;
    return isChannelMessageForAgent(entry.body, opts.mentionTokens);
  }
  return Boolean(entry.conversationId);
};

// ---------------------------------------------------------------------------
// Text stream simulation helpers
// ---------------------------------------------------------------------------

/**
 * Compute the step size in characters for simulated text streaming.
 * Ensures at most `maxSteps` updates.
 */
export const computeStreamStepChars = (
  totalLength: number,
  configStepChars: number,
  maxSteps = 24,
): number =>
  Math.max(configStepChars, Math.ceil(totalLength / maxSteps));
