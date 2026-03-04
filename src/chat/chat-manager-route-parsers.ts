import { toAnswerPreview } from "../lib/text.js";
import type {
  AgentReplyPolicyValue,
  DeterministicRouteParseResult,
  DeterministicRoutePayload,
  DeterministicRouteTargetedPayload,
  DmAutomatedPolicyValue,
  DmPolicyValue,
  ProfileSettingsTarget,
} from "./chat-types.js";
import { parsePostAndCommentHints } from "./chat-manager-context-utils.js";
import {
  BROWSE_AGENT_LOOKUP_PATTERN,
  BROWSE_COMMENT_LOOKUP_PATTERN,
  BROWSE_HOME_FEED_LOOKUP_PATTERN,
  BROWSE_NOTIFICATIONS_LOOKUP_PATTERN,
  BROWSE_POST_LOOKUP_PATTERN,
  BROWSE_TOP_ENGAGERS_LOOKUP_PATTERN,
  LATEST_POST_LOOKUP_PATTERN,
  RESOLVE_REFERENCE_LOOKUP_PATTERN,
  SUGGESTED_FOLLOW_LOOKUP_PATTERN,
  parseHandleMentions,
  parseLookupWindowHours,
} from "./chat-manager-lookup-utils.js";
const RETENTION_BOOL_TRUE_PATTERN =
  /\b(yes|true|enable|enabled|on|confirm|apply)\b/iu;
const RETENTION_BOOL_FALSE_PATTERN =
  /\b(no|false|disable|disabled|off)\b/iu;

const parseBooleanChatInput = (value: string): boolean | null => {
  const normalized = value.trim().toLowerCase();
  if (!normalized.length) return null;
  const hasTrue = RETENTION_BOOL_TRUE_PATTERN.test(normalized);
  const hasFalse = RETENTION_BOOL_FALSE_PATTERN.test(normalized);
  if (hasTrue && !hasFalse) return true;
  if (hasFalse && !hasTrue) return false;
  if (normalized === "y") return true;
  if (normalized === "n") return false;
  return null;
};

export const hasDeterministicRouteTarget = (
  payload: DeterministicRoutePayload,
): payload is DeterministicRouteTargetedPayload =>
  "target" in payload;

const PROFILE_MUTATION_VERB_PATTERN =
  /\b(set|update|change|edit|modify|refresh)\b/iu;
const PROFILE_FIELD_HINT_PATTERN =
  /\b(profile|display\s+name|name|bio|description|about|avatar|pfp|banner|header|cover)\b/iu;
const PROFILE_NAME_HINT_PATTERN =
  /\b(display\s+name|profile\s+name|name)\b/iu;
const PROFILE_BIO_HINT_PATTERN =
  /\b(bio|description|about)\b/iu;
const PROFILE_AVATAR_HINT_PATTERN =
  /\b(avatar|pfp|profile\s+(?:picture|photo|image)|icon)\b/iu;
const PROFILE_BANNER_HINT_PATTERN =
  /\b(banner|header|cover)\b/iu;
const PROFILE_TARGET_OWNER_PATTERN =
  /\b(for\s+me|my\s+(?:profile|account|name|bio|description|avatar|pfp|banner|header|cover)|owner)\b/iu;
const PROFILE_TARGET_AGENT_PATTERN =
  /\b(for\s+yourself|as\s+agent|agent\s+profile|your\s+(?:profile|account|name|bio|description|avatar|pfp|banner|header|cover))\b/iu;

const SETTINGS_MUTATION_VERB_PATTERN =
  /\b(set|update|change|configure|adjust|turn|enable|disable)\b/iu;
const SETTINGS_FIELD_HINT_PATTERN =
  /\b(settings?|read\s+receipts?|dm\s+policy|direct\s+message|online\s+status|presence|default\s+lens|lens\s+id|agent\s+reply\s+policy)\b/iu;
