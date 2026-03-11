import path from "node:path";
import { transformCustomAssetMedia } from "../media/custom-asset-transform.js";
import { resolveEngagementTargetForDirective as _resolveEngagementTarget } from "./engagement/engagement-target-resolution.js";
import { executeChatLiteralGenerate as _executeChatLiteralGen } from "./generate/chat-literal-generate.js";
import { buildGenerateAndQueueRuntime as _buildGenerateQueueRuntime } from "./generate/generate-and-queue-runtime.js";
import type { ExecuteGenerateAndQueueRuntime } from "./generate/generate-and-queue.js";
import { executeGenerateAndQueue as _executeGenerateAndQueue } from "./generate/generate-and-queue.js";
import { finalizeCommandOutcome as _finalizeOutcome } from "./lifecycle/command-finalize.js";
import type { ExecuteCommandRoutingRuntime } from "./lifecycle/execute-command-routing.js";
import { executeCommand as _executeCommand, executeCommandFromMappedDraft as _executeMappedDraftCommand } from "./lifecycle/execute-command-routing.js";
import { executeReview as _executeReview } from "./lifecycle/execute-review.js";
import { ackDirectiveForOutcome as _ackDirective, failedOutcome as _failedOutcome, successOutcome as _successOutcome } from "./lifecycle/outcome.js";
import { buildProcessCommandFileRuntime as _buildProcessRuntime } from "./lifecycle/process-command-file-runtime.js";
import type { ProcessCommandFileRuntime } from "./lifecycle/process-command-file.js";
import { processCommandFilePath as _processCommandFilePath } from "./lifecycle/process-command-file.js";
import { recordCommandLifecycleCheckpoint as _recordCheckpoint } from "./lifecycle/session.js";
import type { ExecuteWriteCreatePostRuntime } from "./write/write-create-post.js";
import { executeWriteCreatePost as _executeWriteCreatePost } from "./write/write-create-post.js";
import type { ExecuteWriteCreateStoryRuntime } from "./write/write-create-story.js";
import { executeWriteCreateStory as _executeWriteCreateStory } from "./write/write-create-story.js";
import { executeWriteComment as _executeWriteComment, executeWriteRepost as _executeWriteRepost, executeWriteVote as _executeWriteVote } from "./write/write-engagement-actions.js";
import { executeWriteUpdateAvatar as _executeWriteUpdateAvatar, executeWriteUpdateBanner as _executeWriteUpdateBanner } from "./write/write-profile-actions.js";
import type { BuildWriteRuntimeDeps } from "./write/write-runtime-builders.js";
import { buildWriteCreatePostRuntime as _buildWriteCreatePostRuntime, buildWriteCreateStoryRuntime as _buildWriteCreateStoryRuntime, buildWriteEngagementRuntime as _buildWriteEngagementRuntime, buildWriteProfileRuntime as _buildWriteProfileRuntime, notePublishedPostVarietyMode as _notePublishedPostVarietyMode } from "./write/write-runtime-builders.js";
import { classifyMediaGenerationDeferral as _classifyDeferral, resolveCommandSourceDirectiveId as _resolveDirectiveId, resolveCommandSourceDirectiveActionNonce as _resolveNonce } from "./directives/resolution.js";
import {
  resolveAgentMutatorOptional,
  resolveAgentQueryOptional,
  resolveAgentRouter,
  resolveRouterQueryOptional,
} from "./router/agent-router.js";
import { callAgentBridgeLookupCached as _bridgeLookupCached, buildEngagementTargetCacheKey as _buildEngagementKey, pruneEngagementTargetCache as _pruneEngagementCache } from "./cache/cache.js";
import { executeDelegatedFollowAction as _executeDelegatedFollowAction } from "./follow/delegated-follow.js";
import { extractEngagementLookupHints as _extractHints, parseTargetIdsFromTextLine as _parseTargetIds } from "./follow/follow-actions.js";
import { buildGenerateInput as _buildGenerateInput } from "./generate/generate-input-builder.js";
import { collectBridgeRecordItems as _collectBridgeItems, collectMediaReferenceInputs as _collectMediaRefs, isPersonaMediaCompatibleDraft as _isPersonaMediaDraft, resolveRequestedGenerateKinds as _resolveGenKinds } from "./generate/generate-input.js";
import { isStreamPartArtifactReference as _isStreamPartRef, mapUploadResult as _mapUploadResult, resolvePreferredMediaUrl as _resolvePreferredUrl } from "./generate/media-curation.js";
import { executeRetryPending as _executeRetryPending } from "./generate/retry-pending.js";
import { buildNonWriteChatCompletion as _buildNonWriteCompletion, resolveChatProcessingClientMessageId as _resolveChatProcessingMsgId } from "./chat/chat-completion.js";
import { sendDraftFailureMessage as _sendDraftFailure } from "./chat/chat-delivery.js";
import { loadPostDraftDiscoverySignals as _loadDiscoverySignals } from "./engagement/engagement-context.js";
import { isOwnEngagementCandidate as _isOwnEngagement, shouldAllowRareTopLevelSelfComment as _shouldAllowRareSelfComment, shouldIncludeOwnLatestCommentLookup as _shouldIncludeOwnLookup } from "./engagement/engagement-helpers.js";
import { saveGeneratedCustomAsset as _saveCustomAsset } from "./generate/custom-asset-save.js";
import { buildGenerateInputWithRuntimeContext as _buildGenInputWithCtx } from "./generate/generate-runtime-context.js";
import { buildMediaGenerationRuntime as _buildMediaRuntime } from "./generate/media-generation-runtime.js";
import type { MediaGenerationRuntime } from "./generate/media-generation.js";
import { generateAndUploadMediaFromPrompt as _generateAndUploadMedia, resolveMediaUpload as _resolveMediaUpload } from "./generate/media-generation.js";
import { runMediaGeneratorViaHttp as _runMediaGenHttp } from "./generate/media-generator-http.js";
import { extractMediaSourceFromParsedOutput as _extractMediaSource } from "./generate/media-source.js";
import { uploadResolvedMediaSource as _uploadMediaSource } from "./generate/media-upload-source.js";
import { uploadBytesViaChunkRoute as _uploadViaChunk } from "./generate/media-upload.js";
import { resolvePersonaFrameReferences as _resolveFrameRefs } from "./persona/persona-frames.js";
import { resolvePersonaReferencePlan as _resolvePersonaPlan, shouldUsePersonaFrameReferences as _shouldUseFrames } from "./persona/persona-resolution.js";
import { decideCommentTargetReuse as _decideTargetReuse, listRecentCommentTargetUsage as _listRecentTargets } from "./grants/grants.js";
import { mapDraftToWriteCommand as _mapDraftToWrite } from "./write/draft-mapping.js";
import { buildPostDraftCurationPrompt as _buildDraftCurationPrompt } from "./write/post-draft-curation.js";
import { resolveGeneratedCustomAssetSaveIntent as _resolveAssetIntent, resolveGeneratedAssetType as _resolveAssetType, resolveGeneratedAttachmentMimeType as _resolveAttachmentMime } from "./generate/custom-asset.js";
import { selectPostVarietyMode as _selectVarietyMode } from "./write/post-variety.js";
import { buildAutonomousMediaSlides as _buildMediaSlides, buildAutonomousThreadSlides as _buildThreadSlides, buildAutonomousVisualPrompt as _buildVisualPrompt, normalizeAgentTextStyle as _normalizeTextStyle, resolveAutonomousTextTheme as _resolveTextTheme } from "./write/post-visual.js";
import { BRIDGE_LOOKUP_CACHE_TTL_MS, MAX_COLLECTED_REFERENCE_INPUTS } from "./constants.js";
import type { AgentRouterLike, Command, CommandExecutorContext, CommandLifecycleCheckpointStage, CommandOutcome, CuratedMediaPromptCacheEntry, CuratedPostDraftCacheEntry, EngagementTargetCandidate, ExecuteResult, GeneratedAssetType, GeneratedCustomAssetSaveIntent, GeneratedCustomAssetSaveResult, GeneratedDraft, MediaGenerationDeferralDecision, MediaGenerationProgress, OwnerCapabilityCooldown, PersonaReferencePlan, PersonaReferenceResolution, PostDraftContext, PostVarietyMode, RecentPostNoveltyEntry, RecentPostVarietyModeEntry, ResolvedMediaUpload, TextPostVisualSlide, TextStyleTheme } from "./types.js";

