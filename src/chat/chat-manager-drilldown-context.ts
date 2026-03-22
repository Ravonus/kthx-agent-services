import { isRecord } from "../lib/guards.js";
import { toAnswerPreview } from "../lib/text.js";
import type { ChatInboxEntry } from "./chat-reply.js";
import type {
  ChatManagerContext,
  LinkedOwnerIdentity,
  ReplyTargetContext,
} from "./chat-types.js";
import {
  buildReplyTargetSummaryLines,
  buildRetrievalQuery,
  mergePostAndCommentHints,
  parsePostAndCommentHints,
  shouldIncludeViewStateContext,
} from "./chat-manager-context-utils.js";
import { buildDrilldownMemorySummary } from "./chat-manager-drilldown-summary.js";
import type { LiveSiteLookupInput } from "./chat-manager-live-site-lookup.js";
import { resolveRetrievalIntentForEntry } from "./chat-manager-lookup-utils.js";

export type LoadDrilldownContextDeps = {
  buildContext: ChatManagerContext["memory"]["buildContext"];
  openClawInputMaxChars: number;
  resolveReplyTargetContext: (
    entry: ChatInboxEntry,
    conversationHistory: unknown[],
  ) => ReplyTargetContext | null;
  loadLiveSiteLookup: (input: LiveSiteLookupInput) => Promise<string[]>;
  loadSystemDocContext: () => Promise<string | null>;
  loadLinkedOwnerIdentity: () => Promise<LinkedOwnerIdentity | null>;
};

export const loadDrilldownContext = async (
  deps: LoadDrilldownContextDeps,
  entry: ChatInboxEntry,
  conversationHistory: unknown[],
): Promise<string | null> => {
  if (typeof deps.buildContext !== "function") return null;
  try {
    const messageHints = parsePostAndCommentHints(entry.body);
    const replyTargetContext = deps.resolveReplyTargetContext(
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
    // Start independent loads in parallel with buildContext to reduce
    // wall-clock time. systemDocContext and linkedOwnerIdentity have no
    // dependency on the memory bundle.
    const [bundle, systemDocContext, linkedOwnerIdentity] = await Promise.all([
      deps.buildContext({
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
      }),
      deps.loadSystemDocContext(),
      deps.loadLinkedOwnerIdentity(),
    ]);
    const summary = buildDrilldownMemorySummary(bundle);
    // Live site lookup depends on bundle, so it runs after buildContext.
    const liveLookupLines = await deps.loadLiveSiteLookup({
      entry,
      retrievalQuery,
      hints,
      bundle,
    });
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
      "- respond_to_request / accept_request / decline_request: resolve pending DM requests before replying when needed",
      "- find_post / find_comment / find_user / find_gif / find_custom_assets / browse_assets / suggest_followers / browse_posts / browse_comments / browse_agents / browse_notifications / browse_home_feed / browse_trending / browse_post_activity / browse_comment_activity / browse_top_engagers / browse_unanswered_mentions / browse_drafts / browse_directive_queue / browse_servers / browse_channels / browse_members / browse_lenses / search_global / resolve_reference / browse_recent_actions: live site lookups",
      "- send_message / edit_message / typing: conversational response + status updates",
      "- follow_user / unfollow_user / update_profile / update_settings / save_custom_asset: direct bridge write actions (restricted to agent or linked owner targets)",
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
      Math.min(9000, deps.openClawInputMaxChars),
    );
    return combined.slice(0, maxChars);
  } catch {
    return null;
  }
};
