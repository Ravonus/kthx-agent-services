/**
 * Memory subsystem types for the agent runtime.
 *
 * Ported from agent-runtime.mjs lines 1255-1730+ (envelope parsing,
 * mood/temporal types, MemoryStore field types, archive indexing).
 */

import type { StateSqliteStore } from "../state/sqlite-state.js";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type MemorySource = "user" | "public" | "local";

export type StreamName =
  | "director"
  | "notifications"
  | "feed"
  | "activity"
  | "memory_activity"
  | "likes"
  | "reposts"
  | "comments"
  | "views"
  | "tags"
  | "story_replies"
  | "writes"
  | "errors";

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export type MemoryEnvelope = {
  receivedAt: string;
  source: MemorySource;
  topic: string;
  payload: unknown;
};

// ---------------------------------------------------------------------------
// Payload key extraction
// ---------------------------------------------------------------------------

export type ExtractedKeys = {
  type: string | null;
  postId: number | null;
  commentId: number | null;
  tags: string[];
  categories: string[];
};

// ---------------------------------------------------------------------------
// Archive index (written alongside .jsonl.gz segments)
// ---------------------------------------------------------------------------

export type ArchiveIndex = {
  version: number;
  stream: string;
  archiveBasename: string;
  createdAt: string;
  receivedAtMin: string | null;
  receivedAtMax: string | null;
  eventCount: number;
  postIds: number[];
  commentIds: number[];
  types: Record<string, number>;
};

// ---------------------------------------------------------------------------
// Mood
// ---------------------------------------------------------------------------

export type MoodSignal = {
  at: string;
  delta: number;
  reason: string;
};

export type MoodState = {
  version: number;
  updatedAt: string;
  score: number;
  volatility: number;
  primary: string;
  secondary: string[];
  recentSignals: MoodSignal[];
};

export type MoodDelta = {
  delta: number;
  reason: string;
};

// ---------------------------------------------------------------------------
// Temporal context
// ---------------------------------------------------------------------------

export type TemporalTierName = "24h" | "7d" | "30d" | "365d";

export type TierRankedEntry = {
  name: string;
  count: number;
};

export type TierRankedPost = {
  id: number;
  count: number;
};

export type TierSummary = {
  version: number;
  tier: string;
  updatedAt: string;
  windowLabel?: string;
  eventCount: number;
  topTypes: TierRankedEntry[];
  topPosts: TierRankedPost[];
  topActors: TierRankedEntry[];
  bullets: string[];
  algorithmBullets: string[];
  compressedBy: "algorithm" | "agent";
};

export type TemporalContext = {
  version: number;
  updatedAt: string;
  algorithmVersion: number;
  tiers: Record<string, TierSummary | null>;
};

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------

export type ViewStateItem = {
  status: "unviewed" | "viewed";
  receivedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  postId: number | null;
  commentId: number | null;
  sourceType: string | null;
  lastTopic: string | null;
};

export type ViewState = {
  version: number;
  updatedAt: string;
  items: Record<string, ViewStateItem>;
};

export type ViewContextSummary = {
  enabled: boolean;
  relevant: boolean;
  lines: string[];
};

export type RetrievalContextSummary = {
  enabled: boolean;
  intent: RetrievalIntent;
  query: string | null;
  keywords: string[];
  lines: string[];
};

export type RetrievalIntent = "chat" | "directive" | "engagement";

// ---------------------------------------------------------------------------
// Memory notes
// ---------------------------------------------------------------------------

export type MemoryNoteAppliesTo = {
  modes?: string[];
  audiences?: string[];
};

export type MemoryNote = {
  version: number;
  title: string;
  content: string;
  appliesTo?: MemoryNoteAppliesTo;
};

// ---------------------------------------------------------------------------
// Context request / bundle (used when building a reply-context prompt)
// ---------------------------------------------------------------------------

