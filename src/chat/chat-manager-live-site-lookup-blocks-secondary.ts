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

export const appendLiveSiteLookupBlocksSecondary = async (runtime: LiveSiteLookupRuntime): Promise<void> => {
  const { input, lines, remember, lookupCall, listServers } = runtime;
  if (BROWSE_TOP_ENGAGERS_LOOKUP_PATTERN.test(input.retrievalQuery)) {
    const windowHours = parseLookupWindowHours(input.retrievalQuery) ?? 24 * 7;
    try {
      const response = await lookupCall({
        action: "browse_top_engagers",
        limit: 8,
        windowHours,
      });
      const rows =
        isRecord(response) && Array.isArray(response.items)
          ? response.items.filter((entry): entry is Record<string, unknown> =>
              isRecord(entry),
            )
          : [];
      if (rows.length === 0) {
        lines.push(`lookup: no top engagers found in last ${windowHours}h`);
        await remember({
          lookupKind: "browse_top_engagers",
          found: false,
          windowHours,
          summary: `no top engagers in last ${windowHours}h`,
        });
      } else {
        for (const row of rows.slice(0, 4)) {
          const user =
            isRecord(row.user) && typeof row.user.handle === "string"
              ? row.user.handle.trim().replace(/^@+/u, "")
              : "unknown";
          const likeCount = toFinitePositiveInt(row.likeCount) ?? 0;
          const repostCount = toFinitePositiveInt(row.repostCount) ?? 0;
          const commentCount = toFinitePositiveInt(row.commentCount) ?? 0;
          const viewCount = toFinitePositiveInt(row.viewCount) ?? 0;
          const score =
            typeof row.score === "number" && Number.isFinite(row.score)
              ? row.score
              : commentCount * 3 + repostCount * 2 + likeCount * 2 + viewCount;
          const line = [
            `lookup: engager=@${user}`,
            `score=${score}`,
            `likes=${likeCount}`,
            `reposts=${repostCount}`,
            `comments=${commentCount}`,
            `views=${viewCount}`,
          ]
            .filter((part) => part.length > 0)
            .join(" · ");
          lines.push(line);
          await remember({
            lookupKind: "browse_top_engagers",
            found: true,
            windowHours,
            handle: user,
            score,
            likeCount,
            repostCount,
            commentCount,
            viewCount,
            summary: line,
          });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(
        `lookup: top engagers failed (${toAnswerPreview(message, 120)})`,
      );
      await remember({
        lookupKind: "browse_top_engagers",
        found: false,
        windowHours,
        error: toAnswerPreview(message, 180),
      });
    }
  }

  if (BROWSE_UNANSWERED_MENTIONS_LOOKUP_PATTERN.test(input.retrievalQuery)) {
    const sinceHours = parseLookupWindowHours(input.retrievalQuery) ?? 24 * 7;
    try {
      const response = await lookupCall({
        action: "browse_unanswered_mentions",
        limit: 12,
        sinceHours,
      });
      const rows =
        isRecord(response) && Array.isArray(response.items)
          ? response.items.filter((entry): entry is Record<string, unknown> =>
              isRecord(entry),
            )
          : [];
      if (rows.length === 0) {
        lines.push(`lookup: no unanswered mentions in last ${sinceHours}h`);
        await remember({
          lookupKind: "browse_unanswered_mentions",
          found: false,
          sinceHours,
          summary: `no unanswered mentions in last ${sinceHours}h`,
        });
      } else {
        for (const row of rows.slice(0, 6)) {
          const targetType =
            typeof row.targetType === "string" ? row.targetType.trim() : "target";
          const targetId = toFinitePositiveInt(row.targetId);
          const line = [
            "lookup: unanswered mention",
            targetId ? `${targetType}:${targetId}` : targetType,
            typeof row.createdAt === "string" ? `at=${row.createdAt}` : "",
          ]
            .filter((part) => part.length > 0)
            .join(" · ");
          lines.push(line);
          await remember({
            lookupKind: "browse_unanswered_mentions",
            found: true,
            sinceHours,
            targetType,
            targetId,
            summary: line,
          });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(
        `lookup: unanswered mentions failed (${toAnswerPreview(message, 120)})`,
      );
      await remember({
        lookupKind: "browse_unanswered_mentions",
        found: false,
        sinceHours,
        error: toAnswerPreview(message, 180),
      });
    }
  }

  if (BROWSE_DRAFTS_LOOKUP_PATTERN.test(input.retrievalQuery)) {
    try {
      const response = await lookupCall({
        action: "browse_drafts",
        limit: 10,
        ...(input.entry.conversationId
          ? { conversationId: input.entry.conversationId }
          : {}),
        ...(input.entry.channelId ? { channelId: input.entry.channelId } : {}),
      });
      const rows =
        isRecord(response) && Array.isArray(response.items)
          ? response.items.filter((entry): entry is Record<string, unknown> =>
              isRecord(entry),
            )
          : [];
      if (rows.length === 0) {
        lines.push("lookup: no recent drafts found");
        await remember({
          lookupKind: "browse_drafts",
          found: false,
          summary: "no recent drafts found",
        });
      } else {
        for (const row of rows.slice(0, 4)) {
          const draftId = typeof row.id === "string" ? row.id.trim() : "";
          const body =
            typeof row.body === "string" && row.body.trim().length > 0
              ? toAnswerPreview(row.body, 110)
              : null;
          const line = [
            `lookup: draft:${draftId || "n/a"}`,
            body ? `summary=${body}` : "",
            typeof row.createdAt === "string" ? `createdAt=${row.createdAt}` : "",
          ]
            .filter((part) => part.length > 0)
            .join(" · ");
          lines.push(line);
          await remember({
            lookupKind: "browse_drafts",
            found: true,
            draftId: draftId || null,
            summary: line,
          });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`lookup: drafts failed (${toAnswerPreview(message, 120)})`);
      await remember({
        lookupKind: "browse_drafts",
        found: false,
        error: toAnswerPreview(message, 180),
      });
    }
  }

  if (BROWSE_DIRECTIVE_QUEUE_LOOKUP_PATTERN.test(input.retrievalQuery)) {
    const includeCompleted = /\b(done|completed|failed|history|past)\b/iu.test(
      input.retrievalQuery,
    );
    try {
      const response = await lookupCall({
        action: "browse_directive_queue",
        includeCompleted,
        limit: 24,
      });
      const rows =
        isRecord(response) && Array.isArray(response.items)
          ? response.items.filter((entry): entry is Record<string, unknown> =>
              isRecord(entry),
            )
          : [];
      if (rows.length === 0) {
        lines.push("lookup: directive queue is empty");
        await remember({
          lookupKind: "browse_directive_queue",
          found: false,
          includeCompleted,
          summary: "directive queue is empty",
        });
      } else {
        for (const row of rows.slice(0, 6)) {
          const queueId = typeof row.id === "string" ? row.id.trim() : "";
          const status =
            typeof row.status === "string" ? row.status.trim() : "unknown";
          const actionKind =
            typeof row.actionKind === "string" ? row.actionKind.trim() : "unknown";
          const line = [
            `lookup: directive:${queueId || "n/a"}`,
            `status=${status}`,
            `action=${actionKind}`,
            typeof row.runAt === "string" ? `runAt=${row.runAt}` : "",
          ]
            .filter((part) => part.length > 0)
            .join(" · ");
          lines.push(line);
          await remember({
            lookupKind: "browse_directive_queue",
            found: true,
            includeCompleted,
            queueId: queueId || null,
            status,
            actionKind,
            summary: line,
          });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(
        `lookup: directive queue failed (${toAnswerPreview(message, 120)})`,
      );
      await remember({
        lookupKind: "browse_directive_queue",
        found: false,
        includeCompleted,
        error: toAnswerPreview(message, 180),
      });
    }
  }

  if (BROWSE_SERVERS_LOOKUP_PATTERN.test(input.retrievalQuery)) {
    try {
      const rows = await listServers();
      if (rows.length === 0) {
        lines.push("lookup: no servers found");
        await remember({
          lookupKind: "browse_servers",
          found: false,
          summary: "no servers found",
        });
      } else {
        for (const row of rows.slice(0, 4)) {
          const id = typeof row.id === "string" ? row.id.trim() : "";
          const name = typeof row.name === "string" ? row.name.trim() : "unknown";
          const channelCount = toFinitePositiveInt(row.channelCount) ?? 0;
          const line = [
            `lookup: server:${id || "n/a"}`,
            `name=${toAnswerPreview(name, 48)}`,
            `channels=${channelCount}`,
          ]
            .filter((part) => part.length > 0)
            .join(" · ");
          lines.push(line);
          await remember({
            lookupKind: "browse_servers",
            found: true,
            serverId: id || null,
            summary: line,
          });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`lookup: servers failed (${toAnswerPreview(message, 120)})`);
      await remember({
        lookupKind: "browse_servers",
        found: false,
        error: toAnswerPreview(message, 180),
      });
    }
  }

  if (BROWSE_CHANNELS_LOOKUP_PATTERN.test(input.retrievalQuery)) {
    try {
      const query = extractLookupQueryTerm(input.retrievalQuery);
      const response = await lookupCall({
        action: "browse_channels",
        ...(query ? { query } : {}),
        limit: 20,
      });
      const rows =
        isRecord(response) && Array.isArray(response.items)
          ? response.items.filter((entry): entry is Record<string, unknown> =>
              isRecord(entry),
            )
          : [];
      if (rows.length === 0) {
        lines.push("lookup: no channels found");
        await remember({
          lookupKind: "browse_channels",
          found: false,
          query,
          summary: "no channels found",
        });
      } else {
        for (const row of rows.slice(0, 5)) {
          const id = typeof row.id === "string" ? row.id.trim() : "";
          const name = typeof row.name === "string" ? row.name.trim() : "unknown";
          const serverName =
            typeof row.serverName === "string" ? row.serverName.trim() : null;
          const line = [
            `lookup: channel:${id || "n/a"}`,
            `name=${toAnswerPreview(name, 48)}`,
            serverName ? `server=${toAnswerPreview(serverName, 36)}` : "",
          ]
            .filter((part) => part.length > 0)
            .join(" · ");
          lines.push(line);
          await remember({
            lookupKind: "browse_channels",
            found: true,
            query,
            channelId: id || null,
            summary: line,
          });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`lookup: channels failed (${toAnswerPreview(message, 120)})`);
      await remember({
        lookupKind: "browse_channels",
        found: false,
        error: toAnswerPreview(message, 180),
      });
    }
  }

  if (BROWSE_MEMBERS_LOOKUP_PATTERN.test(input.retrievalQuery)) {
    try {
      const query = extractLookupQueryTerm(input.retrievalQuery);
      const payload: Record<string, unknown> = {
        action: "browse_members",
        ...(query ? { query } : {}),
        limit: 20,
        includeAgents: true,
        includeHumans: true,
      };
      if (input.entry.conversationId) {
        payload.conversationId = input.entry.conversationId;
      } else {
        const servers = await listServers();
        const first = servers[0];
        if (isRecord(first) && typeof first.id === "string" && first.id.trim().length > 0) {
          payload.serverId = first.id.trim();
        }
      }
      if (!("conversationId" in payload) && !("serverId" in payload)) {
        lines.push("lookup: members lookup needs a chat or server context");
        await remember({
          lookupKind: "browse_members",
          found: false,
          summary: "members lookup missing conversation/server context",
        });
      } else {
        const response = await lookupCall(payload);
        const rows =
          isRecord(response) && Array.isArray(response.items)
            ? response.items.filter((entry): entry is Record<string, unknown> =>
                isRecord(entry),
              )
            : [];
        if (rows.length === 0) {
          lines.push("lookup: no members found for this context");
          await remember({
            lookupKind: "browse_members",
            found: false,
            query,
            summary: "no members found for this context",
          });
        } else {
          for (const row of rows.slice(0, 6)) {
            const handle =
              typeof row.handle === "string" ? row.handle.trim().replace(/^@+/u, "") : "unknown";
            const role = typeof row.role === "string" ? row.role.trim() : null;
            const isAgent = row.isAgent === true;
            const line = [
              `lookup: member=@${handle}`,
              `type=${isAgent ? "agent" : "human"}`,
              role ? `role=${role}` : "",
            ]
              .filter((part) => part.length > 0)
              .join(" · ");
            lines.push(line);
            await remember({
              lookupKind: "browse_members",
              found: true,
              handle,
              role,
              isAgent,
              summary: line,
            });
          }
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`lookup: members failed (${toAnswerPreview(message, 120)})`);
      await remember({
        lookupKind: "browse_members",
        found: false,
        error: toAnswerPreview(message, 180),
      });
    }
  }

  if (BROWSE_LENSES_LOOKUP_PATTERN.test(input.retrievalQuery)) {
    try {
      const query = extractLookupQueryTerm(input.retrievalQuery);
      const response = await lookupCall({
        action: "browse_lenses",
        ...(query ? { query } : {}),
        includeRules: /\b(rule|rules)\b/iu.test(input.retrievalQuery),
        limit: 12,
      });
      const rows =
        isRecord(response) && Array.isArray(response.items)
          ? response.items.filter((entry): entry is Record<string, unknown> =>
              isRecord(entry),
            )
          : [];
      if (rows.length === 0) {
        lines.push("lookup: no lenses found");
        await remember({
          lookupKind: "browse_lenses",
          found: false,
          query,
          summary: "no lenses found",
        });
      } else {
        for (const row of rows.slice(0, 4)) {
          const lensRecord = isRecord(row.lens) ? row.lens : null;
          const lensName =
            lensRecord && typeof lensRecord.name === "string"
              ? lensRecord.name.trim()
              : "unknown";
          const lensId = lensRecord ? toFinitePositiveInt(lensRecord.id) : null;
          const line = [
            `lookup: lens:${lensId ?? "n/a"}`,
            `name=${toAnswerPreview(lensName, 54)}`,
          ]
            .filter((part) => part.length > 0)
            .join(" · ");
          lines.push(line);
          await remember({
            lookupKind: "browse_lenses",
            found: true,
            query,
            lensId,
            summary: line,
          });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`lookup: lenses failed (${toAnswerPreview(message, 120)})`);
      await remember({
        lookupKind: "browse_lenses",
        found: false,
        error: toAnswerPreview(message, 180),
      });
    }
  }

  const wantsAssetBrowse =
    BROWSE_ASSETS_LOOKUP_PATTERN.test(input.retrievalQuery) &&
    !CUSTOM_ASSET_LOOKUP_PATTERN.test(input.retrievalQuery);
  if (wantsAssetBrowse) {
    const assetQuery = extractLookupQueryTerm(input.retrievalQuery);
    try {
      const response = await lookupCall({
        action: "browse_assets",
        ...(assetQuery ? { query: assetQuery } : {}),
        limit: 12,
        includeOwnerSelections: true,
        ...(input.entry.conversationId
          ? { conversationId: input.entry.conversationId }
          : {}),
        ...(input.entry.channelId ? { channelId: input.entry.channelId } : {}),
      });
      const assets = pickCustomAssetRecordsFromLookup(response)
        .map((entry) => summarizeCustomAssetRecord(entry))
        .slice(0, 4);
      if (assets.length === 0) {
        lines.push(
          assetQuery
            ? `lookup: assets for "${assetQuery}" not found`
            : "lookup: no assets found",
        );
        await remember({
          lookupKind: "browse_assets",
          found: false,
          query: assetQuery,
          summary: assetQuery
            ? `assets for "${assetQuery}" not found`
            : "no assets found",
        });
      } else {
        for (const asset of assets) {
          lines.push(`lookup: ${asset.line}`);
          await remember({
            lookupKind: "browse_assets",
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
        `lookup: asset browse failed (${toAnswerPreview(message, 120)})`,
      );
      await remember({
        lookupKind: "browse_assets",
        found: false,
        query: assetQuery,
        error: toAnswerPreview(message, 180),
      });
    }
  }

};
