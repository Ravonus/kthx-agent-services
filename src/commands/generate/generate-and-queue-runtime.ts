import { pruneGeneratedDraftCache as _pruneDraftCache } from "../cache/cache.js";
import { sendDraftPreviewMessage as _sendDraftPreview } from "../chat/chat-delivery.js";
import {
isDirectiveContextLinkedCommand as _isDirectiveLinked,
resolveCommandSourceDirectiveId as _resolveDirectiveId,
resolveCommandSourceDirectiveActionNonce as _resolveNonce,
} from "../directives/resolution.js";
import {
resolveChatCommandName as _resolveChatCmd,
resolveDelegatedFollowAction as _resolveFollowAction,
} from "../follow/follow-actions.js";
import {
isNoTargetDiscoveryFailure as _isNoTargetFailure,
isRecoverableDraftExecutionError as _isRecoverableExecError,
isRecoverableDraftGrantErrorMessage as _isRecoverableGrantError,
isRecoverableDraftSkipDecision as _isRecoverableSkip,
} from "../grants/grants.js";
import { isPersonaMediaLockEnabled as _isPersonaMediaLock } from "../persona/persona-resolution.js";
import {
didChatMessageExplicitlyRequestStory as _didExplicitStory,
isChatOriginCommand as _isChatOriginCommand,
isChatWriteCommandExplicitlyRequested as _isChatWriteExplicit,
isChatWriteRequesterOwner as _isChatWriteOwner,
isStoryGenerateRequestFromChatPayload as _isStoryGenRequest,
isWriteDraftAction as _isWriteDraftAction,
resolveChatLiteralFallbackPromptFromDrafts as _resolveLiteralFallback,
shouldEnforceExplicitPublishGate as _shouldEnforcePublishGate,
shouldRedirectBlockedChatWritesToLiteralGenerate as _shouldRedirectToLiteral,
} from "../write/chat-write-intent.js";
import { buildDraftPreviewPayload as _buildDraftPreview } from "../write/draft-preview.js";
import { buildChatLiteralFallbackPayloadFromStory as _buildStoryFallback } from "../write/post-draft-curation.js";
import {
applyPermissionGenerateInputConstraints as _applyPermissionConstraints,
buildPersonaLockedMediaFallbackDraft as _buildPersonaFallbackDraft,
extractGeneratedDrafts as _extractGenDrafts,
extractInlineDrafts as _extractInlineDrafts,
isGeneratedDraftAllowedByPermissionState as _isDraftAllowed,
resolveEnforcedDraftAction as _resolveEnforcedAction,
} from "./generate-input.js";

import type {
Command,
CommandLifecycleCheckpointStage,
CommandOutcome,
DraftPreviewPayload,
} from "../types.js";
import type { ExecuteGenerateAndQueueRuntime } from "./generate-and-queue.js";

type ChatBridgeFn = ((input: unknown) => Promise<unknown>) | null;