export type ContextRequest = {
  postId?: number;
  commentId?: number;
  mode?: string;
  audience?: string;
  maxRecentEvents?: number;
  maxArchiveEvents?: number;
  includeViewState?: boolean;
  viewStateMaxItems?: number;
  includeKeywordRetrieval?: boolean;
  retrievalQuery?: string;
  retrievalMaxItems?: number;
  retrievalIntent?: RetrievalIntent;
};

export type TargetFocus = {
  counterparties: TierRankedEntry[];
  bullets: string[];
};

export type ContextBundle = {
  generatedAt: string;
  identity: string | null;
  mode: string | null;
  audience: string | null;
  view: ViewContextSummary;
  retrieval: RetrievalContextSummary;
  mood: MoodState;
  temporal: TemporalContext;
  target: {
    postId: number | null;
    commentId: number | null;
    events: MemoryEnvelope[];
    focus: TargetFocus;
  };
  recent: MemoryEnvelope[];
  archive: MemoryEnvelope[];
  notes: MemoryNote[];
};

// ---------------------------------------------------------------------------
// Memory activity (derived from incoming events)
// ---------------------------------------------------------------------------

export type MemoryActivity = {
  type: "memory_activity";
  activityType: string;
  postId: number | null;
  commentId: number | null;
  actor: string | null;
  summary: string | null;
  sourceTopic: string;
  sourceType: string;
};

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export type RetentionCategory =
  | "notifications"
  | "posts"
  | "interactions"
  | "commands"
  | "system"
  | null;

// ---------------------------------------------------------------------------
// Stream path map
// ---------------------------------------------------------------------------

export type StreamPathMap = Record<StreamName, string>;

// ---------------------------------------------------------------------------
// Prune results
// ---------------------------------------------------------------------------

export type PruneResult = {
  pruned: number;
  kept: number;
  stream: string;
};

export type ArchivePruneResult = {
  removed: number;
  stream: string;
};

export type RetentionCleanupResult = {
  active: PruneResult[];
  archives: ArchivePruneResult[];
  moodSignalsPruned: number;
  longTermCompactions: number;
};

export type LongTermArchiveTypeCount = {
  type: string;
  count: number;
};

export type LongTermArchiveCapsule = {
  id: string;
  stream: string;
  archiveBasename: string;
  compactedAt: string;
  receivedAtMin: string | null;
  receivedAtMax: string | null;
  eventCount: number;
  postIds: number[];
  commentIds: number[];
  topTypes: LongTermArchiveTypeCount[];
  summary: string;
  snippets: string[];
  keywords: string[];
  compressedBy: "algorithm" | "agent";
};

export type LongTermArchiveIndex = {
  version: 1;
  updatedAt: string;
  items: LongTermArchiveCapsule[];
};

export type ArchiveCompressionRequest = {
  stream: string;
  archiveBasename: string;
  receivedAtMin: string | null;
  receivedAtMax: string | null;
  eventCount: number;
  topTypes: LongTermArchiveTypeCount[];
  postIds: number[];
  commentIds: number[];
  sampleLines: string[];
};

export type ArchiveCompressFn = (
  request: ArchiveCompressionRequest,
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Agent compression
// ---------------------------------------------------------------------------

export type AgentCompressionRequest = {
  tiers: Record<
    string,
    {
      tier: string;
      label: string;
      eventCount: number;
      topTypes: TierRankedEntry[];
      topPosts: TierRankedPost[];
      topActors: TierRankedEntry[];
      bullets: string[];
    }
  >;
};

export type AgentCompressFn = (
  request: AgentCompressionRequest,
) => Promise<unknown>;

export type RefreshTemporalOptions = {
  force?: boolean;
  allowAgentCompression?: boolean;
  agentCompressFn?: AgentCompressFn | null;
};

// ---------------------------------------------------------------------------
// MemoryStore constructor config
// ---------------------------------------------------------------------------

export type MemoryStoreConfig = {
  stateDir: string;
  rotateBytes: number;
  tailMaxBytes: number;
  tailMaxLines: number;
  stateDb?: StateSqliteStore | null;
};
