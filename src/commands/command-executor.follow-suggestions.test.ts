import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { CommandExecutor } from "./command-executor.js";
import type { Command } from "../types/ipc.js";
import { isRecord } from "../lib/guards.js";

type DelegatedFollowAction = "follow" | "follow_engagers" | "follow_accept" | "follow_suggestions";

type DelegatedFollowActionInput = {
  command: Command;
  payload: Record<string, unknown>;
  action: DelegatedFollowAction;
};

type DelegatedFollowActionInvoker = {
  executeDelegatedFollowAction(input: DelegatedFollowActionInput): Promise<unknown>;
};

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const baseCommand = (): Command => ({
  id: "test-follow-suggestions",
  createdAt: new Date().toISOString(),
  kind: "brain.generateAndQueue",
  grantId: null,
  payload: {},
  sig: null,
  sourceDirectiveId: null,
  pendingDirectiveId: null,
  actionNonce: null,
  challenge: null,
  forceNow: false,
  runtimeSessionId: null,
  runtimeOrigin: null,
  runtimeSig: null,
});

const tempDirs: string[] = [];

const createExecutor = (callAgentChatBridge: (payload: unknown) => Promise<unknown>) => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-command-executor-follow-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  tempDirs.push(root);
  const ipcPaths = {
    inboxDir: path.join(root, "inbox"),
    processedDir: path.join(root, "processed"),
    generatedDir: path.join(root, "generated"),
    queueStatePath: path.join(root, "queue-state.json"),
    resultsPath: path.join(root, "results.jsonl"),
  };
  const executor = new CommandExecutor({
    config: {
      imageGenerateCmd: null,
      fileGenerateCmd: null,
      imageGenerateTimeoutMs: 45_000,
    },
    ipcPaths,
    memory: {
      recordWrite: async () => undefined,
    },
    stateDb: null,
    trpc: null,
    commandSeal: {
      runtimeCommandSessionId: "session-test",
      runtimeCommandSealKey: "seal-test",
      runtimeIssuedCommandIds: new Set<string>(),
      runtimeConsumedCommandIds: new Set<string>(),
    },
    controlKey: null,
    queue: {
      queueStateMutation: Promise.resolve(),
    },
    callAgentChatBridge,
    callAgentUploadChunk: null,
    runOpenClawPrompt: null,
  });
  return executor;
};

const invokeFollowAction = async (
  executor: CommandExecutor,
  input: DelegatedFollowActionInput,
): Promise<unknown> => {
  const invoker = executor as unknown as DelegatedFollowActionInvoker;
  return invoker.executeDelegatedFollowAction(input);
};

describe("command executor delegated follow suggestions", () => {
  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
  });

  it("uses browse_agents for --agent-only suggestions and returns numbered account summaries", async () => {
    const bridge = vi.fn(async (payload: unknown) => {
      if (!isRecord(payload)) {
        throw new Error("bridge payload must be an object");
      }
      if (payload.action !== "browse_agents") {
        throw new Error(`unexpected bridge action: ${String(payload.action)}`);
      }
      return {
        items: [
          { handle: "atlas.engine", name: "Atlas Engine", score: 55, reason: "discoverable_agent" },
          { handle: "aurora.synth", name: "Aurora Synth", score: 55, reason: "discoverable_agent" },
          { handle: "flux.relay", name: "Flux Relay", score: 55, reason: "discoverable_agent" },
          { handle: "echo.engine", name: "Echo Engine", score: 55, reason: "discoverable_agent" },
          { handle: "dev.clawd", name: "Clawd (Dev's Familiar)", score: 55, reason: "discoverable_agent" },
          { handle: "seed.agent", name: "Seed Agent", score: 55, reason: "discoverable_agent" },
        ],
      };
    });
    const executor = createExecutor(bridge);
    const payload: Record<string, unknown> = {
      chatCommandName: "assist",
      chatContext: {
        commandName: "assist",
        commandArgs: ["follow-suggestions", "5", "tech", "savvy", "--agent-only"],
      },
    };

    const outcome = await invokeFollowAction(executor, {
      command: baseCommand(),
      payload,
      action: "follow_suggestions",
    });

    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(true);

    const data = isRecord(outcome.data) ? outcome.data : null;
    const completion = data && isRecord(data.chatCompletion) ? data.chatCompletion : null;
    const body = asNonEmptyString(completion?.body);
    expect(body).not.toBeNull();
    if (!body) return;

    expect(body).toContain("1. @atlas.engine — Atlas Engine");
    expect(body).toContain("5. @dev.clawd — Clawd (Dev's Familiar)");
    expect(body).toContain("Fair warning: most results currently look like seed placeholders");
    expect(body).toContain("Reply with /follow @handle or /follow-engagers 5");

    expect(bridge).toHaveBeenCalledTimes(1);
    const firstCall = bridge.mock.calls[0]?.[0];
    expect(isRecord(firstCall)).toBe(true);
    if (!isRecord(firstCall)) return;
    expect(firstCall.action).toBe("browse_agents");
    expect(firstCall.query).toBe("tech savvy");
  });

  it("attempts follow writes before acknowledging completion text", async () => {
    const bridge = vi.fn(async (payload: unknown) => {
      if (!isRecord(payload)) {
        throw new Error("bridge payload must be an object");
      }
      if (payload.action !== "follow_user") {
        throw new Error(`unexpected bridge action: ${String(payload.action)}`);
      }
      return {
        followed: true,
        created: true,
        user: {
          handle: "dev.clawd",
        },
      };
    });
    const executor = createExecutor(bridge);
    const payload: Record<string, unknown> = {
      chatCommandName: "follow",
      followHandles: ["@dev.clawd"],
    };

    const outcome = await invokeFollowAction(executor, {
      command: baseCommand(),
      payload,
      action: "follow",
    });

    expect(isRecord(outcome)).toBe(true);
    if (!isRecord(outcome)) return;
    expect(outcome.ok).toBe(true);

    const data = isRecord(outcome.data) ? outcome.data : null;
    const completion = data && isRecord(data.chatCompletion) ? data.chatCompletion : null;
    const body = asNonEmptyString(completion?.body);
    expect(body).not.toBeNull();
    if (!body) return;

    expect(body).toContain("now following: @dev.clawd");

    expect(bridge).toHaveBeenCalledTimes(1);
    const firstCall = bridge.mock.calls[0]?.[0];
    expect(isRecord(firstCall)).toBe(true);
    if (!isRecord(firstCall)) return;
    expect(firstCall.action).toBe("follow_user");
    expect(firstCall.handle).toBe("dev.clawd");
  });
});
