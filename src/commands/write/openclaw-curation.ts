/** OpenClaw-based curation — visual planning, post draft curation, and media prompt curation. */

import type {
  CuratedPostDraft,
  CuratedPostDraftCacheEntry,
  GeneratedAssetType,
  OpenClawPromptExecutionResult,
  PostDraftContext,
  PostVarietyMode,
  TextPostVisualPlan,
} from "../types.js";

import { truncateText } from "../helpers.js";

import {
  extractTextPostVisualPlanFromUnknown,
  buildTextPostVisualPlanPrompt,
} from "./post-visual.js";

import {
  buildPostDraftCurationPrompt,
  extractCuratedPostDraftFromUnknown,
} from "./post-draft-curation.js";

import {
  buildMediaPromptCurationRequest,
  extractCuratedMediaPromptFromUnknown,
} from "../generate/media-curation.js";

import {
  buildCuratedPostDraftCacheKey,
  pruneCuratedPromptCaches,
} from "../cache/cache.js";

import { nowIso } from "../../lib/text.js";

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

type OpenClawPromptFn = (input: {
  prompt: string;
  purpose: string;
}) => Promise<OpenClawPromptExecutionResult | null>;

type MemoryWriter = { recordWrite(entry: unknown): Promise<void> };

type PostDraftCacheMap = Map<string, CuratedPostDraftCacheEntry>;
type MediaPromptCacheMap = Map<string, { prompt: string; cachedAtMs: number }>;

// ---------------------------------------------------------------------------
// planTextPostVisualWithOpenClaw
// ---------------------------------------------------------------------------

