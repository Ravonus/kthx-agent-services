import { isRecord } from "../lib/guards.js";
import { toAnswerPreview } from "../lib/text.js";
import {
  extractPostAndCommentHintsFromRecord,
  parsePostAndCommentHints,
  summarizeReplyTargetAttachments,
} from "./chat-manager-context-utils.js";
import type { ChatInboxEntry } from "./chat-reply.js";
import type { ReplyTargetContext } from "./chat-types.js";

export const resolveReplyTargetContext = (
  entry: ChatInboxEntry,
  conversationHistory: unknown[],
): ReplyTargetContext | null => {
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
    author &&
    typeof author.displayCache === "string" &&
    author.displayCache.trim().length > 0
      ? author.displayCache.trim()
      : null;
  const authorHandleRaw =
    author &&
    typeof author.handleCache === "string" &&
    author.handleCache.trim().length > 0
      ? author.handleCache.trim()
      : "";
  const authorHandle = authorHandleRaw.replace(/^@+/u, "");
  const attachmentSummary = summarizeReplyTargetAttachments(matched.attachments);

  const bodyHints = body.length > 0 ? parsePostAndCommentHints(body) : {};
  const messageHints = message
    ? extractPostAndCommentHintsFromRecord(message)
    : { postId: null, commentId: null };
  const metadataHints =
    message && isRecord(message.metadata)
      ? extractPostAndCommentHintsFromRecord(message.metadata)
      : { postId: null, commentId: null };
  const hintPostId =
    bodyHints.postId ?? messageHints.postId ?? metadataHints.postId ?? null;
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
};
