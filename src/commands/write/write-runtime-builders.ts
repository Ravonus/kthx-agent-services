import { nowIso } from "../../lib/text.js";
import {
resolveCommandSourceDirectiveId as _resolveDirectiveId,
} from "../directives/resolution.js";
import { loadPostDraftContext as _loadPostDraftContext } from "../engagement/engagement-context.js";
import {
curateCommentBodyWithOpenClaw as _curateCommentWithOC,
evaluateEngagementActionWithOpenClaw as _evaluateEngagementWithOC,
} from "../engagement/engagement-openclaw.js";
import {
resolveProfileWriteTarget as _resolveProfileTarget,
} from "../follow/follow-actions.js";
import {
isExplicitMultiMediaRequest as _isMultiMedia,
} from "../generate/generate-input.js";
import {
beginActionLifecycle as _beginLifecycle,
buildActionIdempotencyKey as _buildActionIdempotencyKey,
executeCreatePostMutationWithIdempotency as _execPostMutation,
isOwnerCapabilityDeniedError as _isDeniedError,
isNoTargetDiscoveryFailure as _isNoTargetFailure,
preflightGrantForAction as _preflightGrant,
registerOwnerCapabilityCooldown as _registerCooldown,
updateActionLifecycle as _updateLifecycle,
} from "../grants/grants.js";
import {
didChatMessageExplicitlyRequestStory as _didExplicitStory,
isChatOriginCommand as _isChatOriginCommand,
isChatWriteRequesterOwner as _isChatWriteOwner,
} from "./chat-write-intent.js";
import {
curatePostDraftWithOpenClaw as _curateDraftWithOC,
planTextPostVisualWithOpenClaw as _planVisualWithOC,
} from "./openclaw-curation.js";
import {
buildDirectiveScopedMediaGenerationPayload as _buildDirectiveMediaPayload,
collectDirectiveTaggedHandles as _collectTaggedHandles,
buildChatLiteralFallbackPayloadFromStory as _buildStoryFallback,
collectDirectiveSeedHints as _collectSeedHints,
extractTargetPostIdForPostDraft as _extractTargetPostId,
} from "./post-draft-curation.js";
import {
buildPostNoveltyCandidateText as _buildNoveltyText,
notePublishedPostForNoveltyHistory as _noteNoveltyHistory,
snapshotRecentPostNoveltyReferences as _snapshotNoveltyRefs,
validatePostDraftNovelty as _validateNovelty,
} from "./post-novelty.js";
import { notePublishedPostVarietyMode as _noteVarietyMode } from "./post-variety.js";
import {
buildAutonomousTextBackgroundPrompt as _buildTextBgPrompt,
normalizeCaptionPositionValue as _normalizeCaptionPos,
pickDeterministicIndex as _pickDeterministic,
resolveAutonomousCaptionPosition as _resolveCaptionPos,
resolveAutonomousGradientBackground as _resolveGradientBg,
sanitizeTextStyleValue as _sanitizeTextStyle,
} from "./post-visual.js";

import type {
AgentRouterLike,
Command,
CommandOutcome,
CuratedMediaPromptCacheEntry,
CuratedPostDraftCacheEntry,
OpenClawPromptExecutionResult,
OwnerCapabilityCooldown,
PersonaReferencePlan,
PostDraftContext,
PostVarietyMode,
RecentPostNoveltyEntry,
RecentPostVarietyModeEntry,
ResolvedMediaUpload,
StateSqliteStore,
TextPostVisualSlide,
TextStyleTheme,
} from "../types.js";
import type { ExecuteWriteCreatePostRuntime } from "./write-create-post.js";
import type { ExecuteWriteCreateStoryRuntime } from "./write-create-story.js";
import type { ExecuteWriteEngagementRuntime } from "./write-engagement-actions.js";
import type { ExecuteWriteProfileRuntime } from "./write-profile-actions.js";

type ChatBridgeFn = ((input: unknown) => Promise<unknown>) | null;

type MemoryWriter = {
  recordWrite(entry: unknown): Promise<void>;
};

