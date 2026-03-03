import type {
  Command,
  CommandLifecycleCheckpointStage,
  CommandExecutorContext,
  CommandOutcome,
} from "../types.js";
import { asPositiveInt } from "../helpers.js";
import {
  attemptFollowHandle,
  buildFollowSummaryText,
  collectFollowHandlesFromPayload,
  collectFollowSelectionsFromPayload,
  extractBrowsedAgentCandidates,
  extractTopEngagerHandlesFromLookup,
  resolveFollowEngagersCount,
  resolveFollowSuggestionOptions,
  resolveFollowTargetMode,
} from "./follow-actions.js";

export type DelegatedFollowAction =
  | "follow"
  | "follow_engagers"
  | "follow_accept"
  | "follow_suggestions";

type LifecycleCheckpointInput = {
  command: Command;
  stage: CommandLifecycleCheckpointStage;
  status?: "ok" | "failed";
  message?: string | null;
  metadata?: Record<string, unknown>;
};

export type DelegatedFollowActionDeps = {
  ctx: CommandExecutorContext;
  callAgentBridgeLookupCached: (
    payload: Record<string, unknown>,
    ttlMs?: number,
  ) => Promise<{ value: unknown; cacheHit: boolean }>;
  collectBridgeRecordItems: (value: unknown) => Record<string, unknown>[];
  recordCommandLifecycleCheckpoint: (
    input: LifecycleCheckpointInput,
  ) => Promise<void>;
  successOutcome: (command: Command, data: unknown) => CommandOutcome;
  failedOutcome: (
    command: Command,
    message: string,
    code?: string,
  ) => CommandOutcome;
};

