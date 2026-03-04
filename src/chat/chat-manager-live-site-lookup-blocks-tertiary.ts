import { isRecord } from "../lib/guards.js";
import { toAnswerPreview } from "../lib/text.js";
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
  COMMENT_LOOKUP_PATTERN,
  CUSTOM_ASSET_LOOKUP_PATTERN,
  FOLLOW_LOOKUP_PATTERN,
  GIF_LOOKUP_PATTERN,
  LATEST_POST_LOOKUP_PATTERN,
  RESOLVE_REFERENCE_LOOKUP_PATTERN,
  SEARCH_GLOBAL_LOOKUP_PATTERN,
  SUGGESTED_FOLLOW_LOOKUP_PATTERN,
  extractCustomAssetSearchQuery,
  extractGifSearchQuery,
  extractLookupQueryTerm,
  parseHandleMentions,
  parseLookupWindowHours,
  pickCommentRecordsFromLookup,
  pickCustomAssetRecordsFromLookup,
  pickGifRecordsFromLookup,
  pickPostRecordFromLookup,
  pickPostRecordsFromLookup,
  pickUserRecordsFromLookup,
  summarizeCommentRecord,
  summarizeCustomAssetRecord,
  summarizeGifRecord,
  summarizePostRecord,
  summarizeUserRecord,
  toFinitePositiveInt,
} from "./chat-manager-lookup-utils.js";
import type { LiveSiteLookupRuntime } from "./chat-manager-live-site-lookup-types.js";