export type BuildWriteRuntimeDeps = {
  ctx: {
    memory: MemoryWriter;
    callAgentChatBridge: ChatBridgeFn;
    runOpenClawPrompt: ((input: { prompt: string; purpose: string }) => Promise<OpenClawPromptExecutionResult | null>) | null;
    stateDb: StateSqliteStore | null | undefined;
  };
  bridgeLookupCache: Map<string, { expiresAtMs: number; value: unknown }>;
  curatedPostDraftCache: Map<string, CuratedPostDraftCacheEntry>;
  curatedMediaPromptCache: Map<string, CuratedMediaPromptCacheEntry>;
  recentPostNoveltyHistory: RecentPostNoveltyEntry[];
  recentPostVarietyModeHistory: RecentPostVarietyModeEntry[];
  ownerCapabilityDeniedByTarget: Map<string, OwnerCapabilityCooldown>;
  agent: () => AgentRouterLike;
  failedOutcome: (command: Command, message: string, code?: string) => CommandOutcome;
  successOutcome: (command: Command, data: unknown) => CommandOutcome;
  resolveAutonomousTextTheme: (input: {
    commandId: string;
    postKind: "post" | "thread";
    caption: string | null;
    textBody: string;
  }) => TextStyleTheme;
  buildAutonomousVisualPrompt: (input: {
    basePrompt: string;
    caption: string | null;
    commandId: string;
    theme: TextStyleTheme;
    mode: "slide" | "story" | "background";
    index: number;
  }) => string;
  buildAutonomousThreadSlides: (input: {
    commandId: string;
    caption: string | null;
    textBody: string;
    theme: TextStyleTheme;
    postKind: "post" | "thread";
  }) => TextPostVisualSlide[];
  buildAutonomousMediaSlides: (input: {
    commandId: string;
    postKind: "post" | "thread";
    caption: string | null;
    mediaPrompt: string;
    theme: TextStyleTheme;
  }) => TextPostVisualSlide[];
  normalizeAgentTextStyle: (
    style: Record<string, unknown> | null,
    captionPosition: string | null,
    fallbackStyle?: Record<string, unknown> | null,
  ) => Record<string, unknown>;
  selectPostVarietyMode: (input: {
    commandId: string;
    postType: "text" | "media";
    payload: Record<string, unknown>;
    context: PostDraftContext;
    seedHints: string[];
  }) => {
    mode: PostVarietyMode;
    reason: string;
    recentModes: PostVarietyMode[];
    signal: string;
  };
  notePublishedPostVarietyMode: (input: {
    commandId: string;
    postType: "text" | "media";
    targetPostId: number | null;
    mode: PostVarietyMode;
    signal: string;
  }) => void;
  resolvePersonaReferencePlan: (
    payload: Record<string, unknown>,
    mainPersonaSlugRaw?: string | null,
    command?: Command | null,
  ) => PersonaReferencePlan;
  shouldUsePersonaFrameReferences: (plan: PersonaReferencePlan) => boolean;
  resolveMediaUpload: (input: {
    payload: Record<string, unknown>;
    keepOriginal?: boolean;
    promptFallbacks: Array<string | null>;
    command?: Command;
    skipPromptCuration?: boolean;
  }) => Promise<ResolvedMediaUpload>;
  executeChatLiteralGenerate: (
    command: Command,
    payload: Record<string, unknown>,
  ) => Promise<CommandOutcome>;
  resolveEngagementTargetForDirective: ExecuteWriteEngagementRuntime["resolveEngagementTargetForDirective"];
};

