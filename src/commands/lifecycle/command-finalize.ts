/** Finalize command outcome — write result, deliver chat, ack directive. */

import type { Command, CommandOutcome, CommandLifecycleCheckpointStage } from "../types.js";
import { writeOutcome } from "./outcome.js";
import { buildNonWriteChatCompletion } from "../chat/chat-completion.js";
import {
  sendNonWriteChatCompletion,
  emitChatOutcome,
} from "../chat/chat-delivery.js";

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

type MemoryWriter = { recordWrite(entry: unknown): Promise<void> };
type ChatBridgeFn = (input: unknown) => Promise<unknown>;

type RecordCheckpointFn = (input: {
  command: Command;
  stage: CommandLifecycleCheckpointStage;
  status?: "ok" | "failed";
  message?: string | null;
  metadata?: Record<string, unknown>;
}) => Promise<void>;

type AckDirectiveFn = (command: Command, outcome: CommandOutcome) => Promise<void>;

// ---------------------------------------------------------------------------
// finalizeCommandOutcome
// ---------------------------------------------------------------------------

export async function finalizeCommandOutcome(
  deps: {
    resultsPath: string;
    callAgentChatBridge: ChatBridgeFn | null;
    memory: MemoryWriter;
    recordCheckpoint: RecordCheckpointFn;
    ackDirectiveForOutcome: AckDirectiveFn;
  },
  input: {
    command: Command;
    outcome: CommandOutcome;
  },
): Promise<void> {
  await writeOutcome(deps.resultsPath, input.outcome);
  await emitChatOutcome(
    {
      callAgentChatBridge: deps.callAgentChatBridge,
      memory: deps.memory,
      recordCheckpoint: deps.recordCheckpoint,
    },
    input.command,
    input.outcome,
  ).catch(async (error: unknown) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await deps.recordCheckpoint({
      command: input.command,
      stage: "chat_delivery",
      status: "failed",
      message: errorMessage,
      metadata: {
        mode: "emit_exception",
      },
    });
    const fallbackCompletion = buildNonWriteChatCompletion({
      command: input.command,
      outcome: input.outcome,
    });
    if (!fallbackCompletion) return;
    const recovered = await sendNonWriteChatCompletion(
      { callAgentChatBridge: deps.callAgentChatBridge, memory: deps.memory },
      {
        command: input.command,
        body: fallbackCompletion.body,
        metadata: fallbackCompletion.metadata,
      },
    ).catch(() => false);
    await deps.recordCheckpoint({
      command: input.command,
      stage: "chat_delivery",
      status: recovered ? "ok" : "failed",
      message: recovered ? null : errorMessage,
      metadata: {
        mode: "emit_exception_fallback",
        recovered,
      },
    });
  });
  await deps.ackDirectiveForOutcome(input.command, input.outcome).catch(() => undefined);
}
