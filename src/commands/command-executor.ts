/**
 * CommandExecutor: executes staged inbox commands for the TypeScript runtime.
 *
 * This is a focused execution path for v2 that:
 * - validates/parses staged command files
 * - verifies runtime command seals
 * - executes write commands and generate-and-queue plans
 * - marks queue items complete
 * - writes command outcomes to results.jsonl
 * - ACKs directive completion/failure back to the server
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  clampPublishText,
  inheritChatContextIntoPayload,
  sendChatResultMessageFromOutcome,
} from "../chat/chat-context.js";
import { transformCustomAssetMedia } from "../media/custom-asset-transform.js";
import {
  sealRuntimeStagedCommand,
  verifyRuntimeCommandSeal,
} from "../directives/command-seal.js";
import type { SealVerifyError } from "../directives/command-seal.js";
import { parseGrantCandidatesFromPermissionState } from "../grants/grant-state.js";
import { computeCommandSignature } from "../lib/crypto.js";
import {
  applyTargetLock,
  buildTargetHash,
  isTargetLockMatch,
} from "../lib/command-target.js";
import { appendJsonLine, ensureDir, readJsonMaybeIncomplete, readJsonFile, writeJsonFile } from "../lib/fs.js";
import { isRecord } from "../lib/guards.js";
import { parseCommand, parseJsonFromMixedText } from "../lib/parsing.js";
import { sleep } from "../lib/async.js";
import { nowIso } from "../lib/text.js";
import { normalizeQueueState } from "../queue/queue-state.js";

// Extracted lifecycle modules
import {
  resolveRuntimeAgentId as _resolveRuntimeAgentId,
  recordCommandLifecycleCheckpoint as _recordCheckpoint,
} from "./lifecycle/session.js";
import {
  releaseReplayConsumedForRetry as _releaseReplayConsumedForRetry,
  tryResealTrustedCommandForActiveSession as _tryReseal,
  tryRehydrateRuntimeIssuedSeal as _tryRehydrate,
  tryAllowTrustedReplay as _tryAllowReplay,
} from "./lifecycle/seal.js";
import {
  successOutcome as _successOutcome,
  failedOutcome as _failedOutcome,
  writeOutcome as _writeOutcome,
  ackDirectiveForOutcome as _ackDirective,
} from "./lifecycle/outcome.js";
import {
  markQueueItemNotReadyByInbox as _markNotReady,
  markQueueItemCompletedByInbox as _markCompleted,
  moveInboxFileToProcessed as _moveProcessed,
} from "./lifecycle/queue-items.js";
import { finalizeCommandOutcome as _finalizeOutcome } from "./lifecycle/command-finalize.js";
import { executeReview as _executeReview } from "./lifecycle/execute-review.js";
import { executeChatLiteralGenerate as _executeChatLiteralGen } from "./generate/chat-literal-generate.js";
import { primeCommandContextForRequeue as _primeRequeueCtx } from "./lifecycle/command-prime-context.js";
import { resolveEngagementTargetForDirective as _resolveEngagementTarget } from "./engagement/engagement-target-resolution.js";

// Extracted directive resolution
import {
  resolveCommandRequestOrigin as _resolveOrigin,
  resolveCommandSourceDirectiveId as _resolveDirectiveId,
  resolveCommandSourceDirectiveActionNonce as _resolveNonce,
  classifyMediaGenerationDeferral as _classifyDeferral,
  didMediaGenerationProduceActivity as _didMediaActivity,
  resolvePendingDirectiveTerminalStatus as _resolveTerminalStatus,
  resolvePendingDirectiveFilePath as _resolveDirectivePath,
  updatePendingDirectiveStatusForOutcome as _updateDirectiveStatus,
  isDirectiveContextLinkedCommand as _isDirectiveLinked,
  resolveEngagementActionForCommand as _resolveEngagementAction,
} from "./directives/resolution.js";

// Extracted router
import {
  resolveAgentRouter,
  resolveDirectiveAckMutator,
  resolveAgentQueryOptional,
  resolveAgentMutatorOptional,
} from "./router/agent-router.js";

// Extracted cache
import {
  pruneGeneratedDraftCache as _pruneDraftCache,
  buildCuratedPostDraftCacheKey as _buildPostDraftKey,
  buildCuratedMediaPromptCacheKey as _buildMediaPromptKey,
  pruneCuratedPromptCaches as _prunePromptCaches,
  pruneBridgeLookupCache as _pruneBridgeCache,
  pruneEngagementTargetCache as _pruneEngagementCache,
  buildEngagementTargetCacheKey as _buildEngagementKey,
  callAgentBridgeLookupCached as _bridgeLookupCached,
} from "./cache/cache.js";

// Extracted follow
import {
  extractEngagementLookupHints as _extractHints,
  parseTargetIdsFromTextLine as _parseTargetIds,
  resolveChatCommandName as _resolveChatCmd,
  resolveDelegatedFollowAction as _resolveFollowAction,
  resolveProfileWriteTarget as _resolveProfileTarget,
} from "./follow/follow-actions.js";
import { executeDelegatedFollowAction as _executeDelegatedFollowAction } from "./follow/delegated-follow.js";

// Extracted generate
import { executeRetryPending as _executeRetryPending } from "./generate/retry-pending.js";
import {
  mapAllowedWriteKindToGenerateKind as _mapWriteKindToGenKind,
  resolveDirectiveScopeGenerateKinds as _resolveDirectiveGenKinds,
  normalizeRequestedGenerateKind as _normalizeGenKind,
  resolveRequestedGenerateKinds as _resolveGenKinds,
  isExplicitMultiMediaRequest as _isMultiMedia,
  parsePermissionCanState as _parsePermissionCan,
  constrainGenerateKindsByPermissionState as _constrainByPermission,
  applyPermissionGenerateInputConstraints as _applyPermissionConstraints,
  isGeneratedDraftAllowedByPermissionState as _isDraftAllowed,
  mapGoalToGenerateKind as _mapGoalToKind,
  resolveEnforcedDraftAction as _resolveEnforcedAction,
  extractInlineDrafts as _extractInlineDrafts,
  extractGeneratedDrafts as _extractGenDrafts,
  isPersonaMediaCompatibleDraft as _isPersonaMediaDraft,
  buildPersonaLockedMediaFallbackDraft as _buildPersonaFallbackDraft,
  collectBridgeRecordItems as _collectBridgeItems,
  collectMediaReferenceInputs as _collectMediaRefs,
  asNonNegativeInt as _asNonNegativeInt,
} from "./generate/generate-input.js";
import { buildGenerateInput as _buildGenerateInput } from "./generate/generate-input-builder.js";
import {
  normalizeCuratedMediaPrompt as _normalizeMediaPrompt,
  extractCuratedMediaPromptFromUnknown as _extractMediaPrompt,
  buildMediaPromptCurationRequest as _buildMediaCurationReq,
  extractMediaGeneratorContextId as _extractMediaGenCtxId,
  extractMediaGeneratorContextRecord as _extractMediaGenCtxRecord,
  resolveLocalReferencePath as _resolveLocalRef,
  isTransientMediaArtifactFileName as _isTransientArtifact,
  isStreamPartArtifactReference as _isStreamPartRef,
  resolvePreferredMediaUrl as _resolvePreferredUrl,
  mapUploadResult as _mapUploadResult,
} from "./generate/media-curation.js";

// Extracted chat write intent
import {
  shouldEnforceExplicitPublishGate as _shouldEnforcePublishGate,
  isWriteDraftAction as _isWriteDraftAction,
  isChatWriteRequesterOwner as _isChatWriteOwner,
  isChatWriteCommandExplicitlyRequested as _isChatWriteExplicit,
  isChatMediaIntentPayload as _isChatMediaIntent,
  resolveChatLiteralFallbackPromptFromDrafts as _resolveLiteralFallback,
  isChatOriginPayload as _isChatOriginPayload,
  didChatMessageExplicitlyRequestStory as _didExplicitStory,
  isChatOriginCommand as _isChatOriginCommand,
  isStoryGenerateRequestFromChatPayload as _isStoryGenRequest,
  shouldRedirectBlockedChatWritesToLiteralGenerate as _shouldRedirectToLiteral,
} from "./write/chat-write-intent.js";
import { buildDraftPreviewPayload as _buildDraftPreview } from "./write/draft-preview.js";

// Extracted chat completion
import {
  sanitizeUserFacingCommandErrorMessage as _sanitizeErrorMsg,
  buildDeterministicChatClientMessageId as _buildChatMsgId,
  buildNonWriteChatCompletion as _buildNonWriteCompletion,
  buildChatProcessingIndicator as _buildChatIndicator,
  resolveChatProcessingClientMessageId as _resolveChatProcessingMsgId,
} from "./chat/chat-completion.js";
import {
  sendDraftPreviewMessage as _sendDraftPreview,
  sendDraftFailureMessage as _sendDraftFailure,
  emitChatProcessingIndicator as _emitChatProcessing,
} from "./chat/chat-delivery.js";
import {
  computePostSnapshotHash as _computeSnapshotHash,
  isOwnEngagementCandidate as _isOwnEngagement,
  shouldIncludeOwnLatestCommentLookup as _shouldIncludeOwnLookup,
  extractEngagementTargetCandidateFromRecord as _extractEngagementCandidate,
  shouldAllowRareTopLevelSelfComment as _shouldAllowRareSelfComment,
} from "./engagement/engagement-helpers.js";
import {
  resolvePostSnapshotHashForPostId as _resolveSnapshotHash,
  resolveCommentAuthorIdForTarget as _resolveCommentAuthor,
  loadPostDraftDiscoverySignals as _loadDiscoverySignals,
  loadPostDraftMemorySummary as _loadDraftMemory,
  loadPostDraftContext as _loadPostDraftContext,
  loadCommentCurationContext as _loadCommentCurationContext,
} from "./engagement/engagement-context.js";
import {
  curateCommentBodyWithOpenClaw as _curateCommentWithOC,
  evaluateEngagementActionWithOpenClaw as _evaluateEngagementWithOC,
} from "./engagement/engagement-openclaw.js";
import {
  extractMediaSourceFromParsedOutput as _extractMediaSource,
  resolveGeneratedMediaSourceWithRetry as _resolveMediaSourceRetry,
  materializeMediaReferenceFiles as _materializeMediaRefs,
} from "./generate/media-source.js";
import { uploadBytesViaChunkRoute as _uploadViaChunk } from "./generate/media-upload.js";
import { runMediaGeneratorViaHttp as _runMediaGenHttp } from "./generate/media-generator-http.js";
import { saveGeneratedCustomAsset as _saveCustomAsset } from "./generate/custom-asset-save.js";
import { uploadResolvedMediaSource as _uploadMediaSource } from "./generate/media-upload-source.js";
import { runShellCommand as _runShellCommand } from "./generate/shell-command.js";
import { buildGenerateInputWithRuntimeContext as _buildGenInputWithCtx } from "./generate/generate-runtime-context.js";

// Extracted persona
import {
  normalizePersonaSlug as _normalizePersonaSlug,
  isGenericPersonaSlug as _isGenericPersona,
  extractPersonaPromptText as _extractPersonaPrompt,
  resolvePersonaVariantKeyFromPrompt as _resolveVariantKey,
  resolveExplicitPersonaVariantKey as _resolveExplicitVariant,
  isExplicitNewPersonaRequest as _isNewPersonaReq,
  resolvePersonaSelectionStrategy as _resolvePersonaStrategy,
  isPersonaMediaLockEnabled as _isPersonaMediaLock,
  isMediaLikePayloadForPersona as _isMediaLikePayload,
  shouldDefaultPersonaReferences as _shouldDefaultPersona,
  resolvePersonaReferencePlan as _resolvePersonaPlan,
  shouldUsePersonaFrameReferences as _shouldUseFrames,
  isImageMimeType as _isImageMime,
  isLikelyImageReference as _isLikelyImage,
  resolveMainPersonaSlugFromBridge as _resolveMainPersona,
} from "./persona/persona-resolution.js";
import {
  collectPersonaSeedReferenceInputs as _collectPersonaSeeds,
  collectAgentProfilePersonaSeedReferences as _collectProfileSeeds,
  updatePersonaReferenceSnapshot as _updatePersonaSnapshot,
  normalizePersonaFrameRole as _normalizeFrameRole,
  parseIsoOrNull as _parseIsoOrNull,
  parsePersonaFrameRecords as _parseFrameRecords,
  getPersonaFrameRoleSortValue as _getFrameSort,
  sortPersonaFrames as _sortFrames,
  pickPersonaFrameReferenceUrl as _pickFrameUrl,
  collectPersonaFrameReferences as _collectFrameRefs,
  listPersonaFramesFromServer as _listFramesFromServer,
  ensurePersonaDefinitionForFrames as _ensurePersonaDef,
  buildPersonaReferencePrompt as _buildPersonaPrompt,
  compressPersonaReferenceImage as _compressPersonaImage,
  upsertPersonaFrameRecord as _upsertFrameRecord,
  bootstrapPersonaReferenceFrames as _bootstrapFrames,
  resolvePersonaFrameReferences as _resolveFrameRefs,
} from "./persona/persona-frames.js";

// Extracted grants
import {
  grantActionKeysFor as _grantKeys,
  resolvePermissionWindowGrantIdForAction as _resolveGrantId,
  hasUsablePermissionWindowForAction as _hasGrant,
  buildActionIdempotencyKey as _buildActionIdempotencyKey,
  buildPostActionIdempotencyKey as _buildPostIdempotencyKey,
  beginActionLifecycle as _beginLifecycle,
  updateActionLifecycle as _updateLifecycle,
  executeCreatePostMutationWithIdempotency as _execPostMutation,
  ownerCapabilityCooldownKey as _cooldownKey,
  registerOwnerCapabilityCooldown as _registerCooldown,
  resolveOwnerCapabilityCooldown as _resolveCooldown,
  isOwnerCapabilityDeniedError as _isDeniedError,
  isNoTargetDiscoveryFailure as _isNoTargetFailure,
  listRecentCommentTargetUsage as _listRecentTargets,
  isReplySignalCommentSource as _isReplySignal,
  decideCommentTargetReuse as _decideTargetReuse,
  isRecoverableDraftGrantErrorMessage as _isRecoverableGrantError,
  isRecoverableDraftExecutionError as _isRecoverableExecError,
  isRecoverableDraftSkipDecision as _isRecoverableSkip,
  preflightGrantForAction as _preflightGrant,
} from "./grants/grants.js";

// Extracted comment curation
import {
  extractCommentPayloadHint as _extractCommentHint,
  buildCompactEngagementMemorySummary as _buildEngagementSummary,
  extractPostRecordForCommentCuration as _extractPostRecord,
  extractCommentRecordForCommentCuration as _extractCommentRecord,
  summarizePostMediaForComment as _summarizePostMedia,
} from "./write/comment-curation.js";

// Extracted post draft curation
import {
  extractTargetPostIdForPostDraft as _extractTargetPostId,
  collectDirectiveSeedHints as _collectSeedHints,
  buildPostDraftCurationPrompt as _buildDraftCurationPrompt,
  extractCuratedPostDraftFromUnknown as _extractCuratedDraft,
  buildChatLiteralFallbackPayloadFromStory as _buildStoryFallback,
} from "./write/post-draft-curation.js";
import {
  planTextPostVisualWithOpenClaw as _planVisualWithOC,
  curatePostDraftWithOpenClaw as _curateDraftWithOC,
  curateMediaPromptWithOpenClaw as _curateMediaPromptWithOC,
} from "./write/openclaw-curation.js";
import { mapDraftToWriteCommand as _mapDraftToWrite } from "./write/draft-mapping.js";

// Extracted custom asset
import {
  parseGeneratedCustomAssetKind as _parseAssetKind,
  parseGeneratedCustomAssetScope as _parseAssetScope,
  resolveGeneratedCustomAssetSaveIntent as _resolveAssetIntent,
  resolveGeneratedAssetType as _resolveAssetType,
  resolveGeneratedAttachmentMimeType as _resolveAttachmentMime,
} from "./generate/custom-asset.js";

// Extracted write helpers
import {
  buildPostNoveltyCandidateText as _buildNoveltyText,
  pruneRecentPostNoveltyHistory as _pruneNoveltyHistory,
  snapshotRecentPostNoveltyReferences as _snapshotNoveltyRefs,
  computeBidirectionalTokenOverlap as _computeOverlap,
  validatePostDraftNovelty as _validateNovelty,
  notePublishedPostForNoveltyHistory as _noteNoveltyHistory,
} from "./write/post-novelty.js";
import {
  parsePostVarietyMode as _parseVarietyMode,
  pruneRecentPostVarietyModeHistory as _pruneVarietyHistory,
  listRecentPostVarietyModes as _listVarietyModes,
  selectPostVarietyMode as _selectVarietyMode,
  notePublishedPostVarietyMode as _noteVarietyMode,
  buildPostVarietyModeRules as _buildVarietyRules,
} from "./write/post-variety.js";
import {
  normalizeCaptionPositionValue as _normalizeCaptionPos,
  sanitizeTextStyleValue as _sanitizeTextStyle,
  pickDeterministicIndex as _pickDeterministic,
  resolveAutonomousTextTheme as _resolveTextTheme,
  resolveAutonomousGradientBackground as _resolveGradientBg,
  resolveAutonomousPaletteHint as _resolvePaletteHint,
  resolveAutonomousCameraHint as _resolveCameraHint,
  resolveAutonomousCaptionPosition as _resolveCaptionPos,
  buildAutonomousVisualPrompt as _buildVisualPrompt,
  buildAutonomousThreadSlides as _buildThreadSlides,
  buildAutonomousTextBackgroundPrompt as _buildTextBgPrompt,
  buildAutonomousMediaSlides as _buildMediaSlides,
  normalizeAgentTextStyle as _normalizeTextStyle,
  extractTextPostVisualPlanFromUnknown as _extractVisualPlan,
  buildTextPostVisualPlanPrompt as _buildVisualPlanPrompt,
} from "./write/post-visual.js";

// Extracted module-level code
import {
  MEDIA_FILE_RE,
  MAX_COLLECTED_REFERENCE_INPUTS,
  REQUIRED_PERSONA_REFERENCE_FRAME_COUNT,
  PERSONA_REFERENCE_MAX_SIDE,
  PERSONA_REFERENCE_JPEG_QUALITY,
  DEFAULT_MAIN_PERSONA_SLUG,
  GENERIC_PERSONA_SLUGS,
  PERSONA_SELF_REFERENCE_PROMPT_PATTERN,
  PERSONA_REQUEST_PROMPT_PATTERN,
  PERSONA_CREATION_REQUEST_PROMPT_PATTERN,
  PERSONA_VARIANT_PATTERNS,
  COMMENT_ECHO_PREFIX_PATTERN,
  COMMENT_PROMPT_WRAPPER_PATTERN,
  COMMENT_TOKEN_STOP_WORDS,
  STREAM_PART_ARTIFACT_PATTERN,
  STREAM_PART_INDEX_PATTERN,
  TRANSIENT_MEDIA_ARTIFACT_FILENAME_PATTERN,
  NON_IMAGE_REFERENCE_EXTENSION_PATTERN,
  ACTION_IDEMPOTENCY_IN_FLIGHT_WINDOW_MS,
  ACTION_REQUEUE_BACKOFF_MS,
  OWNER_CAPABILITY_COOLDOWN_MS,
  BRIDGE_LOOKUP_CACHE_TTL_MS,
  ENGAGEMENT_TARGET_CACHE_TTL_MS,
  ENGAGEMENT_TARGET_CACHE_MAX_ENTRIES,
  COMMENT_TARGET_REUSE_WINDOW_MS,
  COMMENT_TARGET_HISTORY_LIMIT,
  COMMENT_RECENCY_TRACKED_STATES,
  POST_NOVELTY_HISTORY_WINDOW_MS,
  POST_NOVELTY_HISTORY_MAX_ITEMS,
  POST_NOVELTY_MAX_AVOID_REFERENCES,
  POST_VARIETY_HISTORY_WINDOW_MS,
  POST_VARIETY_HISTORY_MAX_ITEMS,
  POST_VARIETY_RECENT_COOLDOWN_COUNT,
  ENFORCE_PERMISSION_HINT_FILTERS,
  POST_VARIETY_HINT_PATTERNS,
  AGENT_KTHX_GUIDE_LOCATION,
  IMAGE_GENERATION_SETUP_REQUIRED_PATTERN,
  PERSONA_REFERENCE_SETUP_REQUIRED_PATTERN,
  MEDIA_GENERATION_OUTPUT_UNAVAILABLE_PATTERN,
  CAPTION_POSITION_KEYS,
  TEXT_STYLE_THEME_KEYS,
  TEXT_STYLE_ALIGN_KEYS,
  TEXT_STYLE_EMPHASIS_KEYS,
  TEXT_STYLE_FONT_KEYS,
  TEXT_STYLE_WEIGHT_KEYS,
  TEXT_STYLE_SIZE_KEYS,
  TEXT_STYLE_COLOR_KEYS,
  TEXT_STYLE_DEFAULT_COLOR_BY_THEME,
  AUTONOMOUS_TEXT_GRADIENTS,
  AUTONOMOUS_THEME_KEYWORD_HINTS,
  AUTONOMOUS_PALETTE_HINTS_BY_THEME,
  AUTONOMOUS_CAMERA_HINTS,
  AUTONOMOUS_SEQUENCE_SIGNAL_PATTERN,
  BRIDGE_RATE_LIMIT_MESSAGE_RE,
  AGENT_PROVENANCE_VALUES,
} from "./constants.js";

import {
  PERSONA_REFERENCE_FRAME_ROLES,
  POST_VARIETY_MODES,
  TEXT_STYLE_THEMES,
  RequeueCommandError,
} from "./types.js";
import type {
  TextStyleTheme,
  PostVarietyMode,
  PersonaFrameRole,
  AgentMutator,
  AgentQuery,
  AgentProcedure,
  AgentRouterLike,
  TrpcLike,
  CommandOutcome,
  QueueTrackingStateLike,
  CommandExecutorContext,
  ExecuteResult,
  ResolvedMediaUpload,
  GeneratedDraft,
  CuratedPostDraft,
  CuratedPostDraftCacheEntry,
  CuratedMediaPromptCacheEntry,
  GeneratedAssetType,
  GeneratedCustomAssetKind,
  GeneratedCustomAssetScope,
  GeneratedCustomAssetSaveIntent,
  GeneratedCustomAssetSaveResult,
  PersonaFrameRecord,
  PersonaReferenceResolution,
  PersonaReferencePlan,
  MediaGeneratorStreamFrame,
  MediaGenerationProgress,
  OpenClawPromptExecutionResult,
  DraftPreviewPayload,
  CommentCurationContext,
  CuratedCommentBody,
  PostDraftContext,
  TextPostVisualSlide,
  TextPostVisualPlan,
  EngagementTargetCandidate,
  EngagementLookupHints,
  EngagementResolutionTrace,
  RecentPostNoveltyEntry,
  RecentPostVarietyModeEntry,
  EngagementDecision,
  OwnerCapabilityCooldown,
  RecentCommentTargetUsage,
  CommentTargetReuseDecision,
  CommandLifecycleCheckpointStage,
  MediaGenerationDeferralReason,
  MediaGenerationDeferralDecision,
  ProfileCropSpec,
  CropRect,
  Command,
  CommandLifecycleState,
  ContextRequest,
  ContextBundle,
  QueueState,
  StateSqliteStore,
} from "./types.js";

import {
  isHttpUrl,
  isDataUri,
  isFileUrl,
  escapeRegex,
  stripEmptyFilesFlag,
  asNonEmptyString,
  normalizeAgentProvenanceValue,
  normalizeInterestTagToken,
  asPositiveInt,
  truncateText,
  stripEmDashCharacters,
  normalizeDelayMs,
  parseRetryDelayFromMessage,
  extractStatusCode,
  extractRetryAfterMs,
  isBridgeRateLimitedError,
  resolveBridgeRetryDelayMs,
  callBridgeWithRateLimitRetry,
  toUnknownArray,
  extractBridgeMessageId,
  isMissingFileError,
  constrainGifPromptTo256,
  outputExtensionForGeneratedAssetType,
  normalizeCommentText,
  tokenizeCommentText,
  computeTokenOverlapRatio,
  hasLongNormalizedPhraseOverlap,
  buildProfileCropSpec,
  normalizeProfileCropSpec,
  buildProfileCropPromptHint,
  buildExecutionDigest,
} from "./helpers.js";

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

  private async resolveRuntimeAgentId(): Promise<string | null> {
    return _resolveRuntimeAgentId(this.ctx, this._runtimeAgentIdState);
  }

  private resolveCommandRequestOrigin(command: Command, payload: Record<string, unknown> | null): string {
    return _resolveOrigin(command, payload);
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

  private didMediaGenerationProduceActivity(payload: unknown): boolean {
    return _didMediaActivity(
      payload,
      (p) => this.extractMediaGeneratorContextId(p),
      (p) => this.extractMediaGeneratorContextRecord(p),
    );
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

  private releaseReplayConsumedForRetry(commandId: string): void {
    _releaseReplayConsumedForRetry(this.ctx.commandSeal, commandId);
  }

  private pruneGeneratedDraftCache(): void {
    _pruneDraftCache(this.generatedDraftCache);
  }

  private buildCuratedPostDraftCacheKey(input: { commandId: string; postType: "text" | "media"; signature: string }): string {
    return _buildPostDraftKey(input);
  }

  private buildCuratedMediaPromptCacheKey(input: { commandId: string; sourcePrompt: string; generatedAssetType: GeneratedAssetType; mode: string }): string {
    return _buildMediaPromptKey(input);
  }

  private pruneCuratedPromptCaches(): void {
    _prunePromptCaches(this.curatedPostDraftCache, this.curatedMediaPromptCache);
  }

  private pruneBridgeLookupCache(nowMs: number): void {
    _pruneBridgeCache(this.bridgeLookupCache, nowMs);
  }

  private pruneEngagementTargetCache(nowMs: number): void {
    _pruneEngagementCache(this.engagementTargetCache, nowMs);
  }

  private buildEngagementTargetCacheKey(input: { action: "comment" | "like" | "repost"; payload: Record<string, unknown>; hints: EngagementLookupHints }): string {
    return _buildEngagementKey(input);
  }

  private async callAgentBridgeLookupCached(payload: Record<string, unknown>, ttlMs: number = BRIDGE_LOOKUP_CACHE_TTL_MS): Promise<{ value: unknown; cacheHit: boolean }> {
    return _bridgeLookupCached(this.bridgeLookupCache, this.ctx.callAgentChatBridge, payload, ttlMs);
  }

  private extractEngagementLookupHints(payload: Record<string, unknown>): EngagementLookupHints {
    return _extractHints(payload);
  }

  private parseTargetIdsFromTextLine(text: string): { postId: number | null; commentId: number | null } {
    return _parseTargetIds(text);
  }

  private resolveChatCommandName(payload: Record<string, unknown>): string | null {
    return _resolveChatCmd(payload);
  }

  private resolveDelegatedFollowAction(payload: Record<string, unknown>): "follow" | "follow_engagers" | "follow_accept" | "follow_suggestions" | null {
    return _resolveFollowAction(payload);
  }

  private resolveProfileWriteTarget(value: string | null | undefined): "agent" | "owner" {
    return _resolveProfileTarget(value);
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
      return await this.processCommandFilePath(filePath, processOptions);
    } finally {
      this.inFlight.delete(filePath);
    }
  }

  private agent(): AgentRouterLike {
    return resolveAgentRouter(this.ctx.trpc);
  }

  private directiveAckMutator(): AgentMutator {
    return resolveDirectiveAckMutator(this.ctx.trpc);
  }

  private agentQueryOptional(name: string): AgentQuery | null {
    return resolveAgentQueryOptional(this.ctx.trpc, name);
  }

  private agentMutatorOptional(name: string): AgentMutator | null {
    return resolveAgentMutatorOptional(this.ctx.trpc, name);
  }

  private normalizePersonaSlug(value: unknown): string | null {
    return _normalizePersonaSlug(value);
  }

  private isGenericPersonaSlug(value: string | null): boolean {
    return _isGenericPersona(value);
  }

  private extractPersonaPromptText(payload: Record<string, unknown>): string {
    return _extractPersonaPrompt(payload);
  }

  private resolvePersonaVariantKeyFromPrompt(promptText: string): string | null {
    return _resolveVariantKey(promptText);
  }

  private resolveExplicitPersonaVariantKey(payload: Record<string, unknown>): string | null {
    return _resolveExplicitVariant(payload);
  }

  private isExplicitNewPersonaRequest(payload: Record<string, unknown>): boolean {
    return _isNewPersonaReq(payload);
  }

  private resolvePersonaSelectionStrategy(payload: Record<string, unknown>): string | null {
    return _resolvePersonaStrategy(payload);
  }

  private isPersonaMediaLockEnabled(payload: Record<string, unknown>): boolean {
    return _isPersonaMediaLock(payload);
  }

  private isMediaLikePayloadForPersona(payload: Record<string, unknown>, command: Command | null): boolean {
    return _isMediaLikePayload(payload, command, (p, d) => this.resolveRequestedGenerateKinds(p, d));
  }

  private shouldDefaultPersonaReferences(payload: Record<string, unknown>, command: Command | null): boolean {
    return _shouldDefaultPersona(payload, command, (p, d) => this.resolveRequestedGenerateKinds(p, d));
  }

  private resolvePersonaReferencePlan(payload: Record<string, unknown>, mainPersonaSlugRaw: string | null = null, command: Command | null = null): PersonaReferencePlan {
    return _resolvePersonaPlan(payload, mainPersonaSlugRaw, command, (p, d) => this.resolveRequestedGenerateKinds(p, d));
  }

  private shouldUsePersonaFrameReferences(plan: PersonaReferencePlan): boolean {
    return _shouldUseFrames(plan);
  }

  private isImageMimeType(value: string | null | undefined): boolean {
    return _isImageMime(value);
  }

  private isLikelyImageReference(value: string | null | undefined, fallbackMimeType: string | null = null): boolean {
    return _isLikelyImage(value, fallbackMimeType);
  }

  private async resolveMainPersonaSlugFromBridge(): Promise<string | null> {
    return _resolveMainPersona(this.ctx, (p, t) => this.callAgentBridgeLookupCached(p, t));
  }

  private collectPersonaSeedReferenceInputs(input: { payload: Record<string, unknown>; fallbackReferenceInputs: string[] }): string[] {
    return _collectPersonaSeeds(input, {
      collectMediaReferenceInputs: (p, o) => this.collectMediaReferenceInputs(p, o),
      isStreamPartArtifactReference: (v) => this.isStreamPartArtifactReference(v),
    });
  }

  private async collectAgentProfilePersonaSeedReferences(): Promise<string[]> {
    return _collectProfileSeeds({
      ctx: this.ctx,
      callBridgeLookupCached: (p, t) => this.callAgentBridgeLookupCached(p, t),
      isStreamPartArtifactReference: (v) => this.isStreamPartArtifactReference(v),
    });
  }

  private updatePersonaReferenceSnapshot(input: { mainPersonaSlug: string; personaSlug: string; source: string; frameReferences: string[]; builtFrames: boolean; variantKey: string | null }): void {
    _updatePersonaSnapshot(input, this.ctx);
  }

  private normalizePersonaFrameRole(value: unknown): PersonaFrameRole | null {
    return _normalizeFrameRole(value);
  }

  private parseIsoOrNull(value: unknown): string | null {
    return _parseIsoOrNull(value);
  }

  private parsePersonaFrameRecords(value: unknown): PersonaFrameRecord[] {
    return _parseFrameRecords(value);
  }

  private getPersonaFrameRoleSortValue(frameRole: PersonaFrameRole): number {
    return _getFrameSort(frameRole);
  }

  private sortPersonaFrames(frames: PersonaFrameRecord[]): PersonaFrameRecord[] {
    return _sortFrames(frames);
  }

  private pickPersonaFrameReferenceUrl(frame: PersonaFrameRecord): string | null {
    return _pickFrameUrl(frame, (v) => this.isStreamPartArtifactReference(v));
  }

  private collectPersonaFrameReferences(frames: PersonaFrameRecord[]): string[] {
    return _collectFrameRefs(frames, (v) => this.isStreamPartArtifactReference(v));
  }

  private async listPersonaFramesFromServer(personaSlug: string): Promise<PersonaFrameRecord[]> {
    return _listFramesFromServer(personaSlug, {
      ctx: this.ctx,
      agentQueryOptional: (n) => this.agentQueryOptional(n),
      isStreamPartArtifactReference: (v) => this.isStreamPartArtifactReference(v),
    });
  }

  private async ensurePersonaDefinitionForFrames(personaSlug: string, payload: Record<string, unknown>): Promise<void> {
    return _ensurePersonaDef(personaSlug, payload, {
      ctx: this.ctx,
      agentQueryOptional: (n) => this.agentQueryOptional(n),
      agentMutatorOptional: (n) => this.agentMutatorOptional(n),
    });
  }

  private buildPersonaReferencePrompt(input: { personaSlug: string; frameRole: PersonaFrameRole; payload: Record<string, unknown> }): string {
    return _buildPersonaPrompt(input);
  }

  private async compressPersonaReferenceImage(input: { sourceUrl: string; sourceMimeType: string | null; personaSlug: string; frameRole: PersonaFrameRole }): Promise<ResolvedMediaUpload | null> {
    return _compressPersonaImage(input, {
      agent: () => this.agent(),
      uploadBytesViaChunkRoute: (i) => this.uploadBytesViaChunkRoute(i),
      mapUploadResult: (u) => this.mapUploadResult(u),
      transformCustomAssetMedia: (i) => transformCustomAssetMedia(i as Parameters<typeof transformCustomAssetMedia>[0]),
    });
  }

  private async upsertPersonaFrameRecord(input: { personaSlug: string; frameRole: PersonaFrameRole; media: ResolvedMediaUpload; sourcePrompt: string; sourceCommandId: string }): Promise<boolean> {
    return _upsertFrameRecord(input, {
      ctx: this.ctx,
      agentMutatorOptional: (n) => this.agentMutatorOptional(n),
      resolvePreferredMediaUrl: (...v) => this.resolvePreferredMediaUrl(...v),
    });
  }

  private _personaFrameDeps(): import("./persona/persona-frames.js").PersonaFrameDeps {
    return {
      ctx: this.ctx,
      agent: () => this.agent(),
      agentQueryOptional: (n) => this.agentQueryOptional(n),
      agentMutatorOptional: (n) => this.agentMutatorOptional(n),
      callBridgeLookupCached: (p, t) => this.callAgentBridgeLookupCached(p, t),
      collectMediaReferenceInputs: (p, o) => this.collectMediaReferenceInputs(p, o),
      isStreamPartArtifactReference: (v) => this.isStreamPartArtifactReference(v),
      resolvePreferredMediaUrl: (...v) => this.resolvePreferredMediaUrl(...v),
      generateAndUploadMediaFromPrompt: (p, o) => this.generateAndUploadMediaFromPrompt(p, o as Parameters<typeof this.generateAndUploadMediaFromPrompt>[1]),
      uploadBytesViaChunkRoute: (i) => this.uploadBytesViaChunkRoute(i),
      mapUploadResult: (u) => this.mapUploadResult(u),
      transformCustomAssetMedia: (i) => transformCustomAssetMedia(i as Parameters<typeof transformCustomAssetMedia>[0]),
      resolveRequestedGenerateKinds: (p, d) => this.resolveRequestedGenerateKinds(p, d),
    };
  }

  private async bootstrapPersonaReferenceFrames(input: { personaSlug: string; payload: Record<string, unknown>; command: Command; existingFrames: PersonaFrameRecord[]; seedReferences?: string[] }): Promise<{ frames: PersonaFrameRecord[]; builtFrames: boolean }> {
    return _bootstrapFrames(input, this._personaFrameDeps());
  }

  private async resolvePersonaFrameReferences(input: { payload: Record<string, unknown>; command: Command; fallbackReferenceInputs: string[] }): Promise<PersonaReferenceResolution> {
    return _resolveFrameRefs(input, this._personaFrameDeps());
  }

  private async processCommandFilePath(
    filePath: string,
    queueContext?: { attempts?: number; maxAttempts?: number },
  ): Promise<boolean> {
    const inboxFile = path.basename(filePath);
    const read = await readJsonMaybeIncomplete(filePath);
    if (read.status === "missing") {
      await this.markQueueItemCompletedByInbox(inboxFile, "missing", "file missing before execution");
      return true;
    }
    if (read.status === "not_ready") {
      await this.markQueueItemNotReadyByInbox(inboxFile, "inbox_json_not_ready").catch(
        () => undefined,
      );
      return false;
    }
    if (read.status === "invalid") {
      await this.writeOutcome({
        at: nowIso(),
        commandId: `invalid:${inboxFile}`,
        kind: "unknown",
        grantId: null,
        ok: false,
        error: { message: "invalid json command" },
      });
      await this.moveInboxFileToProcessed(filePath, "invalid");
      await this.markQueueItemCompletedByInbox(inboxFile, "failed", "invalid json command");
      return true;
    }

    let command = parseCommand(read.value);
    if (!command) {
      await this.writeOutcome({
        at: nowIso(),
        commandId: `parse_failed:${inboxFile}`,
        kind: "unknown",
        grantId: null,
        ok: false,
        error: { message: "command parse failed" },
      });
      await this.moveInboxFileToProcessed(filePath, "invalid");
      await this.markQueueItemCompletedByInbox(inboxFile, "failed", "command parse failed");
      return true;
    }
    await this.recordCommandLifecycleCheckpoint({
      command,
      stage: "received",
      status: "ok",
      metadata: {
        inboxFile,
      },
    });
    const runtimeOrigin =
      asNonEmptyString(command.runtimeOrigin)?.trim().toLowerCase() ?? "";
    const isDirectiveScopedCommand =
      runtimeOrigin === "director_directive" ||
      runtimeOrigin === "pending_promotion" ||
      runtimeOrigin === "runtime_resealed" ||
      asNonEmptyString(command.sourceDirectiveId) !== null ||
      asNonEmptyString(command.pendingDirectiveId) !== null;
    const targetAgentId = asNonEmptyString(command.targetAgentId);
    if (!targetAgentId && isDirectiveScopedCommand) {
      const missingReason = "directive_target_agent_missing";
      await this.ctx.memory
        .recordWrite({
          type: "inbox_command_target_agent_missing",
          at: nowIso(),
          inboxFile,
          commandId: command.id,
          kind: command.kind,
          runtimeOrigin: command.runtimeOrigin ?? null,
          sourceDirectiveId: command.sourceDirectiveId ?? null,
          pendingDirectiveId: command.pendingDirectiveId ?? null,
          reason: missingReason,
        })
        .catch(() => undefined);
      const outcome: CommandOutcome = {
        at: nowIso(),
        commandId: command.id,
        kind: command.kind,
        grantId: command.grantId,
        ok: false,
        error: {
          message: "Rejected command: directive target agent id is missing.",
          code: missingReason,
        },
      };
      await this.finalizeCommandOutcome({ command, outcome });
      await this.moveInboxFileToProcessed(filePath, "rejected");
      await this.markQueueItemCompletedByInbox(
        inboxFile,
        "failed",
        "directive target agent id missing",
      );
      return true;
    }
    if (targetAgentId) {
      const runtimeAgentId = await this.resolveRuntimeAgentId();
      if (!runtimeAgentId || runtimeAgentId.length === 0) {
        const unresolvedReason = `target_agent_identity_unknown:${targetAgentId}`;
        await this.ctx.memory
          .recordWrite({
            type: "inbox_command_target_agent_identity_unknown",
            at: nowIso(),
            inboxFile,
            commandId: command.id,
            kind: command.kind,
            targetAgentId,
            reason: unresolvedReason,
          })
          .catch(() => undefined);
        await this.markQueueItemNotReadyByInbox(inboxFile, unresolvedReason).catch(
          () => undefined,
        );
        return false;
      }
      if (
        runtimeAgentId !== targetAgentId
      ) {
        const mismatchReason = `target_agent_mismatch:${targetAgentId}:${runtimeAgentId}`;
        await this.ctx.memory
          .recordWrite({
            type: "inbox_command_target_agent_mismatch",
            at: nowIso(),
            inboxFile,
            commandId: command.id,
            kind: command.kind,
            targetAgentId,
            runtimeAgentId,
            reason: mismatchReason,
          })
          .catch(() => undefined);
        await this.markQueueItemNotReadyByInbox(inboxFile, mismatchReason).catch(
          () => undefined,
        );
        return false;
      }
    }

    let commandSigVerified = false;
    if (this.ctx.controlKey) {
      const expected = computeCommandSignature(this.ctx.controlKey, command);
      if (!command.sig || command.sig !== expected) {
        const outcome: CommandOutcome = {
          at: nowIso(),
          commandId: command.id,
          kind: command.kind,
          grantId: command.grantId,
          ok: false,
          error: {
            message:
              "Rejected command: invalid command signature for this runtime session.",
            code: "invalid_command_sig",
          },
        };
        await this.finalizeCommandOutcome({ command, outcome });
        await this.moveInboxFileToProcessed(filePath, "rejected");
        await this.markQueueItemCompletedByInbox(inboxFile, "failed", "invalid command signature");
        return true;
      }
      commandSigVerified = true;
    }

    let sealError = verifyRuntimeCommandSeal(this.ctx.commandSeal, command);
    if (
      sealError === "command_replay_detected" &&
      this.tryAllowTrustedReplay(command)
    ) {
      sealError = verifyRuntimeCommandSeal(this.ctx.commandSeal, command);
    }
    if (
      sealError === "command_not_issued_by_runtime" &&
      this.tryRehydrateRuntimeIssuedSeal(command)
    ) {
      await this.ctx.memory
        .recordWrite({
          type: "inbox_command_seal_rehydrated",
          at: nowIso(),
          inboxFile,
          commandId: command.id,
          kind: command.kind,
          runtimeOrigin: command.runtimeOrigin ?? null,
        })
        .catch(() => undefined);
      sealError = verifyRuntimeCommandSeal(this.ctx.commandSeal, command);
    }
    if (sealError) {
      const resealedCommand = await this.tryResealTrustedCommandForActiveSession({
        command,
        sealError,
        commandSigVerified,
        filePath,
        inboxFile,
      });
      if (resealedCommand) {
        command = resealedCommand;
        sealError = verifyRuntimeCommandSeal(this.ctx.commandSeal, command);
      }
    }
    if (sealError) {
      const outcome: CommandOutcome = {
        at: nowIso(),
        commandId: command.id,
        kind: command.kind,
        grantId: command.grantId,
        ok: false,
        error: {
          message:
            "Rejected external or stale command file. Only runtime-sealed commands from this active tunnel session are executable.",
          code: sealError,
        },
      };
      await this.ctx.memory.recordWrite({
        type: "inbox_command_rejected",
        at: nowIso(),
        inboxFile,
        commandId: command.id,
        kind: command.kind,
        reason: sealError,
      }).catch(() => undefined);
      await this.finalizeCommandOutcome({ command, outcome });
      await this.moveInboxFileToProcessed(filePath, "rejected");
      await this.markQueueItemCompletedByInbox(
        inboxFile,
        "failed",
        `runtime command seal rejected (${sealError})`,
      );
      return true;
    }

    await this.recordCommandLifecycleCheckpoint({
      command,
      stage: "queued",
      status: "ok",
      metadata: {
        inboxFile,
      },
    });
    await this.recordCommandLifecycleCheckpoint({
      command,
      stage: "executing",
      status: "ok",
    });
    await this.emitChatProcessingIndicator(command).catch(() => undefined);

    const result = await this.executeCommand(command).catch(async (error: unknown) => {
      if (error instanceof RequeueCommandError) {
        this.releaseReplayConsumedForRetry(command.id);
        const requeueReason =
          typeof error.message === "string" && error.message.trim().length > 0
            ? error.message.trim()
            : "not_ready";
        await this.markQueueItemNotReadyByInbox(inboxFile, requeueReason).catch(() => undefined);
        await this.primeCommandContextForRequeue(command, requeueReason).catch(() => undefined);
        void this.ctx.memory
          .recordWrite({
            type: "inbox_command_requeued",
            at: nowIso(),
            inboxFile,
            commandId: command.id,
            kind: command.kind,
            reason: requeueReason,
            replayConsumedReleased: true,
          })
          .catch(() => undefined);
        return {
          processed: false,
          outcome: null,
        } satisfies ExecuteResult;
      }
      const message = error instanceof Error ? error.message : String(error);
      const outcome: CommandOutcome = {
        at: nowIso(),
        commandId: command.id,
        kind: command.kind,
        grantId: command.grantId,
        ok: false,
        error: { message },
      };
      return {
        processed: true,
        outcome,
      } satisfies ExecuteResult;
    });

    if (!result.processed) {
      const attempts = queueContext?.attempts ?? 0;
      const maxAttempts = queueContext?.maxAttempts ?? 0;
      if (maxAttempts > 0 && attempts >= maxAttempts - 1) {
        const terminalOutcome: CommandOutcome = {
          at: nowIso(),
          commandId: command.id,
          kind: command.kind,
          grantId: command.grantId,
          ok: false,
          error: {
            message: `Command failed after ${attempts} attempts (max retry exceeded).`,
            code: "max_retry_exceeded",
          },
        };
        await this.finalizeCommandOutcome({ command, outcome: terminalOutcome });
        await this.updatePendingDirectiveStatusForOutcome(command, terminalOutcome).catch(
          () => undefined,
        );
        await this.moveInboxFileToProcessed(filePath, "failed");
        await this.markQueueItemCompletedByInbox(
          inboxFile,
          "failed",
          `max_retry_exceeded (${attempts} attempts)`,
        );
        return true;
      }
      return false;
    }
    const outcome = result.outcome;
    if (!outcome) {
      await this.updatePendingDirectiveStatusForOutcome(command, null).catch(
        () => undefined,
      );
      await this.moveInboxFileToProcessed(filePath, "done");
      await this.markQueueItemCompletedByInbox(inboxFile, "done", null);
      return true;
    }

    if (command.kind.trim().toLowerCase().startsWith("write.")) {
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "write_mutation",
        status: outcome.ok ? "ok" : "failed",
        message: outcome.ok ? null : outcome.error?.message ?? null,
      });
    }

    await this.finalizeCommandOutcome({ command, outcome });
    await this.updatePendingDirectiveStatusForOutcome(command, outcome).catch(
      () => undefined,
    );

    if (outcome.ok) {
      await this.moveInboxFileToProcessed(filePath, "done");
      await this.markQueueItemCompletedByInbox(inboxFile, "done", null);
    } else {
      await this.moveInboxFileToProcessed(filePath, "failed");
      await this.markQueueItemCompletedByInbox(
        inboxFile,
        "failed",
        outcome.error?.message ?? "command failed",
      );
    }
    return true;
  }

  private resolvePendingDirectiveTerminalStatus(outcome: CommandOutcome | null): "completed" | "permission_denied" | "no_executable_draft" | "max_retry_exceeded" {
    return _resolveTerminalStatus(outcome);
  }

  private async resolvePendingDirectiveFilePath(pendingDirectiveId: string): Promise<string | null> {
    return _resolveDirectivePath(pendingDirectiveId, this.ctx);
  }

  private async updatePendingDirectiveStatusForOutcome(command: Command, outcome: CommandOutcome | null): Promise<void> {
    return _updateDirectiveStatus(command, outcome, this.ctx);
  }

  private async executeCommand(command: Command): Promise<ExecuteResult> {
    const kind = command.kind.trim().toLowerCase();
    if (kind === "write.createpost") {
      const outcome = await this.executeWriteCreatePost(command);
      return { processed: true, outcome };
    }
    if (kind === "write.createstory") {
      const outcome = await this.executeWriteCreateStory(command);
      return { processed: true, outcome };
    }
    if (kind === "write.updateavatar") {
      const outcome = await this.executeWriteUpdateAvatar(command);
      return { processed: true, outcome };
    }
    if (kind === "write.updatebanner") {
      const outcome = await this.executeWriteUpdateBanner(command);
      return { processed: true, outcome };
    }
    if (kind === "write.commentpost" || kind === "write.comment") {
      const outcome = await this.executeWriteComment(command);
      return { processed: true, outcome };
    }
    if (kind === "write.votepost" || kind === "write.like") {
      const outcome = await this.executeWriteVote(command);
      return { processed: true, outcome };
    }
    if (kind === "write.repostpost" || kind === "write.repost") {
      const outcome = await this.executeWriteRepost(command);
      return { processed: true, outcome };
    }
    if (kind === "brain.retrypending") {
      const outcome = await this.executeRetryPending(command);
      return { processed: true, outcome };
    }
    if (
      kind === "brain.generateandqueue" ||
      kind === "brain.plan" ||
      kind === "agent.task" ||
      kind === "agent_task"
    ) {
      const outcome = await this.executeGenerateAndQueue(command);
      return { processed: true, outcome };
    }
    if (kind === "review" || kind === "agent.review") {
      const outcome = await this.executeReview(command);
      return { processed: true, outcome };
    }

    const outcome: CommandOutcome = {
      at: nowIso(),
      commandId: command.id,
      kind: command.kind,
      grantId: command.grantId,
      ok: false,
      error: {
        message: `Unsupported command kind: ${command.kind}`,
        code: "unsupported_command_kind",
      },
    };
    await this.ctx.memory.recordWrite({
      type: "command_execution_unsupported",
      at: nowIso(),
      commandId: command.id,
      kind: command.kind,
    }).catch(() => undefined);
    return { processed: true, outcome };
  }

  private async tryResealTrustedCommandForActiveSession(input: {
    command: Command;
    sealError: SealVerifyError;
    commandSigVerified: boolean;
    filePath: string;
    inboxFile: string;
  }): Promise<Command | null> {
    return _tryReseal({
      ...input,
      commandSeal: this.ctx.commandSeal,
      recordWrite: (p) => this.ctx.memory.recordWrite(p),
    });
  }

  private tryRehydrateRuntimeIssuedSeal(command: Command): boolean {
    return _tryRehydrate(this.ctx.commandSeal, command);
  }

  private tryAllowTrustedReplay(command: Command): boolean {
    return _tryAllowReplay(this.ctx.commandSeal, command);
  }

  private grantActionKeysFor(action: "comment" | "like" | "repost"): string[] {
    return _grantKeys(action);
  }

  private resolvePermissionWindowGrantIdForAction(permissionState: unknown, action: "comment" | "like" | "repost"): string | null {
    return _resolveGrantId(permissionState, action);
  }

  private hasUsablePermissionWindowForAction(permissionState: unknown, action: "comment" | "like" | "repost"): boolean {
    return _hasGrant(permissionState, action);
  }

  private buildActionIdempotencyKey(input: { command: Command; action: "comment" | "like" | "repost"; postId: number; commentId: number | null; commentBody?: string | null }): string {
    return _buildActionIdempotencyKey(input);
  }

  private buildPostActionIdempotencyKey(input: { command: Command; postType: "text" | "media"; postKind: "post" | "thread" }): string {
    return _buildPostIdempotencyKey(input);
  }

  private beginActionLifecycle(input: {
    command: Command;
    action: "comment" | "like" | "repost" | "post";
    idempotencyKey: string;
    target: {
      postId: number | null;
      commentId: number | null;
      targetHash: string;
    };
    state: CommandLifecycleState;
  }): { allowed: boolean; reason: string; requeue: boolean } {
    return _beginLifecycle(this.ctx.stateDb, input);
  }

  private updateActionLifecycle(input: {
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
  }): void {
    _updateLifecycle(this.ctx.stateDb, input);
  }

  private async executeCreatePostMutationWithIdempotency(input: {
    command: Command;
    postType: "text" | "media";
    postKind: "post" | "thread";
    mutationInput: Record<string, unknown>;
  }): Promise<
    | {
        skipped: false;
        result: unknown;
      }
    | {
        skipped: true;
        reason: string;
      }
  > {
    return _execPostMutation(this.ctx.stateDb, this.agent(), input);
  }

  private ownerCapabilityCooldownKey(input: {
    action: "comment" | "like" | "repost";
    targetHash: string;
  }): string {
    return _cooldownKey(input);
  }

  private registerOwnerCapabilityCooldown(input: {
    action: "comment" | "like" | "repost";
    targetHash: string;
    reason: string;
  }): void {
    _registerCooldown(this.ownerCapabilityDeniedByTarget, input);
  }

  private resolveOwnerCapabilityCooldown(input: {
    action: "comment" | "like" | "repost";
    targetHash: string;
  }): OwnerCapabilityCooldown | null {
    return _resolveCooldown(this.ownerCapabilityDeniedByTarget, input);
  }

  private isOwnerCapabilityDeniedError(error: unknown): boolean {
    return _isDeniedError(error);
  }

  private isNoTargetDiscoveryFailure(error: unknown): boolean {
    return _isNoTargetFailure(error);
  }

  private listRecentCommentTargetUsage(): RecentCommentTargetUsage[] {
    return _listRecentTargets(this.ctx.stateDb);
  }

  private isReplySignalCommentSource(source: string): boolean {
    return _isReplySignal(source);
  }

  private decideCommentTargetReuse(input: {
    commandId: string;
    postId: number;
    commentId: number | null;
    postSnapshotHash: string | null;
    source: string;
    recentUsage?: RecentCommentTargetUsage[];
  }): CommentTargetReuseDecision {
    return _decideTargetReuse(this.ctx.stateDb, input);
  }

  private isRecoverableDraftGrantErrorMessage(message: string): boolean {
    return _isRecoverableGrantError(message);
  }

  private isRecoverableDraftExecutionError(error: unknown): boolean {
    return _isRecoverableExecError(error);
  }

  private isRecoverableDraftSkipDecision(decision: string | null): boolean {
    return _isRecoverableSkip(decision);
  }

  private async preflightGrantForAction(input: {
    command: Command;
    payload: Record<string, unknown>;
    action: "comment" | "like" | "repost";
    lifecycle: {
      idempotencyKey: string;
        target: {
          postId: number;
          commentId: number | null;
          targetHash: string;
        };
      };
  }): Promise<string | null> {
    return _preflightGrant(this.ctx.stateDb, this.ownerCapabilityDeniedByTarget, this.ctx.memory, input);
  }

  private isDirectiveContextLinkedCommand(command: Command): boolean {
    return _isDirectiveLinked(command);
  }

  private async executeWriteCreatePost(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for write.createPost.");
    }
    const postTypeRaw = asNonEmptyString(payload.postType)?.toLowerCase();
    const postType = postTypeRaw === "text" ? "text" : "media";
    const kindRaw = asNonEmptyString(payload.kind)?.toLowerCase();
    const postKind = kindRaw === "thread" ? "thread" : "post";
    if (
      this.isChatOriginCommand(command, payload) &&
      !this.isChatWriteRequesterOwner(payload)
    ) {
      return this.failedOutcome(
        command,
        "Chat write actions are owner-only unless explicitly granted.",
        "chat_write_owner_only",
      );
    }
    const provenance = normalizeAgentProvenanceValue(payload.provenance);
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command,
      payload,
    });
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;
    const explicitSaveAsProfileMemory =
      typeof payload.saveAsProfileMemory === "boolean"
        ? payload.saveAsProfileMemory
        : null;
    const runtimeOrigin = asNonEmptyString(command.runtimeOrigin)?.toLowerCase() ?? "";
    const isDirectiveRuntimeOrigin =
      runtimeOrigin === "director_directive" || runtimeOrigin === "pending_promotion";
    let saveAsProfileMemoryForMedia = explicitSaveAsProfileMemory === true;
    const buildBase = (
      caption: string | null,
      basePostType: "text" | "media" = postType,
    ): Record<string, unknown> => ({
      kind: postKind,
      postType: basePostType,
      ...(caption ? { caption } : {}),
      ...(basePostType === "media" && saveAsProfileMemoryForMedia
        ? { saveAsProfileMemory: true }
        : {}),
      ...(provenance ? { provenance } : {}),
      ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
      ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
      ...(command.grantId ? { grantId: command.grantId } : {}),
    });
    const skippedPostOutcome = (reason: string): CommandOutcome =>
      this.successOutcome(command, {
        skipped: true,
        action: "post",
        postType,
        postKind,
        decision: reason,
      });

    const targetPostId = this.extractTargetPostIdForPostDraft(payload);
    const postDraftContext = await this.loadPostDraftContext({
      postId: targetPostId,
      payload,
    });
    const requiresCuration = sourceDirectiveId !== null ? true : isDirectiveRuntimeOrigin;
    const directiveSinglePromptMode = requiresCuration;
    const directiveSeedHints = this.collectDirectiveSeedHints(payload);
    const postVariety = this.selectPostVarietyMode({
      commandId: command.id,
      postType,
      payload,
      context: postDraftContext,
      seedHints: directiveSeedHints,
    });
    await this.ctx.memory
      .recordWrite({
        type: "post_variety_mode_selected",
        at: nowIso(),
        commandId: command.id,
        postType,
        mode: postVariety.mode,
        reason: postVariety.reason,
        recentModes: postVariety.recentModes,
        targetPostId: postDraftContext.targetPostId,
      })
      .catch(() => undefined);

    if (postType === "text") {
      const textBodyInitial = asNonEmptyString(payload.textBody);
      if (!textBodyInitial) {
        return this.failedOutcome(command, "textBody is required for text posts.");
      }
      const captionInitial = asNonEmptyString(payload.caption);
      const noveltyAvoidReferences = this.snapshotRecentPostNoveltyReferences("text");
      const curatedTextDraft = await this.curatePostDraftWithOpenClaw({
        commandId: command.id,
        postType: "text",
        varietyMode: postVariety.mode,
        caption: captionInitial,
        textBody: textBodyInitial,
        mediaPrompt: null,
        context: postDraftContext,
        seedHints: directiveSeedHints,
        avoidReferences: noveltyAvoidReferences,
      });
      if (requiresCuration && !curatedTextDraft) {
        throw new RequeueCommandError(
          "post_curation_waiting_for_openclaw:text_curation_unavailable",
        );
      }
      let captionForWrite = curatedTextDraft?.caption ?? captionInitial;
      let textBodyForWrite = curatedTextDraft?.textBody ?? textBodyInitial;
      captionForWrite = captionForWrite ? stripEmDashCharacters(captionForWrite) : captionForWrite;
      textBodyForWrite = stripEmDashCharacters(textBodyForWrite);
      if (!textBodyForWrite) {
        return this.failedOutcome(command, "textBody is required for text posts.");
      }
      let noveltyValidation = this.validatePostDraftNovelty({
        postType: "text",
        caption: captionForWrite,
        textBody: textBodyForWrite,
        mediaPrompt: null,
        context: postDraftContext,
        seedHints: directiveSeedHints,
      });
      if (!noveltyValidation.ok) {
        await this.ctx.memory
          .recordWrite({
            type: "post_novelty_rejected",
            at: nowIso(),
            commandId: command.id,
            postType: "text",
            reason: noveltyValidation.reason,
            candidatePreview: truncateText(noveltyValidation.candidateText, 240),
            referencePreview: noveltyValidation.referencePreview,
          })
          .catch(() => undefined);
        if (directiveSinglePromptMode) {
          await this.ctx.memory
            .recordWrite({
              type: "post_novelty_recuration_skipped",
              at: nowIso(),
              commandId: command.id,
              postType: "text",
              reason: noveltyValidation.reason,
              policy: "single_prompt_per_directive",
            })
            .catch(() => undefined);
          noveltyValidation = {
            ok: true,
            candidateText: this.buildPostNoveltyCandidateText({
              postType: "text",
              caption: captionForWrite,
              textBody: textBodyForWrite,
              mediaPrompt: null,
            }),
          };
        } else {
          const recurationReferences = Array.from(
            new Set<string>(
              [
                ...noveltyAvoidReferences,
                noveltyValidation.referencePreview ?? "",
                truncateText(noveltyValidation.candidateText, 260),
              ]
                .map((value) => value.trim())
                .filter((value) => value.length > 0),
            ),
          );
          const recuratedTextDraft = await this.curatePostDraftWithOpenClaw({
            commandId: command.id,
            postType: "text",
            varietyMode: postVariety.mode,
            caption: captionForWrite,
            textBody: textBodyForWrite,
            mediaPrompt: null,
            context: postDraftContext,
            seedHints: directiveSeedHints,
            avoidReferences: recurationReferences,
          });
          if (!recuratedTextDraft) {
            if (requiresCuration) {
              throw new RequeueCommandError(
                "post_curation_waiting_for_openclaw:text_novelty_recuration_unavailable",
              );
            }
            return this.failedOutcome(
              command,
              `Blocked text post draft due to low novelty (${noveltyValidation.reason}).`,
              "post_novelty_rejected",
            );
          }
          captionForWrite = recuratedTextDraft.caption ?? captionForWrite;
          textBodyForWrite = recuratedTextDraft.textBody ?? textBodyForWrite;
          captionForWrite = captionForWrite ? stripEmDashCharacters(captionForWrite) : captionForWrite;
          textBodyForWrite = stripEmDashCharacters(textBodyForWrite);
          noveltyValidation = this.validatePostDraftNovelty({
            postType: "text",
            caption: captionForWrite,
            textBody: textBodyForWrite,
            mediaPrompt: null,
            context: postDraftContext,
            seedHints: directiveSeedHints,
          });
          if (!noveltyValidation.ok) {
            await this.ctx.memory
              .recordWrite({
                type: "post_novelty_blocked",
                at: nowIso(),
                commandId: command.id,
                postType: "text",
                reason: noveltyValidation.reason,
                candidatePreview: truncateText(noveltyValidation.candidateText, 240),
                referencePreview: noveltyValidation.referencePreview,
              })
              .catch(() => undefined);
            return this.failedOutcome(
              command,
              `Blocked text post draft due to low novelty (${noveltyValidation.reason}).`,
              "post_novelty_blocked",
            );
          }
          await this.ctx.memory
            .recordWrite({
              type: "post_novelty_recurated",
              at: nowIso(),
              commandId: command.id,
              postType: "text",
            })
            .catch(() => undefined);
        }
      }
      const candidate = noveltyValidation.candidateText;
      const autonomousTheme = this.resolveAutonomousTextTheme({
        commandId: command.id,
        postKind,
        caption: captionForWrite,
        textBody: textBodyForWrite,
      });
      const autonomousCaptionPosition = this.resolveAutonomousCaptionPosition({
        commandId: command.id,
        postKind,
        seedText: `${captionForWrite ?? ""} ${textBodyForWrite}`,
      });
      const autonomousAlign = autonomousCaptionPosition.split("-")[1] ?? "center";
      const emphasisOptions =
        postKind === "thread"
          ? (["display", "bold", "mono", "serif"] as const)
          : (["soft", "bold", "serif", "mono"] as const);
      const fontOptions =
        postKind === "thread"
          ? (["display", "sans", "mono", "serif"] as const)
          : (["sans", "serif", "mono", "display"] as const);
      const sizeOptions =
        postKind === "thread"
          ? (["xl", "2xl", "lg"] as const)
          : (["lg", "xl", "md"] as const);
      const autonomousStyleFallback: Record<string, unknown> = {
        theme: autonomousTheme,
        align:
          autonomousAlign === "left" ||
          autonomousAlign === "center" ||
          autonomousAlign === "right"
            ? autonomousAlign
            : "center",
        emphasis:
          emphasisOptions[
            this.pickDeterministicIndex(
              `${command.id}:${candidate}:text_emphasis`,
              emphasisOptions.length,
            )
          ] ?? "soft",
        font:
          fontOptions[
            this.pickDeterministicIndex(
              `${command.id}:${candidate}:text_font`,
              fontOptions.length,
            )
          ] ?? "sans",
        weight:
          this.pickDeterministicIndex(`${command.id}:${candidate}:text_weight`, 100) < 52
            ? "bold"
            : "regular",
        size:
          sizeOptions[
            this.pickDeterministicIndex(
              `${command.id}:${candidate}:text_size`,
              sizeOptions.length,
            )
          ] ?? "lg",
        italic:
          this.pickDeterministicIndex(`${command.id}:${candidate}:text_italic`, 100) < 24,
        color: TEXT_STYLE_DEFAULT_COLOR_BY_THEME[autonomousTheme],
        position: autonomousCaptionPosition,
        background: this.resolveAutonomousGradientBackground(
          autonomousTheme,
          `${command.id}:${candidate}:text_background`,
        ),
      };
      const visualPlan = await this.planTextPostVisualWithOpenClaw({
        commandId: command.id,
        postKind,
        caption: captionForWrite,
        textBody: textBodyForWrite,
        context: postDraftContext,
      });
      const captionPositionForWrite =
        this.normalizeCaptionPositionValue(payload.captionPosition) ??
        visualPlan?.captionPosition ??
        autonomousCaptionPosition;
      const normalizedTextStyle = this.normalizeAgentTextStyle(
        this.sanitizeTextStyleValue(payload.textStyle) ?? visualPlan?.textStyle ?? null,
        captionPositionForWrite,
        autonomousStyleFallback,
      );
      const plannerSlides = visualPlan?.slides.slice(0, 4) ?? [];
      const autonomousSlides = this.buildAutonomousThreadSlides({
        commandId: command.id,
        caption: captionForWrite,
        textBody: textBodyForWrite,
        theme: autonomousTheme,
        postKind,
      });
      const selectedSlides =
        plannerSlides.length >= 2 ? plannerSlides : autonomousSlides;
      const shouldAttemptSlides =
        selectedSlides.length >= 2 &&
        (visualPlan?.renderMode === "slides" || postKind === "thread");
      const visualBackgroundPromptRaw =
        visualPlan?.backgroundImagePrompt ??
        this.buildAutonomousTextBackgroundPrompt({
          commandId: command.id,
          caption: captionForWrite,
          textBody: textBodyForWrite,
          theme: autonomousTheme,
          postKind,
        });
      const visualBackgroundPrompt = visualBackgroundPromptRaw
        ? stripEmDashCharacters(visualBackgroundPromptRaw).trim()
        : "";
      const shouldAttemptImageBackground =
        !shouldAttemptSlides && visualBackgroundPrompt.length >= 8;
      if (shouldAttemptSlides) {
        const slideItems: Array<Record<string, unknown>> = [];
        const slidePrompts = selectedSlides.slice(0, 4);
        for (const slide of slidePrompts) {
          const slidePrompt = stripEmDashCharacters(slide.imagePrompt).trim();
          if (slidePrompt.length < 8) continue;
          const slideMedia = await this.resolveMediaUpload({
            payload: {
              ...payload,
              generatedAssetType: "image",
            },
            keepOriginal: true,
            promptFallbacks: [slidePrompt],
            command,
            skipPromptCuration: true,
          });
          slideItems.push({
            mediaUrl: slideMedia.mediaUrl,
            ...(slideMedia.mediaOriginalUrl
              ? { mediaOriginalUrl: slideMedia.mediaOriginalUrl }
              : {}),
            ...(slideMedia.mediaOptimizedUrl
              ? { mediaOptimizedUrl: slideMedia.mediaOptimizedUrl }
              : {}),
            ...(slideMedia.mediaContentHash
              ? { mediaContentHash: slideMedia.mediaContentHash }
              : {}),
            ...(slideMedia.mediaIpfsCid
              ? { mediaIpfsCid: slideMedia.mediaIpfsCid }
              : {}),
            ...(typeof slideMedia.mediaSizeBytes === "number"
              ? { mediaSizeBytes: slideMedia.mediaSizeBytes }
              : {}),
            ...(slideMedia.mediaType ? { mediaType: slideMedia.mediaType } : {}),
            ...(slide.caption ? { caption: slide.caption } : {}),
            ...(captionPositionForWrite
              ? { captionPosition: captionPositionForWrite }
              : {}),
          });
        }
        if (slideItems.length >= 2) {
          const firstSlide = slideItems[0] ?? {};
          const firstSlideMediaUrl = asNonEmptyString(firstSlide.mediaUrl);
          if (firstSlideMediaUrl) {
            const slideMutation = await this.executeCreatePostMutationWithIdempotency({
              command,
              postType: "media",
              postKind,
              mutationInput: {
                ...buildBase(captionForWrite, "media"),
                mediaUrl: firstSlideMediaUrl,
                ...(asNonEmptyString(firstSlide.mediaOriginalUrl)
                  ? { mediaOriginalUrl: asNonEmptyString(firstSlide.mediaOriginalUrl) }
                  : {}),
                ...(asNonEmptyString(firstSlide.mediaOptimizedUrl)
                  ? { mediaOptimizedUrl: asNonEmptyString(firstSlide.mediaOptimizedUrl) }
                  : {}),
                ...(asNonEmptyString(firstSlide.mediaContentHash)
                  ? { mediaContentHash: asNonEmptyString(firstSlide.mediaContentHash) }
                  : {}),
                ...(asNonEmptyString(firstSlide.mediaIpfsCid)
                  ? { mediaIpfsCid: asNonEmptyString(firstSlide.mediaIpfsCid) }
                  : {}),
                ...(typeof firstSlide.mediaSizeBytes === "number" &&
                Number.isFinite(firstSlide.mediaSizeBytes)
                  ? {
                      mediaSizeBytes: Math.max(
                        1,
                        Math.floor(firstSlide.mediaSizeBytes),
                      ),
                    }
                  : {}),
                ...(asNonEmptyString(firstSlide.mediaType)
                  ? { mediaType: asNonEmptyString(firstSlide.mediaType) }
                  : {}),
                mediaItems: slideItems,
                ...(captionPositionForWrite
                  ? { captionPosition: captionPositionForWrite }
                  : {}),
              },
            });
            if (slideMutation.skipped) {
              return skippedPostOutcome(slideMutation.reason);
            }
            const slideResult = slideMutation.result;
            this.notePublishedPostForNoveltyHistory({
              postType: "media",
              caption: captionForWrite,
              textBody: null,
              mediaPrompt: slidePrompts
                .map((entry) => entry.imagePrompt)
                .join(" | "),
              commandId: command.id,
              targetPostId: postDraftContext.targetPostId,
            });
            this.notePublishedPostVarietyMode({
              commandId: command.id,
              postType: "media",
              targetPostId: postDraftContext.targetPostId,
              mode: postVariety.mode,
              signal: postVariety.signal,
            });
            await this.ctx.memory
              .recordWrite({
                type: "runtime_post_publish_recorded",
                at: nowIso(),
                commandId: command.id,
                kind: postKind,
                postType: "media",
                varietyMode: postVariety.mode,
                targetPostId: postDraftContext.targetPostId,
                bodyPreview: truncateText(candidate, 260),
                visualRenderMode:
                  plannerSlides.length >= 2 ? "slides" : "autonomous_slides",
                slideCount: slideItems.length,
                textStyleTheme: autonomousTheme,
              })
              .catch(() => undefined);
            return this.successOutcome(command, slideResult);
          }
        }
        await this.ctx.memory
          .recordWrite({
            type: "text_post_slides_fallback",
            at: nowIso(),
            commandId: command.id,
            slideCountRequested: slidePrompts.length,
            slideCountResolved: slideItems.length,
          })
          .catch(() => undefined);
      }
      if (shouldAttemptImageBackground) {
        try {
          const backgroundMedia = await this.resolveMediaUpload({
            payload: {
              ...payload,
              generatedAssetType: "image",
            },
            keepOriginal: true,
            promptFallbacks: [visualBackgroundPrompt],
            command,
            skipPromptCuration: true,
          });
          const imageTextItem: Record<string, unknown> = {
            mediaUrl: backgroundMedia.mediaUrl,
            ...(backgroundMedia.mediaOriginalUrl
              ? { mediaOriginalUrl: backgroundMedia.mediaOriginalUrl }
              : {}),
            ...(backgroundMedia.mediaOptimizedUrl
              ? { mediaOptimizedUrl: backgroundMedia.mediaOptimizedUrl }
              : {}),
            ...(backgroundMedia.mediaContentHash
              ? { mediaContentHash: backgroundMedia.mediaContentHash }
              : {}),
            ...(backgroundMedia.mediaIpfsCid
              ? { mediaIpfsCid: backgroundMedia.mediaIpfsCid }
              : {}),
            ...(typeof backgroundMedia.mediaSizeBytes === "number"
              ? { mediaSizeBytes: backgroundMedia.mediaSizeBytes }
              : {}),
            ...(backgroundMedia.mediaType
              ? { mediaType: backgroundMedia.mediaType }
              : {}),
            caption: textBodyForWrite,
            ...(captionPositionForWrite
              ? { captionPosition: captionPositionForWrite }
              : {}),
          };
          const imageTextMutation = await this.executeCreatePostMutationWithIdempotency({
            command,
            postType: "media",
            postKind,
            mutationInput: {
              ...buildBase(captionForWrite, "media"),
              mediaUrl: backgroundMedia.mediaUrl,
              ...(backgroundMedia.mediaOriginalUrl
                ? { mediaOriginalUrl: backgroundMedia.mediaOriginalUrl }
                : {}),
              ...(backgroundMedia.mediaOptimizedUrl
                ? { mediaOptimizedUrl: backgroundMedia.mediaOptimizedUrl }
                : {}),
              ...(backgroundMedia.mediaContentHash
                ? { mediaContentHash: backgroundMedia.mediaContentHash }
                : {}),
              ...(backgroundMedia.mediaIpfsCid
                ? { mediaIpfsCid: backgroundMedia.mediaIpfsCid }
                : {}),
              ...(typeof backgroundMedia.mediaSizeBytes === "number" &&
              Number.isFinite(backgroundMedia.mediaSizeBytes)
                ? {
                    mediaSizeBytes: Math.max(
                      1,
                      Math.floor(backgroundMedia.mediaSizeBytes),
                    ),
                  }
                : {}),
              ...(backgroundMedia.mediaType
                ? { mediaType: backgroundMedia.mediaType }
                : {}),
              mediaItems: [imageTextItem],
              ...(captionPositionForWrite
                ? { captionPosition: captionPositionForWrite }
                : {}),
            },
          });
          if (imageTextMutation.skipped) {
            return skippedPostOutcome(imageTextMutation.reason);
          }
          const imageTextResult = imageTextMutation.result;
          this.notePublishedPostForNoveltyHistory({
            postType: "media",
            caption: captionForWrite,
            textBody: null,
            mediaPrompt: visualBackgroundPrompt,
            commandId: command.id,
            targetPostId: postDraftContext.targetPostId,
          });
          this.notePublishedPostVarietyMode({
            commandId: command.id,
            postType: "media",
            targetPostId: postDraftContext.targetPostId,
            mode: postVariety.mode,
            signal: postVariety.signal,
          });
          await this.ctx.memory
            .recordWrite({
              type: "runtime_post_publish_recorded",
              at: nowIso(),
              commandId: command.id,
              kind: postKind,
              postType: "media",
              varietyMode: postVariety.mode,
              targetPostId: postDraftContext.targetPostId,
              bodyPreview: truncateText(candidate, 260),
              visualRenderMode:
                visualPlan?.backgroundImagePrompt !== null &&
                visualPlan?.backgroundImagePrompt !== undefined
                  ? "image_text"
                  : "autonomous_image_text",
              textStyleTheme: autonomousTheme,
            })
            .catch(() => undefined);
          return this.successOutcome(command, imageTextResult);
        } catch (error: unknown) {
          await this.ctx.memory
            .recordWrite({
              type: "text_post_visual_background_failed",
              at: nowIso(),
              commandId: command.id,
              error: error instanceof Error ? error.message : String(error),
            })
            .catch(() => undefined);
        }
      }

      const textMutation = await this.executeCreatePostMutationWithIdempotency({
        command,
        postType: "text",
        postKind,
        mutationInput: {
          ...buildBase(captionForWrite, "text"),
          textBody: textBodyForWrite,
          textStyle: normalizedTextStyle,
          ...(captionPositionForWrite ? { captionPosition: captionPositionForWrite } : {}),
        },
      });
      if (textMutation.skipped) {
        return skippedPostOutcome(textMutation.reason);
      }
      const result = textMutation.result;
      this.notePublishedPostForNoveltyHistory({
        postType: "text",
        caption: captionForWrite,
        textBody: textBodyForWrite,
        mediaPrompt: null,
        commandId: command.id,
        targetPostId: postDraftContext.targetPostId,
      });
      this.notePublishedPostVarietyMode({
        commandId: command.id,
        postType: "text",
        targetPostId: postDraftContext.targetPostId,
        mode: postVariety.mode,
        signal: postVariety.signal,
      });
      await this.ctx.memory
        .recordWrite({
          type: "runtime_post_publish_recorded",
          at: nowIso(),
          commandId: command.id,
          kind: postKind,
          postType,
          varietyMode: postVariety.mode,
          targetPostId: postDraftContext.targetPostId,
          bodyPreview: truncateText(candidate, 260),
          visualRenderMode: shouldAttemptSlides
            ? shouldAttemptImageBackground
              ? "text_after_slides_and_image_fallback"
              : "text_after_slides_fallback"
            : shouldAttemptImageBackground
              ? "text_after_image_background_fallback"
              : "text",
          textStyleTheme: asNonEmptyString(normalizedTextStyle.theme),
          captionPosition: captionPositionForWrite,
        })
        .catch(() => undefined);
      return this.successOutcome(command, result);
    }

    const captionInitial = asNonEmptyString(payload.caption);
    const mediaPromptInitial =
      asNonEmptyString(payload.mediaPrompt) ??
      asNonEmptyString(payload.imagePrompt) ??
      asNonEmptyString(payload.prompt);
    const noveltyAvoidReferences = this.snapshotRecentPostNoveltyReferences("media");
    const curatedMediaDraft = await this.curatePostDraftWithOpenClaw({
      commandId: command.id,
      postType: "media",
      varietyMode: postVariety.mode,
      caption: captionInitial,
      textBody: null,
      mediaPrompt: mediaPromptInitial,
      context: postDraftContext,
      seedHints: directiveSeedHints,
      avoidReferences: noveltyAvoidReferences,
    });
    if (requiresCuration && !curatedMediaDraft) {
      throw new RequeueCommandError(
        "post_curation_waiting_for_openclaw:media_curation_unavailable",
      );
    }
    let captionForWrite = curatedMediaDraft?.caption ?? captionInitial;
    let mediaPromptForWrite = curatedMediaDraft?.mediaPrompt ?? mediaPromptInitial;
    captionForWrite = captionForWrite ? stripEmDashCharacters(captionForWrite) : captionForWrite;
    mediaPromptForWrite = mediaPromptForWrite
      ? stripEmDashCharacters(mediaPromptForWrite)
      : mediaPromptForWrite;
    let noveltyValidation = this.validatePostDraftNovelty({
      postType: "media",
      caption: captionForWrite,
      textBody: null,
      mediaPrompt: mediaPromptForWrite,
      context: postDraftContext,
      seedHints: directiveSeedHints,
    });
    if (!noveltyValidation.ok) {
      await this.ctx.memory
        .recordWrite({
          type: "post_novelty_rejected",
          at: nowIso(),
          commandId: command.id,
          postType: "media",
          reason: noveltyValidation.reason,
          candidatePreview: truncateText(noveltyValidation.candidateText, 240),
          referencePreview: noveltyValidation.referencePreview,
        })
        .catch(() => undefined);
      if (directiveSinglePromptMode) {
        await this.ctx.memory
          .recordWrite({
            type: "post_novelty_recuration_skipped",
            at: nowIso(),
            commandId: command.id,
            postType: "media",
            reason: noveltyValidation.reason,
            policy: "single_prompt_per_directive",
          })
          .catch(() => undefined);
        noveltyValidation = {
          ok: true,
          candidateText: this.buildPostNoveltyCandidateText({
            postType: "media",
            caption: captionForWrite,
            textBody: null,
            mediaPrompt: mediaPromptForWrite,
          }),
        };
      } else {
        const recurationReferences = Array.from(
          new Set<string>(
            [
              ...noveltyAvoidReferences,
              noveltyValidation.referencePreview ?? "",
              truncateText(noveltyValidation.candidateText, 260),
            ]
              .map((value) => value.trim())
              .filter((value) => value.length > 0),
          ),
        );
        const recuratedMediaDraft = await this.curatePostDraftWithOpenClaw({
          commandId: command.id,
          postType: "media",
          varietyMode: postVariety.mode,
          caption: captionForWrite,
          textBody: null,
          mediaPrompt: mediaPromptForWrite,
          context: postDraftContext,
          seedHints: directiveSeedHints,
          avoidReferences: recurationReferences,
        });
        if (!recuratedMediaDraft) {
          if (requiresCuration) {
            throw new RequeueCommandError(
              "post_curation_waiting_for_openclaw:media_novelty_recuration_unavailable",
            );
          }
          return this.failedOutcome(
            command,
            `Blocked media post draft due to low novelty (${noveltyValidation.reason}).`,
            "post_novelty_rejected",
          );
        }
        captionForWrite = recuratedMediaDraft.caption ?? captionForWrite;
        mediaPromptForWrite = recuratedMediaDraft.mediaPrompt ?? mediaPromptForWrite;
        captionForWrite = captionForWrite ? stripEmDashCharacters(captionForWrite) : captionForWrite;
        mediaPromptForWrite = mediaPromptForWrite
          ? stripEmDashCharacters(mediaPromptForWrite)
          : mediaPromptForWrite;
        noveltyValidation = this.validatePostDraftNovelty({
          postType: "media",
          caption: captionForWrite,
          textBody: null,
          mediaPrompt: mediaPromptForWrite,
          context: postDraftContext,
          seedHints: directiveSeedHints,
        });
        if (!noveltyValidation.ok) {
          await this.ctx.memory
            .recordWrite({
              type: "post_novelty_blocked",
              at: nowIso(),
              commandId: command.id,
              postType: "media",
              reason: noveltyValidation.reason,
              candidatePreview: truncateText(noveltyValidation.candidateText, 240),
              referencePreview: noveltyValidation.referencePreview,
            })
            .catch(() => undefined);
          return this.failedOutcome(
            command,
            `Blocked media post draft due to low novelty (${noveltyValidation.reason}).`,
            "post_novelty_blocked",
          );
        }
        await this.ctx.memory
          .recordWrite({
            type: "post_novelty_recurated",
            at: nowIso(),
            commandId: command.id,
            postType: "media",
          })
          .catch(() => undefined);
      }
    }
    const mediaCandidate = noveltyValidation.candidateText;
    const mediaSeedText = mediaPromptForWrite ?? captionForWrite ?? mediaCandidate;
    const personaReferencePlan = this.resolvePersonaReferencePlan(payload, null, command);
    const personaDrivenMediaGeneration = this.shouldUsePersonaFrameReferences(personaReferencePlan);
    if (explicitSaveAsProfileMemory === null && personaDrivenMediaGeneration) {
      saveAsProfileMemoryForMedia = true;
    }
    const carriedMediaPresent =
      asNonEmptyString(payload.mediaUrl) !== null ||
      (Array.isArray(payload.mediaItems) && payload.mediaItems.length > 0) ||
      isRecord(payload.recentGeneratedAsset);
    const mediaGenerationPayloadBase: Record<string, unknown> = {
      ...payload,
    };
    if (personaDrivenMediaGeneration && carriedMediaPresent) {
      delete mediaGenerationPayloadBase.mediaUrl;
      delete mediaGenerationPayloadBase.mediaOriginalUrl;
      delete mediaGenerationPayloadBase.mediaOptimizedUrl;
      delete mediaGenerationPayloadBase.mediaContentHash;
      delete mediaGenerationPayloadBase.mediaIpfsCid;
      delete mediaGenerationPayloadBase.mediaSizeBytes;
      delete mediaGenerationPayloadBase.mediaType;
      delete mediaGenerationPayloadBase.mediaItems;
      delete mediaGenerationPayloadBase.recentGeneratedAsset;
      await this.ctx.memory
        .recordWrite({
          type: "media_post_persona_carryover_stripped",
          at: nowIso(),
          commandId: command.id,
          commandKind: command.kind,
          sourceDirectiveId,
          personaSlug: personaReferencePlan.targetPersonaSlug,
        })
        .catch(() => undefined);
    }
    const autonomousMediaTheme = this.resolveAutonomousTextTheme({
      commandId: command.id,
      postKind,
      caption: captionForWrite,
      textBody: mediaSeedText,
    });
    const captionPositionForWrite =
      this.normalizeCaptionPositionValue(payload.captionPosition) ??
      this.resolveAutonomousCaptionPosition({
        commandId: command.id,
        postKind,
        seedText: `${captionForWrite ?? ""} ${mediaSeedText}`,
      });
    const autonomousMediaSlides = this.buildAutonomousMediaSlides({
      commandId: command.id,
      postKind,
      caption: captionForWrite,
      mediaPrompt: mediaSeedText,
      theme: autonomousMediaTheme,
    });
    const explicitMultiMediaRequested = this.isExplicitMultiMediaRequest(payload);
    const shouldAttemptMediaSlides =
      explicitMultiMediaRequested && autonomousMediaSlides.length >= 2;
    if (!shouldAttemptMediaSlides && autonomousMediaSlides.length >= 2) {
      await this.ctx.memory
        .recordWrite({
          type: "media_post_slides_suppressed",
          at: nowIso(),
          commandId: command.id,
          sourceDirectiveId,
          reason: explicitMultiMediaRequested
            ? "insufficient_slide_candidates"
            : "single_prompt_policy",
        })
        .catch(() => undefined);
    }
    if (shouldAttemptMediaSlides) {
      const slideItems: Array<Record<string, unknown>> = [];
      const slidePrompts = autonomousMediaSlides.slice(0, 4);
      for (let index = 0; index < slidePrompts.length; index += 1) {
        const slide = slidePrompts[index];
        if (!slide) continue;
        const slidePrompt = stripEmDashCharacters(slide.imagePrompt).trim();
        if (slidePrompt.length < 8) continue;
        try {
          const slideMedia = await this.resolveMediaUpload({
            payload: {
              ...mediaGenerationPayloadBase,
              generatedAssetType: "image",
            },
            keepOriginal: true,
            promptFallbacks: [
              slidePrompt,
              mediaPromptForWrite,
              asNonEmptyString(payload.prompt),
            ],
            command,
            skipPromptCuration: true,
          });
          slideItems.push({
            mediaUrl: slideMedia.mediaUrl,
            ...(slideMedia.mediaOriginalUrl
              ? { mediaOriginalUrl: slideMedia.mediaOriginalUrl }
              : {}),
            ...(slideMedia.mediaOptimizedUrl
              ? { mediaOptimizedUrl: slideMedia.mediaOptimizedUrl }
              : {}),
            ...(slideMedia.mediaContentHash
              ? { mediaContentHash: slideMedia.mediaContentHash }
              : {}),
            ...(slideMedia.mediaIpfsCid
              ? { mediaIpfsCid: slideMedia.mediaIpfsCid }
              : {}),
            ...(typeof slideMedia.mediaSizeBytes === "number"
              ? { mediaSizeBytes: slideMedia.mediaSizeBytes }
              : {}),
            ...(slideMedia.mediaType ? { mediaType: slideMedia.mediaType } : {}),
            ...(slide.caption
              ? { caption: slide.caption }
              : captionForWrite
                ? { caption: captionForWrite }
                : {}),
            ...(captionPositionForWrite
              ? { captionPosition: captionPositionForWrite }
              : {}),
          });
        } catch (error: unknown) {
          await this.ctx.memory
            .recordWrite({
              type: "media_post_slide_generation_failed",
              at: nowIso(),
              commandId: command.id,
              slideIndex: index,
              error: error instanceof Error ? error.message : String(error),
            })
            .catch(() => undefined);
        }
      }
      if (slideItems.length >= 2) {
        const firstSlide = slideItems[0] ?? {};
        const firstSlideMediaUrl = asNonEmptyString(firstSlide.mediaUrl);
        if (firstSlideMediaUrl) {
          const slideMutation = await this.executeCreatePostMutationWithIdempotency({
            command,
            postType: "media",
            postKind,
            mutationInput: {
              ...buildBase(captionForWrite, "media"),
              mediaUrl: firstSlideMediaUrl,
              ...(asNonEmptyString(firstSlide.mediaOriginalUrl)
                ? { mediaOriginalUrl: asNonEmptyString(firstSlide.mediaOriginalUrl) }
                : {}),
              ...(asNonEmptyString(firstSlide.mediaOptimizedUrl)
                ? { mediaOptimizedUrl: asNonEmptyString(firstSlide.mediaOptimizedUrl) }
                : {}),
              ...(asNonEmptyString(firstSlide.mediaContentHash)
                ? { mediaContentHash: asNonEmptyString(firstSlide.mediaContentHash) }
                : {}),
              ...(asNonEmptyString(firstSlide.mediaIpfsCid)
                ? { mediaIpfsCid: asNonEmptyString(firstSlide.mediaIpfsCid) }
                : {}),
              ...(typeof firstSlide.mediaSizeBytes === "number" &&
              Number.isFinite(firstSlide.mediaSizeBytes)
                ? {
                    mediaSizeBytes: Math.max(
                      1,
                      Math.floor(firstSlide.mediaSizeBytes),
                    ),
                  }
                : {}),
              ...(asNonEmptyString(firstSlide.mediaType)
                ? { mediaType: asNonEmptyString(firstSlide.mediaType) }
                : {}),
              mediaItems: slideItems,
              ...(captionPositionForWrite
                ? { captionPosition: captionPositionForWrite }
                : {}),
            },
          });
          if (slideMutation.skipped) {
            return skippedPostOutcome(slideMutation.reason);
          }
          const slideResult = slideMutation.result;
          this.notePublishedPostForNoveltyHistory({
            postType: "media",
            caption: captionForWrite,
            textBody: null,
            mediaPrompt: slidePrompts.map((entry) => entry.imagePrompt).join(" | "),
            commandId: command.id,
            targetPostId: postDraftContext.targetPostId,
          });
          this.notePublishedPostVarietyMode({
            commandId: command.id,
            postType: "media",
            targetPostId: postDraftContext.targetPostId,
            mode: postVariety.mode,
            signal: postVariety.signal,
          });
          await this.ctx.memory
            .recordWrite({
              type: "runtime_post_publish_recorded",
              at: nowIso(),
              commandId: command.id,
              kind: postKind,
              postType: "media",
              varietyMode: postVariety.mode,
              targetPostId: postDraftContext.targetPostId,
              bodyPreview: truncateText(mediaCandidate, 260),
              visualRenderMode: "media_slides",
              slideCount: slideItems.length,
              captionPosition: captionPositionForWrite,
              textStyleTheme: autonomousMediaTheme,
            })
            .catch(() => undefined);
          return this.successOutcome(command, slideResult);
        }
      }
      await this.ctx.memory
        .recordWrite({
          type: "media_post_slides_fallback",
          at: nowIso(),
          commandId: command.id,
          slideCountRequested: slidePrompts.length,
          slideCountResolved: slideItems.length,
        })
        .catch(() => undefined);
    }
    const payloadForMedia: Record<string, unknown> = {
      ...mediaGenerationPayloadBase,
      ...(captionForWrite ? { caption: captionForWrite } : {}),
      ...(mediaPromptForWrite
        ? {
            mediaPrompt: mediaPromptForWrite,
            imagePrompt: mediaPromptForWrite,
            prompt: mediaPromptForWrite,
          }
        : {}),
    };
    const media = await this.resolveMediaUpload({
      payload: payloadForMedia,
      keepOriginal: true,
      promptFallbacks: [
        mediaPromptForWrite,
        asNonEmptyString(payload.prompt),
      ],
      command,
      skipPromptCuration: true,
    });
    const mediaMutation = await this.executeCreatePostMutationWithIdempotency({
      command,
      postType: "media",
      postKind,
      mutationInput: {
        ...buildBase(captionForWrite),
        mediaUrl: media.mediaUrl,
        ...(media.mediaOriginalUrl ? { mediaOriginalUrl: media.mediaOriginalUrl } : {}),
        ...(media.mediaOptimizedUrl ? { mediaOptimizedUrl: media.mediaOptimizedUrl } : {}),
        ...(media.mediaContentHash ? { mediaContentHash: media.mediaContentHash } : {}),
        ...(media.mediaIpfsCid ? { mediaIpfsCid: media.mediaIpfsCid } : {}),
        ...(typeof media.mediaSizeBytes === "number" ? { mediaSizeBytes: media.mediaSizeBytes } : {}),
        ...(media.mediaType ? { mediaType: media.mediaType } : {}),
        ...(captionPositionForWrite ? { captionPosition: captionPositionForWrite } : {}),
      },
    });
    if (mediaMutation.skipped) {
      return skippedPostOutcome(mediaMutation.reason);
    }
    const result = mediaMutation.result;
    this.notePublishedPostForNoveltyHistory({
      postType: "media",
      caption: captionForWrite,
      textBody: null,
      mediaPrompt: mediaPromptForWrite,
      commandId: command.id,
      targetPostId: postDraftContext.targetPostId,
    });
    this.notePublishedPostVarietyMode({
      commandId: command.id,
      postType: "media",
      targetPostId: postDraftContext.targetPostId,
      mode: postVariety.mode,
      signal: postVariety.signal,
    });
    await this.ctx.memory
      .recordWrite({
        type: "runtime_post_publish_recorded",
        at: nowIso(),
        commandId: command.id,
        kind: postKind,
        postType,
        varietyMode: postVariety.mode,
        targetPostId: postDraftContext.targetPostId,
        bodyPreview: truncateText(mediaCandidate, 260),
        mediaUrl: media.mediaUrl,
      })
      .catch(() => undefined);
    return this.successOutcome(command, result);
  }

  private extractTargetPostIdForPostDraft(payload: Record<string, unknown>): number | null {
    return _extractTargetPostId(payload);
  }

  private async loadPostDraftContext(input: {
    postId: number | null;
    payload: Record<string, unknown>;
  }): Promise<PostDraftContext> {
    return _loadPostDraftContext(
      {
        callAgentChatBridge: this.ctx.callAgentChatBridge ?? null,
        memory: this.ctx.memory,
        bridgeLookupCache: this.bridgeLookupCache,
      },
      input,
    );
  }

  private async loadPostDraftMemorySummary(input: {
    postId: number | null;
    payload: Record<string, unknown>;
  }): Promise<string | null> {
    return _loadDraftMemory(
      { memory: this.ctx.memory },
      input,
      (payload) => this.extractCommentPayloadHint(payload),
    );
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

  private buildPostNoveltyCandidateText(input: { postType: "text" | "media"; caption: string | null; textBody: string | null; mediaPrompt: string | null }): string {
    return _buildNoveltyText(input);
  }

  private pruneRecentPostNoveltyHistory(nowMs: number): void {
    _pruneNoveltyHistory(this.recentPostNoveltyHistory, nowMs);
  }

  private snapshotRecentPostNoveltyReferences(postType: "text" | "media"): string[] {
    return _snapshotNoveltyRefs(this.recentPostNoveltyHistory, postType);
  }

  private computeBidirectionalTokenOverlap(first: string, second: string): number {
    return _computeOverlap(first, second);
  }

  private validatePostDraftNovelty(input: {
    postType: "text" | "media";
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
    context: PostDraftContext;
    seedHints: string[];
  }):
    | { ok: true; candidateText: string }
    | { ok: false; reason: string; candidateText: string; referencePreview: string | null } {
    return _validateNovelty(this.recentPostNoveltyHistory, input);
  }

  private notePublishedPostForNoveltyHistory(input: {
    postType: "text" | "media";
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
    commandId: string;
    targetPostId: number | null;
  }): void {
    _noteNoveltyHistory(this.recentPostNoveltyHistory, input);
  }

  private parsePostVarietyMode(value: unknown): PostVarietyMode | null {
    return _parseVarietyMode(value);
  }

  private pruneRecentPostVarietyModeHistory(nowMs: number): void {
    _pruneVarietyHistory(this.recentPostVarietyModeHistory, nowMs);
  }

  private listRecentPostVarietyModes(maxItems: number): PostVarietyMode[] {
    return _listVarietyModes(this.recentPostVarietyModeHistory, maxItems);
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
    _noteVarietyMode(this.recentPostVarietyModeHistory, input);
    void this.ctx.memory
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

  private normalizeCaptionPositionValue(value: unknown): string | null {
    return _normalizeCaptionPos(value);
  }

  private sanitizeTextStyleValue(value: unknown): Record<string, unknown> | null {
    return _sanitizeTextStyle(value);
  }

  private pickDeterministicIndex(seed: string, modulo: number): number {
    return _pickDeterministic(seed, modulo);
  }

  private resolveAutonomousTextTheme(input: { commandId: string; postKind: "post" | "thread"; caption: string | null; textBody: string }): TextStyleTheme {
    return _resolveTextTheme(input);
  }

  private resolveAutonomousGradientBackground(theme: TextStyleTheme, seed: string): string {
    return _resolveGradientBg(theme, seed);
  }

  private resolveAutonomousPaletteHint(theme: TextStyleTheme, seed: string): string {
    return _resolvePaletteHint(theme, seed);
  }

  private resolveAutonomousCameraHint(seed: string): string {
    return _resolveCameraHint(seed);
  }

  private resolveAutonomousCaptionPosition(input: { commandId: string; postKind: "post" | "thread"; seedText: string }): string {
    return _resolveCaptionPos(input);
  }

  private buildAutonomousVisualPrompt(input: { basePrompt: string; caption: string | null; commandId: string; theme: TextStyleTheme; mode: "slide" | "story" | "background"; index: number }): string {
    return _buildVisualPrompt(input);
  }

  private buildAutonomousThreadSlides(input: { commandId: string; caption: string | null; textBody: string; theme: TextStyleTheme; postKind: "post" | "thread" }): TextPostVisualSlide[] {
    return _buildThreadSlides(input);
  }

  private buildAutonomousTextBackgroundPrompt(input: { commandId: string; caption: string | null; textBody: string; theme: TextStyleTheme; postKind: "post" | "thread" }): string | null {
    return _buildTextBgPrompt(input);
  }

  private buildAutonomousMediaSlides(input: { commandId: string; postKind: "post" | "thread"; caption: string | null; mediaPrompt: string; theme: TextStyleTheme }): TextPostVisualSlide[] {
    return _buildMediaSlides(input);
  }

  private normalizeAgentTextStyle(style: Record<string, unknown> | null, captionPosition: string | null, fallbackStyle?: Record<string, unknown> | null): Record<string, unknown> {
    return _normalizeTextStyle(style, captionPosition, fallbackStyle);
  }

  private extractTextPostVisualPlanFromUnknown(value: unknown): TextPostVisualPlan | null {
    return _extractVisualPlan(value);
  }

  private buildTextPostVisualPlanPrompt(input: { postKind: "post" | "thread"; caption: string | null; textBody: string; context: PostDraftContext }): string {
    return _buildVisualPlanPrompt(input);
  }

  private async planTextPostVisualWithOpenClaw(input: {
    commandId: string;
    postKind: "post" | "thread";
    caption: string | null;
    textBody: string;
    context: PostDraftContext;
  }): Promise<TextPostVisualPlan | null> {
    return _planVisualWithOC(
      { runOpenClawPrompt: this.ctx.runOpenClawPrompt ?? null, memory: this.ctx.memory },
      input,
    );
  }

  private buildPostVarietyModeRules(mode: PostVarietyMode, postType: "text" | "media"): string[] {
    return _buildVarietyRules(mode, postType);
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

  private extractCuratedPostDraftFromUnknown(
    value: unknown,
    postType: "text" | "media",
  ): { caption: string | null; textBody: string | null; mediaPrompt: string | null } | null {
    return _extractCuratedDraft(value, postType);
  }

  private async curatePostDraftWithOpenClaw(input: {
    commandId: string;
    postType: "text" | "media";
    varietyMode: PostVarietyMode;
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
    context: PostDraftContext;
    seedHints: string[];
    avoidReferences: string[];
  }): Promise<CuratedPostDraft | null> {
    return _curateDraftWithOC(
      {
        runOpenClawPrompt: this.ctx.runOpenClawPrompt ?? null,
        memory: this.ctx.memory,
        curatedPostDraftCache: this.curatedPostDraftCache,
        curatedMediaPromptCache: this.curatedMediaPromptCache,
      },
      input,
    );
  }

  private collectDirectiveSeedHints(payload: Record<string, unknown>): string[] {
    return _collectSeedHints(payload);
  }

  private buildChatLiteralFallbackPayloadFromStory(input: {
    payload: Record<string, unknown>;
    fallbackPrompt?: string | null;
  }): Record<string, unknown> {
    return _buildStoryFallback(input);
  }

  private async executeWriteCreateStory(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for write.createStory.");
    }
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command,
      payload,
    });
    if (this.isChatOriginCommand(command, payload)) {
      const explicitStoryRequest = this.didChatMessageExplicitlyRequestStory(payload);
      if (!explicitStoryRequest) {
        await this.ctx.memory
          .recordWrite({
            type: "story_write_redirected_chat_request",
            at: nowIso(),
            commandId: command.id,
            commandKind: command.kind,
            sourceDirectiveId,
          })
          .catch(() => undefined);
        const fallbackPayload = this.buildChatLiteralFallbackPayloadFromStory({
          payload,
        });
        return this.executeChatLiteralGenerate(command, fallbackPayload);
      }
      await this.ctx.memory
          .recordWrite({
            type: "story_write_blocked_chat_request",
            at: nowIso(),
            commandId: command.id,
            commandKind: command.kind,
            sourceDirectiveId,
          })
          .catch(() => undefined);
      return this.failedOutcome(
        command,
        "Story creation is directive-only. Chat requests can create posts, but not stories.",
        "story_chat_disabled",
      );
    }
    const provenance = normalizeAgentProvenanceValue(payload.provenance);
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;
    const explicitSaveAsProfileMemory =
      typeof payload.saveAsProfileMemory === "boolean"
        ? payload.saveAsProfileMemory
        : null;
    const caption = asNonEmptyString(payload.caption);
    const baseStoryPrompt =
      asNonEmptyString(payload.mediaPrompt) ??
      asNonEmptyString(payload.imagePrompt) ??
      asNonEmptyString(payload.prompt) ??
      asNonEmptyString(payload.topic) ??
      caption ??
      "a candid original day-in-the-life moment";
    const autonomousTheme = this.resolveAutonomousTextTheme({
      commandId: command.id,
      postKind: "post",
      caption,
      textBody: baseStoryPrompt,
    });
    const autonomousStoryPrompt = this.buildAutonomousVisualPrompt({
      basePrompt: baseStoryPrompt,
      caption,
      commandId: command.id,
      theme: autonomousTheme,
      mode: "story",
      index: 0,
    });
    const captionPositionForWrite =
      this.normalizeCaptionPositionValue(payload.captionPosition) ??
      this.resolveAutonomousCaptionPosition({
        commandId: command.id,
        postKind: "post",
        seedText: `${caption ?? ""} ${baseStoryPrompt ?? ""}`,
      });
    const storyPayload: Record<string, unknown> = {
      ...payload,
    };
    const personaReferencePlan = this.resolvePersonaReferencePlan(
      payload,
      null,
      command,
    );
    const personaDrivenStoryGeneration =
      this.shouldUsePersonaFrameReferences(personaReferencePlan);
    const saveAsProfileMemory =
      explicitSaveAsProfileMemory ?? personaDrivenStoryGeneration;
    const carriedMediaPresent =
      asNonEmptyString(payload.mediaUrl) !== null ||
      (Array.isArray(payload.mediaItems) && payload.mediaItems.length > 0) ||
      isRecord(payload.recentGeneratedAsset);
    delete storyPayload.mediaUrl;
    delete storyPayload.mediaOriginalUrl;
    delete storyPayload.mediaOptimizedUrl;
    delete storyPayload.mediaContentHash;
    delete storyPayload.mediaIpfsCid;
    delete storyPayload.mediaSizeBytes;
    delete storyPayload.mediaType;
    delete storyPayload.mediaItems;
    delete storyPayload.recentGeneratedAsset;
    if (carriedMediaPresent) {
      await this.ctx.memory
        .recordWrite({
          type: "story_media_carryover_stripped",
          at: nowIso(),
          commandId: command.id,
          commandKind: command.kind,
          sourceDirectiveId,
        })
        .catch(() => undefined);
    }

    const media = await this.resolveMediaUpload({
      payload: storyPayload,
      keepOriginal: false,
      promptFallbacks: [
        autonomousStoryPrompt,
        asNonEmptyString(payload.mediaPrompt),
        asNonEmptyString(payload.imagePrompt),
        asNonEmptyString(payload.prompt),
      ],
      command,
    });

    const result = await this.agent().createStory.mutate({
      mediaUrl: media.mediaUrl,
      ...(media.mediaOriginalUrl ? { originalUrl: media.mediaOriginalUrl } : {}),
      ...(media.mediaOptimizedUrl ? { optimizedUrl: media.mediaOptimizedUrl } : {}),
      ...(media.mediaContentHash ? { contentHash: media.mediaContentHash } : {}),
      ...(media.mediaIpfsCid ? { ipfsCid: media.mediaIpfsCid } : {}),
      ...(media.mediaType ? { mediaType: media.mediaType } : {}),
      ...(caption ? { caption } : {}),
      ...(saveAsProfileMemory ? { saveAsProfileMemory: true } : {}),
      ...(captionPositionForWrite ? { captionPosition: captionPositionForWrite } : {}),
      ...(asNonEmptyString(payload.mediaFit) ? { mediaFit: asNonEmptyString(payload.mediaFit) } : {}),
      ...(asPositiveInt(payload.expiresInSeconds)
        ? { expiresInSeconds: asPositiveInt(payload.expiresInSeconds) }
        : {}),
      ...(provenance ? { provenance } : {}),
      ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
      ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
      ...(command.grantId ? { grantId: command.grantId } : {}),
    });
    return this.successOutcome(command, result);
  }

  private async executeWriteUpdateAvatar(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for write.updateAvatar.");
    }
    const target = this.resolveProfileWriteTarget(asNonEmptyString(payload.target));
    const provenance = normalizeAgentProvenanceValue(payload.provenance);
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command,
      payload,
    });
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;

    const media = await this.resolveMediaUpload({
      payload,
      keepOriginal: false,
      promptFallbacks: [
        asNonEmptyString(payload.mediaPrompt),
        asNonEmptyString(payload.imagePrompt),
        asNonEmptyString(payload.prompt),
      ],
      command,
    });
    const result = await this.updateAvatar({
      target,
      imageUrl: media.mediaUrl,
      ...(media.mediaOriginalUrl ? { originalUrl: media.mediaOriginalUrl } : {}),
      ...(media.mediaOptimizedUrl ? { optimizedUrl: media.mediaOptimizedUrl } : {}),
      ...(media.mediaContentHash ? { contentHash: media.mediaContentHash } : {}),
      ...(media.mediaIpfsCid ? { ipfsCid: media.mediaIpfsCid } : {}),
      ...(typeof media.mediaSizeBytes === "number" ? { sizeBytes: media.mediaSizeBytes } : {}),
      ...(provenance ? { provenance } : {}),
      ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
      ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
    });
    return this.successOutcome(command, result);
  }

  private async executeWriteUpdateBanner(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for write.updateBanner.");
    }
    const target = this.resolveProfileWriteTarget(asNonEmptyString(payload.target));
    const provenance = normalizeAgentProvenanceValue(payload.provenance);
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command,
      payload,
    });
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;

    const media = await this.resolveMediaUpload({
      payload,
      keepOriginal: false,
      promptFallbacks: [
        asNonEmptyString(payload.mediaPrompt),
        asNonEmptyString(payload.imagePrompt),
        asNonEmptyString(payload.prompt),
      ],
      command,
    });
    const result = await this.updateBanner({
      target,
      bannerUrl: media.mediaUrl,
      ...(media.mediaOriginalUrl ? { originalUrl: media.mediaOriginalUrl } : {}),
      ...(media.mediaOptimizedUrl ? { optimizedUrl: media.mediaOptimizedUrl } : {}),
      ...(media.mediaContentHash ? { contentHash: media.mediaContentHash } : {}),
      ...(media.mediaIpfsCid ? { ipfsCid: media.mediaIpfsCid } : {}),
      ...(typeof media.mediaSizeBytes === "number" ? { sizeBytes: media.mediaSizeBytes } : {}),
      ...(provenance ? { provenance } : {}),
      ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
      ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
    });
    return this.successOutcome(command, result);
  }

  private async executeWriteComment(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for write.commentPost.");
    }
    const body =
      asNonEmptyString(payload.body) ??
      asNonEmptyString(payload.requestText) ??
      asNonEmptyString(payload.prompt) ??
      "Write a concise, relevant reply to the target post.";
    let resolvedTarget: EngagementTargetCandidate | null = null;
    try {
      resolvedTarget =
        (await this.resolveEngagementTargetForDirective({
          payload,
          action: "comment",
          commandId: command.id,
        })) ?? null;
    } catch (error: unknown) {
      if (this.isNoTargetDiscoveryFailure(error)) {
        return this.failedOutcome(
          command,
          "No target post/comment candidates found after discovery scan.",
          "no_target_candidates",
        );
      }
      throw error;
    }
    if (!resolvedTarget) {
      throw new RequeueCommandError("comment_target_resolution_waiting_for_context:no_target");
    }
    const postId = resolvedTarget.postId;
    const parentId =
      asPositiveInt(payload.parentId) ??
      asPositiveInt(payload.commentId) ??
      asPositiveInt(payload.targetCommentId) ??
      resolvedTarget.commentId ??
      null;
    payload.postId = postId;
    payload.targetPostId = postId;
    if (parentId) {
      payload.parentId = parentId;
      payload.commentId = parentId;
      payload.targetCommentId = parentId;
    }
    if (resolvedTarget.postSnapshotHash) {
      payload.targetPostSnapshotHash = resolvedTarget.postSnapshotHash;
      payload.postSnapshotHash = resolvedTarget.postSnapshotHash;
    }
    const expectedTarget = {
      postId,
      commentId: parentId ?? null,
      targetHash: buildTargetHash({
        postId,
        commentId: parentId ?? null,
      }),
    };
    const lockMatch = isTargetLockMatch({
      payload,
      expected: expectedTarget,
    });
    if (!lockMatch.ok) {
      return this.failedOutcome(
        command,
        `Target lock mismatch: ${lockMatch.reason}.`,
        "target_lock_mismatch",
      );
    }
    const target = applyTargetLock(payload, {
      postId,
      commentId: parentId ?? null,
    });
    const idempotencyKey = this.buildActionIdempotencyKey({
      command,
      action: "comment",
      postId: target.postId,
      commentId: target.commentId,
      commentBody: body,
    });
    const dedupe = this.beginActionLifecycle({
      command,
      action: "comment",
      idempotencyKey,
      target,
      state: "context_ready",
    });
    if (!dedupe.allowed) {
      if (dedupe.requeue) {
        throw new RequeueCommandError(
          `comment_waiting_for_backoff:${dedupe.reason}`,
        );
      }
      return this.successOutcome(command, {
        skipped: true,
        action: "comment",
        postId: target.postId,
        commentId: target.commentId,
        decision: dedupe.reason,
      });
    }
    try {
      const grantId = await this.preflightGrantForAction({
        command,
        payload,
        action: "comment",
        lifecycle: {
          idempotencyKey,
          target,
        },
      });
      const provenance = normalizeAgentProvenanceValue(payload.provenance);
      const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
        command,
        payload,
      });
      const sourceDirectiveActionNonce =
        asNonEmptyString(payload.sourceDirectiveActionNonce) ??
        command.actionNonce ??
        null;
      const curatedBody = await this.curateCommentBodyWithOpenClaw({
        command,
        payload,
        postId: target.postId,
        parentId: target.commentId,
        body,
        targetHash: target.targetHash,
        lifecycleIdempotencyKey: idempotencyKey,
      });
      this.updateActionLifecycle({
        command,
        action: "comment",
        idempotencyKey,
        target,
        state: "action_running",
      });
      const finalBody = stripEmDashCharacters(curatedBody.body);
      const result = await this.agent().commentPost.mutate({
        postId: target.postId,
        body: finalBody,
        ...(target.commentId ? { parentId: target.commentId } : {}),
        ...(provenance ? { provenance } : {}),
        ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
        ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
        ...(grantId ? { grantId } : {}),
      });
      await this.ctx.memory
        .recordWrite({
          type: "comment_body_curated",
          at: nowIso(),
          commandId: command.id,
          postId: target.postId,
          parentId: target.commentId,
          source: curatedBody.source,
          reason: curatedBody.reason,
          draftBody: truncateText(body, 200),
          finalBody: truncateText(finalBody, 200),
        })
        .catch(() => undefined);
      this.updateActionLifecycle({
        command,
        action: "comment",
        idempotencyKey,
        target,
        state: "acked",
        lastError: null,
      });
      return this.successOutcome(command, result);
    } catch (error: unknown) {
      if (error instanceof RequeueCommandError) {
        this.updateActionLifecycle({
          command,
          action: "comment",
          idempotencyKey,
          target,
          state: "requeue",
          lastError: error.message,
        });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (this.isOwnerCapabilityDeniedError(error)) {
        this.registerOwnerCapabilityCooldown({
          action: "comment",
          targetHash: target.targetHash,
          reason: "not_granted",
        });
      }
      this.updateActionLifecycle({
        command,
        action: "comment",
        idempotencyKey,
        target,
        state: "failed",
        lastError: message,
      });
      throw error;
    }
  }

  private async curateCommentBodyWithOpenClaw(input: {
    command: Command;
    payload: Record<string, unknown>;
    postId: number;
    parentId: number | null;
    body: string;
    targetHash: string;
    lifecycleIdempotencyKey: string;
  }): Promise<CuratedCommentBody> {
    return _curateCommentWithOC(
      {
        memory: this.ctx.memory,
        callAgentChatBridge: this.ctx.callAgentChatBridge ?? null,
        runOpenClawPrompt: this.ctx.runOpenClawPrompt ?? null,
        updateActionLifecycle: (lifecycleInput) => this.updateActionLifecycle(lifecycleInput),
      },
      input,
    );
  }

  private async loadCommentCurationContext(input: {
    postId: number;
    parentId: number | null;
    payload: Record<string, unknown>;
  }): Promise<CommentCurationContext> {
    return _loadCommentCurationContext(
      { callAgentChatBridge: this.ctx.callAgentChatBridge ?? null, memory: this.ctx.memory },
      input,
    );
  }

  private extractCommentPayloadHint(payload: Record<string, unknown>): string | null {
    return _extractCommentHint(payload);
  }

  private buildCompactEngagementMemorySummary(bundle: ContextBundle): string | null {
    return _buildEngagementSummary(bundle);
  }

  private extractPostRecordForCommentCuration(
    value: unknown,
    expectedPostId: number,
  ): Record<string, unknown> | null {
    return _extractPostRecord(value, expectedPostId);
  }

  private extractCommentRecordForCommentCuration(
    value: unknown,
  ): Record<string, unknown> | null {
    return _extractCommentRecord(value);
  }

  private summarizePostMediaForComment(post: Record<string, unknown>): string | null {
    return _summarizePostMedia(post);
  }

  private async resolveCommentAuthorIdForTarget(input: {
    postId: number;
    commentId: number;
  }): Promise<string | null> {
    return _resolveCommentAuthor(
      { callAgentChatBridge: this.ctx.callAgentChatBridge ?? null, bridgeLookupCache: this.bridgeLookupCache },
      input,
    );
  }

  private async evaluateEngagementActionWithOpenClaw(input: {
    command: Command;
    action: "like" | "repost";
    postId: number;
    payload: Record<string, unknown>;
    targetHash: string;
    lifecycleIdempotencyKey: string;
  }): Promise<EngagementDecision> {
    return _evaluateEngagementWithOC(
      {
        memory: this.ctx.memory,
        callAgentChatBridge: this.ctx.callAgentChatBridge ?? null,
        runOpenClawPrompt: this.ctx.runOpenClawPrompt ?? null,
        updateActionLifecycle: (lifecycleInput) => this.updateActionLifecycle(lifecycleInput),
      },
      input,
    );
  }

  private async executeWriteVote(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) return this.failedOutcome(command, "Invalid payload for write.votePost.");
    let resolvedTarget: EngagementTargetCandidate | null = null;
    try {
      resolvedTarget =
        (await this.resolveEngagementTargetForDirective({
          payload,
          action: "like",
          commandId: command.id,
        })) ?? null;
    } catch (error: unknown) {
      if (this.isNoTargetDiscoveryFailure(error)) {
        return this.failedOutcome(
          command,
          "No target post candidates found after discovery scan.",
          "no_target_candidates",
        );
      }
      throw error;
    }
    if (!resolvedTarget) {
      throw new RequeueCommandError("like_target_resolution_waiting_for_context:no_target");
    }
    const postId = resolvedTarget.postId;
    payload.postId = postId;
    payload.targetPostId = postId;
    const expectedTarget = {
      postId,
      commentId: null,
      targetHash: buildTargetHash({
        postId,
        commentId: null,
      }),
    };
    const lockMatch = isTargetLockMatch({
      payload,
      expected: expectedTarget,
    });
    if (!lockMatch.ok) {
      return this.failedOutcome(
        command,
        `Target lock mismatch: ${lockMatch.reason}.`,
        "target_lock_mismatch",
      );
    }
    const target = applyTargetLock(payload, {
      postId,
      commentId: null,
    });
    const idempotencyKey = this.buildActionIdempotencyKey({
      command,
      action: "like",
      postId: target.postId,
      commentId: target.commentId,
    });
    const dedupe = this.beginActionLifecycle({
      command,
      action: "like",
      idempotencyKey,
      target,
      state: "context_ready",
    });
    if (!dedupe.allowed) {
      if (dedupe.requeue) {
        throw new RequeueCommandError(
          `engagement_like_waiting_for_backoff:${dedupe.reason}`,
        );
      }
      return this.successOutcome(command, {
        skipped: true,
        action: "like",
        postId: target.postId,
        decision: dedupe.reason,
      });
    }
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command,
      payload,
    });
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;
    const voteRaw =
      typeof payload.vote === "number" && Number.isFinite(payload.vote)
        ? Math.trunc(payload.vote)
        : 1;
    const vote = voteRaw > 0 ? 1 : voteRaw < 0 ? -1 : 0;
    try {
      const grantId = await this.preflightGrantForAction({
        command,
        payload,
        action: "like",
        lifecycle: {
          idempotencyKey,
          target,
        },
      });
      if (vote === 1) {
        const decision = await this.evaluateEngagementActionWithOpenClaw({
          command,
          action: "like",
          postId,
          payload,
          targetHash: target.targetHash,
          lifecycleIdempotencyKey: idempotencyKey,
        });
        const needsRequeue =
          !decision.shouldExecute &&
          decision.reason.trim().toLowerCase().startsWith("openclaw_");
        if (needsRequeue) {
          throw new RequeueCommandError(
            `engagement_like_waiting_for_openclaw:${decision.reason}`,
          );
        }
        await this.ctx.memory
          .recordWrite({
            type: "engagement_action_decision",
            at: nowIso(),
            commandId: command.id,
            action: "like",
            postId,
            shouldExecute: decision.shouldExecute,
            reason: decision.reason,
            source: decision.source,
          })
          .catch(() => undefined);
        if (!decision.shouldExecute) {
          const explicitRequested =
            command.forceNow === true ||
            payload.explicitPublishRequested === true ||
            payload.forceNow === true ||
            payload.userExplicitRequest === true ||
            command.runtimeOrigin === "director_directive" ||
            command.runtimeOrigin === "pending_promotion";
          if (explicitRequested) {
            await this.ctx.memory
              .recordWrite({
                type: "engagement_action_decision_overridden",
                at: nowIso(),
                commandId: command.id,
                action: "like",
                postId,
                reason: decision.reason,
                source: decision.source,
                override: "explicit_request",
              })
              .catch(() => undefined);
          } else {
            this.updateActionLifecycle({
              command,
              action: "like",
              idempotencyKey,
              target,
              state: "acked",
              lastError: null,
            });
            return this.successOutcome(command, {
              skipped: true,
              action: "like",
              postId,
              decision: decision.reason,
            });
          }
        }
      }
      this.updateActionLifecycle({
        command,
        action: "like",
        idempotencyKey,
        target,
        state: "action_running",
      });
      const result = await this.agent().votePost.mutate({
        postId,
        vote,
        ...(grantId ? { grantId } : {}),
        ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
        ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
      });
      const resultRecord = isRecord(result) ? result : null;
      if (resultRecord?.applied === false) {
        this.updateActionLifecycle({
          command,
          action: "like",
          idempotencyKey,
          target,
          state: "acked",
          lastError: null,
        });
        return this.successOutcome(command, {
          skipped: true,
          action: "like",
          postId,
          applied: false,
          ...(typeof resultRecord.delta === "number" && Number.isFinite(resultRecord.delta)
            ? { delta: resultRecord.delta }
            : {}),
          decision:
            asNonEmptyString(resultRecord.decision) ??
            (resultRecord.liked === false ? "noop_not_liked" : "noop"),
        });
      }
      this.updateActionLifecycle({
        command,
        action: "like",
        idempotencyKey,
        target,
        state: "acked",
        lastError: null,
      });
      return this.successOutcome(command, result);
    } catch (error: unknown) {
      if (error instanceof RequeueCommandError) {
        this.updateActionLifecycle({
          command,
          action: "like",
          idempotencyKey,
          target,
          state: "requeue",
          lastError: error.message,
        });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (this.isOwnerCapabilityDeniedError(error)) {
        this.registerOwnerCapabilityCooldown({
          action: "like",
          targetHash: target.targetHash,
          reason: "not_granted",
        });
      }
      this.updateActionLifecycle({
        command,
        action: "like",
        idempotencyKey,
        target,
        state: "failed",
        lastError: message,
      });
      throw error;
    }
  }

  private async executeWriteRepost(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) return this.failedOutcome(command, "Invalid payload for write.repostPost.");
    let resolvedTarget: EngagementTargetCandidate | null = null;
    try {
      resolvedTarget =
        (await this.resolveEngagementTargetForDirective({
          payload,
          action: "repost",
          commandId: command.id,
        })) ?? null;
    } catch (error: unknown) {
      if (this.isNoTargetDiscoveryFailure(error)) {
        return this.failedOutcome(
          command,
          "No target post candidates found after discovery scan.",
          "no_target_candidates",
        );
      }
      throw error;
    }
    if (!resolvedTarget) {
      throw new RequeueCommandError("repost_target_resolution_waiting_for_context:no_target");
    }
    const postId = resolvedTarget.postId;
    payload.postId = postId;
    payload.targetPostId = postId;
    const expectedTarget = {
      postId,
      commentId: null,
      targetHash: buildTargetHash({
        postId,
        commentId: null,
      }),
    };
    const lockMatch = isTargetLockMatch({
      payload,
      expected: expectedTarget,
    });
    if (!lockMatch.ok) {
      return this.failedOutcome(
        command,
        `Target lock mismatch: ${lockMatch.reason}.`,
        "target_lock_mismatch",
      );
    }
    const target = applyTargetLock(payload, {
      postId,
      commentId: null,
    });
    const idempotencyKey = this.buildActionIdempotencyKey({
      command,
      action: "repost",
      postId: target.postId,
      commentId: target.commentId,
    });
    const dedupe = this.beginActionLifecycle({
      command,
      action: "repost",
      idempotencyKey,
      target,
      state: "context_ready",
    });
    if (!dedupe.allowed) {
      if (dedupe.requeue) {
        throw new RequeueCommandError(
          `engagement_repost_waiting_for_backoff:${dedupe.reason}`,
        );
      }
      return this.successOutcome(command, {
        skipped: true,
        action: "repost",
        postId: target.postId,
        decision: dedupe.reason,
      });
    }
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command,
      payload,
    });
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;
    const repost = payload.repost === 0 ? 0 : 1;
    try {
      const grantId = await this.preflightGrantForAction({
        command,
        payload,
        action: "repost",
        lifecycle: {
          idempotencyKey,
          target,
        },
      });
      if (repost === 1) {
        const decision = await this.evaluateEngagementActionWithOpenClaw({
          command,
          action: "repost",
          postId,
          payload,
          targetHash: target.targetHash,
          lifecycleIdempotencyKey: idempotencyKey,
        });
        const needsRequeue =
          !decision.shouldExecute &&
          decision.reason.trim().toLowerCase().startsWith("openclaw_");
        if (needsRequeue) {
          throw new RequeueCommandError(
            `engagement_repost_waiting_for_openclaw:${decision.reason}`,
          );
        }
        await this.ctx.memory
          .recordWrite({
            type: "engagement_action_decision",
            at: nowIso(),
            commandId: command.id,
            action: "repost",
            postId,
            shouldExecute: decision.shouldExecute,
            reason: decision.reason,
            source: decision.source,
          })
          .catch(() => undefined);
        if (!decision.shouldExecute) {
          const explicitRequested =
            command.forceNow === true ||
            payload.explicitPublishRequested === true ||
            payload.forceNow === true ||
            payload.userExplicitRequest === true ||
            command.runtimeOrigin === "director_directive" ||
            command.runtimeOrigin === "pending_promotion";
          if (explicitRequested) {
            await this.ctx.memory
              .recordWrite({
                type: "engagement_action_decision_overridden",
                at: nowIso(),
                commandId: command.id,
                action: "repost",
                postId,
                reason: decision.reason,
                source: decision.source,
                override: "explicit_request",
              })
              .catch(() => undefined);
          } else {
            this.updateActionLifecycle({
              command,
              action: "repost",
              idempotencyKey,
              target,
              state: "acked",
              lastError: null,
            });
            return this.successOutcome(command, {
              skipped: true,
              action: "repost",
              postId,
              decision: decision.reason,
            });
          }
        }
      }
      this.updateActionLifecycle({
        command,
        action: "repost",
        idempotencyKey,
        target,
        state: "action_running",
      });
      const result = await this.agent().repostPost.mutate({
        postId,
        repost,
        ...(grantId ? { grantId } : {}),
        ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
        ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
      });
      const resultRecord = isRecord(result) ? result : null;
      if (resultRecord?.applied === false) {
        this.updateActionLifecycle({
          command,
          action: "repost",
          idempotencyKey,
          target,
          state: "acked",
          lastError: null,
        });
        return this.successOutcome(command, {
          skipped: true,
          action: "repost",
          postId,
          applied: false,
          ...(typeof resultRecord.delta === "number" && Number.isFinite(resultRecord.delta)
            ? { delta: resultRecord.delta }
            : {}),
          decision:
            asNonEmptyString(resultRecord.decision) ??
            (resultRecord.reposted === false ? "noop_not_reposted" : "noop"),
        });
      }
      this.updateActionLifecycle({
        command,
        action: "repost",
        idempotencyKey,
        target,
        state: "acked",
        lastError: null,
      });
      return this.successOutcome(command, result);
    } catch (error: unknown) {
      if (error instanceof RequeueCommandError) {
        this.updateActionLifecycle({
          command,
          action: "repost",
          idempotencyKey,
          target,
          state: "requeue",
          lastError: error.message,
        });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (this.isOwnerCapabilityDeniedError(error)) {
        this.registerOwnerCapabilityCooldown({
          action: "repost",
          targetHash: target.targetHash,
          reason: "not_granted",
        });
      }
      this.updateActionLifecycle({
        command,
        action: "repost",
        idempotencyKey,
        target,
        state: "failed",
        lastError: message,
      });
      throw error;
    }
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
      collectBridgeRecordItems: (value) => this.collectBridgeRecordItems(value),
      recordCommandLifecycleCheckpoint: (checkpoint) =>
        this.recordCommandLifecycleCheckpoint(checkpoint),
      successOutcome: (command, data) => this.successOutcome(command, data),
      failedOutcome: (command, message, code) =>
        this.failedOutcome(command, message, code),
    });
  }

  private async executeRetryPending(command: Command): Promise<CommandOutcome> {
    return _executeRetryPending(command, {
      ctx: this.ctx,
      resolveCommandSourceDirectiveId: (input) =>
        this.resolveCommandSourceDirectiveId(input),
      successOutcome: (resolvedCommand, data) =>
        this.successOutcome(resolvedCommand, data),
      failedOutcome: (resolvedCommand, message, code) =>
        this.failedOutcome(resolvedCommand, message, code),
    });
  }

  private async executeGenerateAndQueue(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for generate-and-queue command.");
    }
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command,
      payload,
    });

    const delegatedFollowAction = this.resolveDelegatedFollowAction(payload);
    if (delegatedFollowAction) {
      return this.executeDelegatedFollowAction({
        command,
        payload,
        action: delegatedFollowAction,
      });
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
      return this.failedOutcome(
        command,
        "Story creation is directive-only. Chat requests can create posts, but not stories.",
        "story_chat_disabled",
      );
    }
    if (payload.chatLiteralGenerate === true) {
      return this.executeChatLiteralGenerate(command, payload);
    }

    const sourceDirectiveActionNonce =
      this.resolveCommandSourceDirectiveActionNonce({ command, payload });
    const provenance = normalizeAgentProvenanceValue(payload.provenance);
    const enforcedDraftAction = this.resolveEnforcedDraftAction(payload);
    if (enforcedDraftAction) {
      const scopedDirective = isRecord(payload.directiveScope) ? payload.directiveScope : null;
      const scopedTarget = scopedDirective && isRecord(scopedDirective.target) ? scopedDirective.target : null;
      const hasTargetPostId =
        asPositiveInt(payload.postId) ??
        asPositiveInt(payload.targetPostId) ??
        (scopedDirective
          ? asPositiveInt(scopedDirective.targetPostId) ??
            (scopedTarget ? asPositiveInt(scopedTarget.postId) : null)
          : null);
      if (!hasTargetPostId) {
        let resolvedTarget: EngagementTargetCandidate | null = null;
        try {
          resolvedTarget = await this.resolveEngagementTargetForDirective({
            payload,
            action: enforcedDraftAction,
            commandId: command.id,
          });
        } catch (error: unknown) {
          if (this.isNoTargetDiscoveryFailure(error)) {
            return this.failedOutcome(
              command,
              `No target candidates found for ${enforcedDraftAction} after discovery scan.`,
              "no_target_candidates",
            );
          }
          throw error;
        }
        if (!resolvedTarget) {
          throw new RequeueCommandError(
            `engagement_target_resolution_waiting_for_context:${enforcedDraftAction}:no_target`,
          );
        }
        payload.postId = resolvedTarget.postId;
        payload.targetPostId = resolvedTarget.postId;
        if (enforcedDraftAction === "comment" && resolvedTarget.commentId) {
          payload.commentId = resolvedTarget.commentId;
          payload.parentId = resolvedTarget.commentId;
          payload.targetCommentId = resolvedTarget.commentId;
        }
        if (resolvedTarget.postSnapshotHash) {
          payload.targetPostSnapshotHash = resolvedTarget.postSnapshotHash;
          payload.postSnapshotHash = resolvedTarget.postSnapshotHash;
        }
        const nextScope = isRecord(payload.directiveScope)
          ? { ...payload.directiveScope }
          : ({} as Record<string, unknown>);
        nextScope.targetPostId = resolvedTarget.postId;
        if (enforcedDraftAction === "comment" && resolvedTarget.commentId) {
          nextScope.targetCommentId = resolvedTarget.commentId;
        }
        const nextScopeTarget = isRecord(nextScope.target)
          ? { ...nextScope.target }
          : ({} as Record<string, unknown>);
        nextScopeTarget.postId = resolvedTarget.postId;
        nextScopeTarget.commentId =
          enforcedDraftAction === "comment" ? (resolvedTarget.commentId ?? null) : null;
        nextScope.target = nextScopeTarget;
        payload.directiveScope = nextScope;
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
      return this.failedOutcome(
        command,
        "No permission-allowed generation actions are available right now.",
        "no_permitted_generate_kind",
      );
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
          return this.executeChatLiteralGenerate(command, fallbackPayload);
        }
        return this.failedOutcome(
          command,
          explicitStoryChatRequest
            ? "Story creation is directive-only. Chat requests can create posts, but not stories."
            : "generate returned no permission-allowed drafts.",
          explicitStoryChatRequest ? "story_chat_disabled" : "no_permitted_drafts",
        );
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
            return this.executeChatLiteralGenerate(command, fallbackPayload);
          }
          return this.failedOutcome(
            command,
            "Chat write actions require an explicit request to post/comment/reply/like/repost/story.",
            "chat_write_explicit_required",
          );
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
          return this.failedOutcome(
            command,
            "Chat write actions are owner-only unless explicitly granted.",
            "chat_write_owner_only",
          );
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
      return this.failedOutcome(
        command,
        `generate returned no executable ${enforcedDraftAction} draft.`,
        "no_executable_draft",
      );
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
          ...failed,
          data: {
            mode: "draft_preview",
            chatDeliveryHandled: previewDelivered,
          },
        };
      }
      return this.failedOutcome(
        command,
        "generate returned no permission-allowed drafts.",
        "no_permitted_drafts",
      );
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
          ...failed,
          data: {
            mode: "draft_preview",
            chatDeliveryHandled: previewDelivered,
          },
        };
      }
      const previewDelivered = await this.sendDraftPreviewMessage({
        payload,
        preview: draftPreview,
      }).catch(() => false);
      if (!previewDelivered) {
        return this.failedOutcome(
          command,
          "Draft generated, but preview delivery to chat failed.",
          "draft_preview_delivery_failed",
        );
      }
      return this.successOutcome(command, {
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
      });
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
        return this.failedOutcome(
          command,
          "Write action blocked: explicit post/comment/reply/like/repost/story request required.",
          "publish_verb_required",
        );
      }
    }

    const executedOutcomes: CommandOutcome[] = [];
    const skippedDrafts: Array<{ kind: string; reason: string }> = [];
    const failedDrafts: Array<{ kind: string; reason: string; code: string | null }> = [];
    const blockedWriteKinds = new Set<string>();
    for (const draft of executionDrafts) {
      if (!draft) continue;
      const draftCommand = this.mapDraftToWriteCommand({
        draft,
        command,
        sourceDirectiveId,
        sourceDirectiveActionNonce,
        provenance,
      });
      if (!draftCommand) continue;
      const normalizedDraftKind = draftCommand.kind.trim().toLowerCase();
      if (blockedWriteKinds.has(normalizedDraftKind)) {
        skippedDrafts.push({
          kind: normalizedDraftKind,
          reason: "skipped_after_recoverable_grant_denial",
        });
        continue;
      }
      try {
        const outcome = await this.executeCommandFromMappedDraft(draftCommand);
        executedOutcomes.push(outcome);
        if (!outcome.ok) {
          const failureReason = asNonEmptyString(outcome.error?.message) ??
            "generated draft execution failed.";
          failedDrafts.push({
            kind: normalizedDraftKind,
            reason: failureReason,
            code: asNonEmptyString(outcome.error?.code) ?? null,
          });
          await this.ctx.memory
            .recordWrite({
              type: "generate_draft_execution_failed",
              at: nowIso(),
              commandId: command.id,
              draftKind: normalizedDraftKind,
              reason: failureReason,
              code: asNonEmptyString(outcome.error?.code) ?? null,
              sourceDirectiveId,
            })
            .catch(() => undefined);
          if (this.isRecoverableDraftGrantErrorMessage(failureReason)) {
            blockedWriteKinds.add(normalizedDraftKind);
          }
          continue;
        }
        const outcomeData = isRecord(outcome.data) ? outcome.data : null;
        const skipped = outcomeData?.skipped === true;
        const decision = asNonEmptyString(outcomeData?.decision);
        if (skipped) {
          const reason = decision ?? "skipped";
          skippedDrafts.push({
            kind: normalizedDraftKind,
            reason,
          });
          if (this.isRecoverableDraftSkipDecision(reason)) {
            blockedWriteKinds.add(normalizedDraftKind);
          }
        }
      } catch (error: unknown) {
        // If the write executor threw RequeueCommandError and no drafts have applied yet,
        // propagate it so the command actually gets requeued (with cached drafts).
        // This prevents burning a generated prompt for nothing.
        if (error instanceof RequeueCommandError) {
          const anyApplied = executedOutcomes.some((entry) => entry.ok);
          if (!anyApplied) {
            throw error;
          }
          // Some drafts already applied — can't requeue without creating duplicates,
          // so treat this draft as failed and continue.
        }
        const reason = error instanceof Error ? error.message : String(error);
        if (this.isRecoverableDraftExecutionError(error)) {
          blockedWriteKinds.add(normalizedDraftKind);
          skippedDrafts.push({
            kind: normalizedDraftKind,
            reason,
          });
          await this.ctx.memory
            .recordWrite({
              type: "generate_draft_execution_skipped",
              at: nowIso(),
              commandId: command.id,
              draftKind: normalizedDraftKind,
              reason,
              sourceDirectiveId,
            })
            .catch(() => undefined);
          continue;
        }
        failedDrafts.push({
          kind: normalizedDraftKind,
          reason,
          code: null,
        });
        await this.ctx.memory
          .recordWrite({
            type: "generate_draft_execution_failed",
            at: nowIso(),
            commandId: command.id,
            draftKind: normalizedDraftKind,
            reason,
            sourceDirectiveId,
          })
          .catch(() => undefined);
        if (this.isRecoverableDraftGrantErrorMessage(reason)) {
          blockedWriteKinds.add(normalizedDraftKind);
        }
        continue;
      }
    }

    const firstFailure = failedDrafts[0] ?? null;
    if (firstFailure && executedOutcomes.filter((entry) => entry.ok).length === 0) {
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "write_mutation",
        status: "failed",
        message: firstFailure.reason,
        metadata: {
          executedCount: executedOutcomes.length,
          failedCount: failedDrafts.length,
        },
      });
      return this.failedOutcome(
        command,
        firstFailure.reason,
        firstFailure.code ?? undefined,
      );
    }

    const appliedOutcomeCount = executedOutcomes.filter((entry) => {
      if (!entry.ok) return false;
      const entryData = isRecord(entry.data) ? entry.data : null;
      return entryData?.skipped !== true;
    }).length;
    const skippedReasonSet = new Set(
      skippedDrafts
        .map((entry) => entry.reason.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    );
    const allSkippedReasonsIdempotentNoop =
      skippedReasonSet.size > 0 &&
      Array.from(skippedReasonSet).every(
        (reason) => reason === "already_acked" || reason === "already_in_flight",
      );
    if (appliedOutcomeCount === 0 && skippedDrafts.length > 0 && failedDrafts.length === 0) {
      if (allSkippedReasonsIdempotentNoop) {
        await this.recordCommandLifecycleCheckpoint({
          command,
          stage: "write_mutation",
          status: "ok",
          metadata: {
            executedCount: executedOutcomes.length,
            skippedCount: skippedDrafts.length,
            failedCount: failedDrafts.length,
            idempotentNoop: true,
          },
        });
      } else {
      const firstSkipReason = skippedDrafts[0]?.reason ?? "no_executable_draft";
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "write_mutation",
        status: "failed",
        message: firstSkipReason,
        metadata: {
          executedCount: executedOutcomes.length,
          skippedCount: skippedDrafts.length,
          failedCount: failedDrafts.length,
        },
      });
      return this.failedOutcome(
        command,
        `Generated drafts were skipped: ${truncateText(firstSkipReason, 220)}.`,
        "no_executable_draft",
      );
      }
    }

    if (executedOutcomes.length > 0 || skippedDrafts.length > 0 || failedDrafts.length > 0) {
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "write_mutation",
        status: failedDrafts.length > 0 && appliedOutcomeCount === 0 ? "failed" : "ok",
        message: failedDrafts.length > 0 ? failedDrafts[0]?.reason ?? null : null,
        metadata: {
          executedCount: executedOutcomes.length,
          appliedCount: appliedOutcomeCount,
          executedKinds: executedOutcomes.map((entry) => entry.kind),
          skippedCount: skippedDrafts.length,
          failedCount: failedDrafts.length,
        },
      });
    }

    // Command completed — clear the draft cache entry.
    this.generatedDraftCache.delete(command.id);

    return this.successOutcome(command, {
      generated: generatedResult,
      executed: executedOutcomes.map((entry) => {
        const entryData = isRecord(entry.data) ? entry.data : null;
        const commandId = asNonEmptyString(entry.commandId) ?? "";
        const kind = asNonEmptyString(entry.kind) ?? "";
        const postId =
          asPositiveInt(entryData?.postId) ??
          asPositiveInt(entryData?.targetPostId) ??
          null;
        const commentId =
          asPositiveInt(entryData?.commentId) ??
          asPositiveInt(entryData?.parentId) ??
          asPositiveInt(entryData?.targetCommentId) ??
          null;
        const action = asNonEmptyString(entryData?.action) ?? null;
        const decision = asNonEmptyString(entryData?.decision) ?? null;
        const delta =
          typeof entryData?.delta === "number" && Number.isFinite(entryData.delta)
            ? entryData.delta
            : null;
        const applied = typeof entryData?.applied === "boolean" ? entryData.applied : null;
        return {
          commandId,
          kind,
          ok: entry.ok,
          skipped: entryData?.skipped === true,
          ...(action ? { action } : {}),
          ...(postId ? { postId } : {}),
          ...(commentId ? { commentId } : {}),
          ...(decision ? { decision } : {}),
          ...(delta !== null ? { delta } : {}),
          ...(applied !== null ? { applied } : {}),
        };
      }),
      ...(skippedDrafts.length > 0
        ? {
            skippedDrafts: skippedDrafts.slice(0, 24),
          }
        : {}),
      ...(failedDrafts.length > 0
        ? {
            failedDrafts: failedDrafts.slice(0, 24),
          }
        : {}),
    });
  }

  private shouldEnforceExplicitPublishGate(payload: Record<string, unknown>): boolean {
    return _shouldEnforcePublishGate(payload);
  }

  private isWriteDraftAction(actionValue: string): boolean {
    return _isWriteDraftAction(actionValue);
  }

  private isChatWriteRequesterOwner(payload: Record<string, unknown>): boolean {
    return _isChatWriteOwner(payload);
  }

  private isChatWriteCommandExplicitlyRequested(
    payload: Record<string, unknown>,
  ): boolean {
    return _isChatWriteExplicit(payload);
  }

  private isChatMediaIntentPayload(payload: Record<string, unknown>): boolean {
    return _isChatMediaIntent(payload);
  }

  private resolveChatLiteralFallbackPromptFromDrafts(input: {
    payload: Record<string, unknown>;
    drafts: GeneratedDraft[];
  }): string | null {
    return _resolveLiteralFallback(input);
  }

  private shouldRedirectBlockedChatWritesToLiteralGenerate(input: {
    payload: Record<string, unknown>;
    blockedDrafts: GeneratedDraft[];
  }): boolean {
    return _shouldRedirectToLiteral(input);
  }

  private isChatOriginPayload(payload: Record<string, unknown> | null): boolean {
    return _isChatOriginPayload(payload);
  }

  private isChatOriginCommand(
    command: Command,
    payloadOverride?: Record<string, unknown> | null,
  ): boolean {
    return _isChatOriginCommand(command, payloadOverride);
  }

  private isStoryGenerateRequestFromChatPayload(
    payload: Record<string, unknown>,
  ): boolean {
    return _isStoryGenRequest(payload);
  }

  private didChatMessageExplicitlyRequestStory(
    payload: Record<string, unknown>,
  ): boolean {
    return _didExplicitStory(payload);
  }

  private parseGeneratedCustomAssetKind(
    value: unknown,
  ): GeneratedCustomAssetKind | null {
    return _parseAssetKind(value);
  }

  private parseGeneratedCustomAssetScope(
    value: unknown,
  ): GeneratedCustomAssetScope | null {
    return _parseAssetScope(value);
  }

  private resolveGeneratedCustomAssetSaveIntent(
    payload: Record<string, unknown>,
    sourcePrompt: string,
  ): GeneratedCustomAssetSaveIntent | null {
    return _resolveAssetIntent(payload, sourcePrompt);
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

  private resolveGeneratedAssetType(value: unknown): GeneratedAssetType {
    return _resolveAssetType(value);
  }

  private resolveGeneratedAttachmentMimeType(input: {
    generatedAssetType: GeneratedAssetType;
    mediaUrl: string;
    mediaType?: "image" | "video";
  }): string {
    return _resolveAttachmentMime(input);
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
        resolveGeneratedAssetType: (v) => this.resolveGeneratedAssetType(v),
        collectMediaReferenceInputs: (p) => this.collectMediaReferenceInputs(p),
        resolvePersonaFrameReferences: (i) => this.resolvePersonaFrameReferences(i),
        resolveGeneratedCustomAssetSaveIntent: (p, pr) => this.resolveGeneratedCustomAssetSaveIntent(p, pr),
        resolveChatProcessingClientMessageId: (c) => this.resolveChatProcessingClientMessageId(c),
        generateAndUploadMediaFromPrompt: (p, o) => this.generateAndUploadMediaFromPrompt(p, o),
        resolveGeneratedAttachmentMimeType: (i) => this.resolveGeneratedAttachmentMimeType(i),
        recordCommandLifecycleCheckpoint: (i) => this.recordCommandLifecycleCheckpoint(i),
        saveGeneratedCustomAsset: (i) => this.saveGeneratedCustomAsset(i),
        updateAvatar: (i) => this.updateAvatar(i),
        updateBanner: (i) => this.updateBanner(i),
        classifyMediaGenerationDeferral: (i) => this.classifyMediaGenerationDeferral(i),
        isStreamPartArtifactReference: (v) => this.isStreamPartArtifactReference(v),
        failedOutcome: (c, m, code) => this.failedOutcome(c, m, code),
        successOutcome: (c, d) => this.successOutcome(c, d),
      },
      command,
      payload,
    );
  }

  private async executeCommandFromMappedDraft(command: Command): Promise<CommandOutcome> {
    const kind = command.kind.trim().toLowerCase();
    if (kind === "write.createpost") return this.executeWriteCreatePost(command);
    if (kind === "write.createstory") return this.executeWriteCreateStory(command);
    if (kind === "write.updateavatar") return this.executeWriteUpdateAvatar(command);
    if (kind === "write.updatebanner") return this.executeWriteUpdateBanner(command);
    if (kind === "write.commentpost" || kind === "write.comment") {
      return this.executeWriteComment(command);
    }
    if (kind === "write.votepost" || kind === "write.like") {
      return this.executeWriteVote(command);
    }
    if (kind === "write.repostpost" || kind === "write.repost") {
      return this.executeWriteRepost(command);
    }
    return this.failedOutcome(command, `Unsupported generated draft command kind: ${command.kind}`);
  }

  private buildGenerateInput(
    payload: Record<string, unknown>,
    command: Command,
  ): Record<string, unknown> {
    return _buildGenerateInput(payload, command);
  }

  private collectBridgeRecordItems(value: unknown): Record<string, unknown>[] {
    return _collectBridgeItems(value);
  }

  private asNonNegativeInt(value: unknown): number | null {
    return _asNonNegativeInt(value);
  }

  private computePostSnapshotHash(input: {
    postId: number;
    commentId: number | null;
    postRecord: Record<string, unknown>;
  }): string | null {
    return _computeSnapshotHash(input);
  }

  private async resolvePostSnapshotHashForPostId(input: {
    postId: number;
    commentId: number | null;
  }): Promise<string | null> {
    return _resolveSnapshotHash(
      { callAgentChatBridge: this.ctx.callAgentChatBridge ?? null, bridgeLookupCache: this.bridgeLookupCache },
      input,
    );
  }

  private extractEngagementTargetCandidateFromRecord(
    record: Record<string, unknown>,
    source: string,
  ): EngagementTargetCandidate | null {
    return _extractEngagementCandidate(record, source);
  }

  private isOwnEngagementCandidate(
    candidate: EngagementTargetCandidate,
    agentMainUserId: string | null,
  ): boolean {
    return _isOwnEngagement(candidate, agentMainUserId);
  }

  private shouldIncludeOwnLatestCommentLookup(input: {
    rawQuery: string;
    explicitPostId: number | null;
    explicitCommentId: number | null;
  }): boolean {
    return _shouldIncludeOwnLookup(input);
  }

  private shouldAllowRareTopLevelSelfComment(input: {
    commandId: string;
    postId: number;
    rawQuery: string;
  }): { allow: boolean; reason: string; gateRoll: number } {
    return _shouldAllowRareSelfComment(input);
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
        extractEngagementLookupHints: (p) => this.extractEngagementLookupHints(p),
        buildEngagementTargetCacheKey: (i) => this.buildEngagementTargetCacheKey(i),
        pruneEngagementTargetCache: (ms) => this.pruneEngagementTargetCache(ms),
        listRecentCommentTargetUsage: () => this.listRecentCommentTargetUsage(),
        decideCommentTargetReuse: (i) => this.decideCommentTargetReuse(i),
        parseTargetIdsFromTextLine: (t) => this.parseTargetIdsFromTextLine(t),
        shouldIncludeOwnLatestCommentLookup: (i) => this.shouldIncludeOwnLatestCommentLookup(i),
        isOwnEngagementCandidate: (c, u) => this.isOwnEngagementCandidate(c, u),
        shouldAllowRareTopLevelSelfComment: (i) => this.shouldAllowRareTopLevelSelfComment(i),
      },
      input,
    );
  }
      : null;
    const explicitPostId =
      asPositiveInt(input.payload.postId) ??
      asPositiveInt(input.payload.targetPostId) ??
      (scopedDirective
        ? asPositiveInt(scopedDirective.targetPostId) ??
          (scopedTarget ? asPositiveInt(scopedTarget.postId) : null)
        : null);
    const explicitCommentId =
      asPositiveInt(input.payload.parentId) ??
      asPositiveInt(input.payload.commentId) ??
      asPositiveInt(input.payload.targetCommentId) ??
      (scopedDirective
        ? asPositiveInt(scopedDirective.targetCommentId) ??
          (scopedTarget ? asPositiveInt(scopedTarget.commentId) : null)
        : null);
    if (explicitPostId) {
      const explicitResolvedCommentId =
        input.action === "comment" ? (explicitCommentId ?? null) : null;
      const postSnapshotHash = await this.resolvePostSnapshotHashForPostId({
        postId: explicitPostId,
        commentId: explicitResolvedCommentId,
      });
      return {
        postId: explicitPostId,
        commentId: explicitResolvedCommentId,
        authorId: null,
        source: "directive_payload",
        postSnapshotHash,
      };
    }

    const hints = this.extractEngagementLookupHints(input.payload);
    const hintedPostId = hints.postId;
    const hintedCommentId = hints.commentId;
    if (hintedPostId) {
      const hintedResolvedCommentId = input.action === "comment" ? hintedCommentId : null;
      const postSnapshotHash = await this.resolvePostSnapshotHashForPostId({
        postId: hintedPostId,
        commentId: hintedResolvedCommentId,
      });
      return {
        postId: hintedPostId,
        commentId: hintedResolvedCommentId,
        authorId: null,
        source: "payload_hint",
        postSnapshotHash,
      };
    }

    const hasBridge = Boolean(this.ctx.callAgentChatBridge);
    let bridgeQuerySuccessCount = 0;
    let bridgeQueryFailureCount = 0;

    const cacheKey = this.buildEngagementTargetCacheKey({
      action: input.action,
      payload: input.payload,
      hints,
    });
    const recentCommentUsage =
      input.action === "comment" ? this.listRecentCommentTargetUsage() : [];
    const nowMs = Date.now();
    this.pruneEngagementTargetCache(nowMs);
    const cachedResolution = this.engagementTargetCache.get(cacheKey);
    if (cachedResolution && cachedResolution.expiresAtMs > nowMs) {
      if (input.action === "comment") {
        const reuseDecision = this.decideCommentTargetReuse({
          commandId: input.commandId,
          postId: cachedResolution.candidate.postId,
          commentId: cachedResolution.candidate.commentId ?? null,
          postSnapshotHash: cachedResolution.candidate.postSnapshotHash ?? null,
          source: cachedResolution.candidate.source,
          recentUsage: recentCommentUsage,
        });
        if (!reuseDecision.allow) {
          this.engagementTargetCache.delete(cacheKey);
          await this.ctx.memory
            .recordWrite({
              type: "engagement_target_cache_skipped_recent_comment_target",
              at: nowIso(),
              commandId: input.commandId,
              action: input.action,
              postId: cachedResolution.candidate.postId,
              commentId: cachedResolution.candidate.commentId ?? null,
              source: cachedResolution.candidate.source,
              postSnapshotHash: cachedResolution.candidate.postSnapshotHash ?? null,
              reason: reuseDecision.reason,
              recentCommandId: reuseDecision.recentMatch?.commandId ?? null,
              recentPostId: reuseDecision.recentMatch?.postId ?? null,
              recentCommentId: reuseDecision.recentMatch?.commentId ?? null,
              recentPostSnapshotHash: reuseDecision.recentMatch?.postSnapshotHash ?? null,
            })
            .catch(() => undefined);
        } else {
          return {
            ...cachedResolution.candidate,
            commentId: cachedResolution.candidate.commentId ?? null,
          };
        }
      } else {
        return {
          ...cachedResolution.candidate,
          commentId: null,
        };
      }
    }

    type LookupPlan = {
      source: string;
      request: Record<string, unknown>;
      parser?: (value: unknown) => EngagementTargetCandidate[];
    };
    const trace: EngagementResolutionTrace[] = [];
    const candidates: EngagementTargetCandidate[] = [];
    const candidateByTargetKey = new Map<string, EngagementTargetCandidate>();
    const pushCandidate = (candidate: EngagementTargetCandidate | null): boolean => {
      if (!candidate) return false;
      if (!candidate.postId || candidate.postId <= 0) return false;
      const key = `${candidate.postId}:${candidate.commentId ?? 0}`;
      const existing = candidateByTargetKey.get(key);
      if (existing) {
        const nextAuthorId = existing.authorId ?? candidate.authorId ?? null;
        if (nextAuthorId !== existing.authorId) {
          existing.authorId = nextAuthorId;
        }
        const nextSnapshotHash =
          candidate.postSnapshotHash ??
          existing.postSnapshotHash ??
          null;
        if (nextSnapshotHash !== existing.postSnapshotHash) {
          existing.postSnapshotHash = nextSnapshotHash;
        }
        if (
          existing.source.startsWith("own_latest") &&
          !candidate.source.startsWith("own_latest")
        ) {
          existing.source = candidate.source;
        }
        return false;
      }
      candidateByTargetKey.set(key, candidate);
      candidates.push(candidate);
      return true;
    };
    const addCandidatesFrom = (value: unknown, source: string): number => {
      let added = 0;
      for (const item of this.collectBridgeRecordItems(value)) {
        const parsed = this.extractEngagementTargetCandidateFromRecord(item, source);
        if (!parsed) continue;
        if (pushCandidate(parsed)) added += 1;
      }
      return added;
    };
    const runLookupStep = async (
      step: string,
      plans: LookupPlan[],
    ): Promise<void> => {
      if (!hasBridge || plans.length === 0) return;
      let queryCount = 0;
      let cacheHits = 0;
      let addedCandidates = 0;
      for (const plan of plans) {
        try {
          const result = await this.callAgentBridgeLookupCached(plan.request);
          bridgeQuerySuccessCount += 1;
          queryCount += 1;
          if (result.cacheHit) cacheHits += 1;
          if (typeof plan.parser === "function") {
            for (const candidate of plan.parser(result.value)) {
              if (pushCandidate(candidate)) addedCandidates += 1;
            }
          } else {
            addedCandidates += addCandidatesFrom(result.value, plan.source);
          }
        } catch (error: unknown) {
          bridgeQueryFailureCount += 1;
          await this.ctx.memory
            .recordWrite({
              type: "engagement_target_lookup_failed",
              at: nowIso(),
              commandId: input.commandId,
              action: input.action,
              step,
              source: plan.source,
              lookupAction: asNonEmptyString(plan.request.action) ?? "unknown",
              error: error instanceof Error ? error.message : String(error),
            })
            .catch(() => undefined);
        }
      }
      trace.push({
        step,
        queryCount,
        cacheHits,
        addedCandidates,
        totalCandidates: candidates.length,
      });
    };

    let agentMainUserId: string | null = null;
    let agentHandle: string | null = null;
    let agentPreferenceTags: string[] = [];
    if (hasBridge) {
      const profileResult = await this.callAgentBridgeLookupCached({
        action: "agent_profile",
      }).catch((error: unknown) => {
        bridgeQueryFailureCount += 1;
        void this.ctx.memory
          .recordWrite({
            type: "engagement_target_lookup_failed",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            step: "agent_profile",
            source: "agent_profile",
            lookupAction: "agent_profile",
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
        return null;
      });
      if (profileResult) {
        bridgeQuerySuccessCount += 1;
        const profileRecord = isRecord(profileResult.value) ? profileResult.value : null;
        if (profileRecord && isRecord(profileRecord.agent)) {
          const agentRecord = profileRecord.agent;
          agentMainUserId = asNonEmptyString(agentRecord.mainUserId) ?? null;
          agentHandle =
            asNonEmptyString(agentRecord.handle)?.replace(/^@+/u, "").toLowerCase() ??
            null;
          const agentPreferredTags = Array.isArray(agentRecord.preferredTags)
            ? (agentRecord.preferredTags as unknown[])
            : [];
          const profilePreferredTags = Array.isArray(profileRecord.preferredTags)
            ? (profileRecord.preferredTags as unknown[])
            : [];
          const configPreferredTags =
            isRecord(profileRecord.config) && Array.isArray(profileRecord.config.preferredTags)
              ? (profileRecord.config.preferredTags as unknown[])
              : [];
          agentPreferenceTags = Array.from(
            new Set(
              [
                ...agentPreferredTags,
                ...profilePreferredTags,
                ...configPreferredTags,
              ]
                .map((value) => normalizeInterestTagToken(value))
                .filter((value): value is string => Boolean(value)),
            ),
          ).slice(0, 8);
        }
        trace.push({
          step: "agent_profile",
          queryCount: 1,
          cacheHits: profileResult.cacheHit ? 1 : 0,
          addedCandidates: 0,
          totalCandidates: 0,
        });
      }
    }

    const parseNotificationTargets = (
      value: unknown,
      source: string,
    ): EngagementTargetCandidate[] => {
      const resolved: EngagementTargetCandidate[] = [];
      const seen = new Set<string>();
      const push = (candidate: EngagementTargetCandidate | null): void => {
        if (!candidate) return;
        if (!candidate.postId || candidate.postId <= 0) return;
        const key = `${candidate.postId}:${candidate.commentId ?? 0}`;
        if (seen.has(key)) return;
        seen.add(key);
        resolved.push(candidate);
      };
      for (const row of this.collectBridgeRecordItems(value)) {
        push(this.extractEngagementTargetCandidateFromRecord(row, source));

        const entityType =
          asNonEmptyString(row.entityType)?.toLowerCase() ??
          asNonEmptyString(row.targetType)?.toLowerCase() ??
          null;
        const entityId =
          asPositiveInt(row.entityId) ??
          asPositiveInt(row.targetId) ??
          null;
        const postIdFromFields =
          asPositiveInt(row.postId) ??
          asPositiveInt(row.targetPostId) ??
          (isRecord(row.post) ? asPositiveInt(row.post.id) : null) ??
          (isRecord(row.target)
            ? asPositiveInt(row.target.postId) ??
              (isRecord(row.target.post) ? asPositiveInt(row.target.post.id) : null)
            : null);
        const commentIdFromFields =
          asPositiveInt(row.commentId) ??
          asPositiveInt(row.targetCommentId) ??
          asPositiveInt(row.parentId) ??
          (isRecord(row.comment) ? asPositiveInt(row.comment.id) : null) ??
          (isRecord(row.target)
            ? asPositiveInt(row.target.commentId) ??
              (isRecord(row.target.comment) ? asPositiveInt(row.target.comment.id) : null)
            : null);
        const postId =
          postIdFromFields ??
          (entityType === "post" ? entityId : null) ??
          null;
        const commentId =
          commentIdFromFields ??
          (entityType === "comment" ? entityId : null) ??
          null;
        if (!postId) continue;
        const postSnapshotHash = this.computePostSnapshotHash({
          postId,
          commentId: input.action === "comment" ? commentId : null,
          postRecord: row,
        });
        push({
          postId,
          commentId: input.action === "comment" ? commentId : null,
          authorId: null,
          source,
          postSnapshotHash,
        });
      }
      return resolved;
    };
    if (hasBridge) {
      await runLookupStep("notifications_priority", [
        {
          source: "notifications_unread",
          request: {
            action: "browse_notifications",
            unreadOnly: true,
            limit: 24,
          },
          parser: (value: unknown): EngagementTargetCandidate[] =>
            parseNotificationTargets(value, "notifications_unread"),
        },
        {
          source: "notifications_recent",
          request: {
            action: "browse_notifications",
            unreadOnly: false,
            limit: 24,
          },
          parser: (value: unknown): EngagementTargetCandidate[] =>
            parseNotificationTargets(value, "notifications_recent"),
        },
      ]);
    }

    if (typeof this.ctx.memory.buildContext === "function") {
      try {
        const request: ContextRequest = {
          mode: "engagement",
          audience: "runtime_write",
          maxRecentEvents: 80,
          maxArchiveEvents: 40,
          includeKeywordRetrieval: true,
          retrievalIntent: "engagement",
          retrievalMaxItems: 12,
          retrievalQuery: [
            input.action,
            hints.rawQuery,
            "target resolution",
          ]
            .filter((entry) => entry.trim().length > 0)
            .join(" · "),
        };
        const bundle = await this.ctx.memory.buildContext(request);
        const before = candidates.length;
        const envelopes = [
          ...(Array.isArray(bundle.target?.events) ? bundle.target.events : []),
          ...(Array.isArray(bundle.recent) ? bundle.recent : []),
          ...(Array.isArray(bundle.archive) ? bundle.archive : []),
        ];
        for (const envelope of envelopes) {
          if (!isRecord(envelope) || !isRecord(envelope.payload)) continue;
          pushCandidate(
            this.extractEngagementTargetCandidateFromRecord(
              envelope.payload,
              "memory_event",
            ),
          );
        }
        if (isRecord(bundle.retrieval) && Array.isArray(bundle.retrieval.lines)) {
          for (const line of bundle.retrieval.lines) {
            if (typeof line !== "string") continue;
            const parsedIds = this.parseTargetIdsFromTextLine(line);
            if (!parsedIds.postId) continue;
            pushCandidate({
              postId: parsedIds.postId,
              commentId: input.action === "comment" ? (parsedIds.commentId ?? null) : null,
              authorId: null,
              source: "memory_retrieval",
              postSnapshotHash: null,
            });
          }
        }
        if (
          isRecord(bundle.retrieval) &&
          Array.isArray(bundle.retrieval.lookupPlans)
        ) {
          for (const plan of bundle.retrieval.lookupPlans) {
            if (!isRecord(plan)) continue;
            const args = isRecord(plan.args) ? plan.args : null;
            if (!args) continue;
            const postId = asPositiveInt(args.postId);
            const commentId = asPositiveInt(args.commentId) ?? null;
            if (!postId) continue;
            pushCandidate({
              postId,
              commentId:
                input.action === "comment" ? (commentId ?? null) : null,
              authorId: null,
              source: "memory_lookup_plan",
              postSnapshotHash: null,
            });
          }
        }
        trace.push({
          step: "memory_context",
          queryCount: 1,
          cacheHits: 0,
          addedCandidates: candidates.length - before,
          totalCandidates: candidates.length,
        });
      } catch (error: unknown) {
        await this.ctx.memory
          .recordWrite({
            type: "engagement_target_lookup_failed",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            step: "memory_context",
            source: "memory",
            lookupAction: "buildContext",
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
      }
    }

    const hintPlans: LookupPlan[] = [];
    if (hintedPostId) {
      hintPlans.push({
        source: "hint_post_lookup",
        request: { action: "find_post", postId: hintedPostId },
      });
    }
    for (const handle of hints.handles.slice(0, 4)) {
      hintPlans.push({
        source: "hint_handle_latest",
        request: {
          action: "find_post",
          authorHandle: `@${handle}`,
          latest: true,
        },
      });
    }
    await runLookupStep("payload_hints", hintPlans);

    const mentionParser = (value: unknown): EngagementTargetCandidate[] => {
      const resolved: EngagementTargetCandidate[] = [];
      for (const row of this.collectBridgeRecordItems(value)) {
        const targetType = asNonEmptyString(row.targetType)?.toLowerCase() ?? "";
        if (targetType !== "post") continue;
        const targetId = asPositiveInt(row.targetId);
        if (!targetId) continue;
        const targetCommentId = asPositiveInt(row.targetCommentId) ?? null;
        const postSnapshotHash = this.computePostSnapshotHash({
          postId: targetId,
          commentId: input.action === "comment" ? targetCommentId : null,
          postRecord: row,
        });
        resolved.push({
          postId: targetId,
          commentId: input.action === "comment" ? targetCommentId : null,
          authorId: null,
          source: "unanswered_mention",
          postSnapshotHash,
        });
      }
      return resolved;
    };
    const discoveryTags = Array.from(
      new Set([...hints.interestTags, ...agentPreferenceTags]),
    ).slice(0, 8);
    const allowOwnLatestCommentLookup = this.shouldIncludeOwnLatestCommentLookup({
      rawQuery: hints.rawQuery,
      explicitPostId,
      explicitCommentId,
    });
    const ownCommentPlans: LookupPlan[] = [];
    if (input.action === "comment" && agentHandle && allowOwnLatestCommentLookup) {
      ownCommentPlans.push({
        source: "own_latest",
        request: {
          action: "find_post",
          authorHandle: `@${agentHandle}`,
          latest: true,
        },
      });
    }
    ownCommentPlans.push({
      source: "unanswered_mention",
      request: {
        action: "browse_unanswered_mentions",
        limit: 24,
        sinceHours: 24 * 14,
      },
      parser: mentionParser,
    });
    await runLookupStep("high_signal", ownCommentPlans);

    const interestLookupPlans: LookupPlan[] = [];
    if (discoveryTags.length > 0) {
      interestLookupPlans.push(
        {
          source: "interest_trending",
          request: {
            action: "browse_trending",
            limit: 24,
            tags: discoveryTags.slice(0, 8),
          },
        },
        {
          source: "interest_explore",
          request: {
            action: "browse_posts",
            limit: 24,
            tags: discoveryTags.slice(0, 8),
          },
        },
      );
      const interestSearchQuery = truncateText(
        [hints.rawQuery, ...discoveryTags.slice(0, 4)]
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
          .join(" "),
        220,
      );
      if (interestSearchQuery.length > 2) {
        interestLookupPlans.push({
          source: "interest_search",
          request: {
            action: "search_global",
            query: interestSearchQuery,
            limit: 24,
            includePeople: false,
          },
        });
      }
    }
    await runLookupStep("interest_discovery", interestLookupPlans);

    let topEngagerHandles: string[] = [];
    if (hasBridge) {
      const topEngagerResult = await this.callAgentBridgeLookupCached({
        action: "browse_top_engagers",
        limit: 10,
        windowHours: 24 * 14,
      }).catch((error: unknown) => {
        bridgeQueryFailureCount += 1;
        void this.ctx.memory
          .recordWrite({
            type: "engagement_target_lookup_failed",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            step: "browse_top_engagers",
            source: "browse_top_engagers",
            lookupAction: "browse_top_engagers",
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
        return null;
      });
      if (topEngagerResult) {
        bridgeQuerySuccessCount += 1;
        topEngagerHandles = this.collectBridgeRecordItems(topEngagerResult.value)
          .map((row) => {
            const user = isRecord(row.user) ? row.user : null;
            return asNonEmptyString(user?.handle) ?? asNonEmptyString(row.handle) ?? null;
          })
          .filter((entry): entry is string => Boolean(entry))
          .map((entry) => entry.replace(/^@+/u, "").toLowerCase())
          .slice(0, 4);
        trace.push({
          step: "browse_top_engagers",
          queryCount: 1,
          cacheHits: topEngagerResult.cacheHit ? 1 : 0,
          addedCandidates: 0,
          totalCandidates: candidates.length,
        });
      }
    }
    const topEngagerPlans: LookupPlan[] = topEngagerHandles.map((handle) => ({
      source: "top_engager_latest",
      request: {
        action: "find_post",
        authorHandle: `@${handle}`,
        latest: true,
      },
    }));
    topEngagerPlans.push({
      source: "recent_actions",
      request: {
        action: "browse_recent_actions",
        limit: 18,
      },
    });
    await runLookupStep("engagement_network", topEngagerPlans);

    const hasConfidentCandidate = (): boolean =>
      candidates.some((candidate) => {
        if (input.action === "comment") {
          return (
            candidate.source === "notifications_unread" ||
            candidate.source === "notifications_recent" ||
            candidate.source === "interest_trending" ||
            candidate.source === "interest_explore" ||
            candidate.source === "interest_search" ||
            candidate.source === "unanswered_mention"
          );
        }
        return (
          candidate.source === "notifications_unread" ||
          candidate.source === "notifications_recent" ||
          candidate.source === "interest_trending" ||
          candidate.source === "interest_explore" ||
          candidate.source === "interest_search" ||
          candidate.source === "unanswered_mention" ||
          candidate.source === "top_engager_latest" ||
          candidate.source === "recent_actions"
        );
      });

    if (!hasConfidentCandidate()) {
      await runLookupStep("broad_feed", [
        {
          source: "home_feed",
          request: { action: "browse_home_feed", limit: 24 },
        },
        {
          source: "trending",
          request: { action: "browse_trending", limit: 24 },
        },
        {
          source: "explore",
          request: { action: "browse_posts", limit: 24 },
        },
      ]);
    }

    if (!hasConfidentCandidate() && hints.rawQuery.trim().length > 2) {
      await runLookupStep("search_global", [
        {
          source: "search_global",
          request: {
            action: "search_global",
            query: truncateText(hints.rawQuery, 220),
            limit: 24,
          },
        },
      ]);
    }

    if (candidates.length === 0) {
      await this.ctx.memory
        .recordWrite({
          type: "engagement_target_resolution_failed",
          at: nowIso(),
          commandId: input.commandId,
          action: input.action,
          reason:
            bridgeQuerySuccessCount > 0
              ? "no_candidates_discovery_exhausted"
              : bridgeQueryFailureCount > 0
                ? "lookup_transient_failure"
                : hasBridge
                  ? "no_candidates_unknown"
                  : "bridge_unavailable",
          query: hints.rawQuery,
          bridgeQuerySuccessCount,
          bridgeQueryFailureCount,
          trace,
        })
        .catch(() => undefined);
      if (bridgeQuerySuccessCount > 0) {
        throw new Error("engagement_target_unavailable:no_targets_discovered");
      }
      return null;
    }

    const byTargetKey = new Map<string, EngagementTargetCandidate>();
    for (const candidate of candidates) {
      const key = `${candidate.postId}:${candidate.commentId ?? 0}`;
      byTargetKey.set(key, candidate);
    }
    const hydrationPool = [...byTargetKey.values()].slice(0, 10);
    await runLookupStep(
      "candidate_hydration",
      hydrationPool.map((candidate) => ({
        source: "hydrate_find_post",
        request: {
          action: "find_post",
          postId: candidate.postId,
        },
        parser: (value: unknown): EngagementTargetCandidate[] => {
          const postRecord = this.extractPostRecordForCommentCuration(value, candidate.postId);
          if (!postRecord) return [];
          const author = isRecord(postRecord.author) ? postRecord.author : null;
          const authorId =
            asNonEmptyString(author?.mainUserId) ??
            asNonEmptyString(author?.id) ??
            asNonEmptyString(postRecord.authorId) ??
            candidate.authorId;
          const postSnapshotHash = this.computePostSnapshotHash({
            postId: candidate.postId,
            commentId: candidate.commentId,
            postRecord,
          });
          return [
            {
              ...candidate,
              authorId,
              source: candidate.source,
              postSnapshotHash: postSnapshotHash ?? candidate.postSnapshotHash ?? null,
            },
          ];
        },
      })),
    );

    const preferredSourceOrderComment = new Map<string, number>([
      ["notifications_unread", 0],
      ["notifications_recent", 1],
      ["payload_hint", 2],
      ["memory_lookup_plan", 2],
      ["memory_retrieval", 2],
      ["unanswered_mention", 3],
      ["interest_trending", 4],
      ["interest_explore", 5],
      ["interest_search", 6],
      ["top_engager_latest", 7],
      ["recent_actions", 8],
      ["home_feed", 9],
      ["trending", 10],
      ["search_global", 11],
      ["explore", 12],
      ["memory_event", 13],
      ["own_latest", 14],
      ["directive_payload", 15],
    ]);
    const preferredSourceOrderEngagement = new Map<string, number>([
      ["notifications_unread", 0],
      ["notifications_recent", 1],
      ["payload_hint", 2],
      ["memory_lookup_plan", 2],
      ["unanswered_mention", 2],
      ["interest_trending", 3],
      ["interest_explore", 4],
      ["interest_search", 5],
      ["top_engager_latest", 6],
      ["recent_actions", 7],
      ["home_feed", 8],
      ["trending", 9],
      ["search_global", 10],
      ["explore", 11],
      ["memory_retrieval", 12],
      ["memory_event", 13],
      ["own_latest", 14],
      ["directive_payload", 15],
    ]);

    let candidatePool = [...candidates];
    if (input.action !== "comment") {
      const nonOwnCandidates = candidatePool.filter(
        (candidate) => !this.isOwnEngagementCandidate(candidate, agentMainUserId),
      );
      if (nonOwnCandidates.length === 0) {
        await this.ctx.memory
          .recordWrite({
            type: "engagement_target_resolution_failed",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            reason: "self_candidates_only",
            query: hints.rawQuery,
            bridgeQuerySuccessCount,
            bridgeQueryFailureCount,
            trace,
          })
          .catch(() => undefined);
        throw new Error("engagement_target_unavailable:no_targets_discovered:self_candidates_only");
      }
      candidatePool = nonOwnCandidates;
    }
    if (input.action === "comment") {
      const allowedCandidates: EngagementTargetCandidate[] = [];
      const filteredRecent: Array<{
        postId: number;
        commentId: number | null;
        source: string;
        reason: string;
        postSnapshotHash: string | null;
        recentPostSnapshotHash: string | null;
      }> = [];
      for (const candidate of candidatePool) {
        const reuseDecision = this.decideCommentTargetReuse({
          commandId: input.commandId,
          postId: candidate.postId,
          commentId: candidate.commentId ?? null,
          postSnapshotHash: candidate.postSnapshotHash ?? null,
          source: candidate.source,
          recentUsage: recentCommentUsage,
        });
        if (reuseDecision.allow) {
          allowedCandidates.push(candidate);
          continue;
        }
        filteredRecent.push({
          postId: candidate.postId,
          commentId: candidate.commentId ?? null,
          source: candidate.source,
          reason: reuseDecision.reason,
          postSnapshotHash: candidate.postSnapshotHash ?? null,
          recentPostSnapshotHash: reuseDecision.recentMatch?.postSnapshotHash ?? null,
        });
      }
      if (allowedCandidates.length === 0) {
        await this.ctx.memory
          .recordWrite({
            type: "engagement_target_resolution_failed",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            reason: "recent_comment_target_reuse_blocked",
            query: hints.rawQuery,
            bridgeQuerySuccessCount,
            bridgeQueryFailureCount,
            filteredRecentTargets: filteredRecent.slice(0, 8),
            trace,
          })
          .catch(() => undefined);
        throw new Error(
          "engagement_target_unavailable:no_targets_discovered:recent_comment_target_reuse_blocked",
        );
      }
      if (filteredRecent.length > 0) {
        await this.ctx.memory
          .recordWrite({
            type: "engagement_target_filtered_recent_comment_target",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            filteredCount: filteredRecent.length,
            keptCount: allowedCandidates.length,
            filtered: filteredRecent.slice(0, 8),
            query: hints.rawQuery,
          })
          .catch(() => undefined);
      }
      candidatePool = allowedCandidates;
    }

    const rankTable =
      input.action === "comment"
        ? preferredSourceOrderComment
        : preferredSourceOrderEngagement;
    const hasNonOwnCandidate =
      input.action === "comment"
        ? candidatePool.some(
            (candidate) =>
              !this.isOwnEngagementCandidate(candidate, agentMainUserId),
          )
        : false;
    const scoreCandidate = (candidate: EngagementTargetCandidate): number => {
      const sourceRank = rankTable.get(candidate.source) ?? 999;
      const isOwn = this.isOwnEngagementCandidate(candidate, agentMainUserId);
      const ownBias =
        input.action === "comment"
          ? isOwn
            ? candidate.commentId
              ? 8
              : hasNonOwnCandidate
                ? -420
                : -260
            : 36
          : isOwn
            ? -140
            : 40;
      const commentBias =
        input.action === "comment" && candidate.commentId ? 26 : 0;
      return 10_000 - sourceRank * 120 + ownBias + commentBias + (candidate.postId % 17);
    };
    candidatePool.sort((a, b) => {
      const delta = scoreCandidate(b) - scoreCandidate(a);
      if (delta !== 0) return delta;
      if (a.postId !== b.postId) return b.postId - a.postId;
      const aComment = a.commentId ?? 0;
      const bComment = b.commentId ?? 0;
      return bComment - aComment;
    });
    let selected = candidatePool[0] ?? null;
    if (!selected) return null;

    if (input.action === "comment" && !selected.commentId) {
      const selectedPostId = selected.postId;
      try {
        const commentLookup = await this.callAgentBridgeLookupCached({
          action: "browse_comments",
          postId: selectedPostId,
          limit: 12,
        });
        const commentRecords = this.collectBridgeRecordItems(commentLookup.value)
          .map((entry) => {
            const postId = asPositiveInt(entry.postId);
            const commentId = asPositiveInt(entry.commentId) ?? asPositiveInt(entry.id);
            if (!postId || postId !== selectedPostId || !commentId) return null;
            const author = isRecord(entry.author) ? entry.author : null;
            const authorId =
              asNonEmptyString(author?.mainUserId) ??
              asNonEmptyString(author?.id) ??
              asNonEmptyString(entry.authorId) ??
              null;
            const createdAtRaw =
              asNonEmptyString(entry.createdAt) ??
              asNonEmptyString(entry.created_at);
            const createdAtMs = createdAtRaw ? Date.parse(createdAtRaw) : NaN;
            return {
              commentId,
              authorId,
              createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : -1,
            };
          })
          .filter(
            (
              value,
            ): value is { commentId: number; authorId: string | null; createdAtMs: number } =>
              Boolean(value),
          )
          .filter((value) => !agentMainUserId || value.authorId !== agentMainUserId)
          .sort((a, b) => b.createdAtMs - a.createdAtMs);
        if (commentRecords.length > 0) {
          selected = {
            ...selected,
            commentId: commentRecords[0]?.commentId ?? null,
            source: `${selected.source}+comment_thread`,
          };
        }
      } catch {
        // best-effort parent comment enrichment only
      }
    }

    if (input.action === "comment") {
      const commentAuthorById = new Map<number, string | null>();
      const isAllowedOwnReplyCandidate = async (
        candidate: EngagementTargetCandidate,
      ): Promise<boolean> => {
        if (!agentMainUserId) return true;
        if (!this.isOwnEngagementCandidate(candidate, agentMainUserId)) return true;
        if (!candidate.commentId) return true;
        const cached = commentAuthorById.get(candidate.commentId);
        if (cached !== undefined) {
          return cached !== agentMainUserId;
        }
        const resolvedAuthorId = await this.resolveCommentAuthorIdForTarget({
          postId: candidate.postId,
          commentId: candidate.commentId,
        });
        commentAuthorById.set(candidate.commentId, resolvedAuthorId);
        return resolvedAuthorId !== agentMainUserId;
      };
      if (
        agentMainUserId &&
        this.isOwnEngagementCandidate(selected, agentMainUserId) &&
        typeof selected.commentId === "number" &&
        selected.commentId > 0
      ) {
        const selectedAllowed = await isAllowedOwnReplyCandidate(selected);
        if (!selectedAllowed) {
          let fallback: EngagementTargetCandidate | null = null;
          for (const candidate of candidatePool) {
            if (
              candidate.postId === selected.postId &&
              candidate.commentId === selected.commentId
            ) {
              continue;
            }
            if (!(await isAllowedOwnReplyCandidate(candidate))) continue;
            fallback = candidate;
            break;
          }
          if (fallback) {
            await this.ctx.memory
              .recordWrite({
                type: "engagement_target_filtered_self_own_comment_reply",
                at: nowIso(),
                commandId: input.commandId,
                action: input.action,
                postId: selected.postId,
                commentId: selected.commentId,
                source: selected.source,
                reason: "fallback_to_non_self_parent",
                fallbackPostId: fallback.postId,
                fallbackCommentId: fallback.commentId,
                fallbackSource: fallback.source,
                query: hints.rawQuery,
              })
              .catch(() => undefined);
            selected = fallback;
          } else {
            await this.ctx.memory
              .recordWrite({
                type: "engagement_target_filtered_self_own_comment_reply",
                at: nowIso(),
                commandId: input.commandId,
                action: input.action,
                postId: selected.postId,
                commentId: selected.commentId,
                source: selected.source,
                reason: "no_fallback",
                query: hints.rawQuery,
              })
              .catch(() => undefined);
            throw new Error(
              "engagement_target_unavailable:no_targets_discovered:self_own_comment_reply_filtered",
            );
          }
        }
      }
      const selectedIsOwn = this.isOwnEngagementCandidate(selected, agentMainUserId);
      if (selectedIsOwn && !selected.commentId) {
        const selectedPostId = selected.postId;
        const selectedCommentId = selected.commentId;
        const rareAllowance = this.shouldAllowRareTopLevelSelfComment({
          commandId: input.commandId,
          postId: selectedPostId,
          rawQuery: hints.rawQuery,
        });
        const fallback = candidatePool.find((candidate) => {
          if (candidate.postId === selectedPostId && candidate.commentId === selectedCommentId) {
            return false;
          }
          const candidateIsOwn = this.isOwnEngagementCandidate(
            candidate,
            agentMainUserId,
          );
          if (candidateIsOwn && !candidate.commentId) return false;
          return true;
        });
        if (fallback) {
          await this.ctx.memory
            .recordWrite({
              type: "engagement_target_filtered_self_root_comment",
              at: nowIso(),
              commandId: input.commandId,
              action: input.action,
              postId: selected.postId,
              source: selected.source,
              reason: "fallback_to_non_self_or_thread",
              gateRoll: rareAllowance.gateRoll,
              fallbackPostId: fallback.postId,
              fallbackCommentId: fallback.commentId,
              fallbackSource: fallback.source,
              query: hints.rawQuery,
            })
            .catch(() => undefined);
          selected = fallback;
        } else if (!rareAllowance.allow) {
          await this.ctx.memory
            .recordWrite({
              type: "engagement_target_filtered_self_root_comment",
              at: nowIso(),
              commandId: input.commandId,
              action: input.action,
              postId: selected.postId,
              source: selected.source,
              reason: rareAllowance.reason,
              gateRoll: rareAllowance.gateRoll,
              query: hints.rawQuery,
            })
            .catch(() => undefined);
          throw new Error(
            "engagement_target_unavailable:no_targets_discovered:self_root_comment_filtered",
          );
        } else if (rareAllowance.allow) {
          await this.ctx.memory
            .recordWrite({
              type: "engagement_target_allowed_self_root_comment",
              at: nowIso(),
              commandId: input.commandId,
              action: input.action,
              postId: selected.postId,
              source: selected.source,
              reason: rareAllowance.reason,
              gateRoll: rareAllowance.gateRoll,
              query: hints.rawQuery,
            })
            .catch(() => undefined);
        }
      }
    }

    if (input.action === "comment") {
      const selectedTarget = selected;
      if (!selectedTarget) return null;
      const selectedReuseDecision = this.decideCommentTargetReuse({
        commandId: input.commandId,
        postId: selectedTarget.postId,
        commentId: selectedTarget.commentId ?? null,
        postSnapshotHash: selectedTarget.postSnapshotHash ?? null,
        source: selectedTarget.source,
        recentUsage: recentCommentUsage,
      });
      if (!selectedReuseDecision.allow) {
        const fallback = candidatePool.find((candidate) => {
          if (candidate.postId === selectedTarget.postId) return false;
          if (
            agentMainUserId &&
            this.isOwnEngagementCandidate(candidate, agentMainUserId) &&
            !candidate.commentId
          ) {
            return false;
          }
          const reuseDecision = this.decideCommentTargetReuse({
            commandId: input.commandId,
            postId: candidate.postId,
            commentId: candidate.commentId ?? null,
            postSnapshotHash: candidate.postSnapshotHash ?? null,
            source: candidate.source,
            recentUsage: recentCommentUsage,
          });
          return reuseDecision.allow;
        });
        if (fallback) {
          await this.ctx.memory
            .recordWrite({
              type: "engagement_target_filtered_recent_comment_target",
              at: nowIso(),
              commandId: input.commandId,
              action: input.action,
              filteredCount: 1,
              keptCount: 1,
              filtered: [
                {
                  postId: selectedTarget.postId,
                  commentId: selectedTarget.commentId ?? null,
                  source: selectedTarget.source,
                  reason: selectedReuseDecision.reason,
                  postSnapshotHash: selectedTarget.postSnapshotHash ?? null,
                  recentPostSnapshotHash:
                    selectedReuseDecision.recentMatch?.postSnapshotHash ?? null,
                },
              ],
              fallbackPostId: fallback.postId,
              fallbackCommentId: fallback.commentId ?? null,
              fallbackSource: fallback.source,
              query: hints.rawQuery,
            })
            .catch(() => undefined);
          selected = fallback;
        } else {
          await this.ctx.memory
            .recordWrite({
              type: "engagement_target_resolution_failed",
              at: nowIso(),
              commandId: input.commandId,
              action: input.action,
              reason: "recent_comment_target_reuse_blocked_after_thread_resolution",
              query: hints.rawQuery,
              bridgeQuerySuccessCount,
              bridgeQueryFailureCount,
              selectedPostId: selectedTarget.postId,
              selectedCommentId: selectedTarget.commentId ?? null,
              selectedSource: selectedTarget.source,
              selectedPostSnapshotHash: selectedTarget.postSnapshotHash ?? null,
              selectedReason: selectedReuseDecision.reason,
              recentPostSnapshotHash:
                selectedReuseDecision.recentMatch?.postSnapshotHash ?? null,
              trace,
            })
            .catch(() => undefined);
          throw new Error(
            "engagement_target_unavailable:no_targets_discovered:recent_comment_target_reuse_blocked",
          );
        }
      }
    }

    const resolved = {
      ...selected,
      commentId: input.action === "comment" ? (selected.commentId ?? null) : null,
    };
    this.engagementTargetCache.set(cacheKey, {
      expiresAtMs: Date.now() + ENGAGEMENT_TARGET_CACHE_TTL_MS,
      candidate: resolved,
    });
    this.pruneEngagementTargetCache(Date.now());
    await this.ctx.memory
      .recordWrite({
        type: "engagement_target_resolved",
        at: nowIso(),
        commandId: input.commandId,
        action: input.action,
        postId: resolved.postId,
        commentId: resolved.commentId,
        source: resolved.source,
        postSnapshotHash: resolved.postSnapshotHash ?? null,
        query: hints.rawQuery,
        candidatesConsidered: candidatePool.length,
        trace,
      })
      .catch(() => undefined);
    return resolved;
  }

  private mapAllowedWriteKindToGenerateKind(commandKind: string): string | null {
    return _mapWriteKindToGenKind(commandKind);
  }

  private resolveDirectiveScopeGenerateKinds(payload: Record<string, unknown>): string[] {
    return _resolveDirectiveGenKinds(payload);
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

  private normalizeRequestedGenerateKind(value: unknown): string | null {
    return _normalizeGenKind(value);
  }

  private resolveRequestedGenerateKinds(
    payload: Record<string, unknown>,
    fallbackKind: string,
  ): string[] {
    return _resolveGenKinds(payload, fallbackKind);
  }

  private isExplicitMultiMediaRequest(payload: Record<string, unknown>): boolean {
    return _isMultiMedia(payload);
  }

  private parsePermissionCanState(permissionState: unknown): {
    hasHints: boolean;
    can: {
      postMedia: boolean;
      postText: boolean;
      story: boolean;
      comment: boolean;
      like: boolean;
      repost: boolean;
      imageGenerate: boolean;
      textGenerate: boolean;
    };
  } {
    return _parsePermissionCan(permissionState);
  }

  private constrainGenerateKindsByPermissionState(
    kinds: string[],
    permissionState: unknown,
  ): string[] {
    return _constrainByPermission(kinds, permissionState);
  }

  private applyPermissionGenerateInputConstraints(
    generateInput: Record<string, unknown>,
    permissionState: unknown,
  ): Record<string, unknown> {
    return _applyPermissionConstraints(generateInput, permissionState);
  }

  private isGeneratedDraftAllowedByPermissionState(
    draft: GeneratedDraft,
    permissionState: unknown,
  ): boolean {
    return _isDraftAllowed(draft, permissionState);
  }

  private mapGoalToGenerateKind(goal: string): string {
    return _mapGoalToKind(goal);
  }

  private resolveEnforcedDraftAction(
    payload: Record<string, unknown>,
  ): "comment" | "like" | "repost" | null {
    return _resolveEnforcedAction(payload);
  }

  private extractInlineDrafts(payload: Record<string, unknown>): GeneratedDraft[] {
    return _extractInlineDrafts(payload);
  }

  private extractGeneratedDrafts(generatedResult: unknown): GeneratedDraft[] {
    return _extractGenDrafts(generatedResult);
  }

  private isPersonaMediaCompatibleDraft(draft: GeneratedDraft): boolean {
    return _isPersonaMediaDraft(draft);
  }

  private buildPersonaLockedMediaFallbackDraft(input: {
    payload: Record<string, unknown>;
    drafts: GeneratedDraft[];
  }): GeneratedDraft | null {
    return _buildPersonaFallbackDraft(input);
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

  private async resolveLocalReferencePath(reference: string): Promise<string | null> {
    return _resolveLocalRef(reference);
  }

  private async materializeMediaReferenceFiles(input: {
    requestDir: string;
    referenceInputs: string[];
    maxReferenceInputs?: number;
  }): Promise<string[]> {
    return _materializeMediaRefs(input);
  }

  private async resolveMediaUpload(input: {
    payload: Record<string, unknown>;
    keepOriginal?: boolean;
    promptFallbacks: Array<string | null>;
    command?: Command;
    skipPromptCuration?: boolean;
  }): Promise<ResolvedMediaUpload> {
    const isRecoverableMediaSourceFailure = (error: unknown): boolean => {
      if (!(error instanceof Error)) return false;
      const message = error.message.trim().toLowerCase();
      return (
        message.includes("only image and video uploads are supported") ||
        message.includes("unsupported_media_payload_mime:") ||
        message.includes("invalid data uri") ||
        message.includes("invalid_data_uri") ||
        message.includes("empty media data") ||
        message.includes("media_source_empty") ||
        message.includes("no_media_url")
      );
    };
    const tryUploadSource = async (
      source: string,
      sourceKey: string,
    ): Promise<ResolvedMediaUpload | null> => {
      try {
        return await this.uploadResolvedMediaSource(source, { keepOriginal });
      } catch (error: unknown) {
        if (!isRecoverableMediaSourceFailure(error)) {
          throw error;
        }
        if (input.command) {
          await this.ctx.memory
            .recordWrite({
              type: "media_source_skipped",
              at: nowIso(),
              commandId: input.command.id,
              source: sourceKey,
              error: error instanceof Error ? error.message : String(error),
            })
            .catch(() => undefined);
        }
        return null;
      }
    };
    const payload = input.payload;
    const keepOriginal = input.keepOriginal === true;
    const skipPromptCuration =
      input.skipPromptCuration === true ||
      (input.command ? this.isDirectiveContextLinkedCommand(input.command) : false);
    const markUploaded = async (
      result: ResolvedMediaUpload,
      source: string,
    ): Promise<ResolvedMediaUpload> => {
      if (input.command) {
        await this.recordCommandLifecycleCheckpoint({
          command: input.command,
          stage: "uploaded",
          status: "ok",
          metadata: {
            source,
            mediaUrl: result.mediaUrl,
            mediaType: result.mediaType ?? null,
          },
        });
      }
      return result;
    };
    const existingMediaUrl = asNonEmptyString(payload.mediaUrl);
    if (existingMediaUrl) {
      const resolved = await tryUploadSource(existingMediaUrl, "payload.mediaUrl");
      if (resolved) return markUploaded(resolved, "payload.mediaUrl");
    }

    const mediaItems = Array.isArray(payload.mediaItems) ? payload.mediaItems : [];
    for (let index = 0; index < mediaItems.length; index += 1) {
      const mediaItem = mediaItems[index];
      if (!isRecord(mediaItem)) continue;
      const mediaUrl = asNonEmptyString(mediaItem.mediaUrl);
      if (mediaUrl) {
        const resolved = await tryUploadSource(
          mediaUrl,
          `payload.mediaItems[${index}].mediaUrl`,
        );
        if (resolved) return markUploaded(resolved, "payload.mediaItems");
      }
    }

    const prompt =
      input.promptFallbacks.find((entry) => typeof entry === "string" && entry.trim().length > 0) ??
      null;
    if (!prompt) {
      throw new Error("missing_media_input");
    }
    const fallbackReferenceInputs = this.collectMediaReferenceInputs(payload);
    try {
      let referenceInputs = fallbackReferenceInputs;
      if (input.command) {
        const personaReferences = await this.resolvePersonaFrameReferences({
          payload,
          command: input.command,
          fallbackReferenceInputs,
        });
        if (
          personaReferences.personaSlug !== null &&
          personaReferences.frameReferences.length < REQUIRED_PERSONA_REFERENCE_FRAME_COUNT
        ) {
          throw new Error(
            `persona_reference_setup_required:${personaReferences.personaSlug}`,
          );
        }
        referenceInputs =
          personaReferences.personaSlug !== null
            ? personaReferences.frameReferences
            : fallbackReferenceInputs;
      }
      const requestedGeneratedAssetType = this.resolveGeneratedAssetType(
        payload.generatedAssetType,
      );
      const generatedAssetType =
        requestedGeneratedAssetType === "gif" ? "gif" : "image";
      const generated = await this.generateAndUploadMediaFromPrompt(prompt, {
        generatedAssetType,
        mode: "write_media_generate",
        referenceInputs,
        keepOriginal,
        commandId: input.command?.id ?? null,
        skipPromptCuration,
      });
      return markUploaded(generated, "generated_prompt");
    } catch (error: unknown) {
      if (input.command) {
        const deferred = this.classifyMediaGenerationDeferral({
          error,
          hasPrompt: true,
        });
        if (deferred.shouldRequeue && deferred.reason) {
          const message = error instanceof Error ? error.message : String(error);
          await this.recordCommandLifecycleCheckpoint({
            command: input.command,
            stage: "generated",
            status: "failed",
            message,
            metadata: {
              requeued: true,
              reason: deferred.reason,
              reasonCode: deferred.reasonCode,
              personaSlug: deferred.personaSlug,
              source: "resolve_media_upload",
            },
          });
          await this.ctx.memory
            .recordWrite({
              type: "media_generation_deferred_for_setup",
              at: nowIso(),
              commandId: input.command.id,
              reason: deferred.reason,
              reasonCode: deferred.reasonCode,
              personaSlug: deferred.personaSlug,
              error: message,
            })
            .catch(() => undefined);
          throw new RequeueCommandError(deferred.reason);
        }
      }
      throw error;
    }
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

  private async uploadBytesViaChunkRoute(input: {
    bytes: Buffer;
    mimeType: string;
    filename: string;
    keepOriginal?: boolean;
  }): Promise<ResolvedMediaUpload | null> {
    return _uploadViaChunk(
      { callAgentUploadChunk: this.ctx.callAgentUploadChunk ?? null, memory: this.ctx.memory },
      input,
    );
  }

  private isTransientMediaArtifactFileName(value: string | null | undefined): boolean {
    return _isTransientArtifact(value);
  }

  private isStreamPartArtifactReference(value: string | null | undefined): boolean {
    return _isStreamPartRef(value);
  }

  private resolvePreferredMediaUrl(
    ...values: Array<string | null | undefined>
  ): string | null {
    return _resolvePreferredUrl(...values);
  }

  private mapUploadResult(uploaded: unknown): ResolvedMediaUpload {
    return _mapUploadResult(uploaded);
  }

  private normalizeCuratedMediaPrompt(value: string): string {
    return _normalizeMediaPrompt(value);
  }

  private extractCuratedMediaPromptFromUnknown(value: unknown): string | null {
    return _extractMediaPrompt(value);
  }

  private buildMediaPromptCurationRequest(input: {
    sourcePrompt: string;
    generatedAssetType: GeneratedAssetType;
    mode: string;
  }): string {
    return _buildMediaCurationReq(input);
  }

  private async curateMediaPromptWithOpenClaw(input: {
    sourcePrompt: string;
    generatedAssetType: GeneratedAssetType;
    mode: string;
  }): Promise<string> {
    return _curateMediaPromptWithOC(
      { runOpenClawPrompt: this.ctx.runOpenClawPrompt ?? null, memory: this.ctx.memory },
      input,
    );
  }

  private extractMediaGeneratorContextId(payload: unknown): string | null {
    return _extractMediaGenCtxId(payload);
  }

  private extractMediaGeneratorContextRecord(payload: unknown): Record<string, unknown> | null {
    return _extractMediaGenCtxRecord(payload);
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
    const sourcePrompt = prompt.trim();
    if (!sourcePrompt.length) {
      throw new Error("missing_prompt");
    }
    const generatedAssetType = opts?.generatedAssetType ?? "image";
    const mode = opts?.mode ?? "media_generation";
    const streamEnabled =
      generatedAssetType === "image" && /^chat_/iu.test(mode);
    const commandId = asNonEmptyString(opts?.commandId) ?? null;
    const skipPromptCuration = opts?.skipPromptCuration === true;
    this.pruneCuratedPromptCaches();
    let curatedPromptBase: string;
    if (skipPromptCuration) {
      curatedPromptBase = sourcePrompt;
    } else {
      const cacheKey = commandId
        ? this.buildCuratedMediaPromptCacheKey({
            commandId,
            sourcePrompt,
            generatedAssetType,
            mode,
          })
        : null;
      const cached = cacheKey ? this.curatedMediaPromptCache.get(cacheKey) : null;
      if (cached) {
        curatedPromptBase = cached.prompt;
      } else {
        curatedPromptBase = await this.curateMediaPromptWithOpenClaw({
          sourcePrompt,
          generatedAssetType,
          mode,
        });
        if (cacheKey) {
          this.curatedMediaPromptCache.set(cacheKey, {
            prompt: curatedPromptBase,
            cachedAtMs: Date.now(),
          });
        }
      }
    }
    const curatedPrompt =
      generatedAssetType === "gif"
        ? constrainGifPromptTo256(curatedPromptBase)
        : curatedPromptBase;
    const useFileGenerator = generatedAssetType !== "image";
    const template = useFileGenerator
      ? this.ctx.config.fileGenerateCmd
      : this.ctx.config.imageGenerateCmd;
    if (!template?.trim().length) {
      throw new Error(
        useFileGenerator
          ? "file_generator_unconfigured"
          : "image_generator_unconfigured",
      );
    }
    const requestDir = path.join(
      this.ctx.ipcPaths.generatedDir,
      `generate-${Date.now()}-${crypto.randomUUID()}`,
    );
    await ensureDir(requestDir);

    const promptFilePath = path.join(requestDir, "prompt.txt");
    const outputPath = path.join(
      requestDir,
      `output.${outputExtensionForGeneratedAssetType(generatedAssetType)}`,
    );
    await fs.writeFile(promptFilePath, `${curatedPrompt}\n`, "utf8").catch(() => undefined);
    const referenceInputs = Array.isArray(opts?.referenceInputs)
      ? opts.referenceInputs.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
        )
      : [];
    const referenceFiles = await this.materializeMediaReferenceFiles({
      requestDir,
      referenceInputs,
      ...(typeof opts?.maxReferenceInputs === "number"
        ? { maxReferenceInputs: opts.maxReferenceInputs }
        : {}),
    });

    const refs =
      process.platform === "win32"
        ? {
            prompt: "%MG_IMAGE_PROMPT%",
            dir: "%MG_IMAGE_PROMPT_DIR%",
            output: "%MG_IMAGE_OUTPUT%",
            promptFile: "%MG_IMAGE_PROMPT_FILE%",
            files: "%MG_IMAGE_FILES%",
            type: "%MG_IMAGE_TYPE%",
          }
        : {
            prompt: "$MG_IMAGE_PROMPT",
            dir: "$MG_IMAGE_PROMPT_DIR",
            output: "$MG_IMAGE_OUTPUT",
            promptFile: "$MG_IMAGE_PROMPT_FILE",
            files: "$MG_IMAGE_FILES",
            type: "$MG_IMAGE_TYPE",
          };
    let command = template
      .replaceAll("{prompt}", refs.prompt)
      .replaceAll("{dir}", refs.dir)
      .replaceAll("{output}", refs.output)
      .replaceAll("{prompt_file}", refs.promptFile)
      .replaceAll("{files}", refs.files)
      .replaceAll("{type}", refs.type)
      .trim();
    if (referenceFiles.length === 0) {
      command = stripEmptyFilesFlag(command, refs.files);
    }
    if (!command.includes(refs.prompt)) {
      command = `${command} "${refs.prompt}"`.trim();
    }

    await this.ctx.memory.recordWrite({
      type: "image_generation_invoked",
      at: nowIso(),
      provider: "command",
      mode,
      generatedAssetType,
      sourcePromptChars: sourcePrompt.length,
      promptChars: curatedPrompt.length,
      referenceInputCount: referenceInputs.length,
      referenceFileCount: referenceFiles.length,
      commandPreview: command.slice(0, 240),
    }).catch(() => undefined);

    const serviceRun = await this.runMediaGeneratorViaHttp({
      prompt: curatedPrompt,
      generatedAssetType,
      requestDir,
      referenceFiles,
      timeoutMs: this.ctx.config.imageGenerateTimeoutMs,
      stream: streamEnabled,
      onProgress: streamEnabled ? opts?.onProgress : undefined,
    });
    const execResult = serviceRun
      ? {
          ok: true,
          stdout: JSON.stringify(serviceRun.payload),
          stderr: "",
          error: null,
          timedOut: serviceRun.timedOut,
        }
      : await this.runShellCommand(command, {
          MG_IMAGE_PROMPT: curatedPrompt,
          MG_IMAGE_PROMPT_DIR: requestDir,
          MG_IMAGE_OUTPUT: outputPath,
          MG_IMAGE_PROMPT_FILE: promptFilePath,
          MG_IMAGE_FILES: referenceFiles.join(","),
          MG_IMAGE_TYPE: generatedAssetType,
        });
    if (!execResult.ok) {
      const reason = execResult.timedOut
        ? `image_generation_timeout_after_${this.ctx.config.imageGenerateTimeoutMs}ms`
        : execResult.error ?? execResult.stderr ?? "image_generation_failed";
      await this.ctx.memory.recordWrite({
        type: "image_generation_failed",
        at: nowIso(),
        provider: "command",
        reason: String(reason).slice(0, 600),
      }).catch(() => undefined);
      throw new Error(String(reason));
    }

    const parsedGeneratorOutput = parseJsonFromMixedText(execResult.stdout);
    const hadGenerationActivity = this.didMediaGenerationProduceActivity(parsedGeneratorOutput);
    const resolvedSource = await this.resolveGeneratedMediaSourceWithRetry({
      requestDir,
      outputPath,
      stdout: execResult.stdout,
      maxWaitMs: Math.min(
        30_000,
        Math.max(3_000, Math.floor(this.ctx.config.imageGenerateTimeoutMs / 10)),
      ),
      requireFinalStreamFrame: generatedAssetType === "image" && streamEnabled,
    });
    if (!resolvedSource) {
      if (!hadGenerationActivity) {
        throw new Error("no_media_url_without_generation_activity");
      }
      throw new Error("no_media_url");
    }
    try {
      return await this.uploadResolvedMediaSource(resolvedSource, {
        keepOriginal: opts?.keepOriginal === true,
      });
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        throw error;
      }
      await this.ctx.memory
        .recordWrite({
          type: "image_generation_source_missing_retrying",
          at: nowIso(),
          mode,
          generatedAssetType,
          sourcePreview: truncateText(resolvedSource, 260),
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      const retrySource = await this.resolveGeneratedMediaSourceWithRetry({
        requestDir,
        outputPath,
        stdout: execResult.stdout,
        maxWaitMs: 12_000,
        requireFinalStreamFrame: generatedAssetType === "image" && streamEnabled,
      });
      if (!retrySource) {
        throw error;
      }
      return this.uploadResolvedMediaSource(retrySource, {
        keepOriginal: opts?.keepOriginal === true,
      });
    }
  }

  private async resolveGeneratedMediaSourceWithRetry(input: {
    requestDir: string;
    outputPath: string;
    stdout: string;
    maxWaitMs: number;
    requireFinalStreamFrame?: boolean;
  }): Promise<string | null> {
    return _resolveMediaSourceRetry(input);
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

  private async runShellCommand(
    command: string,
    extraEnv: Record<string, string>,
  ): Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    error: string | null;
    timedOut: boolean;
  }> {
    return _runShellCommand(this.ctx.config.imageGenerateTimeoutMs, command, extraEnv);
  }

  private buildDeterministicChatClientMessageId(input: {
    prefix: string;
    stableKey: string;
  }): string {
    return _buildChatMsgId(input);
  }

  private resolveChatProcessingClientMessageId(command: Command): string | null {
    return _resolveChatProcessingMsgId(command);
  }

  private buildChatProcessingIndicator(command: Command): {
    body: string;
    metadata: Record<string, unknown>;
  } | null {
    return _buildChatIndicator(command);
  }

  private async emitChatProcessingIndicator(command: Command): Promise<boolean> {
    return _emitChatProcessing(
      { callAgentChatBridge: this.ctx.callAgentChatBridge ?? null, memory: this.ctx.memory },
      command,
    );
  }

  private sanitizeUserFacingCommandErrorMessage(input: {
    errorMessage: string;
  }): string {
    return _sanitizeErrorMsg(input);
  }

  private buildNonWriteChatCompletion(input: {
    command: Command;
    outcome: CommandOutcome;
  }): { body: string; metadata: Record<string, unknown> } | null {
    return _buildNonWriteCompletion(input);
  }

  private buildDraftPreviewPayload(drafts: GeneratedDraft[]): DraftPreviewPayload | null {
    return _buildDraftPreview(drafts);
  }

  private async sendDraftPreviewMessage(input: {
    payload: Record<string, unknown>;
    preview: DraftPreviewPayload;
  }): Promise<boolean> {
    return _sendDraftPreview(this.ctx.callAgentChatBridge ?? null, input);
  }

  private async sendDraftFailureMessage(input: {
    payload: Record<string, unknown>;
    message: string;
  }): Promise<boolean> {
    return _sendDraftFailure(this.ctx.callAgentChatBridge ?? null, input);
  }

  private async updateAvatar(
    input: Record<string, unknown> & { target: string; imageUrl: string },
  ): Promise<unknown> {
    return await this.agent().updateAvatar.mutate(input);
  }

  private async updateBanner(
    input: Record<string, unknown> & { target: string; bannerUrl: string },
  ): Promise<unknown> {
    return await this.agent().updateBanner.mutate(input);
  }

  // ---------------------------------------------------------------------------
  // Review command – content moderation review via LLM
  // ---------------------------------------------------------------------------

  private async executeReview(command: Command): Promise<CommandOutcome> {
    return _executeReview(
      {
        memory: this.ctx.memory,
        runOpenClawPrompt: this.ctx.runOpenClawPrompt ?? null,
        submitReview: (input) => this.agent().submitReview.mutate(input),
      },
      command,
    );
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
        ackDirectiveForOutcome: (cmd, out) => this.ackDirectiveForOutcome(cmd, out),
      },
      input,
    );
  }

  private async ackDirectiveForOutcome(command: Command, outcome: CommandOutcome): Promise<void> {
    return _ackDirective({
      command,
      outcome,
      trpc: this.ctx.trpc,
      recordCheckpoint: (i) => this.recordCommandLifecycleCheckpoint(i),
    });
  }

  private async writeOutcome(outcome: CommandOutcome): Promise<void> {
    return _writeOutcome(this.ctx.ipcPaths.resultsPath, outcome);
  }

  private async markQueueItemNotReadyByInbox(
    inboxFile: string,
    reason: string,
  ): Promise<void> {
    return _markNotReady(this.ctx, inboxFile, reason);
  }

  private resolveEngagementActionForCommand(command: Command): "comment" | "like" | "repost" | null {
    return _resolveEngagementAction(command, (p) => this.resolveEnforcedDraftAction(p));
  }

  private async primeCommandContextForRequeue(
    command: Command,
    reason: string,
  ): Promise<void> {
    return _primeRequeueCtx(
      {
        memory: this.ctx.memory,
        callAgentChatBridge: this.ctx.callAgentChatBridge ?? null,
        resolveEngagementActionForCommand: (cmd) => this.resolveEngagementActionForCommand(cmd),
        callAgentBridgeLookupCached: (req, ttl) => this.callAgentBridgeLookupCached(req, ttl),
        engagementTargetCache: this.engagementTargetCache,
      },
      command,
      reason,
    );
  }

  private async markQueueItemCompletedByInbox(
    inboxFile: string,
    status: "done" | "failed" | "missing",
    error: string | null,
  ): Promise<void> {
    return _markCompleted(this.ctx, inboxFile, status, error);
  }

  private async moveInboxFileToProcessed(
    filePath: string,
    statusSuffix: "done" | "failed" | "invalid" | "rejected",
  ): Promise<void> {
    return _moveProcessed(this.ctx.ipcPaths.processedDir, filePath, statusSuffix);
  }
}