export function buildWriteCreatePostRuntime(
  deps: BuildWriteRuntimeDeps,
): ExecuteWriteCreatePostRuntime {
  return {
    ctx: { memory: deps.ctx.memory },
    failedOutcome: (command, message, code) =>
      deps.failedOutcome(command, message, code),
    successOutcome: (command, data) => deps.successOutcome(command, data),
    isChatOriginCommand: (command, payloadOverride) =>
      _isChatOriginCommand(command, payloadOverride),
    isChatWriteRequesterOwner: (payload) => _isChatWriteOwner(payload),
    resolveCommandSourceDirectiveId: (input) => _resolveDirectiveId(input),
    extractTargetPostIdForPostDraft: (payload) => _extractTargetId(payload),
    loadPostDraftContext: (input) =>
      _loadPostDraftContext(
        {
          callAgentChatBridge: deps.ctx.callAgentChatBridge,
          memory: deps.ctx.memory,
          bridgeLookupCache: deps.bridgeLookupCache,
        },
        input,
      ),
    collectDirectiveSeedHints: (payload) => _collectSeedHints(payload),
    collectDirectiveTaggedHandles: (payload) => _collectTaggedHandles(payload),
    selectPostVarietyMode: (input) => deps.selectPostVarietyMode(input),
    curatePostDraftWithOpenClaw: (input) =>
      _curateDraftWithOC(
        {
          runOpenClawPrompt: deps.ctx.runOpenClawPrompt,
          memory: deps.ctx.memory,
          curatedPostDraftCache: deps.curatedPostDraftCache,
          curatedMediaPromptCache: deps.curatedMediaPromptCache,
        },
        input,
      ),
    snapshotRecentPostNoveltyReferences: (postType) =>
      _snapshotNoveltyRefs(deps.recentPostNoveltyHistory, postType),
    validatePostDraftNovelty: (input) =>
      _validateNovelty(deps.recentPostNoveltyHistory, input),
    buildPostNoveltyCandidateText: (input) => _buildNoveltyText(input),
    buildDirectiveScopedMediaGenerationPayload: (input) =>
      _buildDirectiveMediaPayload(input),
    resolveAutonomousTextTheme: (input) => deps.resolveAutonomousTextTheme(input),
    resolveAutonomousCaptionPosition: (input) => _resolveCaptionPos(input),
    pickDeterministicIndex: (seed, modulo) => _pickDeterministic(seed, modulo),
    resolveAutonomousGradientBackground: (theme, seed) => _resolveGradientBg(theme, seed),
    planTextPostVisualWithOpenClaw: (input) =>
      _planVisualWithOC(
        { runOpenClawPrompt: deps.ctx.runOpenClawPrompt, memory: deps.ctx.memory },
        input,
      ),
    normalizeCaptionPositionValue: (value) => _normalizeCaptionPos(value),
    sanitizeTextStyleValue: (value) => _sanitizeTextStyle(value),
    normalizeAgentTextStyle: (style, captionPosition, fallbackStyle) =>
      deps.normalizeAgentTextStyle(style, captionPosition, fallbackStyle),
    buildAutonomousThreadSlides: (input) => deps.buildAutonomousThreadSlides(input),
    buildAutonomousTextBackgroundPrompt: (input) => _buildTextBgPrompt(input),
    resolveMediaUpload: (input) => deps.resolveMediaUpload(input),
    executeCreatePostMutationWithIdempotency: (input) =>
      _execPostMutation(deps.ctx.stateDb, deps.agent(), input),
    notePublishedPostForNoveltyHistory: (input) =>
      _noteNoveltyHistory(deps.recentPostNoveltyHistory, input),
    notePublishedPostVarietyMode: (input) => deps.notePublishedPostVarietyMode(input),
    resolvePersonaReferencePlan: (payload, mainPersonaSlugRaw, command) =>
      deps.resolvePersonaReferencePlan(payload, mainPersonaSlugRaw ?? null, command ?? null),
    shouldUsePersonaFrameReferences: (plan) => deps.shouldUsePersonaFrameReferences(plan),
    isExplicitMultiMediaRequest: (payload) => _isMultiMedia(payload),
    buildAutonomousMediaSlides: (input) => deps.buildAutonomousMediaSlides(input),
  };
}

export function buildWriteCreateStoryRuntime(
  deps: BuildWriteRuntimeDeps,
): ExecuteWriteCreateStoryRuntime {
  return {
    ctx: { memory: deps.ctx.memory },
    agent: () => deps.agent(),
    failedOutcome: (command, message, code) =>
      deps.failedOutcome(command, message, code),
    successOutcome: (command, data) => deps.successOutcome(command, data),
    resolveCommandSourceDirectiveId: (input) => _resolveDirectiveId(input),
    isChatOriginCommand: (command, payloadOverride) =>
      _isChatOriginCommand(command, payloadOverride),
    didChatMessageExplicitlyRequestStory: (payload) => _didExplicitStory(payload),
    buildChatLiteralFallbackPayloadFromStory: (input) => _buildStoryFallback(input),
    executeChatLiteralGenerate: (command, payload) =>
      deps.executeChatLiteralGenerate(command, payload),
    resolveAutonomousTextTheme: (input) => deps.resolveAutonomousTextTheme(input),
    buildAutonomousVisualPrompt: (input) => deps.buildAutonomousVisualPrompt(input),
    normalizeCaptionPositionValue: (value) => _normalizeCaptionPos(value),
    resolveAutonomousCaptionPosition: (input) => _resolveCaptionPos(input),
    resolvePersonaReferencePlan: (payload, mainPersonaSlugRaw, command) =>
      deps.resolvePersonaReferencePlan(payload, mainPersonaSlugRaw ?? null, command ?? null),
    shouldUsePersonaFrameReferences: (plan) => deps.shouldUsePersonaFrameReferences(plan),
    resolveMediaUpload: (input) => deps.resolveMediaUpload(input),
  };
}

