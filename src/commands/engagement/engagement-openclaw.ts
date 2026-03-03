/** OpenClaw-based engagement orchestration — comment body curation and engagement action evaluation. */

import type { Command } from "../../types/ipc.js";
import type {
  CommandLifecycleState,
  CommentCurationContext,
  CuratedCommentBody,
  EngagementDecision,
  EngagementDecisionContext,
  OpenClawPromptExecutionResult,
} from "../types.js";
import { RequeueCommandError } from "../types.js";

import { truncateText } from "../helpers.js";

import {
  buildCommentCurationPrompt,
  buildDraftCommentFallback,
  validateCuratedCommentCandidate,
} from "../write/comment-curation.js";

import { extractActionContractFromUnknown } from "../write/action-contract.js";
import { buildEngagementDecisionPrompt } from "../chat/chat-completion.js";

import { loadCommentCurationContext } from "./engagement-context.js";
import { loadEngagementDecisionContext } from "./engagement-context.js";

import { nowIso } from "../../lib/text.js";

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

type OpenClawPromptFn = (input: {
  prompt: string;
  purpose: string;
}) => Promise<OpenClawPromptExecutionResult | null>;

type MemoryWriter = { recordWrite(entry: unknown): Promise<void> };
type ChatBridgeFn = (input: unknown) => Promise<unknown>;

type UpdateActionLifecycleFn = (input: {
  command: Command;
  action: "comment" | "like" | "repost" | "post";
  idempotencyKey: string;
  target: {
    postId: number | null;
    commentId: number | null;
    targetHash: string;
  };
  state: CommandLifecycleState;
  lastError?: string | null;
}) => void;

// ---------------------------------------------------------------------------
// curateCommentBodyWithOpenClaw
// ---------------------------------------------------------------------------

