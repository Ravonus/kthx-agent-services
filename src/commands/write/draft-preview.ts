/** Draft preview payload composition for user review. */

import type { GeneratedDraft, DraftPreviewPayload } from "../types.js";

import {
  asNonEmptyString,
  stripEmDashCharacters,
} from "../helpers.js";

import { clampPublishText } from "../../chat/chat-context.js";

import { isRecord } from "../../lib/guards.js";

// ---------------------------------------------------------------------------
// buildDraftPreviewPayload
// ---------------------------------------------------------------------------

export function buildDraftPreviewPayload(drafts: GeneratedDraft[]): DraftPreviewPayload | null {
  const previewParts: string[] = [];
  let firstPostKind: "post" | "thread" = "post";
  let mode: "thread" | "carousel" = "thread";
  let slideCount = 1;

  const resolveMediaUrlFromDraft = (draftPayload: Record<string, unknown>): string | null => {
    const direct = asNonEmptyString(draftPayload.mediaUrl);
    if (direct) return direct;
    const mediaItems = Array.isArray(draftPayload.mediaItems) ? draftPayload.mediaItems : [];
    for (const item of mediaItems) {
      if (!isRecord(item)) continue;
      const itemUrl = asNonEmptyString(item.mediaUrl) ?? asNonEmptyString(item.url);
      if (itemUrl) return itemUrl;
    }
    return null;
  };

  const resolveMediaItemCount = (draftPayload: Record<string, unknown>): number => {
    const mediaItems = Array.isArray(draftPayload.mediaItems) ? draftPayload.mediaItems : [];
    return mediaItems.filter((entry) => isRecord(entry)).length;
  };

  const addPreviewPart = (value: string | null): void => {
    if (!value) return;
    const normalized = stripEmDashCharacters(value).trim();
    if (!normalized.length) return;
    previewParts.push(normalized);
  };

  for (const draft of drafts.slice(0, 5)) {
    const action = draft.action.trim().toLowerCase();
    if (action === "post") {
      const postType = asNonEmptyString(draft.payload.postType)?.toLowerCase();
      const textBody =
        asNonEmptyString(draft.payload.textBody) ??
        asNonEmptyString(draft.payload.body) ??
        asNonEmptyString(draft.payload.text);
      const caption =
        asNonEmptyString(draft.payload.caption) ??
        asNonEmptyString(draft.payload.title);
      const imagePrompt =
        asNonEmptyString(draft.payload.imagePrompt) ??
        asNonEmptyString(draft.payload.mediaPrompt) ??
        asNonEmptyString(draft.payload.prompt);
      const mediaUrl = resolveMediaUrlFromDraft(draft.payload);
      const mediaItemCount = resolveMediaItemCount(draft.payload);
      if (postType === "text" && textBody) {
        addPreviewPart(textBody);
        firstPostKind = "post";
        continue;
      }

      if (textBody || caption || imagePrompt || mediaUrl) {
        const composed = [textBody, caption, imagePrompt ? `Image prompt: ${imagePrompt}` : null]
          .filter((entry): entry is string => Boolean(entry))
          .join("\n");
        addPreviewPart(
          composed.length > 0
            ? composed
            : mediaUrl
              ? "Post draft with attached media is ready for review."
              : "Post draft is ready for review.",
        );
        firstPostKind = "post";
        if (postType === "media" || imagePrompt || mediaUrl || mediaItemCount > 0) {
          mode = "carousel";
          slideCount = Math.max(slideCount, mediaItemCount > 1 ? mediaItemCount : 2);
        }
        continue;
      }
    }
    if (action === "story") {
      const caption = asNonEmptyString(draft.payload.caption);
      const imagePrompt =
        asNonEmptyString(draft.payload.imagePrompt) ??
        asNonEmptyString(draft.payload.mediaPrompt) ??
        asNonEmptyString(draft.payload.prompt);
      const mediaUrl = resolveMediaUrlFromDraft(draft.payload);
      const composed = [caption, imagePrompt ? `Image prompt: ${imagePrompt}` : null]
        .filter((entry): entry is string => Boolean(entry))
        .join("\n");
      addPreviewPart(
        composed.length > 0
          ? composed
          : mediaUrl
            ? "Story draft with media is ready for review."
            : "Story draft is ready for review.",
      );
      firstPostKind = "post";
      if (imagePrompt || mediaUrl) {
        mode = "carousel";
        slideCount = Math.max(slideCount, 2);
      }
      continue;
    }
    if (action === "comment") {
      const body =
        asNonEmptyString(draft.payload.body) ??
        asNonEmptyString(draft.payload.text) ??
        asNonEmptyString(draft.payload.caption);
      addPreviewPart(body ?? "Comment draft is ready for review.");
      firstPostKind = "thread";
      continue;
    }
    if (action === "like") {
      const reason = asNonEmptyString(draft.payload.reason);
      addPreviewPart(reason ? `Like draft: ${reason}` : "Like action draft is ready.");
    }
  }

  if (previewParts.length === 0) {
    const actionSummary = drafts
      .slice(0, 3)
      .map((entry) => entry.action.trim().toLowerCase())
      .filter((entry) => entry.length > 0)
      .join(", ");
    if (!actionSummary.length) return null;
    previewParts.push(`Draft ready for review (${actionSummary}).`);
  }
  const draftPreviewText = previewParts.join("\n\n").slice(0, 2500);
  const summary = clampPublishText(draftPreviewText, 220);
  return {
    body: `Draft ready for review:\n\n${draftPreviewText}`,
    summary,
    draftPreviewText,
    draftPostKind: firstPostKind,
    draftMode: mode,
    draftSlideCount: slideCount,
  };
}
