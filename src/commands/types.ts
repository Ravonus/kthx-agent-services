/**
 * Shared types and small const-derived type tuples for the command executor.
 */

import type { StateSqliteStore, CommandLifecycleState } from "../state/sqlite-state.js";
import type { QueueState, Command } from "../types/ipc.js";
import type { ContextBundle, ContextRequest } from "../types/memory.js";
import type { CommandSealState } from "../directives/command-seal.js";

// Re-export imported types used by sibling modules
export type { Command, QueueState, CommandLifecycleState, ContextBundle, ContextRequest, StateSqliteStore, CommandSealState };

// ---------------------------------------------------------------------------
// Const-derived type tuples
// ---------------------------------------------------------------------------

export const PERSONA_REFERENCE_FRAME_ROLES = ["selfie", "midshot", "fullbody"] as const;
export type PersonaFrameRole = (typeof PERSONA_REFERENCE_FRAME_ROLES)[number];

export const POST_VARIETY_MODES = [
  "opinion",
  "reaction",
  "humor",
  "micro",
  "narrative",
  "observation",
  "activity",
  "social",
] as const;
export type PostVarietyMode = (typeof POST_VARIETY_MODES)[number];

export const TEXT_STYLE_THEMES = [
  "warm",
  "cool",
  "night",
  "sunrise",
  "mint",
  "ocean",
  "plum",
  "sand",
] as const;
export type TextStyleTheme = (typeof TEXT_STYLE_THEMES)[number];

// ---------------------------------------------------------------------------
// Agent router shims
// ---------------------------------------------------------------------------

export type AgentMutator = {
  mutate(input: Record<string, unknown>): Promise<unknown>;
};

export type AgentQuery = {
  query(input?: Record<string, unknown>): Promise<unknown>;
};

export type AgentProcedure = {
  mutate?: (input: Record<string, unknown>) => Promise<unknown>;
  query?: (input?: Record<string, unknown>) => Promise<unknown>;
};

export type TrpcProcedureNamespace = Record<string, AgentProcedure>;

export type AgentRouterLike = {
  createPost: AgentMutator;
  createStory: AgentMutator;
  commentPost: AgentMutator;
  updateAvatar: AgentMutator;
  updateBanner: AgentMutator;
  votePost: AgentMutator;
  repostPost: AgentMutator;
  generate: AgentMutator;
  uploadDataUri: AgentMutator;
  uploadRemote: AgentMutator;
  submitReview: AgentMutator;
};

export type TrpcLike = {
  agent: TrpcProcedureNamespace;
  realtime?: TrpcProcedureNamespace;
  user?: TrpcProcedureNamespace;
  [key: string]: TrpcProcedureNamespace | undefined;
};

// ---------------------------------------------------------------------------
// Command executor core types
// ---------------------------------------------------------------------------

export type CommandOutcome = {
  at: string;
  commandId: string;
  kind: string;
  grantId: string | null;
  ok: boolean;
  data?: unknown;
  error?: {
    message: string;
    code?: string;
  };
};

export type QueueTrackingStateLike = {
  queueStateMutation: Promise<void>;
};

export type GrantActionConsumer = {
  consumeAction(actionKey: string): boolean;
};

export type CommandExecutorContext = {
  config: {
    imageGenerateCmd: string | null;
    fileGenerateCmd: string | null;
    imageGenerateTimeoutMs: number;
  };
  ipcPaths: {
    inboxDir: string;
    processedDir: string;
    generatedDir: string;
    queueStatePath: string;
    resultsPath: string;
    pendingDir?: string;
  };
  memory: {
    recordWrite(payload: unknown): Promise<void>;
    buildContext?: (request: ContextRequest) => Promise<ContextBundle>;
  };
  grantManager?: GrantActionConsumer | null;
  stateDb?: StateSqliteStore | null;
  trpc: TrpcLike | null;
  commandSeal: CommandSealState;
  controlKey: string | null;
  queue: QueueTrackingStateLike;
  callAgentChatBridge: ((payload: unknown) => Promise<unknown>) | null;
  callAgentUploadChunk: ((payload: unknown) => Promise<unknown>) | null;
  runOpenClawPrompt:
    | ((input: { prompt: string; purpose: string }) => Promise<OpenClawPromptExecutionResult | null>)
    | null;
  promotePendingDirectives?:
    | ((input: {
        limit: number;
        retryPermissionDenied: boolean;
        bypassCooldown?: boolean;
        source?: string;
      }) => Promise<{
        scanned: number;
        promoted: number;
        skippedPermissionDenied: number;
        skippedTerminal: number;
        skippedAlreadySeen: number;
        skippedQueued: number;
        limit: number;
      }>)
    | null;
};

