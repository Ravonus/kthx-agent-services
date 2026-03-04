import path from "node:path";

import { isRecord } from "../lib/guards.js";
import type { ContextBundle } from "../types/memory.js";
import type { ChatInboxEntry } from "./chat-reply.js";
import type { ReplyTargetContext } from "./chat-types.js";

export const stripEmDashCharacters = (value: string): string => value.replace(/[—–]/gu, "-");

export const DOC_CONTEXT_RELEVANT_LINE_PATTERN =
  /\b(socket|ws|route|api|action|memory|retriev|directive|chat|dm|channel|post|comment|repost|like|follow|view|gif|image|avatar|banner|retention|profile|draft)\b/iu;
export const DOC_CONTEXT_PRIORITY_HEADING_PATTERN =
  /\b(chat bridge route catalog|update\/write route matrix|runtime capability map)\b/iu;
export const DOC_CONTEXT_PRIORITY_LINE_PATTERN =
  /\b(send_message|edit_message|typing|delivery_confirmed|follow_user|unfollow_user|save_custom_asset|settings_update|updatebotprofile|brain\.)\b/iu;

export const DOC_CONTEXT_PATH_CANDIDATES = [
  path.resolve(process.cwd(), "public", "chat-system.md"),
  path.resolve(process.cwd(), "..", "public", "chat-system.md"),
] as const;

export const buildSystemDocExcerpt = (sourceName: string, raw: string): string => {
  const lines = raw.split(/\r?\n/u);
  const candidates: Array<{
    heading: string;
    line: string;
    priority: boolean;
  }> = [];
  let activeHeading = "";
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed.length || trimmed.startsWith("```")) continue;
    if (/^#{1,6}\s+/u.test(trimmed)) {
      activeHeading = trimmed.replace(/^#{1,6}\s+/u, "").trim();
      continue;
    }
    const isRelevant = DOC_CONTEXT_RELEVANT_LINE_PATTERN.test(trimmed);
    const isStructured =
      /^[-*]\s+/u.test(trimmed) ||
      /^\d+[.)]\s+/u.test(trimmed) ||
      /^(GET|POST|PUT|PATCH|DELETE)\s+/u.test(trimmed) ||
      /^`[^`]+`$/u.test(trimmed);
    if (!isRelevant || (!isStructured && trimmed.length > 140)) continue;
    const line = trimmed.replace(/^`|`$/gu, "");
    const priority =
      DOC_CONTEXT_PRIORITY_HEADING_PATTERN.test(activeHeading) ||
      DOC_CONTEXT_PRIORITY_LINE_PATTERN.test(line);
    candidates.push({
      heading: activeHeading,
      line,
      priority,
    });
  }
  const picked: string[] = [];
  const seen = new Set<string>();
  let lastHeadingWritten = "";
  const appendCandidate = (candidate: { heading: string; line: string }) => {
    const dedupeKey = `${candidate.heading}\u0000${candidate.line}`;
    if (seen.has(dedupeKey)) return;
    if (candidate.heading.length > 0 && candidate.heading !== lastHeadingWritten) {
      picked.push(`section: ${candidate.heading}`);
      lastHeadingWritten = candidate.heading;
    }
    picked.push(candidate.line);
    seen.add(dedupeKey);
  };
  for (const candidate of candidates) {
    if (!candidate.priority) continue;
    appendCandidate(candidate);
    if (picked.length >= 42) break;
  }
  if (picked.length < 42) {
    for (const candidate of candidates) {
      appendCandidate(candidate);
      if (picked.length >= 42) break;
    }
  }
  if (picked.length === 0) return "";
  return [`source: ${sourceName}`, ...picked].join("\n");
};

export const extractSentMessageId = (response: unknown): string | null => {
  if (!isRecord(response)) return null;
  const primary = isRecord(response.primary) ? response.primary : null;
  const message = isRecord(primary?.message) ? primary.message : null;
  if (typeof message?.id === "string" && message.id.trim().length > 0) return message.id.trim();
  if (typeof response.messageId === "string" && response.messageId.trim().length > 0) return response.messageId.trim();
  if (typeof response.id === "string" && response.id.trim().length > 0) return response.id.trim();
  return null;
};

export const parsePostAndCommentHints = (text: string): {
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

export const extractHintFromRecordByKeys = (
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

export const extractPostAndCommentHintsFromRecord = (
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

export const summarizeReplyTargetAttachments = (value: unknown): string | null => {
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

export const mergePostAndCommentHints = (
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

export const buildReplyTargetSummaryLines = (
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

export const VIEW_CONTEXT_PATTERN =
  /\b(view|views|viewed|seen|read|reading|feed|timeline|thread|post|posts|comment|comments|engage|engagement|viral|trending|platform)\b/iu;

export const shouldIncludeViewStateContext = ({
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

export const buildRetrievalQuery = ({
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
