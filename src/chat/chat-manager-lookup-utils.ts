import { isRecord } from "../lib/guards.js";
import { toAnswerPreview } from "../lib/text.js";
import type { ContextBundle, RetrievalIntent } from "../types/memory.js";
import type { ChatInboxEntry } from "./chat-reply.js";

const clampInt = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.floor(value)));

export const ENGAGEMENT_RETRIEVAL_PATTERN =
  /\b(like|likes|comment|comments|reply|replies|repost|reposts|quote|follow|follows|engage|engagement|interact|interaction|views?|impressions?|timeline|feed|trending|viral)\b/iu;

export const SITE_LOOKUP_TRIGGER_PATTERN =
  /\b(post|posts|comment|comments|likes?|views?|reposts?|engagement|followers?|following|draft|directive|timeline|feed|recent|latest|newest|last|who viewed|who liked|gif|gifs|meme|reaction|emote|emotes|sticker|stickers|emoji|asset|assets|account|accounts|users?|agents?|discover|recommend|suggest|browse|explore|trending)\b/iu;

export const LOOKUP_FORCE_PATTERN =
  /\b(not found|never found|can't find|cant find|where (?:is|did)|show me|what happened to|pull it|fetch it)\b/iu;

export const LATEST_POST_LOOKUP_PATTERN =
  /\b(most\s+recent|latest|newest|last)\s+post\b/iu;

export const COMMENT_LOOKUP_PATTERN = /\bcomments?\b/iu;
export const FOLLOW_LOOKUP_PATTERN = /\bfollow(?:er|ers|ing)?\b/iu;
export const SUGGESTED_FOLLOW_LOOKUP_PATTERN =
  /\b(suggest|recommended?|recommend|discover|find)\b[\s\S]*\b(follow|accounts?|people|users?|agents?|creators?|vibe)\b|\bwho\s+should\s+(?:i|we|you)\s+follow\b/iu;
export const BROWSE_POST_LOOKUP_PATTERN =
  /\b(browse|explore|discover|trending|doom\s*scroll|look\s+around)\b[\s\S]*\b(feed|posts?|timeline|platform|around)\b|\bwhat(?:'s| is)\s+trending\b/iu;
export const BROWSE_COMMENT_LOOKUP_PATTERN =
  /\b(browse|explore|discover|read|scan|find|show|look\s+at)\b[\s\S]*\b(comments?|replies?|threads?)\b|\bwhat\s+are\s+people\s+saying\b/iu;
export const BROWSE_AGENT_LOOKUP_PATTERN =
  /\b(browse|explore|discover|find|show)\b[\s\S]*\b(agents?|bots?|creators?)\b|\bagents?\s+(?:to\s+follow|you(?:'d| would)?\s+vibe)\b/iu;
export const GIF_LOOKUP_PATTERN = /\b(gif|gifs|meme|reaction)\b/iu;
export const CUSTOM_ASSET_LOOKUP_PATTERN =
  /\b(emote|emotes|sticker|stickers|gif|gifs|reaction|reactions|emoji|asset|assets)\b/iu;
export const BROWSE_NOTIFICATIONS_LOOKUP_PATTERN =
  /\b(notification|notifications|mention|mentions|unread|inbox|alerts?)\b/iu;
export const BROWSE_HOME_FEED_LOOKUP_PATTERN =
  /\b(home\s+feed|my\s+feed|following\s+feed|for\s+you\s+feed|home\s+timeline)\b/iu;
export const BROWSE_TRENDING_LOOKUP_PATTERN =
  /\b(trending|explore|discover|what(?:'s| is)\s+hot|what(?:'s| is)\s+popular)\b/iu;
export const BROWSE_POST_ACTIVITY_LOOKUP_PATTERN =
  /\bpost\b[\s\S]{0,80}\b(activity|engagement|likes?|reposts?|comments?|views?)\b|\bwho\s+(?:liked|reposted|commented|viewed)\b/iu;
export const BROWSE_COMMENT_ACTIVITY_LOOKUP_PATTERN =
  /\bcomment\b[\s\S]{0,80}\b(activity|engagement|replies?|likes?|views?)\b|\bwho\s+(?:replied|viewed)\b[\s\S]{0,40}\bcomment\b/iu;
export const BROWSE_TOP_ENGAGERS_LOOKUP_PATTERN =
  /\b(top|biggest|best|most)\b[\s\S]{0,40}\b(engagers?|engagement|supporters|fans)\b/iu;
export const BROWSE_UNANSWERED_MENTIONS_LOOKUP_PATTERN =
  /\b(unanswered|unreplied|pending)\b[\s\S]{0,40}\b(mentions?|tags?)\b|\bmentions?\s+i\s+(?:haven't|have not)\s+answered\b/iu;
export const BROWSE_DRAFTS_LOOKUP_PATTERN = /\b(draft|drafts|wip|unfinished)\b/iu;
export const BROWSE_DIRECTIVE_QUEUE_LOOKUP_PATTERN =
  /\b(directive|queue|queued|pending\s+actions?|scheduled\s+actions?)\b/iu;
export const BROWSE_SERVERS_LOOKUP_PATTERN =
  /\b(server|servers|guild|guilds|community|communities)\b/iu;
export const BROWSE_CHANNELS_LOOKUP_PATTERN = /\b(channel|channels|room|rooms)\b/iu;
export const BROWSE_MEMBERS_LOOKUP_PATTERN =
  /\b(member|members|participants?|people|users?)\b[\s\S]{0,40}\b(chat|dm|group|server|channel|conversation|here)\b|\bwho(?:'s| is)\s+here\b/iu;
export const BROWSE_LENSES_LOOKUP_PATTERN =
  /\b(lens|lenses|filter|filters)\b/iu;
export const BROWSE_ASSETS_LOOKUP_PATTERN =
  /\b(asset|assets|library|vault|media\s+library)\b/iu;
export const SEARCH_GLOBAL_LOOKUP_PATTERN =
  /\b(search|lookup|find)\b[\s\S]{0,40}\b(platform|global|site|everywhere)\b/iu;
export const RESOLVE_REFERENCE_LOOKUP_PATTERN =
  /\b(resolve|reference|lookup|check|open)\b[\s\S]{0,40}\b(post|comment|message|thread)\b|(?:\bpost(?:\s+number)?\s*#?\s*\d+\b)|(?:\bcomment(?:\s+number)?\s*#?\s*\d+\b)|(?:\/(?:post|comment)\/\d+\b)|(?:^|\s)#\d+\b/iu;
export const BROWSE_RECENT_ACTIONS_LOOKUP_PATTERN =
  /\b(recent|last)\b[\s\S]{0,40}\b(actions?|events?|audits?|logs?)\b/iu;

export const toFinitePositiveInt = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
};

export const parseHandleMentions = (value: string): string[] => {
  const handles = Array.from(value.matchAll(/@([a-z0-9_.-]+)/giu))
    .map((match) => (match[1] ?? "").trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return [...new Set(handles)];
};

export const extractGifSearchQuery = (value: string): string | null => {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized.length) return null;
  const slashMatch = /^\/(?:gif|gifs)\s+(.+)$/iu.exec(normalized);
  if (slashMatch?.[1]) {
    return toAnswerPreview(slashMatch[1], 120);
  }
  const afterGifMatch =
    /\b(?:gif|gifs|meme|reaction)\b(?:\s+(?:of|for|about))?\s+(.+)/iu.exec(normalized);
  if (afterGifMatch?.[1]) {
    return toAnswerPreview(afterGifMatch[1], 120);
  }
  const softened = normalized.replace(
    /\b(?:show|find|search|look|lookup|pull|fetch|get|give|send|share|checkout|check out)\b/giu,
    " ",
  );
  const compact = softened.replace(/\s+/gu, " ").trim();
  if (!compact.length) return null;
  if (/^(?:gif|gifs|meme|reaction)$/iu.test(compact)) return null;
  return toAnswerPreview(compact, 120);
};

export const extractCustomAssetSearchQuery = (value: string): string | null => {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized.length) return null;
  const directMatch =
    /\b(?:emote|sticker|gif|reaction|emoji|asset)s?\b(?:\s+(?:named|called|for|of|about|with))?\s+(.+)/iu.exec(
      normalized,
    );
  if (directMatch?.[1]) {
    return toAnswerPreview(directMatch[1], 140);
  }
  const softened = normalized.replace(
    /\b(?:show|find|search|lookup|look|pull|fetch|get|give|send|share|use|drop|react|with|my)\b/giu,
    " ",
  );
  const compact = softened
    .replace(/\b(?:emote|emotes|sticker|stickers|gif|gifs|reaction|reactions|emoji|asset|assets)\b/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!compact.length) return null;
  return toAnswerPreview(compact, 140);
};

export const extractLookupQueryTerm = (value: string): string | null => {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized.length) return null;
  const cleaned = normalized
    .replace(
      /\b(?:show|find|search|lookup|look|pull|fetch|get|give|send|share|browse|explore|discover|check|checkout|who|what|where|when|why|how|please|can you|could you|would you|for me|for us)\b/giu,
      " ",
    )
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned.length) return null;
  return toAnswerPreview(cleaned, 140);
};

export const parseLookupWindowHours = (value: string): number | null => {
  const normalized = value.toLowerCase();
  const parseBy = (pattern: RegExp, multiplier: number): number | null => {
    const match = pattern.exec(normalized);
    if (!match?.[1]) return null;
    const raw = Number.parseFloat(match[1]);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return clampInt(Math.round(raw * multiplier), 1, 24 * 30);
  };
  const hours =
    parseBy(/\b(?:last|past)\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/iu, 1) ??
    parseBy(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/iu, 1);
  if (hours !== null) return hours;
  const days =
    parseBy(/\b(?:last|past)\s+(\d+(?:\.\d+)?)\s*(?:days?|d)\b/iu, 24) ??
    parseBy(/\b(\d+(?:\.\d+)?)\s*(?:days?|d)\b/iu, 24);
  if (days !== null) return days;
  const weeks =
    parseBy(/\b(?:last|past)\s+(\d+(?:\.\d+)?)\s*(?:weeks?|w)\b/iu, 24 * 7) ??
    parseBy(/\b(\d+(?:\.\d+)?)\s*(?:weeks?|w)\b/iu, 24 * 7);
  if (weeks !== null) return weeks;
  if (/\b(today|last\s+24\s*hours?|past\s+24\s*hours?)\b/iu.test(normalized)) {
    return 24;
  }
  if (/\b(this\s+week|last\s+week)\b/iu.test(normalized)) return 24 * 7;
  if (/\b(this\s+month|last\s+month)\b/iu.test(normalized)) return 24 * 30;
  return null;
};

export const parseRetrievalHitCount = (bundle: ContextBundle): number => {
  if (
    !isRecord(bundle.retrieval) ||
    !Array.isArray(bundle.retrieval.lines) ||
    bundle.retrieval.lines.length === 0
  ) {
    return 0;
  }
  for (const line of bundle.retrieval.lines) {
    if (typeof line !== "string") continue;
    const match = /\bhits=(\d+)\b/iu.exec(line);
    if (!match?.[1]) continue;
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
};

export const pickPostRecordFromLookup = (
  value: unknown,
): Record<string, unknown> | null => {
  if (!isRecord(value)) return null;
  if (isRecord(value.post)) return value.post;
  if (Array.isArray(value.items)) {
    const first = value.items.find((entry) => isRecord(entry));
    if (isRecord(first)) return first;
  }
  return value;
};

export const pickPostRecordsFromLookup = (
  value: unknown,
): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is Record<string, unknown> =>
      isRecord(entry),
    );
  }
  if (!isRecord(value)) return [];
  if (Array.isArray(value.items)) {
    return value.items.filter((entry): entry is Record<string, unknown> =>
      isRecord(entry),
    );
  }
  if (isRecord(value.post)) return [value.post];
  return [value];
};

export const pickCommentRecordsFromLookup = (
  value: unknown,
): Array<Record<string, unknown>> => {
  if (!isRecord(value)) return [];
  if (isRecord(value.comment)) return [value.comment];
  if (Array.isArray(value.items)) {
    return value.items.filter((entry): entry is Record<string, unknown> =>
      isRecord(entry),
    );
  }
  if (Array.isArray(value.comments)) {
    return value.comments.filter((entry): entry is Record<string, unknown> =>
      isRecord(entry),
    );
  }
  return [value];
};

export const summarizePostRecord = (
  value: Record<string, unknown>,
): { line: string; postId: number | null; bodyPreview: string | null } => {
  const postId = toFinitePositiveInt(value.id);
  const author = isRecord(value.author) ? value.author : null;
  const authorHandleRaw =
    (author && typeof author.handle === "string" ? author.handle : "") ||
    (typeof value.authorHandle === "string" ? value.authorHandle : "");
  const authorHandle = authorHandleRaw.trim().replace(/^@+/u, "");
  const createdAt =
    typeof value.createdAt === "string" && value.createdAt.trim().length > 0
      ? value.createdAt.trim()
      : "n/a";
  const textRaw =
    (typeof value.caption === "string" ? value.caption : "") ||
    (typeof value.textBody === "string" ? value.textBody : "") ||
    (typeof value.body === "string" ? value.body : "");
  const bodyPreview = textRaw.trim().length > 0
    ? toAnswerPreview(textRaw, 140)
    : null;
  const likeCount = toFinitePositiveInt(value.likeCount) ?? 0;
  const commentCount = toFinitePositiveInt(value.commentCount) ?? 0;
  const repostCount = toFinitePositiveInt(value.repostCount) ?? 0;
  const viewCount = toFinitePositiveInt(value.viewCount) ?? 0;
  const line = [
    `post:${postId ?? "n/a"}`,
    authorHandle.length > 0 ? `author=@${authorHandle}` : "",
    `likes=${likeCount}`,
    `comments=${commentCount}`,
    `reposts=${repostCount}`,
    `views=${viewCount}`,
    `createdAt=${createdAt}`,
    bodyPreview ? `summary=${bodyPreview}` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
  return { line, postId, bodyPreview };
};

export const summarizeCommentRecord = (
  value: Record<string, unknown>,
): {
  line: string;
  postId: number | null;
  commentId: number | null;
  bodyPreview: string | null;
} => {
  const commentId = toFinitePositiveInt(value.id);
  const postId = toFinitePositiveInt(value.postId);
  const author = isRecord(value.author) ? value.author : null;
  const authorHandleRaw =
    (author && typeof author.handle === "string" ? author.handle : "") ||
    (typeof value.authorHandle === "string" ? value.authorHandle : "");
  const authorHandle = authorHandleRaw.trim().replace(/^@+/u, "");
  const createdAt =
    typeof value.createdAt === "string" && value.createdAt.trim().length > 0
      ? value.createdAt.trim()
      : "n/a";
  const bodyRaw =
    (typeof value.body === "string" ? value.body : "") ||
    (typeof value.textBody === "string" ? value.textBody : "");
  const bodyPreview = bodyRaw.trim().length > 0
    ? toAnswerPreview(bodyRaw, 140)
    : null;
  const likeCount = toFinitePositiveInt(value.likeCount) ?? 0;
  const viewCount = toFinitePositiveInt(value.viewCount) ?? 0;
  const replyCount = toFinitePositiveInt(value.replyCount) ?? 0;
  const line = [
    `comment:${commentId ?? "n/a"}`,
    `post:${postId ?? "n/a"}`,
    authorHandle.length > 0 ? `author=@${authorHandle}` : "",
    `likes=${likeCount}`,
    `views=${viewCount}`,
    `replies=${replyCount}`,
    `createdAt=${createdAt}`,
    bodyPreview ? `summary=${bodyPreview}` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
  return { line, postId, commentId, bodyPreview };
};

export const pickUserRecordsFromLookup = (
  value: unknown,
): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is Record<string, unknown> =>
      isRecord(entry),
    );
  }
  if (!isRecord(value)) return [];
  if (isRecord(value.user)) return [value.user];
  if (Array.isArray(value.items)) {
    return value.items.filter((entry): entry is Record<string, unknown> =>
      isRecord(entry),
    );
  }
  return [value];
};

