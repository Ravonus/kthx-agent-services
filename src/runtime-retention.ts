import { isRecord } from "./lib/guards.js";
import { nowIso } from "./lib/text.js";
import type { RuntimeContext } from "./runtime-context.js";
import type { ArchiveCompressionRequest } from "./types/memory.js";

const buildArchiveCompressionPrompt = (
  request: ArchiveCompressionRequest,
): string => {
  const payload = {
    stream: request.stream,
    archiveBasename: request.archiveBasename,
    receivedAtMin: request.receivedAtMin,
    receivedAtMax: request.receivedAtMax,
    eventCount: request.eventCount,
    topTypes: request.topTypes.slice(0, 12),
    postIds: request.postIds.slice(0, 48),
    commentIds: request.commentIds.slice(0, 96),
    sampleLines: request.sampleLines.slice(0, 16),
  };
  return [
    "Summarize this archived memory slice for long-term retrieval.",
    "Return only JSON with keys:",
    "summary (string, <= 320 chars), snippets (string[] <= 8, each <= 220 chars).",
    "Focus on durable facts, notable interactions, and useful retrieval cues.",
    "No markdown, no extra keys.",
    JSON.stringify(payload),
  ].join("\n");
};

const createArchiveCompressionFn = (
  ctx: RuntimeContext,
): ((request: ArchiveCompressionRequest) => Promise<unknown>) | null => {
  const openClawConfig = isRecord(ctx.kthxConfig.openclaw)
    ? ctx.kthxConfig.openclaw
    : null;
  const utilAgentNameRaw =
    openClawConfig && typeof openClawConfig.responseAgentName === "string"
      ? openClawConfig.responseAgentName.trim()
      : "";
  const utilAgentName = utilAgentNameRaw.length > 0 ? utilAgentNameRaw : "util-agent";
  if (!ctx.openClawManager) return null;

  return async (request: ArchiveCompressionRequest): Promise<unknown> => {
    const result = await ctx.openClawManager?.promptAgent(
      utilAgentName,
      buildArchiveCompressionPrompt(request),
      { purpose: "archive_retention_compaction" },
    );
    if (!result) return null;
    return result.parsed ?? result.envelope ?? null;
  };
};

export const startRetentionCleanupLoop = (
  ctx: RuntimeContext,
  intervals: Array<ReturnType<typeof setInterval>>,
): void => {
  let retentionRunInFlight = false;
  const runRetentionCleanup = async (trigger: string): Promise<void> => {
    if (retentionRunInFlight) return;
    const memoryConfig = isRecord(ctx.kthxConfig.memory) ? ctx.kthxConfig.memory : null;
    const retentionConfig =
      memoryConfig && isRecord(memoryConfig.retention)
        ? memoryConfig.retention
        : null;
    if (!retentionConfig || retentionConfig.enabled !== true) return;

    retentionRunInFlight = true;
    try {
      const archiveCompressFn =
        retentionConfig.longTerm?.enabled === true &&
        retentionConfig.longTerm?.useAgentCompression === true
          ? createArchiveCompressionFn(ctx)
          : null;
      const result = await ctx.memory.runRetentionCleanup({
        retentionConfig,
        archiveCompressFn,
      });
      if (result) {
        const activePruned = result.active.reduce(
          (sum, row) => sum + (Number.isFinite(row.pruned) ? row.pruned : 0),
          0,
        );
        const archivesRemoved = result.archives.reduce(
          (sum, row) => sum + (Number.isFinite(row.removed) ? row.removed : 0),
          0,
        );
        await ctx.memory.recordWrite({
          type: "retention_cleanup_completed",
          at: nowIso(),
          trigger,
          activePruned,
          archivesRemoved,
          moodSignalsPruned: result.moodSignalsPruned,
          longTermCompactions: result.longTermCompactions,
        });
      }
    } catch (error: unknown) {
      await ctx.memory.recordWrite({
        type: "retention_cleanup_failed",
        at: nowIso(),
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      retentionRunInFlight = false;
    }
  };

  const retentionIntervalMinutesRaw =
    isRecord(ctx.kthxConfig.memory) &&
    isRecord(ctx.kthxConfig.memory.retention) &&
    typeof ctx.kthxConfig.memory.retention.intervalMinutes === "number" &&
    Number.isFinite(ctx.kthxConfig.memory.retention.intervalMinutes)
      ? Math.floor(ctx.kthxConfig.memory.retention.intervalMinutes)
      : 180;
  const retentionIntervalMs = Math.max(
    60_000,
    Math.min(86_400_000, retentionIntervalMinutesRaw * 60_000),
  );

  void runRetentionCleanup("runtime_boot").catch(() => {});
  intervals.push(
    setInterval(() => {
      void runRetentionCleanup("interval").catch(() => {});
    }, retentionIntervalMs),
  );
};