export const appendLiveSiteLookupBlocksTertiary = async (runtime: LiveSiteLookupRuntime): Promise<void> => {
  const { input, lines, remember, lookupCall, listServers } = runtime;
  if (SEARCH_GLOBAL_LOOKUP_PATTERN.test(input.retrievalQuery)) {
    const query = extractLookupQueryTerm(input.retrievalQuery);
    if (query) {
      try {
        const response = await lookupCall({
          action: "search_global",
          query,
          limit: 8,
          includePeople: true,
        });
        const people =
          isRecord(response) && Array.isArray(response.people)
            ? response.people.filter((entry): entry is Record<string, unknown> =>
                isRecord(entry),
              )
            : [];
        const posts =
          isRecord(response) && Array.isArray(response.posts)
            ? response.posts.filter((entry): entry is Record<string, unknown> =>
                isRecord(entry),
              )
            : [];
        const postSummaries = posts.map((entry) => summarizePostRecord(entry)).slice(0, 2);
        const peopleSummaries = people
          .map((entry) => summarizeUserRecord(entry))
          .slice(0, 2);
        if (postSummaries.length === 0 && peopleSummaries.length === 0) {
          lines.push(`lookup: global search "${query}" returned no matches`);
          await remember({
            lookupKind: "search_global",
            found: false,
            query,
            summary: `global search "${query}" returned no matches`,
          });
        } else {
          for (const person of peopleSummaries) {
            lines.push(`lookup: search person -> ${person.line}`);
            await remember({
              lookupKind: "search_global",
              found: true,
              query,
              handle: person.handle,
              userId: person.userId,
              summary: person.reason ?? person.line,
            });
          }
          for (const post of postSummaries) {
            lines.push(`lookup: search post -> ${post.line}`);
            await remember({
              lookupKind: "search_global",
              found: true,
              query,
              postId: post.postId,
              summary: post.bodyPreview ?? post.line,
            });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(
          `lookup: global search failed (${toAnswerPreview(message, 120)})`,
        );
        await remember({
          lookupKind: "search_global",
          found: false,
          query,
          error: toAnswerPreview(message, 180),
        });
      }
    }
  }

  const wantsResolveReference =
    RESOLVE_REFERENCE_LOOKUP_PATTERN.test(input.retrievalQuery) ||
    typeof input.hints.postId === "number" ||
    typeof input.hints.commentId === "number";
  if (wantsResolveReference) {
    const references = new Set<string>();
    if (typeof input.hints.postId === "number") references.add(`post ${input.hints.postId}`);
    if (typeof input.hints.commentId === "number") references.add(`comment ${input.hints.commentId}`);
    for (const handle of parseHandleMentions(input.retrievalQuery).slice(0, 2)) {
      references.add(`@${handle}`);
    }
    if (references.size === 0) {
      const single = extractLookupQueryTerm(input.retrievalQuery);
      if (single) references.add(single);
    }
    for (const reference of Array.from(references).slice(0, 3)) {
      try {
        const response = await lookupCall({
          action: "resolve_reference",
          reference,
        });
        const responseRecord = isRecord(response) ? response : null;
        const type =
          responseRecord && typeof responseRecord.type === "string"
            ? responseRecord.type
            : "unknown";
        const postRecord = responseRecord && isRecord(responseRecord.post)
          ? responseRecord.post
          : null;
        const commentRecord = responseRecord && isRecord(responseRecord.comment)
          ? responseRecord.comment
          : null;
        const userRecord = responseRecord && isRecord(responseRecord.user)
          ? responseRecord.user
          : null;
        const found = postRecord !== null || commentRecord !== null || userRecord !== null;
        if (!found) {
          lines.push(`lookup: reference "${reference}" not found`);
          await remember({
            lookupKind: "resolve_reference",
            found: false,
            reference,
            summary: `reference "${reference}" not found`,
          });
          continue;
        }
        if (type === "post" && postRecord) {
          const summary = summarizePostRecord(postRecord);
          lines.push(`lookup: ref "${reference}" -> ${summary.line}`);
          await remember({
            lookupKind: "resolve_reference",
            found: true,
            reference,
            refType: type,
            postId: summary.postId,
            summary: summary.bodyPreview ?? summary.line,
          });
          continue;
        }
        if (type === "comment" && commentRecord) {
          const summary = summarizeCommentRecord(commentRecord);
          lines.push(`lookup: ref "${reference}" -> ${summary.line}`);
          await remember({
            lookupKind: "resolve_reference",
            found: true,
            reference,
            refType: type,
            postId: summary.postId,
            commentId: summary.commentId,
            summary: summary.bodyPreview ?? summary.line,
          });
          continue;
        }
        if (type === "user" && userRecord) {
          const summary = summarizeUserRecord(userRecord);
          lines.push(`lookup: ref "${reference}" -> ${summary.line}`);
          await remember({
            lookupKind: "resolve_reference",
            found: true,
            reference,
            refType: type,
            handle: summary.handle,
            userId: summary.userId,
            summary: summary.reason ?? summary.line,
          });
          continue;
        }
        lines.push(`lookup: ref "${reference}" resolved as ${type}`);
        await remember({
          lookupKind: "resolve_reference",
          found: true,
          reference,
          refType: type,
          summary: `resolved as ${type}`,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(
          `lookup: resolve "${reference}" failed (${toAnswerPreview(message, 120)})`,
        );
        await remember({
          lookupKind: "resolve_reference",
          found: false,
          reference,
          error: toAnswerPreview(message, 180),
        });
      }
    }
  }

  if (BROWSE_RECENT_ACTIONS_LOOKUP_PATTERN.test(input.retrievalQuery)) {
    const windowHours = parseLookupWindowHours(input.retrievalQuery) ?? 24 * 7;
    try {
      const response = await lookupCall({
        action: "browse_recent_actions",
        windowHours,
        limit: 24,
      });
      const rows =
        isRecord(response) && Array.isArray(response.items)
          ? response.items.filter((entry): entry is Record<string, unknown> =>
              isRecord(entry),
            )
          : [];
      if (rows.length === 0) {
        lines.push(`lookup: no recent actions in last ${windowHours}h`);
        await remember({
          lookupKind: "browse_recent_actions",
          found: false,
          windowHours,
          summary: `no recent actions in last ${windowHours}h`,
        });
      } else {
        for (const row of rows.slice(0, 6)) {
          const eventType =
            typeof row.eventType === "string" ? row.eventType.trim() : "unknown";
          const capability =
            typeof row.capability === "string" ? row.capability.trim() : null;
          const allowed = row.allowed === true;
          const line = [
            `lookup: action:${eventType}`,
            capability ? `capability=${capability}` : "",
            `allowed=${allowed ? "yes" : "no"}`,
            typeof row.createdAt === "string" ? `at=${row.createdAt}` : "",
          ]
            .filter((part) => part.length > 0)
            .join(" · ");
          lines.push(line);
          await remember({
            lookupKind: "browse_recent_actions",
            found: true,
            windowHours,
            eventType,
            capability,
            allowed,
            summary: line,
          });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(
        `lookup: recent actions failed (${toAnswerPreview(message, 120)})`,
      );
      await remember({
        lookupKind: "browse_recent_actions",
        found: false,
        windowHours,
        error: toAnswerPreview(message, 180),
      });
    }
  }

  if (CUSTOM_ASSET_LOOKUP_PATTERN.test(input.retrievalQuery)) {
    const assetQuery = extractCustomAssetSearchQuery(input.retrievalQuery);
    const assetLookupPayload: Record<string, unknown> = {
      action: "find_custom_assets",
      limit: 8,
      includeOwnerSelections: true,
    };
    if (assetQuery) {
      assetLookupPayload.query = assetQuery;
    }
    if (input.entry.conversationId) {
      assetLookupPayload.conversationId = input.entry.conversationId;
    } else if (input.entry.channelId) {
      assetLookupPayload.channelId = input.entry.channelId;
    }
    try {
      const response = await lookupCall(assetLookupPayload);
      const assets = pickCustomAssetRecordsFromLookup(response)
        .map((entry) => summarizeCustomAssetRecord(entry))
        .slice(0, 4);
      if (assets.length === 0) {
        lines.push(
          assetQuery
            ? `lookup: custom assets for "${assetQuery}" not found`
            : "lookup: no preferred custom assets available",
        );
        await remember({
          lookupKind: "custom_asset_search",
          found: false,
          query: assetQuery,
          summary: assetQuery
            ? `custom assets for "${assetQuery}" not found`
            : "no preferred custom assets available",
        });
      } else {
        for (const asset of assets) {
          lines.push(`lookup: ${asset.line}`);
          await remember({
            lookupKind: "custom_asset_search",
            found: true,
            query: assetQuery,
            kind: asset.kind,
            name: asset.name,
            owner: asset.owner,
            source: asset.source,
            url: asset.url,
            summary: asset.line,
          });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(
        `lookup: custom asset fetch failed (${toAnswerPreview(message, 120)})`,
      );
      await remember({
        lookupKind: "custom_asset_search",
        found: false,
        query: assetQuery,
        error: toAnswerPreview(message, 180),
      });
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

};
