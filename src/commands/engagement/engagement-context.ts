/** Engagement context loaders — memory summaries, bridge lookups, and author resolution. */

import type { ContextBundle, ContextRequest } from "../../types/memory.js";
import type {
  PostDraftContext,
  CommentCurationContext,
  EngagementDecisionContext,
} from "../types.js";

import {
  asNonEmptyString,
  asPositiveInt,
  truncateText,
  normalizeCommentText,
} from "../helpers.js";

import {
  buildEngagementRetrievalQuery,
  buildCompactEngagementMemorySummary,
  extractPostRecordForCommentCuration,
  extractCommentRecordForCommentCuration,
  extractCommentPayloadHint,
  summarizePostMediaForComment,
  summarizeCommentsForPostDraft,
} from "../write/comment-curation.js";

import {
  extractPostDiscoverySignalFromRecord,
} from "../write/post-draft-curation.js";

import {
  extractEngagementLookupHints,
} from "../follow/follow-actions.js";

import {
  collectBridgeRecordItems,
} from "../generate/generate-input.js";

import {
  callAgentBridgeLookupCached,
} from "../cache/cache.js";

import {
  computePostSnapshotHash,
} from "./engagement-helpers.js";

import {
  POST_DISCOVERY_SIGNAL_MAX_LINES,
  POST_DISCOVERY_SIGNAL_MAX_LENGTH,
} from "../constants.js";

import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

type MemoryWithContext = {
  buildContext?: (request: ContextRequest) => Promise<ContextBundle>;
  recordWrite(entry: unknown): Promise<void>;
};
type ChatBridgeFn = (input: unknown) => Promise<unknown>;
type BridgeLookupCache = Map<string, { expiresAtMs: number; value: unknown }>;

// ---------------------------------------------------------------------------
// loadEngagementMemorySummary
// ---------------------------------------------------------------------------

