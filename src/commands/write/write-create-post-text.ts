import { TEXT_STYLE_DEFAULT_COLOR_BY_THEME } from "../constants.js";
import { RequeueCommandError } from "../types.js";
import type { CommandOutcome } from "../types.js";
import { asNonEmptyString, stripEmDashCharacters, truncateText } from "../helpers.js";
import { nowIso } from "../../lib/text.js";
import type {
  ExecuteWriteCreatePostRuntime,
  WriteCreatePostCommonInput,
} from "./write-create-post.js";

export async function executeWriteCreatePostText(
  this: ExecuteWriteCreatePostRuntime,
  input: WriteCreatePostCommonInput,
): Promise<CommandOutcome> {
  const {
    command,
    payload,
    postType,
    postKind,
    sourceDirectiveId,
    sourceDirectiveActionNonce,
    provenance,
    postDraftContext,
    requiresCuration,
    directiveSinglePromptMode,
    directiveSeedHints,
    directiveTaggedHandles,
    postVariety,
  } = input;

  const buildBase = (
    caption: string | null,
    basePostType: "text" | "media" = postType,
  ): Record<string, unknown> => ({
    kind: postKind,
    postType: basePostType,
    ...(caption ? { caption } : {}),
    ...(provenance ? { provenance } : {}),
    ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
    ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
    ...(command.grantId ? { grantId: command.grantId } : {}),
  });

  const skippedPostOutcome = (reason: string): CommandOutcome =>
    this.successOutcome(command, {
      skipped: true,
      action: "post",
      postType,
      postKind,
      decision: reason,
    });

  const textBodyInitial = asNonEmptyString(payload.textBody);
  if (!textBodyInitial) {
    return this.failedOutcome(command, "textBody is required for text posts.");
  }
  const captionInitial = asNonEmptyString(payload.caption);
  const noveltyAvoidReferences = this.snapshotRecentPostNoveltyReferences("text");
  const curatedTextDraft = await this.curatePostDraftWithOpenClaw({
    commandId: command.id,
    postType: "text",
    varietyMode: postVariety.mode,
    caption: captionInitial,
    textBody: textBodyInitial,
    mediaPrompt: null,
    context: postDraftContext,
    seedHints: directiveSeedHints,
    avoidReferences: noveltyAvoidReferences,
    taggedHandles: directiveTaggedHandles,
  });
  if (requiresCuration && !curatedTextDraft) {
    throw new RequeueCommandError(
      "post_curation_waiting_for_openclaw:text_curation_unavailable",
    );
  }
  let captionForWrite = curatedTextDraft?.caption ?? captionInitial;
  let textBodyForWrite = curatedTextDraft?.textBody ?? textBodyInitial;
  let selectedTaggedHandlesForMediaGeneration =
    curatedTextDraft?.selectedTaggedHandles ?? null;
  let useTargetContextForMediaGeneration =
    curatedTextDraft?.useTargetContext ?? null;
  let targetKindForMediaGeneration =
    curatedTextDraft?.targetKind ?? null;
  captionForWrite = captionForWrite ? stripEmDashCharacters(captionForWrite) : captionForWrite;
  textBodyForWrite = stripEmDashCharacters(textBodyForWrite);
  if (!textBodyForWrite) {
    return this.failedOutcome(command, "textBody is required for text posts.");
  }
  let noveltyValidation = this.validatePostDraftNovelty({
    postType: "text",
    caption: captionForWrite,
    textBody: textBodyForWrite,
    mediaPrompt: null,
    context: postDraftContext,
    seedHints: directiveSeedHints,
  });
  if (!noveltyValidation.ok) {
    await this.ctx.memory
      .recordWrite({
        type: "post_novelty_rejected",
        at: nowIso(),
        commandId: command.id,
        postType: "text",
        reason: noveltyValidation.reason,
        candidatePreview: truncateText(noveltyValidation.candidateText, 240),
        referencePreview: noveltyValidation.referencePreview,
      })
      .catch(() => undefined);
    if (directiveSinglePromptMode) {
      await this.ctx.memory
        .recordWrite({
          type: "post_novelty_recuration_skipped",
          at: nowIso(),
          commandId: command.id,
          postType: "text",
          reason: noveltyValidation.reason,
          policy: "single_prompt_per_directive",
        })
        .catch(() => undefined);
      noveltyValidation = {
        ok: true,
        candidateText: this.buildPostNoveltyCandidateText({
          postType: "text",
          caption: captionForWrite,
          textBody: textBodyForWrite,
          mediaPrompt: null,
        }),
      };
    } else {
      const recurationReferences = Array.from(
        new Set<string>(
          [
            ...noveltyAvoidReferences,
            noveltyValidation.referencePreview ?? "",
            truncateText(noveltyValidation.candidateText, 260),
          ]
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
        ),
      );
      const recuratedTextDraft = await this.curatePostDraftWithOpenClaw({
        commandId: command.id,
        postType: "text",
        varietyMode: postVariety.mode,
        caption: captionForWrite,
        textBody: textBodyForWrite,
        mediaPrompt: null,
        context: postDraftContext,
        seedHints: directiveSeedHints,
        avoidReferences: recurationReferences,
        taggedHandles: directiveTaggedHandles,
      });
      if (!recuratedTextDraft) {
        if (requiresCuration) {
          throw new RequeueCommandError(
            "post_curation_waiting_for_openclaw:text_novelty_recuration_unavailable",
          );
        }
        return this.failedOutcome(
          command,
          `Blocked text post draft due to low novelty (${noveltyValidation.reason}).`,
          "post_novelty_rejected",
        );
      }
      captionForWrite = recuratedTextDraft.caption ?? captionForWrite;
      textBodyForWrite = recuratedTextDraft.textBody ?? textBodyForWrite;
      selectedTaggedHandlesForMediaGeneration =
        recuratedTextDraft.selectedTaggedHandles ?? null;
      useTargetContextForMediaGeneration =
        recuratedTextDraft.useTargetContext ?? null;
      targetKindForMediaGeneration =
        recuratedTextDraft.targetKind ?? null;
      captionForWrite = captionForWrite ? stripEmDashCharacters(captionForWrite) : captionForWrite;
      textBodyForWrite = stripEmDashCharacters(textBodyForWrite);
      noveltyValidation = this.validatePostDraftNovelty({
        postType: "text",
        caption: captionForWrite,
        textBody: textBodyForWrite,
        mediaPrompt: null,
        context: postDraftContext,
        seedHints: directiveSeedHints,
      });
      if (!noveltyValidation.ok) {
        await this.ctx.memory
          .recordWrite({
            type: "post_novelty_blocked",
            at: nowIso(),
            commandId: command.id,
            postType: "text",
            reason: noveltyValidation.reason,
            candidatePreview: truncateText(noveltyValidation.candidateText, 240),
            referencePreview: noveltyValidation.referencePreview,
          })
          .catch(() => undefined);
        return this.failedOutcome(
          command,
          `Blocked text post draft due to low novelty (${noveltyValidation.reason}).`,
          "post_novelty_blocked",
        );
      }
      await this.ctx.memory
        .recordWrite({
          type: "post_novelty_recurated",
          at: nowIso(),
          commandId: command.id,
          postType: "text",
        })
        .catch(() => undefined);
    }
  }
  const candidate = noveltyValidation.candidateText;
  const autonomousTheme = this.resolveAutonomousTextTheme({
    commandId: command.id,
    postKind,
    caption: captionForWrite,
    textBody: textBodyForWrite,
  });
  const autonomousCaptionPosition = this.resolveAutonomousCaptionPosition({
    commandId: command.id,
    postKind,
    seedText: `${captionForWrite ?? ""} ${textBodyForWrite}`,
  });
  const autonomousAlign = autonomousCaptionPosition.split("-")[1] ?? "center";
  const emphasisOptions =
    postKind === "thread"
      ? (["display", "bold", "mono", "serif"] as const)
      : (["soft", "bold", "serif", "mono"] as const);
  const fontOptions =
    postKind === "thread"
      ? (["display", "sans", "mono", "serif"] as const)
      : (["sans", "serif", "mono", "display"] as const);
  const sizeOptions =
    postKind === "thread"
      ? (["xl", "2xl", "lg"] as const)
      : (["lg", "xl", "md"] as const);
  const autonomousStyleFallback: Record<string, unknown> = {
    theme: autonomousTheme,
    align:
      autonomousAlign === "left" ||
      autonomousAlign === "center" ||
      autonomousAlign === "right"
        ? autonomousAlign
        : "center",
    emphasis:
      emphasisOptions[
        this.pickDeterministicIndex(
          `${command.id}:${candidate}:text_emphasis`,
          emphasisOptions.length,
        )
      ] ?? "soft",
    font:
      fontOptions[
        this.pickDeterministicIndex(
          `${command.id}:${candidate}:text_font`,
          fontOptions.length,
        )
      ] ?? "sans",
    weight:
      this.pickDeterministicIndex(`${command.id}:${candidate}:text_weight`, 100) < 52
        ? "bold"
        : "regular",
    size:
      sizeOptions[
        this.pickDeterministicIndex(
          `${command.id}:${candidate}:text_size`,
          sizeOptions.length,
        )
      ] ?? "lg",
    italic:
      this.pickDeterministicIndex(`${command.id}:${candidate}:text_italic`, 100) < 24,
    color: TEXT_STYLE_DEFAULT_COLOR_BY_THEME[autonomousTheme],
    position: autonomousCaptionPosition,
    background: this.resolveAutonomousGradientBackground(
      autonomousTheme,
      `${command.id}:${candidate}:text_background`,
    ),
  };
  const visualPlan = await this.planTextPostVisualWithOpenClaw({
    commandId: command.id,
    postKind,
    caption: captionForWrite,
    textBody: textBodyForWrite,
    context: postDraftContext,
  });
  const captionPositionForWrite =
    this.normalizeCaptionPositionValue(payload.captionPosition) ??
    visualPlan?.captionPosition ??
    autonomousCaptionPosition;
  const normalizedTextStyle = this.normalizeAgentTextStyle(
    this.sanitizeTextStyleValue(payload.textStyle) ?? visualPlan?.textStyle ?? null,
    captionPositionForWrite,
    autonomousStyleFallback,
  );
  const plannerSlides = visualPlan?.slides.slice(0, 4) ?? [];
  const autonomousSlides = this.buildAutonomousThreadSlides({
    commandId: command.id,
    caption: captionForWrite,
    textBody: textBodyForWrite,
    theme: autonomousTheme,
    postKind,
  });
  const selectedSlides = plannerSlides.length >= 2 ? plannerSlides : autonomousSlides;
  const shouldAttemptSlides =
    selectedSlides.length >= 2 &&
    (visualPlan?.renderMode === "slides" || postKind === "thread");
  const mediaGenerationPayloadBase =
    this.buildDirectiveScopedMediaGenerationPayload({
      payload,
      selectedTaggedHandles: selectedTaggedHandlesForMediaGeneration,
      useTargetContext: useTargetContextForMediaGeneration,
      targetKind: targetKindForMediaGeneration,
    });
  const visualBackgroundPromptRaw =
    visualPlan?.backgroundImagePrompt ??
    this.buildAutonomousTextBackgroundPrompt({
      commandId: command.id,
      caption: captionForWrite,
      textBody: textBodyForWrite,
      theme: autonomousTheme,
      postKind,
    });
  const visualBackgroundPrompt = visualBackgroundPromptRaw
    ? stripEmDashCharacters(visualBackgroundPromptRaw).trim()
    : "";
  const shouldAttemptImageBackground =
    !shouldAttemptSlides && visualBackgroundPrompt.length >= 8;
  if (shouldAttemptSlides) {
    const slideItems: Array<Record<string, unknown>> = [];
    const slidePrompts = selectedSlides.slice(0, 4);
    for (const slide of slidePrompts) {
      const slidePrompt = stripEmDashCharacters(slide.imagePrompt).trim();
      if (slidePrompt.length < 8) continue;
      const slideMedia = await this.resolveMediaUpload({
        payload: {
          ...mediaGenerationPayloadBase,
          generatedAssetType: "image",
        },
        keepOriginal: true,
        promptFallbacks: [slidePrompt],
        command,
        skipPromptCuration: true,
      });
      slideItems.push({
        mediaUrl: slideMedia.mediaUrl,
        ...(slideMedia.mediaOriginalUrl
          ? { mediaOriginalUrl: slideMedia.mediaOriginalUrl }
          : {}),
        ...(slideMedia.mediaOptimizedUrl
          ? { mediaOptimizedUrl: slideMedia.mediaOptimizedUrl }
          : {}),
        ...(slideMedia.mediaContentHash
          ? { mediaContentHash: slideMedia.mediaContentHash }
          : {}),
        ...(slideMedia.mediaIpfsCid
          ? { mediaIpfsCid: slideMedia.mediaIpfsCid }
          : {}),
        ...(typeof slideMedia.mediaSizeBytes === "number"
          ? { mediaSizeBytes: slideMedia.mediaSizeBytes }
          : {}),
        ...(slideMedia.mediaType ? { mediaType: slideMedia.mediaType } : {}),
        ...(slide.caption ? { caption: slide.caption } : {}),
        ...(captionPositionForWrite
          ? { captionPosition: captionPositionForWrite }
          : {}),
      });
    }
    if (slideItems.length >= 2) {
      const firstSlide = slideItems[0] ?? {};
      const firstSlideMediaUrl = asNonEmptyString(firstSlide.mediaUrl);
      if (firstSlideMediaUrl) {
        const slideMutation = await this.executeCreatePostMutationWithIdempotency({
          command,
          postType: "media",
          postKind,
          mutationInput: {
            ...buildBase(captionForWrite, "media"),
            mediaUrl: firstSlideMediaUrl,
            ...(asNonEmptyString(firstSlide.mediaOriginalUrl)
              ? { mediaOriginalUrl: asNonEmptyString(firstSlide.mediaOriginalUrl) }
              : {}),
            ...(asNonEmptyString(firstSlide.mediaOptimizedUrl)
              ? { mediaOptimizedUrl: asNonEmptyString(firstSlide.mediaOptimizedUrl) }
              : {}),
            ...(asNonEmptyString(firstSlide.mediaContentHash)
              ? { mediaContentHash: asNonEmptyString(firstSlide.mediaContentHash) }
              : {}),
            ...(asNonEmptyString(firstSlide.mediaIpfsCid)
              ? { mediaIpfsCid: asNonEmptyString(firstSlide.mediaIpfsCid) }
              : {}),
            ...(typeof firstSlide.mediaSizeBytes === "number" &&
            Number.isFinite(firstSlide.mediaSizeBytes)
              ? {
                  mediaSizeBytes: Math.max(
                    1,
                    Math.floor(firstSlide.mediaSizeBytes),
                  ),
                }
              : {}),
            ...(asNonEmptyString(firstSlide.mediaType)
              ? { mediaType: asNonEmptyString(firstSlide.mediaType) }
              : {}),
            mediaItems: slideItems,
            ...(captionPositionForWrite
              ? { captionPosition: captionPositionForWrite }
              : {}),
          },
        });
        if (slideMutation.skipped) {
          return skippedPostOutcome(slideMutation.reason);
        }
        const slideResult = slideMutation.result;
        this.consumeGrantedAction([
          `post:${postKind}:media`,
          `post:${postKind}:text`,
          "write.createPost",
        ]);
        this.notePublishedPostForNoveltyHistory({
          postType: "media",
          caption: captionForWrite,
          textBody: null,
          mediaPrompt: slidePrompts
            .map((entry) => entry.imagePrompt)
            .join(" | "),
          commandId: command.id,
          targetPostId: postDraftContext.targetPostId,
        });
        this.notePublishedPostVarietyMode({
          commandId: command.id,
          postType: "media",
          targetPostId: postDraftContext.targetPostId,
          mode: postVariety.mode,
          signal: postVariety.signal,
        });
        await this.ctx.memory
          .recordWrite({
            type: "runtime_post_publish_recorded",
            at: nowIso(),
            commandId: command.id,
            kind: postKind,
            postType: "media",
            varietyMode: postVariety.mode,
            targetPostId: postDraftContext.targetPostId,
            bodyPreview: truncateText(candidate, 260),
            visualRenderMode:
              plannerSlides.length >= 2 ? "slides" : "autonomous_slides",
            slideCount: slideItems.length,
            textStyleTheme: autonomousTheme,
          })
          .catch(() => undefined);
        return this.successOutcome(command, slideResult);
      }
    }
    await this.ctx.memory
      .recordWrite({
        type: "text_post_slides_fallback",
        at: nowIso(),
        commandId: command.id,
        slideCountRequested: slidePrompts.length,
        slideCountResolved: slideItems.length,
      })
      .catch(() => undefined);
  }
  if (shouldAttemptImageBackground) {
    try {
      const backgroundMedia = await this.resolveMediaUpload({
        payload: {
          ...mediaGenerationPayloadBase,
          generatedAssetType: "image",
        },
        keepOriginal: true,
        promptFallbacks: [visualBackgroundPrompt],
        command,
        skipPromptCuration: true,
      });
      const imageTextItem: Record<string, unknown> = {
        mediaUrl: backgroundMedia.mediaUrl,
        ...(backgroundMedia.mediaOriginalUrl
          ? { mediaOriginalUrl: backgroundMedia.mediaOriginalUrl }
          : {}),
        ...(backgroundMedia.mediaOptimizedUrl
          ? { mediaOptimizedUrl: backgroundMedia.mediaOptimizedUrl }
          : {}),
        ...(backgroundMedia.mediaContentHash
          ? { mediaContentHash: backgroundMedia.mediaContentHash }
          : {}),
        ...(backgroundMedia.mediaIpfsCid
          ? { mediaIpfsCid: backgroundMedia.mediaIpfsCid }
          : {}),
        ...(typeof backgroundMedia.mediaSizeBytes === "number"
          ? { mediaSizeBytes: backgroundMedia.mediaSizeBytes }
          : {}),
        ...(backgroundMedia.mediaType
          ? { mediaType: backgroundMedia.mediaType }
          : {}),
        caption: textBodyForWrite,
        ...(captionPositionForWrite
          ? { captionPosition: captionPositionForWrite }
          : {}),
      };
      const imageTextMutation = await this.executeCreatePostMutationWithIdempotency({
        command,
        postType: "media",
        postKind,
        mutationInput: {
          ...buildBase(captionForWrite, "media"),
          mediaUrl: backgroundMedia.mediaUrl,
          ...(backgroundMedia.mediaOriginalUrl
            ? { mediaOriginalUrl: backgroundMedia.mediaOriginalUrl }
            : {}),
          ...(backgroundMedia.mediaOptimizedUrl
            ? { mediaOptimizedUrl: backgroundMedia.mediaOptimizedUrl }
            : {}),
          ...(backgroundMedia.mediaContentHash
            ? { mediaContentHash: backgroundMedia.mediaContentHash }
            : {}),
          ...(backgroundMedia.mediaIpfsCid
            ? { mediaIpfsCid: backgroundMedia.mediaIpfsCid }
            : {}),
          ...(typeof backgroundMedia.mediaSizeBytes === "number" &&
          Number.isFinite(backgroundMedia.mediaSizeBytes)
            ? {
                mediaSizeBytes: Math.max(
                  1,
                  Math.floor(backgroundMedia.mediaSizeBytes),
                ),
              }
            : {}),
          ...(backgroundMedia.mediaType
            ? { mediaType: backgroundMedia.mediaType }
            : {}),
          mediaItems: [imageTextItem],
          ...(captionPositionForWrite
            ? { captionPosition: captionPositionForWrite }
            : {}),
        },
      });
      if (imageTextMutation.skipped) {
        return skippedPostOutcome(imageTextMutation.reason);
      }
      const imageTextResult = imageTextMutation.result;
      this.consumeGrantedAction([
        `post:${postKind}:media`,
        `post:${postKind}:text`,
        "write.createPost",
      ]);
      this.notePublishedPostForNoveltyHistory({
        postType: "media",
        caption: captionForWrite,
        textBody: null,
        mediaPrompt: visualBackgroundPrompt,
        commandId: command.id,
        targetPostId: postDraftContext.targetPostId,
      });
      this.notePublishedPostVarietyMode({
        commandId: command.id,
        postType: "media",
        targetPostId: postDraftContext.targetPostId,
        mode: postVariety.mode,
        signal: postVariety.signal,
      });
      await this.ctx.memory
        .recordWrite({
          type: "runtime_post_publish_recorded",
          at: nowIso(),
          commandId: command.id,
          kind: postKind,
          postType: "media",
          varietyMode: postVariety.mode,
          targetPostId: postDraftContext.targetPostId,
          bodyPreview: truncateText(candidate, 260),
          visualRenderMode:
            visualPlan?.backgroundImagePrompt !== null &&
            visualPlan?.backgroundImagePrompt !== undefined
              ? "image_text"
              : "autonomous_image_text",
          textStyleTheme: autonomousTheme,
        })
        .catch(() => undefined);
      return this.successOutcome(command, imageTextResult);
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "text_post_visual_background_failed",
          at: nowIso(),
          commandId: command.id,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
    }
  }

  const textMutation = await this.executeCreatePostMutationWithIdempotency({
    command,
    postType: "text",
    postKind,
    mutationInput: {
      ...buildBase(captionForWrite, "text"),
      textBody: textBodyForWrite,
      textStyle: normalizedTextStyle,
      ...(captionPositionForWrite ? { captionPosition: captionPositionForWrite } : {}),
    },
  });
  if (textMutation.skipped) {
    return skippedPostOutcome(textMutation.reason);
  }
  const result = textMutation.result;
  this.consumeGrantedAction([
    `post:${postKind}:text`,
    `post:${postKind}:media`,
    "write.createPost",
  ]);
  this.notePublishedPostForNoveltyHistory({
    postType: "text",
    caption: captionForWrite,
    textBody: textBodyForWrite,
    mediaPrompt: null,
    commandId: command.id,
    targetPostId: postDraftContext.targetPostId,
  });
  this.notePublishedPostVarietyMode({
    commandId: command.id,
    postType: "text",
    targetPostId: postDraftContext.targetPostId,
    mode: postVariety.mode,
    signal: postVariety.signal,
  });
  await this.ctx.memory
    .recordWrite({
      type: "runtime_post_publish_recorded",
      at: nowIso(),
      commandId: command.id,
      kind: postKind,
      postType,
      varietyMode: postVariety.mode,
      targetPostId: postDraftContext.targetPostId,
      bodyPreview: truncateText(candidate, 260),
      visualRenderMode: shouldAttemptSlides
        ? shouldAttemptImageBackground
          ? "text_after_slides_and_image_fallback"
          : "text_after_slides_fallback"
        : shouldAttemptImageBackground
          ? "text_after_image_background_fallback"
          : "text",
      textStyleTheme: asNonEmptyString(normalizedTextStyle.theme),
      captionPosition: captionPositionForWrite,
    })
    .catch(() => undefined);
  return this.successOutcome(command, result);
}
