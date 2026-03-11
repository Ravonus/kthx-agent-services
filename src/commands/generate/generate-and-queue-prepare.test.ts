import { describe, expect, it, vi } from "vitest";

import { prepareGenerateAndQueue } from "./generate-and-queue-prepare.js";
import { RequeueCommandError, type Command } from "../types.js";
import type { ExecuteGenerateAndQueueRuntime } from "./generate-and-queue.js";

const createCommand = (
  payload: Record<string, unknown>,
): Command => ({
  id: "cmd-auto-post-generate-1",
  createdAt: "2026-03-10T12:00:00.000Z",
  kind: "brain.generateAndQueue",
  grantId: "grant-auto-1",
  payload,
  sig: null,
  targetAgentId: "agent-runtime-1",
  sourceDirectiveId: "auto_post_media_retry_1",
  pendingDirectiveId: null,
  actionNonce: null,
  challenge: null,
  forceNow: true,
  runtimeSessionId: null,
  runtimeOrigin: "director_directive",
  runtimeSig: null,
});

describe("prepareGenerateAndQueue", () => {
  it("requeues auto-posting when generate.mutate fails before drafts are produced", async () => {
    const recordWrite = vi.fn(async (_entry: unknown) => undefined);
    const command = createCommand({
      goal: "post",
      kind: "media",
      provenance: "runtime_auto_posting",
      autoPlanned: {
        trigger: "runtime_startup",
      },
    });

    const runtime = {
      ctx: {
        memory: {
          recordWrite,
        },
      },
      agent: () => ({
        generate: {
          mutate: async () => {
            throw new Error(
              "Unable to generate drafts: LLM draft generation returned invalid JSON for media.",
            );
          },
        },
      }),
      resolveCommandSourceDirectiveId: () => command.sourceDirectiveId,
      resolveDelegatedFollowAction: () => null,
      executeDelegatedFollowAction: async () => {
        throw new Error("unexpected delegated follow action");
      },
      isChatOriginCommand: () => false,
      resolveChatCommandName: () => null,
      didChatMessageExplicitlyRequestStory: () => false,
      isStoryGenerateRequestFromChatPayload: () => false,
      executeChatLiteralGenerate: async () => {
        throw new Error("unexpected chat literal generate");
      },
      failedOutcome: (_command: Command, message: string, code?: string) => ({
        at: "2026-03-10T12:00:10.000Z",
        commandId: command.id,
        kind: command.kind,
        grantId: command.grantId,
        ok: false,
        error: {
          message,
          ...(code ? { code } : {}),
        },
      }),
      successOutcome: (_command: Command, data: unknown) => ({
        at: "2026-03-10T12:00:10.000Z",
        commandId: command.id,
        kind: command.kind,
        grantId: command.grantId,
        ok: true,
        data,
      }),
      resolveCommandSourceDirectiveActionNonce: () => null,
      resolveEnforcedDraftAction: () => null,
      resolveEngagementTargetForDirective: async () => null,
      isNoTargetDiscoveryFailure: () => false,
      pruneGeneratedDraftCache: () => undefined,
      extractInlineDrafts: () => [],
      buildGenerateInputWithRuntimeContext: async () => ({
        kind: "media",
        topic: "city at dusk",
      }),
      classifyMediaGenerationDeferral: () => ({
        shouldRequeue: false,
        reason: null,
        reasonCode: null,
        personaSlug: null,
      }),
      recordCommandLifecycleCheckpoint: async () => undefined,
      isDirectiveContextLinkedCommand: () => true,
      applyPermissionGenerateInputConstraints: (
        generateInput: Record<string, unknown>,
      ) => generateInput,
      buildGenerateInput: () => ({
        kind: "media",
      }),
      extractGeneratedDrafts: () => [],
      isGeneratedDraftAllowedByPermissionState: () => true,
      isPersonaMediaLockEnabled: () => false,
      isPersonaMediaCompatibleDraft: () => true,
      buildPersonaLockedMediaFallbackDraft: () => null,
      isChatWriteCommandExplicitlyRequested: () => false,
      isWriteDraftAction: () => false,
      shouldRedirectBlockedChatWritesToLiteralGenerate: () => false,
      resolveChatLiteralFallbackPromptFromDrafts: () => null,
      isChatWriteRequesterOwner: () => true,
      shouldEnforceExplicitPublishGate: () => false,
      sendDraftFailureMessage: async () => false,
      buildDraftPreviewPayload: () => null,
      sendDraftPreviewMessage: async () => false,
      mapDraftToWriteCommand: () => null,
      executeCommandFromMappedDraft: async () => ({
        at: "2026-03-10T12:00:10.000Z",
        commandId: command.id,
        kind: "write.createPost",
        grantId: command.grantId,
        ok: true,
      }),
      isRecoverableDraftGrantErrorMessage: () => false,
      isRecoverableDraftSkipDecision: () => false,
      isRecoverableDraftExecutionError: () => false,
      buildChatLiteralFallbackPayloadFromStory: (input: {
        payload: Record<string, unknown>;
        fallbackPrompt?: string | null;
      }) => input.payload,
      generatedDraftCache: new Map(),
    } satisfies ExecuteGenerateAndQueueRuntime;

    await expect(
      prepareGenerateAndQueue.call(runtime, command),
    ).rejects.toBeInstanceOf(RequeueCommandError);

    expect(recordWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "auto_post_generate_retry_scheduled",
        commandId: command.id,
      }),
    );
  });
});