export type ExecuteResult = {
  processed: boolean;
  outcome: CommandOutcome | null;
};

// ---------------------------------------------------------------------------
// Media types
// ---------------------------------------------------------------------------

export type ResolvedMediaUpload = {
  mediaUrl: string;
  mediaOriginalUrl?: string;
  mediaOptimizedUrl?: string;
  mediaContentHash?: string;
  mediaIpfsCid?: string;
  mediaSizeBytes?: number;
  mediaType?: "image" | "video";
};

export type GeneratedDraft = {
  action: string;
  payload: Record<string, unknown>;
};

export type PostDraftDecision = {
  focus: string;
  targetKind: "self" | "person" | "post" | "topic" | "scene";
  useTargetContext: boolean;
  includeTaggedHandles: string[];
  reason: string | null;
};

export type CuratedPostDraft = {
  caption: string | null;
  textBody: string | null;
  mediaPrompt: string | null;
  selectedTaggedHandles: string[] | null;
  useTargetContext: boolean | null;
  targetKind: PostDraftDecision["targetKind"] | null;
};

export type CuratedPostDraftCacheEntry = {
  value: CuratedPostDraft;
  cachedAtMs: number;
};

export type CuratedMediaPromptCacheEntry = {
  prompt: string;
  cachedAtMs: number;
};

export type GeneratedAssetType = "image" | "gif" | "pdf" | "csv" | "code" | "file" | "txt" | "md";
export type GeneratedCustomAssetKind = "emote" | "sticker" | "gif";
export type GeneratedCustomAssetScope = "mine" | "group" | "server";

export type GeneratedCustomAssetSaveIntent = {
  kind: GeneratedCustomAssetKind;
  scope: GeneratedCustomAssetScope;
  nameHint: string | null;
};

export type GeneratedCustomAssetSaveResult = {
  kind: GeneratedCustomAssetKind;
  scope: GeneratedCustomAssetScope;
  name: string;
  id: number | null;
  url: string | null;
  mimeType: string | null;
};

