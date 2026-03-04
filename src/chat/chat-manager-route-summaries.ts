import { isRecord } from "../lib/guards.js";
import type {
  DeterministicRoutePayload,
  DeterministicRouteTargetedPayload,
} from "./chat-types.js";
import {
  pickCommentRecordsFromLookup,
  pickPostRecordFromLookup,
  pickPostRecordsFromLookup,
  pickUserRecordsFromLookup,
  summarizeCommentRecord,
  summarizePostRecord,
  summarizeUserRecord,
  toFinitePositiveInt,
} from "./chat-manager-lookup-utils.js";

const hasDeterministicRouteTarget = (
  payload: DeterministicRoutePayload,
): payload is DeterministicRouteTargetedPayload =>
  "target" in payload;

export const summarizeProfileRouteSuccess = (
  payload: DeterministicRoutePayload,
  response: unknown,
): string => {
  if (payload.action !== "update_profile" || !hasDeterministicRouteTarget(payload)) {
    return "Profile update applied.";
  }
  const targetLabel = payload.target === "owner" ? "owner" : "agent";
  const responseRecord = isRecord(response) ? response : null;
  const userRecord =
    responseRecord && isRecord(responseRecord.user) ? responseRecord.user : null;
  const handleRaw =
    userRecord && typeof userRecord.handle === "string" ? userRecord.handle.trim() : "";
  const normalizedHandle = handleRaw.replace(/^@+/u, "");
  const updatedFields: string[] = [];
  if (payload.action === "update_profile" && payload.name !== undefined)
    updatedFields.push("name");
  if (payload.action === "update_profile" && payload.bio !== undefined)
    updatedFields.push("bio");
  if (payload.action === "update_profile" && payload.imageUrl !== undefined)
    updatedFields.push("avatar");
  if (payload.action === "update_profile" && payload.bannerUrl !== undefined)
    updatedFields.push("banner");
  return `Updated ${targetLabel} profile${
    normalizedHandle.length > 0 ? ` (@${normalizedHandle})` : ""
  }: ${updatedFields.join(", ")}.`;
};

export const summarizeSettingsRouteSuccess = (
  payload: DeterministicRoutePayload,
  response: unknown,
): string => {
  if (payload.action !== "update_settings" || !hasDeterministicRouteTarget(payload)) {
    return "Settings update applied.";
  }
  const targetLabel = payload.target === "owner" ? "owner" : "agent";
  const responseRecord = isRecord(response) ? response : null;
  const settingsRecord =
    responseRecord && isRecord(responseRecord.settings) ? responseRecord.settings : null;
  const settingSummaries: string[] = [];
  if (payload.action === "update_settings" && payload.defaultLensId !== undefined) {
    const value =
      settingsRecord && typeof settingsRecord.defaultLensId === "number"
        ? settingsRecord.defaultLensId
        : payload.defaultLensId;
    settingSummaries.push(
      value === null ? "defaultLens=none" : `defaultLens=${String(value)}`,
    );
  }
  if (payload.action === "update_settings" && payload.readReceipts !== undefined) {
    const value =
      settingsRecord && typeof settingsRecord.readReceipts === "boolean"
        ? settingsRecord.readReceipts
        : payload.readReceipts;
    settingSummaries.push(`readReceipts=${value ? "on" : "off"}`);
  }
  if (payload.action === "update_settings" && payload.dmPolicy !== undefined) {
    const value =
      settingsRecord && typeof settingsRecord.dmPolicy === "string"
        ? settingsRecord.dmPolicy
        : payload.dmPolicy;
    settingSummaries.push(`dmPolicy=${value}`);
  }
  if (
    payload.action === "update_settings" &&
    payload.dmAutomatedPolicy !== undefined
  ) {
    const value =
      settingsRecord && typeof settingsRecord.dmAutomatedPolicy === "string"
        ? settingsRecord.dmAutomatedPolicy
        : payload.dmAutomatedPolicy;
    settingSummaries.push(`dmAutomatedPolicy=${value}`);
  }
  if (
    payload.action === "update_settings" &&
    payload.agentReplyPolicy !== undefined
  ) {
    const value =
      settingsRecord && typeof settingsRecord.agentReplyPolicy === "string"
        ? settingsRecord.agentReplyPolicy
        : payload.agentReplyPolicy;
    settingSummaries.push(`agentReplyPolicy=${value}`);
  }
  if (
    payload.action === "update_settings" &&
    payload.showOnlineStatus !== undefined
  ) {
    const value =
      settingsRecord && typeof settingsRecord.showOnlineStatus === "boolean"
        ? settingsRecord.showOnlineStatus
        : payload.showOnlineStatus;
    settingSummaries.push(`showOnlineStatus=${value ? "on" : "off"}`);
  }
  return `Updated ${targetLabel} settings: ${settingSummaries.join(", ")}.`;
};

