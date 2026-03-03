/** Enrich a generate input payload with runtime context (post/comment details, memory, persona). */

import type { Command } from "../../types/ipc.js";
import type { PersonaReferenceResolution, ContextBundle } from "../types.js";

import { asNonEmptyString, asPositiveInt, truncateText } from "../helpers.js";
import { buildGenerateInput } from "./generate-input-builder.js";
import {
  extractCommentPayloadHint,
  buildCompactEngagementMemorySummary,
  extractPostRecordForCommentCuration,
  extractCommentRecordForCommentCuration,
  summarizePostMediaForComment,
} from "../write/comment-curation.js";

import {
  MAX_MEDIA_REFERENCE_INPUTS,
  REQUIRED_PERSONA_REFERENCE_FRAME_COUNT,
} from "../constants.js";

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

type ChatBridgeFn = (input: unknown) => Promise<unknown>;
type MemoryWithBuildContext = {
  buildContext?: (input: Record<string, unknown>) => Promise<ContextBundle>;
};
type ResolvePersonaFrameRefsFn = (input: {
  payload: Record<string, unknown>;
  command: Command;
  fallbackReferenceInputs: string[];
}) => Promise<PersonaReferenceResolution>;

// ---------------------------------------------------------------------------
// buildGenerateInputWithRuntimeContext
// ---------------------------------------------------------------------------

export async function buildGenerateInputWithRuntimeContext(
  deps: {
    callAgentChatBridge: ChatBridgeFn | null;
    memory: MemoryWithBuildContext;
    resolvePersonaFrameReferences: ResolvePersonaFrameRefsFn;
  },
  payload: Record<string, unknown>,
  command: Command,
): Promise<Record<string, unknown>> {
  const base = buildGenerateInput(payload, command);
  const postId = asPositiveInt(base.postId);
  const commentId = asPositiveInt(base.commentId);
  const payloadHint = extractCommentPayloadHint(payload);
  const contextLines: string[] = [];

  if (postId && deps.callAgentChatBridge) {
    try {
      const postResponse = await deps.callAgentChatBridge({
        action: "find_post",
        postId,
      });
      const postRecord = extractPostRecordForCommentCuration(postResponse, postId);
      if (postRecord) {
        const postText =
          asNonEmptyString(postRecord.textBody) ??
          asNonEmptyString(postRecord.caption) ??
          asNonEmptyString(postRecord.body);
        if (postText) contextLines.push(`targetPostText: ${truncateText(postText, 260)}`);
        const mediaSummary = summarizePostMediaForComment(postRecord);
        if (mediaSummary) contextLines.push(`targetMedia: ${mediaSummary}`);
      }
    } catch {
      // best effort context enrichment only
    }
  }

  if (postId && commentId && deps.callAgentChatBridge) {
    try {
      const commentResponse = await deps.callAgentChatBridge({
        action: "find_comment",
        postId,
        commentId,
      });
      const commentRecord = extractCommentRecordForCommentCuration(commentResponse);
      if (commentRecord) {
        const body =
          asNonEmptyString(commentRecord.body) ??
          asNonEmptyString(commentRecord.textBody);
        if (body) contextLines.push(`targetComment: ${truncateText(body, 220)}`);
      }
    } catch {
      // best effort context enrichment only
    }
  }

  if (typeof deps.memory.buildContext === "function") {
    try {
      const bundle = await deps.memory.buildContext({
        mode: "directive",
        audience: "runtime_generate",
        ...(postId ? { postId } : {}),
        ...(commentId ? { commentId } : {}),
        maxRecentEvents: 120,
        maxArchiveEvents: 40,
        includeViewState: true,
        viewStateMaxItems: 10,
        includeKeywordRetrieval: true,
        retrievalIntent: "directive",
        retrievalMaxItems: 10,
        retrievalQuery: [
          payloadHint ?? "",
          postId ? `post ${postId}` : "",
          commentId ? `comment ${commentId}` : "",
        ]
          .filter((value) => value.length > 0)
          .join(" · "),
      });
      const memorySummary = buildCompactEngagementMemorySummary(bundle);
      if (memorySummary) {
        contextLines.push(`memory: ${truncateText(memorySummary, 900)}`);
      }
    } catch {
      // best effort context enrichment only
    }
  }

  const contextHint = truncateText(
    [
      payloadHint ? `directiveHint: ${payloadHint}` : "",
      ...contextLines,
    ]
      .filter((value) => value.length > 0)
      .join("\n"),
    2200,
  );

  const topic =
    asNonEmptyString(base.topic) ??
    payloadHint ??
    (contextLines.length > 0 ? truncateText(contextLines.join(" | "), 120) : null);

  const fallbackReferenceInputs = Array.isArray(base.mediaReferenceUrls)
    ? base.mediaReferenceUrls
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .slice(0, MAX_MEDIA_REFERENCE_INPUTS)
    : [];
  const personaReferences = await deps.resolvePersonaFrameReferences({
    payload,
    command,
    fallbackReferenceInputs,
  });
  if (
    personaReferences.personaSlug !== null &&
    personaReferences.frameReferences.length < REQUIRED_PERSONA_REFERENCE_FRAME_COUNT
  ) {
    throw new Error(
      `persona_reference_setup_required:${personaReferences.personaSlug}`,
    );
  }
  const mediaReferenceUrls =
    personaReferences.personaSlug !== null
      ? personaReferences.frameReferences
      : fallbackReferenceInputs;

  return {
    ...base,
    ...(topic ? { topic: truncateText(topic, 120) } : {}),
    ...(contextHint.length > 0 ? { contextHint } : {}),
    ...(mediaReferenceUrls.length > 0 ? { mediaReferenceUrls } : {}),
  };
}