export class CommandExecutor {
  private readonly ctx: CommandExecutorContext;
  private readonly inFlight = new Set<string>();
  private readonly ownerCapabilityDeniedByTarget = new Map<string, OwnerCapabilityCooldown>();
  private readonly recentPostNoveltyHistory: RecentPostNoveltyEntry[] = [];
  private readonly recentPostVarietyModeHistory: RecentPostVarietyModeEntry[] = [];
  private readonly bridgeLookupCache = new Map<string, { expiresAtMs: number; value: unknown }>();
  private readonly engagementTargetCache = new Map<
    string,
    { expiresAtMs: number; candidate: EngagementTargetCandidate }
  >();
  /** Cache generated drafts by command ID so requeued commands skip regeneration. */
  private readonly generatedDraftCache = new Map<
    string,
    { drafts: GeneratedDraft[]; cachedAtMs: number }
  >();
  /** Cache curated post drafts by command/postType so retries do not re-prompt OpenClaw. */
  private readonly curatedPostDraftCache = new Map<
    string,
    CuratedPostDraftCacheEntry
  >();
  /** Cache curated media prompts by command+source so retries keep the exact same prompt. */
  private readonly curatedMediaPromptCache = new Map<
    string,
    CuratedMediaPromptCacheEntry
  >();
  private readonly _runtimeAgentIdState = { agentIdCache: null as string | null, checkedAtMs: 0 };