export const summarizeUserRecord = (
  value: Record<string, unknown>,
): {
  line: string;
  handle: string | null;
  userId: string | null;
  reason: string | null;
} => {
  const userId =
    typeof value.id === "string" && value.id.trim().length > 0
      ? value.id.trim()
      : null;
  const handleRaw =
    typeof value.handle === "string" && value.handle.trim().length > 0
      ? value.handle.trim()
      : "";
  const handle = handleRaw.replace(/^@+/u, "");
  const name =
    typeof value.name === "string" && value.name.trim().length > 0
      ? toAnswerPreview(value.name.trim(), 42)
      : null;
  const reason =
    typeof value.reason === "string" && value.reason.trim().length > 0
      ? toAnswerPreview(value.reason.trim(), 68)
      : null;
  const mutualCount = toFinitePositiveInt(value.mutualCount);
  const score =
    typeof value.score === "number" && Number.isFinite(value.score)
      ? value.score.toFixed(2)
      : null;
  const isAgent = value.isAgent === true;
  const line = [
    `user:@${handle.length > 0 ? handle : "unknown"}`,
    name ? `name=${name}` : "",
    reason ? `reason=${reason}` : "",
    typeof mutualCount === "number" ? `mutuals=${mutualCount}` : "",
    score ? `score=${score}` : "",
    `type=${isAgent ? "agent" : "human"}`,
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
  return {
    line,
    handle: handle.length > 0 ? handle : null,
    userId,
    reason,
  };
};

export const pickGifRecordsFromLookup = (
  value: unknown,
): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is Record<string, unknown> => isRecord(entry));
  }
  if (!isRecord(value)) return [];
  if (Array.isArray(value.items)) {
    return value.items.filter((entry): entry is Record<string, unknown> => isRecord(entry));
  }
  return [value];
};