export const summarizeFollowRouteSuccess = (
  payload: DeterministicRoutePayload,
  response: unknown,
): string => {
  if (payload.action !== "follow_user" && payload.action !== "unfollow_user") {
    return "Follow action completed.";
  }
  const responseRecord = isRecord(response) ? response : null;
  const userRecord =
    responseRecord && isRecord(responseRecord.user) ? responseRecord.user : null;
  const handleRaw =
    userRecord && typeof userRecord.handle === "string" ? userRecord.handle.trim() : "";
  const normalizedHandle =
    handleRaw.length > 0
      ? handleRaw.replace(/^@+/u, "")
      : typeof payload.handle === "string"
        ? payload.handle.replace(/^@+/u, "")
        : "unknown";
  const accountLabel =
    payload.target === "owner" ? "owner account" : "agent account";
  if (payload.action === "unfollow_user") {
    const removed =
      responseRecord && typeof responseRecord.removed === "boolean"
        ? responseRecord.removed
        : true;
    if (!removed) {
      return `@${normalizedHandle} was already not followed on ${accountLabel}.`;
    }
    return `Unfollowed @${normalizedHandle} on ${accountLabel}.`;
  }
  const created =
    responseRecord && typeof responseRecord.created === "boolean"
      ? responseRecord.created
      : true;
  if (!created) {
    return `Already following @${normalizedHandle} on ${accountLabel}.`;
  }
  return `Now following @${normalizedHandle} on ${accountLabel}.`;
};

export const summarizeFollowDiscoveryRouteSuccess = (
  payload: DeterministicRoutePayload,
  response: unknown,
): string => {
  if (
    payload.action !== "suggest_followers" &&
    payload.action !== "browse_agents"
  ) {
    return "Lookup completed.";
  }
  const responseRecord = isRecord(response) ? response : null;
  const rows = Array.isArray(responseRecord?.items)
    ? responseRecord.items
    : [];
  const handles = rows
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .map((entry) =>
      typeof entry.handle === "string"
        ? entry.handle.trim().replace(/^@+/u, "")
        : "",
    )
    .filter((entry) => entry.length > 0)
    .slice(0, 6);
  if (handles.length === 0) {
    return "I couldn’t find good follow suggestions right now.";
  }
  return `Top follow suggestions: ${handles.map((handle) => `@${handle}`).join(", ")}.`;
};

export const summarizeAgentProfileLookupSuccess = (
  _payload: DeterministicRoutePayload,
  response: unknown,
): string => {
  const responseRecord = isRecord(response) ? response : null;
  const owner =
    responseRecord && isRecord(responseRecord.owner) ? responseRecord.owner : null;
  const agent =
    responseRecord && isRecord(responseRecord.agent) ? responseRecord.agent : null;
  const ownerHandleRaw =
    owner && typeof owner.handle === "string" ? owner.handle.trim() : "";
  const agentHandleRaw =
    agent && typeof agent.handle === "string" ? agent.handle.trim() : "";
  const ownerHandle = ownerHandleRaw.replace(/^@+/u, "");
  const agentHandle = agentHandleRaw.replace(/^@+/u, "");
  if (!ownerHandle.length && !agentHandle.length) {
    return "I couldn’t resolve owner/profile linkage right now.";
  }
  if (!ownerHandle.length) {
    return `Agent profile is @${agentHandle}. Owner linkage was not available.`;
  }
  if (!agentHandle.length) {
    return `Owner is @${ownerHandle}.`;
  }
  return `Owner is @${ownerHandle}. Agent profile is @${agentHandle}.`;
};

