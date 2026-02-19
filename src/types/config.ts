/**
 * Configuration types for the agent runtime.
 *
 * Ported from agent-runtime.mjs lines 3320-3582 (createRuntimeConfig)
 * and lines 400-458 (buildDefaultKthxConfig).
 */

import type { PersonaDefinition } from "../lib/persona.js";

// ---------------------------------------------------------------------------
// KthxConfig sub-objects
// ---------------------------------------------------------------------------

export type KthxOpenClawConfig = {
  enabled: boolean;
  binPath: string;
  agentName: string;
  listAgentsCommand: string;
  promptCommand: string;
  scheduleCommand: string;
  wakeUrl: string;
  wakeToken: string;
  wakeReasons: string[];
  allowCreateAgent: boolean;
  createAgentCommand: string;
  timeoutMs: number;
};

export type KthxQueueConfig = {
  llmScheduleMinItems: number;
  minSpacingSeconds: number;
  maxSpacingSeconds: number;
  runnerTickMs: number;
  autoRun: boolean;
};

export type RetentionCategoryConfig = {
  days: number;
};

export type KthxRetentionConfig = {
  enabled: boolean;
  intervalMinutes: number;
  commands: RetentionCategoryConfig;
  moods: RetentionCategoryConfig;
  posts: RetentionCategoryConfig;
  interactions: RetentionCategoryConfig;
  notifications: RetentionCategoryConfig;
  system: RetentionCategoryConfig;
};

export type KthxMemoryConfig = {
  checkpointMinutes: number;
  agentCompressionCooldownMinutes: number;
  notificationBufferMax: number;
  retention: KthxRetentionConfig;
};

export type KthxImageConfig = {
  commandTemplate: string;
  defaultPersona: string;
  mediaIndexMaxEntries: number;
  referenceLookback: number;
  personas: PersonaDefinition[];
};

export type KthxPathsConfig = {
  homeDir: string;
  stateDir: string;
  generatedDir: string;
};

export type KthxUpdatesConfig = {
  enabled: boolean;
  autoUpdateOnStart: boolean;
  restartAfterUpdate: boolean;
  haltOnFailure: boolean;
  repoDir: string;
  remote: string;
  branch: string;
  allowDirtyWorkingTree: boolean;
  runInstall: boolean;
  runBuild: boolean;
  packageManagerExecutable: string;
  packageManagerUseNpmExecFallback: boolean;
  timeoutMs: number;
};

export type KthxConfig = {
  version: number;
  paths: KthxPathsConfig;
  openclaw: KthxOpenClawConfig;
  queue: KthxQueueConfig;
  memory: KthxMemoryConfig;
  image: KthxImageConfig;
  updates: KthxUpdatesConfig;
};

// ---------------------------------------------------------------------------
// RuntimeConfig (returned by createRuntimeConfig)
// ---------------------------------------------------------------------------

export type RuntimeConfig = {
  // Paths
  runtimeFilePath: string;
  runtimeRootDir: string;
  agentHomeDir: string;
  kthxConfigPath: string;
  stateDir: string;

  // Connection
  connectionId: string;
  realtimeWsUrl: string;
  heartbeatIntervalMs: number;

  // Memory / rotation
  rotateBytes: number;
  tailMaxBytes: number;
  tailMaxLines: number;

  // Subscriptions
  subscribeGlobalFeed: boolean;
  subscribeActivityFeed: boolean;
  autoSubscribeLenses: boolean;
  lensRefreshMinMs: number;

  // Console
  consoleEnabled: boolean;
  consoleAllowNonTty: boolean;

  // Image generation
  imageGenerateCmd: string | null;
  imageGenerateTimeoutMs: number;

  // Bot session
  botSessionTokenTtlSeconds: number;
  botSessionMaxUses: number | null;

  // Grant / challenge
  autoRequestGrantOnDefer: boolean;
  autoRequestGrantCooldownMs: number;
  challengeAnswerMaxChars: number;

  // Mint
  mintConsoleDebugEnabled: boolean;
  mintChallengeUseOpenClaw: boolean;
  rejectMultipleChoiceChallenges: boolean;
  mintChallengeAutoRetryEnabled: boolean;
  mintChallengeAutoRetryMaxAttempts: number;
  mintRetryMinBackoffMs: number;
  mintRetryMaxBackoffMs: number;

  // WebSocket upload
  wsUploadDataUriMaxBytes: number;
  allowSyntheticMediaFallback: boolean;
  httpUploadChunkBytes: number;

  // OpenClaw wake
  openClawWakeDebounceMs: number;
  openClawWakeBatchMs: number;
  openClawWakeIncludeSocketStateChange: boolean;
  openClawWakeIncludeMediaPrepared: boolean;

  // Chat runtime
  chatRuntimeEnabled: boolean;
  chatRuntimePollMs: number;
  chatRuntimeReadChunkBytes: number;
  chatRuntimeSeenMessageLimit: number;
  chatRuntimeReplyMaxChars: number;
  chatRuntimeOpenClawInputMaxChars: number;
  chatRuntimeUseOpenClaw: boolean;
  chatRuntimeReplayOnStart: boolean;
  chatRuntimeChannelRequireMention: boolean;
  chatRuntimeMentionNames: string[];
  chatRuntimeTextStreamEnabled: boolean;
  chatRuntimeTextStreamNativeEnabled: boolean;
  chatRuntimeTextStreamNativeOnly: boolean;
  chatRuntimeTextStreamStepChars: number;
  chatRuntimeTextStreamStepMs: number;
  chatRuntimeTextStreamUpdateMinMs: number;
  chatRuntimeStaleReplyMaxAgeMs: number;
  chatRuntimeStaleReplyMaxAgeImportantMs: number;

  // Execution / queue
  autoRetryPendingMs: number;
  terminalTriggerOnly: boolean;
  queueRunnerDefaultEnabled: boolean;
  executionStateResetOnStart: boolean;
  pendingRetryMaxAttempts: number;

  // Events
  eventsResetOnStart: boolean;
  currentEventsMaxLines: number;

  // WebSocket health
  wsActivityStaleMs: number;
  wsPendingWatchdogMs: number;

  // Memory compression
  memoryCompressionIntervalMs: number;
  memoryCompressionIntervalEnvOverride: boolean;

  // Backend serialization
  backendSerializeRequests: boolean;
  backendRequestMinGapMs: number;
  backendRequestMaxQueue: number;
  backendRequestDebug: boolean;

  // Runtime hash
  runtimeHashMaxFiles: number;
  runtimeHashExtensions: Set<string>;

  // Extra topics
  extraPublicTopics: string[];
  extraUserTopics: string[];
};
