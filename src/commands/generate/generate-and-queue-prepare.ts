import { ENFORCE_PERMISSION_HINT_FILTERS } from "../constants.js";
import { RequeueCommandError } from "../types.js";
import type { Command } from "../types.js";
import {
  asNonEmptyString,
  normalizeAgentProvenanceValue,
} from "../helpers.js";
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";
import type {
  ExecuteGenerateAndQueueRuntime,
  GenerateAndQueuePreparationResult,
} from "./generate-and-queue.js";
import { ensureEnforcedDraftTarget } from "./generate-and-queue-enforced-target.js";

export async function prepareGenerateAndQueue(
  this: ExecuteGenerateAndQueueRuntime,
  command: Command,
): Promise<GenerateAndQueuePreparationResult> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return {
        kind: "outcome",
        outcome: this.failedOutcome(command, "Invalid payload for generate-and-queue command."),
      };
    }
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command,
      payload,
    });

    const delegatedFollowAction = this.resolveDelegatedFollowAction(payload);
    if (delegatedFollowAction) {
      return {
        kind: "outcome",
        outcome: await this.executeDelegatedFollowAction({
          command,
          payload,
          action: delegatedFollowAction,
        }),
      };
    }

    const isChatOrigin = this.isChatOriginCommand(command, payload);
    const chatCommandName = this.resolveChatCommandName(payload);
    const isAgentDecideChatCommand =
      (chatCommandName?.trim().toLowerCase() ?? "") === "agent-decide";
    const explicitStoryChatRequest = isChatOrigin
      ? this.didChatMessageExplicitlyRequestStory(payload)
      : false;
    if (
      isChatOrigin &&
      (!isAgentDecideChatCommand || explicitStoryChatRequest) &&
      this.isStoryGenerateRequestFromChatPayload(payload)
    ) {
      await this.ctx.memory
        .recordWrite({
          type: "story_generate_blocked_chat_request",
          at: nowIso(),
          commandId: command.id,
          commandKind: command.kind,
          sourceDirectiveId,
        })
        .catch(() => undefined);
      return {
        kind: "outcome",
        outcome: this.failedOutcome(
          command,
          "Story creation is directive-only. Chat requests can create posts, but not stories.",
          "story_chat_disabled",
        ),
      };
    }
    if (payload.chatLiteralGenerate === true) {
      return {
        kind: "outcome",
        outcome: await this.executeChatLiteralGenerate(command, payload),
      };
    }

    const sourceDirectiveActionNonce =
      this.resolveCommandSourceDirectiveActionNonce({ command, payload });
    const provenance = normalizeAgentProvenanceValue(payload.provenance);
    const enforcedDraftAction = this.resolveEnforcedDraftAction(payload);
    if (enforcedDraftAction) {
      const enforcedTargetResult = await ensureEnforcedDraftTarget(this, {
        command,
        payload,
        enforcedDraftAction,
      });
      if (enforcedTargetResult) {
        return enforcedTargetResult;
      }
    }

    // Check for previously-generated drafts cached from a prior attempt (requeue).
    // This prevents re-calling generate.mutate() when the command is retried.
    this.pruneGeneratedDraftCache();
    const cachedEntry = this.generatedDraftCache.get(command.id);
    const inlineDrafts = cachedEntry ? cachedEntry.drafts : this.extractInlineDrafts(payload);
    let generateInputRaw: Record<string, unknown> | null = null;
    if (!inlineDrafts.length) {
      try {
        generateInputRaw = await this.buildGenerateInputWithRuntimeContext(
          payload,
          command,
        );
      } catch (error: unknown) {
        const deferred = this.classifyMediaGenerationDeferral({
          error,
          hasPrompt: true,
        });
        if (deferred.shouldRequeue && deferred.reason) {
          const message = error instanceof Error ? error.message : String(error);
          await this.recordCommandLifecycleCheckpoint({
            command,
            stage: "generated",
            status: "failed",
            message,
            metadata: {
              requeued: true,
              reason: deferred.reason,
              reasonCode: deferred.reasonCode,
              personaSlug: deferred.personaSlug,
              source: "build_generate_input",
            },
          });
          await this.ctx.memory
            .recordWrite({
              type: "generate_deferred_for_setup",
              at: nowIso(),
              commandId: command.id,
              sourceDirectiveId,
              reason: deferred.reason,
              reasonCode: deferred.reasonCode,
              personaSlug: deferred.personaSlug,
              error: message,
            })
            .catch(() => undefined);
          throw new RequeueCommandError(deferred.reason);
        }
        throw error;
      }
    }
    const enforcePermissionHintFilters =
      ENFORCE_PERMISSION_HINT_FILTERS &&
      !this.isDirectiveContextLinkedCommand(command);
    const generateInput =
      enforcePermissionHintFilters &&
      generateInputRaw &&
      inlineDrafts.length === 0
        ? this.applyPermissionGenerateInputConstraints(
            generateInputRaw,
            payload.permissionState,
          )
        : generateInputRaw;
    if (
      enforcePermissionHintFilters &&
      generateInputRaw &&
      generateInput &&
      generateInput !== generateInputRaw
    ) {
      await this.ctx.memory
        .recordWrite({
          type: "generate_input_constrained_by_permissions",
          at: nowIso(),
          commandId: command.id,
          sourceDirectiveId,
          originalKinds: Array.isArray(generateInputRaw.kinds)
            ? generateInputRaw.kinds
            : [],
          constrainedKinds: Array.isArray(generateInput.kinds)
            ? generateInput.kinds
            : [],
          originalKind: asNonEmptyString(generateInputRaw.kind),
          constrainedKind: asNonEmptyString(generateInput.kind),
        })
        .catch(() => undefined);
    }
    const constrainedGenerateKinds =
      generateInput && Array.isArray(generateInput.kinds)
        ? generateInput.kinds
            .map((entry) => asNonEmptyString(entry)?.trim().toLowerCase() ?? "")
            .filter((entry) => entry.length > 0)
        : null;
    if (
      enforcePermissionHintFilters &&
      !inlineDrafts.length &&
      generateInputRaw &&
      generateInput &&
      generateInput !== generateInputRaw &&
      constrainedGenerateKinds !== null &&
      constrainedGenerateKinds.length === 0
    ) {
      await this.ctx.memory
        .recordWrite({
          type: "generate_blocked_by_permissions",
          at: nowIso(),
          commandId: command.id,
          sourceDirectiveId,
          originalKinds: Array.isArray(generateInputRaw.kinds)
            ? generateInputRaw.kinds
            : [],
        })
        .catch(() => undefined);
      return {
        kind: "outcome",
        outcome: this.failedOutcome(
          command,
          "No permission-allowed generation actions are available right now.",
          "no_permitted_generate_kind",
        ),
      };
    }
    let generatedResult: unknown = null;
    if (!inlineDrafts.length) {
      try {
        generatedResult = await this.agent().generate.mutate(
          generateInput ?? this.buildGenerateInput(payload, command),
        );
        await this.recordCommandLifecycleCheckpoint({
          command,
          stage: "generated",
          status: "ok",
          metadata: {
            hasGeneratedResult: Boolean(generatedResult),
          },
        });
      } catch (error: unknown) {
        await this.recordCommandLifecycleCheckpoint({
          command,
          stage: "generated",
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    const drafts =
      inlineDrafts.length > 0
        ? inlineDrafts
        : this.extractGeneratedDrafts(generatedResult);

    // Cache generated drafts so requeued commands skip the expensive generate.mutate() call.
    if (drafts.length > 0 && !cachedEntry) {
      this.generatedDraftCache.set(command.id, { drafts, cachedAtMs: Date.now() });
    }

    const executableDrafts =
      enforcedDraftAction === null
        ? drafts
        : drafts.filter(
            (draft) => draft.action.trim().toLowerCase() === enforcedDraftAction,
          );
    const permissionFilteredDrafts = enforcePermissionHintFilters
      ? executableDrafts.filter((draft) =>
          this.isGeneratedDraftAllowedByPermissionState(
            draft,
            payload.permissionState,
          ),
        )
      : executableDrafts;
    if (
      enforcePermissionHintFilters &&
      executableDrafts.length > 0 &&
      permissionFilteredDrafts.length !== executableDrafts.length
    ) {
      const droppedActions = executableDrafts
        .filter((draft) => !permissionFilteredDrafts.includes(draft))
        .map((draft) => draft.action.trim().toLowerCase())
        .slice(0, 12);
      await this.ctx.memory
        .recordWrite({
          type: "generate_draft_filtered_by_permissions",
          at: nowIso(),
          commandId: command.id,
          sourceDirectiveId,
          beforeCount: executableDrafts.length,
          afterCount: permissionFilteredDrafts.length,
          droppedActions,
        })
        .catch(() => undefined);
    }
    let executionDrafts = permissionFilteredDrafts;
    if (isChatOrigin && executionDrafts.length > 0) {
      const chatCandidateDrafts = executionDrafts;
      const blockedStoryDraftCount = chatCandidateDrafts.filter(
        (draft) => draft.action.trim().toLowerCase() === "story",
      ).length;
      const firstBlockedStoryDraft =
        blockedStoryDraftCount > 0
          ? chatCandidateDrafts.find(
              (draft) => draft.action.trim().toLowerCase() === "story",
            ) ?? null
          : null;
      if (blockedStoryDraftCount > 0) {
        executionDrafts = chatCandidateDrafts.filter(
          (draft) => draft.action.trim().toLowerCase() !== "story",
        );
        await this.ctx.memory
          .recordWrite({
            type: "story_drafts_blocked_chat_request",
            at: nowIso(),
            commandId: command.id,
            commandKind: command.kind,
            sourceDirectiveId,
            blockedStoryDraftCount,
            retainedDraftCount: executionDrafts.length,
          })
          .catch(() => undefined);
      }
      if (executionDrafts.length === 0 && blockedStoryDraftCount > 0) {
        if (!explicitStoryChatRequest) {
          await this.ctx.memory
            .recordWrite({
              type: "story_drafts_suppressed_chat_request",
              at: nowIso(),
              commandId: command.id,
              commandKind: command.kind,
              sourceDirectiveId,
              blockedStoryDraftCount,
            })
            .catch(() => undefined);
        }
        if (!explicitStoryChatRequest) {
          const storyFallbackPrompt =
            asNonEmptyString(firstBlockedStoryDraft?.payload.mediaPrompt) ??
            asNonEmptyString(firstBlockedStoryDraft?.payload.imagePrompt) ??
            asNonEmptyString(firstBlockedStoryDraft?.payload.prompt) ??
            asNonEmptyString(firstBlockedStoryDraft?.payload.topic) ??
            asNonEmptyString(firstBlockedStoryDraft?.payload.caption);
          await this.ctx.memory
            .recordWrite({
              type: "story_drafts_redirected_chat_literal_generate",
              at: nowIso(),
              commandId: command.id,
              commandKind: command.kind,
              sourceDirectiveId,
              blockedStoryDraftCount,
            })
            .catch(() => undefined);
          const fallbackPayload = this.buildChatLiteralFallbackPayloadFromStory({
            payload,
            fallbackPrompt: storyFallbackPrompt,
          });
          return {
            kind: "outcome",
            outcome: await this.executeChatLiteralGenerate(command, fallbackPayload),
          };
        }
        return {
          kind: "outcome",
          outcome: this.failedOutcome(
            command,
            explicitStoryChatRequest
              ? "Story creation is directive-only. Chat requests can create posts, but not stories."
              : "generate returned no permission-allowed drafts.",
            explicitStoryChatRequest ? "story_chat_disabled" : "no_permitted_drafts",
          ),
        };
      }
    }
    const personaMediaLock = this.isPersonaMediaLockEnabled(payload);
    if (personaMediaLock) {
      const personaCompatibleDrafts = executionDrafts.filter((draft) =>
        this.isPersonaMediaCompatibleDraft(draft),
      );
      if (personaCompatibleDrafts.length > 0) {
        executionDrafts = personaCompatibleDrafts;
      } else {
        const fallbackDraft = this.buildPersonaLockedMediaFallbackDraft({
          payload,
          drafts: executionDrafts.length > 0 ? executionDrafts : drafts,
        });
        const fallbackAllowed =
          fallbackDraft &&
          (!enforcePermissionHintFilters ||
            this.isGeneratedDraftAllowedByPermissionState(
              fallbackDraft,
              payload.permissionState,
            ));
        if (fallbackDraft && fallbackAllowed) {
          executionDrafts = [fallbackDraft];
          await this.ctx.memory
            .recordWrite({
              type: "persona_media_lock_fallback_draft",
              at: nowIso(),
              commandId: command.id,
              sourceDirectiveId,
              reason: "no_persona_compatible_generated_draft",
            })
            .catch(() => undefined);
        } else {
          executionDrafts = [];
        }
      }
    }
    if (isChatOrigin && executionDrafts.length > 0) {
      const allowChatWriteExecution = this.isChatWriteCommandExplicitlyRequested(payload);
      const blockedWriteDrafts = executionDrafts.filter((draft) =>
        this.isWriteDraftAction(draft.action),
      );
      if (blockedWriteDrafts.length > 0 && !allowChatWriteExecution) {
        executionDrafts = executionDrafts.filter(
          (draft) => !this.isWriteDraftAction(draft.action),
        );
        await this.ctx.memory
          .recordWrite({
            type: "chat_write_drafts_blocked_missing_explicit_request",
            at: nowIso(),
            commandId: command.id,
            commandKind: command.kind,
            sourceDirectiveId,
            blockedDraftCount: blockedWriteDrafts.length,
            blockedActions: blockedWriteDrafts
              .map((draft) => draft.action.trim().toLowerCase())
              .filter((value) => value.length > 0)
              .slice(0, 12),
            retainedDraftCount: executionDrafts.length,
          })
          .catch(() => undefined);
        if (executionDrafts.length === 0) {
          if (
            this.shouldRedirectBlockedChatWritesToLiteralGenerate({
              payload,
              blockedDrafts: blockedWriteDrafts,
            })
          ) {
            const fallbackPrompt =
              this.resolveChatLiteralFallbackPromptFromDrafts({
                payload,
                drafts: blockedWriteDrafts,
              });
            await this.ctx.memory
              .recordWrite({
                type: "chat_write_drafts_redirected_chat_literal_generate",
                at: nowIso(),
                commandId: command.id,
                commandKind: command.kind,
                sourceDirectiveId,
                blockedDraftCount: blockedWriteDrafts.length,
              })
              .catch(() => undefined);
            const fallbackPayload = this.buildChatLiteralFallbackPayloadFromStory({
              payload,
              ...(fallbackPrompt ? { fallbackPrompt } : {}),
            });
            return {
              kind: "outcome",
              outcome: await this.executeChatLiteralGenerate(command, fallbackPayload),
            };
          }
          return {
            kind: "outcome",
            outcome: this.failedOutcome(
              command,
              "Chat write actions require an explicit request to post/comment/reply/like/repost/story.",
              "chat_write_explicit_required",
            ),
          };
        }
      }
      if (
        allowChatWriteExecution &&
        blockedWriteDrafts.length > 0 &&
        !this.isChatWriteRequesterOwner(payload)
      ) {
        executionDrafts = executionDrafts.filter(
          (draft) => !this.isWriteDraftAction(draft.action),
        );
        await this.ctx.memory
          .recordWrite({
            type: "chat_write_drafts_blocked_non_owner",
            at: nowIso(),
            commandId: command.id,
            commandKind: command.kind,
            sourceDirectiveId,
            blockedDraftCount: blockedWriteDrafts.length,
            blockedActions: blockedWriteDrafts
              .map((draft) => draft.action.trim().toLowerCase())
              .filter((value) => value.length > 0)
              .slice(0, 12),
            retainedDraftCount: executionDrafts.length,
          })
          .catch(() => undefined);
        if (executionDrafts.length === 0) {
          return {
            kind: "outcome",
            outcome: this.failedOutcome(
              command,
              "Chat write actions are owner-only unless explicitly granted.",
              "chat_write_owner_only",
            ),
          };
        }
      }
    }
    if (enforcedDraftAction !== null && executableDrafts.length === 0) {
      await this.ctx.memory
        .recordWrite({
          type: "generate_draft_action_mismatch",
          at: nowIso(),
          commandId: command.id,
          commandKind: command.kind,
          enforcedAction: enforcedDraftAction,
          generatedActions: drafts
            .map((draft) => draft.action.trim().toLowerCase())
            .filter((action) => action.length > 0)
            .slice(0, 12),
          sourceDirectiveId,
        })
        .catch(() => undefined);
      return {
        kind: "outcome",
        outcome: this.failedOutcome(
          command,
          `generate returned no executable ${enforcedDraftAction} draft.`,
          "no_executable_draft",
        ),
      };
    }
    const allowMultipleGeneratedDrafts =
      payload.allowMultipleGeneratedDrafts === true ||
      payload.executeAllDrafts === true;
    if (
      this.isDirectiveContextLinkedCommand(command) &&
      !allowMultipleGeneratedDrafts &&
      executionDrafts.length > 1
    ) {
      const keptDraft = executionDrafts[0];
      executionDrafts = keptDraft ? [keptDraft] : [];
      await this.ctx.memory
        .recordWrite({
          type: "generate_draft_multi_suppressed",
          at: nowIso(),
          commandId: command.id,
          sourceDirectiveId,
          originalDraftCount: permissionFilteredDrafts.length,
          keptDraftAction: keptDraft?.action ?? null,
          policy: "single_prompt_per_directive",
        })
        .catch(() => undefined);
    }
    if (executionDrafts.length === 0) {
      if (payload.requireDraftOnly === true) {
        const previewDelivered = await this.sendDraftFailureMessage({
          payload,
          message: "I couldn't generate a draft right now. Please try again.",
        }).catch(() => false);
        const failed = this.failedOutcome(
          command,
          "generate returned no permission-allowed drafts.",
          "no_permitted_drafts",
        );
        return {
          kind: "outcome",
          outcome: {
            ...failed,
            data: {
              mode: "draft_preview",
              chatDeliveryHandled: previewDelivered,
            },
          },
        };
      }
      return {
        kind: "outcome",
        outcome: this.failedOutcome(
          command,
          "generate returned no permission-allowed drafts.",
          "no_permitted_drafts",
        ),
      };
    }

    const requireDraftOnly = payload.requireDraftOnly === true;
    if (requireDraftOnly) {
      const draftPreview = this.buildDraftPreviewPayload(executionDrafts);
      if (!draftPreview) {
        const previewDelivered = await this.sendDraftFailureMessage({
          payload,
          message: "I generated output, but couldn't shape a readable draft preview.",
        }).catch(() => false);
        const failed = this.failedOutcome(
          command,
          "generate returned drafts without previewable text.",
          "draft_preview_missing",
        );
        return {
          kind: "outcome",
          outcome: {
            ...failed,
            data: {
              mode: "draft_preview",
              chatDeliveryHandled: previewDelivered,
            },
          },
        };
      }
      const previewDelivered = await this.sendDraftPreviewMessage({
        payload,
        preview: draftPreview,
      }).catch(() => false);
      if (!previewDelivered) {
        return {
          kind: "outcome",
          outcome: this.failedOutcome(
            command,
            "Draft generated, but preview delivery to chat failed.",
            "draft_preview_delivery_failed",
          ),
        };
      }
      return {
        kind: "outcome",
        outcome: this.successOutcome(command, {
          generated: generatedResult,
          draftOnly: true,
          draftCount: executionDrafts.length,
          chatDeliveryHandled: previewDelivered,
          preview: {
            summary: draftPreview.summary,
            postKind: draftPreview.draftPostKind,
            mode: draftPreview.draftMode,
            slideCount: draftPreview.draftSlideCount,
          },
        }),
      };
    }

    const requireExplicitPublishVerb = payload.requireExplicitPublishVerb === true;
    const explicitPublishRequested = payload.explicitPublishRequested === true;
    if (
      requireExplicitPublishVerb &&
      !explicitPublishRequested &&
      this.shouldEnforceExplicitPublishGate(payload)
    ) {
      const blockedDraftCount = executionDrafts.filter((draft) =>
        this.isWriteDraftAction(draft.action),
      ).length;
      if (blockedDraftCount > 0) {
        await this.ctx.memory.recordWrite({
          type: "publish_blocked_missing_explicit_request",
          at: nowIso(),
          commandId: command.id,
          commandKind: command.kind,
          blockedDraftCount,
          sourceDirectiveId,
        }).catch(() => undefined);
        return {
          kind: "outcome",
          outcome: this.failedOutcome(
            command,
            "Write action blocked: explicit post/comment/reply/like/repost/story request required.",
            "publish_verb_required",
          ),
        };
      }
    }

    return {
      kind: "prepared",
      state: {
        command,
        payload,
        sourceDirectiveId,
        sourceDirectiveActionNonce,
        provenance,
        generatedResult,
        executionDrafts,
      },
    };
}
