/** Chat completion building, error sanitization, engagement decision prompts, and processing indicators. */

import crypto from "node:crypto";

import type { Command } from "../../types/ipc.js";
import type { CommandOutcome, EngagementDecisionContext } from "../types.js";

import {
  asNonEmptyString,
  asPositiveInt,
  truncateText,
} from "../helpers.js";

import { resolveChatCommandName } from "../follow/follow-actions.js";

import { isRecord } from "../../lib/guards.js";

// ---------------------------------------------------------------------------
// sanitizeUserFacingCommandErrorMessage
// ---------------------------------------------------------------------------

export function sanitizeUserFacingCommandErrorMessage(input: {
  errorMessage: string;
}): string {
  const raw = input.errorMessage.trim();
  if (!raw.length) return "";
  const lowered = raw.toLowerCase();

  if (
    lowered.includes("no_media_url") ||
    lowered.includes("media_generation_waiting_for_output")
  ) {
    return "I did not receive a final media asset yet.";
  }
  if (
    lowered.includes("prompt_curation_failed") ||
    lowered.includes("prompt_curation_unavailable") ||
    lowered.includes("openclaw_no_usable_prompt") ||
    lowered.includes("invalid json") ||
    lowered.includes("json parse")
  ) {
    return "I could not produce a valid generation draft for that request.";
  }
  if (lowered.includes("persona_reference_setup_required")) {
    return "Persona reference setup is incomplete (selfie, midshot, fullbody).";
  }
  if (
    lowered.includes("image_generation_setup_required") ||
    lowered.includes("image_generator_unconfigured") ||
    lowered.includes("file_generator_unconfigured")
  ) {
    return "Image generation is not ready yet.";
  }
  if (
    lowered.includes("owner capability denied") ||
    lowered.includes("permission denied") ||
    lowered.includes("not_granted") ||
    lowered.includes("no_grant")
  ) {
    return "I do not currently have permission for that action.";
  }
  if (
    lowered.includes("only image and video uploads are supported") ||
    lowered.includes("unsupported_media_payload_mime")
  ) {
    return "The generated media format was not uploadable.";
  }
  if (
    /\b(runtime|bridge|directive|queue|openclaw|edenai|playwright|chatgpt|api|session token|agent key)\b/iu.test(
      raw,
    )
  ) {
    return "I hit an internal processing issue while handling that request.";
  }
  return raw;
}

// ---------------------------------------------------------------------------
// buildDeterministicChatClientMessageId
// ---------------------------------------------------------------------------

export function buildDeterministicChatClientMessageId(input: {
  prefix: string;
  stableKey: string;
}): string {
  const normalizedPrefix = input.prefix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, "_")
    .slice(0, 32);
  const fallbackPrefix = normalizedPrefix.length > 0 ? normalizedPrefix : "runtime_chat";
  const digest = crypto
    .createHash("sha256")
    .update(input.stableKey)
    .digest("hex")
    .slice(0, 32);
  return `${fallbackPrefix}_${digest}`;
}

// ---------------------------------------------------------------------------
// buildEngagementDecisionPrompt
// ---------------------------------------------------------------------------