export const summarizeGifRecord = (
  value: Record<string, unknown>,
): { line: string; id: string | null; url: string | null; title: string | null } => {
  const id = typeof value.id === "string" && value.id.trim().length > 0 ? value.id.trim() : null;
  const url = typeof value.url === "string" && value.url.trim().length > 0 ? value.url.trim() : null;
  const previewUrl =
    typeof value.previewUrl === "string" && value.previewUrl.trim().length > 0
      ? value.previewUrl.trim()
      : null;
  const titleRaw =
    typeof value.title === "string" && value.title.trim().length > 0
      ? value.title.trim()
      : "";
  const width = toFinitePositiveInt(value.width);
  const height = toFinitePositiveInt(value.height);
  const title = titleRaw.length > 0 ? toAnswerPreview(titleRaw, 60) : null;
  const line = [
    `gif:${id ?? "n/a"}`,
    title ? `title=${title}` : "",
    width && height ? `size=${width}x${height}` : "",
    url ? `url=${url}` : "",
    !url && previewUrl ? `preview=${previewUrl}` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
  return { line, id, url: url ?? previewUrl, title };
};

export const pickCustomAssetRecordsFromLookup = (
  value: unknown,
): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is Record<string, unknown> =>
      isRecord(entry),
    );
  }
  if (!isRecord(value)) return [];
  if (Array.isArray(value.items)) {
    return value.items.filter((entry): entry is Record<string, unknown> =>
      isRecord(entry),
    );
  }
  return [value];
};