const SETTINGS_TARGET_OWNER_PATTERN =
  /\b(for\s+me|my\s+(?:settings?|account)|owner)\b/iu;
const SETTINGS_TARGET_AGENT_PATTERN =
  /\b(for\s+yourself|as\s+agent|agent\s+settings?|your\s+(?:settings?|account))\b/iu;
const READ_RECEIPTS_HINT_PATTERN = /\bread\s+receipts?\b/iu;
const ONLINE_STATUS_HINT_PATTERN =
  /\b(online\s+status|show\s+online|presence)\b/iu;
const DM_POLICY_HINT_PATTERN =
  /\b(dm\s+policy|direct\s+messages?\s+policy|who\s+can\s+dm)\b/iu;
const DM_AUTOMATED_POLICY_HINT_PATTERN =
  /\b(dm\s+automated\s+policy|automated\s+dm(?:\s+policy)?|bot\s+dm(?:\s+policy)?|agent\s+dm(?:\s+policy)?)\b/iu;
const AGENT_REPLY_POLICY_HINT_PATTERN =
  /\b(agent\s+reply\s+policy|reply\s+policy)\b/iu;
const DEFAULT_LENS_HINT_PATTERN =
  /\b(default\s+lens(?:\s+id)?|lens(?:\s+id)?)\b/iu;
const URL_CAPTURE_PATTERN = /https?:\/\/[^\s)]+/giu;
const FOLLOW_TARGET_OWNER_PATTERN =
  /\b(for\s+me|on\s+my\s+account|as\s+me|owner)\b/iu;
const FOLLOW_TARGET_AGENT_PATTERN =
  /\b(as\s+agent|as\s+yourself|for\s+yourself|on\s+your\s+account)\b/iu;
const FOLLOW_MUTATION_PATTERN = /\b(follow|unfollow)\b/iu;
const UNFOLLOW_MUTATION_PATTERN = /\b(unfollow|stop\s+following)\b/iu;
const FOLLOW_DISCOVERY_PATTERN =
  /\b(find|discover|show|suggest|recommend)\b[\s\S]*\b(follow|accounts?|agents?|users?|creators?)\b|\bwho\s+should\s+(?:i|we|you)\s+follow\b/iu;
const AGENT_PROFILE_LOOKUP_PATTERN =
  /\b(who\s+(?:is|are)\s+your\s+owner|who\s+owns\s+you|show\s+your\s+(?:owner|profile)|agent\s+profile)\b/iu;
