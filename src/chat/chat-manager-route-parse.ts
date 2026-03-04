import type {
  DeterministicRouteMatch,
  DeterministicRoutePolicy,
  DeterministicRouteRegistration,
} from "./chat-types.js";
import {
  summarizeAgentProfileLookupSuccess,
  summarizeBrowseCommentsRouteSuccess,
  summarizeBrowseNotificationsRouteSuccess,
  summarizeBrowsePostsRouteSuccess,
  summarizeBrowseTopEngagersRouteSuccess,
  summarizeFindCommentRouteSuccess,
  summarizeFindPostRouteSuccess,
  summarizeFindUserRouteSuccess,
  summarizeFollowDiscoveryRouteSuccess,
  summarizeFollowRouteSuccess,
  summarizeProfileRouteSuccess,
  summarizeSettingsRouteSuccess,
} from "./chat-manager-route-summaries.js";
import {
  hasDeterministicRouteTarget,
  parseAgentProfileLookupRouteAction,
  parseBrowseAgentsRouteAction,
  parseBrowseCommentsRouteAction,
  parseBrowseHomeFeedRouteAction,
  parseBrowseNotificationsRouteAction,
  parseBrowsePostsRouteAction,
  parseBrowseTopEngagersRouteAction,
  parseFindCommentRouteAction,
  parseFindPostRouteAction,
  parseFindUserRouteAction,
  parseFollowRouteAction,
  parseProfileRouteAction,
  parseSettingsRouteAction,
  parseSuggestFollowersRouteAction,
} from "./chat-manager-route-parsers.js";

export { hasDeterministicRouteTarget };
const DETERMINISTIC_ROUTE_POLICY_TARGETED_DM: DeterministicRoutePolicy = {
  dmOnly: true,
  allowChannel: false,
  allowedTargets: ["agent", "owner"],
  requireLinkedOwnerForOwnerTarget: true,
};

const DETERMINISTIC_ROUTE_POLICY_DM_ONLY: DeterministicRoutePolicy = {
  dmOnly: true,
  allowChannel: false,
};

// Single registration table: add a parser + policy + success formatter here
// to introduce a new deterministic chat route without touching the executor.
const DETERMINISTIC_ROUTE_REGISTRATIONS: readonly DeterministicRouteRegistration[] =
  [
    {
      action: "update_profile",
      parse: parseProfileRouteAction,
      policy: DETERMINISTIC_ROUTE_POLICY_TARGETED_DM,
      summarizeSuccess: summarizeProfileRouteSuccess,
      failureLabel: "profile update",
    },
    {
      action: "update_settings",
      parse: parseSettingsRouteAction,
      policy: DETERMINISTIC_ROUTE_POLICY_TARGETED_DM,
      summarizeSuccess: summarizeSettingsRouteSuccess,
      failureLabel: "settings update",
    },
    {
      action: "follow_user",
      parse: parseFollowRouteAction,
      policy: DETERMINISTIC_ROUTE_POLICY_TARGETED_DM,
      summarizeSuccess: summarizeFollowRouteSuccess,
      failureLabel: "follow request",
    },
    {
      action: "unfollow_user",
      parse: parseFollowRouteAction,
      policy: DETERMINISTIC_ROUTE_POLICY_TARGETED_DM,
      summarizeSuccess: summarizeFollowRouteSuccess,
      failureLabel: "unfollow request",
    },
    {
      action: "browse_agents",
      parse: parseBrowseAgentsRouteAction,
      policy: DETERMINISTIC_ROUTE_POLICY_DM_ONLY,
      summarizeSuccess: summarizeFollowDiscoveryRouteSuccess,
      failureLabel: "agent discovery lookup",
    },
    {
      action: "suggest_followers",
      parse: parseSuggestFollowersRouteAction,
      policy: DETERMINISTIC_ROUTE_POLICY_DM_ONLY,
      summarizeSuccess: summarizeFollowDiscoveryRouteSuccess,
      failureLabel: "follower suggestion lookup",
    },
    {
      action: "agent_profile",
      parse: parseAgentProfileLookupRouteAction,
      policy: DETERMINISTIC_ROUTE_POLICY_DM_ONLY,
      summarizeSuccess: summarizeAgentProfileLookupSuccess,
      failureLabel: "agent profile lookup",
    },
    {
      action: "find_user",
      parse: parseFindUserRouteAction,
      policy: DETERMINISTIC_ROUTE_POLICY_DM_ONLY,
      summarizeSuccess: summarizeFindUserRouteSuccess,
      failureLabel: "user lookup",
    },
    {
      action: "find_post",
      parse: parseFindPostRouteAction,
      policy: DETERMINISTIC_ROUTE_POLICY_DM_ONLY,
      summarizeSuccess: summarizeFindPostRouteSuccess,
      failureLabel: "post lookup",
    },
    {
      action: "find_comment",
      parse: parseFindCommentRouteAction,
      policy: DETERMINISTIC_ROUTE_POLICY_DM_ONLY,
      summarizeSuccess: summarizeFindCommentRouteSuccess,
      failureLabel: "comment lookup",
    },
    {
      action: "browse_posts",
      parse: parseBrowsePostsRouteAction,
      policy: DETERMINISTIC_ROUTE_POLICY_DM_ONLY,
      summarizeSuccess: summarizeBrowsePostsRouteSuccess,
      failureLabel: "post browse lookup",
    },
    {
      action: "browse_comments",
      parse: parseBrowseCommentsRouteAction,
      policy: DETERMINISTIC_ROUTE_POLICY_DM_ONLY,
      summarizeSuccess: summarizeBrowseCommentsRouteSuccess,
      failureLabel: "comment browse lookup",
    },
    {
      action: "browse_notifications",
      parse: parseBrowseNotificationsRouteAction,
      policy: DETERMINISTIC_ROUTE_POLICY_DM_ONLY,
      summarizeSuccess: summarizeBrowseNotificationsRouteSuccess,
      failureLabel: "notification lookup",
    },
    {
      action: "browse_home_feed",
      parse: parseBrowseHomeFeedRouteAction,
      policy: DETERMINISTIC_ROUTE_POLICY_DM_ONLY,
      summarizeSuccess: summarizeBrowsePostsRouteSuccess,
      failureLabel: "home feed lookup",
    },
    {
      action: "browse_top_engagers",
      parse: parseBrowseTopEngagersRouteAction,
      policy: DETERMINISTIC_ROUTE_POLICY_DM_ONLY,
      summarizeSuccess: summarizeBrowseTopEngagersRouteSuccess,
      failureLabel: "top engager lookup",
    },
  ];

export const parseDeterministicRouteAction = (
  body: string,
): DeterministicRouteMatch | null => {
  for (const registration of DETERMINISTIC_ROUTE_REGISTRATIONS) {
    const parsed = registration.parse(body);
    if (!parsed) continue;
    if (parsed.kind === "clarify") return parsed;
    if (parsed.payload.action !== registration.action) continue;
    return {
      kind: "action",
      payload: parsed.payload,
      registration,
    };
  }
  return null;
};