export const summarizeFindUserRouteSuccess = (
  _payload: DeterministicRoutePayload,
  response: unknown,
): string => {
  const users = pickUserRecordsFromLookup(response).map((entry) => summarizeUserRecord(entry));
  const first = users[0];
  if (!first) return "I couldn’t find that account.";
  const handleLabel = first.handle ? `@${first.handle}` : "that account";
  const reasonText = first.reason ? ` ${first.reason}.` : "";
  return `Found ${handleLabel}.${reasonText}`.trim();
};

export const summarizeFindPostRouteSuccess = (
  _payload: DeterministicRoutePayload,
  response: unknown,
): string => {
  const post = pickPostRecordFromLookup(response);
  if (!post) return "I couldn’t find that post.";
  const summary = summarizePostRecord(post);
  return `Found ${summary.line}.`;
};

export const summarizeFindCommentRouteSuccess = (
  _payload: DeterministicRoutePayload,
  response: unknown,
): string => {
  const comments = pickCommentRecordsFromLookup(response).map((entry) =>
    summarizeCommentRecord(entry),
  );
  const first = comments[0];
  if (!first) return "I couldn’t find that comment.";
  return `Found ${first.line}.`;
};

export const summarizeBrowsePostsRouteSuccess = (
  _payload: DeterministicRoutePayload,
  response: unknown,
): string => {
  const posts = pickPostRecordsFromLookup(response)
    .map((entry) => summarizePostRecord(entry))
    .slice(0, 3);
  if (posts.length === 0) return "No posts found right now.";
  return `Top posts: ${posts.map((entry) => entry.line).join(" | ")}.`;
};

export const summarizeBrowseCommentsRouteSuccess = (
  _payload: DeterministicRoutePayload,
  response: unknown,
): string => {
  const comments = pickCommentRecordsFromLookup(response)
    .map((entry) => summarizeCommentRecord(entry))
    .slice(0, 3);
  if (comments.length === 0) return "No comments found for that request.";
  return `Top comments: ${comments.map((entry) => entry.line).join(" | ")}.`;
};

export const summarizeBrowseNotificationsRouteSuccess = (
  _payload: DeterministicRoutePayload,
  response: unknown,
): string => {
  const responseRecord = isRecord(response) ? response : null;
  const rows = Array.isArray(responseRecord?.items)
    ? responseRecord.items.filter((entry): entry is Record<string, unknown> =>
        isRecord(entry),
      )
    : [];
  if (rows.length === 0) return "No matching notifications right now.";
  const summaries = rows.slice(0, 4).map((row) => {
    const actor =
      isRecord(row.actor) && typeof row.actor.handle === "string"
        ? row.actor.handle.trim().replace(/^@+/u, "")
        : null;
    const type =
      typeof row.type === "string" && row.type.trim().length > 0
        ? row.type.trim()
        : "event";
    const read = typeof row.readAt === "string" && row.readAt.trim().length > 0;
    return `${type}${actor ? ` from @${actor}` : ""}${read ? " (read)" : " (unread)"}`;
  });
  return `Notifications: ${summaries.join("; ")}.`;
};

export const summarizeBrowseTopEngagersRouteSuccess = (
  _payload: DeterministicRoutePayload,
  response: unknown,
): string => {
  const responseRecord = isRecord(response) ? response : null;
  const rows = Array.isArray(responseRecord?.items)
    ? responseRecord.items.filter((entry): entry is Record<string, unknown> =>
        isRecord(entry),
      )
    : [];
  if (rows.length === 0) return "No top engagers found for that window.";
  const summaries = rows.slice(0, 4).map((row) => {
    const handle =
      isRecord(row.user) && typeof row.user.handle === "string"
        ? row.user.handle.trim().replace(/^@+/u, "")
        : "unknown";
    const score =
      typeof row.score === "number" && Number.isFinite(row.score)
        ? Math.round(row.score)
        : (toFinitePositiveInt(row.commentCount) ?? 0) * 3 +
          (toFinitePositiveInt(row.repostCount) ?? 0) * 2 +
          (toFinitePositiveInt(row.likeCount) ?? 0) * 2 +
          (toFinitePositiveInt(row.viewCount) ?? 0);
    return `@${handle} (score ${score})`;
  });
  return `Top engagers: ${summaries.join(", ")}.`;
};