export function buildEngagementDecisionPrompt(input: {
  action: "like" | "repost";
  postId: number;
  targetHash: string;
  context: EngagementDecisionContext;
}): string {
  const actionLabel = input.action === "like" ? "like" : "repost";
  const contextLines = [
    `postId: ${input.postId}`,
    input.context.postAuthorHandle
      ? `postAuthor: @${input.context.postAuthorHandle.replace(/^@+/u, "")}`
      : null,
    input.context.postText ? `postText: ${input.context.postText}` : null,
    input.context.mediaSummary ? `mediaContext: ${input.context.mediaSummary}` : null,
    input.context.payloadHint ? `requestHint: ${input.context.payloadHint}` : null,
    input.context.memorySummary ? `memoryContext: ${input.context.memorySummary}` : null,
  ].filter((entry): entry is string => Boolean(entry));
  return [
    "Decide whether the runtime should execute this social engagement action now.",
    "Return strict JSON only.",
    "Rules:",
    "- shouldExecute=true when context suggests this action is relevant and non-spammy.",
    "- Prefer own-post engagement when it is active and high-signal; avoid repetitive low-value actions.",
    "- reason must be short (6-120 chars) and action-specific.",
    `- action must be exactly \"${actionLabel}\".`,
    "- target fields must match exactly.",
    "Return strict JSON ONLY with this exact shape:",
    `{"action":"${actionLabel}","target":{"postId":${input.postId},"commentId":null,"targetHash":"${input.targetHash}"},"shouldExecute":true,"reason":"<short reason>"}`,
    `Action: ${actionLabel}`,
    "Context:",
    ...contextLines.map((line) => `- ${line}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// buildNonWriteChatCompletion
// ---------------------------------------------------------------------------

export function buildNonWriteChatCompletion(input: {
  command: Command;
  outcome: CommandOutcome;
}): { body: string; metadata: Record<string, unknown> } | null {
  const payload = isRecord(input.command.payload) ? input.command.payload : null;
  const commandName = payload ? resolveChatCommandName(payload) ?? input.command.kind : input.command.kind;
  const suppressCommandActionPreview =
    commandName.trim().toLowerCase() === "agent-decide";
  const data = isRecord(input.outcome.data) ? input.outcome.data : null;
  const explicitCompletion = data && isRecord(data.chatCompletion)
    ? data.chatCompletion
    : null;
  const explicitBody = asNonEmptyString(explicitCompletion?.body);
  if (explicitBody) {
    const explicitMetadata = isRecord(explicitCompletion?.metadata)
      ? explicitCompletion.metadata
      : null;
    const sanitizedExplicitMetadata =
      suppressCommandActionPreview && explicitMetadata
        ? (() => {
            const { actionPreview: _ignoredActionPreview, ...rest } = explicitMetadata;
            return rest;
          })()
        : explicitMetadata;
    return {
      body: explicitBody,
      metadata: {
        automated: true,
        sourceContext: "CHAT",
        ...(sanitizedExplicitMetadata ?? {}),
      },
    };
  }

  if (!payload) return null;
  const errorMessageRaw = input.outcome.error?.message?.trim() ?? "";
  const errorMessage = sanitizeUserFacingCommandErrorMessage({
    errorMessage: errorMessageRaw,
  });
  if (!input.outcome.ok) {
    return {
      body: errorMessage.length > 0
        ? `I couldn't complete that ${commandName} request: ${errorMessage}`
        : `I couldn't complete that ${commandName} request.`,
      metadata: {
        automated: true,
        sourceContext: "CHAT",
        ...(suppressCommandActionPreview
          ? {}
          : {
              actionPreview: {
                type: "command",
                status: "failed",
                title: "Command failed",
                summary: commandName,
                ...(errorMessage.length > 0
                  ? { error: truncateText(errorMessage, 240) }
                  : {}),
              },
            }),
      },
    };
  }

  const executedAll = Array.isArray(data?.executed) ? data.executed : [];
  const executedApplied = executedAll.filter((entry) => {
    if (!isRecord(entry)) return true;
    return entry.skipped !== true;
  });
  const skippedExecutionEntries = executedAll.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry.skipped === true,
  );
  const skippedDraftEntries = Array.isArray(data?.skippedDrafts)
    ? data.skippedDrafts.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
  const failedDraftEntries = Array.isArray(data?.failedDrafts)
    ? data.failedDrafts.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
  const executedCount = executedApplied.length;
  const skippedCount = skippedExecutionEntries.length + skippedDraftEntries.length;
  const failedCount = failedDraftEntries.length;
  const skippedDecisionReasons = Array.from(
    new Set(
      skippedExecutionEntries
        .map((entry) => asNonEmptyString(entry.decision)?.toLowerCase() ?? null)
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ).slice(0, 4);
  const skippedReasonSuffix =
    skippedDecisionReasons.length > 0
      ? ` (${skippedDecisionReasons.join(", ")})`
      : " due to unavailable grant budget or action constraints";
  const readHandleList = (value: unknown): string[] =>
    Array.from(
      new Set(
        (Array.isArray(value) ? value : [])
          .map((entry) =>
            asNonEmptyString(entry)
              ?.replace(/^@+/u, "")
              .toLowerCase() ?? null,
          )
          .filter((entry): entry is string => Boolean(entry)),
      ),
    );
  const followedHandles = readHandleList(data?.followedHandles);
  const alreadyFollowedHandles = readHandleList(data?.alreadyFollowedHandles);
  const failedHandles = readHandleList(data?.failedHandles);
  const normalizeKindForSummary = (value: string): string => {
    const normalized = value.trim().toLowerCase();
    if (normalized.startsWith("write.")) {
      return normalized.slice("write.".length);
    }
    if (normalized.startsWith("brain.")) {
      return normalized.slice("brain.".length);
    }
    return normalized;
  };
  const executedKinds = Array.from(
    new Set(
      executedApplied
        .map((entry) =>
          isRecord(entry) ? asNonEmptyString(entry.kind) : null,
        )
        .filter((entry): entry is string => Boolean(entry))
        .map((entry) => normalizeKindForSummary(entry)),
    ),
  );
  const resolveActionLabel = (entry: Record<string, unknown>): string | null => {
    const explicit = asNonEmptyString(entry.action)?.trim().toLowerCase() ?? null;
    if (explicit) return explicit;
    const kind = asNonEmptyString(entry.kind);
    if (!kind) return null;
    const normalizedKind = normalizeKindForSummary(kind);
    if (normalizedKind.includes("comment")) return "comment";
    if (normalizedKind.includes("vote") || normalizedKind === "like") return "like";
    if (normalizedKind.includes("repost")) return "repost";
    return normalizedKind;
  };
  const executedTargetDetails = executedApplied
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const action = resolveActionLabel(entry);
      if (!action) return null;
      const postId = asPositiveInt(entry.postId);
      const commentId =
        asPositiveInt(entry.commentId) ??
        asPositiveInt(entry.parentId) ??
        null;
      return {
        action,
        postId,
        commentId,
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        action: string;
        postId: number | null;
        commentId: number | null;
      } => Boolean(entry),
    );
  const summarizeExecutedTargets = (
    action: "comment" | "like" | "repost",
    label: string,
  ): string | null => {
    const matches = executedTargetDetails.filter(
      (entry) => entry.action === action && entry.postId !== null,
    );
    if (matches.length === 0) return null;
    if (action === "comment") {
      const formatted = matches.slice(0, 5).map((entry) => {
        const postRef = `#${entry.postId}`;
        if (entry.commentId && entry.commentId > 0) {
          return `${postRef} (reply #${entry.commentId})`;
        }
        return postRef;
      });
      return `${label}: ${formatted.join(", ")}${matches.length > 5 ? ` (+${matches.length - 5} more)` : ""}.`;
    }
    const uniquePostIds = Array.from(
      new Set(matches.map((entry) => entry.postId).filter((id): id is number => id !== null)),
    );
    if (uniquePostIds.length === 0) return null;
    return `${label}: ${uniquePostIds
      .slice(0, 6)
      .map((id) => `#${id}`)
      .join(", ")}${uniquePostIds.length > 6 ? ` (+${uniquePostIds.length - 6} more)` : ""}.`;
  };
  const executedTargetSummaries = [
    summarizeExecutedTargets("like", "Likes"),
    summarizeExecutedTargets("comment", "Comments"),
    summarizeExecutedTargets("repost", "Reposts"),
  ].filter((entry): entry is string => entry !== null);
  let summary = "Done.";
  if (
    followedHandles.length > 0 ||
    alreadyFollowedHandles.length > 0 ||
    failedHandles.length > 0
  ) {
    const parts: string[] = [];
    if (followedHandles.length > 0) {
      parts.push(
        `Followed: ${followedHandles
          .slice(0, 8)
          .map((entry) => `@${entry}`)
          .join(", ")}${followedHandles.length > 8 ? ` (+${followedHandles.length - 8} more)` : ""}.`,
      );
    }
    if (alreadyFollowedHandles.length > 0) {
      parts.push(
        `Already followed: ${alreadyFollowedHandles
          .slice(0, 8)
          .map((entry) => `@${entry}`)
          .join(", ")}${alreadyFollowedHandles.length > 8 ? ` (+${alreadyFollowedHandles.length - 8} more)` : ""}.`,
      );
    }
    if (failedHandles.length > 0) {
      parts.push(
        `Could not follow: ${failedHandles
          .slice(0, 8)
          .map((entry) => `@${entry}`)
          .join(", ")}${failedHandles.length > 8 ? ` (+${failedHandles.length - 8} more)` : ""}.`,
      );
    }
    summary = parts.length > 0 ? parts.join(" ") : summary;
  } else if (executedCount > 0 && executedKinds.length > 0) {
    summary =
      `Done. Executed ${executedCount} action${executedCount === 1 ? "" : "s"}: ${executedKinds.slice(0, 4).join(", ")}${executedKinds.length > 4 ? ` (+${executedKinds.length - 4} more)` : ""}.`;
    if (skippedCount > 0) {
      summary += ` Skipped ${skippedCount}${skippedReasonSuffix}.`;
    }
    if (failedCount > 0) {
      summary += ` Failed ${failedCount} action${failedCount === 1 ? "" : "s"} during execution.`;
    }
    if (executedTargetSummaries.length > 0) {
      summary += ` ${executedTargetSummaries.join(" ")}`;
    }
  } else if (executedCount > 0) {
    summary = `Done. Executed ${executedCount} action${executedCount === 1 ? "" : "s"}.`;
    if (skippedCount > 0) {
      summary += ` Skipped ${skippedCount}${skippedReasonSuffix}.`;
    }
    if (failedCount > 0) {
      summary += ` Failed ${failedCount} action${failedCount === 1 ? "" : "s"} during execution.`;
    }
    if (executedTargetSummaries.length > 0) {
      summary += ` ${executedTargetSummaries.join(" ")}`;
    }
  } else if (skippedCount > 0 && failedCount > 0) {
    summary =
      `No actions were executed. Skipped ${skippedCount} and failed ${failedCount} during execution.`;
  } else if (skippedCount > 0) {
    summary =
      `No actions were executed. Skipped ${skippedCount}${skippedReasonSuffix}.`;
  } else if (failedCount > 0) {
    summary =
      `No actions were executed. Failed ${failedCount} action${failedCount === 1 ? "" : "s"} during execution.`;
  }
  return {
    body: summary,
    metadata: {
      automated: true,
      sourceContext: "CHAT",
      ...(suppressCommandActionPreview
        ? {}
        : {
            actionPreview: {
              type: "command",
              status: "success",
              title: "Command completed",
              summary: commandName,
              detail: summary,
              executedCount,
              skippedCount,
              failedCount,
              ...(executedKinds.length > 0 ? { executedKinds } : {}),
              ...(executedTargetDetails.length > 0
                ? { executedTargets: executedTargetDetails.slice(0, 16) }
                : {}),
              ...(followedHandles.length > 0 ? { followedHandles } : {}),
              ...(alreadyFollowedHandles.length > 0
                ? { alreadyFollowedHandles }
                : {}),
              ...(failedHandles.length > 0 ? { failedHandles } : {}),
              ...(failedDraftEntries.length > 0
                ? {
                    failedDrafts: failedDraftEntries
                      .map((entry) => ({
                        kind: asNonEmptyString(entry.kind),
                        reason: asNonEmptyString(entry.reason),
                        code: asNonEmptyString(entry.code),
                      }))
                      .filter(
                        (entry): entry is {
                          kind: string | null;
                          reason: string | null;
                          code: string | null;
                        } => entry.reason !== null,
                      )
                      .slice(0, 12),
                  }
                : {}),
            },
          }),
    },
  };
}

// ---------------------------------------------------------------------------
// buildChatProcessingIndicator
// ---------------------------------------------------------------------------

export function buildChatProcessingIndicator(command: Command): {
  body: string;
  metadata: Record<string, unknown>;
} | null {
  const payload = isRecord(command.payload) ? command.payload : null;
  if (!payload) return null;
  const commandName = resolveChatCommandName(payload) ?? command.kind;
  const normalizedName = commandName.trim().toLowerCase();
  const shortName = normalizedName.startsWith("write.")
    ? normalizedName.slice("write.".length)
    : normalizedName.startsWith("brain.")
      ? normalizedName.slice("brain.".length)
      : normalizedName;
  const previewType =
    shortName.includes("follow")
      ? "follow"
      : shortName.includes("repost")
        ? "repost"
        : shortName.includes("vote") || shortName.includes("like")
          ? "like"
          : "command";
  const summary =
    shortName.length > 0
      ? `Running ${shortName.replace(/[_-]+/gu, " ")}.`
      : "Running your request.";
  return {
    body: "Working on that now.",
    metadata: {
      automated: true,
      sourceContext: "CHAT",
      actionPreview: {
        type: previewType,
        status: "processing",
        title: "In progress",
        summary,
        commandId: command.id,
        commandName,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// resolveChatProcessingClientMessageId
// ---------------------------------------------------------------------------

export function resolveChatProcessingClientMessageId(command: Command): string | null {
  const payload = isRecord(command.payload) ? command.payload : null;
  if (!payload) return null;
  const sourceContext = asNonEmptyString(payload.sourceContext)?.toLowerCase() ?? "";
  const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
  if (sourceContext !== "chat" && !chatContext) return null;
  const chatCommandName = resolveChatCommandName(payload);
  if ((chatCommandName?.trim().toLowerCase() ?? "") === "agent-decide") {
    return null;
  }
  if (payload.chatLiteralGenerate === true || payload.chatLiteralGenerate === "true") {
    return null;
  }
  if (payload.requireDraftOnly === true || payload.requireDraftOnly === "true") {
    return null;
  }
  return buildDeterministicChatClientMessageId({
    prefix: "runtime_chat_progress",
    stableKey: command.id,
  });
}