export async function planTextPostVisualWithOpenClaw(
  deps: { runOpenClawPrompt: OpenClawPromptFn | null; memory: MemoryWriter },
  input: {
    commandId: string;
    postKind: "post" | "thread";
    caption: string | null;
    textBody: string;
    context: PostDraftContext;
  },
): Promise<TextPostVisualPlan | null> {
  const runOpenClawPrompt = deps.runOpenClawPrompt;
  if (!runOpenClawPrompt) return null;
  const prompt = buildTextPostVisualPlanPrompt(input);
  try {
    const result = await runOpenClawPrompt({
      prompt,
      purpose: "text_post_visual_plan",
    });
    const plan =
      (result
        ? extractTextPostVisualPlanFromUnknown(result.parsed) ??
          extractTextPostVisualPlanFromUnknown(result.payloadText) ??
          extractTextPostVisualPlanFromUnknown(result.raw)
        : null) ?? null;
    if (!plan) return null;
    await deps.memory
      .recordWrite({
        type: "text_post_visual_plan_created",
        at: nowIso(),
        commandId: input.commandId,
        renderMode: plan.renderMode,
        captionPosition: plan.captionPosition,
        hasTextStyle: plan.textStyle !== null,
        hasBackgroundImagePrompt: plan.backgroundImagePrompt !== null,
        slideCount: plan.slides.length,
      })
      .catch(() => undefined);
    return plan;
  } catch (error: unknown) {
    await deps.memory
      .recordWrite({
        type: "text_post_visual_plan_failed",
        at: nowIso(),
        commandId: input.commandId,
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    return null;
  }
}

// ---------------------------------------------------------------------------
// curatePostDraftWithOpenClaw
// ---------------------------------------------------------------------------

export async function curatePostDraftWithOpenClaw(
  deps: {
    runOpenClawPrompt: OpenClawPromptFn | null;
    memory: MemoryWriter;
    curatedPostDraftCache: PostDraftCacheMap;
    curatedMediaPromptCache: MediaPromptCacheMap;
  },
  input: {
    commandId: string;
    postType: "text" | "media";
    varietyMode: PostVarietyMode;
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
    context: PostDraftContext;
    seedHints: string[];
    avoidReferences: string[];
  },
): Promise<CuratedPostDraft | null> {
  const runOpenClawPrompt = deps.runOpenClawPrompt;
  if (!runOpenClawPrompt) return null;
  pruneCuratedPromptCaches(deps.curatedPostDraftCache, deps.curatedMediaPromptCache);
  const cacheSignature = [
    input.varietyMode,
    input.caption ?? "",
    input.textBody ?? "",
    input.mediaPrompt ?? "",
    input.seedHints.join("|"),
    input.avoidReferences.join("|"),
  ].join("\n");
  const cacheKey = buildCuratedPostDraftCacheKey({
    commandId: input.commandId,
    postType: input.postType,
    signature: cacheSignature,
  });
  const cached = deps.curatedPostDraftCache.get(cacheKey);
  if (cached) {
    return {
      caption: cached.value.caption,
      textBody: cached.value.textBody,
      mediaPrompt: cached.value.mediaPrompt,
    };
  }
  const prompt = buildPostDraftCurationPrompt({
    postType: input.postType,
    varietyMode: input.varietyMode,
    caption: input.caption,
    textBody: input.textBody,
    mediaPrompt: input.mediaPrompt,
    context: input.context,
    seedHints: input.seedHints,
    avoidReferences: input.avoidReferences,
  });
  try {
    const result = await runOpenClawPrompt({
      prompt,
      purpose: "post_draft_curation",
    });
    const curated =
      (result
        ? extractCuratedPostDraftFromUnknown(result.parsed, input.postType) ??
          extractCuratedPostDraftFromUnknown(result.payloadText, input.postType) ??
          extractCuratedPostDraftFromUnknown(result.raw, input.postType)
        : null) ?? null;
    if (!curated) return null;
    const candidate = [
      curated.caption ?? input.caption ?? "",
      curated.textBody ?? "",
      curated.mediaPrompt ?? "",
    ]
      .filter((value) => value.trim().length > 0)
      .join("\n");
    if (candidate.length < 12) return null;
    deps.curatedPostDraftCache.set(cacheKey, {
      value: {
        caption: curated.caption,
        textBody: curated.textBody,
        mediaPrompt: curated.mediaPrompt,
      },
      cachedAtMs: Date.now(),
    });
    await deps.memory
      .recordWrite({
          type: "post_draft_curated",
          at: nowIso(),
          commandId: input.commandId,
          postType: input.postType,
          varietyMode: input.varietyMode,
          caption: curated.caption,
          textBody: curated.textBody,
          mediaPrompt: curated.mediaPrompt,
      })
      .catch(() => undefined);
    return curated;
  } catch (error: unknown) {
    await deps.memory
      .recordWrite({
          type: "post_draft_curation_failed",
          at: nowIso(),
          commandId: input.commandId,
          postType: input.postType,
          varietyMode: input.varietyMode,
          error: error instanceof Error ? error.message : String(error),
        })
      .catch(() => undefined);
    return null;
  }
}

// ---------------------------------------------------------------------------
// curateMediaPromptWithOpenClaw
// ---------------------------------------------------------------------------

export async function curateMediaPromptWithOpenClaw(
  deps: { runOpenClawPrompt: OpenClawPromptFn | null; memory: MemoryWriter },
  input: {
    sourcePrompt: string;
    generatedAssetType: GeneratedAssetType;
    mode: string;
  },
): Promise<string> {
  const runOpenClawPrompt = deps.runOpenClawPrompt;
  if (!runOpenClawPrompt) {
    throw new Error("prompt_curation_unavailable");
  }
  const curationPrompt = buildMediaPromptCurationRequest(input);
  const result = await runOpenClawPrompt({
    prompt: curationPrompt,
    purpose: "media_prompt_curation",
  });
  const curatedPrompt =
    (result
      ? extractCuratedMediaPromptFromUnknown(result.parsed) ??
        extractCuratedMediaPromptFromUnknown(result.payloadText) ??
        extractCuratedMediaPromptFromUnknown(result.raw)
      : null) ?? null;
  if (!curatedPrompt || curatedPrompt.trim().length < 8) {
    await deps.memory
      .recordWrite({
        type: "media_prompt_curation_failed",
        at: nowIso(),
        mode: input.mode,
        generatedAssetType: input.generatedAssetType,
        sourcePrompt: truncateText(input.sourcePrompt, 220),
        reason: "openclaw_no_usable_prompt",
      })
      .catch(() => undefined);
    throw new Error("prompt_curation_failed");
  }
  await deps.memory
    .recordWrite({
      type: "media_prompt_curated",
      at: nowIso(),
      mode: input.mode,
      generatedAssetType: input.generatedAssetType,
      sourcePrompt: truncateText(input.sourcePrompt, 220),
      curatedPrompt: truncateText(curatedPrompt, 360),
    })
    .catch(() => undefined);
  return curatedPrompt;
}
