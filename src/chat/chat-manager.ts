/**
 * ChatManager: inbox polling, auto-reply orchestration, and text stream
 * simulation for the agent's chat runtime.
 *
 * Ported from agent-runtime.mjs lines 5815-6267 (send reply, text stream,
 * inbox parsing, poll loop) and portions of 20000+ (entry processing).
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

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
}: {
  entry: ChatInboxEntry;
  conversationHistory: unknown[];
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
  const combined = [entry.body.trim(), historySnippets]
    .filter((line) => line.length > 0)
    .join(" ")
    .trim();
  return combined.slice(0, 700);
};

const ENGAGEMENT_RETRIEVAL_PATTERN =
  /\b(like|likes|comment|comments|reply|replies|repost|reposts|quote|follow|follows|engage|engagement|interact|interaction|views?|impressions?|timeline|feed|trending|viral)\b/iu;

const SITE_LOOKUP_TRIGGER_PATTERN =
  /\b(post|posts|comment|comments|likes?|views?|reposts?|engagement|followers?|following|draft|directive|timeline|feed|recent|latest|newest|last|who viewed|who liked|gif|gifs|meme|reaction)\b/iu;

const LOOKUP_FORCE_PATTERN =
  /\b(not found|never found|can't find|cant find|where (?:is|did)|show me|what happened to|pull it|fetch it)\b/iu;

const LATEST_POST_LOOKUP_PATTERN =
  /\b(most\s+recent|latest|newest|last)\s+post\b/iu;

const COMMENT_LOOKUP_PATTERN = /\bcomments?\b/iu;
const FOLLOW_LOOKUP_PATTERN = /\bfollow(?:er|ers|ing)?\b/iu;
const GIF_LOOKUP_PATTERN = /\b(gif|gifs|meme|reaction)\b/iu;

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

const pickCommentRecordsFromLookup = (
  value: unknown,
): Array<Record<string, unknown>> => {
  if (!isRecord(value)) return [];
  if (isRecord(value.comment)) return [value.comment];
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

  private async fetchConversationHistory(entry: ChatInboxEntry): Promise<unknown[]> {
    try {
      const payload = {
        action: "list_messages",
        ...(entry.conversationId ? { conversationId: entry.conversationId } : { channelId: entry.channelId }),
        limit: 10,
      };
      const result = await this.ctx.callAgentChatBridge(payload);
      if (isRecord(result) && Array.isArray(result.items)) return (result.items as unknown[]).slice(0, 10).reverse();
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
      const hints = parsePostAndCommentHints(entry.body);
      const includeViewState = shouldIncludeViewStateContext({
        entry,
        conversationHistory,
        hints,
      });
      const retrievalQuery = buildRetrievalQuery({
        entry,
        conversationHistory,
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
        "- if memory misses, use live site lookup results below before asking for clarification",
        "- if exact target unclear, ask one concise clarifying question",
        "",
        "## Recent Chat History",
        ...(historyLines.length > 0 ? historyLines : ["(none)"]),
        "",
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
    if (GIF_LOOKUP_PATTERN.test(query)) return true;
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

    return lines.slice(0, 12);
  }
}