type BuildGenerateAndQueueRuntimeDeps = {
  ctx: {
    memory: {
      recordWrite(entry: unknown): Promise<void>;
    };
    callAgentChatBridge: ChatBridgeFn;
  };
  generatedDraftCache: ExecuteGenerateAndQueueRuntime["generatedDraftCache"];
  agent: ExecuteGenerateAndQueueRuntime["agent"];
  executeDelegatedFollowAction: ExecuteGenerateAndQueueRuntime["executeDelegatedFollowAction"];
  executeChatLiteralGenerate: ExecuteGenerateAndQueueRuntime["executeChatLiteralGenerate"];
  resolveEngagementTargetForDirective: ExecuteGenerateAndQueueRuntime["resolveEngagementTargetForDirective"];
  buildGenerateInputWithRuntimeContext: ExecuteGenerateAndQueueRuntime["buildGenerateInputWithRuntimeContext"];
  classifyMediaGenerationDeferral: ExecuteGenerateAndQueueRuntime["classifyMediaGenerationDeferral"];
  recordCommandLifecycleCheckpoint: (input: {
    command: Command;
    stage: CommandLifecycleCheckpointStage;
    status?: "ok" | "failed";
    message?: string | null;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  buildGenerateInput: ExecuteGenerateAndQueueRuntime["buildGenerateInput"];
  isPersonaMediaCompatibleDraft: ExecuteGenerateAndQueueRuntime["isPersonaMediaCompatibleDraft"];
  sendDraftFailureMessage: ExecuteGenerateAndQueueRuntime["sendDraftFailureMessage"];
  mapDraftToWriteCommand: ExecuteGenerateAndQueueRuntime["mapDraftToWriteCommand"];
  executeCommandFromMappedDraft: ExecuteGenerateAndQueueRuntime["executeCommandFromMappedDraft"];
  successOutcome: (command: Command, data: unknown) => CommandOutcome;
  failedOutcome: (command: Command, message: string, code?: string) => CommandOutcome;
};

function toChatDeliveryPreview(preview: {
  summary: string;
  body: string;
  draftPostKind: string | null;
  draftMode: string | null;
  draftSlideCount: number | null;
}): DraftPreviewPayload {
  return {
    body: preview.body,
    summary: preview.summary,
    draftPreviewText: preview.body,
    draftPostKind: preview.draftPostKind === "thread" ? "thread" : "post",
    draftMode: preview.draftMode === "carousel" ? "carousel" : "thread",
    draftSlideCount:
      typeof preview.draftSlideCount === "number" && Number.isFinite(preview.draftSlideCount)
        ? Math.max(1, Math.trunc(preview.draftSlideCount))
        : 1,
  };
}

export function buildGenerateAndQueueRuntime(
  deps: BuildGenerateAndQueueRuntimeDeps,
): ExecuteGenerateAndQueueRuntime {
  return {
    ctx: { memory: deps.ctx.memory },
    generatedDraftCache: deps.generatedDraftCache,
    agent: () => deps.agent(),
    resolveCommandSourceDirectiveId: (input) => _resolveDirectiveId(input),
    resolveDelegatedFollowAction: (payload) => _resolveFollowAction(payload),
    executeDelegatedFollowAction: (input) => deps.executeDelegatedFollowAction(input),
    isChatOriginCommand: (command, payloadOverride) =>
      _isChatOriginCommand(command, payloadOverride),
    resolveChatCommandName: (payload) => _resolveChatCmd(payload),
    didChatMessageExplicitlyRequestStory: (payload) => _didExplicitStory(payload),
    isStoryGenerateRequestFromChatPayload: (payload) => _isStoryGenRequest(payload),
    executeChatLiteralGenerate: (command, payload) =>
      deps.executeChatLiteralGenerate(command, payload),
    failedOutcome: (command, message, code) => deps.failedOutcome(command, message, code),
    successOutcome: (command, data) => deps.successOutcome(command, data),
    resolveCommandSourceDirectiveActionNonce: (input) => _resolveNonce(input),
    resolveEnforcedDraftAction: (payload) => _resolveEnforcedAction(payload),
    resolveEngagementTargetForDirective: (input) =>
      deps.resolveEngagementTargetForDirective(input),
    isNoTargetDiscoveryFailure: _isNoTargetFailure,
    pruneGeneratedDraftCache: () => _pruneDraftCache(deps.generatedDraftCache),
    extractInlineDrafts: (payload) => _extractInlineDrafts(payload),
    buildGenerateInputWithRuntimeContext: (payload, command) =>
      deps.buildGenerateInputWithRuntimeContext(payload, command),
    classifyMediaGenerationDeferral: (input) => deps.classifyMediaGenerationDeferral(input),
    recordCommandLifecycleCheckpoint: (input) =>
      deps.recordCommandLifecycleCheckpoint({
        ...input,
        stage: input.stage as CommandLifecycleCheckpointStage,
      }),
    isDirectiveContextLinkedCommand: (command) => _isDirectiveLinked(command),
    applyPermissionGenerateInputConstraints: (generateInput, permissionState) =>
      _applyPermissionConstraints(generateInput, permissionState),
    buildGenerateInput: (payload, command) => deps.buildGenerateInput(payload, command),
    extractGeneratedDrafts: (generatedResult) => _extractGenDrafts(generatedResult),
    isGeneratedDraftAllowedByPermissionState: (draft, permissionState) =>
      _isDraftAllowed(draft, permissionState),
    isPersonaMediaLockEnabled: (payload) => _isPersonaMediaLock(payload),
    isPersonaMediaCompatibleDraft: (draft) => deps.isPersonaMediaCompatibleDraft(draft),
    buildPersonaLockedMediaFallbackDraft: (input) => _buildPersonaFallbackDraft(input),
    isChatWriteCommandExplicitlyRequested: (payload) => _isChatWriteExplicit(payload),
    isWriteDraftAction: (actionValue) => _isWriteDraftAction(actionValue),
    shouldRedirectBlockedChatWritesToLiteralGenerate: (input) =>
      _shouldRedirectToLiteral(input),
    resolveChatLiteralFallbackPromptFromDrafts: (input) => _resolveLiteralFallback(input),
    isChatWriteRequesterOwner: (payload) => _isChatWriteOwner(payload),
    shouldEnforceExplicitPublishGate: (payload) => _shouldEnforcePublishGate(payload),
    sendDraftFailureMessage: (input) => deps.sendDraftFailureMessage(input),
    buildDraftPreviewPayload: (drafts) => {
      const preview = _buildDraftPreview(drafts);
      if (!preview) return null;
      return {
        summary: preview.summary,
        body: preview.body,
        draftPostKind: preview.draftPostKind,
        draftMode: preview.draftMode,
        draftSlideCount: preview.draftSlideCount,
      };
    },
    sendDraftPreviewMessage: (input) =>
      _sendDraftPreview(deps.ctx.callAgentChatBridge, {
        payload: input.payload,
        preview: toChatDeliveryPreview(input.preview),
      }),
    mapDraftToWriteCommand: (input) => deps.mapDraftToWriteCommand(input),
    executeCommandFromMappedDraft: (command) => deps.executeCommandFromMappedDraft(command),
    isRecoverableDraftGrantErrorMessage: _isRecoverableGrantError,
    isRecoverableDraftSkipDecision: _isRecoverableSkip,
    isRecoverableDraftExecutionError: _isRecoverableExecError,
    buildChatLiteralFallbackPayloadFromStory: (input) => _buildStoryFallback(input),
  };
}
