/** OpenClaw-based curation — visual planning, post draft curation, and media prompt curation. */

import type {
  CuratedPostDraft,
  CuratedPostDraftCacheEntry,
  GeneratedAssetType,
  OpenClawPromptExecutionResult,
  PostDraftDecision,
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
  buildPostDraftDecisionPrompt,
  extractPostDraftDecisionFromUnknown,
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

async function decidePostDraftWithOpenClaw(
  deps: { runOpenClawPrompt: OpenClawPromptFn | null; memory: MemoryWriter },
  input: {
    commandId: string;
    postType: "text" | "media";
    varietyMode: PostVarietyMode;
    context: PostDraftContext;
    seedHints: string[];
    avoidReferences: string[];
    taggedHandles: string[];
  },
): Promise<PostDraftDecision | null> {
  const runOpenClawPrompt = deps.runOpenClawPrompt;
  if (!runOpenClawPrompt) return null;
  const prompt = buildPostDraftDecisionPrompt({
    postType: input.postType,
    context: input.context,
    varietyMode: input.varietyMode,
    seedHints: input.seedHints,
    avoidReferences: input.avoidReferences,
    taggedHandles: input.taggedHandles,
  });
  try {
    const result = await runOpenClawPrompt({
      prompt,
      purpose: "post_draft_decision",
    });
    const decision =
      (result
        ? extractPostDraftDecisionFromUnknown(result.parsed) ??
          extractPostDraftDecisionFromUnknown(result.payloadText) ??
          extractPostDraftDecisionFromUnknown(result.raw)
        : null) ?? null;
    if (!decision) return null;
    await deps.memory
      .recordWrite({
        type: "post_draft_decided",
        at: nowIso(),
        commandId: input.commandId,
        postType: input.postType,
        varietyMode: input.varietyMode,
        focus: decision.focus,
        targetKind: decision.targetKind,
        useTargetContext: decision.useTargetContext,
        includeTaggedHandles: decision.includeTaggedHandles,
        reason: decision.reason,
      })
      .catch(() => undefined);
    return decision;
  } catch (error: unknown) {
    await deps.memory
      .recordWrite({
        type: "post_draft_decision_failed",
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
    taggedHandles: string[];
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
    input.taggedHandles.join("|"),
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
      selectedTaggedHandles: cached.value.selectedTaggedHandles,
      useTargetContext: cached.value.useTargetContext,
      targetKind: cached.value.targetKind,
    };
  }
  const decision = await decidePostDraftWithOpenClaw(
    {
      runOpenClawPrompt: deps.runOpenClawPrompt,
      memory: deps.memory,
    },
    {
      commandId: input.commandId,
      postType: input.postType,
      varietyMode: input.varietyMode,
      context: input.context,
      seedHints: input.seedHints,
      avoidReferences: input.avoidReferences,
      taggedHandles: input.taggedHandles,
    },
  );
  const prompt = buildPostDraftCurationPrompt({
    postType: input.postType,
    varietyMode: input.varietyMode,
    caption: input.caption,
    textBody: input.textBody,
    mediaPrompt: input.mediaPrompt,
    context: input.context,
    seedHints: input.seedHints,
    avoidReferences: input.avoidReferences,
    taggedHandles: input.taggedHandles,
    decision,
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
        selectedTaggedHandles:
          curated.selectedTaggedHandles ?? decision?.includeTaggedHandles ?? null,
        useTargetContext:
          curated.useTargetContext ?? decision?.useTargetContext ?? null,
        targetKind:
          curated.targetKind ?? decision?.targetKind ?? null,
      },
      cachedAtMs: Date.now(),
    });
    const selectedTaggedHandles =
      curated.selectedTaggedHandles ?? decision?.includeTaggedHandles ?? null;
    const useTargetContext =
      curated.useTargetContext ?? decision?.useTargetContext ?? null;
    const targetKind =
      curated.targetKind ?? decision?.targetKind ?? null;
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
          selectedTaggedHandles,
          useTargetContext,
          targetKind,
      })
      .catch(() => undefined);
    return {
      caption: curated.caption,
      textBody: curated.textBody,
      mediaPrompt: curated.mediaPrompt,
      selectedTaggedHandles,
      useTargetContext,
      targetKind,
    };
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
