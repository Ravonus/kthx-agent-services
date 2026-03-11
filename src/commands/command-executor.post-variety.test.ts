import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { CommandExecutor } from "./command-executor.js";
import type { PostVarietyMode } from "./types.js";

const tempDirs: string[] = [];

const createExecutor = (options?: {
  callAgentChatBridge?: (payload: unknown) => Promise<unknown>;
  memoryWrites?: unknown[];
}) => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-command-executor-post-variety-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  tempDirs.push(root);
  const ipcPaths = {
    inboxDir: path.join(root, "inbox"),
    processedDir: path.join(root, "processed"),
    generatedDir: path.join(root, "generated"),
    queueStatePath: path.join(root, "queue-state.json"),
    resultsPath: path.join(root, "results.jsonl"),
  };
  return new CommandExecutor({
    config: {
      imageGenerateCmd: null,
      fileGenerateCmd: null,
      imageGenerateTimeoutMs: 45_000,
    },
    ipcPaths,
    memory: {
      recordWrite: async (payload: unknown) => {
        options?.memoryWrites?.push(payload);
      },
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
    callAgentChatBridge: options?.callAgentChatBridge ?? null,
    callAgentUploadChunk: null,
    runOpenClawPrompt: null,
  });
};

type PostVarietyInvoker = {
  selectPostVarietyMode(input: {
    commandId: string;
    postType: "text" | "media";
    payload: Record<string, unknown>;
    context: {
      targetPostId: number | null;
      postText: string | null;
      mediaSummary: string | null;
      commentSummary: string | null;
      payloadHint: string | null;
      memorySummary: string | null;
      platformSignals: string | null;
      agentHandle: string | null;
      agentName: string | null;
    };
    seedHints: string[];
  }): {
    mode: PostVarietyMode;
    reason: string;
    recentModes: string[];
    signal: string;
  };
  notePublishedPostVarietyMode(input: {
    commandId: string;
    postType: "text" | "media";
    targetPostId: number | null;
    mode: PostVarietyMode;
    signal: string;
  }): void;
  buildPostDraftCurationPrompt(input: {
    postType: "text" | "media";
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
    context: {
      targetPostId: number | null;
      postText: string | null;
      mediaSummary: string | null;
      commentSummary: string | null;
      payloadHint: string | null;
      memorySummary: string | null;
      platformSignals: string | null;
      agentHandle: string | null;
      agentName: string | null;
    };
    varietyMode: PostVarietyMode;
    seedHints: string[];
    avoidReferences: string[];
  }): string;
  loadPostDraftDiscoverySignals(input: {
    postId: number | null;
    payload: Record<string, unknown>;
  }): Promise<string | null>;
};

const blankContext = {
  targetPostId: null,
  postText: null,
  mediaSummary: null,
  commentSummary: null,
  payloadHint: null,
  memorySummary: null,
  platformSignals: null,
  agentHandle: null,
  agentName: null,
};

describe("command executor post variety", () => {
  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
  });

  it("rotates variety mode when the previous mode is on cooldown", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as PostVarietyInvoker;
    const first = invoker.selectPostVarietyMode({
      commandId: "variety-mode-1",
      postType: "text",
      payload: {
        textBody: "Quick update from the build log.",
      },
      context: blankContext,
      seedHints: [],
    });
    invoker.notePublishedPostVarietyMode({
      commandId: "variety-mode-1",
      postType: "text",
      targetPostId: null,
      mode: first.mode,
      signal: first.signal,
    });
    const second = invoker.selectPostVarietyMode({
      commandId: "variety-mode-2",
      postType: "text",
      payload: {
        textBody: "Quick update from the build log.",
      },
      context: blankContext,
      seedHints: [],
    });
    expect(second.mode).not.toBe(first.mode);
  });

  it("injects variety mode and platform signals into curation prompt", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as PostVarietyInvoker;
    const prompt = invoker.buildPostDraftCurationPrompt({
      postType: "text",
      caption: "Draft caption",
      textBody: "Draft body",
      mediaPrompt: null,
      context: {
        ...blankContext,
        payloadHint: "react to current launch",
        platformSignals:
          "trending: @atlas.engine: new launch thread | home: @dev.clawd: infra post",
      },
      varietyMode: "reaction",
      seedHints: ["react to the launch"],
      avoidReferences: [],
    });
    expect(prompt).toContain("Variety mode: reaction.");
    expect(prompt).toContain("platformSignals:");
    expect(prompt).toContain("Anchor output to one concrete platform signal");
  });

  it("pushes auto-planned media posts into broader post archetypes", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as PostVarietyInvoker;
    const mode = invoker.selectPostVarietyMode({
      commandId: "auto-post-variety-activity",
      postType: "media",
      payload: {
        provenance: "runtime_auto_posting",
        autoPlanned: {
          trigger: "runtime_startup",
          source: "posting_window_media",
        },
        caption: "fresh autonomous post",
      },
      context: {
        ...blankContext,
        platformSignals:
          "trending: @atlas.engine: launch build thread | home: @kael: bench photo",
      },
      seedHints: [],
    });
    expect(["observation", "activity", "social"]).toContain(mode.mode);
  });

  it("collects compact discovery signals from bridge lookups", async () => {
    const executor = createExecutor({
      callAgentChatBridge: async (payload: unknown) => {
        if (typeof payload !== "object" || payload === null) return { items: [] };
        const action =
          typeof (payload as { action?: unknown }).action === "string"
            ? String((payload as { action?: unknown }).action)
            : "";
        if (action === "browse_trending") {
          return {
            items: [
              {
                caption: "AI launch thread is blowing up right now.",
                author: { handle: "atlas.engine" },
              },
            ],
          };
        }
        if (action === "browse_home_feed") {
          return {
            items: [
              {
                textBody: "Compiler patch with actual benchmarks, not vibes.",
                author: { handle: "dev.clawd" },
              },
            ],
          };
        }
        if (action === "browse_posts") {
          return {
            items: [
              {
                body: "Hot take: infra debt is still underrated.",
                authorHandle: "kael",
              },
            ],
          };
        }
        if (action === "search_global") {
          return {
            items: [
              {
                caption: "Reacting live to the new model drop.",
                author: { handle: "aurora.synth" },
              },
            ],
          };
        }
        return { items: [] };
      },
    });
    const invoker = executor as unknown as PostVarietyInvoker;
    const signals = await invoker.loadPostDraftDiscoverySignals({
      postId: null,
      payload: {
        requestText: "react to launch updates",
      },
    });
    expect(signals).not.toBeNull();
    if (!signals) return;
    expect(signals).toContain("trending:");
    expect(signals).toContain("home:");
    expect(signals).toContain("@atlas.engine");
  });
});
