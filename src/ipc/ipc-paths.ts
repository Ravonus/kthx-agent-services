/**
 * IPC path management: creates all IPC file path constants, initialises
 * directory structure, and cleans up stale execution artifacts.
 *
 * Ported from agent-runtime.mjs lines 2796-3050.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { nowIso } from "../lib/text.js";
import { ensureDir } from "../lib/fs-helpers.js";
import type { IpcPaths } from "../types/ipc.js";

export type { IpcPaths } from "../types/ipc.js";

// ---------------------------------------------------------------------------
// Path creation
// ---------------------------------------------------------------------------

/**
 * Builds the complete set of IPC file-path constants rooted under `stateDir`.
 */
export const createIpcPaths = (stateDir: string): IpcPaths => {
  const ipcDir = path.join(stateDir, "ipc");
  return {
    ipcDir,
    chatDir: path.join(ipcDir, "chat"),
    challengeDir: path.join(ipcDir, "challenge"),
    challengePromptsDir: path.join(ipcDir, "challenge", "prompts"),
    challengeRepliesDir: path.join(ipcDir, "challenge", "replies"),
    challengeProcessedDir: path.join(ipcDir, "challenge", "processed"),
    debugDir: path.join(ipcDir, "debug"),
    hookDir: path.join(ipcDir, "hook"),
    inboxDir: path.join(ipcDir, "inbox"),
    pendingDir: path.join(ipcDir, "pending"),
    pendingHistoryDir: path.join(ipcDir, "pending", "history"),
    draftsDir: path.join(ipcDir, "drafts"),
    probeDir: path.join(ipcDir, "probes"),
    generatedDir: path.join(ipcDir, "generated"),
    processedDir: path.join(ipcDir, "processed"),
    eventsHistoryDir: path.join(ipcDir, "events-history"),
    outboxDir: path.join(ipcDir, "outbox"),
    directiveDir: path.join(ipcDir, "directive"),
    directiveHistoryDir: path.join(ipcDir, "directive", "history"),
    queueDir: path.join(ipcDir, "queue"),
    wakePath: path.join(ipcDir, "wake"),
    hookWakePath: path.join(ipcDir, "hook", "wake"),
    chatWakePath: path.join(ipcDir, "wake-chat"),
    eventsPath: path.join(ipcDir, "events.jsonl"),
    chatEventsPath: path.join(ipcDir, "chat", "events.jsonl"),
    chatInboxPath: path.join(ipcDir, "chat", "inbox.jsonl"),
    chatStatusPath: path.join(ipcDir, "chat", "status.json"),
    chatRuntimeStatePath: path.join(ipcDir, "chat", "runtime-state.json"),
    hookRequestsPath: path.join(ipcDir, "hook", "requests.jsonl"),
    resultsPath: path.join(ipcDir, "results.jsonl"),
    probeWritePath: path.join(ipcDir, "probes", "tunnel-write-probe.txt"),
    latestDirectorGrantPath: path.join(ipcDir, "director", "latest-grant.json"),
    currentDirectivePath: path.join(ipcDir, "directive", "current.json"),
    latestDebugPath: path.join(ipcDir, "debug", "latest.json"),
    mintDebugPath: path.join(ipcDir, "debug", "mint.json"),
    mintTracePath: path.join(ipcDir, "debug", "mint-trace.jsonl"),
    queueStatePath: path.join(ipcDir, "queue", "state.json"),
  };
};

// ---------------------------------------------------------------------------
// Directory & file initialisation
// ---------------------------------------------------------------------------

/**
 * Ensure a file exists; create it with `defaultContent` if missing.
 */
const ensureFile = async (
  filePath: string,
  defaultContent: string,
): Promise<void> => {
  await fs.access(filePath).catch(async () => {
    await fs.writeFile(filePath, defaultContent, "utf8");
  });
};

/**
 * Creates all IPC directories and seed files required by the runtime.
 */
export const initIpc = async (paths: IpcPaths): Promise<void> => {
  // Create all directories
  await ensureDir(paths.chatDir);
  await ensureDir(paths.challengeDir);
  await ensureDir(paths.challengePromptsDir);
  await ensureDir(paths.challengeRepliesDir);
  await ensureDir(paths.challengeProcessedDir);
  await ensureDir(paths.debugDir);
  await ensureDir(paths.hookDir);
  await ensureDir(paths.inboxDir);
  await ensureDir(paths.pendingDir);
  await ensureDir(paths.pendingHistoryDir);
  await ensureDir(paths.draftsDir);
  await ensureDir(paths.probeDir);
  await ensureDir(paths.generatedDir);
  await ensureDir(paths.processedDir);
  await ensureDir(paths.eventsHistoryDir);
  await ensureDir(paths.outboxDir);
  await ensureDir(paths.directiveDir);
  await ensureDir(paths.directiveHistoryDir);
  await ensureDir(paths.queueDir);
  await ensureDir(path.dirname(paths.latestDirectorGrantPath));

  // Seed empty JSONL streams
  await ensureFile(paths.eventsPath, "");
  await ensureFile(paths.hookRequestsPath, "");
  await ensureFile(paths.resultsPath, "");
  await ensureFile(paths.wakePath, "");
  await ensureFile(paths.hookWakePath, "");
  await ensureFile(paths.chatWakePath, "");
  await ensureFile(paths.chatEventsPath, "");
  await ensureFile(paths.chatInboxPath, "");

  // Seed JSON state files
  await ensureFile(paths.chatStatusPath, "{}");

  await ensureFile(
    paths.chatRuntimeStatePath,
    JSON.stringify(
      {
        updatedAt: nowIso(),
        inboxPath: paths.chatInboxPath,
        readOffset: 0,
        partialLine: "",
        seenMessageIds: [] as string[],
        lastProcessedMessageId: null,
        lastProcessedAt: null,
      },
      null,
      2,
    ),
  );

  await ensureFile(paths.probeWritePath, "");
  await ensureFile(paths.latestDebugPath, "{}");
  await ensureFile(paths.mintDebugPath, "{}");
  await ensureFile(paths.mintTracePath, "");

  await ensureFile(
    paths.currentDirectivePath,
    JSON.stringify(
      {
        updatedAt: nowIso(),
        status: "idle",
        directive: null,
        command: null,
        archive: null,
      },
      null,
      2,
    ),
  );

  await ensureFile(
    paths.queueStatePath,
    JSON.stringify(
      {
        updatedAt: nowIso(),
        runnerEnabled: false,
        items: [] as unknown[],
        lastPlanAt: null,
        lastPlanSource: null,
      },
      null,
      2,
    ),
  );
};