export function buildWriteProfileRuntime(
  deps: BuildWriteRuntimeDeps,
): ExecuteWriteProfileRuntime {
  return {
    resolveProfileWriteTarget: (value) => _resolveProfileTarget(value),
    resolveCommandSourceDirectiveId: (input) => _resolveDirectiveId(input),
    resolveMediaUpload: (input) => deps.resolveMediaUpload(input),
    updateAvatar: async (input) => deps.agent().updateAvatar.mutate(input),
    updateBanner: async (input) => deps.agent().updateBanner.mutate(input),
    successOutcome: (command, data) => deps.successOutcome(command, data),
    failedOutcome: (command, message, code) =>
      deps.failedOutcome(command, message, code),
  };
}

export function buildWriteEngagementRuntime(
  deps: BuildWriteRuntimeDeps,
): ExecuteWriteEngagementRuntime {
  return {
    ctx: { memory: deps.ctx.memory },
    agent: () => deps.agent(),
    failedOutcome: (command, message, code) =>
      deps.failedOutcome(command, message, code),
    successOutcome: (command, data) => deps.successOutcome(command, data),
    resolveEngagementTargetForDirective: (input) =>
      deps.resolveEngagementTargetForDirective(input),
    isNoTargetDiscoveryFailure: _isNoTargetFailure,
    buildActionIdempotencyKey: _buildActionIdempotencyKey,
    beginActionLifecycle: (input) => _beginLifecycle(deps.ctx.stateDb, input),
    preflightGrantForAction: (input) =>
      _preflightGrant(
        deps.ctx.stateDb,
        deps.ownerCapabilityDeniedByTarget,
        deps.ctx.memory,
        input,
      ),
    resolveCommandSourceDirectiveId: (input) => _resolveDirectiveId(input),
    curateCommentBodyWithOpenClaw: (input) =>
      _curateCommentWithOC(
        {
          memory: deps.ctx.memory,
          callAgentChatBridge: deps.ctx.callAgentChatBridge,
          runOpenClawPrompt: deps.ctx.runOpenClawPrompt,
          updateActionLifecycle: (lifecycleInput) =>
            _updateLifecycle(deps.ctx.stateDb, lifecycleInput),
        },
        input,
      ),
    evaluateEngagementActionWithOpenClaw: (input) =>
      _evaluateEngagementWithOC(
        {
          memory: deps.ctx.memory,
          callAgentChatBridge: deps.ctx.callAgentChatBridge,
          runOpenClawPrompt: deps.ctx.runOpenClawPrompt,
          updateActionLifecycle: (lifecycleInput) =>
            _updateLifecycle(deps.ctx.stateDb, lifecycleInput),
        },
        input,
      ),
    updateActionLifecycle: (input) => _updateLifecycle(deps.ctx.stateDb, input),
    isOwnerCapabilityDeniedError: _isDeniedError,
    registerOwnerCapabilityCooldown: (input) =>
      _registerCooldown(deps.ownerCapabilityDeniedByTarget, input),
  };
}

function _extractTargetId(payload: Record<string, unknown>): number | null {
  return _extractTargetPostId(payload);
}

export function notePublishedPostVarietyMode(
  memory: MemoryWriter,
  recentPostVarietyModeHistory: RecentPostVarietyModeEntry[],
  input: {
    commandId: string;
    postType: "text" | "media";
    targetPostId: number | null;
    mode: PostVarietyMode;
    signal: string;
  },
): void {
  _noteVarietyMode(recentPostVarietyModeHistory, input);
  void memory
    .recordWrite({
      type: "post_variety_mode_published",
      at: nowIso(),
      commandId: input.commandId,
      postType: input.postType,
      targetPostId: input.targetPostId,
      mode: input.mode,
    })
    .catch(() => undefined);
}
