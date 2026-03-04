/**
 * Standalone generate-and-queue executor extracted from CommandExecutor.
 */

import type {
  Command,
  CommandOutcome,
  EngagementTargetCandidate,
  GeneratedDraft,
} from "../types.js";
import { executePreparedGenerateAndQueue } from "./generate-and-queue-execution.js";
import { prepareGenerateAndQueue } from "./generate-and-queue-prepare.js";

type DraftPreviewPayload = {
  summary: string;
  body: string;
  draftPostKind: string | null;
  draftMode: string | null;
  draftSlideCount: number | null;
};

export type ExecuteGenerateAndQueueRuntime = {
  ctx: {
    memory: {
      recordWrite(entry: unknown): Promise<void>;
    };
  };
  generatedDraftCache: Map<string, { drafts: GeneratedDraft[]; cachedAtMs: number }>;
  agent: () => {
    generate: {
      mutate(input: Record<string, unknown>): Promise<unknown>;
    };
  };
  resolveCommandSourceDirectiveId: (input: {
    command: Command;
    payload?: Record<string, unknown> | null;
  }) => string | null;
  resolveDelegatedFollowAction: (
    payload: Record<string, unknown>,
  ) => "follow" | "follow_engagers" | "follow_accept" | "follow_suggestions" | null;
  executeDelegatedFollowAction: (input: {
    command: Command;
    payload: Record<string, unknown>;
    action: "follow" | "follow_engagers" | "follow_accept" | "follow_suggestions";
  }) => Promise<CommandOutcome>;
  isChatOriginCommand: (
    command: Command,
    payloadOverride?: Record<string, unknown> | null,
  ) => boolean;
  resolveChatCommandName: (payload: Record<string, unknown>) => string | null;
  didChatMessageExplicitlyRequestStory: (payload: Record<string, unknown>) => boolean;
  isStoryGenerateRequestFromChatPayload: (payload: Record<string, unknown>) => boolean;
  executeChatLiteralGenerate: (
    command: Command,
    payload: Record<string, unknown>,
  ) => Promise<CommandOutcome>;
  failedOutcome: (command: Command, message: string, code?: string) => CommandOutcome;
  successOutcome: (command: Command, data: unknown) => CommandOutcome;
  resolveCommandSourceDirectiveActionNonce: (input: {
    command: Command;
    payload?: Record<string, unknown> | null;
  }) => string | null;
  resolveEnforcedDraftAction: (
    payload: Record<string, unknown>,
  ) => "comment" | "like" | "repost" | null;
  resolveEngagementTargetForDirective: (input: {
    payload: Record<string, unknown>;
    action: "comment" | "like" | "repost";
    commandId: string;
  }) => Promise<EngagementTargetCandidate | null>;
  isNoTargetDiscoveryFailure: (error: unknown) => boolean;
  pruneGeneratedDraftCache: () => void;
  extractInlineDrafts: (payload: Record<string, unknown>) => GeneratedDraft[];
  buildGenerateInputWithRuntimeContext: (
    payload: Record<string, unknown>,
    command: Command,
  ) => Promise<Record<string, unknown>>;
  classifyMediaGenerationDeferral: (input: {
    error: unknown;
    hasPrompt: boolean;
  }) => {
    shouldRequeue: boolean;
    reason: string | null;
    reasonCode: string | null;
    personaSlug: string | null;
  };
  recordCommandLifecycleCheckpoint: (input: {
    command: Command;
    stage: string;
    status?: "ok" | "failed";
    message?: string | null;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  isDirectiveContextLinkedCommand: (command: Command) => boolean;
  applyPermissionGenerateInputConstraints: (
    generateInput: Record<string, unknown>,
    permissionState: unknown,
  ) => Record<string, unknown>;
  buildGenerateInput: (payload: Record<string, unknown>, command: Command) => Record<string, unknown>;
  extractGeneratedDrafts: (generatedResult: unknown) => GeneratedDraft[];
  isGeneratedDraftAllowedByPermissionState: (
    draft: GeneratedDraft,
    permissionState: unknown,
  ) => boolean;
  isPersonaMediaLockEnabled: (payload: Record<string, unknown>) => boolean;
  isPersonaMediaCompatibleDraft: (draft: GeneratedDraft) => boolean;
  buildPersonaLockedMediaFallbackDraft: (input: {
    payload: Record<string, unknown>;
    drafts: GeneratedDraft[];
  }) => GeneratedDraft | null;
  isChatWriteCommandExplicitlyRequested: (payload: Record<string, unknown>) => boolean;
  isWriteDraftAction: (actionValue: string) => boolean;
  shouldRedirectBlockedChatWritesToLiteralGenerate: (input: {
    payload: Record<string, unknown>;
    blockedDrafts: GeneratedDraft[];
  }) => boolean;
  resolveChatLiteralFallbackPromptFromDrafts: (input: {
    payload: Record<string, unknown>;
    drafts: GeneratedDraft[];
  }) => string | null;
  isChatWriteRequesterOwner: (payload: Record<string, unknown>) => boolean;
  shouldEnforceExplicitPublishGate: (payload: Record<string, unknown>) => boolean;
  sendDraftFailureMessage: (input: {
    payload: Record<string, unknown>;
    message: string;
  }) => Promise<boolean>;
  buildDraftPreviewPayload: (drafts: GeneratedDraft[]) => DraftPreviewPayload | null;
  sendDraftPreviewMessage: (input: {
    payload: Record<string, unknown>;
    preview: DraftPreviewPayload;
  }) => Promise<boolean>;
  mapDraftToWriteCommand: (input: {
    draft: GeneratedDraft;
    command: Command;
    sourceDirectiveId: string | null;
    sourceDirectiveActionNonce: string | null;
    provenance: string | null;
  }) => Command | null;
  executeCommandFromMappedDraft: (command: Command) => Promise<CommandOutcome>;
  isRecoverableDraftGrantErrorMessage: (message: string) => boolean;
  isRecoverableDraftSkipDecision: (decision: string | null) => boolean;
  isRecoverableDraftExecutionError: (error: unknown) => boolean;
  buildChatLiteralFallbackPayloadFromStory: (input: {
    payload: Record<string, unknown>;
    fallbackPrompt?: string | null;
  }) => Record<string, unknown>;
};

export type GenerateAndQueuePreparedState = {
  command: Command;
  payload: Record<string, unknown>;
  sourceDirectiveId: string | null;
  sourceDirectiveActionNonce: string | null;
  provenance: string | null;
  generatedResult: unknown;
  executionDrafts: GeneratedDraft[];
};

export type GenerateAndQueuePreparationResult =
  | {
      kind: "outcome";
      outcome: CommandOutcome;
    }
  | {
      kind: "prepared";
      state: GenerateAndQueuePreparedState;
    };

export async function executeGenerateAndQueue(
  this: ExecuteGenerateAndQueueRuntime,
  command: Command,
): Promise<CommandOutcome> {
  const prepared = await prepareGenerateAndQueue.call(this, command);
  if (prepared.kind === "outcome") {
    return prepared.outcome;
  }
  return executePreparedGenerateAndQueue.call(this, prepared.state);
}
