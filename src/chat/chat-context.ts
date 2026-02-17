/**
 * Chat context utilities: extract, resolve, and inherit chat routing context
 * from command payloads, and build structured result messages for write
 * command outcomes (createPost, commentPost, createStory).
 *
 * Ported from agent-runtime.mjs lines 12529-12681.
 *
 * Pure functions module -- no class needed.
 */

import { isRecord } from "../lib/guards.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toFinitePositiveInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;

const clampPublishText = (value: unknown, maxChars: number): string => {
  const text = typeof value === "string" ? value.replaceAll("\r", "").trim() : "";
  if (!text.length) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(12, maxChars - 3))}...`;
};

// ---------------------------------------------------------------------------
// Chat context types
// ---------------------------------------------------------------------------

export interface ChatContext {
  conversationId?: string;
  channelId?: string;
  [key: string]: unknown;
}

export interface ChatTarget {
  conversationId?: string;
  channelId?: string;
  chatContext: ChatContext;
}

export interface ChatResultMessage {
  body: string;
  metadata: {
    automated: boolean;
    sourceContext: string;
    actionPreview: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Extract chat context from a payload
// ---------------------------------------------------------------------------

export const extractChatContextFromPayload = (
  value: unknown,
): ChatContext | null => {
  const payload = isRecord(value) ? value : null;
  if (!payload) return null;
  const nestedContext = isRecord(payload.context) ? payload.context : null;
  const chatContext = isRecord(payload.chatContext)
    ? payload.chatContext
    : isRecord(nestedContext?.chatContext)
      ? nestedContext.chatContext
      : null;
  if (!chatContext) return null;
  return { ...chatContext } as ChatContext;
};

// ---------------------------------------------------------------------------
// Resolve conversation/channel target from payload
// ---------------------------------------------------------------------------

export const resolveChatTargetFromPayload = (
  value: unknown,
): ChatTarget | null => {
  const chatContext = extractChatContextFromPayload(value);
  if (!chatContext) return null;
  const conversationId =
    typeof chatContext.conversationId === "string" &&
    chatContext.conversationId.trim().length > 0
      ? chatContext.conversationId.trim()
      : "";
  const channelId =
    typeof chatContext.channelId === "string" &&
    chatContext.channelId.trim().length > 0
      ? chatContext.channelId.trim()
      : "";
  if (!conversationId.length && !channelId.length) return null;
  const target = conversationId.length > 0
    ? { conversationId }
    : { channelId };
  return { ...target, chatContext };
};

// ---------------------------------------------------------------------------
// Inherit chat context into a payload
// ---------------------------------------------------------------------------

export const inheritChatContextIntoPayload = ({
  payload,
  sourcePayload,
}: {
  payload: unknown;
  sourcePayload: unknown;
}): unknown => {
  if (!isRecord(payload)) return payload ?? null;
  if (isRecord(payload.chatContext)) return payload;
  const inherited = extractChatContextFromPayload(sourcePayload);
  if (!inherited) return payload;
  return { ...payload, chatContext: inherited };
};

// ---------------------------------------------------------------------------
// Build chat result message from write command outcome
// ---------------------------------------------------------------------------

export const buildChatResultMessageFromOutcome = ({
  command,
  outcome,
}: {
  command: Record<string, unknown> | null;
  outcome: Record<string, unknown> | null;
}): ChatResultMessage | null => {
  const kind =
    typeof command?.kind === "string" ? command.kind.trim() : "";
  const ok = Boolean(outcome?.ok);
  const errorMessage =
    !ok && isRecord(outcome?.error) && typeof (outcome!.error as Record<string, unknown>).message === "string"
      ? ((outcome!.error as Record<string, unknown>).message as string).trim()
      : !ok
        ? "request failed"
        : "";

  if (kind === "write.createPost") {
    const data = isRecord(outcome?.data) ? outcome!.data as Record<string, unknown> : null;
    const post = isRecord(data?.post) ? data!.post as Record<string, unknown> : data;
    const postId = toFinitePositiveInt(post?.id);
    const caption =
      typeof post?.caption === "string" && (post.caption as string).trim().length > 0
        ? clampPublishText(post.caption, 200)
        : "";
    const textBody =
      typeof post?.textBody === "string" && (post.textBody as string).trim().length > 0
        ? clampPublishText(post.textBody, 200)
        : "";
    const previewText = caption || textBody || "";
    if (ok && postId) {
      return {
        body: "Done. I posted it.",
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: {
            type: "post",
            status: "success",
            title: "Post published",
            summary: previewText,
            href: `/post/${postId}`,
            hrefLabel: "Open post",
            postId,
          },
        },
      };
    }
    return {
      body: `I couldn't complete that post request${errorMessage ? `: ${errorMessage}` : "."}`,
      metadata: {
        automated: true,
        sourceContext: "CHAT",
        actionPreview: {
          type: "post",
          status: "failed",
          title: "Post failed",
          error: errorMessage || null,
        },
      },
    };
  }

  if (kind === "write.commentPost") {
    const data = isRecord(outcome?.data) ? outcome!.data as Record<string, unknown> : null;
    const comment = isRecord(data?.comment) ? data!.comment as Record<string, unknown> : data;
    const commentId = toFinitePositiveInt(comment?.id);
    const postId = toFinitePositiveInt(comment?.postId);
    const bodyPreview =
      typeof comment?.body === "string" && (comment.body as string).trim().length > 0
        ? clampPublishText(comment.body, 200)
        : "";
    if (ok && commentId && postId) {
      return {
        body: "Done. I posted the reply.",
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: {
            type: "comment",
            status: "success",
            title: "Reply posted",
            summary: bodyPreview,
            href: `/post/${postId}#comment-${commentId}`,
            hrefLabel: "Open reply",
            postId,
            commentId,
          },
        },
      };
    }
    return {
      body: `I couldn't complete that reply${errorMessage ? `: ${errorMessage}` : "."}`,
      metadata: {
        automated: true,
        sourceContext: "CHAT",
        actionPreview: {
          type: "comment",
          status: "failed",
          title: "Reply failed",
          error: errorMessage || null,
        },
      },
    };
  }

  if (kind === "write.createStory") {
    const data = isRecord(outcome?.data) ? outcome!.data as Record<string, unknown> : null;
    const story = isRecord(data?.story) ? data!.story as Record<string, unknown> : data;
    const storyId = toFinitePositiveInt(story?.id);
    if (ok && storyId) {
      return {
        body: "Done. Story posted.",
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: {
            type: "story",
            status: "success",
            title: "Story published",
            summary: null,
            storyId,
          },
        },
      };
    }
    return {
      body: `I couldn't complete that story request${errorMessage ? `: ${errorMessage}` : "."}`,
      metadata: {
        automated: true,
        sourceContext: "CHAT",
        actionPreview: {
          type: "story",
          status: "failed",
          title: "Story failed",
          error: errorMessage || null,
        },
      },
    };
  }

  return null;
};

// ---------------------------------------------------------------------------
// Exports for use by runtime command execution
// ---------------------------------------------------------------------------

export { clampPublishText };