export async function loadEngagementMemorySummary(
  deps: { memory: MemoryWithContext },
  input: {
    action: "comment" | "like" | "repost";
    postId: number;
    commentId: number | null;
    payload: Record<string, unknown>;
  },
): Promise<string | null> {
  if (typeof deps.memory.buildContext !== "function") {
    return null;
  }
  try {
    const request: ContextRequest = {
      mode: "engagement",
      audience: "runtime_write",
      postId: input.postId,
      ...(typeof input.commentId === "number" ? { commentId: input.commentId } : {}),
      maxRecentEvents: 120,
      maxArchiveEvents: 40,
      includeViewState: true,
      viewStateMaxItems: 10,
      includeKeywordRetrieval: true,
      retrievalIntent: "engagement",
      retrievalMaxItems: 10,
      retrievalQuery: buildEngagementRetrievalQuery(input),
    };
    const bundle = await deps.memory.buildContext(request);
    return buildCompactEngagementMemorySummary(bundle);
  } catch (error: unknown) {
    await deps.memory
      .recordWrite({
        type: "engagement_memory_context_failed",
        at: nowIso(),
        action: input.action,
        postId: input.postId,
        commentId: input.commentId,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    return null;
  }
}

// ---------------------------------------------------------------------------
// resolvePostSnapshotHashForPostId
// ---------------------------------------------------------------------------

export async function resolvePostSnapshotHashForPostId(
  deps: { callAgentChatBridge: ChatBridgeFn | null; bridgeLookupCache: BridgeLookupCache },
  input: {
    postId: number;
    commentId: number | null;
  },
): Promise<string | null> {
  if (!deps.callAgentChatBridge) return null;
  try {
    const lookup = await callAgentBridgeLookupCached(
      deps.bridgeLookupCache,
      deps.callAgentChatBridge,
      {
        action: "find_post",
        postId: input.postId,
      },
    );
    const postRecord = extractPostRecordForCommentCuration(lookup.value, input.postId);
    if (!postRecord) return null;
    return computePostSnapshotHash({
      postId: input.postId,
      commentId: input.commentId,
      postRecord,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// resolveCommentAuthorIdForTarget
// ---------------------------------------------------------------------------

export async function resolveCommentAuthorIdForTarget(
  deps: { callAgentChatBridge: ChatBridgeFn | null; bridgeLookupCache: BridgeLookupCache },
  input: {
    postId: number;
    commentId: number;
  },
): Promise<string | null> {
  if (!deps.callAgentChatBridge) return null;
  try {
    const lookup = await callAgentBridgeLookupCached(
      deps.bridgeLookupCache,
      deps.callAgentChatBridge,
      {
        action: "find_comment",
        postId: input.postId,
        commentId: input.commentId,
      },
    );
    const record = extractCommentRecordForCommentCuration(lookup.value);
    if (record) {
      const author = isRecord(record.author) ? record.author : null;
      const authorId =
        asNonEmptyString(record.authorId) ??
        asNonEmptyString(author?.mainUserId) ??
        asNonEmptyString(author?.id) ??
        null;
      if (authorId) return authorId;
    }
  } catch {
    // best effort only
  }
  try {
    const lookup = await callAgentBridgeLookupCached(
      deps.bridgeLookupCache,
      deps.callAgentChatBridge,
      {
        action: "browse_comments",
        postId: input.postId,
        limit: 40,
      },
    );
    for (const item of collectBridgeRecordItems(lookup.value)) {
      const entryCommentId =
        asPositiveInt(item.commentId) ??
        asPositiveInt(item.id);
      if (!entryCommentId || entryCommentId !== input.commentId) continue;
      const author = isRecord(item.author) ? item.author : null;
      const authorId =
        asNonEmptyString(item.authorId) ??
        asNonEmptyString(author?.mainUserId) ??
        asNonEmptyString(author?.id) ??
        null;
      if (authorId) return authorId;
    }
  } catch {
    // best effort only
  }
  return null;
}

// ---------------------------------------------------------------------------
// loadPostDraftDiscoverySignals
// ---------------------------------------------------------------------------

export async function loadPostDraftDiscoverySignals(
  deps: {
    callAgentChatBridge: ChatBridgeFn | null;
    memory: MemoryWithContext;
    bridgeLookupCache: BridgeLookupCache;
  },
  input: {
    postId: number | null;
    payload: Record<string, unknown>;
  },
): Promise<string | null> {
  if (!deps.callAgentChatBridge) return null;
  const hints = extractEngagementLookupHints(input.payload);
  const lookupPlans: Array<{ source: string; request: Record<string, unknown> }> = [
    {
      source: "trending",
      request: {
        action: "browse_trending",
        limit: 12,
      },
    },
    {
      source: "home",
      request: {
        action: "browse_home_feed",
        limit: 12,
      },
    },
    {
      source: "posts",
      request: {
        action: "browse_posts",
        limit: 12,
      },
    },
  ];
  if (hints.interestTags.length > 0) {
    lookupPlans.push({
      source: "interest",
      request: {
        action: "browse_posts",
        limit: 12,
        tags: hints.interestTags.slice(0, 4),
      },
    });
  }
  if (hints.rawQuery.trim().length > 0) {
    lookupPlans.push({
      source: "search",
      request: {
        action: "search_global",
        limit: 8,
        query: truncateText(hints.rawQuery, 96),
      },
    });
  }
  for (const handle of hints.handles.slice(0, 2)) {
    lookupPlans.push({
      source: "handle",
      request: {
        action: "find_post",
        authorHandle: handle,
        latest: true,
        limit: 1,
      },
    });
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const plan of lookupPlans) {
    if (lines.length >= POST_DISCOVERY_SIGNAL_MAX_LINES) break;
    try {
      const lookup = await callAgentBridgeLookupCached(
        deps.bridgeLookupCache,
        deps.callAgentChatBridge,
        plan.request,
      );
      for (const item of collectBridgeRecordItems(lookup.value)) {
        if (lines.length >= POST_DISCOVERY_SIGNAL_MAX_LINES) break;
        const signal = extractPostDiscoverySignalFromRecord(item);
        if (!signal) continue;
        const line = `${plan.source}: ${signal}`;
        const key = normalizeCommentText(line);
        if (!key.length || seen.has(key)) continue;
        seen.add(key);
        lines.push(truncateText(line, 180));
      }
    } catch (error: unknown) {
      await deps.memory
        .recordWrite({
          type: "post_discovery_lookup_failed",
          at: nowIso(),
          postId: input.postId,
          source: plan.source,
          lookupAction: asNonEmptyString(plan.request.action) ?? "unknown",
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
    }
  }
  if (lines.length === 0) return null;
  return truncateText(lines.join(" | "), POST_DISCOVERY_SIGNAL_MAX_LENGTH);
}

// ---------------------------------------------------------------------------
// loadPostDraftMemorySummary
// ---------------------------------------------------------------------------

export async function loadPostDraftContext(
  deps: {
    callAgentChatBridge: ChatBridgeFn | null;
    memory: MemoryWithContext;
    bridgeLookupCache: BridgeLookupCache;
  },
  input: {
    postId: number | null;
    payload: Record<string, unknown>;
  },
): Promise<PostDraftContext> {
  const payloadContext =
    input.payload.context != null && typeof input.payload.context === "object"
      ? (input.payload.context as Record<string, unknown>)
      : null;
  const personaDescription =
    asNonEmptyString(input.payload.personaDescription) ??
    asNonEmptyString(payloadContext?.personaDescription) ??
    asNonEmptyString(input.payload.description) ??
    null;
  const personaStyleHint =
    asNonEmptyString(input.payload.personaStyleHint) ??
    asNonEmptyString(input.payload.mediaPersonaStyleHint) ??
    asNonEmptyString(payloadContext?.personaStyleHint) ??
    asNonEmptyString(payloadContext?.mediaPersonaStyleHint) ??
    null;
  const context: PostDraftContext = {
    targetPostId: input.postId,
    postText: null,
    mediaSummary: null,
    commentSummary: null,
    payloadHint: extractCommentPayloadHint(input.payload),
    memorySummary: await loadPostDraftMemorySummary(
      deps,
      input,
      extractCommentPayloadHint,
    ),
    platformSignals: await loadPostDraftDiscoverySignals(deps, input),
    personaDescription,
    personaStyleHint,
  };
  if (!input.postId) return context;
  const callAgentChatBridge = deps.callAgentChatBridge;
  if (!callAgentChatBridge) return context;
  try {
    const postResponse = await callAgentChatBridge({
      action: "find_post",
      postId: input.postId,
    });
    const postRecord = extractPostRecordForCommentCuration(postResponse, input.postId);
    if (!postRecord) return context;
    context.postText =
      asNonEmptyString(postRecord.textBody) ??
      asNonEmptyString(postRecord.caption) ??
      asNonEmptyString(postRecord.body);
    context.mediaSummary = summarizePostMediaForComment(postRecord);
    try {
      const commentResponse = await callAgentChatBridge({
        action: "find_comment",
        postId: input.postId,
      });
      context.commentSummary = summarizeCommentsForPostDraft(commentResponse);
    } catch (error: unknown) {
      await deps.memory
        .recordWrite({
          type: "post_context_comments_lookup_failed",
          at: nowIso(),
          postId: input.postId,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
    }
    return context;
  } catch (error: unknown) {
    await deps.memory
      .recordWrite({
        type: "post_context_lookup_failed",
        at: nowIso(),
        postId: input.postId,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    return context;
  }
}

// ---------------------------------------------------------------------------
// loadCommentCurationContext
// ---------------------------------------------------------------------------

export async function loadCommentCurationContext(
  deps: {
    callAgentChatBridge: ChatBridgeFn | null;
    memory: MemoryWithContext;
  },
  input: {
    postId: number;
    parentId: number | null;
    payload: Record<string, unknown>;
  },
): Promise<CommentCurationContext> {
  const context: CommentCurationContext = {
    postAuthorHandle: null,
    postText: null,
    mediaSummary: null,
    threadSummary: null,
    payloadHint: extractCommentPayloadHint(input.payload),
    memorySummary: await loadEngagementMemorySummary(deps, {
      action: "comment",
      postId: input.postId,
      commentId: input.parentId,
      payload: input.payload,
    }),
  };
  const callAgentChatBridge = deps.callAgentChatBridge;
  if (!callAgentChatBridge) return context;
  try {
    const postResponse = await callAgentChatBridge({
      action: "find_post",
      postId: input.postId,
    });
    const postRecord = extractPostRecordForCommentCuration(postResponse, input.postId);
    if (postRecord) {
      const author = isRecord(postRecord.author) ? postRecord.author : null;
      context.postAuthorHandle =
        asNonEmptyString(author?.handle) ??
        asNonEmptyString(postRecord.authorHandle);
      context.postText =
        asNonEmptyString(postRecord.textBody) ??
        asNonEmptyString(postRecord.caption) ??
        asNonEmptyString(postRecord.body);
      context.mediaSummary = summarizePostMediaForComment(postRecord);
    }
  } catch (error: unknown) {
    await deps.memory
      .recordWrite({
        type: "comment_curation_post_lookup_failed",
        at: nowIso(),
        postId: input.postId,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
  }
  if (input.parentId) {
    try {
      const commentResponse = await callAgentChatBridge({
        action: "find_comment",
        postId: input.postId,
        commentId: input.parentId,
      });
      const commentRecord = extractCommentRecordForCommentCuration(commentResponse);
      if (commentRecord) {
        const commentAuthor = isRecord(commentRecord.author)
          ? commentRecord.author
          : null;
        const commentAuthorHandle =
          asNonEmptyString(commentAuthor?.handle) ??
          asNonEmptyString(commentRecord.authorHandle) ??
          "user";
        const commentBody =
          asNonEmptyString(commentRecord.body) ??
          asNonEmptyString(commentRecord.textBody);
        if (commentBody) {
          context.threadSummary = truncateText(
            `Reply target @${commentAuthorHandle}: ${commentBody}`,
            220,
          );
        }
      }
    } catch (error: unknown) {
      await deps.memory
        .recordWrite({
          type: "comment_curation_parent_lookup_failed",
          at: nowIso(),
          postId: input.postId,
          parentId: input.parentId,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
    }
  }
  return context;
}

// ---------------------------------------------------------------------------
// loadEngagementDecisionContext
// ---------------------------------------------------------------------------

export async function loadEngagementDecisionContext(
  deps: {
    callAgentChatBridge: ChatBridgeFn | null;
    memory: MemoryWithContext;
  },
  input: {
    action: "like" | "repost";
    postId: number;
    payload: Record<string, unknown>;
  },
): Promise<EngagementDecisionContext> {
  const context: EngagementDecisionContext = {
    postAuthorHandle: null,
    postText: null,
    mediaSummary: null,
    payloadHint: extractCommentPayloadHint(input.payload),
    memorySummary: await loadEngagementMemorySummary(deps, {
      action: input.action,
      postId: input.postId,
      commentId: null,
      payload: input.payload,
    }),
  };
  const callAgentChatBridge = deps.callAgentChatBridge;
  if (!callAgentChatBridge) return context;
  try {
    const postResponse = await callAgentChatBridge({
      action: "find_post",
      postId: input.postId,
    });
    const postRecord = extractPostRecordForCommentCuration(postResponse, input.postId);
    if (!postRecord) return context;
    const author = isRecord(postRecord.author) ? postRecord.author : null;
    context.postAuthorHandle =
      asNonEmptyString(author?.handle) ??
      asNonEmptyString(postRecord.authorHandle);
    context.postText =
      asNonEmptyString(postRecord.textBody) ??
      asNonEmptyString(postRecord.caption) ??
      asNonEmptyString(postRecord.body);
    context.mediaSummary = summarizePostMediaForComment(postRecord);
    return context;
  } catch (error: unknown) {
    await deps.memory
      .recordWrite({
        type: "engagement_post_lookup_failed",
        at: nowIso(),
        action: input.action,
        postId: input.postId,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    return context;
  }
}

// ---------------------------------------------------------------------------
// loadPostDraftMemorySummary
// ---------------------------------------------------------------------------

export async function loadPostDraftMemorySummary(
  deps: { memory: MemoryWithContext },
  input: {
    postId: number | null;
    payload: Record<string, unknown>;
  },
  extractCommentPayloadHintFn: (payload: Record<string, unknown>) => string | null = extractCommentPayloadHint,
): Promise<string | null> {
  if (typeof deps.memory.buildContext !== "function") {
    return null;
  }
  try {
    const payloadHint = extractCommentPayloadHintFn(input.payload);
    const retrievalQuery = [
      "post draft context",
      "latest post",
      "recent comments, likes, and views",
      "most engaged posts",
      typeof input.postId === "number" ? `post ${input.postId}` : "",
      payloadHint ? `hint ${payloadHint}` : "",
    ]
      .filter((value) => value.length > 0)
      .join(" · ");
    const request: ContextRequest = {
      mode: "directive",
      audience: "runtime_write",
      ...(typeof input.postId === "number" ? { postId: input.postId } : {}),
      maxRecentEvents: 120,
      maxArchiveEvents: 40,
      includeViewState: true,
      viewStateMaxItems: 10,
      includeKeywordRetrieval: true,
      retrievalIntent: "directive",
      retrievalMaxItems: 10,
      retrievalQuery,
    };
    const bundle = await deps.memory.buildContext(request);
    return buildCompactEngagementMemorySummary(bundle);
  } catch (error: unknown) {
    await deps.memory
      .recordWrite({
        type: "post_memory_context_failed",
        at: nowIso(),
        postId: input.postId,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    return null;
  }
}
