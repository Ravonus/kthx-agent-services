import { describe, expect, it, vi } from "vitest";

import { executePreparedGenerateAndQueue } from "./generate-and-queue-execution.js";
import { RequeueCommandError, type Command, type CommandOutcome, type GeneratedDraft } from "../types.js";
import type { ExecuteGenerateAndQueueRuntime, GenerateAndQueuePreparedState } from "./generate-and-queue.js";

const createCommand = (
  payload: Record<string, unknown>,
): Command => ({
  id: "cmd-auto-post-1",
  createdAt: "2026-03-10T12:00:00.000Z",
  kind: "brain.generateAndQueue",
  grantId: "grant-auto-1",
  payload,
  sig: null,
  targetAgentId: "agent-runtime-1",
  sourceDirectiveId: "auto_post_media_abc123",
  pendingDirectiveId: null,
  actionNonce: null,
  challenge: null,
  forceNow: true,
  runtimeSessionId: null,
  runtimeOrigin: "director_directive",
  runtimeSig: null,
});

const createDraft = (): GeneratedDraft => ({
  action: "post",
  payload: {
    postType: "media",
    kind: "post",
    caption: "auto-post caption",
    mediaPrompt: "cinematic skyline at sunrise",
  },
});

const createMappedDraftCommand = (command: Command): Command => ({
  ...command,
  kind: "write.createPost",
});

const buildRuntime = (options: {
  executeCommandFromMappedDraft: (command: Command) => Promise<CommandOutcome>;
  generatedDraftCache?: Map<string, { drafts: GeneratedDraft[]; cachedAtMs: number }>;
  recordWrite?: (entry: unknown) => Promise<void>;
  recordCheckpoint?: (input: {
    command: Command;
    stage: string;
    status?: "ok" | "failed";
    message?: string | null;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
}) => {
  const runtime = {
    ctx: {
      memory: {
        recordWrite: options.recordWrite ?? (async () => undefined),
      },
    },
    generatedDraftCache:
      options.generatedDraftCache ?? new Map<string, { drafts: GeneratedDraft[]; cachedAtMs: number }>(),
    mapDraftToWriteCommand: (input: {
      draft: GeneratedDraft;
      command: Command;
      sourceDirectiveId: string | null;
      sourceDirectiveActionNonce: string | null;
      provenance: string | null;
    }) => createMappedDraftCommand(input.command),
    executeCommandFromMappedDraft: options.executeCommandFromMappedDraft,
    isRecoverableDraftGrantErrorMessage: () => false,
    isRecoverableDraftSkipDecision: () => false,
    isRecoverableDraftExecutionError: () => false,
    recordCommandLifecycleCheckpoint:
      options.recordCheckpoint ??
      (async () => undefined),
    failedOutcome: (command: Command, message: string, code?: string): CommandOutcome => ({
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
    successOutcome: (command: Command, data: unknown): CommandOutcome => ({
      at: "2026-03-10T12:00:10.000Z",
      commandId: command.id,
      kind: command.kind,
      grantId: command.grantId,
      ok: true,
      data,
    }),
  } satisfies Pick<
    ExecuteGenerateAndQueueRuntime,
    | "ctx"
    | "generatedDraftCache"
    | "mapDraftToWriteCommand"
    | "executeCommandFromMappedDraft"
    | "isRecoverableDraftGrantErrorMessage"
    | "isRecoverableDraftSkipDecision"
    | "isRecoverableDraftExecutionError"
    | "recordCommandLifecycleCheckpoint"
    | "failedOutcome"
    | "successOutcome"
  >;

  return runtime as ExecuteGenerateAndQueueRuntime;
};

const createPreparedState = (command: Command): GenerateAndQueuePreparedState => ({
  command,
  payload: command.payload ?? {},
  sourceDirectiveId: command.sourceDirectiveId,
  sourceDirectiveActionNonce: command.actionNonce,
  provenance:
    typeof command.payload?.provenance === "string" ? command.payload.provenance : null,
  generatedResult: {
    drafts: [createDraft()],
  },
  executionDrafts: [createDraft()],
});

describe("executePreparedGenerateAndQueue", () => {
  it("requeues failed auto-post writes so the same generated draft can retry deterministically", async () => {
    const recordWrite = vi.fn(async (_entry: unknown) => undefined);
    const command = createCommand({
      provenance: "runtime_auto_posting",
      autoPlanned: {
        trigger: "runtime_startup",
      },
    });
    const cachedDrafts = new Map<string, { drafts: GeneratedDraft[]; cachedAtMs: number }>([
      [
        command.id,
        {
          drafts: [createDraft()],
          cachedAtMs: Date.now(),
        },
      ],
    ]);
    const runtime = buildRuntime({
      generatedDraftCache: cachedDrafts,
      recordWrite,
      executeCommandFromMappedDraft: async (_draftCommand) => ({
        at: "2026-03-10T12:00:05.000Z",
        commandId: command.id,
        kind: "write.createPost",
        grantId: command.grantId,
        ok: false,
        error: {
          message: "Temporary bridge failure while creating post.",
        },
      }),
    });

    await expect(
      executePreparedGenerateAndQueue.call(runtime, createPreparedState(command)),
    ).rejects.toBeInstanceOf(RequeueCommandError);

    expect(cachedDrafts.has(command.id)).toBe(true);
    expect(recordWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "auto_post_write_retry_scheduled",
        commandId: command.id,
      }),
    );
  });

  it("does not requeue permanent auto-post content failures", async () => {
    const command = createCommand({
      provenance: "runtime_auto_posting",
      autoPlanned: {
        trigger: "runtime_startup",
      },
    });
    const runtime = buildRuntime({
      executeCommandFromMappedDraft: async (_draftCommand) => ({
        at: "2026-03-10T12:00:05.000Z",
        commandId: command.id,
        kind: "write.createPost",
        grantId: command.grantId,
        ok: false,
        error: {
          message: "Blocked media post draft due to low novelty (too similar).",
          code: "post_novelty_blocked",
        },
      }),
    });

    const outcome = await executePreparedGenerateAndQueue.call(
      runtime,
      createPreparedState(command),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("post_novelty_blocked");
  });
});
