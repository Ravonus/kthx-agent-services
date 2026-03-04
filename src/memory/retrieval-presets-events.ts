import type { RetrievalPresetEvent } from "./retrieval-presets.js";

type LatestEventDoc = {
  doc: {
    sourceType: string | null;
    postId: number | null;
    commentId: number | null;
    receivedAt: string;
    actor: string | null;
    summary: string;
  };
};

export const collectLatestEvents = (
  docs: LatestEventDoc[],
  sourceType: string,
  limit: number,
  scopePostId: number | null,
  scopeCommentId: number | null,
): RetrievalPresetEvent[] => {
  const maxItems = Math.max(1, Math.min(10, Math.floor(limit)));
  return docs
    .filter((entry) => entry.doc.sourceType === sourceType)
    .filter((entry) => {
      if (typeof scopePostId === "number") return entry.doc.postId === scopePostId;
      if (typeof scopeCommentId === "number") {
        return entry.doc.commentId === scopeCommentId;
      }
      return true;
    })
    .slice(0, maxItems)
    .map((entry) => ({
      receivedAt: entry.doc.receivedAt,
      postId: entry.doc.postId,
      commentId: entry.doc.commentId,
      actor: entry.doc.actor,
      summary: entry.doc.summary,
    }));
};
