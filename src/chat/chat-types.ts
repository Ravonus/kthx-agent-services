import type { ChatTrackingState } from "../runtime-context.js";
import type { ContextBundle, ContextRequest } from "../types/memory.js";
import type { OpenClawPromptResponse } from "./chat-intent.js";
import type { ChatInboxEntry } from "./chat-reply.js";

export interface ChatManagerContext {
  config: {
    chatRuntimeEnabled: boolean;
    chatRuntimePollMs: number;
    chatRuntimeReadChunkBytes: number;
    chatRuntimeSeenMessageLimit: number;
    chatRuntimeReplyMaxChars: number;
    chatRuntimeOpenClawInputMaxChars: number;
    chatRuntimeUseOpenClaw: boolean;
    chatRuntimeReplayOnStart: boolean;
    chatRuntimeChannelRequireMention: boolean;
    chatRuntimeMentionNames: string[];
    chatRuntimeTextStreamEnabled: boolean;
    chatRuntimeTextStreamNativeEnabled: boolean;
    chatRuntimeTextStreamNativeOnly: boolean;
    chatRuntimeTextStreamStepChars: number;
    chatRuntimeTextStreamStepMs: number;
    chatRuntimeTextStreamUpdateMinMs: number;
    chatRuntimeStaleReplyMaxAgeMs: number;
    chatRuntimeStaleReplyMaxAgeImportantMs: number;
  };
  ipcPaths: {
    chatInboxPath: string;
    chatRuntimeStatePath: string;
  };
  memory: {
    recordWrite(payload: unknown): Promise<void>;
    buildContext?: (request: ContextRequest) => Promise<ContextBundle>;
  };
  chat: ChatTrackingState;
  callAgentChatBridge: (payload: unknown) => Promise<unknown>;
  runOpenClawPrompt: (opts: {
    prompt: string;
    purpose: string;
    onTextDelta?: ((delta: string) => void) | null;
  }) => Promise<OpenClawPromptResponse | null>;
  resolveOpenClawAgentName: () => Promise<string | null>;
  runMemoryCheckpoint: (opts: {
    force: boolean;
    source: string;
    allowAgentCompression: boolean;
  }) => Promise<void>;
}

export interface StreamState {
  entry: ChatInboxEntry;
  messageId: string | null;
  currentBody: string;
  targetBody: string;
  lastUpdateAtMs: number;
  nativeDeltaChars: number;
}

export interface StaleReplyDecision {
  skipReply: boolean;
  ageMs: number | null;
  important: boolean;
  reason:
    | "fresh"
    | "stale_not_important"
    | "stale_important_expired"
    | "stale_important_allowed"
    | "invalid_timestamp";
}

export interface ReplyTargetContext {
  messageId: string;
  authorDisplay: string | null;
  authorHandle: string | null;
  bodyPreview: string | null;
  attachmentSummary: string | null;
  hintPostId: number | null;
  hintCommentId: number | null;
  retrievalQueryFragment: string;
}

export interface LinkedOwnerIdentity {
  agentMainUserId: string;
  agentHandle: string | null;
  agentName: string | null;
  ownerMainUserId: string;
  ownerHandle: string;
  ownerName: string | null;
}

export type RetentionDialogStep =
  | "ask_days"
  | "ask_interval"
  | "ask_long_term"
  | "ask_agent_compression"
  | "ask_confirm";

export interface RetentionDialogConfig {
  days: number;
  intervalMinutes: number;
  longTermEnabled: boolean;
  longTermUseAgentCompression: boolean;
}

export interface RetentionDialogState {
  key: string;
  step: RetentionDialogStep;
  createdAt: string;
  updatedAt: string;
  conversationId: string | null;
  authorMainUserId: string | null;
  pending: Partial<RetentionDialogConfig>;
}

export type ProfileSettingsTarget = "agent" | "owner";
export type DmPolicyValue =
  | "everyone"
  | "following_only"
  | "followers_only"
  | "mutual_only";
export type DmAutomatedPolicyValue =
  | "allow_all"
  | "allow_followed"
  | "deny_all";
export type AgentReplyPolicyValue =
  | "allow_all"
  | "deny_all"
  | "deny_selected";

export type DeterministicRoutePayload =
  | {
      action: "update_profile";
      target: ProfileSettingsTarget;
      name?: string;
      bio?: string | null;
      imageUrl?: string;
      bannerUrl?: string;
    }
  | {
      action: "update_settings";
      target: ProfileSettingsTarget;
      defaultLensId?: number | null;
      readReceipts?: boolean;
      dmPolicy?: DmPolicyValue;
      dmAutomatedPolicy?: DmAutomatedPolicyValue;
      agentReplyPolicy?: AgentReplyPolicyValue;
      showOnlineStatus?: boolean;
    }
  | {
      action: "follow_user";
      target: ProfileSettingsTarget;
      userId?: string;
      handle?: string;
    }
  | {
      action: "unfollow_user";
      target: ProfileSettingsTarget;
      userId?: string;
      handle?: string;
    }
  | {
      action: "suggest_followers";
      limit?: number;
      includeAgents?: boolean;
    }
  | {
      action: "browse_agents";
      query?: string;
      limit?: number;
      includeFollowing?: boolean;
      includeFollowers?: boolean;
      includeRecentPosters?: boolean;
    }
  | {
      action: "agent_profile";
    }
  | {
      action: "find_user";
      handle?: string;
      mainUserId?: string;
    }
  | {
      action: "find_post";
      postId?: number;
      authorHandle?: string;
      searchText?: string;
      latest?: boolean;
    }
  | {
      action: "find_comment";
      postId: number;
      commentId?: number;
      searchText?: string;
    }
  | {
      action: "browse_posts";
      limit?: number;
    }
  | {
      action: "browse_comments";
      postId?: number;
      searchText?: string;
      limit?: number;
    }
  | {
      action: "browse_notifications";
      limit?: number;
      unreadOnly?: boolean;
    }
  | {
      action: "browse_home_feed";
      limit?: number;
    }
  | {
      action: "browse_top_engagers";
      limit?: number;
      windowHours?: number;
    };

export type DeterministicRouteParseResult =
  | { kind: "action"; payload: DeterministicRoutePayload }
  | { kind: "clarify"; reply: string };

export interface DeterministicRoutePolicy {
  dmOnly: boolean;
  allowChannel: boolean;
  allowedTargets?: readonly ProfileSettingsTarget[];
  requireLinkedOwnerForOwnerTarget?: boolean;
}

export interface DeterministicRouteRegistration {
  action: DeterministicRoutePayload["action"];
  parse: (body: string) => DeterministicRouteParseResult | null;
  policy: DeterministicRoutePolicy;
  summarizeSuccess: (
    payload: DeterministicRoutePayload,
    response: unknown,
  ) => string;
  failureLabel: string;
}

export type DeterministicRouteMatch =
  | {
      kind: "action";
      payload: DeterministicRoutePayload;
      registration: DeterministicRouteRegistration;
    }
  | { kind: "clarify"; reply: string };

export type DeterministicRouteTargetedPayload = Extract<
  DeterministicRoutePayload,
  { target: ProfileSettingsTarget }
>;
