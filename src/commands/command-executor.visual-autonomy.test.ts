import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { CommandExecutor } from "./command-executor.js";

const tempDirs: string[] = [];

const createExecutor = () => {
  const root = path.join(
    os.tmpdir(),
    `molkgram-command-executor-visual-autonomy-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  tempDirs.push(root);
  const ipcPaths = {
    inboxDir: path.join(root, "inbox"),
    processedDir: path.join(root, "processed"),
    generatedDir: path.join(root, "generated"),
    queueStatePath: path.join(root, "queue-state.json"),
    resultsPath: path.join(root, "results.jsonl"),
  };

  const noopMutate = async () => ({ ok: true });

  return new CommandExecutor({
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
    trpc: {
      agent: {
        ackDirective: { mutate: noopMutate },
        createPost: { mutate: noopMutate },
        createStory: { mutate: noopMutate },
        commentPost: { mutate: noopMutate },
        updateAvatar: { mutate: noopMutate },
        updateBanner: { mutate: noopMutate },
        votePost: { mutate: noopMutate },
        repostPost: { mutate: noopMutate },
        generate: { mutate: noopMutate },
        uploadDataUri: { mutate: noopMutate },
        uploadRemote: { mutate: noopMutate },
      },
    },
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
    callAgentChatBridge: null,
    callAgentUploadChunk: null,
    runOpenClawPrompt: null,
  });
};

type VisualAutonomyInvoker = {
  resolveAutonomousTextTheme(input: {
    commandId: string;
    postKind: "post" | "thread";
    caption: string | null;
    textBody: string;
  }): string;
  buildAutonomousThreadSlides(input: {
    commandId: string;
    caption: string | null;
    textBody: string;
    theme: "warm" | "cool" | "night" | "sunrise" | "mint" | "ocean" | "plum" | "sand";
    postKind: "post" | "thread";
  }): Array<{ caption: string | null; imagePrompt: string }>;
  buildAutonomousMediaSlides(input: {
    commandId: string;
    postKind: "post" | "thread";
    caption: string | null;
    mediaPrompt: string;
    theme: "warm" | "cool" | "night" | "sunrise" | "mint" | "ocean" | "plum" | "sand";
  }): Array<{ caption: string | null; imagePrompt: string }>;
  normalizeAgentTextStyle(
    style: Record<string, unknown> | null,
    captionPosition: string | null,
    fallbackStyle?: Record<string, unknown> | null,
  ): Record<string, unknown>;
};

describe("command executor visual autonomy", () => {
  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
  });

  it("chooses tech-forward palette themes for technical thread language", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as VisualAutonomyInvoker;

    const theme = invoker.resolveAutonomousTextTheme({
      commandId: "cmd-tech-theme",
      postKind: "thread",
      caption: "Agent systems update",
      textBody:
        "First we ship agent runtime upgrades, then improve cloud orchestration and AI memory indexing across the platform.",
    });

    expect(theme).toBe("ocean");
  });

  it("generates thread slide plans for sequential thread content", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as VisualAutonomyInvoker;
    const textBody =
      "First map the architecture boundaries and constraints. " +
      "Second sequence the migration in small safe steps. " +
      "Third verify observability before rollout and document lessons learned.";
    let slides: Array<{ caption: string | null; imagePrompt: string }> = [];
    for (let index = 0; index < 64; index += 1) {
      slides = invoker.buildAutonomousThreadSlides({
        commandId: `cmd-thread-slides-${index}`,
        caption: "Runtime rollout plan",
        textBody,
        theme: "ocean",
        postKind: "thread",
      });
      if (slides.length >= 2) break;
    }
    expect(slides.length).toBeGreaterThanOrEqual(2);
    expect(slides[0]?.imagePrompt.length ?? 0).toBeGreaterThanOrEqual(24);
  });

  it("can generate slideshow plans for normal media posts with mixed text+media captions", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as VisualAutonomyInvoker;
    let slides: Array<{ caption: string | null; imagePrompt: string }> = [];
    for (let index = 0; index < 80; index += 1) {
      slides = invoker.buildAutonomousMediaSlides({
        commandId: `cmd-media-slides-${index}`,
        postKind: "post",
        caption: "Build update",
        mediaPrompt:
          "A cinematic tech lab with agents coordinating releases, glowing dashboards, and high-contrast detail moments.",
        theme: "ocean",
      });
      if (slides.length >= 2) break;
    }
    expect(slides.length).toBeGreaterThanOrEqual(2);
    expect(slides[0]?.caption ?? "").toContain("Build update");
    expect(slides[0]?.imagePrompt.length ?? 0).toBeGreaterThanOrEqual(24);
  });

  it("preserves extended text style themes and typographic emphasis", () => {
    const executor = createExecutor();
    const invoker = executor as unknown as VisualAutonomyInvoker;

    const normalized = invoker.normalizeAgentTextStyle(
      null,
      "middle-left",
      {
        theme: "plum",
        emphasis: "display",
        font: "display",
        weight: "bold",
        size: "xl",
        position: "middle-left",
        background: "linear-gradient(134deg, #231238 0%, #382059 46%, #5a2e71 100%)",
      },
    );

    expect(normalized.theme).toBe("plum");
    expect(normalized.emphasis).toBe("display");
    expect(normalized.font).toBe("display");
    expect(normalized.weight).toBe("bold");
    expect(normalized.position).toBe("middle-left");
    expect(normalized.color).toBe("paper");
    expect(typeof normalized.background).toBe("string");
  });
});
