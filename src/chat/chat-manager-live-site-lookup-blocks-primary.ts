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

export const appendLiveSiteLookupBlocksPrimary = async (runtime: LiveSiteLookupRuntime): Promise<void> => {
  const { input, lines, remember, lookupCall, listServers } = runtime;
  if (typeof input.hints.postId === "number") {
    try {
      const response = await lookupCall({
        action: "find_post",
        postId: input.hints.postId,
      });
      const postRecord = pickPostRecordFromLookup(response);
      if (postRecord) {
        const summary = summarizePostRecord(postRecord);
        lines.push(`lookup: ${summary.line}`);
        await remember({
          lookupKind: "post_by_id",
          found: true,
          postId: summary.postId,
          summary: summary.bodyPreview ?? summary.line,
        });
      } else {
        lines.push(`lookup: post:${input.hints.postId} not found`);
        await remember({
          lookupKind: "post_by_id",
          found: false,
          postId: input.hints.postId,
          summary: `post:${input.hints.postId} not found`,
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(
        `lookup: post:${input.hints.postId} fetch failed (${toAnswerPreview(message, 120)})`,
      );
      await remember({
        lookupKind: "post_by_id",
        found: false,
        postId: input.hints.postId,
        error: toAnswerPreview(message, 180),
      });
    }
  }

  const wantsCommentLookup =
    typeof input.hints.commentId === "number" ||
    COMMENT_LOOKUP_PATTERN.test(input.retrievalQuery);
  if (wantsCommentLookup && typeof input.hints.postId === "number") {
    try {
      const response = await lookupCall({
        action: "find_comment",
        postId: input.hints.postId,
        ...(typeof input.hints.commentId === "number"
          ? { commentId: input.hints.commentId }
          : {}),
      });
      const comments = pickCommentRecordsFromLookup(response);
      const sorted = comments
        .map((entry) => ({
          record: entry,
          createdAtMs: Date.parse(
            typeof entry.createdAt === "string" ? entry.createdAt : "",
          ),
        }))
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
        .map((entry) => entry.record);
      const chosen =
        typeof input.hints.commentId === "number"
          ? sorted.slice(0, 1)
          : sorted.slice(0, 3);
      if (chosen.length === 0) {
        const detail =
          typeof input.hints.commentId === "number"
            ? `comment:${input.hints.commentId}`
            : "recent comments";
        lines.push(`lookup: ${detail} not found for post:${input.hints.postId}`);
        await remember({
          lookupKind: "comment_by_post",
          found: false,
          postId: input.hints.postId,
          commentId: input.hints.commentId ?? null,
          summary: `${detail} not found`,
        });
      } else {
        for (const commentRecord of chosen) {
          const summary = summarizeCommentRecord(commentRecord);
          lines.push(`lookup: ${summary.line}`);
          await remember({
            lookupKind: "comment_by_post",
            found: true,
            postId: summary.postId,
            commentId: summary.commentId,
            summary: summary.bodyPreview ?? summary.line,
          });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(
        `lookup: comment fetch failed (${toAnswerPreview(message, 120)})`,
      );
      await remember({
        lookupKind: "comment_by_post",
        found: false,
        postId: input.hints.postId,
        commentId: input.hints.commentId ?? null,
        error: toAnswerPreview(message, 180),
      });
    }
  }

  const wantsPostActivityLookup =
    typeof input.hints.postId === "number" &&
    BROWSE_POST_ACTIVITY_LOOKUP_PATTERN.test(input.retrievalQuery);
  if (wantsPostActivityLookup && typeof input.hints.postId === "number") {
    try {
      const response = await lookupCall({
        action: "browse_post_activity",
        postId: input.hints.postId,
        limit: 12,
        includeLikes: true,
        includeReposts: true,
        includeComments: true,
        includeViews: true,
      });
      const responseRecord = isRecord(response) ? response : null;
      const totalsRecord =
        responseRecord && isRecord(responseRecord.totals) ? responseRecord.totals : null;
      const totals = {
        likes: toFinitePositiveInt(totalsRecord?.likes) ?? 0,
        reposts: toFinitePositiveInt(totalsRecord?.reposts) ?? 0,
        comments: toFinitePositiveInt(totalsRecord?.comments) ?? 0,
        views: toFinitePositiveInt(totalsRecord?.views) ?? 0,
      };
      const itemsRecord =
        responseRecord && isRecord(responseRecord.items) ? responseRecord.items : null;
      const likes = Array.isArray(itemsRecord?.likes) ? itemsRecord.likes : [];
      const reposts = Array.isArray(itemsRecord?.reposts) ? itemsRecord.reposts : [];
      const comments = Array.isArray(itemsRecord?.comments) ? itemsRecord.comments : [];
      const firstActorHandle = (() => {
        const firstLike = likes.find((entry) => isRecord(entry));
        if (isRecord(firstLike?.author) && typeof firstLike.author.handle === "string") {
          return firstLike.author.handle.trim().replace(/^@+/u, "");
        }
        if (isRecord(firstLike?.user) && typeof firstLike.user.handle === "string") {
          return firstLike.user.handle.trim().replace(/^@+/u, "");
        }
        return null;
      })();
      const line = [
        `lookup: post:${input.hints.postId} activity`,
        `likes=${totals.likes}`,
        `reposts=${totals.reposts}`,
        `comments=${totals.comments}`,
        `views=${totals.views}`,
        firstActorHandle ? `firstLiker=@${firstActorHandle}` : "",
      ]
        .filter((part) => part.length > 0)
        .join(" · ");
      lines.push(line);
      await remember({
        lookupKind: "post_activity",
        found: true,
        postId: input.hints.postId,
        likes: totals.likes,
        reposts: totals.reposts,
        comments: totals.comments,
        views: totals.views,
        sampleLikeCount: likes.length,
        sampleRepostCount: reposts.length,
        sampleCommentCount: comments.length,
        summary: line,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(
        `lookup: post:${input.hints.postId} activity failed (${toAnswerPreview(message, 120)})`,
      );
      await remember({
        lookupKind: "post_activity",
        found: false,
        postId: input.hints.postId,
        error: toAnswerPreview(message, 180),
      });
    }
  }

  const wantsCommentActivityLookup =
    typeof input.hints.commentId === "number" &&
    BROWSE_COMMENT_ACTIVITY_LOOKUP_PATTERN.test(input.retrievalQuery);
  if (wantsCommentActivityLookup && typeof input.hints.commentId === "number") {
    try {
      const response = await lookupCall({
        action: "browse_comment_activity",
        commentId: input.hints.commentId,
        limit: 12,
        includeReplies: true,
        includeViews: true,
      });
      const responseRecord = isRecord(response) ? response : null;
      const totalsRecord =
        responseRecord && isRecord(responseRecord.totals) ? responseRecord.totals : null;
      const replies = toFinitePositiveInt(totalsRecord?.replies) ?? 0;
      const views = toFinitePositiveInt(totalsRecord?.views) ?? 0;
      const commentRecord =
        responseRecord && isRecord(responseRecord.comment) ? responseRecord.comment : null;
      const bodyRaw = commentRecord && typeof commentRecord.body === "string"
        ? commentRecord.body
        : "";
      const line = [
        `lookup: comment:${input.hints.commentId} activity`,
        `replies=${replies}`,
        `views=${views}`,
        bodyRaw.trim().length > 0 ? `summary=${toAnswerPreview(bodyRaw, 100)}` : "",
      ]
        .filter((part) => part.length > 0)
        .join(" · ");
      lines.push(line);
      await remember({
        lookupKind: "comment_activity",
        found: true,
        commentId: input.hints.commentId,
        postId: toFinitePositiveInt(commentRecord?.postId),
        replies,
        views,
        summary: line,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(
        `lookup: comment:${input.hints.commentId} activity failed (${toAnswerPreview(message, 120)})`,
      );
      await remember({
        lookupKind: "comment_activity",
        found: false,
        commentId: input.hints.commentId,
        error: toAnswerPreview(message, 180),
      });
    }
  }

  if (LATEST_POST_LOOKUP_PATTERN.test(input.retrievalQuery)) {
    const handles = parseHandleMentions(input.retrievalQuery);
    if (
      handles.length === 0 &&
      /\b(my|me|i)\b/iu.test(input.entry.body) &&
      input.entry.authorHandle.trim().length > 0
    ) {
      handles.push(input.entry.authorHandle.trim().replace(/^@+/u, "").toLowerCase());
    }
    for (const handle of handles.slice(0, 3)) {
      try {
        const response = await lookupCall({
          action: "find_post",
          authorHandle: handle,
          latest: true,
        });
        const postRecord = pickPostRecordFromLookup(response);
        if (postRecord) {
          const summary = summarizePostRecord(postRecord);
          lines.push(`lookup: latest @${handle} -> ${summary.line}`);
          await remember({
            lookupKind: "latest_post_by_handle",
            found: true,
            handle,
            postId: summary.postId,
            summary: summary.bodyPreview ?? summary.line,
          });
        } else {
          lines.push(`lookup: latest post for @${handle} not found`);
          await remember({
            lookupKind: "latest_post_by_handle",
            found: false,
            handle,
            summary: `latest post for @${handle} not found`,
          });
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(
          `lookup: latest @${handle} failed (${toAnswerPreview(message, 120)})`,
        );
        await remember({
          lookupKind: "latest_post_by_handle",
          found: false,
          handle,
          error: toAnswerPreview(message, 180),
        });
      }
    }
  }

  if (FOLLOW_LOOKUP_PATTERN.test(input.retrievalQuery)) {
    const handles = parseHandleMentions(input.retrievalQuery);
    for (const handle of handles.slice(0, 3)) {
      try {
        const response = await lookupCall({
          action: "find_user",
          handle,
        });
        const userRecord = isRecord(response)
          ? isRecord(response.user)
            ? response.user
            : response
          : null;
        if (userRecord) {
          const resolvedHandle =
            (typeof userRecord.handle === "string"
              ? userRecord.handle
              : handle).trim();
          lines.push(`lookup: user @${resolvedHandle} exists`);
          await remember({
            lookupKind: "user_by_handle",
            found: true,
            handle: resolvedHandle,
            summary: `user @${resolvedHandle} exists`,
          });
        } else {
          lines.push(`lookup: user @${handle} not found`);
          await remember({
            lookupKind: "user_by_handle",
            found: false,
            handle,
            summary: `user @${handle} not found`,
          });
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(`lookup: user @${handle} failed (${toAnswerPreview(message, 120)})`);
        await remember({
          lookupKind: "user_by_handle",
          found: false,
          handle,
          error: toAnswerPreview(message, 180),
        });
      }
    }
  }

  if (SUGGESTED_FOLLOW_LOOKUP_PATTERN.test(input.retrievalQuery)) {
    try {
      const response = await lookupCall({
        action: "suggest_followers",
        limit: 8,
        includeAgents: true,
      });
      const users = pickUserRecordsFromLookup(response)
        .map((entry) => summarizeUserRecord(entry))
        .slice(0, 4);
      if (users.length === 0) {
        lines.push("lookup: no follow suggestions available right now");
        await remember({
          lookupKind: "suggest_followers",
          found: false,
          summary: "no follow suggestions available",
        });
      } else {
        for (const user of users) {
          lines.push(`lookup: ${user.line}`);
          await remember({
            lookupKind: "suggest_followers",
            found: true,
            handle: user.handle,
            userId: user.userId,
            summary: user.reason ?? user.line,
          });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(
        `lookup: suggest_followers failed (${toAnswerPreview(message, 120)})`,
      );
      await remember({
        lookupKind: "suggest_followers",
        found: false,
        error: toAnswerPreview(message, 180),
      });
    }
  }

  if (BROWSE_POST_LOOKUP_PATTERN.test(input.retrievalQuery)) {
    try {
      const response = await lookupCall({
        action: "browse_posts",
        limit: 8,
      });
      const posts = pickPostRecordsFromLookup(response)
        .map((entry) => summarizePostRecord(entry))
        .slice(0, 4);
      if (posts.length === 0) {
        lines.push("lookup: browse posts returned no items");
        await remember({
          lookupKind: "browse_posts",
          found: false,
          summary: "browse posts returned no items",
        });
      } else {
        for (const post of posts) {
          lines.push(`lookup: browse -> ${post.line}`);
          await remember({
            lookupKind: "browse_posts",
            found: true,
            postId: post.postId,
            summary: post.bodyPreview ?? post.line,
          });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(
        `lookup: browse_posts failed (${toAnswerPreview(message, 120)})`,
      );
      await remember({
        lookupKind: "browse_posts",
        found: false,
        error: toAnswerPreview(message, 180),
      });
    }
  }

  if (BROWSE_COMMENT_LOOKUP_PATTERN.test(input.retrievalQuery)) {
    try {
      const response = await lookupCall({
        action: "browse_comments",
        limit: 10,
        ...(typeof input.hints.postId === "number"
          ? { postId: input.hints.postId }
          : {
              searchText: toAnswerPreview(input.retrievalQuery, 160),
            }),
      });
      const comments = pickCommentRecordsFromLookup(response)
        .map((entry) => summarizeCommentRecord(entry))
        .slice(0, 4);
      if (comments.length === 0) {
        lines.push("lookup: browse comments returned no items");
        await remember({
          lookupKind: "browse_comments",
          found: false,
          postId: input.hints.postId ?? null,
          summary: "browse comments returned no items",
        });
      } else {
        for (const comment of comments) {
          lines.push(`lookup: browse comments -> ${comment.line}`);
          await remember({
            lookupKind: "browse_comments",
            found: true,
            postId: comment.postId,
            commentId: comment.commentId,
            summary: comment.bodyPreview ?? comment.line,
          });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(
        `lookup: browse_comments failed (${toAnswerPreview(message, 120)})`,
      );
      await remember({
        lookupKind: "browse_comments",
        found: false,
        postId: input.hints.postId ?? null,
        error: toAnswerPreview(message, 180),
      });
    }
  }

  if (BROWSE_AGENT_LOOKUP_PATTERN.test(input.retrievalQuery)) {
    try {
      const response = await lookupCall({
        action: "browse_agents",
        query: toAnswerPreview(input.retrievalQuery, 90),
        limit: 8,
        includeFollowing: true,
        includeFollowers: true,
        includeRecentPosters: true,
      });
      const users = pickUserRecordsFromLookup(response)
        .map((entry) => summarizeUserRecord(entry))
        .slice(0, 4);
      if (users.length === 0) {
        lines.push("lookup: browse agents returned no items");
        await remember({
          lookupKind: "browse_agents",
          found: false,
          summary: "browse agents returned no items",
        });
      } else {
        for (const user of users) {
          lines.push(`lookup: browse agents -> ${user.line}`);
          await remember({
            lookupKind: "browse_agents",
            found: true,
            handle: user.handle,
            userId: user.userId,
            summary: user.reason ?? user.line,
          });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(
        `lookup: browse_agents failed (${toAnswerPreview(message, 120)})`,
      );
      await remember({
        lookupKind: "browse_agents",
        found: false,
        error: toAnswerPreview(message, 180),
      });
    }
  }

  if (BROWSE_NOTIFICATIONS_LOOKUP_PATTERN.test(input.retrievalQuery)) {
    const unreadOnly =
      /\b(unread|unanswered|pending)\b/iu.test(input.retrievalQuery);
    try {
      const response = await lookupCall({
        action: "browse_notifications",
        unreadOnly,
        limit: 12,
      });
      const rows =
        isRecord(response) && Array.isArray(response.items)
          ? response.items.filter((entry): entry is Record<string, unknown> =>
              isRecord(entry),
            )
          : [];
      if (rows.length === 0) {
        lines.push(
          unreadOnly
            ? "lookup: no unread notifications right now"
            : "lookup: notifications feed is empty right now",
        );
        await remember({
          lookupKind: "browse_notifications",
          found: false,
          unreadOnly,
          summary: unreadOnly
            ? "no unread notifications"
            : "notifications feed is empty",
        });
      } else {
        for (const row of rows.slice(0, 4)) {
          const actor =
            isRecord(row.actor) && typeof row.actor.handle === "string"
              ? row.actor.handle.trim().replace(/^@+/u, "")
              : null;
          const type = typeof row.type === "string" ? row.type.trim() : "unknown";
          const entityType =
            typeof row.entityType === "string" ? row.entityType.trim() : "entity";
          const entityId = toFinitePositiveInt(row.entityId);
          const readAt =
            typeof row.readAt === "string" && row.readAt.trim().length > 0
              ? row.readAt.trim()
              : null;
          const line = [
            `lookup: notification:${type}`,
            actor ? `actor=@${actor}` : "",
            entityId ? `${entityType}:${entityId}` : entityType,
            readAt ? "read" : "unread",
          ]
            .filter((part) => part.length > 0)
            .join(" · ");
          lines.push(line);
          await remember({
            lookupKind: "browse_notifications",
            found: true,
            unreadOnly,
            notificationType: type,
            entityType,
            entityId,
            actorHandle: actor,
            readAt,
            summary: line,
          });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(
        `lookup: notifications fetch failed (${toAnswerPreview(message, 120)})`,
      );
      await remember({
        lookupKind: "browse_notifications",
        found: false,
        unreadOnly,
        error: toAnswerPreview(message, 180),
      });
    }
  }

  if (BROWSE_HOME_FEED_LOOKUP_PATTERN.test(input.retrievalQuery)) {
    try {
      const response = await lookupCall({
        action: "browse_home_feed",
        limit: 10,
      });
      const posts = pickPostRecordsFromLookup(response)
        .map((entry) => summarizePostRecord(entry))
        .slice(0, 4);
      if (posts.length === 0) {
        lines.push("lookup: home feed returned no items");
        await remember({
          lookupKind: "browse_home_feed",
          found: false,
          summary: "home feed returned no items",
        });
      } else {
        for (const post of posts) {
          lines.push(`lookup: home -> ${post.line}`);
          await remember({
            lookupKind: "browse_home_feed",
            found: true,
            postId: post.postId,
            summary: post.bodyPreview ?? post.line,
          });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(
        `lookup: home feed failed (${toAnswerPreview(message, 120)})`,
      );
      await remember({
        lookupKind: "browse_home_feed",
        found: false,
        error: toAnswerPreview(message, 180),
      });
    }
  }

  if (BROWSE_TRENDING_LOOKUP_PATTERN.test(input.retrievalQuery)) {
    try {
      const response = await lookupCall({
        action: "browse_trending",
        limit: 10,
      });
      const posts = pickPostRecordsFromLookup(response)
        .map((entry) => summarizePostRecord(entry))
        .slice(0, 4);
      if (posts.length === 0) {
        lines.push("lookup: trending returned no items");
        await remember({
          lookupKind: "browse_trending",
          found: false,
          summary: "trending returned no items",
        });
      } else {
        for (const post of posts) {
          lines.push(`lookup: trending -> ${post.line}`);
          await remember({
            lookupKind: "browse_trending",
            found: true,
            postId: post.postId,
            summary: post.bodyPreview ?? post.line,
          });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(
        `lookup: trending failed (${toAnswerPreview(message, 120)})`,
      );
      await remember({
        lookupKind: "browse_trending",
        found: false,
        error: toAnswerPreview(message, 180),
      });
    }
  }

};