export async function executeDelegatedFollowAction(
  input: {
    command: Command;
    payload: Record<string, unknown>;
    action: DelegatedFollowAction;
  },
  deps: DelegatedFollowActionDeps,
): Promise<CommandOutcome> {
  const target = resolveFollowTargetMode(input.payload);
  const actionLabel =
    input.action === "follow_engagers"
      ? "follow-engagers"
      : input.action === "follow_accept"
        ? "follow-accept"
        : input.action === "follow_suggestions"
          ? "follow-suggestions"
          : "follow";

  const applyFollowForHandles = async (handles: string[]) => {
    const followed: string[] = [];
    const alreadyFollowed: string[] = [];
    const notFound: string[] = [];
    const self: string[] = [];
    const blocked: string[] = [];
    const failed: string[] = [];
    const errors: Array<{ handle: string; error: string }> = [];

    for (const handle of handles) {
      const attempt = await attemptFollowHandle(
        {
          target,
          handle,
          action: "follow_user",
        },
        deps.ctx,
      );
      if (attempt.status === "followed") {
        followed.push(attempt.handle);
        continue;
      }
      if (attempt.status === "already_followed") {
        alreadyFollowed.push(attempt.handle);
        continue;
      }
      if (attempt.status === "not_found") {
        notFound.push(attempt.handle);
        if (attempt.error) {
          errors.push({ handle: attempt.handle, error: attempt.error });
        }
        continue;
      }
      if (attempt.status === "self") {
        self.push(attempt.handle);
        if (attempt.error) {
          errors.push({ handle: attempt.handle, error: attempt.error });
        }
        continue;
      }
      if (attempt.status === "blocked") {
        blocked.push(attempt.handle);
        if (attempt.error) {
          errors.push({ handle: attempt.handle, error: attempt.error });
        }
        continue;
      }
      failed.push(attempt.handle);
      if (attempt.error) {
        errors.push({ handle: attempt.handle, error: attempt.error });
      }
    }

    return {
      followed,
      alreadyFollowed,
      notFound,
      self,
      blocked,
      failed,
      errors,
    };
  };

  if (input.action === "follow") {
    const handles = collectFollowHandlesFromPayload(input.payload);
    if (handles.length === 0) {
      return deps.successOutcome(input.command, {
        followAction: actionLabel,
        followInputMissing: true,
        chatCompletion: {
          body: "Usage: /follow [for-me|as-agent] @handle (you can include multiple handles).",
          metadata: {
            automated: true,
            sourceContext: "CHAT",
            actionPreview: {
              type: "follow",
              status: "failed",
              title: "Follow input missing",
            },
          },
        },
      });
    }

    const applied = await applyFollowForHandles(handles);
    const summaryText = buildFollowSummaryText({
      target,
      followed: applied.followed,
      alreadyFollowed: applied.alreadyFollowed,
      notFound: applied.notFound,
      self: applied.self,
      blocked: applied.blocked,
      failed: applied.failed,
    });

    await deps.recordCommandLifecycleCheckpoint({
      command: input.command,
      stage: "write_mutation",
      status:
        applied.followed.length > 0 || applied.alreadyFollowed.length > 0
          ? "ok"
          : "failed",
      metadata: {
        action: actionLabel,
        target,
        requestedCount: handles.length,
        followedCount: applied.followed.length,
        alreadyFollowedCount: applied.alreadyFollowed.length,
        notFoundCount: applied.notFound.length,
        selfCount: applied.self.length,
        blockedCount: applied.blocked.length,
        failedCount: applied.failed.length,
      },
    });

    return deps.successOutcome(input.command, {
      followAction: actionLabel,
      target,
      requestedHandles: handles,
      followedHandles: applied.followed,
      alreadyFollowedHandles: applied.alreadyFollowed,
      notFoundHandles: applied.notFound,
      selfHandles: applied.self,
      blockedHandles: applied.blocked,
      failedHandles: applied.failed,
      errors: applied.errors,
      chatCompletion: {
        body: summaryText,
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: {
            type: "follow",
            status:
              applied.followed.length > 0 || applied.alreadyFollowed.length > 0
                ? "success"
                : "failed",
            title: "Follow update",
            summary: summaryText,
          },
        },
      },
    });
  }

  if (input.action === "follow_engagers" || input.action === "follow_suggestions") {
    const requestedCount = resolveFollowEngagersCount(input.payload);
    const lookbackDays = asPositiveInt(input.payload.followLookbackDays) ?? 120;
    const suggestionOptions = resolveFollowSuggestionOptions(input.payload);
    const discoverySource: "browse_agents" | "browse_top_engagers" = suggestionOptions.agentOnly
      ? "browse_agents"
      : "browse_top_engagers";
    let candidateHandles: string[] = [];
    const browsedAgentByHandle = new Map<
      string,
      {
        name: string | null;
        score: number | null;
        reason: string | null;
      }
    >();

    try {
      if (discoverySource === "browse_agents") {
        const lookup = await deps.callAgentBridgeLookupCached(
          {
            action: "browse_agents",
            ...(suggestionOptions.topicHint ? { query: suggestionOptions.topicHint } : {}),
            limit: Math.min(60, Math.max(24, requestedCount * 4)),
            includeFollowing: true,
            includeFollowers: true,
            includeRecentPosters: true,
          },
          4_000,
        );
        const browsedCandidates = extractBrowsedAgentCandidates(lookup.value, 60);
        for (const candidate of browsedCandidates) {
          browsedAgentByHandle.set(candidate.handle, {
            name: candidate.name,
            score: candidate.score,
            reason: candidate.reason,
          });
        }
        candidateHandles = browsedCandidates.map((entry) => entry.handle);
      } else {
        const lookup = await deps.callAgentBridgeLookupCached(
          {
            action: "browse_top_engagers",
            limit: Math.min(60, Math.max(24, requestedCount * 4)),
            windowHours: lookbackDays * 24,
          },
          4_000,
        );
        candidateHandles = extractTopEngagerHandlesFromLookup(
          lookup.value,
          60,
          deps.collectBridgeRecordItems,
        );
      }
    } catch (error: unknown) {
      return deps.failedOutcome(
        input.command,
        `Follow candidate lookup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "follow_candidate_lookup_failed",
      );
    }

    if (candidateHandles.length === 0) {
      const body =
        discoverySource === "browse_agents"
          ? suggestionOptions.topicHint
            ? `I could not find agent accounts matching "${suggestionOptions.topicHint}" yet.`
            : "I could not find discoverable agent accounts right now."
          : target === "agent"
            ? `I do not have recent engagers left to follow on the agent account (last ${lookbackDays} days).`
            : `I do not see recent engagers left to follow on your account (last ${lookbackDays} days).`;
      return deps.successOutcome(input.command, {
        followAction: actionLabel,
        target,
        requestedCount,
        lookbackDays,
        candidatesFound: 0,
        discoverySource,
        agentOnly: suggestionOptions.agentOnly,
        chatCompletion: {
          body,
          metadata: {
            automated: true,
            sourceContext: "CHAT",
            actionPreview: {
              type: "follow",
              status: "success",
              title: "No follow candidates",
              summary: body,
            },
          },
        },
      });
    }

    const selectedHandles = candidateHandles.slice(0, requestedCount);
    if (input.action === "follow_suggestions") {
      const remainingCount = Math.max(0, candidateHandles.length - selectedHandles.length);
      const compactHandles = selectedHandles.slice(0, 12);
      const summaryText = (() => {
        if (compactHandles.length === 0) {
          return "I found candidates, but could not shape a follow suggestion list right now.";
        }
        if (discoverySource === "browse_agents") {
          const listLines = compactHandles.map((handle, index) => {
            const browsed = browsedAgentByHandle.get(handle);
            return `${index + 1}. @${handle}${browsed?.name ? ` — ${browsed.name}` : ""}`;
          });
          const listedProfiles = compactHandles
            .map((handle) => browsedAgentByHandle.get(handle) ?? null)
            .filter(
              (
                entry,
              ): entry is {
                name: string | null;
                score: number | null;
                reason: string | null;
              } => Boolean(entry),
            );
          const mostlyDiscoverableSeed =
            listedProfiles.length > 0 &&
            listedProfiles.every(
              (entry) =>
                entry.reason === "discoverable_agent" &&
                (entry.score === null || entry.score <= 55),
            );
          const lines = [
            `Found ${candidateHandles.length} agent account${candidateHandles.length === 1 ? "" : "s"}${suggestionOptions.topicHint ? ` for "${suggestionOptions.topicHint}"` : ""}.`,
            `Top ${listLines.length}:`,
            ...listLines,
          ];
          if (remainingCount > 0) {
            lines.push(`+${remainingCount} more available.`);
          }
          if (mostlyDiscoverableSeed) {
            lines.push(
              "Fair warning: most results currently look like seed placeholders with limited activity signals.",
            );
          }
          lines.push(
            `Reply with /follow @handle or /follow-engagers ${compactHandles.length} to apply follows.`,
          );
          return lines.join("\n");
        }
        const compactHandleText = compactHandles.map((entry) => `@${entry}`).join(", ");
        return `Top ${compactHandles.length} account${compactHandles.length === 1 ? "" : "s"} to consider: ${compactHandleText}.${remainingCount > 0 ? ` (+${remainingCount} more)` : ""} Reply with /follow @handle or /follow-engagers ${compactHandles.length} to apply follows.`;
      })();

      await deps.recordCommandLifecycleCheckpoint({
        command: input.command,
        stage: "generated",
        status: "ok",
        metadata: {
          action: actionLabel,
          target,
          requestedCount,
          candidatesFound: candidateHandles.length,
          suggestedCount: compactHandles.length,
          remainingCount,
          discoverySource,
          agentOnly: suggestionOptions.agentOnly,
          topicHint: suggestionOptions.topicHint,
        },
      });

      return deps.successOutcome(input.command, {
        followAction: actionLabel,
        target,
        requestedCount,
        lookbackDays,
        candidateHandles,
        suggestedHandles: selectedHandles,
        remainingCount,
        discoverySource,
        agentOnly: suggestionOptions.agentOnly,
        topicHint: suggestionOptions.topicHint,
        chatCompletion: {
          body: summaryText,
          metadata: {
            automated: true,
            sourceContext: "CHAT",
            actionPreview: {
              type: "follow",
              status: "success",
              title: "Follow suggestions",
              summary: summaryText,
              suggestedCount: compactHandles.length,
              requestedCount,
            },
          },
        },
      });
    }

    const applied = await applyFollowForHandles(selectedHandles);
    const remainingCount = Math.max(0, candidateHandles.length - selectedHandles.length);
    const sourcedFromEngagers = discoverySource === "browse_top_engagers";
    const summaryText = buildFollowSummaryText({
      target,
      followed: applied.followed,
      alreadyFollowed: applied.alreadyFollowed,
      notFound: applied.notFound,
      self: applied.self,
      blocked: applied.blocked,
      failed: applied.failed,
      ...(sourcedFromEngagers ? { remainingCount } : {}),
      followEngagers: sourcedFromEngagers,
    });

    await deps.recordCommandLifecycleCheckpoint({
      command: input.command,
      stage: "write_mutation",
      status:
        applied.followed.length > 0 || applied.alreadyFollowed.length > 0
          ? "ok"
          : "failed",
      metadata: {
        action: actionLabel,
        target,
        requestedCount,
        candidatesFound: candidateHandles.length,
        followedCount: applied.followed.length,
        alreadyFollowedCount: applied.alreadyFollowed.length,
        failedCount:
          applied.failed.length +
          applied.notFound.length +
          applied.self.length +
          applied.blocked.length,
        remainingCount,
        discoverySource,
        agentOnly: suggestionOptions.agentOnly,
        topicHint: suggestionOptions.topicHint,
      },
    });

    return deps.successOutcome(input.command, {
      followAction: actionLabel,
      target,
      requestedCount,
      lookbackDays,
      candidateHandles,
      selectedHandles,
      followedHandles: applied.followed,
      alreadyFollowedHandles: applied.alreadyFollowed,
      notFoundHandles: applied.notFound,
      selfHandles: applied.self,
      blockedHandles: applied.blocked,
      failedHandles: applied.failed,
      errors: applied.errors,
      remainingCount,
      discoverySource,
      agentOnly: suggestionOptions.agentOnly,
      topicHint: suggestionOptions.topicHint,
      chatCompletion: {
        body: summaryText,
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: {
            type: "follow",
            status:
              applied.followed.length > 0 || applied.alreadyFollowed.length > 0
                ? "success"
                : "failed",
            title:
              discoverySource === "browse_top_engagers"
                ? "Follow-engagers update"
                : "Follow update",
            summary: summaryText,
          },
        },
      },
    });
  }

  const followSelections = collectFollowSelectionsFromPayload(input.payload)
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const explicitHandles = collectFollowHandlesFromPayload(input.payload);
  let mappedHandles = [...explicitHandles];
  const wantsAll = followSelections.includes("all");
  const indexSelections = followSelections
    .map((entry) => Number.parseInt(entry, 10))
    .filter((entry) => Number.isFinite(entry) && entry > 0)
    .map((entry) => Math.floor(entry));

  if (wantsAll || indexSelections.length > 0) {
    try {
      const followCount = resolveFollowEngagersCount(input.payload);
      const lookup = await deps.callAgentBridgeLookupCached(
        {
          action: "browse_top_engagers",
          limit: Math.min(60, Math.max(24, followCount * 4)),
          windowHours: (asPositiveInt(input.payload.followLookbackDays) ?? 120) * 24,
        },
        4_000,
      );
      const rankedHandles = extractTopEngagerHandlesFromLookup(
        lookup.value,
        60,
        deps.collectBridgeRecordItems,
      );
      if (wantsAll) {
        mappedHandles = [...mappedHandles, ...rankedHandles.slice(0, followCount)];
      } else {
        mappedHandles = [
          ...mappedHandles,
          ...indexSelections
            .map((value) => rankedHandles[value - 1] ?? null)
            .filter((value): value is string => Boolean(value)),
        ];
      }
    } catch (error: unknown) {
      return deps.failedOutcome(
        input.command,
        `Follow-accept lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        "follow_accept_lookup_failed",
      );
    }
  }

  const targetHandles = Array.from(new Set(mappedHandles)).slice(0, 24);
  if (targetHandles.length === 0) {
    return deps.successOutcome(input.command, {
      followAction: actionLabel,
      target,
      followInputMissing: true,
      chatCompletion: {
        body:
          "I do not have a pending follow suggestion list for this request. Ask for suggestions first, then confirm with handles or indexes.",
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: {
            type: "follow",
            status: "failed",
            title: "Follow accept pending list missing",
          },
        },
      },
    });
  }

  const applied = await applyFollowForHandles(targetHandles);
  const summaryText = buildFollowSummaryText({
    target,
    followed: applied.followed,
    alreadyFollowed: applied.alreadyFollowed,
    notFound: applied.notFound,
    self: applied.self,
    blocked: applied.blocked,
    failed: applied.failed,
  });

  await deps.recordCommandLifecycleCheckpoint({
    command: input.command,
    stage: "write_mutation",
    status:
      applied.followed.length > 0 || applied.alreadyFollowed.length > 0
        ? "ok"
        : "failed",
    metadata: {
      action: actionLabel,
      target,
      requestedCount: targetHandles.length,
      followedCount: applied.followed.length,
      alreadyFollowedCount: applied.alreadyFollowed.length,
      failedCount:
        applied.failed.length +
        applied.notFound.length +
        applied.self.length +
        applied.blocked.length,
    },
  });

  return deps.successOutcome(input.command, {
    followAction: actionLabel,
    target,
    followSelections,
    selectedHandles: targetHandles,
    followedHandles: applied.followed,
    alreadyFollowedHandles: applied.alreadyFollowed,
    notFoundHandles: applied.notFound,
    selfHandles: applied.self,
    blockedHandles: applied.blocked,
    failedHandles: applied.failed,
    errors: applied.errors,
    chatCompletion: {
      body: summaryText,
      metadata: {
        automated: true,
        sourceContext: "CHAT",
        actionPreview: {
          type: "follow",
          status:
            applied.followed.length > 0 || applied.alreadyFollowed.length > 0
              ? "success"
              : "failed",
          title: "Follow-accept update",
          summary: summaryText,
        },
      },
    },
  });
}