export async function curateCommentBodyWithOpenClaw(
  deps: {
    memory: MemoryWriter;
    callAgentChatBridge: ChatBridgeFn | null;
    runOpenClawPrompt: OpenClawPromptFn | null;
    updateActionLifecycle: UpdateActionLifecycleFn;
  },
  input: {
    command: Command;
    payload: Record<string, unknown>;
    postId: number;
    parentId: number | null;
    body: string;
    targetHash: string;
    lifecycleIdempotencyKey: string;
  },
): Promise<CuratedCommentBody> {
  const context = await loadCommentCurationContext(
    { callAgentChatBridge: deps.callAgentChatBridge, memory: deps.memory },
    {
      postId: input.postId,
      parentId: input.parentId,
      payload: input.payload,
    },
  );
  const draftBody = input.body.trim();
  if (!draftBody.length) {
    throw new Error("Comment blocked: empty draft body.");
  }
  const attemptDraftFallback = async (reason: string): Promise<CuratedCommentBody | null> => {
    const fallback = buildDraftCommentFallback({
      draftBody,
      context,
    });
    if (!fallback) return null;
    await deps.memory
      .recordWrite({
        type: "comment_body_curation_fallback",
        at: nowIso(),
        commandId: input.command.id,
        postId: input.postId,
        parentId: input.parentId,
        reason,
        draftBody: truncateText(draftBody, 200),
        fallbackBody: truncateText(fallback.body, 200),
      })
      .catch(() => undefined);
    return fallback;
  };

  const runOpenClawPrompt = deps.runOpenClawPrompt;
  if (!runOpenClawPrompt) {
    const fallback = await attemptDraftFallback("openclaw_required_unavailable");
    if (fallback) return fallback;
    throw new RequeueCommandError(
      "comment_curation_waiting_for_openclaw:openclaw_required_unavailable",
    );
  }
  if (!context.postText && !context.mediaSummary && !context.threadSummary) {
    await deps.memory
      .recordWrite({
        type: "comment_body_curation_blocked",
        at: nowIso(),
        commandId: input.command.id,
        postId: input.postId,
        parentId: input.parentId,
        reason: "missing_target_post_context",
      })
      .catch(() => undefined);
    const fallback = await attemptDraftFallback("missing_target_post_context");
    if (fallback) return fallback;
    throw new RequeueCommandError(
      "comment_curation_waiting_for_target_context:missing_target_post_context",
    );
  }
  let attemptedOpenClawCuration = false;
  let openClawCurationErrored = false;
  attemptedOpenClawCuration = true;
  try {
    deps.updateActionLifecycle({
      command: input.command,
      action: "comment",
      idempotencyKey: input.lifecycleIdempotencyKey,
      target: {
        postId: input.postId,
        commentId: input.parentId,
        targetHash: input.targetHash,
      },
      state: "llm_running",
    });
    const curationPrompt = buildCommentCurationPrompt({
      postId: input.postId,
      parentId: input.parentId,
      targetHash: input.targetHash,
      draftBody,
      context,
    });
    const result = await runOpenClawPrompt({
      prompt: curationPrompt,
      purpose: "comment_body_curation",
    });
    const contract =
      (result
        ? extractActionContractFromUnknown({
          value: result.parsed,
          action: "comment",
          expectedPostId: input.postId,
          expectedCommentId: input.parentId,
          expectedTargetHash: input.targetHash,
        }) ??
          extractActionContractFromUnknown({
            value: result.payloadText,
            action: "comment",
            expectedPostId: input.postId,
            expectedCommentId: input.parentId,
            expectedTargetHash: input.targetHash,
          }) ??
          extractActionContractFromUnknown({
            value: result.raw,
            action: "comment",
            expectedPostId: input.postId,
            expectedCommentId: input.parentId,
            expectedTargetHash: input.targetHash,
          })
        : null) ?? null;
    if (contract) {
      if (!contract.shouldExecute || !contract.body) {
        await deps.memory
          .recordWrite({
            type: "comment_body_curation_rejected",
            at: nowIso(),
            commandId: input.command.id,
            postId: input.postId,
            reason: contract.shouldExecute ? "missing_body" : "llm_declined_execute",
            draftBody: truncateText(draftBody, 200),
          })
          .catch(() => undefined);
      }
      if (contract.shouldExecute && contract.body) {
        const validation = validateCuratedCommentCandidate({
          candidate: contract.body,
          draftBody,
          context,
        });
        if (validation.ok) {
          return {
            body: contract.body,
            source: "openclaw",
            reason: "openclaw_curated",
          };
        }
        await deps.memory
          .recordWrite({
            type: "comment_body_curation_rejected",
            at: nowIso(),
            commandId: input.command.id,
            postId: input.postId,
            reason: validation.reason,
            draftBody: truncateText(draftBody, 200),
            candidate: truncateText(contract.body, 200),
          })
          .catch(() => undefined);
      }
    } else {
      await deps.memory
        .recordWrite({
          type: "comment_body_curation_missing_contract",
          at: nowIso(),
          commandId: input.command.id,
          postId: input.postId,
        })
        .catch(() => undefined);
    }
  } catch (error: unknown) {
    openClawCurationErrored = true;
    await deps.memory
      .recordWrite({
        type: "comment_body_curation_failed",
        at: nowIso(),
        commandId: input.command.id,
        postId: input.postId,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
  }

  if (openClawCurationErrored) {
    const fallback = await attemptDraftFallback("openclaw_curation_failed");
    if (fallback) return fallback;
    throw new RequeueCommandError(
      "comment_curation_waiting_for_openclaw:openclaw_curation_failed",
    );
  }
  const fallback = await attemptDraftFallback(
    attemptedOpenClawCuration
      ? "target_specific_llm_curation_required"
      : "missing_llm_curation",
  );
  if (fallback) return fallback;
  await deps.memory
    .recordWrite({
      type: "comment_body_curation_blocked",
      at: nowIso(),
      commandId: input.command.id,
      postId: input.postId,
      parentId: input.parentId,
      reason: attemptedOpenClawCuration
        ? "target_specific_llm_curation_required"
        : "missing_llm_curation",
      draftBody: truncateText(draftBody, 200),
    })
    .catch(() => undefined);
  throw new RequeueCommandError(
    "comment_curation_waiting_for_openclaw:openclaw_contract_invalid",
  );
}

// ---------------------------------------------------------------------------
// evaluateEngagementActionWithOpenClaw
// ---------------------------------------------------------------------------

export async function evaluateEngagementActionWithOpenClaw(
  deps: {
    memory: MemoryWriter;
    callAgentChatBridge: ChatBridgeFn | null;
    runOpenClawPrompt: OpenClawPromptFn | null;
    updateActionLifecycle: UpdateActionLifecycleFn;
  },
  input: {
    command: Command;
    action: "like" | "repost";
    postId: number;
    payload: Record<string, unknown>;
    targetHash: string;
    lifecycleIdempotencyKey: string;
  },
): Promise<EngagementDecision> {
  const context = await loadEngagementDecisionContext(
    { callAgentChatBridge: deps.callAgentChatBridge, memory: deps.memory },
    {
      action: input.action,
      postId: input.postId,
      payload: input.payload,
    },
  );
  const fallbackExecute = async (
    reason: string,
    errorMessage?: string,
  ): Promise<EngagementDecision> => {
    await deps.memory
      .recordWrite({
        type: "engagement_action_decision_fallback",
        at: nowIso(),
        commandId: input.command.id,
        action: input.action,
        postId: input.postId,
        reason,
        ...(errorMessage ? { error: errorMessage } : {}),
      })
      .catch(() => undefined);
    return {
      shouldExecute: true,
      reason,
      source: "agent_runtime",
      contract: null,
    };
  };
  const runOpenClawPrompt = deps.runOpenClawPrompt;
  if (!runOpenClawPrompt) {
    return fallbackExecute("agent_runtime_without_openclaw");
  }
  try {
    deps.updateActionLifecycle({
      command: input.command,
      action: input.action,
      idempotencyKey: input.lifecycleIdempotencyKey,
      target: {
        postId: input.postId,
        commentId: null,
        targetHash: input.targetHash,
      },
      state: "llm_running",
    });
    const prompt = buildEngagementDecisionPrompt({
      action: input.action,
      postId: input.postId,
      targetHash: input.targetHash,
      context,
    });
    const result = await runOpenClawPrompt({
      prompt,
      purpose: "engagement_action_decision",
    });
    const contract =
      (result
        ? extractActionContractFromUnknown({
          value: result.parsed,
          action: input.action,
          expectedPostId: input.postId,
          expectedCommentId: null,
          expectedTargetHash: input.targetHash,
        }) ??
          extractActionContractFromUnknown({
            value: result.payloadText,
            action: input.action,
            expectedPostId: input.postId,
            expectedCommentId: null,
            expectedTargetHash: input.targetHash,
          }) ??
          extractActionContractFromUnknown({
            value: result.raw,
            action: input.action,
            expectedPostId: input.postId,
            expectedCommentId: null,
            expectedTargetHash: input.targetHash,
          })
        : null) ?? null;
    if (!contract) {
      await deps.memory
        .recordWrite({
          type: "engagement_action_decision_missing",
          at: nowIso(),
          commandId: input.command.id,
          action: input.action,
          postId: input.postId,
        })
        .catch(() => undefined);
      return fallbackExecute("agent_runtime_openclaw_contract_invalid");
    }
    return {
      shouldExecute: contract.shouldExecute,
      reason: contract.reason,
      source: "openclaw",
      contract,
    };
  } catch (error: unknown) {
    await deps.memory
      .recordWrite({
        type: "engagement_action_decision_failed",
        at: nowIso(),
        commandId: input.command.id,
        action: input.action,
        postId: input.postId,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return fallbackExecute("agent_runtime_openclaw_error", errorMessage);
  }
}