// ---------------------------------------------------------------------------
// Directory cleanup utilities
// ---------------------------------------------------------------------------

export interface RemoveDirectoryEntriesOptions {
  /** File/directory names to keep (not removed). */
  preserveNames?: ReadonlyArray<string>;
}

/**
 * Removes all entries in `dirPath`, optionally preserving named entries.
 * Returns the number of entries removed.
 */
export const removeDirectoryEntries = async (
  dirPath: string,
  options: RemoveDirectoryEntriesOptions = {},
): Promise<number> => {
  const keep = new Set(
    (options.preserveNames ?? []).map((entry) => String(entry)),
  );
  const entries = await fs
    .readdir(dirPath, { withFileTypes: true })
    .catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (keep.has(entry.name)) continue;
    const targetPath = path.join(dirPath, entry.name);
    await fs
      .rm(targetPath, {
        recursive: entry.isDirectory(),
        force: true,
      })
      .catch(() => {});
    removed += 1;
  }
  return removed;
};

// ---------------------------------------------------------------------------
// State factory helpers
// ---------------------------------------------------------------------------

interface QueueState {
  updatedAt: string;
  runnerEnabled: boolean;
  items: unknown[];
  lastPlanAt: string | null;
  lastPlanSource: string | null;
}

interface DirectiveState {
  updatedAt: string;
  status: string;
  directive: unknown;
  command: unknown;
  archive: unknown;
}

export const createEmptyQueueState = (): QueueState => ({
  updatedAt: nowIso(),
  runnerEnabled: false,
  items: [],
  lastPlanAt: null,
  lastPlanSource: null,
});

export const createIdleDirectiveState = (): DirectiveState => ({
  updatedAt: nowIso(),
  status: "idle",
  directive: null,
  command: null,
  archive: null,
});

// ---------------------------------------------------------------------------
// Execution artifact reset
// ---------------------------------------------------------------------------

export interface ResetArtifactsSummary {
  cleared: {
    inbox: number;
    pending: number;
    drafts: number;
    processed: number;
    outbox: number;
    generated: number;
    challengePrompts: number;
    challengeReplies: number;
    challengeProcessed: number;
    queueAux: number;
  };
}

/**
 * Cleans up stale execution artifacts on process start.
 * Directories are emptied (with optional preserves) and key state files
 * are reset to their initial values.
 */
export const resetExecutionArtifactsOnStart = async (
  paths: IpcPaths,
): Promise<ResetArtifactsSummary> => {
  const cleared: ResetArtifactsSummary["cleared"] = {
    inbox: 0,
    pending: 0,
    drafts: 0,
    processed: 0,
    outbox: 0,
    generated: 0,
    challengePrompts: 0,
    challengeReplies: 0,
    challengeProcessed: 0,
    queueAux: 0,
  };

  cleared.inbox = await removeDirectoryEntries(paths.inboxDir);
  cleared.pending = await removeDirectoryEntries(paths.pendingDir, {
    preserveNames: ["history"],
  });
  cleared.drafts = await removeDirectoryEntries(paths.draftsDir);
  cleared.processed = await removeDirectoryEntries(paths.processedDir);
  cleared.outbox = await removeDirectoryEntries(paths.outboxDir);
  // Preserve generated media/history across tunnel restarts.
  cleared.generated = 0;
  cleared.challengePrompts = await removeDirectoryEntries(
    paths.challengePromptsDir,
  );
  cleared.challengeReplies = await removeDirectoryEntries(
    paths.challengeRepliesDir,
  );
  cleared.challengeProcessed = await removeDirectoryEntries(
    paths.challengeProcessedDir,
  );
  cleared.queueAux = await removeDirectoryEntries(paths.queueDir, {
    preserveNames: [path.basename(paths.queueStatePath)],
  });

  await fs.writeFile(paths.resultsPath, "", "utf8").catch(() => {});
  await fs.writeFile(paths.probeWritePath, "", "utf8").catch(() => {});
  await fs
    .writeFile(
      paths.queueStatePath,
      JSON.stringify(createEmptyQueueState(), null, 2),
      "utf8",
    )
    .catch(() => {});
  await fs
    .writeFile(
      paths.currentDirectivePath,
      JSON.stringify(createIdleDirectiveState(), null, 2),
      "utf8",
    )
    .catch(() => {});

  return { cleared };
};