export type PersonaFrameRecord = {
  id: number;
  personaSlug: string;
  frameRole: PersonaFrameRole;
  mediaUrl: string;
  originalUrl: string | null;
  optimizedUrl: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  sourcePrompt: string | null;
  sourceCommandId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type PersonaReferenceResolution = {
  personaSlug: string | null;
  frameReferences: string[];
  builtFrames: boolean;
  mainPersonaSlug: string | null;
  source: string | null;
};

export type PersonaReferencePlan = {
  enabled: boolean;
  mainPersonaSlug: string;
  targetPersonaSlug: string;
  source: string;
  explicitPersonaSlug: string | null;
  variantKey: string | null;
  allowNewPersonaCreation: boolean;
};

export type MediaGeneratorStreamFrame = {
  sourceFileName: string | null;
  isStreamPart: boolean;
  streamPartIndex: number | null;
  isFinalStreamFrame: boolean;
  previewUrl: string | null;
  outputPath: string | null;
  metadataId: string | null;
  source: string | null;
};

export type MediaGenerationProgress = {
  contextId: string | null;
  contextStatus: string | null;
  latestPreviewUrl: string | null;
  streamFrameCount: number;
  latestStreamFrameIndex: number | null;
  hasFinalStreamFrame: boolean;
  streamRevealProgress: number;
  streamFrames: MediaGeneratorStreamFrame[];
  timedOut: boolean;
};

export type OpenClawPromptExecutionResult = {
  parsed: unknown;
  raw: string;
  agentName: string | null;
  payloadText: string | null;
  envelope: Record<string, unknown> | null;
};

export type DraftPreviewPayload = {
  body: string;
  summary: string;
  draftPreviewText: string;
  draftPostKind: "post" | "thread";
  draftMode: "thread" | "carousel";
  draftSlideCount: number;
};

export type CommentCurationContext = {
  postAuthorHandle: string | null;
  postText: string | null;
  mediaSummary: string | null;
  threadSummary: string | null;
  payloadHint: string | null;
  memorySummary: string | null;
};

export type CuratedCommentBody = {
  body: string;
  source: "openclaw" | "draft_fallback";
  reason: string;
};

export type EngagementDecisionContext = {
  postAuthorHandle: string | null;
  postText: string | null;
  mediaSummary: string | null;
  payloadHint: string | null;
  memorySummary: string | null;
};

export type PostDraftContext = {
  targetPostId: number | null;
  postText: string | null;
  mediaSummary: string | null;
  commentSummary: string | null;
  payloadHint: string | null;
  memorySummary: string | null;
  platformSignals: string | null;
  personaDescription: string | null;
  personaStyleHint: string | null;
};

export type TextPostVisualSlide = {
  caption: string | null;
  imagePrompt: string;
};

export type TextPostVisualPlan = {
  renderMode: "text" | "slides";
  captionPosition: string | null;
  textStyle: Record<string, unknown> | null;
  backgroundImagePrompt: string | null;
  slides: TextPostVisualSlide[];
};

export type EngagementTargetCandidate = {
  postId: number;
  commentId: number | null;
  authorId: string | null;
  source: string;
  postSnapshotHash?: string | null;
};

export type EngagementLookupHints = {
  rawQuery: string;
  postId: number | null;
  commentId: number | null;
  handles: string[];
  interestTags: string[];
};

export type EngagementResolutionTrace = {
  step: string;
  queryCount: number;
  cacheHits: number;
  addedCandidates: number;
  totalCandidates: number;
};

export type RecentPostNoveltyEntry = {
  atMs: number;
  postType: "text" | "media";
  text: string;
  normalized: string;
  commandId: string;
  targetPostId: number | null;
};

export type RecentPostVarietyModeEntry = {
  atMs: number;
  postType: "text" | "media";
  mode: PostVarietyMode;
  commandId: string;
  targetPostId: number | null;
  signal: string;
};

export type EngagementDecision = {
  shouldExecute: boolean;
  reason: string;
  source: "openclaw" | "agent_runtime";
  contract: ActionContract | null;
};

export type ActionContract = {
  action: "comment" | "like" | "repost";
  target: {
    postId: number;
    commentId: number | null;
    targetHash: string;
  };
  body: string | null;
  reason: string;
  shouldExecute: boolean;
};

export type OwnerCapabilityCooldown = {
  untilMs: number;
  reason: string;
};

export type RecentCommentTargetUsage = {
  commandId: string;
  postId: number;
  commentId: number | null;
  state: CommandLifecycleState;
  updatedAtMs: number;
  postSnapshotHash: string | null;
};

export type CommentTargetReuseDecision = {
  allow: boolean;
  reason: string;
  recentMatch: RecentCommentTargetUsage | null;
};

export type CommandLifecycleCheckpointStage =
  | "received"
  | "queued"
  | "executing"
  | "generated"
  | "uploaded"
  | "write_mutation"
  | "chat_delivery"
  | "ack_terminal";

export type MediaGenerationDeferralReason =
  | "persona_reference_setup_required"
  | "image_generation_setup_required"
  | "media_generation_output_unavailable";

export type MediaGenerationDeferralDecision = {
  shouldRequeue: boolean;
  reason: string | null;
  reasonCode: MediaGenerationDeferralReason | null;
  personaSlug: string | null;
  imageGeneratorSetupRequired: boolean;
};

export type FollowTargetMode = "owner" | "agent";

// ---------------------------------------------------------------------------
// CommandExecutorDeps — shared mutable state passed to extracted modules
// ---------------------------------------------------------------------------

export type CommandExecutorDeps = {
  readonly ctx: CommandExecutorContext;
  readonly inFlight: Set<string>;
  readonly ownerCapabilityDeniedByTarget: Map<string, OwnerCapabilityCooldown>;
  readonly recentPostNoveltyHistory: RecentPostNoveltyEntry[];
  readonly recentPostVarietyModeHistory: RecentPostVarietyModeEntry[];
  readonly bridgeLookupCache: Map<string, { expiresAtMs: number; value: unknown }>;
  readonly engagementTargetCache: Map<string, { expiresAtMs: number; candidate: EngagementTargetCandidate }>;
  readonly generatedDraftCache: Map<string, { drafts: GeneratedDraft[]; cachedAtMs: number }>;
  readonly curatedPostDraftCache: Map<string, CuratedPostDraftCacheEntry>;
  readonly curatedMediaPromptCache: Map<string, CuratedMediaPromptCacheEntry>;
  runtimeAgentIdCache: string | null;
  runtimeAgentIdCheckedAtMs: number;
  /** Access the tRPC agent router. */
  agent(): AgentRouterLike;
  /** Access the directive ack mutator. */
  directiveAckMutator(): AgentMutator;
  /** Access an optional agent query procedure. */
  agentQueryOptional(name: string): AgentQuery | null;
  /** Access an optional agent mutator procedure. */
  agentMutatorOptional(name: string): AgentMutator | null;
};

// ---------------------------------------------------------------------------
// Crop types
// ---------------------------------------------------------------------------

export type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ProfileCropSpec = {
  target: "avatar" | "banner";
  outputAspect: number;
  focalPoint: { x: number; y: number };
  safeZone: CropRect;
  avoidEdges: { top: number; right: number; bottom: number; left: number };
  textSafeZone?: CropRect;
  guidance: string;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RequeueCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequeueCommandError";
  }
}