export const summarizeCustomAssetRecord = (value: Record<string, unknown>): {
  line: string;
  kind: string | null;
  name: string | null;
  owner: string | null;
  source: string | null;
  url: string | null;
} => {
  const kindRaw =
    typeof value.kind === "string" && value.kind.trim().length > 0
      ? value.kind.trim().toLowerCase()
      : null;
  const kind =
    kindRaw === "emote" || kindRaw === "sticker" || kindRaw === "gif"
      ? kindRaw
      : null;
  const name =
    typeof value.name === "string" && value.name.trim().length > 0
      ? toAnswerPreview(value.name.trim(), 42)
      : null;
  const ownerRaw =
    typeof value.owner === "string" && value.owner.trim().length > 0
      ? value.owner.trim().toLowerCase()
      : null;
  const owner = ownerRaw === "agent" || ownerRaw === "owner" ? ownerRaw : null;
  const source =
    typeof value.source === "string" && value.source.trim().length > 0
      ? value.source.trim().toLowerCase()
      : null;
  const urlRaw =
    (typeof value.previewUrl === "string" && value.previewUrl.trim().length > 0
      ? value.previewUrl
      : typeof value.url === "string" && value.url.trim().length > 0
        ? value.url
        : null) ?? null;
  const url = urlRaw ? urlRaw.trim() : null;
  const score =
    typeof value.score === "number" && Number.isFinite(value.score)
      ? value.score.toFixed(0)
      : null;
  const line = [
    `${kind ?? "asset"}:${name ?? "unnamed"}`,
    owner ? `owner=${owner}` : "",
    source ? `source=${source}` : "",
    score ? `score=${score}` : "",
    url ? `url=${url}` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
  return { line, kind, name, owner, source, url };
};

export const resolveRetrievalIntentForEntry = ({
  entry,
  hints,
  retrievalQuery,
}: {
  entry: ChatInboxEntry;
  hints: { postId?: number; commentId?: number };
  retrievalQuery: string;
}): RetrievalIntent => {
  const actionFamily = (entry.serverIntentActionFamily ?? "").trim().toLowerCase();
  if (entry.commandKind !== "none") return "directive";
  if (actionFamily.length > 0 && actionFamily !== "conversation") {
    if (/(engagement|social|reaction|follow)/iu.test(actionFamily)) {
      return "engagement";
    }
    return "directive";
  }

  const hasTargetHint =
    typeof hints.postId === "number" || typeof hints.commentId === "number";
  if (
    hasTargetHint &&
    ENGAGEMENT_RETRIEVAL_PATTERN.test(
      `${entry.body.trim()} ${retrievalQuery.trim()}`.trim(),
    )
  ) {
    return "engagement";
  }
  if (ENGAGEMENT_RETRIEVAL_PATTERN.test(entry.body)) return "engagement";
  return "chat";
};
