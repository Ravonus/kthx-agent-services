import { isRecord } from "../lib/guards.js";
import { nowIso, toAnswerPreview } from "../lib/text.js";
import {
  BROWSE_AGENT_LOOKUP_PATTERN,
  BROWSE_ASSETS_LOOKUP_PATTERN,
  BROWSE_CHANNELS_LOOKUP_PATTERN,
  BROWSE_COMMENT_ACTIVITY_LOOKUP_PATTERN,
  BROWSE_COMMENT_LOOKUP_PATTERN,
  BROWSE_DIRECTIVE_QUEUE_LOOKUP_PATTERN,
  BROWSE_DRAFTS_LOOKUP_PATTERN,
  BROWSE_HOME_FEED_LOOKUP_PATTERN,
  BROWSE_LENSES_LOOKUP_PATTERN,
  BROWSE_MEMBERS_LOOKUP_PATTERN,
  BROWSE_NOTIFICATIONS_LOOKUP_PATTERN,
  BROWSE_POST_ACTIVITY_LOOKUP_PATTERN,
  BROWSE_POST_LOOKUP_PATTERN,
  BROWSE_RECENT_ACTIONS_LOOKUP_PATTERN,
  BROWSE_SERVERS_LOOKUP_PATTERN,
  BROWSE_TOP_ENGAGERS_LOOKUP_PATTERN,
  BROWSE_TRENDING_LOOKUP_PATTERN,
  BROWSE_UNANSWERED_MENTIONS_LOOKUP_PATTERN,
  GIF_LOOKUP_PATTERN,
  LATEST_POST_LOOKUP_PATTERN,
  LOOKUP_FORCE_PATTERN,
  RESOLVE_REFERENCE_LOOKUP_PATTERN,
  SEARCH_GLOBAL_LOOKUP_PATTERN,
  SITE_LOOKUP_TRIGGER_PATTERN,
  SUGGESTED_FOLLOW_LOOKUP_PATTERN,
  extractLookupQueryTerm,
  parseRetrievalHitCount,
} from "./chat-manager-lookup-utils.js";
import {
  appendLiveSiteLookupBlocksPrimary,
} from "./chat-manager-live-site-lookup-blocks-primary.js";
import {
  appendLiveSiteLookupBlocksSecondary,
} from "./chat-manager-live-site-lookup-blocks-secondary.js";
import {
  appendLiveSiteLookupBlocksTertiary,
} from "./chat-manager-live-site-lookup-blocks-tertiary.js";
import type {
  LiveSiteLookupDeps,
  LiveSiteLookupInput,
} from "./chat-manager-live-site-lookup-types.js";

export type {
  LiveSiteLookupDeps,
  LiveSiteLookupInput,
} from "./chat-manager-live-site-lookup-types.js";

export const shouldRunLiveSiteLookup = (input: LiveSiteLookupInput): boolean => {
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
};

export const loadLiveSiteLookup = async (
  deps: LiveSiteLookupDeps,
  input: LiveSiteLookupInput,
): Promise<string[]> => {
  if (!shouldRunLiveSiteLookup(input)) return [];
  const lines: string[] = [];
  const now = nowIso();
  const remember = async (payload: Record<string, unknown>): Promise<void> => {
    await deps
      .recordWrite({
        type: "chat_runtime_site_lookup",
        at: now,
        messageId: input.entry.messageId,
        conversationId: input.entry.conversationId ?? null,
        channelId: input.entry.channelId ?? null,
        query: toAnswerPreview(input.retrievalQuery, 220),
        ...payload,
      })
      .catch(() => undefined);
  };

  const lookupCall = async (payload: Record<string, unknown>) =>
    deps.callAgentChatBridge(payload);

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

  const runtime = {
    input,
    lines,
    remember,
    lookupCall,
    listServers,
  };

  await appendLiveSiteLookupBlocksPrimary(runtime);
  await appendLiveSiteLookupBlocksSecondary(runtime);
  await appendLiveSiteLookupBlocksTertiary(runtime);

  return lines.slice(0, 20);
};
