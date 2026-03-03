/** Follow-action helpers and engagement target lookup hint resolution. */

import type {
  CommandExecutorContext,
  EngagementLookupHints,
  FollowTargetMode,
} from "../types.js";
import {
  asNonEmptyString,
  asPositiveInt,
  truncateText,
  normalizeInterestTagToken,
} from "../helpers.js";
import { isRecord } from "../../lib/guards.js";

// ---------------------------------------------------------------------------
// Engagement lookup hints
// ---------------------------------------------------------------------------

export function extractEngagementLookupHints(
  payload: Record<string, unknown>,
): EngagementLookupHints {
  const context = isRecord(payload.context) ? payload.context : null;
  const collectTagTokens = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    const collected: string[] = [];
    for (const entry of value) {
      const normalized = normalizeInterestTagToken(entry);
      if (!normalized) continue;
      collected.push(normalized);
    }
    return collected;
  };
  const fields = [
    asNonEmptyString(payload.requestText),
    asNonEmptyString(payload.topic),
    asNonEmptyString(payload.prompt),
    asNonEmptyString(payload.body),
    asNonEmptyString(payload.caption),
    asNonEmptyString(payload.textBody),
  ].filter((value): value is string => Boolean(value));
  const rawQuery = truncateText(fields.join(" \u00b7 "), 420);
  const postIdFromText = (() => {
    for (const match of rawQuery.matchAll(/\bpost(?:\s*id)?\s*[:#]?\s*(\d{1,12})\b/giu)) {
      const parsed = Number.parseInt(match[1] ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  })();
  const commentIdFromText = (() => {
    for (const match of rawQuery.matchAll(
      /\bcomment(?:\s*id)?\s*[:#]?\s*(\d{1,12})\b/giu,
    )) {
      const parsed = Number.parseInt(match[1] ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  })();
  const handles = [...rawQuery.matchAll(/@([a-z0-9_.-]{2,64})/giu)]
    .map((match) => (match[1] ?? "").trim().toLowerCase())
    .filter((value) => value.length > 0)
    .slice(0, 8);
  const tagsFromQuery = [...rawQuery.matchAll(/#([a-z0-9_-]{2,40})/giu)]
    .map((match) => normalizeInterestTagToken(match[1] ?? ""))
    .filter((value): value is string => Boolean(value));
  const interestTags = Array.from(
    new Set(
      [
        ...collectTagTokens(payload.tags),
        ...collectTagTokens(payload.mediaLabels),
        ...collectTagTokens(payload.labels),
        ...collectTagTokens(payload.interests),
        ...collectTagTokens(payload.preferredTags),
        ...collectTagTokens(context?.tags),
        ...collectTagTokens(context?.mediaLabels),
        ...collectTagTokens(context?.labels),
        ...collectTagTokens(context?.interests),
        ...collectTagTokens(context?.preferredTags),
        ...tagsFromQuery,
      ],
    ),
  ).slice(0, 10);
  return {
    rawQuery,
    postId: postIdFromText,
    commentId: commentIdFromText,
    handles,
    interestTags,
  };
}

// ---------------------------------------------------------------------------
// Text-line ID parsing
// ---------------------------------------------------------------------------

export function parseTargetIdsFromTextLine(text: string): {
  postId: number | null;
  commentId: number | null;
} {
  const normalized = text.trim();
  if (!normalized.length) {
    return { postId: null, commentId: null };
  }
  const parse = (pattern: RegExp): number | null => {
    const match = normalized.match(pattern);
    if (!match) return null;
    const parsed = Number.parseInt(match[1] ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  return {
    postId: parse(/\bpost(?:\s*id)?\s*[:#]?\s*(\d{1,12})\b/iu),
    commentId: parse(/\bcomment(?:\s*id)?\s*[:#]?\s*(\d{1,12})\b/iu),
  };
}

// ---------------------------------------------------------------------------
// Handle normalization
// ---------------------------------------------------------------------------

export function normalizeFollowHandleCandidate(value: string): string | null {
  const cleaned = value
    .trim()
    .replace(/^[`"'\u201c\u201d\u2018\u2019([{<@]+/gu, "")
    .replace(/[`"'\u201c\u201d\u2018\u2019)\]}>.,!?;:]+$/gu, "");
  const normalized = cleaned.replace(/^@+/u, "").toLowerCase();
  if (!normalized.length) return null;
  return /^[a-z0-9_.-]{2,64}$/u.test(normalized) ? normalized : null;
}

// ---------------------------------------------------------------------------
// Chat command name resolution
// ---------------------------------------------------------------------------

export function resolveChatCommandName(payload: Record<string, unknown>): string | null {
  const explicit = asNonEmptyString(payload.chatCommandName)?.toLowerCase();
  if (explicit) return explicit;
  const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
  return asNonEmptyString(chatContext?.commandName)?.toLowerCase() ?? null;
}

// ---------------------------------------------------------------------------
// Delegated follow action resolution
// ---------------------------------------------------------------------------

export function resolveDelegatedFollowAction(
  payload: Record<string, unknown>,
): "follow" | "follow_engagers" | "follow_accept" | "follow_suggestions" | null {
  const explicitAction = asNonEmptyString(payload.followAction)?.toLowerCase() ?? "";
  if (explicitAction === "follow") return "follow";
  if (
    explicitAction === "follow_engagers" ||
    explicitAction === "follow-engagers" ||
    explicitAction === "followengagers"
  ) {
    return "follow_engagers";
  }
  if (
    explicitAction === "follow_accept" ||
    explicitAction === "follow-accept" ||
    explicitAction === "followaccept"
  ) {
    return "follow_accept";
  }
  const chatCommandName = resolveChatCommandName(payload);
  if (chatCommandName === "follow") return "follow";
  if (
    chatCommandName === "follow-engagers" ||
    chatCommandName === "followengagers"
  ) {
    return "follow_engagers";
  }
  if (
    chatCommandName === "follow-accept" ||
    chatCommandName === "followaccept"
  ) {
    return "follow_accept";
  }
  if (chatCommandName === "assist") {
    const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
    const commandArgs = Array.isArray(chatContext?.commandArgs)
      ? chatContext.commandArgs
          .map((entry) => asNonEmptyString(entry)?.toLowerCase() ?? null)
          .filter((entry): entry is string => Boolean(entry))
      : [];
    const assistAction = commandArgs[0] ?? "";
    if (assistAction === "follow-suggestions" || assistAction === "followsuggestions") {
      const autoFollowRequested = commandArgs.some(
        (entry) => entry === "--auto-follow" || entry === "--autofollow",
      );
      return autoFollowRequested ? "follow_engagers" : "follow_suggestions";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Follow target mode resolution
// ---------------------------------------------------------------------------

export function resolveFollowTargetMode(payload: Record<string, unknown>): FollowTargetMode {
  const parseTarget = (value: string | null): FollowTargetMode | null => {
    if (!value) return null;
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "owner" ||
      normalized === "for-me" ||
      normalized === "for_owner" ||
      normalized === "me"
    ) {
      return "owner";
    }
    if (normalized === "agent" || normalized === "as-agent" || normalized === "as_agent") {
      return "agent";
    }
    return null;
  };

  const directTarget =
    parseTarget(asNonEmptyString(payload.followTargetMode)) ??
    parseTarget(asNonEmptyString(payload.followMode)) ??
    parseTarget(asNonEmptyString(payload.requestedActingAs));
  if (directTarget) return directTarget;

  const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
  const commandArgs = Array.isArray(chatContext?.commandArgs) ? chatContext.commandArgs : [];
  const firstArg = commandArgs.length > 0 ? asNonEmptyString(commandArgs[0]) : null;
  const argTarget = parseTarget(firstArg);
  if (argTarget) return argTarget;

  const commandOrigin = asNonEmptyString(chatContext?.commandOrigin)?.toLowerCase();
  if (commandOrigin === "natural" || commandOrigin === "followup") {
    return "agent";
  }
  return "owner";
}

// ---------------------------------------------------------------------------
// Profile write target resolution
// ---------------------------------------------------------------------------

export function resolveProfileWriteTarget(
  value: string | null | undefined,
): "agent" | "owner" {
  const normalized = asNonEmptyString(value)?.toLowerCase() ?? "";
  if (
    normalized === "owner" ||
    normalized === "for_owner" ||
    normalized === "as-owner" ||
    normalized === "as_owner" ||
    normalized === "owner-account" ||
    normalized === "owner_account"
  ) {
    return "owner";
  }
  return "agent";
}

// ---------------------------------------------------------------------------
// Handle collection from payloads
// ---------------------------------------------------------------------------

export function collectFollowHandlesFromPayload(payload: Record<string, unknown>): string[] {
  const handles: string[] = [];
  const pushHandle = (value: unknown): void => {
    if (typeof value !== "string") return;
    const normalized = normalizeFollowHandleCandidate(value);
    if (!normalized) return;
    if (
      normalized === "for" ||
      normalized === "me" ||
      normalized === "all" ||
      normalized === "more" ||
      normalized === "as-agent" ||
      normalized === "as_agent"
    ) {
      return;
    }
    handles.push(normalized);
  };
  const pushHandlesFromUnknown = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/@([a-z0-9_.-]{2,64})/giu)) {
        pushHandle(match[1] ?? "");
      }
      for (const token of value.split(/\s+/u)) {
        pushHandle(token);
      }
      return;
    }
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (typeof entry === "string") {
        pushHandle(entry);
      }
    }
  };

  pushHandlesFromUnknown(payload.followHandles);
  pushHandle(payload.handle);
  pushHandle(payload.followHandle);
  pushHandlesFromUnknown(payload.followSelections);

  const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
  pushHandlesFromUnknown(chatContext?.commandArgs);
  pushHandlesFromUnknown(chatContext?.commandRawArgs);
  pushHandlesFromUnknown(chatContext?.originalMessage);

  pushHandlesFromUnknown(payload.prompt);
  pushHandlesFromUnknown(payload.topic);
  pushHandlesFromUnknown(payload.requestText);

  return Array.from(new Set(handles)).slice(0, 24);
}

// ---------------------------------------------------------------------------
// Follow selections from payload
// ---------------------------------------------------------------------------

export function collectFollowSelectionsFromPayload(payload: Record<string, unknown>): string[] {
  const selections: string[] = [];
  const pushSelection = (value: unknown): void => {
    if (typeof value !== "string") return;
    const normalized = value.trim().toLowerCase();
    if (!normalized.length) return;
    selections.push(normalized);
  };
  const pushSelectionFromUnknown = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        pushSelection(entry);
      }
      return;
    }
    pushSelection(value);
  };

  pushSelectionFromUnknown(payload.followSelections);
  const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
  pushSelectionFromUnknown(chatContext?.commandArgs);
  return Array.from(new Set(selections)).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Engager count resolution
// ---------------------------------------------------------------------------

export function resolveFollowEngagersCount(payload: Record<string, unknown>): number {
  const fromPayload = asPositiveInt(payload.followCount);
  if (fromPayload) return Math.max(1, Math.min(12, fromPayload));
  const selections = collectFollowSelectionsFromPayload(payload);
  if (selections.includes("all")) return 12;
  const numeric = selections
    .map((entry) => Number.parseInt(entry, 10))
    .find((value) => Number.isFinite(value) && value > 0);
  if (numeric) return Math.max(1, Math.min(12, Math.floor(numeric)));
  return 8;
}

// ---------------------------------------------------------------------------
// Follow suggestion options
// ---------------------------------------------------------------------------

export function resolveFollowSuggestionOptions(payload: Record<string, unknown>): {
  agentOnly: boolean;
  topicHint: string | null;
} {
  const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
  const commandArgs = Array.isArray(chatContext?.commandArgs)
    ? chatContext.commandArgs
        .map((entry) => asNonEmptyString(entry)?.toLowerCase() ?? null)
        .filter((entry): entry is string => Boolean(entry))
    : [];
  const agentOnly = commandArgs.some(
    (entry) =>
      entry === "--agent-only" ||
      entry === "--agentonly" ||
      entry === "agent-only" ||
      entry === "agentonly",
  );
  const topicTokens = commandArgs.filter((entry, index) => {
    if (index === 0 && (entry === "follow-suggestions" || entry === "followsuggestions")) {
      return false;
    }
    if (entry === "follow-suggestions" || entry === "followsuggestions") return false;
    if (entry === "ask-count") return false;
    if (/^\d{1,2}$/u.test(entry)) return false;
    if (entry.startsWith("--")) return false;
    if (
      entry === "for-me" ||
      entry === "forme" ||
      entry === "as-agent" ||
      entry === "as_agent" ||
      entry === "asagent"
    ) {
      return false;
    }
    return true;
  });
  const topicHint =
    topicTokens.length > 0 ? truncateText(topicTokens.join(" "), 120) : null;
  return {
    agentOnly,
    topicHint,
  };
}

// ---------------------------------------------------------------------------
// Browsed agent candidate extraction
// ---------------------------------------------------------------------------

export function extractBrowsedAgentCandidates(
  value: unknown,
  limit: number,
): Array<{
  handle: string;
  name: string | null;
  score: number | null;
  reason: string | null;
}> {
  const data = isRecord(value) ? value : null;
  const rows = Array.isArray(data?.items) ? data.items : [];
  const deduped = new Map<
    string,
    {
      handle: string;
      name: string | null;
      score: number | null;
      reason: string | null;
    }
  >();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const user = isRecord(row.user) ? row.user : null;
    const handleCandidate =
      asNonEmptyString(row.handle) ??
      asNonEmptyString(row.username) ??
      asNonEmptyString(user?.handle) ??
      asNonEmptyString(user?.username);
    if (!handleCandidate) continue;
    const handle = normalizeFollowHandleCandidate(handleCandidate);
    if (!handle) continue;
    const name =
      asNonEmptyString(row.name) ??
      asNonEmptyString(user?.name) ??
      asNonEmptyString(row.displayName) ??
      null;
    const score =
      typeof row.score === "number" && Number.isFinite(row.score)
        ? Math.max(0, Math.floor(row.score))
        : null;
    const reason = asNonEmptyString(row.reason)?.toLowerCase() ?? null;
    const existing = deduped.get(handle);
    if (!existing || (score ?? -1) > (existing.score ?? -1)) {
      deduped.set(handle, {
        handle,
        name,
        score,
        reason,
      });
    }
    if (deduped.size >= limit) break;
  }
  return Array.from(deduped.values()).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Top engager handle extraction
// ---------------------------------------------------------------------------

export function extractTopEngagerHandlesFromLookup(
  value: unknown,
  limit: number,
  collectBridgeRecordItems: (value: unknown) => Record<string, unknown>[],
): string[] {
  const handles: string[] = [];
  for (const row of collectBridgeRecordItems(value)) {
    const user = isRecord(row.user) ? row.user : null;
    const candidate =
      asNonEmptyString(user?.handle) ??
      asNonEmptyString(user?.username) ??
      asNonEmptyString(row.handle) ??
      asNonEmptyString(row.username);
    if (!candidate) continue;
    const normalized = normalizeFollowHandleCandidate(candidate);
    if (!normalized) continue;
    handles.push(normalized);
    if (handles.length >= limit) break;
  }
  return Array.from(new Set(handles)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Follow attempt
// ---------------------------------------------------------------------------

export async function attemptFollowHandle(
  input: {
    target: FollowTargetMode;
    handle: string;
    action: "follow_user" | "unfollow_user";
  },
  ctx: CommandExecutorContext,
): Promise<{
  handle: string;
  status:
    | "followed"
    | "already_followed"
    | "unfollowed"
    | "already_unfollowed"
    | "not_found"
    | "self"
    | "blocked"
    | "failed";
  error: string | null;
}> {
  const callAgentChatBridge = ctx.callAgentChatBridge;
  if (!callAgentChatBridge) {
    return {
      handle: input.handle,
      status: "failed",
      error: "chat_bridge_unavailable",
    };
  }
  try {
    const result = await callAgentChatBridge({
      action: input.action,
      target: input.target,
      handle: input.handle,
    });
    const data = isRecord(result) ? result : null;
    const user = isRecord(data?.user) ? data.user : null;
    const resolvedHandle =
      normalizeFollowHandleCandidate(asNonEmptyString(user?.handle) ?? input.handle) ??
      input.handle;
    if (input.action === "follow_user") {
      const created = data?.created === true;
      const followed = data?.followed === true;
      if (followed && created) {
        return { handle: resolvedHandle, status: "followed", error: null };
      }
      if (followed && !created) {
        return { handle: resolvedHandle, status: "already_followed", error: null };
      }
      return {
        handle: resolvedHandle,
        status: "failed",
        error: "follow_action_returned_unexpected_shape",
      };
    }
    const removed = data?.removed === true;
    if (removed) {
      return { handle: resolvedHandle, status: "unfollowed", error: null };
    }
    return { handle: resolvedHandle, status: "already_unfollowed", error: null };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const lowered = message.toLowerCase();
    if (lowered.includes("not found")) {
      return { handle: input.handle, status: "not_found", error: message };
    }
    if (lowered.includes("own account") || lowered.includes("your own")) {
      return { handle: input.handle, status: "self", error: message };
    }
    if (lowered.includes("blocked")) {
      return { handle: input.handle, status: "blocked", error: message };
    }
    return { handle: input.handle, status: "failed", error: message };
  }
}

// ---------------------------------------------------------------------------
// Follow summary text builder
// ---------------------------------------------------------------------------

export function buildFollowSummaryText(input: {
  target: FollowTargetMode;
  followed: string[];
  alreadyFollowed: string[];
  notFound: string[];
  self: string[];
  blocked: string[];
  failed: string[];
  remainingCount?: number;
  followEngagers?: boolean;
}): string {
  const accountLabel = input.target === "agent" ? "agent account" : "your account";
  const segments: string[] = [];
  if (input.followed.length > 0) {
    if (input.followEngagers) {
      segments.push(
        `On the ${accountLabel}, now following ${input.followed.length} top engager${input.followed.length === 1 ? "" : "s"}: ${input.followed.map((entry) => `@${entry}`).join(", ")}.`,
      );
    } else {
      segments.push(
        `On the ${accountLabel}, now following: ${input.followed.map((entry) => `@${entry}`).join(", ")}.`,
      );
    }
  }
  if (input.alreadyFollowed.length > 0) {
    segments.push(
      `Already followed on the ${accountLabel}: ${input.alreadyFollowed.map((entry) => `@${entry}`).join(", ")}.`,
    );
  }
  if (input.notFound.length > 0) {
    segments.push(`Not found: ${input.notFound.map((entry) => `@${entry}`).join(", ")}.`);
  }
  if (input.self.length > 0) {
    segments.push(`Skipped your own account: ${input.self.map((entry) => `@${entry}`).join(", ")}.`);
  }
  if (input.blocked.length > 0) {
    segments.push(
      `Blocked follow relationship: ${input.blocked.map((entry) => `@${entry}`).join(", ")}.`,
    );
  }
  if (input.failed.length > 0) {
    segments.push(`Could not follow right now: ${input.failed.map((entry) => `@${entry}`).join(", ")}.`);
  }
  if (segments.length === 0) {
    segments.push("No follow changes were applied.");
  }
  if (typeof input.remainingCount === "number" && input.remainingCount > 0) {
    segments.push(
      `${input.remainingCount} more high-signal engagers are available. Say "follow more engagers" to continue.`,
    );
  }
  return segments.join(" ");
}