  constructor(ctx: CommandExecutorContext) {
    this.ctx = ctx;
  }

  private resolveCommandSourceDirectiveId(input: { command: Command; payload?: Record<string, unknown> | null }): string | null {
    return _resolveDirectiveId(input);
  }

  private resolveCommandSourceDirectiveActionNonce(input: { command: Command; payload?: Record<string, unknown> | null }): string | null {
    return _resolveNonce(input);
  }

  private classifyMediaGenerationDeferral(input: { error: unknown; hasPrompt?: boolean }): MediaGenerationDeferralDecision {
    return _classifyDeferral(input);
  }

  private async recordCommandLifecycleCheckpoint(input: {
    command: Command;
    stage: CommandLifecycleCheckpointStage;
    status?: "ok" | "failed";
    message?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    return _recordCheckpoint(this.ctx, this._runtimeAgentIdState, input);
  }

  private async callAgentBridgeLookupCached(payload: Record<string, unknown>, ttlMs: number = BRIDGE_LOOKUP_CACHE_TTL_MS): Promise<{ value: unknown; cacheHit: boolean }> {
    return _bridgeLookupCached(this.bridgeLookupCache, this.ctx.callAgentChatBridge, payload, ttlMs);
  }

  async processCommandFile(
    fileName: string,
    opts?: { interactiveRl?: unknown; attempts?: number; maxAttempts?: number },
  ): Promise<boolean> {
    const filePath = path.join(this.ctx.ipcPaths.inboxDir, fileName);
    if (this.inFlight.has(filePath)) return false;
    this.inFlight.add(filePath);
    try {
      const processOptions: { attempts?: number; maxAttempts?: number } = {};
      if (typeof opts?.attempts === "number" && Number.isFinite(opts.attempts)) {
        processOptions.attempts = opts.attempts;
      }
      if (typeof opts?.maxAttempts === "number" && Number.isFinite(opts.maxAttempts)) {
        processOptions.maxAttempts = opts.maxAttempts;
      }
      const runtime: ProcessCommandFileRuntime = _buildProcessRuntime({
        ctx: this.ctx,
        runtimeAgentIdState: this._runtimeAgentIdState,
        bridgeLookupCache: this.bridgeLookupCache,
        engagementTargetCache: this.engagementTargetCache,
        recordCommandLifecycleCheckpoint: (input) =>
          this.recordCommandLifecycleCheckpoint(input),
        finalizeCommandOutcome: (input) => this.finalizeCommandOutcome(input),
        executeCommand: (command) => this.executeCommand(command),
      });
      return await _processCommandFilePath.call(
        runtime,
        filePath,
        processOptions,
      );
    } finally {
      this.inFlight.delete(filePath);
    }
  }

  private agent(): AgentRouterLike {
    return resolveAgentRouter(this.ctx.trpc);
  }

  private resolvePersonaReferencePlan(payload: Record<string, unknown>, mainPersonaSlugRaw: string | null = null, command: Command | null = null): PersonaReferencePlan {
    return _resolvePersonaPlan(payload, mainPersonaSlugRaw, command, _resolveGenKinds);
  }

  private shouldUsePersonaFrameReferences(plan: PersonaReferencePlan): boolean {
    return _shouldUseFrames(plan);
  }

  private async resolvePersonaFrameReferences(input: { payload: Record<string, unknown>; command: Command; fallbackReferenceInputs: string[] }): Promise<PersonaReferenceResolution> {
    return _resolveFrameRefs(input, {
      ctx: this.ctx,
      agent: () => resolveAgentRouter(this.ctx.trpc),
      agentQueryOptional: (name) => resolveAgentQueryOptional(this.ctx.trpc, name),
      userQueryOptional: (name) =>
        resolveRouterQueryOptional(this.ctx.trpc, "user", name),
      agentMutatorOptional: (name) => resolveAgentMutatorOptional(this.ctx.trpc, name),
      callBridgeLookupCached: (payload, ttlMs) =>
        this.callAgentBridgeLookupCached(payload, ttlMs),
      collectMediaReferenceInputs: (payload, options) =>
        this.collectMediaReferenceInputs(payload, options),
      isStreamPartArtifactReference: _isStreamPartRef,
      resolvePreferredMediaUrl: (...values) => _resolvePreferredUrl(...values),
      generateAndUploadMediaFromPrompt: (prompt, options) =>
        this.generateAndUploadMediaFromPrompt(
          prompt,
          options as Parameters<typeof this.generateAndUploadMediaFromPrompt>[1],
        ),
      uploadBytesViaChunkRoute: (uploadInput) =>
        _uploadViaChunk(
          {
            callAgentUploadChunk: this.ctx.callAgentUploadChunk ?? null,
            memory: this.ctx.memory,
          },
          uploadInput,
        ),
      mapUploadResult: _mapUploadResult,
      transformCustomAssetMedia: (transformInput) =>
        transformCustomAssetMedia(
          transformInput as Parameters<typeof transformCustomAssetMedia>[0],
        ),
      resolveRequestedGenerateKinds: _resolveGenKinds,
    });
  }

  private buildCommandRoutingRuntime(): ExecuteCommandRoutingRuntime {
    return {
      ctx: { memory: this.ctx.memory },
      executeWriteCreatePost: (command) => this.executeWriteCreatePost(command),
      executeWriteCreateStory: (command) => this.executeWriteCreateStory(command),
      executeWriteUpdateAvatar: (command) =>
        _executeWriteUpdateAvatar.call(
          _buildWriteProfileRuntime(this.buildWriteRuntimeDeps()),
          command,
        ),
      executeWriteUpdateBanner: (command) =>
        _executeWriteUpdateBanner.call(
          _buildWriteProfileRuntime(this.buildWriteRuntimeDeps()),
          command,
        ),
      executeWriteComment: (command) => this.executeWriteComment(command),
      executeWriteVote: (command) => this.executeWriteVote(command),
      executeWriteRepost: (command) => this.executeWriteRepost(command),
      executeRetryPending: (command) =>
        _executeRetryPending(command, {
          ctx: this.ctx,
          resolveCommandSourceDirectiveId: (input) =>
            this.resolveCommandSourceDirectiveId(input),
          successOutcome: (resolvedCommand, data) =>
            this.successOutcome(resolvedCommand, data),
          failedOutcome: (resolvedCommand, message, code) =>
            this.failedOutcome(resolvedCommand, message, code),
        }),
      executeGenerateAndQueue: (command) => this.executeGenerateAndQueue(command),
      executeReview: (command) =>
        _executeReview(
          {
            memory: this.ctx.memory,
            runOpenClawPrompt: this.ctx.runOpenClawPrompt ?? null,
            submitReview: (input) => this.agent().submitReview.mutate(input),
          },
          command,
        ),
      failedOutcome: (command, message, code) =>
        this.failedOutcome(command, message, code),
    };
  }

  private async executeCommand(command: Command): Promise<ExecuteResult> {
    return _executeCommand.call(this.buildCommandRoutingRuntime(), command);
  }

  private async executeWriteCreatePost(command: Command): Promise<CommandOutcome> {
    const runtime: ExecuteWriteCreatePostRuntime = _buildWriteCreatePostRuntime(
      this.buildWriteRuntimeDeps(),
    );
    return _executeWriteCreatePost.call(runtime, command);
  }

  private async loadPostDraftDiscoverySignals(input: {
    postId: number | null;
    payload: Record<string, unknown>;
  }): Promise<string | null> {
    return _loadDiscoverySignals(
      {
        callAgentChatBridge: this.ctx.callAgentChatBridge ?? null,
        memory: this.ctx.memory,
        bridgeLookupCache: this.bridgeLookupCache,
      },
      input,
    );
  }

  private selectPostVarietyMode(input: {
    commandId: string;
    postType: "text" | "media";
    payload: Record<string, unknown>;
    context: PostDraftContext;
    seedHints: string[];
  }): { mode: PostVarietyMode; reason: string; recentModes: PostVarietyMode[]; signal: string } {
    return _selectVarietyMode(this.recentPostVarietyModeHistory, input);
  }

  private notePublishedPostVarietyMode(input: {
    commandId: string;
    postType: "text" | "media";
    targetPostId: number | null;
    mode: PostVarietyMode;
    signal: string;
  }): void {
    _notePublishedPostVarietyMode(
      this.ctx.memory,
      this.recentPostVarietyModeHistory,
      input,
    );
  }

  private resolveAutonomousTextTheme(input: { commandId: string; postKind: "post" | "thread"; caption: string | null; textBody: string }): TextStyleTheme {
    return _resolveTextTheme(input);
  }

  private buildAutonomousVisualPrompt(input: { basePrompt: string; caption: string | null; commandId: string; theme: TextStyleTheme; mode: "slide" | "story" | "background"; index: number }): string {
    return _buildVisualPrompt(input);
  }

  private buildAutonomousThreadSlides(input: { commandId: string; caption: string | null; textBody: string; theme: TextStyleTheme; postKind: "post" | "thread" }): TextPostVisualSlide[] {
    return _buildThreadSlides(input);
  }

  private buildAutonomousMediaSlides(input: { commandId: string; postKind: "post" | "thread"; caption: string | null; mediaPrompt: string; theme: TextStyleTheme }): TextPostVisualSlide[] {
    return _buildMediaSlides(input);
  }

  private normalizeAgentTextStyle(style: Record<string, unknown> | null, captionPosition: string | null, fallbackStyle?: Record<string, unknown> | null): Record<string, unknown> {
    return _normalizeTextStyle(style, captionPosition, fallbackStyle);
  }

  private buildPostDraftCurationPrompt(input: {
    postType: "text" | "media";
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
    context: PostDraftContext;
    varietyMode: PostVarietyMode;
    seedHints: string[];
    avoidReferences: string[];
  }): string {
    return _buildDraftCurationPrompt(input);
  }

  private buildWriteRuntimeDeps(): BuildWriteRuntimeDeps {
    return {
      ctx: {
        memory: this.ctx.memory,
        callAgentChatBridge: this.ctx.callAgentChatBridge ?? null,
        runOpenClawPrompt: this.ctx.runOpenClawPrompt ?? null,
        stateDb: this.ctx.stateDb,
      },
      bridgeLookupCache: this.bridgeLookupCache,
      curatedPostDraftCache: this.curatedPostDraftCache,
      curatedMediaPromptCache: this.curatedMediaPromptCache,
      recentPostNoveltyHistory: this.recentPostNoveltyHistory,
      recentPostVarietyModeHistory: this.recentPostVarietyModeHistory,
      ownerCapabilityDeniedByTarget: this.ownerCapabilityDeniedByTarget,
      agent: () => this.agent(),
      failedOutcome: (command, message, code) =>
        this.failedOutcome(command, message, code),
      successOutcome: (command, data) => this.successOutcome(command, data),
      resolveAutonomousTextTheme: (input) => this.resolveAutonomousTextTheme(input),
      buildAutonomousVisualPrompt: (input) => this.buildAutonomousVisualPrompt(input),
      buildAutonomousThreadSlides: (input) => this.buildAutonomousThreadSlides(input),
      buildAutonomousMediaSlides: (input) => this.buildAutonomousMediaSlides(input),
      normalizeAgentTextStyle: (style, captionPosition, fallbackStyle) =>
        this.normalizeAgentTextStyle(style, captionPosition, fallbackStyle),
      selectPostVarietyMode: (input) => this.selectPostVarietyMode(input),
      notePublishedPostVarietyMode: (input) => this.notePublishedPostVarietyMode(input),
      resolvePersonaReferencePlan: (payload, mainPersonaSlugRaw, command) =>
        this.resolvePersonaReferencePlan(payload, mainPersonaSlugRaw ?? null, command ?? null),
      shouldUsePersonaFrameReferences: (plan) => this.shouldUsePersonaFrameReferences(plan),
      resolveMediaUpload: (input) => this.resolveMediaUpload(input),
      executeChatLiteralGenerate: (command, payload) =>
        this.executeChatLiteralGenerate(command, payload),
      resolveEngagementTargetForDirective: (input) =>
        this.resolveEngagementTargetForDirective(input),
    };
  }

  private async executeWriteCreateStory(command: Command): Promise<CommandOutcome> {
    const runtime: ExecuteWriteCreateStoryRuntime = _buildWriteCreateStoryRuntime(
      this.buildWriteRuntimeDeps(),
    );
    return _executeWriteCreateStory.call(runtime, command);
  }

  private async executeWriteComment(command: Command): Promise<CommandOutcome> {
    return _executeWriteComment.call(
      _buildWriteEngagementRuntime(this.buildWriteRuntimeDeps()),
      command,
    );
  }

  private async executeWriteVote(command: Command): Promise<CommandOutcome> {
    return _executeWriteVote.call(
      _buildWriteEngagementRuntime(this.buildWriteRuntimeDeps()),
      command,
    );
  }

  private async executeWriteRepost(command: Command): Promise<CommandOutcome> {
    return _executeWriteRepost.call(
      _buildWriteEngagementRuntime(this.buildWriteRuntimeDeps()),
      command,
    );
  }

  private async executeDelegatedFollowAction(input: {
    command: Command;
    payload: Record<string, unknown>;
    action: "follow" | "follow_engagers" | "follow_accept" | "follow_suggestions";
  }): Promise<CommandOutcome> {
    return _executeDelegatedFollowAction(input, {
      ctx: this.ctx,
      callAgentBridgeLookupCached: (payload, ttlMs) =>
        this.callAgentBridgeLookupCached(payload, ttlMs),
      collectBridgeRecordItems: _collectBridgeItems,
      recordCommandLifecycleCheckpoint: (checkpoint) =>
        this.recordCommandLifecycleCheckpoint(checkpoint),
      successOutcome: (command, data) => this.successOutcome(command, data),
      failedOutcome: (command, message, code) =>
        this.failedOutcome(command, message, code),
    });
  }

  private async executeGenerateAndQueue(command: Command): Promise<CommandOutcome> {
    const runtime: ExecuteGenerateAndQueueRuntime = _buildGenerateQueueRuntime({
      ctx: {
        memory: this.ctx.memory,
        callAgentChatBridge: this.ctx.callAgentChatBridge ?? null,
      },
      generatedDraftCache: this.generatedDraftCache,
      agent: () => this.agent(),
      executeDelegatedFollowAction: (input) => this.executeDelegatedFollowAction(input),
      executeChatLiteralGenerate: (runtimeCommand, payload) =>
        this.executeChatLiteralGenerate(runtimeCommand, payload),
      resolveEngagementTargetForDirective: (input) =>
        this.resolveEngagementTargetForDirective(input),
      buildGenerateInputWithRuntimeContext: (payload, runtimeCommand) =>
        this.buildGenerateInputWithRuntimeContext(payload, runtimeCommand),
      classifyMediaGenerationDeferral: (input) =>
        this.classifyMediaGenerationDeferral(input),
      recordCommandLifecycleCheckpoint: (input) =>
        this.recordCommandLifecycleCheckpoint(input),
      buildGenerateInput: (payload, runtimeCommand) =>
        this.buildGenerateInput(payload, runtimeCommand),
      isPersonaMediaCompatibleDraft: (draft) => this.isPersonaMediaCompatibleDraft(draft),
      sendDraftFailureMessage: (input) => this.sendDraftFailureMessage(input),
      mapDraftToWriteCommand: (input) => this.mapDraftToWriteCommand(input),
      executeCommandFromMappedDraft: (runtimeCommand) =>
        this.executeCommandFromMappedDraft(runtimeCommand),
      successOutcome: (runtimeCommand, data) => this.successOutcome(runtimeCommand, data),
      failedOutcome: (runtimeCommand, message, code) =>
        this.failedOutcome(runtimeCommand, message, code),
    });
    return _executeGenerateAndQueue.call(runtime, command);
  }

  private async saveGeneratedCustomAsset(input: {
    command: Command;
    payload: Record<string, unknown>;
    intent: GeneratedCustomAssetSaveIntent;
    sourcePrompt: string;
    mediaUrl: string;
    mimeType: string;
    chatTarget: { conversationId?: string; channelId?: string };
  }): Promise<GeneratedCustomAssetSaveResult> {
    if (!this.ctx.callAgentChatBridge) {
      throw new Error("chat_bridge_unavailable");
    }
    return _saveCustomAsset(
      {
        memory: this.ctx.memory,
        callAgentChatBridge: this.ctx.callAgentChatBridge,
        callAgentUploadChunk: this.ctx.callAgentUploadChunk ?? null,
        uploadDataUri: (i) => this.agent().uploadDataUri.mutate(i),
      },
      input,
    );
  }

  private async executeChatLiteralGenerate(
    command: Command,
    payload: Record<string, unknown>,
  ): Promise<CommandOutcome> {
    return _executeChatLiteralGen(
      {
        callAgentChatBridge: this.ctx.callAgentChatBridge ?? null,
        memory: this.ctx.memory,
        resolveCommandSourceDirectiveId: (i) => this.resolveCommandSourceDirectiveId(i),
        resolveCommandSourceDirectiveActionNonce: (i) => this.resolveCommandSourceDirectiveActionNonce(i),
        resolveGeneratedAssetType: (v) => _resolveAssetType(v),
        collectMediaReferenceInputs: (p) => this.collectMediaReferenceInputs(p),
        resolvePersonaFrameReferences: (i) => this.resolvePersonaFrameReferences(i),
        resolveGeneratedCustomAssetSaveIntent: _resolveAssetIntent,
        resolveChatProcessingClientMessageId: (c) => this.resolveChatProcessingClientMessageId(c),
        generateAndUploadMediaFromPrompt: (p, o) => this.generateAndUploadMediaFromPrompt(p, o),
        resolveGeneratedAttachmentMimeType: _resolveAttachmentMime,
        recordCommandLifecycleCheckpoint: (i) => this.recordCommandLifecycleCheckpoint(i),
        saveGeneratedCustomAsset: (i) => this.saveGeneratedCustomAsset(i),
        updateAvatar: async (i) => this.agent().updateAvatar.mutate(i),
        updateBanner: async (i) => this.agent().updateBanner.mutate(i),
        classifyMediaGenerationDeferral: (i) => this.classifyMediaGenerationDeferral(i),
        isStreamPartArtifactReference: _isStreamPartRef,
        failedOutcome: (c, m, code) => this.failedOutcome(c, m, code),
        successOutcome: (c, d) => this.successOutcome(c, d),
      },
      command,
      payload,
    );
  }

  private async executeCommandFromMappedDraft(command: Command): Promise<CommandOutcome> {
    return _executeMappedDraftCommand.call(this.buildCommandRoutingRuntime(), command);
  }

  private buildGenerateInput(
    payload: Record<string, unknown>,
    command: Command,
  ): Record<string, unknown> {
    return _buildGenerateInput(payload, command);
  }

  private async resolveEngagementTargetForDirective(input: {
    payload: Record<string, unknown>;
    action: "comment" | "like" | "repost";
    commandId: string;
  }): Promise<EngagementTargetCandidate | null> {
    return _resolveEngagementTarget(
      {
        callAgentChatBridge: this.ctx.callAgentChatBridge ?? null,
        bridgeLookupCache: this.bridgeLookupCache,
        memory: this.ctx.memory,
        engagementTargetCache: this.engagementTargetCache,
        callAgentBridgeLookupCached: (p, t) => this.callAgentBridgeLookupCached(p, t),
        extractEngagementLookupHints: _extractHints,
        buildEngagementTargetCacheKey: _buildEngagementKey,
        pruneEngagementTargetCache: (ms) =>
          _pruneEngagementCache(this.engagementTargetCache, ms),
        listRecentCommentTargetUsage: () => _listRecentTargets(this.ctx.stateDb),
        decideCommentTargetReuse: (i) => _decideTargetReuse(this.ctx.stateDb, i),
        parseTargetIdsFromTextLine: _parseTargetIds,
        shouldIncludeOwnLatestCommentLookup: _shouldIncludeOwnLookup,
        isOwnEngagementCandidate: _isOwnEngagement,
        shouldAllowRareTopLevelSelfComment: _shouldAllowRareSelfComment,
      },
      input,
    );
  }
  private async buildGenerateInputWithRuntimeContext(
    payload: Record<string, unknown>,
    command: Command,
  ): Promise<Record<string, unknown>> {
    return _buildGenInputWithCtx(
      {
        callAgentChatBridge: this.ctx.callAgentChatBridge ?? null,
        memory: this.ctx.memory,
        resolvePersonaFrameReferences: (input) => this.resolvePersonaFrameReferences(input),
      },
      payload,
      command,
    );
  }

  private isPersonaMediaCompatibleDraft(draft: GeneratedDraft): boolean {
    return _isPersonaMediaDraft(draft);
  }

  private mapDraftToWriteCommand(input: {
    draft: GeneratedDraft;
    command: Command;
    sourceDirectiveId: string | null;
    sourceDirectiveActionNonce: string | null;
    provenance: string | null;
  }): Command | null {
    return _mapDraftToWrite(this.ctx.controlKey ?? null, input);
  }

  private collectMediaReferenceInputs(
    payload: Record<string, unknown>,
    options?: {
      includeRecentGeneratedAsset?: boolean;
    },
  ): string[] {
    return _collectMediaRefs(payload, MAX_COLLECTED_REFERENCE_INPUTS, options);
  }

  private buildMediaGenerationRuntime(): MediaGenerationRuntime {
    return _buildMediaRuntime({
      ctx: this.ctx,
      curatedPostDraftCache: this.curatedPostDraftCache,
      curatedMediaPromptCache: this.curatedMediaPromptCache,
      recordCommandLifecycleCheckpoint: (input) =>
        this.recordCommandLifecycleCheckpoint(input),
      collectMediaReferenceInputs: (payload, options) =>
        this.collectMediaReferenceInputs(payload, options),
      resolvePersonaFrameReferences: (input) => this.resolvePersonaFrameReferences(input),
      classifyMediaGenerationDeferral: (input) =>
        this.classifyMediaGenerationDeferral(input),
      uploadResolvedMediaSource: (source, options) =>
        this.uploadResolvedMediaSource(source, options),
      runMediaGeneratorViaHttp: (input) => this.runMediaGeneratorViaHttp(input),
      generateAndUploadMediaFromPrompt: (prompt, opts) =>
        this.generateAndUploadMediaFromPrompt(prompt, opts),
    });
  }

  private async resolveMediaUpload(input: {
    payload: Record<string, unknown>;
    keepOriginal?: boolean;
    promptFallbacks: Array<string | null>;
    command?: Command;
    skipPromptCuration?: boolean;
  }): Promise<ResolvedMediaUpload> {
    return _resolveMediaUpload.call(this.buildMediaGenerationRuntime(), input);
  }

  private async uploadResolvedMediaSource(
    source: string,
    options?: { keepOriginal?: boolean },
  ): Promise<ResolvedMediaUpload> {
    return _uploadMediaSource(
      {
        memory: this.ctx.memory,
        callAgentUploadChunk: this.ctx.callAgentUploadChunk ?? null,
        uploadDataUri: (i) => this.agent().uploadDataUri.mutate(i),
        uploadRemote: (i) => this.agent().uploadRemote.mutate(i),
      },
      source,
      options,
    );
  }

  private mapUploadResult(uploaded: unknown): ResolvedMediaUpload {
    return _mapUploadResult(uploaded);
  }

  private async runMediaGeneratorViaHttp(input: {
    prompt: string;
    generatedAssetType: GeneratedAssetType;
    requestDir: string;
    referenceFiles: string[];
    timeoutMs: number;
    stream: boolean;
    onProgress?: ((progress: MediaGenerationProgress) => Promise<void> | void) | undefined;
  }): Promise<{ payload: unknown; timedOut: boolean } | null> {
    return _runMediaGenHttp({ memory: this.ctx.memory }, input);
  }

  private async generateAndUploadMediaFromPrompt(
    prompt: string,
    opts?: {
      generatedAssetType?: GeneratedAssetType;
      mode?: string;
      referenceInputs?: string[];
      maxReferenceInputs?: number;
      keepOriginal?: boolean;
      commandId?: string | null;
      skipPromptCuration?: boolean;
      onProgress?: ((progress: MediaGenerationProgress) => Promise<void> | void) | undefined;
    },
  ): Promise<ResolvedMediaUpload> {
    return _generateAndUploadMedia.call(this.buildMediaGenerationRuntime(), prompt, opts);
  }

  private extractMediaSourceFromParsedOutput(
    parsed: unknown,
    requestDir: string,
    options?: {
      requireFinalStreamFrame?: boolean;
    },
  ): string | null {
    return _extractMediaSource(parsed, requestDir, options);
  }

  private resolveChatProcessingClientMessageId(command: Command): string | null {
    return _resolveChatProcessingMsgId(command);
  }

  private buildNonWriteChatCompletion(input: {
    command: Command;
    outcome: CommandOutcome;
  }): { body: string; metadata: Record<string, unknown> } | null {
    return _buildNonWriteCompletion(input);
  }

  private async sendDraftFailureMessage(input: {
    payload: Record<string, unknown>;
    message: string;
  }): Promise<boolean> {
    return _sendDraftFailure(this.ctx.callAgentChatBridge ?? null, input);
  }

  private successOutcome(command: Command, data: unknown): CommandOutcome {
    return _successOutcome(command, data);
  }

  private failedOutcome(command: Command, message: string, code?: string): CommandOutcome {
    return _failedOutcome(command, message, code);
  }

  private async finalizeCommandOutcome(input: {
    command: Command;
    outcome: CommandOutcome;
  }): Promise<void> {
    return _finalizeOutcome(
      {
        resultsPath: this.ctx.ipcPaths.resultsPath,
        callAgentChatBridge: this.ctx.callAgentChatBridge ?? null,
        memory: this.ctx.memory,
        recordCheckpoint: (i) => this.recordCommandLifecycleCheckpoint(i),
        ackDirectiveForOutcome: (command, outcome) =>
          _ackDirective({
            command,
            outcome,
            trpc: this.ctx.trpc,
            recordCheckpoint: (checkpointInput) =>
              this.recordCommandLifecycleCheckpoint(checkpointInput),
          }),
      },
      input,
    );
  }

}
