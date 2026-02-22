/**
 * ChatManager: inbox polling, auto-reply orchestration, and text stream
 * simulation for the agent's chat runtime.
 *
 * Ported from agent-runtime.mjs lines 5815-6267 (send reply, text stream,
 * inbox parsing, poll loop) and portions of 20000+ (entry processing).
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { isRecord } from "../lib/guards.js";
import { nowIso, toAnswerPreview } from "../lib/text.js";
import { readJsonFile, writeJsonFile } from "../lib/fs.js";
import type { ChatManagerLike } from "../runtime-context.js";
import type {
  ContextBundle,
  ContextRequest,
  RetrievalIntent,
} from "../types/memory.js";
import type { ChatInboxEntry } from "./chat-reply.js";
import {
  truncateChatReply,
  shouldReplyToChatInboxEntry,
  buildMentionTokens,
} from "./chat-reply.js";
import { normalizeInboxEntry, buildAutoReply } from "./chat-intent.js";

// ---------------------------------------------------------------------------
// Narrow context interface
// ---------------------------------------------------------------------------

export interface ChatManagerContext {
  config: {
    chatRuntimeEnabled: boolean;
    chatRuntimePollMs: number;
    chatRuntimeReadChunkBytes: number;
    chatRuntimeSeenMessageLimit: number;
    chatRuntimeReplyMaxChars: number;
    chatRuntimeOpenClawInputMaxChars: number;
    chatRuntimeUseOpenClaw: boolean;
    chatRuntimeReplayOnStart: boolean;
    chatRuntimeChannelRequireMention: boolean;
    chatRuntimeMentionNames: string[];
    chatRuntimeTextStreamEnabled: boolean;
    chatRuntimeTextStreamNativeEnabled: boolean;
    chatRuntimeTextStreamNativeOnly: boolean;
    chatRuntimeTextStreamStepChars: number;
    chatRuntimeTextStreamStepMs: number;
    chatRuntimeTextStreamUpdateMinMs: number;
    chatRuntimeStaleReplyMaxAgeMs: number;
    chatRuntimeStaleReplyMaxAgeImportantMs: number;
  };
  ipcPaths: {
    chatInboxPath: string;
    chatRuntimeStatePath: string;
  };
  memory: {
    recordWrite(payload: unknown): Promise<void>;
    buildContext?: (request: ContextRequest) => Promise<ContextBundle>;
  };
  chat: ChatTrackingState;
  callAgentChatBridge: (payload: unknown) => Promise<unknown>;
  runOpenClawPrompt: (opts: {
    prompt: string; purpose: string;
    onTextDelta?: ((delta: string) => void) | null;
  }) => Promise<OpenClawPromptResponse | null>;
  resolveOpenClawAgentName: () => Promise<string | null>;
  runMemoryCheckpoint: (opts: { force: boolean; source: string; allowAgentCompression: boolean }) => Promise<void>;
}

export interface ChatTrackingState {
  chatInboxPollInFlight: boolean;
  chatInboxCursorInitialized: boolean;
  chatInboxReadOffset: number;
  chatInboxPartialLine: string;
  chatRuntimeStateDirty: boolean;
  chatRuntimeStateWriteAtMs: number;
  chatReplyThrottleUntilMs: number;
  chatSeenMessageIds: Set<string>;
  chatSeenMessageIdQueue: string[];
  chatMentionTokensCache: string[];
  chatMentionTokensCachedAtMs: number;
}

interface OpenClawPromptResponse {
  parsed: unknown;
  raw: string;
  agentName: string | null;
  payloadText: string | null;
  envelope: Record<string, unknown> | null;
}

interface StreamState {
  entry: ChatInboxEntry;
  messageId: string | null;
  currentBody: string;
  targetBody: string;
  lastUpdateAtMs: number;
  nativeDeltaChars: number;
}

interface StaleReplyDecision {
  skipReply: boolean;
  ageMs: number | null;
  important: boolean;
  reason: "fresh" | "stale_not_important" | "stale_important_expired" | "stale_important_allowed" | "invalid_timestamp";
}

interface ReplyTargetContext {
  messageId: string;
  authorDisplay: string | null;
  authorHandle: string | null;
  bodyPreview: string | null;
  attachmentSummary: string | null;
  hintPostId: number | null;
  hintCommentId: number | null;
  retrievalQueryFragment: string;
}

interface LinkedOwnerIdentity {
  agentMainUserId: string;
  agentHandle: string | null;
  agentName: string | null;
  ownerMainUserId: string;
  ownerHandle: string;
  ownerName: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const DOC_CONTEXT_RELEVANT_LINE_PATTERN =
  /\b(socket|ws|route|api|action|memory|retriev|directive|chat|dm|channel|post|comment|repost|like|follow|view|gif|image|avatar|banner|retention|profile|draft)\b/iu;

const DOC_CONTEXT_PATH_CANDIDATES = [
  path.resolve(process.cwd(), "public", "chat-system.md"),
  path.resolve(process.cwd(), "public", "AGENT-KTHX-v2.md"),
  path.resolve(process.cwd(), "..", "public", "chat-system.md"),
  path.resolve(process.cwd(), "..", "public", "AGENT-KTHX-v2.md"),
] as const;

const buildSystemDocExcerpt = (sourceName: string, raw: string): string => {
  const lines = raw.split(/\r?\n/u);
  const picked: string[] = [];
  let activeHeading = "";
  let lastHeadingWritten = "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.length || line.startsWith("```")) continue;
    if (/^#{1,6}\s+/u.test(line)) {
      activeHeading = line.replace(/^#{1,6}\s+/u, "").trim();
      continue;
    }
    const isRelevant = DOC_CONTEXT_RELEVANT_LINE_PATTERN.test(line);
    const isStructured =
      /^[-*]\s+/u.test(line) ||
      /^\d+[.)]\s+/u.test(line) ||
      /^(GET|POST|PUT|PATCH|DELETE)\s+/u.test(line) ||
      /^`[^`]+`$/u.test(line);
    if (!isRelevant || (!isStructured && line.length > 140)) continue;
    if (activeHeading.length > 0 && activeHeading !== lastHeadingWritten) {
      picked.push(`section: ${activeHeading}`);
      lastHeadingWritten = activeHeading;
    }
    picked.push(line.replace(/^`|`$/gu, ""));
    if (picked.length >= 42) break;
  }
  if (picked.length === 0) return "";
  return [`source: ${sourceName}`, ...picked].join("\n");
};

const extractSentMessageId = (response: unknown): string | null => {
  if (!isRecord(response)) return null;
  const primary = isRecord(response.primary) ? response.primary : null;
  const message = isRecord(primary?.message) ? primary.message : null;
  if (typeof message?.id === "string" && message.id.trim().length > 0) return message.id.trim();
  if (typeof response.messageId === "string" && response.messageId.trim().length > 0) return response.messageId.trim();
  if (typeof response.id === "string" && response.id.trim().length > 0) return response.id.trim();
  return null;
};

const parsePostAndCommentHints = (text: string): {
  postId?: number;
  commentId?: number;
} => {
  const normalized = text.trim();
  if (!normalized.length) return {};
  const postMatch =
    /\bpost(?:\s+number)?\s*#?\s*(\d+)\b/iu.exec(normalized) ??
    /(?:^|\s)#(\d{1,10})(?:\s|$)/u.exec(normalized);
  const commentMatch =
    /\bcomment(?:\s+number)?\s*#?\s*(\d+)\b/iu.exec(normalized);
  const postIdRaw = postMatch?.[1];
  const commentIdRaw = commentMatch?.[1];
  const postId = postIdRaw ? Number.parseInt(postIdRaw, 10) : NaN;
  const commentId = commentIdRaw ? Number.parseInt(commentIdRaw, 10) : NaN;
  return {
    ...(Number.isFinite(postId) && postId > 0 ? { postId } : {}),
    ...(Number.isFinite(commentId) && commentId > 0 ? { commentId } : {}),
  };
};

const extractHintFromRecordByKeys = (
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null => {
  for (const key of keys) {
    const value = record[key];
    const numeric =
      typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : typeof value === "string"
          ? (() => {
              const parsed = Number.parseInt(value.trim(), 10);
              return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
            })()
          : null;
    if (numeric !== null) return numeric;
  }
  return null;
};

const extractPostAndCommentHintsFromRecord = (
  value: Record<string, unknown>,
): { postId: number | null; commentId: number | null } => {
  const postKeys = [
    "postId",
    "post_id",
    "targetPostId",
    "target_post_id",
  ] as const;
  const commentKeys = [
    "commentId",
    "comment_id",
    "targetCommentId",
    "target_comment_id",
  ] as const;
  const directPostId = extractHintFromRecordByKeys(value, postKeys);
  const directCommentId = extractHintFromRecordByKeys(value, commentKeys);
  if (directPostId !== null || directCommentId !== null) {
    return {
      postId: directPostId,
      commentId: directCommentId,
    };
  }

  for (const nestedKey of ["target", "context", "metadata", "directive", "reply"] as const) {
    const nested = value[nestedKey];
    if (!isRecord(nested)) continue;
    const nestedPostId = extractHintFromRecordByKeys(nested, postKeys);
    const nestedCommentId = extractHintFromRecordByKeys(nested, commentKeys);
    if (nestedPostId !== null || nestedCommentId !== null) {
      return {
        postId: nestedPostId,
        commentId: nestedCommentId,
      };
    }
  }

  return {
    postId: null,
    commentId: null,
  };
};

const summarizeReplyTargetAttachments = (value: unknown): string | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const mimeTypeCounts = new Map<string, number>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const mimeRaw = typeof item.mimeType === "string" ? item.mimeType.trim().toLowerCase() : "";
    if (!mimeRaw.length) continue;
    mimeTypeCounts.set(mimeRaw, (mimeTypeCounts.get(mimeRaw) ?? 0) + 1);
  }
  const total = Array.from(mimeTypeCounts.values()).reduce((sum, count) => sum + count, 0);
  if (total <= 0) return null;
  const topMimes = Array.from(mimeTypeCounts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([mime, count]) => `${mime}:${count}`);
  const noun = total === 1 ? "attachment" : "attachments";
  return `${total} ${noun} (${topMimes.join(", ")})`;
};

const mergePostAndCommentHints = (
  primary: { postId?: number; commentId?: number },
  secondary: { postId?: number; commentId?: number },
): { postId?: number; commentId?: number } => {
  const mergedPostId = primary.postId ?? secondary.postId;
  const mergedCommentId = primary.commentId ?? secondary.commentId;
  return {
    ...(typeof mergedPostId === "number" ? { postId: mergedPostId } : {}),
    ...(typeof mergedCommentId === "number" ? { commentId: mergedCommentId } : {}),
  };
};

const buildReplyTargetSummaryLines = (
  replyTargetContext: ReplyTargetContext | null,
): string[] => {
  if (!replyTargetContext) return [];
  const lines = [
    `- messageId=${replyTargetContext.messageId}`,
  ];
  if (replyTargetContext.authorDisplay || replyTargetContext.authorHandle) {
    lines.push(
      `- author=${replyTargetContext.authorDisplay ?? "unknown"}${
        replyTargetContext.authorHandle ? ` (@${replyTargetContext.authorHandle})` : ""
      }`,
    );
  }
  if (replyTargetContext.bodyPreview) {
    lines.push(`- body=${replyTargetContext.bodyPreview}`);
  }
  if (replyTargetContext.attachmentSummary) {
    lines.push(`- attachments=${replyTargetContext.attachmentSummary}`);
  }
  if (typeof replyTargetContext.hintPostId === "number") {
    lines.push(`- hintedPostId=${replyTargetContext.hintPostId}`);
  }
  if (typeof replyTargetContext.hintCommentId === "number") {
    lines.push(`- hintedCommentId=${replyTargetContext.hintCommentId}`);
  }
  return lines;
};

const VIEW_CONTEXT_PATTERN =
  /\b(view|views|viewed|seen|read|reading|feed|timeline|thread|post|posts|comment|comments|engage|engagement|viral|trending|platform)\b/iu;

const shouldIncludeViewStateContext = ({
  entry,
  conversationHistory,
  hints,
}: {
  entry: ChatInboxEntry;
  conversationHistory: unknown[];
  hints: { postId?: number; commentId?: number };
}): boolean => {
  if (typeof hints.postId === "number" || typeof hints.commentId === "number") {
    return true;
  }
  if (VIEW_CONTEXT_PATTERN.test(entry.body)) return true;

  const historyBody = conversationHistory
    .map((item) => {
      if (!isRecord(item)) return "";
      const message = isRecord(item.message) ? item.message : null;
      return message && typeof message.body === "string" ? message.body.trim() : "";
    })
    .filter((line) => line.length > 0)
    .slice(-6)
    .join(" ");
  return historyBody.length > 0 && VIEW_CONTEXT_PATTERN.test(historyBody);
};

const buildRetrievalQuery = ({
  entry,
  conversationHistory,
  replyTargetContext,
}: {
  entry: ChatInboxEntry;
  conversationHistory: unknown[];
  replyTargetContext: ReplyTargetContext | null;
}): string => {
  const historySnippets = conversationHistory
    .map((item) => {
      if (!isRecord(item)) return "";
      const message = isRecord(item.message) ? item.message : null;
      return message && typeof message.body === "string" ? message.body.trim() : "";
    })
    .filter((line) => line.length > 0)
    .slice(-6)
    .join(" ");
  const combined = [
    entry.body.trim(),
    replyTargetContext?.retrievalQueryFragment ?? "",
    historySnippets,
  ]
    .filter((line) => line.length > 0)
    .join(" ")
    .trim();
  return combined.slice(0, 900);
};

const ENGAGEMENT_RETRIEVAL_PATTERN =
  /\b(like|likes|comment|comments|reply|replies|repost|reposts|quote|follow|follows|engage|engagement|interact|interaction|views?|impressions?|timeline|feed|trending|viral)\b/iu;

const SITE_LOOKUP_TRIGGER_PATTERN =
  /\b(post|posts|comment|comments|likes?|views?|reposts?|engagement|followers?|following|draft|directive|timeline|feed|recent|latest|newest|last|who viewed|who liked|gif|gifs|meme|reaction|emote|emotes|sticker|stickers|emoji|asset|assets|account|accounts|users?|agents?|discover|recommend|suggest|browse|explore|trending)\b/iu;

const LOOKUP_FORCE_PATTERN =
  /\b(not found|never found|can't find|cant find|where (?:is|did)|show me|what happened to|pull it|fetch it)\b/iu;

const LATEST_POST_LOOKUP_PATTERN =
  /\b(most\s+recent|latest|newest|last)\s+post\b/iu;

const COMMENT_LOOKUP_PATTERN = /\bcomments?\b/iu;
const FOLLOW_LOOKUP_PATTERN = /\bfollow(?:er|ers|ing)?\b/iu;
const SUGGESTED_FOLLOW_LOOKUP_PATTERN =
  /\b(suggest|recommended?|recommend|discover|find)\b[\s\S]*\b(follow|accounts?|people|users?|agents?|creators?|vibe)\b|\bwho\s+should\s+(?:i|we|you)\s+follow\b/iu;
const BROWSE_POST_LOOKUP_PATTERN =
  /\b(browse|explore|discover|trending|doom\s*scroll|look\s+around)\b[\s\S]*\b(feed|posts?|timeline|platform|around)\b|\bwhat(?:'s| is)\s+trending\b/iu;
const BROWSE_COMMENT_LOOKUP_PATTERN =
  /\b(browse|explore|discover|read|scan|find|show|look\s+at)\b[\s\S]*\b(comments?|replies?|threads?)\b|\bwhat\s+are\s+people\s+saying\b/iu;
const BROWSE_AGENT_LOOKUP_PATTERN =
  /\b(browse|explore|discover|find|show)\b[\s\S]*\b(agents?|bots?|creators?)\b|\bagents?\s+(?:to\s+follow|you(?:'d| would)?\s+vibe)\b/iu;
const GIF_LOOKUP_PATTERN = /\b(gif|gifs|meme|reaction)\b/iu;
const CUSTOM_ASSET_LOOKUP_PATTERN =
  /\b(emote|emotes|sticker|stickers|gif|gifs|reaction|reactions|emoji|asset|assets)\b/iu;
const BROWSE_NOTIFICATIONS_LOOKUP_PATTERN =
  /\b(notification|notifications|mention|mentions|unread|inbox|alerts?)\b/iu;
const BROWSE_HOME_FEED_LOOKUP_PATTERN =
  /\b(home\s+feed|my\s+feed|following\s+feed|for\s+you\s+feed|home\s+timeline)\b/iu;
const BROWSE_TRENDING_LOOKUP_PATTERN =
  /\b(trending|explore|discover|what(?:'s| is)\s+hot|what(?:'s| is)\s+popular)\b/iu;
const BROWSE_POST_ACTIVITY_LOOKUP_PATTERN =
  /\bpost\b[\s\S]{0,80}\b(activity|engagement|likes?|reposts?|comments?|views?)\b|\bwho\s+(?:liked|reposted|commented|viewed)\b/iu;
const BROWSE_COMMENT_ACTIVITY_LOOKUP_PATTERN =
  /\bcomment\b[\s\S]{0,80}\b(activity|engagement|replies?|likes?|views?)\b|\bwho\s+(?:replied|viewed)\b[\s\S]{0,40}\bcomment\b/iu;
const BROWSE_TOP_ENGAGERS_LOOKUP_PATTERN =
  /\b(top|biggest|best|most)\b[\s\S]{0,40}\b(engagers?|engagement|supporters|fans)\b/iu;
const BROWSE_UNANSWERED_MENTIONS_LOOKUP_PATTERN =
  /\b(unanswered|unreplied|pending)\b[\s\S]{0,40}\b(mentions?|tags?)\b|\bmentions?\s+i\s+(?:haven't|have not)\s+answered\b/iu;
const BROWSE_DRAFTS_LOOKUP_PATTERN = /\b(draft|drafts|wip|unfinished)\b/iu;
const BROWSE_DIRECTIVE_QUEUE_LOOKUP_PATTERN =
  /\b(directive|queue|queued|pending\s+actions?|scheduled\s+actions?)\b/iu;
const BROWSE_SERVERS_LOOKUP_PATTERN =
  /\b(server|servers|guild|guilds|community|communities)\b/iu;
const BROWSE_CHANNELS_LOOKUP_PATTERN = /\b(channel|channels|room|rooms)\b/iu;
const BROWSE_MEMBERS_LOOKUP_PATTERN =
  /\b(member|members|participants?|people|users?)\b[\s\S]{0,40}\b(chat|dm|group|server|channel|conversation|here)\b|\bwho(?:'s| is)\s+here\b/iu;
const BROWSE_LENSES_LOOKUP_PATTERN =
  /\b(lens|lenses|filter|filters)\b/iu;
const BROWSE_ASSETS_LOOKUP_PATTERN =
  /\b(asset|assets|library|vault|media\s+library)\b/iu;
const SEARCH_GLOBAL_LOOKUP_PATTERN =
  /\b(search|lookup|find)\b[\s\S]{0,40}\b(platform|global|site|everywhere)\b/iu;
const RESOLVE_REFERENCE_LOOKUP_PATTERN =
  /\b(resolve|reference|lookup|check|open)\b[\s\S]{0,40}\b(post|comment|message|thread)\b|(?:\bpost(?:\s+number)?\s*#?\s*\d+\b)|(?:\bcomment(?:\s+number)?\s*#?\s*\d+\b)|(?:\/(?:post|comment)\/\d+\b)|(?:^|\s)#\d+\b/iu;
const BROWSE_RECENT_ACTIONS_LOOKUP_PATTERN =
  /\b(recent|last)\b[\s\S]{0,40}\b(actions?|events?|audits?|logs?)\b/iu;

const toFinitePositiveInt = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
};

const parseHandleMentions = (value: string): string[] => {
  const handles = Array.from(value.matchAll(/@([a-z0-9_.-]+)/giu))
    .map((match) => (match[1] ?? "").trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return [...new Set(handles)];
};

const extractGifSearchQuery = (value: string): string | null => {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized.length) return null;
  const slashMatch = /^\/(?:gif|gifs)\s+(.+)$/iu.exec(normalized);
  if (slashMatch?.[1]) {
    return toAnswerPreview(slashMatch[1], 120);
  }
  const afterGifMatch =
    /\b(?:gif|gifs|meme|reaction)\b(?:\s+(?:of|for|about))?\s+(.+)/iu.exec(normalized);
  if (afterGifMatch?.[1]) {
    return toAnswerPreview(afterGifMatch[1], 120);
  }
  const softened = normalized.replace(
    /\b(?:show|find|search|look|lookup|pull|fetch|get|give|send|share|checkout|check out)\b/giu,
    " ",
  );
  const compact = softened.replace(/\s+/gu, " ").trim();
  if (!compact.length) return null;
  if (/^(?:gif|gifs|meme|reaction)$/iu.test(compact)) return null;
  return toAnswerPreview(compact, 120);
};

const extractCustomAssetSearchQuery = (value: string): string | null => {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized.length) return null;
  const directMatch =
    /\b(?:emote|sticker|gif|reaction|emoji|asset)s?\b(?:\s+(?:named|called|for|of|about|with))?\s+(.+)/iu.exec(
      normalized,
    );
  if (directMatch?.[1]) {
    return toAnswerPreview(directMatch[1], 140);
  }
  const softened = normalized.replace(
    /\b(?:show|find|search|lookup|look|pull|fetch|get|give|send|share|use|drop|react|with|my)\b/giu,
    " ",
  );
  const compact = softened
    .replace(/\b(?:emote|emotes|sticker|stickers|gif|gifs|reaction|reactions|emoji|asset|assets)\b/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!compact.length) return null;
  return toAnswerPreview(compact, 140);
};

const extractLookupQueryTerm = (value: string): string | null => {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized.length) return null;
  const cleaned = normalized
    .replace(
      /\b(?:show|find|search|lookup|look|pull|fetch|get|give|send|share|browse|explore|discover|check|checkout|who|what|where|when|why|how|please|can you|could you|would you|for me|for us)\b/giu,
      " ",
    )
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned.length) return null;
  return toAnswerPreview(cleaned, 140);
};

const parseLookupWindowHours = (value: string): number | null => {
  const normalized = value.toLowerCase();
  const parseBy = (pattern: RegExp, multiplier: number): number | null => {
    const match = pattern.exec(normalized);
    if (!match?.[1]) return null;
    const raw = Number.parseFloat(match[1]);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return clampInt(Math.round(raw * multiplier), 1, 24 * 30);
  };
  const hours =
    parseBy(/\b(?:last|past)\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/iu, 1) ??
    parseBy(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/iu, 1);
  if (hours !== null) return hours;
  const days =
    parseBy(/\b(?:last|past)\s+(\d+(?:\.\d+)?)\s*(?:days?|d)\b/iu, 24) ??
    parseBy(/\b(\d+(?:\.\d+)?)\s*(?:days?|d)\b/iu, 24);
  if (days !== null) return days;
  const weeks =
    parseBy(/\b(?:last|past)\s+(\d+(?:\.\d+)?)\s*(?:weeks?|w)\b/iu, 24 * 7) ??
    parseBy(/\b(\d+(?:\.\d+)?)\s*(?:weeks?|w)\b/iu, 24 * 7);
  if (weeks !== null) return weeks;
  if (/\b(today|last\s+24\s*hours?|past\s+24\s*hours?)\b/iu.test(normalized)) {
    return 24;
  }
  if (/\b(this\s+week|last\s+week)\b/iu.test(normalized)) return 24 * 7;
  if (/\b(this\s+month|last\s+month)\b/iu.test(normalized)) return 24 * 30;
  return null;
};

const parseRetrievalHitCount = (bundle: ContextBundle): number => {
  if (
    !isRecord(bundle.retrieval) ||
    !Array.isArray(bundle.retrieval.lines) ||
    bundle.retrieval.lines.length === 0
  ) {
    return 0;
  }
  for (const line of bundle.retrieval.lines) {
    if (typeof line !== "string") continue;
    const match = /\bhits=(\d+)\b/iu.exec(line);
    if (!match?.[1]) continue;
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
};

const pickPostRecordFromLookup = (
  value: unknown,
): Record<string, unknown> | null => {
  if (!isRecord(value)) return null;
  if (isRecord(value.post)) return value.post;
  if (Array.isArray(value.items)) {
    const first = value.items.find((entry) => isRecord(entry));
    if (isRecord(first)) return first;
  }
  return value;
};

const pickPostRecordsFromLookup = (
  value: unknown,
): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is Record<string, unknown> =>
      isRecord(entry),
    );
  }
  if (!isRecord(value)) return [];
  if (Array.isArray(value.items)) {
    return value.items.filter((entry): entry is Record<string, unknown> =>
      isRecord(entry),
    );
  }
  if (isRecord(value.post)) return [value.post];
  return [value];
};

const pickCommentRecordsFromLookup = (
  value: unknown,
): Array<Record<string, unknown>> => {
  if (!isRecord(value)) return [];
  if (isRecord(value.comment)) return [value.comment];
  if (Array.isArray(value.items)) {
    return value.items.filter((entry): entry is Record<string, unknown> =>
      isRecord(entry),
    );
  }
  if (Array.isArray(value.comments)) {
    return value.comments.filter((entry): entry is Record<string, unknown> =>
      isRecord(entry),
    );
  }
  return [value];
};

const summarizePostRecord = (
  value: Record<string, unknown>,
): { line: string; postId: number | null; bodyPreview: string | null } => {
  const postId = toFinitePositiveInt(value.id);
  const author = isRecord(value.author) ? value.author : null;
  const authorHandleRaw =
    (author && typeof author.handle === "string" ? author.handle : "") ||
    (typeof value.authorHandle === "string" ? value.authorHandle : "");
  const authorHandle = authorHandleRaw.trim().replace(/^@+/u, "");
  const createdAt =
    typeof value.createdAt === "string" && value.createdAt.trim().length > 0
      ? value.createdAt.trim()
      : "n/a";
  const textRaw =
    (typeof value.caption === "string" ? value.caption : "") ||
    (typeof value.textBody === "string" ? value.textBody : "") ||
    (typeof value.body === "string" ? value.body : "");
  const bodyPreview = textRaw.trim().length > 0
    ? toAnswerPreview(textRaw, 140)
    : null;
  const likeCount = toFinitePositiveInt(value.likeCount) ?? 0;
  const commentCount = toFinitePositiveInt(value.commentCount) ?? 0;
  const repostCount = toFinitePositiveInt(value.repostCount) ?? 0;
  const viewCount = toFinitePositiveInt(value.viewCount) ?? 0;
  const line = [
    `post:${postId ?? "n/a"}`,
    authorHandle.length > 0 ? `author=@${authorHandle}` : "",
    `likes=${likeCount}`,
    `comments=${commentCount}`,
    `reposts=${repostCount}`,
    `views=${viewCount}`,
    `createdAt=${createdAt}`,
    bodyPreview ? `summary=${bodyPreview}` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
  return { line, postId, bodyPreview };
};

const summarizeCommentRecord = (
  value: Record<string, unknown>,
): {
  line: string;
  postId: number | null;
  commentId: number | null;
  bodyPreview: string | null;
} => {
  const commentId = toFinitePositiveInt(value.id);
  const postId = toFinitePositiveInt(value.postId);
  const author = isRecord(value.author) ? value.author : null;
  const authorHandleRaw =
    (author && typeof author.handle === "string" ? author.handle : "") ||
    (typeof value.authorHandle === "string" ? value.authorHandle : "");
  const authorHandle = authorHandleRaw.trim().replace(/^@+/u, "");
  const createdAt =
    typeof value.createdAt === "string" && value.createdAt.trim().length > 0
      ? value.createdAt.trim()
      : "n/a";
  const bodyRaw =
    (typeof value.body === "string" ? value.body : "") ||
    (typeof value.textBody === "string" ? value.textBody : "");
  const bodyPreview = bodyRaw.trim().length > 0
    ? toAnswerPreview(bodyRaw, 140)
    : null;
  const likeCount = toFinitePositiveInt(value.likeCount) ?? 0;
  const viewCount = toFinitePositiveInt(value.viewCount) ?? 0;
  const replyCount = toFinitePositiveInt(value.replyCount) ?? 0;
  const line = [
    `comment:${commentId ?? "n/a"}`,
    `post:${postId ?? "n/a"}`,
    authorHandle.length > 0 ? `author=@${authorHandle}` : "",
    `likes=${likeCount}`,
    `views=${viewCount}`,
    `replies=${replyCount}`,
    `createdAt=${createdAt}`,
    bodyPreview ? `summary=${bodyPreview}` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
  return { line, postId, commentId, bodyPreview };
};

const pickUserRecordsFromLookup = (
  value: unknown,
): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is Record<string, unknown> =>
      isRecord(entry),
    );
  }
  if (!isRecord(value)) return [];
  if (isRecord(value.user)) return [value.user];
  if (Array.isArray(value.items)) {
    return value.items.filter((entry): entry is Record<string, unknown> =>
      isRecord(entry),
    );
  }
  return [value];
};

const summarizeUserRecord = (
  value: Record<string, unknown>,
): {
  line: string;
  handle: string | null;
  userId: string | null;
  reason: string | null;
} => {
  const userId =
    typeof value.id === "string" && value.id.trim().length > 0
      ? value.id.trim()
      : null;
  const handleRaw =
    typeof value.handle === "string" && value.handle.trim().length > 0
      ? value.handle.trim()
      : "";
  const handle = handleRaw.replace(/^@+/u, "");
  const name =
    typeof value.name === "string" && value.name.trim().length > 0
      ? toAnswerPreview(value.name.trim(), 42)
      : null;
  const reason =
    typeof value.reason === "string" && value.reason.trim().length > 0
      ? toAnswerPreview(value.reason.trim(), 68)
      : null;
  const mutualCount = toFinitePositiveInt(value.mutualCount);
  const score =
    typeof value.score === "number" && Number.isFinite(value.score)
      ? value.score.toFixed(2)
      : null;
  const isAgent = value.isAgent === true;
  const line = [
    `user:@${handle.length > 0 ? handle : "unknown"}`,
    name ? `name=${name}` : "",
    reason ? `reason=${reason}` : "",
    typeof mutualCount === "number" ? `mutuals=${mutualCount}` : "",
    score ? `score=${score}` : "",
    `type=${isAgent ? "agent" : "human"}`,
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
  return {
    line,
    handle: handle.length > 0 ? handle : null,
    userId,
    reason,
  };
};

const pickGifRecordsFromLookup = (
  value: unknown,
): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is Record<string, unknown> => isRecord(entry));
  }
  if (!isRecord(value)) return [];
  if (Array.isArray(value.items)) {
    return value.items.filter((entry): entry is Record<string, unknown> => isRecord(entry));
  }
  return [value];
};

const summarizeGifRecord = (
  value: Record<string, unknown>,
): { line: string; id: string | null; url: string | null; title: string | null } => {
  const id = typeof value.id === "string" && value.id.trim().length > 0 ? value.id.trim() : null;
  const url = typeof value.url === "string" && value.url.trim().length > 0 ? value.url.trim() : null;
  const previewUrl =
    typeof value.previewUrl === "string" && value.previewUrl.trim().length > 0
      ? value.previewUrl.trim()
      : null;
  const titleRaw =
    typeof value.title === "string" && value.title.trim().length > 0
      ? value.title.trim()
      : "";
  const width = toFinitePositiveInt(value.width);
  const height = toFinitePositiveInt(value.height);
  const title = titleRaw.length > 0 ? toAnswerPreview(titleRaw, 60) : null;
  const line = [
    `gif:${id ?? "n/a"}`,
    title ? `title=${title}` : "",
    width && height ? `size=${width}x${height}` : "",
    url ? `url=${url}` : "",
    !url && previewUrl ? `preview=${previewUrl}` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
  return { line, id, url: url ?? previewUrl, title };
};

const pickCustomAssetRecordsFromLookup = (
  value: unknown,
): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is Record<string, unknown> =>
      isRecord(entry),
    );
  }
  if (!isRecord(value)) return [];
  if (Array.isArray(value.items)) {
    return value.items.filter((entry): entry is Record<string, unknown> =>
      isRecord(entry),
    );
  }
  return [value];
};

const summarizeCustomAssetRecord = (value: Record<string, unknown>): {
  line: string;
  kind: string | null;
  name: string | null;
  owner: string | null;
  source: string | null;
  url: string | null;
} => {
  const kindRaw =
    typeof value.kind === "string" && value.kind.trim().length > 0
      ? value.kind.trim().toLowerCase()
      : null;
  const kind =
    kindRaw === "emote" || kindRaw === "sticker" || kindRaw === "gif"
      ? kindRaw
      : null;
  const name =
    typeof value.name === "string" && value.name.trim().length > 0
      ? toAnswerPreview(value.name.trim(), 42)
      : null;
  const ownerRaw =
    typeof value.owner === "string" && value.owner.trim().length > 0
      ? value.owner.trim().toLowerCase()
      : null;
  const owner = ownerRaw === "agent" || ownerRaw === "owner" ? ownerRaw : null;
  const source =
    typeof value.source === "string" && value.source.trim().length > 0
      ? value.source.trim().toLowerCase()
      : null;
  const urlRaw =
    (typeof value.previewUrl === "string" && value.previewUrl.trim().length > 0
      ? value.previewUrl
      : typeof value.url === "string" && value.url.trim().length > 0
        ? value.url
        : null) ?? null;
  const url = urlRaw ? urlRaw.trim() : null;
  const score =
    typeof value.score === "number" && Number.isFinite(value.score)
      ? value.score.toFixed(0)
      : null;
  const line = [
    `${kind ?? "asset"}:${name ?? "unnamed"}`,
    owner ? `owner=${owner}` : "",
    source ? `source=${source}` : "",
    score ? `score=${score}` : "",
    url ? `url=${url}` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
  return { line, kind, name, owner, source, url };
};

const resolveRetrievalIntentForEntry = ({
  entry,
  hints,
  retrievalQuery,
}: {
  entry: ChatInboxEntry;
  hints: { postId?: number; commentId?: number };
  retrievalQuery: string;
}): RetrievalIntent => {
  const actionFamily = (entry.serverIntentActionFamily ?? "").trim().toLowerCase();
  if (entry.commandKind !== "none") return "directive";
  if (actionFamily.length > 0 && actionFamily !== "conversation") {
    if (/(engagement|social|reaction|follow)/iu.test(actionFamily)) {
      return "engagement";
    }
    return "directive";
  }

  const hasTargetHint =
    typeof hints.postId === "number" || typeof hints.commentId === "number";
  if (
    hasTargetHint &&
    ENGAGEMENT_RETRIEVAL_PATTERN.test(
      `${entry.body.trim()} ${retrievalQuery.trim()}`.trim(),
    )
  ) {
    return "engagement";
  }
  if (ENGAGEMENT_RETRIEVAL_PATTERN.test(entry.body)) return "engagement";
  return "chat";
};

const MEMORY_INTERNAL_BULLET_PATTERN =
  /\b(openclaw|bot token|session token|agent key|directive|queue|runtime|bridge|heartbeat|mint|challenge|permission(?:s)?(?:\s+state)?|no_grant|api\/agent\/chat|port\s*\d{3,5}|websocket|socket|postgres|database|sql|migration|column\s+\w+)\b/iu;

const STALE_IMPORTANT_PATTERN =
  /\?|(\b(can you|could you|would you|please|help|urgent|asap|stuck|error|failed|fix|why|where|when|what|how|follow up|follow-up)\b)/iu;

type RetentionDialogStep =
  | "ask_days"
  | "ask_interval"
  | "ask_long_term"
  | "ask_agent_compression"
  | "ask_confirm";

interface RetentionDialogConfig {
  days: number;
  intervalMinutes: number;
  longTermEnabled: boolean;
  longTermUseAgentCompression: boolean;
}

interface RetentionDialogState {
  key: string;
  step: RetentionDialogStep;
  createdAt: string;
  updatedAt: string;
  conversationId: string | null;
  authorMainUserId: string | null;
  pending: Partial<RetentionDialogConfig>;
}

const RETENTION_INTENT_PATTERN =
  /\b(retention|retain|retained|memory\s+policy|memory\s+retention|cleanup\s+interval|archive\s+policy|ttl)\b/iu;
const RETENTION_ACTION_PATTERN =
  /\b(set|change|update|configure|adjust|tune|modify)\b/iu;
const RETENTION_CANCEL_PATTERN =
  /\b(cancel|stop|abort|never\s*mind|nevermind)\b/iu;
const RETENTION_BOOL_TRUE_PATTERN =
  /\b(yes|true|enable|enabled|on|confirm|apply)\b/iu;
const RETENTION_BOOL_FALSE_PATTERN =
  /\b(no|false|disable|disabled|off)\b/iu;
const RETENTION_LONG_TERM_HINT_PATTERN = /\b(long\s*term|archive)\b/iu;
const RETENTION_AGENT_COMPRESSION_HINT_PATTERN =
  /\b(agent\s*compression|llm\s*compression|model\s*compression)\b/iu;

const clampInt = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.floor(value)));

const parseBooleanChatInput = (value: string): boolean | null => {
  const normalized = value.trim().toLowerCase();
  if (!normalized.length) return null;
  const hasTrue = RETENTION_BOOL_TRUE_PATTERN.test(normalized);
  const hasFalse = RETENTION_BOOL_FALSE_PATTERN.test(normalized);
  if (hasTrue && !hasFalse) return true;
  if (hasFalse && !hasTrue) return false;
  if (normalized === "y") return true;
  if (normalized === "n") return false;
  return null;
};

const parseRetentionDaysInput = (value: string): number | null => {
  const normalized = value.trim().toLowerCase();
  if (!normalized.length) return null;
  if (/\b(forever|indefinite|indefinitely|lifetime)\b/iu.test(normalized)) {
    return 3650;
  }
  const parseWithUnit = (
    pattern: RegExp,
    multiplier: number,
  ): number | null => {
    const match = pattern.exec(normalized);
    if (!match?.[1]) return null;
    const raw = Number.parseFloat(match[1]);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return clampInt(Math.round(raw * multiplier), 1, 3650);
  };
  const years = parseWithUnit(/\b(\d+(?:\.\d+)?)\s*(?:years?|yrs?|y)\b/iu, 365);
  if (years !== null) return years;
  const months = parseWithUnit(/\b(\d+(?:\.\d+)?)\s*(?:months?|mos?)\b/iu, 30);
  if (months !== null) return months;
  const weeks = parseWithUnit(/\b(\d+(?:\.\d+)?)\s*(?:weeks?|w)\b/iu, 7);
  if (weeks !== null) return weeks;
  const days = parseWithUnit(/\b(\d+(?:\.\d+)?)\s*(?:days?|d)\b/iu, 1);
  if (days !== null) return days;
  const plain = Number.parseInt(normalized, 10);
  if (Number.isFinite(plain) && plain > 0) return clampInt(plain, 1, 3650);
  return null;
};

const parseRetentionIntervalMinutesInput = (value: string): number | null => {
  const normalized = value.trim().toLowerCase();
  if (!normalized.length) return null;
  if (/\bhourly\b/iu.test(normalized)) return 60;
  if (/\bdaily\b/iu.test(normalized)) return 1440;
  const parseWithUnit = (
    pattern: RegExp,
    multiplier: number,
  ): number | null => {
    const match = pattern.exec(normalized);
    if (!match?.[1]) return null;
    const raw = Number.parseFloat(match[1]);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return clampInt(Math.round(raw * multiplier), 10, 1440);
  };
  const hours =
    parseWithUnit(
      /\bevery\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/iu,
      60,
    ) ??
    parseWithUnit(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/iu, 60);
  if (hours !== null) return hours;
  const days =
    parseWithUnit(/\bevery\s+(\d+(?:\.\d+)?)\s*(?:days?|d)\b/iu, 1440) ??
    parseWithUnit(/\b(\d+(?:\.\d+)?)\s*(?:days?|d)\b/iu, 1440);
  if (days !== null) return days;
  const minutes =
    parseWithUnit(
      /\bevery\s+(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/iu,
      1,
    ) ??
    parseWithUnit(/\b(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/iu, 1);
  if (minutes !== null) return minutes;
  const plain = Number.parseInt(normalized, 10);
  if (Number.isFinite(plain) && plain > 0) return clampInt(plain, 10, 1440);
  return null;
};

const extractRetentionDialogHints = (
  value: string,
): Partial<RetentionDialogConfig> => {
  const pending: Partial<RetentionDialogConfig> = {};
  const days = parseRetentionDaysInput(value);
  if (days !== null) pending.days = days;
  const intervalMinutes = parseRetentionIntervalMinutesInput(value);
  if (intervalMinutes !== null) pending.intervalMinutes = intervalMinutes;
  if (RETENTION_LONG_TERM_HINT_PATTERN.test(value)) {
    const longTermEnabled = parseBooleanChatInput(value);
    if (longTermEnabled !== null) pending.longTermEnabled = longTermEnabled;
  }
  if (RETENTION_AGENT_COMPRESSION_HINT_PATTERN.test(value)) {
    const useCompression = parseBooleanChatInput(value);
    if (useCompression !== null) {
      pending.longTermUseAgentCompression = useCompression;
    }
  }
  if (pending.longTermEnabled === false) {
    pending.longTermUseAgentCompression = false;
  }
  return pending;
};

const resolveRetentionDialogStep = (
  pending: Partial<RetentionDialogConfig>,
): RetentionDialogStep => {
  if (typeof pending.days !== "number") return "ask_days";
  if (typeof pending.intervalMinutes !== "number") return "ask_interval";
  if (typeof pending.longTermEnabled !== "boolean") return "ask_long_term";
  if (
    pending.longTermEnabled &&
    typeof pending.longTermUseAgentCompression !== "boolean"
  ) {
    return "ask_agent_compression";
  }
  return "ask_confirm";
};

const parseRetentionDialogState = (value: unknown): RetentionDialogState | null => {
  if (!isRecord(value)) return null;
  const key =
    typeof value.key === "string" && value.key.trim().length > 0
      ? value.key.trim()
      : "";
  if (!key.length) return null;
  const stepRaw =
    typeof value.step === "string" && value.step.trim().length > 0
      ? value.step.trim()
      : "";
  const step: RetentionDialogStep | null = [
    "ask_days",
    "ask_interval",
    "ask_long_term",
    "ask_agent_compression",
    "ask_confirm",
  ].includes(stepRaw)
    ? (stepRaw as RetentionDialogStep)
    : null;
  if (!step) return null;
  const pendingRaw = isRecord(value.pending) ? value.pending : {};
  const pending: Partial<RetentionDialogConfig> = {};
  if (
    typeof pendingRaw.days === "number" &&
    Number.isFinite(pendingRaw.days) &&
    pendingRaw.days > 0
  ) {
    pending.days = clampInt(pendingRaw.days, 1, 3650);
  }
  if (
    typeof pendingRaw.intervalMinutes === "number" &&
    Number.isFinite(pendingRaw.intervalMinutes) &&
    pendingRaw.intervalMinutes > 0
  ) {
    pending.intervalMinutes = clampInt(pendingRaw.intervalMinutes, 10, 1440);
  }
  if (typeof pendingRaw.longTermEnabled === "boolean") {
    pending.longTermEnabled = pendingRaw.longTermEnabled;
  }
  if (typeof pendingRaw.longTermUseAgentCompression === "boolean") {
    pending.longTermUseAgentCompression = pendingRaw.longTermUseAgentCompression;
  }
  if (pending.longTermEnabled === false) {
    pending.longTermUseAgentCompression = false;
  }
  return {
    key,
    step,
    createdAt:
      typeof value.createdAt === "string" && value.createdAt.trim().length > 0
        ? value.createdAt.trim()
        : nowIso(),
    updatedAt:
      typeof value.updatedAt === "string" && value.updatedAt.trim().length > 0
        ? value.updatedAt.trim()
        : nowIso(),
    conversationId:
      typeof value.conversationId === "string" &&
      value.conversationId.trim().length > 0
        ? value.conversationId.trim()
        : null,
    authorMainUserId:
      typeof value.authorMainUserId === "string" &&
      value.authorMainUserId.trim().length > 0
        ? value.authorMainUserId.trim()
        : null,
    pending,
  };
};

const isSafeMemoryBullet = (value: string): boolean =>
  !MEMORY_INTERNAL_BULLET_PATTERN.test(value.trim().toLowerCase());

const buildDrilldownMemorySummary = (bundle: ContextBundle): string => {
  const lines: string[] = [];
  lines.push("## Memory Snapshot");
  lines.push(`generatedAt=${bundle.generatedAt}`);
  if (bundle.mood) {
    lines.push(
      `mood=${bundle.mood.primary} score=${Number.parseFloat(String(bundle.mood.score)).toFixed(2)}`,
    );
  }

  if (isRecord(bundle.temporal?.tiers)) {
    lines.push("temporal:");
    for (const tierKey of ["24h", "7d", "30d", "365d"]) {
      const tier = bundle.temporal.tiers[tierKey];
      if (!isRecord(tier)) continue;
      const bullets = Array.isArray(tier.bullets)
        ? tier.bullets
            .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
            .filter((entry) => isSafeMemoryBullet(entry))
            .slice(0, tierKey === "24h" ? 3 : 1)
            .map((entry) => entry.trim())
        : [];
      const eventCount =
        typeof tier.eventCount === "number" && Number.isFinite(tier.eventCount)
          ? tier.eventCount
          : 0;
      lines.push(`- ${tierKey} events=${eventCount}`);
      for (const bullet of bullets) {
        lines.push(`  - ${bullet}`);
      }
    }
  }

  if (
    isRecord(bundle.view) &&
    bundle.view.enabled === true &&
    bundle.view.relevant === true &&
    Array.isArray(bundle.view.lines) &&
    bundle.view.lines.length > 0
  ) {
    lines.push("view:");
    for (const line of bundle.view.lines.slice(0, 12)) {
      if (typeof line !== "string") continue;
      const trimmed = line.trim();
      if (!trimmed.length) continue;
      lines.push(`- ${trimmed}`);
    }
  }

  if (
    isRecord(bundle.retrieval) &&
    bundle.retrieval.enabled === true &&
    Array.isArray(bundle.retrieval.lines) &&
    bundle.retrieval.lines.length > 0
  ) {
    lines.push("retrieval:");
    if (typeof bundle.retrieval.query === "string" && bundle.retrieval.query.trim().length > 0) {
      lines.push(`- query=${bundle.retrieval.query.trim()}`);
    }
    for (const line of bundle.retrieval.lines.slice(0, 10)) {
      if (typeof line !== "string") continue;
      const trimmed = line.trim();
      if (!trimmed.length) continue;
      lines.push(`- ${trimmed}`);
    }
  }

  if (bundle.target.postId || bundle.target.commentId) {
    lines.push("target:");
    lines.push(
      `- postId=${bundle.target.postId ?? "null"} commentId=${bundle.target.commentId ?? "null"} targetEvents=${bundle.target.events.length}`,
    );
    const focusBullets = Array.isArray(bundle.target.focus?.bullets)
      ? bundle.target.focus.bullets
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .filter((entry) => isSafeMemoryBullet(entry))
          .slice(0, 4)
          .map((entry) => entry.trim())
      : [];
    for (const bullet of focusBullets) {
      lines.push(`  - ${bullet}`);
    }
  }

  lines.push("retrievalPolicy=prefer_recent_first_then_targeted_archive_then_single_clarifying_question");
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// ChatManager
// ---------------------------------------------------------------------------

export class ChatManager implements ChatManagerLike {
  private readonly ctx: ChatManagerContext;
  private readonly retentionDialogs = new Map<string, RetentionDialogState>();
  private systemDocContextCached: string | null = null;
  private systemDocContextCachedAtMs = 0;
  private systemDocContextInFlight: Promise<string | null> | null = null;
  private linkedOwnerIdentityCached: LinkedOwnerIdentity | null = null;
  private linkedOwnerIdentityCachedAtMs = 0;
  private linkedOwnerIdentityInFlight: Promise<LinkedOwnerIdentity | null> | null = null;
  constructor(ctx: ChatManagerContext) { this.ctx = ctx; }

  async pollInbox(): Promise<void> {
    if (!this.ctx.config.chatRuntimeEnabled || this.ctx.chat.chatInboxPollInFlight) return;
    this.ctx.chat.chatInboxPollInFlight = true;
    try {
      await this.initializeCursor();
      const lines = await this.readDeltaLines();
      let staleReplySkippedCount = 0;
      for (const line of lines) {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        const entry = normalizeInboxEntry(parsed);
        if (!entry) continue;
        if (this.ctx.chat.chatSeenMessageIds.has(entry.messageId)) continue;
        this.rememberSeenMessageId(entry.messageId);
        await this.ctx.memory.recordWrite({
          type: entry.commandKind !== "none" ? "chat_runtime_command_received" : "chat_runtime_interaction_received",
          at: entry.receivedAt, messageId: entry.messageId, conversationId: entry.conversationId,
          channelId: entry.channelId, commandKind: entry.commandKind, authorHandle: entry.authorHandle,
          bodyPreview: toAnswerPreview(entry.body, 160),
        }).catch(() => undefined);
        const mentionTokens = await this.resolveMentionTokens();
        if (!shouldReplyToChatInboxEntry(entry, { channelRequireMention: this.ctx.config.chatRuntimeChannelRequireMention, mentionTokens })) continue;
        const staleDecision = this.evaluateStaleReplyDecision(entry);
        if (staleDecision.skipReply) {
          staleReplySkippedCount += 1;
          await this.ctx.memory
            .recordWrite({
              type: "chat_runtime_stale_reply_skipped",
              at: nowIso(),
              messageId: entry.messageId,
              conversationId: entry.conversationId,
              channelId: entry.channelId,
              eventType: entry.eventType,
              reason: staleDecision.reason,
              ageMs: staleDecision.ageMs,
              important: staleDecision.important,
              bodyPreview: toAnswerPreview(entry.body, 180),
            })
            .catch(() => undefined);
          continue;
        }
        if (staleDecision.reason === "stale_important_allowed") {
          await this.ctx.memory
            .recordWrite({
              type: "chat_runtime_stale_reply_allowed",
              at: nowIso(),
              messageId: entry.messageId,
              conversationId: entry.conversationId,
              channelId: entry.channelId,
              ageMs: staleDecision.ageMs,
              important: true,
            })
            .catch(() => undefined);
        }
        await this.ctx
          .runMemoryCheckpoint({
            force: true,
            source: "chat_runtime_interaction",
            allowAgentCompression: true,
          })
          .catch(() => undefined);
        let typingSent = false;
        try {
          await this.setTyping(entry, true).catch(() => undefined);
          typingSent = true;
          const retentionReply = await this.handleRetentionPolicyDialog(entry);
          if (retentionReply) {
            await this.sendReply(entry, retentionReply).catch(() => undefined);
            this.ctx.chat.chatReplyThrottleUntilMs = Date.now() + 650;
            await this.ctx.memory
              .recordWrite({
                type: "chat_runtime_retention_dialog_reply",
                at: nowIso(),
                messageId: entry.messageId,
                conversationId: entry.conversationId,
                channelId: entry.channelId,
                replyPreview: toAnswerPreview(retentionReply, 220),
              })
              .catch(() => undefined);
            continue;
          }
          const shouldStream = this.ctx.config.chatRuntimeTextStreamEnabled && this.ctx.config.chatRuntimeUseOpenClaw;
          const streamState = shouldStream ? this.createStreamState(entry) : null;
          const replyBody = await buildAutoReply(entry, {
            maxChars: this.ctx.config.chatRuntimeReplyMaxChars,
            useOpenClaw: this.ctx.config.chatRuntimeUseOpenClaw,
            recordWrite: (p) => this.ctx.memory.recordWrite(p),
            runOpenClawPrompt: (o) => this.ctx.runOpenClawPrompt(o),
            fetchConversationHistory: (e) => this.fetchConversationHistory(e),
            loadDrilldownContext: (e, conversationHistory) =>
              this.loadDrilldownContext(e, conversationHistory),
            reportSystemProbe: ({ entry: flaggedEntry, reason }) =>
              this.reportSystemProbe(flaggedEntry, reason),
          });
          if (!replyBody.length) {
            await this.ctx.memory
              .recordWrite({
                type: "chat_runtime_auto_reply_suppressed",
                at: nowIso(),
                messageId: entry.messageId,
                conversationId: entry.conversationId,
                channelId: entry.channelId,
                reason: "empty_llm_reply",
                bodyPreview: toAnswerPreview(entry.body, 140),
              })
              .catch(() => undefined);
            continue;
          }
          const nowMs = Date.now();
          if (this.ctx.chat.chatReplyThrottleUntilMs > nowMs) await sleep(this.ctx.chat.chatReplyThrottleUntilMs - nowMs);
          if (streamState) {
            // Do not emit partial placeholder edits unless native streaming actually
            // provided deltas. Partial writes can get stuck if finalization fails.
            let finalized = await this.finalizeStream(streamState, replyBody);
            if (!finalized && typeof streamState.messageId === "string" && streamState.messageId.trim().length > 0) {
              const normalized = truncateChatReply(replyBody, this.ctx.config.chatRuntimeReplyMaxChars);
              try { await this.editMessage(streamState.messageId, normalized); streamState.currentBody = normalized; streamState.lastUpdateAtMs = Date.now(); finalized = true; } catch { finalized = streamState.currentBody === normalized; }
            }
            if (!finalized && !streamState.messageId?.trim().length) {
              await this.sendReply(entry, replyBody);
            }
          } else {
            await this.sendReply(entry, replyBody);
          }
          this.ctx.chat.chatReplyThrottleUntilMs = Date.now() + 650;
          await this.ctx.memory.recordWrite({
            type: "chat_runtime_auto_reply_sent", at: nowIso(), messageId: entry.messageId,
            conversationId: entry.conversationId, channelId: entry.channelId, eventType: entry.eventType,
            sourceContext: "CHAT", topic: entry.topic, replyPreview: toAnswerPreview(replyBody, 220),
            replyStreamed: Boolean(streamState), replyStreamNative: Boolean(streamState) && (streamState?.nativeDeltaChars ?? 0) > 0,
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          await this.ctx.memory.recordWrite({
            type: "chat_runtime_auto_reply_failed",
            at: nowIso(),
            message,
            messageId: entry.messageId,
            conversationId: entry.conversationId,
            channelId: entry.channelId,
            bodyPreview: toAnswerPreview(entry.body, 140),
          }).catch(() => undefined);
          const failureReply = truncateChatReply(
            "I hit a snag handling that right now. Please try again in a moment.",
            this.ctx.config.chatRuntimeReplyMaxChars,
          );
          if (failureReply.length > 0) {
            await this.sendReply(entry, failureReply).catch(() => undefined);
            this.ctx.chat.chatReplyThrottleUntilMs = Date.now() + 650;
            await this.ctx.memory.recordWrite({
              type: "chat_runtime_auto_reply_error_sent",
              at: nowIso(),
              messageId: entry.messageId,
              conversationId: entry.conversationId,
              channelId: entry.channelId,
              error: toAnswerPreview(message, 220),
            }).catch(() => undefined);
          }
        } finally {
          if (typingSent) await this.setTyping(entry, false).catch(() => undefined);
        }
      }
      if (staleReplySkippedCount > 0) {
        await this.ctx
          .runMemoryCheckpoint({
            force: false,
            source: "chat_runtime_stale_ingest",
            allowAgentCompression: true,
          })
          .catch(() => undefined);
      }
      await this.persistState("poll");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.ctx.memory.recordWrite({ type: "chat_runtime_auto_reply_failed", at: nowIso(), message });
    } finally {
      this.ctx.chat.chatInboxPollInFlight = false;
    }
  }

  dispose(): void { /* No timers to clear. */ }

  // -----------------------------------------------------------------------
  // Private: cursor initialization
  // -----------------------------------------------------------------------

  private async initializeCursor(): Promise<void> {
    if (this.ctx.chat.chatInboxCursorInitialized) return;
    this.ctx.chat.chatInboxCursorInitialized = true;
    const stateRaw = await readJsonFile(this.ctx.ipcPaths.chatRuntimeStatePath);
    const state = isRecord(stateRaw) ? stateRaw : null;
    const fileStat = await fs.stat(this.ctx.ipcPaths.chatInboxPath).catch(() => null);
    const fileBytes = fileStat && typeof fileStat.size === "number" && Number.isFinite(fileStat.size)
      ? Math.max(0, Math.floor(fileStat.size)) : 0;
    if (this.ctx.config.chatRuntimeReplayOnStart) {
      this.ctx.chat.chatInboxReadOffset = 0;
      this.ctx.chat.chatInboxPartialLine = "";
    } else {
      const savedOffset =
        state && typeof state.readOffset === "number" && Number.isFinite(state.readOffset)
          ? Math.max(0, Math.floor(state.readOffset))
          : null;
      this.ctx.chat.chatInboxReadOffset = savedOffset === null ? fileBytes : Math.min(savedOffset, fileBytes);
      this.ctx.chat.chatInboxPartialLine =
        state && typeof state.partialLine === "string" && state.partialLine.length <= 4096
          ? state.partialLine
          : "";
    }
    if (state && Array.isArray(state.seenMessageIds)) {
      for (const entry of state.seenMessageIds) {
        if (typeof entry === "string" && entry.trim().length > 0) this.rememberSeenMessageId(entry.trim());
      }
    }
    if (state && Array.isArray(state.retentionDialogs)) {
      this.retentionDialogs.clear();
      for (const entry of state.retentionDialogs) {
        const parsed = parseRetentionDialogState(entry);
        if (!parsed) continue;
        this.retentionDialogs.set(parsed.key, parsed);
      }
    }
    this.ctx.chat.chatRuntimeStateDirty = true;
    await this.persistState("init");
    await this.ctx.memory.recordWrite({
      type: "chat_runtime_inbox_initialized", at: nowIso(), enabled: this.ctx.config.chatRuntimeEnabled,
      replayOnStart: this.ctx.config.chatRuntimeReplayOnStart, readOffset: this.ctx.chat.chatInboxReadOffset,
      seenMessageIds: this.ctx.chat.chatSeenMessageIds.size,
    });
  }

  // -----------------------------------------------------------------------
  // Private: JSONL cursor reading
  // -----------------------------------------------------------------------

  private async readDeltaLines(): Promise<string[]> {
    const handle = await fs.open(this.ctx.ipcPaths.chatInboxPath, "r").catch(() => null);
    if (!handle) return [];
    try {
      const stat = await handle.stat().catch(() => null);
      const size = stat && typeof stat.size === "number" && Number.isFinite(stat.size) ? Math.max(0, Math.floor(stat.size)) : 0;
      if (size < this.ctx.chat.chatInboxReadOffset) {
        this.ctx.chat.chatInboxReadOffset = 0; this.ctx.chat.chatInboxPartialLine = ""; this.ctx.chat.chatRuntimeStateDirty = true;
      }
      if (size <= this.ctx.chat.chatInboxReadOffset) return [];
      const remaining = size - this.ctx.chat.chatInboxReadOffset;
      const chunkSize = Math.max(1, Math.min(remaining, this.ctx.config.chatRuntimeReadChunkBytes));
      const buffer = Buffer.allocUnsafe(chunkSize);
      const readResult = await handle.read(buffer, 0, chunkSize, this.ctx.chat.chatInboxReadOffset);
      const bytesRead = typeof readResult.bytesRead === "number" && readResult.bytesRead > 0 ? readResult.bytesRead : 0;
      if (bytesRead <= 0) return [];
      this.ctx.chat.chatInboxReadOffset += bytesRead;
      this.ctx.chat.chatRuntimeStateDirty = true;
      const chunkText = buffer.subarray(0, bytesRead).toString("utf8");
      const merged = `${this.ctx.chat.chatInboxPartialLine}${chunkText}`;
      const lines = merged.split(/\r?\n/u);
      this.ctx.chat.chatInboxPartialLine = lines.pop() ?? "";
      if (this.ctx.chat.chatInboxPartialLine.length > 8192) this.ctx.chat.chatInboxPartialLine = "";
      return lines.map((l) => l.trim()).filter((l) => l.length > 0);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  // -----------------------------------------------------------------------
  // Private: seen message dedup (LRU queue)
  // -----------------------------------------------------------------------

  private rememberSeenMessageId(messageId: string): void {
    if (typeof messageId !== "string" || !messageId.trim().length) return;
    const normalized = messageId.trim();
    if (this.ctx.chat.chatSeenMessageIds.has(normalized)) return;
    this.ctx.chat.chatSeenMessageIds.add(normalized);
    this.ctx.chat.chatSeenMessageIdQueue.push(normalized);
    while (this.ctx.chat.chatSeenMessageIdQueue.length > this.ctx.config.chatRuntimeSeenMessageLimit) {
      const removed = this.ctx.chat.chatSeenMessageIdQueue.shift();
      if (removed) this.ctx.chat.chatSeenMessageIds.delete(removed);
    }
    this.ctx.chat.chatRuntimeStateDirty = true;
  }

  // -----------------------------------------------------------------------
  // Private: stale reply policy
  // -----------------------------------------------------------------------

  private evaluateStaleReplyDecision(entry: ChatInboxEntry): StaleReplyDecision {
    const receivedAtMs = this.parseEntryTimestampMs(entry.receivedAt);
    if (receivedAtMs === null) {
      return {
        skipReply: false,
        ageMs: null,
        important: false,
        reason: "invalid_timestamp",
      };
    }
    const ageMs = Date.now() - receivedAtMs;
    if (ageMs <= this.ctx.config.chatRuntimeStaleReplyMaxAgeMs) {
      return {
        skipReply: false,
        ageMs,
        important: false,
        reason: "fresh",
      };
    }
    const important = this.isImportantMissedMessage(entry);
    if (!important) {
      return {
        skipReply: true,
        ageMs,
        important: false,
        reason: "stale_not_important",
      };
    }
    if (ageMs > this.ctx.config.chatRuntimeStaleReplyMaxAgeImportantMs) {
      return {
        skipReply: true,
        ageMs,
        important: true,
        reason: "stale_important_expired",
      };
    }
    return {
      skipReply: false,
      ageMs,
      important: true,
      reason: "stale_important_allowed",
    };
  }

  private parseEntryTimestampMs(value: string): number | null {
    const raw = value.trim();
    if (!raw.length) return null;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) return null;
    return ms;
  }

  private isImportantMissedMessage(entry: ChatInboxEntry): boolean {
    const body = entry.body.trim();
    if (!body.length) return false;
    const bodyLower = body.toLowerCase();
    if (STALE_IMPORTANT_PATTERN.test(bodyLower)) return true;
    if (entry.channelId && bodyLower.includes("@")) return true;
    if (
      entry.serverIntentActionFamily === "conversation" &&
      typeof entry.serverIntentConfidence === "string" &&
      entry.serverIntentConfidence === "high"
    ) {
      return true;
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Private: send / edit / typing
  // -----------------------------------------------------------------------

  private async sendReply(entry: ChatInboxEntry, body: string): Promise<unknown> {
    const trimmedBody = truncateChatReply(body, this.ctx.config.chatRuntimeReplyMaxChars);
    if (!trimmedBody.length || /^(?:\u2026+|\.{3,})$/u.test(trimmedBody)) return null;
    return this.ctx.callAgentChatBridge({
      action: "send_message",
      clientMessageId: `runtime_chat_${Date.now().toString(36)}_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`,
      body: trimmedBody, format: "markdown", replyToMessageId: entry.messageId,
      ...(entry.conversationId ? { conversationId: entry.conversationId } : { channelId: entry.channelId }),
    });
  }

  private async editMessage(messageId: string, body: string): Promise<unknown> {
    const trimmedBody = truncateChatReply(body, this.ctx.config.chatRuntimeReplyMaxChars);
    if (!trimmedBody.length || /^(?:\u2026+|\.{3,})$/u.test(trimmedBody)) return null;
    return this.ctx.callAgentChatBridge({ action: "edit_message", messageId, body: trimmedBody });
  }

  private async setTyping(entry: ChatInboxEntry, isTyping: boolean): Promise<unknown> {
    return this.ctx.callAgentChatBridge({
      action: "typing", ...(entry.conversationId ? { conversationId: entry.conversationId } : { channelId: entry.channelId }), isTyping,
    });
  }

  // -----------------------------------------------------------------------
  // Private: text stream simulation
  // -----------------------------------------------------------------------

  private createStreamState(entry: ChatInboxEntry): StreamState {
    return { entry, messageId: null, currentBody: "", targetBody: "", lastUpdateAtMs: 0, nativeDeltaChars: 0 };
  }

  private async flushStream(state: StreamState, opts?: { force?: boolean }): Promise<boolean> {
    const force = opts?.force ?? false;
    const nextBody = truncateChatReply(state.targetBody, this.ctx.config.chatRuntimeReplyMaxChars);
    if (!nextBody.length || /^(?:\u2026+|\.{3,})$/u.test(nextBody) || nextBody === state.currentBody) return false;
    if (!force && Date.now() - state.lastUpdateAtMs < this.ctx.config.chatRuntimeTextStreamUpdateMinMs) return false;
    if (typeof state.messageId === "string" && state.messageId.trim().length > 0) {
      await this.editMessage(state.messageId, nextBody);
    } else {
      const created = await this.sendReply(state.entry, nextBody);
      const createdId = extractSentMessageId(created);
      if (!createdId) return false;
      state.messageId = createdId;
    }
    state.currentBody = nextBody; state.lastUpdateAtMs = Date.now();
    return true;
  }

  private async finalizeStream(state: StreamState, finalBody: string): Promise<boolean> {
    const normalized = truncateChatReply(finalBody, this.ctx.config.chatRuntimeReplyMaxChars);
    if (!normalized.length) return false;
    state.targetBody = normalized;
    await this.flushStream(state, { force: true }).catch(() => undefined);
    return state.currentBody === normalized;
  }

  // -----------------------------------------------------------------------
  // Private: state persistence
  // -----------------------------------------------------------------------

  private async persistState(reason: string): Promise<void> {
    if (!this.ctx.config.chatRuntimeEnabled || !this.ctx.chat.chatRuntimeStateDirty) return;
    const nowMs = Date.now();
    if (reason !== "init" && nowMs - this.ctx.chat.chatRuntimeStateWriteAtMs < 1000) return;
    const lastId = this.ctx.chat.chatSeenMessageIdQueue.length > 0
      ? this.ctx.chat.chatSeenMessageIdQueue[this.ctx.chat.chatSeenMessageIdQueue.length - 1] : null;
    await writeJsonFile(this.ctx.ipcPaths.chatRuntimeStatePath, {
      updatedAt: nowIso(), reason, inboxPath: this.ctx.ipcPaths.chatInboxPath,
      readOffset: this.ctx.chat.chatInboxReadOffset, partialLine: this.ctx.chat.chatInboxPartialLine,
      seenMessageIds: [...this.ctx.chat.chatSeenMessageIdQueue],
      retentionDialogs: [...this.retentionDialogs.values()],
      lastProcessedMessageId: lastId ?? null, lastProcessedAt: nowIso(),
    }).catch(() => undefined);
    this.ctx.chat.chatRuntimeStateDirty = false;
    this.ctx.chat.chatRuntimeStateWriteAtMs = nowMs;
  }

  // -----------------------------------------------------------------------
  // Private: mention tokens + conversation history
  // -----------------------------------------------------------------------

  private async resolveMentionTokens(): Promise<string[]> {
    const nowMs = Date.now();
    if (nowMs - this.ctx.chat.chatMentionTokensCachedAtMs < 60_000 && this.ctx.chat.chatMentionTokensCache.length > 0) {
      return this.ctx.chat.chatMentionTokensCache;
    }
    const openclawName = await this.ctx.resolveOpenClawAgentName().catch(() => null);
    const tokens = buildMentionTokens({ mentionNames: this.ctx.config.chatRuntimeMentionNames, openclawAgentName: openclawName });
    this.ctx.chat.chatMentionTokensCache = tokens;
    this.ctx.chat.chatMentionTokensCachedAtMs = nowMs;
    return tokens;
  }

  private resolveReplyTargetContext(
    entry: ChatInboxEntry,
    conversationHistory: unknown[],
  ): ReplyTargetContext | null {
    const replyToMessageId = entry.replyToMessageId?.trim() ?? "";
    if (!replyToMessageId.length) return null;

    const matched = conversationHistory.find((item) => {
      if (!isRecord(item)) return false;
      const message = isRecord(item.message) ? item.message : null;
      return (
        message &&
        typeof message.id === "string" &&
        message.id.trim() === replyToMessageId
      );
    });

    if (!isRecord(matched)) {
      return {
        messageId: replyToMessageId,
        authorDisplay: null,
        authorHandle: null,
        bodyPreview: null,
        attachmentSummary: null,
        hintPostId: null,
        hintCommentId: null,
        retrievalQueryFragment: `reply_to_message_id ${replyToMessageId}`,
      };
    }

    const message = isRecord(matched.message) ? matched.message : null;
    const author = isRecord(matched.author) ? matched.author : null;
    const body =
      message && typeof message.body === "string" ? message.body.trim() : "";
    const bodyPreview = body.length > 0 ? toAnswerPreview(body, 220) : null;
    const authorDisplay =
      author && typeof author.displayCache === "string" && author.displayCache.trim().length > 0
        ? author.displayCache.trim()
        : null;
    const authorHandleRaw =
      author && typeof author.handleCache === "string" && author.handleCache.trim().length > 0
        ? author.handleCache.trim()
        : "";
    const authorHandle = authorHandleRaw.replace(/^@+/u, "");
    const attachmentSummary = summarizeReplyTargetAttachments(matched.attachments);

    const bodyHints = body.length > 0 ? parsePostAndCommentHints(body) : {};
    const messageHints = message ? extractPostAndCommentHintsFromRecord(message) : { postId: null, commentId: null };
    const metadataHints =
      message && isRecord(message.metadata)
        ? extractPostAndCommentHintsFromRecord(message.metadata)
        : { postId: null, commentId: null };
    const hintPostId =
      bodyHints.postId ??
      messageHints.postId ??
      metadataHints.postId ??
      null;
    const hintCommentId =
      bodyHints.commentId ??
      messageHints.commentId ??
      metadataHints.commentId ??
      null;

    const retrievalParts = [
      `reply_to_message_id ${replyToMessageId}`,
      authorHandle.length > 0 ? `reply_to_author @${authorHandle}` : "",
      bodyPreview ? `reply_to_body ${bodyPreview}` : "",
      typeof hintPostId === "number" ? `reply_to_post ${hintPostId}` : "",
      typeof hintCommentId === "number" ? `reply_to_comment ${hintCommentId}` : "",
      attachmentSummary ? `reply_to_attachments ${attachmentSummary}` : "",
    ].filter((part) => part.length > 0);

    return {
      messageId: replyToMessageId,
      authorDisplay,
      authorHandle: authorHandle.length > 0 ? authorHandle : null,
      bodyPreview,
      attachmentSummary,
      hintPostId,
      hintCommentId,
      retrievalQueryFragment: toAnswerPreview(retrievalParts.join(" "), 420),
    };
  }

  private async fetchConversationHistory(entry: ChatInboxEntry): Promise<unknown[]> {
    try {
      const limit = entry.replyToMessageId ? 40 : 10;
      const payload = {
        action: "list_messages",
        ...(entry.conversationId ? { conversationId: entry.conversationId } : { channelId: entry.channelId }),
        limit,
      };
      const result = await this.ctx.callAgentChatBridge(payload);
      if (isRecord(result) && Array.isArray(result.items)) {
        return (result.items as unknown[]).slice(0, limit).reverse();
      }
      return [];
    } catch { return []; }
  }

  private async reportSystemProbe(
    entry: ChatInboxEntry,
    reason:
      | "system_disclosure_request_blocked"
      | "system_disclosure_reply_blocked",
  ): Promise<void> {
    const targetMainUserId = entry.authorMainUserId?.trim() ?? "";
    if (!targetMainUserId.length) return;
    const contextPayload = entry.conversationId
      ? { conversationId: entry.conversationId }
      : entry.channelId
        ? { channelId: entry.channelId }
        : null;
    if (!contextPayload) return;
    try {
      const payload = {
        action: "report_system_probe",
        targetMainUserId,
        ...(entry.messageId ? { messageId: entry.messageId } : {}),
        ...contextPayload,
        reason,
      };
      const response = await this.ctx.callAgentChatBridge(payload);
      await this.ctx.memory
        .recordWrite({
          type: "chat_runtime_system_probe_reported",
          at: nowIso(),
          reason,
          messageId: entry.messageId,
          targetMainUserId,
          response: isRecord(response) ? response : null,
        })
        .catch(() => undefined);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.ctx.memory
        .recordWrite({
          type: "chat_runtime_system_probe_report_failed",
          at: nowIso(),
          reason,
          messageId: entry.messageId,
          targetMainUserId,
          error: toAnswerPreview(message, 240),
        })
        .catch(() => undefined);
    }
  }

  private getRetentionDialogKey(entry: ChatInboxEntry): string | null {
    if (entry.conversationId && entry.conversationId.trim().length > 0) {
      return `conversation:${entry.conversationId.trim()}`;
    }
    if (entry.authorMainUserId && entry.authorMainUserId.trim().length > 0) {
      return `author:${entry.authorMainUserId.trim()}`;
    }
    return null;
  }

  private isRetentionIntentMessage(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (!normalized.length) return false;
    if (RETENTION_INTENT_PATTERN.test(normalized)) return true;
    return (
      RETENTION_ACTION_PATTERN.test(normalized) &&
      /\b(memory|archive|retention|ttl|cleanup|policy)\b/iu.test(normalized)
    );
  }

  private retentionStepPrompt(step: RetentionDialogStep): string {
    switch (step) {
      case "ask_days":
        return "Retention setup: how long should primary memory be kept before archival/compression? Example: `365 days` or `2 years`.";
      case "ask_interval":
        return "Retention setup: how often should cleanup run? Example: `every 3 hours` or `180 minutes`.";
      case "ask_long_term":
        return "Retention setup: should long-term archive stay enabled? Reply `yes` or `no`.";
      case "ask_agent_compression":
        return "Retention setup: should long-term archive use agent compression for older capsules? Reply `yes` or `no`.";
      case "ask_confirm":
        return "Reply `confirm` to apply, or `cancel` to abort.";
    }
  }

  private retentionSummary(config: RetentionDialogConfig): string {
    return [
      `days=${config.days}`,
      `intervalMin=${config.intervalMinutes}`,
      `longTerm=${config.longTermEnabled ? "on" : "off"}`,
      `agentCompression=${config.longTermUseAgentCompression ? "on" : "off"}`,
    ].join(" · ");
  }

  private toRetentionDialogConfig(
    pending: Partial<RetentionDialogConfig>,
  ): RetentionDialogConfig | null {
    if (
      typeof pending.days !== "number" ||
      !Number.isFinite(pending.days) ||
      pending.days <= 0
    ) {
      return null;
    }
    if (
      typeof pending.intervalMinutes !== "number" ||
      !Number.isFinite(pending.intervalMinutes) ||
      pending.intervalMinutes <= 0
    ) {
      return null;
    }
    if (typeof pending.longTermEnabled !== "boolean") return null;
    const longTermUseAgentCompression =
      pending.longTermEnabled === true
        ? pending.longTermUseAgentCompression === true
        : false;
    return {
      days: clampInt(pending.days, 1, 3650),
      intervalMinutes: clampInt(pending.intervalMinutes, 10, 1440),
      longTermEnabled: pending.longTermEnabled,
      longTermUseAgentCompression,
    };
  }

  private buildRetentionConfirmPrompt(
    config: RetentionDialogConfig,
  ): string {
    return [
      "Retention plan:",
      this.retentionSummary(config),
      this.retentionStepPrompt("ask_confirm"),
    ].join("\n");
  }

  private async applyRetentionPolicy(
    config: RetentionDialogConfig,
  ): Promise<{ ok: boolean; reply: string }> {
    const hostRaw = (process.env.MG_AGENT_HEALTH_HOST ?? "").trim();
    const host = hostRaw.length > 0 ? hostRaw : "127.0.0.1";
    const portRaw = Number.parseInt(
      (process.env.MG_AGENT_HEALTH_PORT ?? "4278").trim(),
      10,
    );
    const port =
      Number.isFinite(portRaw) && portRaw > 0 && portRaw <= 65_535
        ? portRaw
        : 4278;
    const key = (process.env.MG_AGENT_HEALTH_PRIVATE_KEY ?? "").trim();
    const url = new URL(`/api/health/retention`, `http://${host}:${port}`);
    url.searchParams.set("set", "1");
    url.searchParams.set("days", String(config.days));
    url.searchParams.set("intervalMinutes", String(config.intervalMinutes));
    url.searchParams.set("longTermEnabled", config.longTermEnabled ? "1" : "0");
    url.searchParams.set(
      "longTermUseAgentCompression",
      config.longTermUseAgentCompression ? "1" : "0",
    );
    if (key.length > 0) url.searchParams.set("key", key);

    let response: Response;
    try {
      response = await fetch(url.toString(), { method: "GET" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reply: `Retention update failed: ${toAnswerPreview(message, 160)}`,
      };
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const payloadRecord = isRecord(payload) ? payload : null;
    if (!response.ok || payloadRecord?.ok === false) {
      const detail =
        payloadRecord && typeof payloadRecord.message === "string"
          ? payloadRecord.message
          : `HTTP ${response.status}`;
      return {
        ok: false,
        reply: `Retention update failed: ${toAnswerPreview(detail, 160)}`,
      };
    }
    const updated =
      payloadRecord && typeof payloadRecord.updated === "boolean"
        ? payloadRecord.updated
        : true;
    return {
      ok: true,
      reply: `Retention ${updated ? "updated" : "already up to date"}.\n${this.retentionSummary(config)}`,
    };
  }

  private async handleRetentionPolicyDialog(
    entry: ChatInboxEntry,
  ): Promise<string | null> {
    const body = entry.body.trim();
    if (!body.length) return null;

    const dialogKey = this.getRetentionDialogKey(entry);
    if (!dialogKey) return null;
    const existing = this.retentionDialogs.get(dialogKey) ?? null;
    const wantsRetentionFlow = this.isRetentionIntentMessage(body);
    if (!existing && !wantsRetentionFlow) return null;

    if (entry.channelId) {
      if (existing) {
        this.retentionDialogs.delete(dialogKey);
        this.ctx.chat.chatRuntimeStateDirty = true;
      }
      return "Retention settings can only be changed in a DM with me. Open a DM and I’ll walk through it step by step.";
    }

    if (RETENTION_CANCEL_PATTERN.test(body)) {
      if (existing) {
        this.retentionDialogs.delete(dialogKey);
        this.ctx.chat.chatRuntimeStateDirty = true;
        return "Retention update canceled. Send `set retention ...` to start again.";
      }
      return "No retention update is currently in progress.";
    }

    let dialog = existing;
    if (!dialog) {
      const now = nowIso();
      const pending = extractRetentionDialogHints(body);
      dialog = {
        key: dialogKey,
        step: resolveRetentionDialogStep(pending),
        createdAt: now,
        updatedAt: now,
        conversationId: entry.conversationId,
        authorMainUserId: entry.authorMainUserId,
        pending,
      };
      this.retentionDialogs.set(dialogKey, dialog);
      this.ctx.chat.chatRuntimeStateDirty = true;
      await this.ctx.memory
        .recordWrite({
          type: "chat_runtime_retention_dialog_started",
          at: now,
          messageId: entry.messageId,
          conversationId: entry.conversationId,
          channelId: entry.channelId,
          pending,
        })
        .catch(() => undefined);
    } else {
      if (dialog.step === "ask_days") {
        const days = parseRetentionDaysInput(body);
        if (days === null) {
          return "I need the retention length first. Example: `365 days` or `2 years`.";
        }
        dialog.pending.days = days;
      } else if (dialog.step === "ask_interval") {
        const interval = parseRetentionIntervalMinutesInput(body);
        if (interval === null) {
          return "I need the cleanup interval. Example: `every 3 hours` or `180 minutes`.";
        }
        dialog.pending.intervalMinutes = interval;
      } else if (dialog.step === "ask_long_term") {
        const longTermEnabled = parseBooleanChatInput(body);
        if (longTermEnabled === null) {
          return "Should long-term archive be enabled? Reply `yes` or `no`.";
        }
        dialog.pending.longTermEnabled = longTermEnabled;
        if (!longTermEnabled) dialog.pending.longTermUseAgentCompression = false;
      } else if (dialog.step === "ask_agent_compression") {
        const useCompression = parseBooleanChatInput(body);
        if (useCompression === null) {
          return "Should I enable agent compression for long-term capsules? Reply `yes` or `no`.";
        }
        dialog.pending.longTermUseAgentCompression = useCompression;
      } else {
        const decision = parseBooleanChatInput(body);
        if (decision === null) {
          return "Reply `confirm` to apply retention changes, or `cancel`.";
        }
        if (!decision) {
          this.retentionDialogs.delete(dialogKey);
          this.ctx.chat.chatRuntimeStateDirty = true;
          return "No changes applied. Retention update canceled.";
        }
        const resolved = this.toRetentionDialogConfig(dialog.pending);
        if (!resolved) {
          dialog.step = resolveRetentionDialogStep(dialog.pending);
          dialog.updatedAt = nowIso();
          this.retentionDialogs.set(dialogKey, dialog);
          this.ctx.chat.chatRuntimeStateDirty = true;
          return this.retentionStepPrompt(dialog.step);
        }
        const applied = await this.applyRetentionPolicy(resolved);
        await this.ctx.memory
          .recordWrite({
            type: applied.ok
              ? "chat_runtime_retention_dialog_applied"
              : "chat_runtime_retention_dialog_apply_failed",
            at: nowIso(),
            messageId: entry.messageId,
            conversationId: entry.conversationId,
            channelId: entry.channelId,
            config: resolved,
            ok: applied.ok,
            replyPreview: toAnswerPreview(applied.reply, 220),
          })
          .catch(() => undefined);
        if (applied.ok) {
          this.retentionDialogs.delete(dialogKey);
          this.ctx.chat.chatRuntimeStateDirty = true;
        } else {
          dialog.updatedAt = nowIso();
          this.retentionDialogs.set(dialogKey, dialog);
          this.ctx.chat.chatRuntimeStateDirty = true;
        }
        return applied.reply;
      }
      dialog.updatedAt = nowIso();
      dialog.step = resolveRetentionDialogStep(dialog.pending);
      this.retentionDialogs.set(dialogKey, dialog);
      this.ctx.chat.chatRuntimeStateDirty = true;
    }

    const resolved = this.toRetentionDialogConfig(dialog.pending);
    if (resolved) {
      dialog.step = "ask_confirm";
      dialog.updatedAt = nowIso();
      this.retentionDialogs.set(dialogKey, dialog);
      this.ctx.chat.chatRuntimeStateDirty = true;
      return this.buildRetentionConfirmPrompt(resolved);
    }
    return this.retentionStepPrompt(dialog.step);
  }

  private async loadDrilldownContext(
    entry: ChatInboxEntry,
    conversationHistory: unknown[],
  ): Promise<string | null> {
    if (typeof this.ctx.memory.buildContext !== "function") return null;
    try {
      const messageHints = parsePostAndCommentHints(entry.body);
      const replyTargetContext = this.resolveReplyTargetContext(
        entry,
        conversationHistory,
      );
      const replyHints =
        replyTargetContext
          ? {
              ...(typeof replyTargetContext.hintPostId === "number"
                ? { postId: replyTargetContext.hintPostId }
                : {}),
              ...(typeof replyTargetContext.hintCommentId === "number"
                ? { commentId: replyTargetContext.hintCommentId }
                : {}),
            }
          : {};
      const hints = mergePostAndCommentHints(messageHints, replyHints);
      const includeViewState = shouldIncludeViewStateContext({
        entry,
        conversationHistory,
        hints,
      });
      const retrievalQuery = buildRetrievalQuery({
        entry,
        conversationHistory,
        replyTargetContext,
      });
      const retrievalIntent = resolveRetrievalIntentForEntry({
        entry,
        hints,
        retrievalQuery,
      });
      const audience = entry.channelId ? "chat_channel" : "chat_dm";
      const bundle = await this.ctx.memory.buildContext({
        mode: "chat",
        audience,
        maxRecentEvents: 120,
        maxArchiveEvents: 30,
        includeViewState,
        includeKeywordRetrieval: true,
        retrievalQuery,
        retrievalIntent,
        retrievalMaxItems:
          typeof hints.postId === "number" || typeof hints.commentId === "number"
            ? 10
            : 6,
        ...(includeViewState
          ? {
              viewStateMaxItems:
                typeof hints.postId === "number" || typeof hints.commentId === "number"
                  ? 12
                  : 6,
            }
          : {}),
        ...hints,
      });
      const summary = buildDrilldownMemorySummary(bundle);
      const liveLookupLines = await this.loadLiveSiteLookup({
        entry,
        retrievalQuery,
        hints,
        bundle,
      });
      const systemDocContext = await this.loadSystemDocContext();
      const linkedOwnerIdentity = await this.loadLinkedOwnerIdentity();
      const replyTargetLines = buildReplyTargetSummaryLines(replyTargetContext);
      const linkedOwnerLines = linkedOwnerIdentity
        ? [
            `- owner (authoritative) = @${linkedOwnerIdentity.ownerHandle}${
              linkedOwnerIdentity.ownerName
                ? ` (${linkedOwnerIdentity.ownerName})`
                : ""
            }`,
            `- agent (self) = ${
              linkedOwnerIdentity.agentHandle
                ? `@${linkedOwnerIdentity.agentHandle}`
                : linkedOwnerIdentity.agentName ?? "unknown"
            }`,
            "- if owner/permissions are mentioned, use this owner handle only; never guess from display names or memory aliases",
          ]
        : [];

      const historyLines = conversationHistory
        .map((item) => {
          if (!isRecord(item)) return "";
          const message = isRecord(item.message) ? item.message : null;
          const author = isRecord(item.author) ? item.author : null;
          const body =
            message && typeof message.body === "string"
              ? message.body.trim()
              : "";
          if (!body.length) return "";
          const display =
            author && typeof author.displayCache === "string"
              ? author.displayCache
              : author && typeof author.handleCache === "string"
                ? author.handleCache
                : "unknown";
          return `${display}: ${body}`;
        })
        .filter((line) => line.length > 0)
        .slice(-8);

      const combined = [
        "## Site Retrieval Map",
        "- user is talking to their connected runtime agent on Molkgram",
        "- prefer natural conversation; do not force command syntax",
        "- when asked about drafts/directives/posts/comments/likes, infer from recent memory first",
        "- when asked for gifs or reactions, use live gif lookup results when available",
        "- for emotes/stickers/gifs in chats, prefer agent-owned custom assets first, then owner-selected assets",
        "- memory retrieval supports: most recent post, most engaged posts/comments, last comments/likes/views, and top participants by engagement or memory presence",
        "- if memory misses, use live site lookup results below before asking for clarification",
        "- if exact target unclear, ask one concise clarifying question",
        "- permissions/account ownership: use linked owner identity below as source of truth; do not infer from similar handles",
        "",
        "## Runtime Capability Map",
        "- agent_profile: authoritative owner linkage for this agent (owner handle + id)",
        "- list_messages: fetch DM/channel history and reply target content",
        "- find_post / find_comment / find_user / find_gif / find_custom_assets / browse_assets / suggest_followers / browse_posts / browse_comments / browse_agents / browse_notifications / browse_home_feed / browse_trending / browse_post_activity / browse_comment_activity / browse_top_engagers / browse_unanswered_mentions / browse_drafts / browse_directive_queue / browse_servers / browse_channels / browse_members / browse_lenses / search_global / resolve_reference / browse_recent_actions: live site lookups",
        "- send_message / edit_message / typing: conversational response + status updates",
        "- memory context: keyword retrieval, long-term archive retrieval, view state, engagement presets",
        "- retention control (DM-only): guided retention policy updates",
        "- when conversion is ambiguous, use these capabilities first; ask follow-up only when no route can resolve the request",
        "- route names are exact snake_case tokens; do not invent aliases (for example never say findAgents)",
        "- only claim a route/action was run when the lookup result exists in context for this turn",
        "- if user asks about a route name and it is unknown, say so and use the closest real route from this map",
        "",
        ...(systemDocContext
          ? ["## System Docs Capability Context", systemDocContext, ""]
          : []),
        ...(linkedOwnerLines.length > 0
          ? ["## Linked Owner Identity", ...linkedOwnerLines, ""]
          : []),
        "## Recent Chat History",
        ...(historyLines.length > 0 ? historyLines : ["(none)"]),
        "",
        ...(replyTargetLines.length > 0
          ? ["## Reply Target", ...replyTargetLines, ""]
          : []),
        ...(liveLookupLines.length > 0
          ? ["## Live Site Lookup", ...liveLookupLines, ""]
          : []),
        summary,
      ].join("\n");

      const maxChars = Math.max(
        1200,
        Math.min(9000, this.ctx.config.chatRuntimeOpenClawInputMaxChars),
      );
      return combined.slice(0, maxChars);
    } catch {
      return null;
    }
  }

  private async loadSystemDocContext(): Promise<string | null> {
    const nowMs = Date.now();
    if (
      this.systemDocContextCached &&
      nowMs - this.systemDocContextCachedAtMs < 5 * 60_000
    ) {
      return this.systemDocContextCached;
    }
    if (this.systemDocContextInFlight) {
      return this.systemDocContextInFlight;
    }
    this.systemDocContextInFlight = (async () => {
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
      const capped =
        combined.length > 0
          ? combined.slice(0, 2600)
          : null;
      this.systemDocContextCached = capped;
      this.systemDocContextCachedAtMs = Date.now();
      return capped;
    })();
    try {
      return await this.systemDocContextInFlight;
    } finally {
      this.systemDocContextInFlight = null;
    }
  }

  private async loadLinkedOwnerIdentity(): Promise<LinkedOwnerIdentity | null> {
    const nowMs = Date.now();
    if (
      this.linkedOwnerIdentityCached &&
      nowMs - this.linkedOwnerIdentityCachedAtMs < 5 * 60_000
    ) {
      return this.linkedOwnerIdentityCached;
    }
    if (this.linkedOwnerIdentityInFlight) {
      return this.linkedOwnerIdentityInFlight;
    }
    this.linkedOwnerIdentityInFlight = (async () => {
      try {
        const response = await this.ctx.callAgentChatBridge({
          action: "agent_profile",
        });
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
        if (
          !agentMainUserId.length ||
          !ownerMainUserId.length ||
          !ownerHandle.length
        ) {
          return null;
        }
        const agentHandleRaw =
          typeof agent.handle === "string" ? agent.handle.trim() : "";
        const agentHandleNormalized = agentHandleRaw.replace(/^@+/u, "").toLowerCase();
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
        this.linkedOwnerIdentityCached = parsed;
        this.linkedOwnerIdentityCachedAtMs = Date.now();
        return parsed;
      } catch {
        return null;
      }
    })();
    try {
      return await this.linkedOwnerIdentityInFlight;
    } finally {
      this.linkedOwnerIdentityInFlight = null;
    }
  }

  private shouldRunLiveSiteLookup(input: {
    entry: ChatInboxEntry;
    retrievalQuery: string;
    hints: { postId?: number; commentId?: number };
    bundle: ContextBundle;
  }): boolean {
    if (
      typeof input.hints.postId === "number" ||
      typeof input.hints.commentId === "number"
    ) {
      return true;
    }
    const query = input.retrievalQuery.trim();
    if (!query.length) return false;
    if (SUGGESTED_FOLLOW_LOOKUP_PATTERN.test(query)) return true;
    if (BROWSE_POST_LOOKUP_PATTERN.test(query)) return true;
    if (BROWSE_COMMENT_LOOKUP_PATTERN.test(query)) return true;
    if (BROWSE_AGENT_LOOKUP_PATTERN.test(query)) return true;
    if (GIF_LOOKUP_PATTERN.test(query)) return true;
    if (BROWSE_NOTIFICATIONS_LOOKUP_PATTERN.test(query)) return true;
    if (BROWSE_HOME_FEED_LOOKUP_PATTERN.test(query)) return true;
    if (BROWSE_TRENDING_LOOKUP_PATTERN.test(query)) return true;
    if (BROWSE_POST_ACTIVITY_LOOKUP_PATTERN.test(query)) return true;
    if (BROWSE_COMMENT_ACTIVITY_LOOKUP_PATTERN.test(query)) return true;
    if (BROWSE_TOP_ENGAGERS_LOOKUP_PATTERN.test(query)) return true;
    if (BROWSE_UNANSWERED_MENTIONS_LOOKUP_PATTERN.test(query)) return true;
    if (BROWSE_DRAFTS_LOOKUP_PATTERN.test(query)) return true;
    if (BROWSE_DIRECTIVE_QUEUE_LOOKUP_PATTERN.test(query)) return true;
    if (BROWSE_SERVERS_LOOKUP_PATTERN.test(query)) return true;
    if (BROWSE_CHANNELS_LOOKUP_PATTERN.test(query)) return true;
    if (BROWSE_MEMBERS_LOOKUP_PATTERN.test(query)) return true;
    if (BROWSE_LENSES_LOOKUP_PATTERN.test(query)) return true;
    if (BROWSE_ASSETS_LOOKUP_PATTERN.test(query)) return true;
    if (SEARCH_GLOBAL_LOOKUP_PATTERN.test(query)) return true;
    if (BROWSE_RECENT_ACTIONS_LOOKUP_PATTERN.test(query)) return true;
    if (RESOLVE_REFERENCE_LOOKUP_PATTERN.test(query)) return true;
    if (!SITE_LOOKUP_TRIGGER_PATTERN.test(query)) return false;
    if (LOOKUP_FORCE_PATTERN.test(query)) return true;
    if (LATEST_POST_LOOKUP_PATTERN.test(query)) return true;
    const hits = parseRetrievalHitCount(input.bundle);
    return hits <= 0;
  }

  private async loadLiveSiteLookup(input: {
    entry: ChatInboxEntry;
    retrievalQuery: string;
    hints: { postId?: number; commentId?: number };
    bundle: ContextBundle;
  }): Promise<string[]> {
    if (!this.shouldRunLiveSiteLookup(input)) return [];
    const lines: string[] = [];
    const now = nowIso();
    const remember = async (payload: Record<string, unknown>): Promise<void> => {
      await this.ctx.memory.recordWrite({
        type: "chat_runtime_site_lookup",
        at: now,
        messageId: input.entry.messageId,
        conversationId: input.entry.conversationId ?? null,
        channelId: input.entry.channelId ?? null,
        query: toAnswerPreview(input.retrievalQuery, 220),
        ...payload,
      }).catch(() => undefined);
    };

    const lookupCall = async (payload: Record<string, unknown>) =>
      this.ctx.callAgentChatBridge(payload);

    let cachedServerRows: Array<Record<string, unknown>> | null = null;
    const listServers = async (): Promise<Array<Record<string, unknown>>> => {
      if (cachedServerRows) return cachedServerRows;
      const query = extractLookupQueryTerm(input.retrievalQuery);
      const response = await lookupCall({
        action: "browse_servers",
        ...(query ? { query } : {}),
        limit: 12,
      });
      const rows =
        isRecord(response) && Array.isArray(response.items)
          ? response.items.filter((entry): entry is Record<string, unknown> =>
              isRecord(entry),
            )
          : [];
      cachedServerRows = rows;
      return rows;
    };

    if (typeof input.hints.postId === "number") {
      try {
        const response = await lookupCall({
          action: "find_post",
          postId: input.hints.postId,
        });
        const postRecord = pickPostRecordFromLookup(response);
        if (postRecord) {
          const summary = summarizePostRecord(postRecord);
          lines.push(`lookup: ${summary.line}`);
          await remember({
            lookupKind: "post_by_id",
            found: true,
            postId: summary.postId,
            summary: summary.bodyPreview ?? summary.line,
          });
        } else {
          lines.push(`lookup: post:${input.hints.postId} not found`);
          await remember({
            lookupKind: "post_by_id",
            found: false,
            postId: input.hints.postId,
            summary: `post:${input.hints.postId} not found`,
          });
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(
          `lookup: post:${input.hints.postId} fetch failed (${toAnswerPreview(message, 120)})`,
        );
        await remember({
          lookupKind: "post_by_id",
          found: false,
          postId: input.hints.postId,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    const wantsCommentLookup =
      typeof input.hints.commentId === "number" ||
      COMMENT_LOOKUP_PATTERN.test(input.retrievalQuery);
    if (wantsCommentLookup && typeof input.hints.postId === "number") {
      try {
        const response = await lookupCall({
          action: "find_comment",
          postId: input.hints.postId,
          ...(typeof input.hints.commentId === "number"
            ? { commentId: input.hints.commentId }
            : {}),
        });
        const comments = pickCommentRecordsFromLookup(response);
        const sorted = comments
          .map((entry) => ({
            record: entry,
            createdAtMs: Date.parse(
              typeof entry.createdAt === "string" ? entry.createdAt : "",
            ),
          }))
          .sort((a, b) => b.createdAtMs - a.createdAtMs)
          .map((entry) => entry.record);
        const chosen =
          typeof input.hints.commentId === "number"
            ? sorted.slice(0, 1)
            : sorted.slice(0, 3);
        if (chosen.length === 0) {
          const detail =
            typeof input.hints.commentId === "number"
              ? `comment:${input.hints.commentId}`
              : "recent comments";
          lines.push(`lookup: ${detail} not found for post:${input.hints.postId}`);
          await remember({
            lookupKind: "comment_by_post",
            found: false,
            postId: input.hints.postId,
            commentId: input.hints.commentId ?? null,
            summary: `${detail} not found`,
          });
        } else {
          for (const commentRecord of chosen) {
            const summary = summarizeCommentRecord(commentRecord);
            lines.push(`lookup: ${summary.line}`);
            await remember({
              lookupKind: "comment_by_post",
              found: true,
              postId: summary.postId,
              commentId: summary.commentId,
              summary: summary.bodyPreview ?? summary.line,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(
          `lookup: comment fetch failed (${toAnswerPreview(message, 120)})`,
        );
        await remember({
          lookupKind: "comment_by_post",
          found: false,
          postId: input.hints.postId,
          commentId: input.hints.commentId ?? null,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    const wantsPostActivityLookup =
      typeof input.hints.postId === "number" &&
      BROWSE_POST_ACTIVITY_LOOKUP_PATTERN.test(input.retrievalQuery);
    if (wantsPostActivityLookup && typeof input.hints.postId === "number") {
      try {
        const response = await lookupCall({
          action: "browse_post_activity",
          postId: input.hints.postId,
          limit: 12,
          includeLikes: true,
          includeReposts: true,
          includeComments: true,
          includeViews: true,
        });
        const responseRecord = isRecord(response) ? response : null;
        const totalsRecord =
          responseRecord && isRecord(responseRecord.totals) ? responseRecord.totals : null;
        const totals = {
          likes: toFinitePositiveInt(totalsRecord?.likes) ?? 0,
          reposts: toFinitePositiveInt(totalsRecord?.reposts) ?? 0,
          comments: toFinitePositiveInt(totalsRecord?.comments) ?? 0,
          views: toFinitePositiveInt(totalsRecord?.views) ?? 0,
        };
        const itemsRecord =
          responseRecord && isRecord(responseRecord.items) ? responseRecord.items : null;
        const likes = Array.isArray(itemsRecord?.likes) ? itemsRecord.likes : [];
        const reposts = Array.isArray(itemsRecord?.reposts) ? itemsRecord.reposts : [];
        const comments = Array.isArray(itemsRecord?.comments) ? itemsRecord.comments : [];
        const firstActorHandle = (() => {
          const firstLike = likes.find((entry) => isRecord(entry));
          if (isRecord(firstLike?.author) && typeof firstLike.author.handle === "string") {
            return firstLike.author.handle.trim().replace(/^@+/u, "");
          }
          if (isRecord(firstLike?.user) && typeof firstLike.user.handle === "string") {
            return firstLike.user.handle.trim().replace(/^@+/u, "");
          }
          return null;
        })();
        const line = [
          `lookup: post:${input.hints.postId} activity`,
          `likes=${totals.likes}`,
          `reposts=${totals.reposts}`,
          `comments=${totals.comments}`,
          `views=${totals.views}`,
          firstActorHandle ? `firstLiker=@${firstActorHandle}` : "",
        ]
          .filter((part) => part.length > 0)
          .join(" · ");
        lines.push(line);
        await remember({
          lookupKind: "post_activity",
          found: true,
          postId: input.hints.postId,
          likes: totals.likes,
          reposts: totals.reposts,
          comments: totals.comments,
          views: totals.views,
          sampleLikeCount: likes.length,
          sampleRepostCount: reposts.length,
          sampleCommentCount: comments.length,
          summary: line,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(
          `lookup: post:${input.hints.postId} activity failed (${toAnswerPreview(message, 120)})`,
        );
        await remember({
          lookupKind: "post_activity",
          found: false,
          postId: input.hints.postId,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    const wantsCommentActivityLookup =
      typeof input.hints.commentId === "number" &&
      BROWSE_COMMENT_ACTIVITY_LOOKUP_PATTERN.test(input.retrievalQuery);
    if (wantsCommentActivityLookup && typeof input.hints.commentId === "number") {
      try {
        const response = await lookupCall({
          action: "browse_comment_activity",
          commentId: input.hints.commentId,
          limit: 12,
          includeReplies: true,
          includeViews: true,
        });
        const responseRecord = isRecord(response) ? response : null;
        const totalsRecord =
          responseRecord && isRecord(responseRecord.totals) ? responseRecord.totals : null;
        const replies = toFinitePositiveInt(totalsRecord?.replies) ?? 0;
        const views = toFinitePositiveInt(totalsRecord?.views) ?? 0;
        const commentRecord =
          responseRecord && isRecord(responseRecord.comment) ? responseRecord.comment : null;
        const bodyRaw = commentRecord && typeof commentRecord.body === "string"
          ? commentRecord.body
          : "";
        const line = [
          `lookup: comment:${input.hints.commentId} activity`,
          `replies=${replies}`,
          `views=${views}`,
          bodyRaw.trim().length > 0 ? `summary=${toAnswerPreview(bodyRaw, 100)}` : "",
        ]
          .filter((part) => part.length > 0)
          .join(" · ");
        lines.push(line);
        await remember({
          lookupKind: "comment_activity",
          found: true,
          commentId: input.hints.commentId,
          postId: toFinitePositiveInt(commentRecord?.postId),
          replies,
          views,
          summary: line,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(
          `lookup: comment:${input.hints.commentId} activity failed (${toAnswerPreview(message, 120)})`,
        );
        await remember({
          lookupKind: "comment_activity",
          found: false,
          commentId: input.hints.commentId,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    if (LATEST_POST_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      const handles = parseHandleMentions(input.retrievalQuery);
      if (
        handles.length === 0 &&
        /\b(my|me|i)\b/iu.test(input.entry.body) &&
        input.entry.authorHandle.trim().length > 0
      ) {
        handles.push(input.entry.authorHandle.trim().replace(/^@+/u, "").toLowerCase());
      }
      for (const handle of handles.slice(0, 3)) {
        try {
          const response = await lookupCall({
            action: "find_post",
            authorHandle: handle,
            latest: true,
          });
          const postRecord = pickPostRecordFromLookup(response);
          if (postRecord) {
            const summary = summarizePostRecord(postRecord);
            lines.push(`lookup: latest @${handle} -> ${summary.line}`);
            await remember({
              lookupKind: "latest_post_by_handle",
              found: true,
              handle,
              postId: summary.postId,
              summary: summary.bodyPreview ?? summary.line,
            });
          } else {
            lines.push(`lookup: latest post for @${handle} not found`);
            await remember({
              lookupKind: "latest_post_by_handle",
              found: false,
              handle,
              summary: `latest post for @${handle} not found`,
            });
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          lines.push(
            `lookup: latest @${handle} failed (${toAnswerPreview(message, 120)})`,
          );
          await remember({
            lookupKind: "latest_post_by_handle",
            found: false,
            handle,
            error: toAnswerPreview(message, 180),
          });
        }
      }
    }

    if (FOLLOW_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      const handles = parseHandleMentions(input.retrievalQuery);
      for (const handle of handles.slice(0, 3)) {
        try {
          const response = await lookupCall({
            action: "find_user",
            handle,
          });
          const userRecord = isRecord(response)
            ? isRecord(response.user)
              ? response.user
              : response
            : null;
          if (userRecord) {
            const resolvedHandle =
              (typeof userRecord.handle === "string"
                ? userRecord.handle
                : handle).trim();
            lines.push(`lookup: user @${resolvedHandle} exists`);
            await remember({
              lookupKind: "user_by_handle",
              found: true,
              handle: resolvedHandle,
              summary: `user @${resolvedHandle} exists`,
            });
          } else {
            lines.push(`lookup: user @${handle} not found`);
            await remember({
              lookupKind: "user_by_handle",
              found: false,
              handle,
              summary: `user @${handle} not found`,
            });
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          lines.push(`lookup: user @${handle} failed (${toAnswerPreview(message, 120)})`);
          await remember({
            lookupKind: "user_by_handle",
            found: false,
            handle,
            error: toAnswerPreview(message, 180),
          });
        }
      }
    }

    if (SUGGESTED_FOLLOW_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      try {
        const response = await lookupCall({
          action: "suggest_followers",
          limit: 8,
          includeAgents: true,
        });
        const users = pickUserRecordsFromLookup(response)
          .map((entry) => summarizeUserRecord(entry))
          .slice(0, 4);
        if (users.length === 0) {
          lines.push("lookup: no follow suggestions available right now");
          await remember({
            lookupKind: "suggest_followers",
            found: false,
            summary: "no follow suggestions available",
          });
        } else {
          for (const user of users) {
            lines.push(`lookup: ${user.line}`);
            await remember({
              lookupKind: "suggest_followers",
              found: true,
              handle: user.handle,
              userId: user.userId,
              summary: user.reason ?? user.line,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(
          `lookup: suggest_followers failed (${toAnswerPreview(message, 120)})`,
        );
        await remember({
          lookupKind: "suggest_followers",
          found: false,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    if (BROWSE_POST_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      try {
        const response = await lookupCall({
          action: "browse_posts",
          limit: 8,
        });
        const posts = pickPostRecordsFromLookup(response)
          .map((entry) => summarizePostRecord(entry))
          .slice(0, 4);
        if (posts.length === 0) {
          lines.push("lookup: browse posts returned no items");
          await remember({
            lookupKind: "browse_posts",
            found: false,
            summary: "browse posts returned no items",
          });
        } else {
          for (const post of posts) {
            lines.push(`lookup: browse -> ${post.line}`);
            await remember({
              lookupKind: "browse_posts",
              found: true,
              postId: post.postId,
              summary: post.bodyPreview ?? post.line,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(
          `lookup: browse_posts failed (${toAnswerPreview(message, 120)})`,
        );
        await remember({
          lookupKind: "browse_posts",
          found: false,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    if (BROWSE_COMMENT_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      try {
        const response = await lookupCall({
          action: "browse_comments",
          limit: 10,
          ...(typeof input.hints.postId === "number"
            ? { postId: input.hints.postId }
            : {
                searchText: toAnswerPreview(input.retrievalQuery, 160),
              }),
        });
        const comments = pickCommentRecordsFromLookup(response)
          .map((entry) => summarizeCommentRecord(entry))
          .slice(0, 4);
        if (comments.length === 0) {
          lines.push("lookup: browse comments returned no items");
          await remember({
            lookupKind: "browse_comments",
            found: false,
            postId: input.hints.postId ?? null,
            summary: "browse comments returned no items",
          });
        } else {
          for (const comment of comments) {
            lines.push(`lookup: browse comments -> ${comment.line}`);
            await remember({
              lookupKind: "browse_comments",
              found: true,
              postId: comment.postId,
              commentId: comment.commentId,
              summary: comment.bodyPreview ?? comment.line,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(
          `lookup: browse_comments failed (${toAnswerPreview(message, 120)})`,
        );
        await remember({
          lookupKind: "browse_comments",
          found: false,
          postId: input.hints.postId ?? null,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    if (BROWSE_AGENT_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      try {
        const response = await lookupCall({
          action: "browse_agents",
          query: toAnswerPreview(input.retrievalQuery, 90),
          limit: 8,
          includeFollowing: true,
          includeFollowers: true,
          includeRecentPosters: true,
        });
        const users = pickUserRecordsFromLookup(response)
          .map((entry) => summarizeUserRecord(entry))
          .slice(0, 4);
        if (users.length === 0) {
          lines.push("lookup: browse agents returned no items");
          await remember({
            lookupKind: "browse_agents",
            found: false,
            summary: "browse agents returned no items",
          });
        } else {
          for (const user of users) {
            lines.push(`lookup: browse agents -> ${user.line}`);
            await remember({
              lookupKind: "browse_agents",
              found: true,
              handle: user.handle,
              userId: user.userId,
              summary: user.reason ?? user.line,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(
          `lookup: browse_agents failed (${toAnswerPreview(message, 120)})`,
        );
        await remember({
          lookupKind: "browse_agents",
          found: false,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    if (BROWSE_NOTIFICATIONS_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      const unreadOnly =
        /\b(unread|unanswered|pending)\b/iu.test(input.retrievalQuery);
      try {
        const response = await lookupCall({
          action: "browse_notifications",
          unreadOnly,
          limit: 12,
        });
        const rows =
          isRecord(response) && Array.isArray(response.items)
            ? response.items.filter((entry): entry is Record<string, unknown> =>
                isRecord(entry),
              )
            : [];
        if (rows.length === 0) {
          lines.push(
            unreadOnly
              ? "lookup: no unread notifications right now"
              : "lookup: notifications feed is empty right now",
          );
          await remember({
            lookupKind: "browse_notifications",
            found: false,
            unreadOnly,
            summary: unreadOnly
              ? "no unread notifications"
              : "notifications feed is empty",
          });
        } else {
          for (const row of rows.slice(0, 4)) {
            const actor =
              isRecord(row.actor) && typeof row.actor.handle === "string"
                ? row.actor.handle.trim().replace(/^@+/u, "")
                : null;
            const type = typeof row.type === "string" ? row.type.trim() : "unknown";
            const entityType =
              typeof row.entityType === "string" ? row.entityType.trim() : "entity";
            const entityId = toFinitePositiveInt(row.entityId);
            const readAt =
              typeof row.readAt === "string" && row.readAt.trim().length > 0
                ? row.readAt.trim()
                : null;
            const line = [
              `lookup: notification:${type}`,
              actor ? `actor=@${actor}` : "",
              entityId ? `${entityType}:${entityId}` : entityType,
              readAt ? "read" : "unread",
            ]
              .filter((part) => part.length > 0)
              .join(" · ");
            lines.push(line);
            await remember({
              lookupKind: "browse_notifications",
              found: true,
              unreadOnly,
              notificationType: type,
              entityType,
              entityId,
              actorHandle: actor,
              readAt,
              summary: line,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(
          `lookup: notifications fetch failed (${toAnswerPreview(message, 120)})`,
        );
        await remember({
          lookupKind: "browse_notifications",
          found: false,
          unreadOnly,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    if (BROWSE_HOME_FEED_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      try {
        const response = await lookupCall({
          action: "browse_home_feed",
          limit: 10,
        });
        const posts = pickPostRecordsFromLookup(response)
          .map((entry) => summarizePostRecord(entry))
          .slice(0, 4);
        if (posts.length === 0) {
          lines.push("lookup: home feed returned no items");
          await remember({
            lookupKind: "browse_home_feed",
            found: false,
            summary: "home feed returned no items",
          });
        } else {
          for (const post of posts) {
            lines.push(`lookup: home -> ${post.line}`);
            await remember({
              lookupKind: "browse_home_feed",
              found: true,
              postId: post.postId,
              summary: post.bodyPreview ?? post.line,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(
          `lookup: home feed failed (${toAnswerPreview(message, 120)})`,
        );
        await remember({
          lookupKind: "browse_home_feed",
          found: false,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    if (BROWSE_TRENDING_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      try {
        const response = await lookupCall({
          action: "browse_trending",
          limit: 10,
        });
        const posts = pickPostRecordsFromLookup(response)
          .map((entry) => summarizePostRecord(entry))
          .slice(0, 4);
        if (posts.length === 0) {
          lines.push("lookup: trending returned no items");
          await remember({
            lookupKind: "browse_trending",
            found: false,
            summary: "trending returned no items",
          });
        } else {
          for (const post of posts) {
            lines.push(`lookup: trending -> ${post.line}`);
            await remember({
              lookupKind: "browse_trending",
              found: true,
              postId: post.postId,
              summary: post.bodyPreview ?? post.line,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(
          `lookup: trending failed (${toAnswerPreview(message, 120)})`,
        );
        await remember({
          lookupKind: "browse_trending",
          found: false,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    if (BROWSE_TOP_ENGAGERS_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      const windowHours = parseLookupWindowHours(input.retrievalQuery) ?? 24 * 7;
      try {
        const response = await lookupCall({
          action: "browse_top_engagers",
          limit: 8,
          windowHours,
        });
        const rows =
          isRecord(response) && Array.isArray(response.items)
            ? response.items.filter((entry): entry is Record<string, unknown> =>
                isRecord(entry),
              )
            : [];
        if (rows.length === 0) {
          lines.push(`lookup: no top engagers found in last ${windowHours}h`);
          await remember({
            lookupKind: "browse_top_engagers",
            found: false,
            windowHours,
            summary: `no top engagers in last ${windowHours}h`,
          });
        } else {
          for (const row of rows.slice(0, 4)) {
            const user =
              isRecord(row.user) && typeof row.user.handle === "string"
                ? row.user.handle.trim().replace(/^@+/u, "")
                : "unknown";
            const likeCount = toFinitePositiveInt(row.likeCount) ?? 0;
            const repostCount = toFinitePositiveInt(row.repostCount) ?? 0;
            const commentCount = toFinitePositiveInt(row.commentCount) ?? 0;
            const viewCount = toFinitePositiveInt(row.viewCount) ?? 0;
            const score =
              typeof row.score === "number" && Number.isFinite(row.score)
                ? row.score
                : commentCount * 3 + repostCount * 2 + likeCount * 2 + viewCount;
            const line = [
              `lookup: engager=@${user}`,
              `score=${score}`,
              `likes=${likeCount}`,
              `reposts=${repostCount}`,
              `comments=${commentCount}`,
              `views=${viewCount}`,
            ]
              .filter((part) => part.length > 0)
              .join(" · ");
            lines.push(line);
            await remember({
              lookupKind: "browse_top_engagers",
              found: true,
              windowHours,
              handle: user,
              score,
              likeCount,
              repostCount,
              commentCount,
              viewCount,
              summary: line,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(
          `lookup: top engagers failed (${toAnswerPreview(message, 120)})`,
        );
        await remember({
          lookupKind: "browse_top_engagers",
          found: false,
          windowHours,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    if (BROWSE_UNANSWERED_MENTIONS_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      const sinceHours = parseLookupWindowHours(input.retrievalQuery) ?? 24 * 7;
      try {
        const response = await lookupCall({
          action: "browse_unanswered_mentions",
          limit: 12,
          sinceHours,
        });
        const rows =
          isRecord(response) && Array.isArray(response.items)
            ? response.items.filter((entry): entry is Record<string, unknown> =>
                isRecord(entry),
              )
            : [];
        if (rows.length === 0) {
          lines.push(`lookup: no unanswered mentions in last ${sinceHours}h`);
          await remember({
            lookupKind: "browse_unanswered_mentions",
            found: false,
            sinceHours,
            summary: `no unanswered mentions in last ${sinceHours}h`,
          });
        } else {
          for (const row of rows.slice(0, 6)) {
            const targetType =
              typeof row.targetType === "string" ? row.targetType.trim() : "target";
            const targetId = toFinitePositiveInt(row.targetId);
            const line = [
              "lookup: unanswered mention",
              targetId ? `${targetType}:${targetId}` : targetType,
              typeof row.createdAt === "string" ? `at=${row.createdAt}` : "",
            ]
              .filter((part) => part.length > 0)
              .join(" · ");
            lines.push(line);
            await remember({
              lookupKind: "browse_unanswered_mentions",
              found: true,
              sinceHours,
              targetType,
              targetId,
              summary: line,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(
          `lookup: unanswered mentions failed (${toAnswerPreview(message, 120)})`,
        );
        await remember({
          lookupKind: "browse_unanswered_mentions",
          found: false,
          sinceHours,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    if (BROWSE_DRAFTS_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      try {
        const response = await lookupCall({
          action: "browse_drafts",
          limit: 10,
          ...(input.entry.conversationId
            ? { conversationId: input.entry.conversationId }
            : {}),
          ...(input.entry.channelId ? { channelId: input.entry.channelId } : {}),
        });
        const rows =
          isRecord(response) && Array.isArray(response.items)
            ? response.items.filter((entry): entry is Record<string, unknown> =>
                isRecord(entry),
              )
            : [];
        if (rows.length === 0) {
          lines.push("lookup: no recent drafts found");
          await remember({
            lookupKind: "browse_drafts",
            found: false,
            summary: "no recent drafts found",
          });
        } else {
          for (const row of rows.slice(0, 4)) {
            const draftId = typeof row.id === "string" ? row.id.trim() : "";
            const body =
              typeof row.body === "string" && row.body.trim().length > 0
                ? toAnswerPreview(row.body, 110)
                : null;
            const line = [
              `lookup: draft:${draftId || "n/a"}`,
              body ? `summary=${body}` : "",
              typeof row.createdAt === "string" ? `createdAt=${row.createdAt}` : "",
            ]
              .filter((part) => part.length > 0)
              .join(" · ");
            lines.push(line);
            await remember({
              lookupKind: "browse_drafts",
              found: true,
              draftId: draftId || null,
              summary: line,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(`lookup: drafts failed (${toAnswerPreview(message, 120)})`);
        await remember({
          lookupKind: "browse_drafts",
          found: false,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    if (BROWSE_DIRECTIVE_QUEUE_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      const includeCompleted = /\b(done|completed|failed|history|past)\b/iu.test(
        input.retrievalQuery,
      );
      try {
        const response = await lookupCall({
          action: "browse_directive_queue",
          includeCompleted,
          limit: 24,
        });
        const rows =
          isRecord(response) && Array.isArray(response.items)
            ? response.items.filter((entry): entry is Record<string, unknown> =>
                isRecord(entry),
              )
            : [];
        if (rows.length === 0) {
          lines.push("lookup: directive queue is empty");
          await remember({
            lookupKind: "browse_directive_queue",
            found: false,
            includeCompleted,
            summary: "directive queue is empty",
          });
        } else {
          for (const row of rows.slice(0, 6)) {
            const queueId = typeof row.id === "string" ? row.id.trim() : "";
            const status =
              typeof row.status === "string" ? row.status.trim() : "unknown";
            const actionKind =
              typeof row.actionKind === "string" ? row.actionKind.trim() : "unknown";
            const line = [
              `lookup: directive:${queueId || "n/a"}`,
              `status=${status}`,
              `action=${actionKind}`,
              typeof row.runAt === "string" ? `runAt=${row.runAt}` : "",
            ]
              .filter((part) => part.length > 0)
              .join(" · ");
            lines.push(line);
            await remember({
              lookupKind: "browse_directive_queue",
              found: true,
              includeCompleted,
              queueId: queueId || null,
              status,
              actionKind,
              summary: line,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(
          `lookup: directive queue failed (${toAnswerPreview(message, 120)})`,
        );
        await remember({
          lookupKind: "browse_directive_queue",
          found: false,
          includeCompleted,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    if (BROWSE_SERVERS_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      try {
        const rows = await listServers();
        if (rows.length === 0) {
          lines.push("lookup: no servers found");
          await remember({
            lookupKind: "browse_servers",
            found: false,
            summary: "no servers found",
          });
        } else {
          for (const row of rows.slice(0, 4)) {
            const id = typeof row.id === "string" ? row.id.trim() : "";
            const name = typeof row.name === "string" ? row.name.trim() : "unknown";
            const channelCount = toFinitePositiveInt(row.channelCount) ?? 0;
            const line = [
              `lookup: server:${id || "n/a"}`,
              `name=${toAnswerPreview(name, 48)}`,
              `channels=${channelCount}`,
            ]
              .filter((part) => part.length > 0)
              .join(" · ");
            lines.push(line);
            await remember({
              lookupKind: "browse_servers",
              found: true,
              serverId: id || null,
              summary: line,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(`lookup: servers failed (${toAnswerPreview(message, 120)})`);
        await remember({
          lookupKind: "browse_servers",
          found: false,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    if (BROWSE_CHANNELS_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      try {
        const query = extractLookupQueryTerm(input.retrievalQuery);
        const response = await lookupCall({
          action: "browse_channels",
          ...(query ? { query } : {}),
          limit: 20,
        });
        const rows =
          isRecord(response) && Array.isArray(response.items)
            ? response.items.filter((entry): entry is Record<string, unknown> =>
                isRecord(entry),
              )
            : [];
        if (rows.length === 0) {
          lines.push("lookup: no channels found");
          await remember({
            lookupKind: "browse_channels",
            found: false,
            query,
            summary: "no channels found",
          });
        } else {
          for (const row of rows.slice(0, 5)) {
            const id = typeof row.id === "string" ? row.id.trim() : "";
            const name = typeof row.name === "string" ? row.name.trim() : "unknown";
            const serverName =
              typeof row.serverName === "string" ? row.serverName.trim() : null;
            const line = [
              `lookup: channel:${id || "n/a"}`,
              `name=${toAnswerPreview(name, 48)}`,
              serverName ? `server=${toAnswerPreview(serverName, 36)}` : "",
            ]
              .filter((part) => part.length > 0)
              .join(" · ");
            lines.push(line);
            await remember({
              lookupKind: "browse_channels",
              found: true,
              query,
              channelId: id || null,
              summary: line,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(`lookup: channels failed (${toAnswerPreview(message, 120)})`);
        await remember({
          lookupKind: "browse_channels",
          found: false,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    if (BROWSE_MEMBERS_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      try {
        const query = extractLookupQueryTerm(input.retrievalQuery);
        const payload: Record<string, unknown> = {
          action: "browse_members",
          ...(query ? { query } : {}),
          limit: 20,
          includeAgents: true,
          includeHumans: true,
        };
        if (input.entry.conversationId) {
          payload.conversationId = input.entry.conversationId;
        } else {
          const servers = await listServers();
          const first = servers[0];
          if (isRecord(first) && typeof first.id === "string" && first.id.trim().length > 0) {
            payload.serverId = first.id.trim();
          }
        }
        if (!("conversationId" in payload) && !("serverId" in payload)) {
          lines.push("lookup: members lookup needs a chat or server context");
          await remember({
            lookupKind: "browse_members",
            found: false,
            summary: "members lookup missing conversation/server context",
          });
        } else {
          const response = await lookupCall(payload);
          const rows =
            isRecord(response) && Array.isArray(response.items)
              ? response.items.filter((entry): entry is Record<string, unknown> =>
                  isRecord(entry),
                )
              : [];
          if (rows.length === 0) {
            lines.push("lookup: no members found for this context");
            await remember({
              lookupKind: "browse_members",
              found: false,
              query,
              summary: "no members found for this context",
            });
          } else {
            for (const row of rows.slice(0, 6)) {
              const handle =
                typeof row.handle === "string" ? row.handle.trim().replace(/^@+/u, "") : "unknown";
              const role = typeof row.role === "string" ? row.role.trim() : null;
              const isAgent = row.isAgent === true;
              const line = [
                `lookup: member=@${handle}`,
                `type=${isAgent ? "agent" : "human"}`,
                role ? `role=${role}` : "",
              ]
                .filter((part) => part.length > 0)
                .join(" · ");
              lines.push(line);
              await remember({
                lookupKind: "browse_members",
                found: true,
                handle,
                role,
                isAgent,
                summary: line,
              });
            }
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(`lookup: members failed (${toAnswerPreview(message, 120)})`);
        await remember({
          lookupKind: "browse_members",
          found: false,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    if (BROWSE_LENSES_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      try {
        const query = extractLookupQueryTerm(input.retrievalQuery);
        const response = await lookupCall({
          action: "browse_lenses",
          ...(query ? { query } : {}),
          includeRules: /\b(rule|rules)\b/iu.test(input.retrievalQuery),
          limit: 12,
        });
        const rows =
          isRecord(response) && Array.isArray(response.items)
            ? response.items.filter((entry): entry is Record<string, unknown> =>
                isRecord(entry),
              )
            : [];
        if (rows.length === 0) {
          lines.push("lookup: no lenses found");
          await remember({
            lookupKind: "browse_lenses",
            found: false,
            query,
            summary: "no lenses found",
          });
        } else {
          for (const row of rows.slice(0, 4)) {
            const lensRecord = isRecord(row.lens) ? row.lens : null;
            const lensName =
              lensRecord && typeof lensRecord.name === "string"
                ? lensRecord.name.trim()
                : "unknown";
            const lensId = lensRecord ? toFinitePositiveInt(lensRecord.id) : null;
            const line = [
              `lookup: lens:${lensId ?? "n/a"}`,
              `name=${toAnswerPreview(lensName, 54)}`,
            ]
              .filter((part) => part.length > 0)
              .join(" · ");
            lines.push(line);
            await remember({
              lookupKind: "browse_lenses",
              found: true,
              query,
              lensId,
              summary: line,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(`lookup: lenses failed (${toAnswerPreview(message, 120)})`);
        await remember({
          lookupKind: "browse_lenses",
          found: false,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    const wantsAssetBrowse =
      BROWSE_ASSETS_LOOKUP_PATTERN.test(input.retrievalQuery) &&
      !CUSTOM_ASSET_LOOKUP_PATTERN.test(input.retrievalQuery);
    if (wantsAssetBrowse) {
      const assetQuery = extractLookupQueryTerm(input.retrievalQuery);
      try {
        const response = await lookupCall({
          action: "browse_assets",
          ...(assetQuery ? { query: assetQuery } : {}),
          limit: 12,
          includeOwnerSelections: true,
          ...(input.entry.conversationId
            ? { conversationId: input.entry.conversationId }
            : {}),
          ...(input.entry.channelId ? { channelId: input.entry.channelId } : {}),
        });
        const assets = pickCustomAssetRecordsFromLookup(response)
          .map((entry) => summarizeCustomAssetRecord(entry))
          .slice(0, 4);
        if (assets.length === 0) {
          lines.push(
            assetQuery
              ? `lookup: assets for "${assetQuery}" not found`
              : "lookup: no assets found",
          );
          await remember({
            lookupKind: "browse_assets",
            found: false,
            query: assetQuery,
            summary: assetQuery
              ? `assets for "${assetQuery}" not found`
              : "no assets found",
          });
        } else {
          for (const asset of assets) {
            lines.push(`lookup: ${asset.line}`);
            await remember({
              lookupKind: "browse_assets",
              found: true,
              query: assetQuery,
              kind: asset.kind,
              name: asset.name,
              owner: asset.owner,
              source: asset.source,
              url: asset.url,
              summary: asset.line,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(
          `lookup: asset browse failed (${toAnswerPreview(message, 120)})`,
        );
        await remember({
          lookupKind: "browse_assets",
          found: false,
          query: assetQuery,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    if (SEARCH_GLOBAL_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      const query = extractLookupQueryTerm(input.retrievalQuery);
      if (query) {
        try {
          const response = await lookupCall({
            action: "search_global",
            query,
            limit: 8,
            includePeople: true,
          });
          const people =
            isRecord(response) && Array.isArray(response.people)
              ? response.people.filter((entry): entry is Record<string, unknown> =>
                  isRecord(entry),
                )
              : [];
          const posts =
            isRecord(response) && Array.isArray(response.posts)
              ? response.posts.filter((entry): entry is Record<string, unknown> =>
                  isRecord(entry),
                )
              : [];
          const postSummaries = posts.map((entry) => summarizePostRecord(entry)).slice(0, 2);
          const peopleSummaries = people
            .map((entry) => summarizeUserRecord(entry))
            .slice(0, 2);
          if (postSummaries.length === 0 && peopleSummaries.length === 0) {
            lines.push(`lookup: global search "${query}" returned no matches`);
            await remember({
              lookupKind: "search_global",
              found: false,
              query,
              summary: `global search "${query}" returned no matches`,
            });
          } else {
            for (const person of peopleSummaries) {
              lines.push(`lookup: search person -> ${person.line}`);
              await remember({
                lookupKind: "search_global",
                found: true,
                query,
                handle: person.handle,
                userId: person.userId,
                summary: person.reason ?? person.line,
              });
            }
            for (const post of postSummaries) {
              lines.push(`lookup: search post -> ${post.line}`);
              await remember({
                lookupKind: "search_global",
                found: true,
                query,
                postId: post.postId,
                summary: post.bodyPreview ?? post.line,
              });
            }
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          lines.push(
            `lookup: global search failed (${toAnswerPreview(message, 120)})`,
          );
          await remember({
            lookupKind: "search_global",
            found: false,
            query,
            error: toAnswerPreview(message, 180),
          });
        }
      }
    }

    const wantsResolveReference =
      RESOLVE_REFERENCE_LOOKUP_PATTERN.test(input.retrievalQuery) ||
      typeof input.hints.postId === "number" ||
      typeof input.hints.commentId === "number";
    if (wantsResolveReference) {
      const references = new Set<string>();
      if (typeof input.hints.postId === "number") references.add(`post ${input.hints.postId}`);
      if (typeof input.hints.commentId === "number") references.add(`comment ${input.hints.commentId}`);
      for (const handle of parseHandleMentions(input.retrievalQuery).slice(0, 2)) {
        references.add(`@${handle}`);
      }
      if (references.size === 0) {
        const single = extractLookupQueryTerm(input.retrievalQuery);
        if (single) references.add(single);
      }
      for (const reference of Array.from(references).slice(0, 3)) {
        try {
          const response = await lookupCall({
            action: "resolve_reference",
            reference,
          });
          const responseRecord = isRecord(response) ? response : null;
          const type =
            responseRecord && typeof responseRecord.type === "string"
              ? responseRecord.type
              : "unknown";
          const postRecord = responseRecord && isRecord(responseRecord.post)
            ? responseRecord.post
            : null;
          const commentRecord = responseRecord && isRecord(responseRecord.comment)
            ? responseRecord.comment
            : null;
          const userRecord = responseRecord && isRecord(responseRecord.user)
            ? responseRecord.user
            : null;
          const found = postRecord !== null || commentRecord !== null || userRecord !== null;
          if (!found) {
            lines.push(`lookup: reference "${reference}" not found`);
            await remember({
              lookupKind: "resolve_reference",
              found: false,
              reference,
              summary: `reference "${reference}" not found`,
            });
            continue;
          }
          if (type === "post" && postRecord) {
            const summary = summarizePostRecord(postRecord);
            lines.push(`lookup: ref "${reference}" -> ${summary.line}`);
            await remember({
              lookupKind: "resolve_reference",
              found: true,
              reference,
              refType: type,
              postId: summary.postId,
              summary: summary.bodyPreview ?? summary.line,
            });
            continue;
          }
          if (type === "comment" && commentRecord) {
            const summary = summarizeCommentRecord(commentRecord);
            lines.push(`lookup: ref "${reference}" -> ${summary.line}`);
            await remember({
              lookupKind: "resolve_reference",
              found: true,
              reference,
              refType: type,
              postId: summary.postId,
              commentId: summary.commentId,
              summary: summary.bodyPreview ?? summary.line,
            });
            continue;
          }
          if (type === "user" && userRecord) {
            const summary = summarizeUserRecord(userRecord);
            lines.push(`lookup: ref "${reference}" -> ${summary.line}`);
            await remember({
              lookupKind: "resolve_reference",
              found: true,
              reference,
              refType: type,
              handle: summary.handle,
              userId: summary.userId,
              summary: summary.reason ?? summary.line,
            });
            continue;
          }
          lines.push(`lookup: ref "${reference}" resolved as ${type}`);
          await remember({
            lookupKind: "resolve_reference",
            found: true,
            reference,
            refType: type,
            summary: `resolved as ${type}`,
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          lines.push(
            `lookup: resolve "${reference}" failed (${toAnswerPreview(message, 120)})`,
          );
          await remember({
            lookupKind: "resolve_reference",
            found: false,
            reference,
            error: toAnswerPreview(message, 180),
          });
        }
      }
    }

    if (BROWSE_RECENT_ACTIONS_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      const windowHours = parseLookupWindowHours(input.retrievalQuery) ?? 24 * 7;
      try {
        const response = await lookupCall({
          action: "browse_recent_actions",
          windowHours,
          limit: 24,
        });
        const rows =
          isRecord(response) && Array.isArray(response.items)
            ? response.items.filter((entry): entry is Record<string, unknown> =>
                isRecord(entry),
              )
            : [];
        if (rows.length === 0) {
          lines.push(`lookup: no recent actions in last ${windowHours}h`);
          await remember({
            lookupKind: "browse_recent_actions",
            found: false,
            windowHours,
            summary: `no recent actions in last ${windowHours}h`,
          });
        } else {
          for (const row of rows.slice(0, 6)) {
            const eventType =
              typeof row.eventType === "string" ? row.eventType.trim() : "unknown";
            const capability =
              typeof row.capability === "string" ? row.capability.trim() : null;
            const allowed = row.allowed === true;
            const line = [
              `lookup: action:${eventType}`,
              capability ? `capability=${capability}` : "",
              `allowed=${allowed ? "yes" : "no"}`,
              typeof row.createdAt === "string" ? `at=${row.createdAt}` : "",
            ]
              .filter((part) => part.length > 0)
              .join(" · ");
            lines.push(line);
            await remember({
              lookupKind: "browse_recent_actions",
              found: true,
              windowHours,
              eventType,
              capability,
              allowed,
              summary: line,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(
          `lookup: recent actions failed (${toAnswerPreview(message, 120)})`,
        );
        await remember({
          lookupKind: "browse_recent_actions",
          found: false,
          windowHours,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    if (CUSTOM_ASSET_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      const assetQuery = extractCustomAssetSearchQuery(input.retrievalQuery);
      const assetLookupPayload: Record<string, unknown> = {
        action: "find_custom_assets",
        limit: 8,
        includeOwnerSelections: true,
      };
      if (assetQuery) {
        assetLookupPayload.query = assetQuery;
      }
      if (input.entry.conversationId) {
        assetLookupPayload.conversationId = input.entry.conversationId;
      } else if (input.entry.channelId) {
        assetLookupPayload.channelId = input.entry.channelId;
      }
      try {
        const response = await lookupCall(assetLookupPayload);
        const assets = pickCustomAssetRecordsFromLookup(response)
          .map((entry) => summarizeCustomAssetRecord(entry))
          .slice(0, 4);
        if (assets.length === 0) {
          lines.push(
            assetQuery
              ? `lookup: custom assets for "${assetQuery}" not found`
              : "lookup: no preferred custom assets available",
          );
          await remember({
            lookupKind: "custom_asset_search",
            found: false,
            query: assetQuery,
            summary: assetQuery
              ? `custom assets for "${assetQuery}" not found`
              : "no preferred custom assets available",
          });
        } else {
          for (const asset of assets) {
            lines.push(`lookup: ${asset.line}`);
            await remember({
              lookupKind: "custom_asset_search",
              found: true,
              query: assetQuery,
              kind: asset.kind,
              name: asset.name,
              owner: asset.owner,
              source: asset.source,
              url: asset.url,
              summary: asset.line,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(
          `lookup: custom asset fetch failed (${toAnswerPreview(message, 120)})`,
        );
        await remember({
          lookupKind: "custom_asset_search",
          found: false,
          query: assetQuery,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    if (GIF_LOOKUP_PATTERN.test(input.retrievalQuery)) {
      const gifQuery = extractGifSearchQuery(input.retrievalQuery);
      try {
        const response = await lookupCall({
          action: "find_gif",
          ...(gifQuery ? { query: gifQuery } : {}),
          limit: 6,
        });
        const gifs = pickGifRecordsFromLookup(response)
          .slice(0, 3)
          .map((entry) => summarizeGifRecord(entry));
        if (gifs.length === 0) {
          lines.push(
            gifQuery
              ? `lookup: gifs for "${gifQuery}" not found`
              : "lookup: trending gifs unavailable",
          );
          await remember({
            lookupKind: "gif_search",
            found: false,
            query: gifQuery,
            summary: gifQuery
              ? `gifs for "${gifQuery}" not found`
              : "trending gifs unavailable",
          });
        } else {
          for (const gif of gifs) {
            lines.push(`lookup: ${gif.line}`);
            await remember({
              lookupKind: "gif_search",
              found: true,
              query: gifQuery,
              gifId: gif.id,
              gifUrl: gif.url,
              summary: gif.title ?? gif.line,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(`lookup: gif fetch failed (${toAnswerPreview(message, 120)})`);
        await remember({
          lookupKind: "gif_search",
          found: false,
          query: gifQuery,
          error: toAnswerPreview(message, 180),
        });
      }
    }

    return lines.slice(0, 20);
  }
}
