/**
 * IPC (inter-process communication) types for the agent runtime.
 *
 * Ported from agent-runtime.mjs lines 2796-2836 (createIpcPaths)
 * and lines 4636-4740 (normalizeQueueItem, normalizeQueueState)
 * and lines 3054-3105 (parseCommand).
 */

// ---------------------------------------------------------------------------
// IPC directory / file paths
// ---------------------------------------------------------------------------

export type IpcPaths = {
  ipcDir: string;
  chatDir: string;
  challengeDir: string;
  challengePromptsDir: string;
  challengeRepliesDir: string;
  challengeProcessedDir: string;
  debugDir: string;
  hookDir: string;
  inboxDir: string;
  pendingDir: string;
  pendingHistoryDir: string;
  draftsDir: string;
  probeDir: string;
  generatedDir: string;
  processedDir: string;
  eventsHistoryDir: string;
  outboxDir: string;
  directiveDir: string;
  directiveHistoryDir: string;
  queueDir: string;
  wakePath: string;
  hookWakePath: string;
  chatWakePath: string;
  eventsPath: string;
  chatEventsPath: string;
  chatInboxPath: string;
  chatStatusPath: string;
  chatRuntimeStatePath: string;
  hookRequestsPath: string;
  resultsPath: string;
  probeWritePath: string;
  latestDirectorGrantPath: string;
  currentDirectivePath: string;
  latestDebugPath: string;
  mintDebugPath: string;
  mintTracePath: string;
  queueStatePath: string;
};

// ---------------------------------------------------------------------------
// Queue item / state
// ---------------------------------------------------------------------------

export type QueueItemStatus =
  | "queued"
  | "scheduled"
  | "running"
  | "done"
  | "failed"
  | "missing"
  | "cancelled";

export type QueueItem = {
  id: string;
  directiveId: string;
  inboxFile: string;
  queueClass: string;
  forceNow: boolean;
  commandFingerprint: string | null;
  status: QueueItemStatus;
  createdAt: string;
  dueAt: string | null;
  attempts: number;
  startedAt: string | null;
  completedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  scheduledBy: string | null;
};

export type QueueState = {
  updatedAt: string;
  runnerEnabled: boolean;
  items: QueueItem[];
  lastPlanAt: string | null;
  lastPlanSource: string | null;
};

// ---------------------------------------------------------------------------
// Parsed command
// ---------------------------------------------------------------------------

export type Command = {
  id: string;
  createdAt: string;
  kind: string;
  grantId: string | null;
  payload: Record<string, unknown> | null;
  sig: string | null;
  sourceDirectiveId: string | null;
  pendingDirectiveId: string | null;
  actionNonce: string | null;
  challenge: Record<string, unknown> | null;
  forceNow: boolean;
  runtimeSessionId: string | null;
  runtimeOrigin: string | null;
  runtimeSig: string | null;
};

// ---------------------------------------------------------------------------
// readJsonMaybeIncomplete result
// ---------------------------------------------------------------------------

export type JsonReadStatus = "ok" | "missing" | "not_ready" | "invalid";

export type JsonReadResult = {
  status: JsonReadStatus;
  value: unknown;
};
