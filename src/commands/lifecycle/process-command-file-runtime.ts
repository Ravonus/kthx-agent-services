import type { SealVerifyError } from "../../directives/command-seal.js";
import type {
Command,
CommandExecutorContext,
CommandLifecycleCheckpointStage,
CommandOutcome,
EngagementTargetCandidate,
ExecuteResult,
} from "../types.js";

import { callAgentBridgeLookupCached as _bridgeLookupCached } from "../cache/cache.js";
import { emitChatProcessingIndicator as _emitChatProcessing } from "../chat/chat-delivery.js";
import {
resolveEngagementActionForCommand as _resolveEngagementAction,
updatePendingDirectiveStatusForOutcome as _updateDirectiveStatus,
} from "../directives/resolution.js";
import { resolveEnforcedDraftAction as _resolveEnforcedAction } from "../generate/generate-input.js";
import { primeCommandContextForRequeue as _primeRequeueCtx } from "./command-prime-context.js";
import { writeOutcome as _writeOutcome } from "./outcome.js";
import type { ProcessCommandFileRuntime } from "./process-command-file.js";
import {
markQueueItemCompletedByInbox as _markCompleted,
markQueueItemNotReadyByInbox as _markNotReady,
moveInboxFileToProcessed as _moveProcessed,
} from "./queue-items.js";
import {
releaseReplayConsumedForRetry as _releaseReplayConsumedForRetry,
tryAllowTrustedReplay as _tryAllowReplay,
tryRehydrateRuntimeIssuedSeal as _tryRehydrate,
tryResealTrustedCommandForActiveSession as _tryReseal,
} from "./seal.js";
import { resolveRuntimeAgentId as _resolveRuntimeAgentId } from "./session.js";

export type RuntimeAgentIdState = {
  agentIdCache: string | null;
  checkedAtMs: number;
};

export type BuildProcessCommandFileRuntimeInput = {
  ctx: CommandExecutorContext;
  runtimeAgentIdState: RuntimeAgentIdState;
  bridgeLookupCache: Map<string, { expiresAtMs: number; value: unknown }>;
  engagementTargetCache: Map<
    string,
    { expiresAtMs: number; candidate: EngagementTargetCandidate }
  >;
  recordCommandLifecycleCheckpoint: (input: {
    command: Command;
    stage: CommandLifecycleCheckpointStage;
    status?: "ok" | "failed";
    message?: string | null;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  finalizeCommandOutcome: (input: {
    command: Command;
    outcome: CommandOutcome;
  }) => Promise<void>;
  executeCommand: (command: Command) => Promise<ExecuteResult>;
};

export function buildProcessCommandFileRuntime(
  input: BuildProcessCommandFileRuntimeInput,
): ProcessCommandFileRuntime {
  return {
    ctx: {
      memory: input.ctx.memory,
      controlKey: input.ctx.controlKey,
      commandSeal: input.ctx.commandSeal,
    },
    markQueueItemCompletedByInbox: (inboxFile, status, reason) =>
      _markCompleted(input.ctx, inboxFile, status, reason),
    markQueueItemNotReadyByInbox: (inboxFile, reason) =>
      _markNotReady(input.ctx, inboxFile, reason),
    writeOutcome: (outcome) => _writeOutcome(input.ctx.ipcPaths.resultsPath, outcome),
    moveInboxFileToProcessed: (runtimeFilePath, suffix) =>
      _moveProcessed(input.ctx.ipcPaths.processedDir, runtimeFilePath, suffix),
    recordCommandLifecycleCheckpoint: (checkpoint) =>
      input.recordCommandLifecycleCheckpoint(checkpoint),
    finalizeCommandOutcome: (finalizeInput) => input.finalizeCommandOutcome(finalizeInput),
    resolveRuntimeAgentId: () => _resolveRuntimeAgentId(input.ctx, input.runtimeAgentIdState),
    tryAllowTrustedReplay: (command) => _tryAllowReplay(input.ctx.commandSeal, command),
    tryRehydrateRuntimeIssuedSeal: (command) =>
      _tryRehydrate(input.ctx.commandSeal, command),
    tryResealTrustedCommandForActiveSession: (resealInput) =>
      _tryReseal({
        ...resealInput,
        sealError: resealInput.sealError as SealVerifyError,
        commandSeal: input.ctx.commandSeal,
        recordWrite: (entry) => input.ctx.memory.recordWrite(entry),
      }),
    emitChatProcessingIndicator: async (command) => {
      await _emitChatProcessing(
        {
          callAgentChatBridge: input.ctx.callAgentChatBridge ?? null,
          memory: input.ctx.memory,
        },
        command,
      );
    },
    executeCommand: (command) => input.executeCommand(command),
    releaseReplayConsumedForRetry: (commandId) =>
      _releaseReplayConsumedForRetry(input.ctx.commandSeal, commandId),
    primeCommandContextForRequeue: (command, reason) =>
      _primeRequeueCtx(
        {
          memory: input.ctx.memory,
          callAgentChatBridge: input.ctx.callAgentChatBridge ?? null,
          resolveEngagementActionForCommand: (runtimeCommand) =>
            _resolveEngagementAction(runtimeCommand, _resolveEnforcedAction),
          callAgentBridgeLookupCached: (payload, ttlMs) =>
            _bridgeLookupCached(
              input.bridgeLookupCache,
              input.ctx.callAgentChatBridge,
              payload,
              ttlMs,
            ),
          engagementTargetCache: input.engagementTargetCache,
        },
        command,
        reason,
      ),
    updatePendingDirectiveStatusForOutcome: (command, outcome) =>
      _updateDirectiveStatus(command, outcome, input.ctx),
  };
}