const LOOKUP_REQUEST_VERB_PATTERN =
  /\b(find|lookup|show|check|open|get|list|browse|who\s+is|who's)\b/iu;
const USER_LOOKUP_PATTERN =
  /\b(user|profile|account|handle)\b|\bwho\s+is\b|\bwho's\b/iu;

const stripQuotedValue = (value: string): string =>
  value
    .trim()
    .replace(/^[`"'“”‘’]+/u, "")
    .replace(/[`"'“”‘’]+$/u, "")
    .trim();

const stripMutationTail = (value: string): string =>
  value
    .replace(
      /\s+(?:and|plus|,)\s+(?:my|your|the)?\s*(?:name|bio|description|avatar|pfp|banner|header|cover|read\s+receipts?|dm\s+policy|online\s+status|presence|default\s+lens|lens\s+id|agent\s+reply\s+policy)\b[\s\S]*$/iu,
      "",
    )
    .trim();

const extractFirstUrl = (value: string): string | null => {
  const match = URL_CAPTURE_PATTERN.exec(value);
  URL_CAPTURE_PATTERN.lastIndex = 0;
  if (!match?.[0]) return null;
  return match[0].trim();
};

const extractAssignedText = (
  body: string,
  patterns: readonly RegExp[],
  maxChars: number,
): string | null => {
  for (const pattern of patterns) {
    const match = pattern.exec(body);
    const candidateRaw = match?.[1];
    if (!candidateRaw) continue;
    const normalized = stripMutationTail(stripQuotedValue(candidateRaw));
    if (!normalized.length) continue;
    return normalized.slice(0, maxChars);
  }
  return null;
};

const parseProfileTarget = (body: string): ProfileSettingsTarget => {
  if (PROFILE_TARGET_OWNER_PATTERN.test(body)) return "owner";
  if (PROFILE_TARGET_AGENT_PATTERN.test(body)) return "agent";
  return "agent";
};

const parseSettingsTarget = (body: string): ProfileSettingsTarget => {
  if (SETTINGS_TARGET_AGENT_PATTERN.test(body)) return "agent";
  if (SETTINGS_TARGET_OWNER_PATTERN.test(body)) return "owner";
  return "owner";
};

const parseFollowTarget = (body: string): ProfileSettingsTarget => {
  if (FOLLOW_TARGET_OWNER_PATTERN.test(body)) return "owner";
  if (FOLLOW_TARGET_AGENT_PATTERN.test(body)) return "agent";
  return "agent";
};

const parseDiscoveryLimit = (
  body: string,
  fallback = 8,
): number => {
  const match =
    /\b(?:top|first|show|list|give me|find)\s+(\d{1,2})\b/iu.exec(body) ??
    /\b(\d{1,2})\s+(?:accounts?|agents?|users?|people)\b/iu.exec(body);
  const raw = match?.[1];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(20, parsed));
};

const parseFieldBoolean = (body: string): boolean | null => {
  const normalized = body.trim().toLowerCase();
  if (!normalized.length) return null;
  if (/\b(turn|switch|set)\s+off\b/iu.test(normalized)) return false;
  if (/\b(turn|switch|set)\s+on\b/iu.test(normalized)) return true;
  if (/\bhide\b/iu.test(normalized)) return false;
  if (/\bshow\b/iu.test(normalized)) return true;
  return parseBooleanChatInput(normalized);
};

const parseDmPolicyValue = (body: string): DmPolicyValue | null => {
  if (!DM_POLICY_HINT_PATTERN.test(body)) return null;
  const normalized = body.toLowerCase();
  if (/\bmutual(?:\s+only)?\b/iu.test(normalized)) return "mutual_only";
  if (/\bfollowers?\s+only\b|\bonly\s+followers?\b/iu.test(normalized))
    return "followers_only";
  if (
    /\bfollowing\s+only\b|\bonly\s+following\b|\bpeople\s+i\s+follow\b/iu.test(
      normalized,
    )
  ) {
    return "following_only";
  }
  if (/\beveryone\b|\banyone\b|\ball\b/iu.test(normalized)) return "everyone";
  return null;
};

const parseDmAutomatedPolicyValue = (
  body: string,
): DmAutomatedPolicyValue | null => {
  if (!DM_AUTOMATED_POLICY_HINT_PATTERN.test(body)) return null;
  const normalized = body.toLowerCase();
  if (/\bdeny\s+all\b|\bblock\s+all\b|\boff\b|\bnone\b/iu.test(normalized))
    return "deny_all";
  if (
    /\ballow\s+followed\b|\bfollowed\s+only\b|\bfollowing\s+only\b/iu.test(
      normalized,
    )
  ) {
    return "allow_followed";
  }
  if (/\ballow\s+all\b|\beveryone\b|\banyone\b|\bon\b/iu.test(normalized))
    return "allow_all";
  return null;
};

const parseAgentReplyPolicyValue = (
  body: string,
): AgentReplyPolicyValue | null => {
  if (!AGENT_REPLY_POLICY_HINT_PATTERN.test(body)) return null;
  const normalized = body.toLowerCase();
  if (/\bdeny\s+selected\b|\bselected\s+only\b|\ballow\s+selected\b/iu.test(normalized))
    return "deny_selected";
  if (/\bdeny\s+all\b|\boff\b|\bnone\b/iu.test(normalized)) return "deny_all";
  if (/\ballow\s+all\b|\bon\b|\beveryone\b|\banyone\b/iu.test(normalized))
    return "allow_all";
  return null;
};

const parseDefaultLensIdValue = (body: string): number | null | undefined => {
  if (!DEFAULT_LENS_HINT_PATTERN.test(body)) return undefined;
  if (/\b(clear|remove|none|null|off)\b/iu.test(body)) return null;
  const match =
    /\bdefault\s+lens(?:\s+id)?\s*(?:to|as|=|:)?\s*(\d+)\b/iu.exec(body) ??
    /\blens\s+id\s*(?:to|as|=|:)?\s*(\d+)\b/iu.exec(body);
  const raw = match?.[1];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
};

const parseProfileRouteAction = (
  body: string,
): DeterministicRouteParseResult | null => {
  if (
    !PROFILE_MUTATION_VERB_PATTERN.test(body) ||
    !PROFILE_FIELD_HINT_PATTERN.test(body)
  ) {
    return null;
  }
  const name = PROFILE_NAME_HINT_PATTERN.test(body)
    ? extractAssignedText(
        body,
        [
          /\b(?:display\s+name|profile\s+name|name)\s*(?:to|as|=|:)\s*([\s\S]+)$/iu,
          /\bcall\s+(?:me|you)\s+([\s\S]+)$/iu,
          /\b(?:display\s+name|profile\s+name|name)\b\s*["“]([^"”]+)["”]/iu,
        ],
        80,
      )
    : null;
  const bio = PROFILE_BIO_HINT_PATTERN.test(body)
    ? extractAssignedText(
        body,
        [
          /\b(?:bio|description|about)\s*(?:to|as|=|:)\s*([\s\S]+)$/iu,
          /\b(?:bio|description|about)\b\s*["“]([\s\S]+?)["”]/iu,
        ],
        2200,
      )
    : null;
  const imageUrl =
    PROFILE_AVATAR_HINT_PATTERN.test(body) ? extractFirstUrl(body) : null;
  const bannerUrl =
    PROFILE_BANNER_HINT_PATTERN.test(body) ? extractFirstUrl(body) : null;
  const hasAnyUpdate =
    name !== null ||
    bio !== null ||
    typeof imageUrl === "string" ||
    typeof bannerUrl === "string";
  if (!hasAnyUpdate) {
    return {
      kind: "clarify",
      reply:
        "I can apply this directly, but I need exact values. Provide name/bio text or avatar/banner URL.",
    };
  }
  return {
    kind: "action",
    payload: {
      action: "update_profile",
      target: parseProfileTarget(body),
      ...(name !== null ? { name } : {}),
      ...(bio !== null ? { bio } : {}),
      ...(typeof imageUrl === "string" ? { imageUrl } : {}),
      ...(typeof bannerUrl === "string" ? { bannerUrl } : {}),
    },
  };
};

const parseSettingsRouteAction = (
  body: string,
): DeterministicRouteParseResult | null => {
  if (
    !SETTINGS_FIELD_HINT_PATTERN.test(body) ||
    !SETTINGS_MUTATION_VERB_PATTERN.test(body)
  ) {
    return null;
  }
  const readReceipts = READ_RECEIPTS_HINT_PATTERN.test(body)
    ? parseFieldBoolean(body)
    : null;
  const showOnlineStatus = ONLINE_STATUS_HINT_PATTERN.test(body)
    ? parseFieldBoolean(body)
    : null;
  const dmPolicy = parseDmPolicyValue(body);
  const dmAutomatedPolicy = parseDmAutomatedPolicyValue(body);
  const agentReplyPolicy = parseAgentReplyPolicyValue(body);
  const defaultLensId = parseDefaultLensIdValue(body);
  const hasAnyUpdate =
    typeof readReceipts === "boolean" ||
    typeof showOnlineStatus === "boolean" ||
    dmPolicy !== null ||
    dmAutomatedPolicy !== null ||
    agentReplyPolicy !== null ||
    defaultLensId !== undefined;
  if (!hasAnyUpdate) {
    return {
      kind: "clarify",
      reply:
        "I can update settings directly, but I need specific values (for example: read receipts off, dm policy followers only, default lens 12).",
    };
  }
  return {
    kind: "action",
    payload: {
      action: "update_settings",
      target: parseSettingsTarget(body),
      ...(typeof readReceipts === "boolean" ? { readReceipts } : {}),
      ...(typeof showOnlineStatus === "boolean" ? { showOnlineStatus } : {}),
      ...(dmPolicy ? { dmPolicy } : {}),
      ...(dmAutomatedPolicy ? { dmAutomatedPolicy } : {}),
      ...(agentReplyPolicy ? { agentReplyPolicy } : {}),
      ...(defaultLensId !== undefined ? { defaultLensId } : {}),
    },
  };
};

const parseFollowRouteAction = (
  body: string,
): DeterministicRouteParseResult | null => {
  if (!FOLLOW_MUTATION_PATTERN.test(body)) return null;
  if (
    SUGGESTED_FOLLOW_LOOKUP_PATTERN.test(body) ||
    BROWSE_AGENT_LOOKUP_PATTERN.test(body)
  ) {
    return null;
  }
  const handles = parseHandleMentions(body);
  const primaryHandle = handles[0];
  if (!primaryHandle) {
    return {
      kind: "clarify",
      reply: "Tell me which handle to follow or unfollow (example: @dev).",
    };
  }
  if (UNFOLLOW_MUTATION_PATTERN.test(body)) {
    return {
      kind: "action",
      payload: {
        action: "unfollow_user",
        target: parseFollowTarget(body),
        handle: primaryHandle,
      },
    };
  }
  return {
    kind: "action",
    payload: {
      action: "follow_user",
      target: parseFollowTarget(body),
      handle: primaryHandle,
    },
  };
};

const parseSuggestFollowersRouteAction = (
  body: string,
): DeterministicRouteParseResult | null => {
  if (!FOLLOW_DISCOVERY_PATTERN.test(body)) return null;
  return {
    kind: "action",
    payload: {
      action: "suggest_followers",
      includeAgents: true,
      limit: parseDiscoveryLimit(body, 8),
    },
  };
};

const parseBrowseAgentsRouteAction = (
  body: string,
): DeterministicRouteParseResult | null => {
  if (!BROWSE_AGENT_LOOKUP_PATTERN.test(body)) return null;
  return {
    kind: "action",
    payload: {
      action: "browse_agents",
      query: toAnswerPreview(body, 120),
      limit: parseDiscoveryLimit(body, 8),
      includeFollowing: true,
      includeFollowers: true,
      includeRecentPosters: true,
    },
  };
};

const parseAgentProfileLookupRouteAction = (
  body: string,
): DeterministicRouteParseResult | null => {
  if (!AGENT_PROFILE_LOOKUP_PATTERN.test(body)) return null;
  return {
    kind: "action",
    payload: {
      action: "agent_profile",
    },
  };
};

const parseFindUserRouteAction = (
  body: string,
): DeterministicRouteParseResult | null => {
  if (!LOOKUP_REQUEST_VERB_PATTERN.test(body) || !USER_LOOKUP_PATTERN.test(body)) {
    return null;
  }
  const handles = parseHandleMentions(body);
  const primaryHandle = handles[0];
  if (!primaryHandle) return null;
  return {
    kind: "action",
    payload: {
      action: "find_user",
      handle: primaryHandle,
    },
  };
};

const parseFindPostRouteAction = (
  body: string,
): DeterministicRouteParseResult | null => {
  const hints = parsePostAndCommentHints(body);
  const handles = parseHandleMentions(body);
  const primaryHandle = handles[0];
  if (LATEST_POST_LOOKUP_PATTERN.test(body) && primaryHandle) {
    return {
      kind: "action",
      payload: {
        action: "find_post",
        authorHandle: primaryHandle,
        latest: true,
      },
    };
  }
  if (
    typeof hints.postId === "number" &&
    (RESOLVE_REFERENCE_LOOKUP_PATTERN.test(body) ||
      (LOOKUP_REQUEST_VERB_PATTERN.test(body) &&
        /\b(?:post|thread)\b/iu.test(body)))
  ) {
    return {
      kind: "action",
      payload: {
        action: "find_post",
        postId: hints.postId,
      },
    };
  }
  return null;
};

const parseFindCommentRouteAction = (
  body: string,
): DeterministicRouteParseResult | null => {
  const hints = parsePostAndCommentHints(body);
  if (typeof hints.commentId !== "number") return null;
  if (typeof hints.postId !== "number") {
    return {
      kind: "clarify",
      reply:
        "I can look up that comment, but I need the post number too (example: comment 77 on post 12).",
    };
  }
  return {
    kind: "action",
    payload: {
      action: "find_comment",
      postId: hints.postId,
      commentId: hints.commentId,
    },
  };
};

const parseBrowsePostsRouteAction = (
  body: string,
): DeterministicRouteParseResult | null => {
  if (!BROWSE_POST_LOOKUP_PATTERN.test(body)) return null;
  return {
    kind: "action",
    payload: {
      action: "browse_posts",
      limit: parseDiscoveryLimit(body, 8),
    },
  };
};

const parseBrowseCommentsRouteAction = (
  body: string,
): DeterministicRouteParseResult | null => {
  if (!BROWSE_COMMENT_LOOKUP_PATTERN.test(body)) return null;
  const hints = parsePostAndCommentHints(body);
  const searchText = toAnswerPreview(body, 160);
  return {
    kind: "action",
    payload: {
      action: "browse_comments",
      ...(typeof hints.postId === "number" ? { postId: hints.postId } : {}),
      ...(typeof hints.postId !== "number" && searchText.length > 0
        ? { searchText }
        : {}),
      limit: parseDiscoveryLimit(body, 10),
    },
  };
};

const parseBrowseNotificationsRouteAction = (
  body: string,
): DeterministicRouteParseResult | null => {
  if (!BROWSE_NOTIFICATIONS_LOOKUP_PATTERN.test(body)) return null;
  return {
    kind: "action",
    payload: {
      action: "browse_notifications",
      unreadOnly: /\b(unread|unanswered|pending)\b/iu.test(body),
      limit: parseDiscoveryLimit(body, 12),
    },
  };
};

const parseBrowseHomeFeedRouteAction = (
  body: string,
): DeterministicRouteParseResult | null => {
  if (!BROWSE_HOME_FEED_LOOKUP_PATTERN.test(body)) return null;
  return {
    kind: "action",
    payload: {
      action: "browse_home_feed",
      limit: parseDiscoveryLimit(body, 10),
    },
  };
};

const parseBrowseTopEngagersRouteAction = (
  body: string,
): DeterministicRouteParseResult | null => {
  if (!BROWSE_TOP_ENGAGERS_LOOKUP_PATTERN.test(body)) return null;
  return {
    kind: "action",
    payload: {
      action: "browse_top_engagers",
      limit: parseDiscoveryLimit(body, 8),
      windowHours: parseLookupWindowHours(body) ?? 24 * 7,
    },
  };
};

export {
  parseProfileRouteAction,
  parseSettingsRouteAction,
  parseFollowRouteAction,
  parseSuggestFollowersRouteAction,
  parseBrowseAgentsRouteAction,
  parseAgentProfileLookupRouteAction,
  parseFindUserRouteAction,
  parseFindPostRouteAction,
  parseFindCommentRouteAction,
  parseBrowsePostsRouteAction,
  parseBrowseCommentsRouteAction,
  parseBrowseNotificationsRouteAction,
  parseBrowseHomeFeedRouteAction,
  parseBrowseTopEngagersRouteAction,
};
