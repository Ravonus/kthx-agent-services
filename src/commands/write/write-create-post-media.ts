import { RequeueCommandError } from "../types.js";
import type { CommandOutcome } from "../types.js";
import { asNonEmptyString, stripEmDashCharacters, truncateText } from "../helpers.js";
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";
import type {
  ExecuteWriteCreatePostRuntime,
  WriteCreatePostCommonInput,
} from "./write-create-post.js";

export async function executeWriteCreatePostMedia(
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
    explicitSaveAsProfileMemory,
  } = input;

  let saveAsProfileMemoryForMedia = explicitSaveAsProfileMemory === true;

  const buildBase = (
    caption: string | null,
    basePostType: "text" | "media" = postType,
  ): Record<string, unknown> => ({
    kind: postKind,
    postType: basePostType,
    ...(caption ? { caption } : {}),
    ...(basePostType === "media" && saveAsProfileMemoryForMedia
      ? { saveAsProfileMemory: true }
      : {}),
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

  const captionInitial = asNonEmptyString(payload.caption);
  const mediaPromptInitial =
    asNonEmptyString(payload.mediaPrompt) ??
    asNonEmptyString(payload.imagePrompt) ??
    asNonEmptyString(payload.prompt);
  const noveltyAvoidReferences = this.snapshotRecentPostNoveltyReferences("media");
  const curatedMediaDraft = await this.curatePostDraftWithOpenClaw({
    commandId: command.id,
    postType: "media",
    varietyMode: postVariety.mode,
    caption: captionInitial,
    textBody: null,
    mediaPrompt: mediaPromptInitial,
    context: postDraftContext,
    seedHints: directiveSeedHints,
    avoidReferences: noveltyAvoidReferences,
    taggedHandles: directiveTaggedHandles,
  });
  if (requiresCuration && !curatedMediaDraft) {
    throw new RequeueCommandError(
      "post_curation_waiting_for_openclaw:media_curation_unavailable",
    );
  }
  let captionForWrite = curatedMediaDraft?.caption ?? captionInitial;
  let mediaPromptForWrite = curatedMediaDraft?.mediaPrompt ?? mediaPromptInitial;
  let selectedTaggedHandlesForMediaGeneration =
    curatedMediaDraft?.selectedTaggedHandles ?? null;
  let useTargetContextForMediaGeneration =
    curatedMediaDraft?.useTargetContext ?? null;
  captionForWrite = captionForWrite ? stripEmDashCharacters(captionForWrite) : captionForWrite;
  mediaPromptForWrite = mediaPromptForWrite
    ? stripEmDashCharacters(mediaPromptForWrite)
    : mediaPromptForWrite;
  let noveltyValidation = this.validatePostDraftNovelty({
    postType: "media",
    caption: captionForWrite,
    textBody: null,
    mediaPrompt: mediaPromptForWrite,
    context: postDraftContext,
    seedHints: directiveSeedHints,
  });
  if (!noveltyValidation.ok) {
    await this.ctx.memory
      .recordWrite({
        type: "post_novelty_rejected",
        at: nowIso(),
        commandId: command.id,
        postType: "media",
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
          postType: "media",
          reason: noveltyValidation.reason,
          policy: "single_prompt_per_directive",
        })
        .catch(() => undefined);
      noveltyValidation = {
        ok: true,
        candidateText: this.buildPostNoveltyCandidateText({
          postType: "media",
          caption: captionForWrite,
          textBody: null,
          mediaPrompt: mediaPromptForWrite,
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
      const recuratedMediaDraft = await this.curatePostDraftWithOpenClaw({
        commandId: command.id,
        postType: "media",
        varietyMode: postVariety.mode,
        caption: captionForWrite,
        textBody: null,
        mediaPrompt: mediaPromptForWrite,
        context: postDraftContext,
        seedHints: directiveSeedHints,
        avoidReferences: recurationReferences,
        taggedHandles: directiveTaggedHandles,
      });
      if (!recuratedMediaDraft) {
        if (requiresCuration) {
          throw new RequeueCommandError(
            "post_curation_waiting_for_openclaw:media_novelty_recuration_unavailable",
          );
        }
        return this.failedOutcome(
          command,
          `Blocked media post draft due to low novelty (${noveltyValidation.reason}).`,
          "post_novelty_rejected",
        );
      }
      captionForWrite = recuratedMediaDraft.caption ?? captionForWrite;
      mediaPromptForWrite = recuratedMediaDraft.mediaPrompt ?? mediaPromptForWrite;
      selectedTaggedHandlesForMediaGeneration =
        recuratedMediaDraft.selectedTaggedHandles ?? null;
      useTargetContextForMediaGeneration =
        recuratedMediaDraft.useTargetContext ?? null;
      captionForWrite = captionForWrite ? stripEmDashCharacters(captionForWrite) : captionForWrite;
      mediaPromptForWrite = mediaPromptForWrite
        ? stripEmDashCharacters(mediaPromptForWrite)
        : mediaPromptForWrite;
      noveltyValidation = this.validatePostDraftNovelty({
        postType: "media",
        caption: captionForWrite,
        textBody: null,
        mediaPrompt: mediaPromptForWrite,
        context: postDraftContext,
        seedHints: directiveSeedHints,
      });
      if (!noveltyValidation.ok) {
        await this.ctx.memory
          .recordWrite({
            type: "post_novelty_blocked",
            at: nowIso(),
            commandId: command.id,
            postType: "media",
            reason: noveltyValidation.reason,
            candidatePreview: truncateText(noveltyValidation.candidateText, 240),
            referencePreview: noveltyValidation.referencePreview,
          })
          .catch(() => undefined);
        return this.failedOutcome(
          command,
          `Blocked media post draft due to low novelty (${noveltyValidation.reason}).`,
          "post_novelty_blocked",
        );
      }
      await this.ctx.memory
        .recordWrite({
          type: "post_novelty_recurated",
          at: nowIso(),
          commandId: command.id,
          postType: "media",
        })
        .catch(() => undefined);
    }
  }
  const mediaCandidate = noveltyValidation.candidateText;
  const mediaSeedText = mediaPromptForWrite ?? captionForWrite ?? mediaCandidate;
  const mediaGenerationPayloadBase =
    this.buildDirectiveScopedMediaGenerationPayload({
      payload,
      selectedTaggedHandles: selectedTaggedHandlesForMediaGeneration,
      useTargetContext: useTargetContextForMediaGeneration,
    });
  const personaReferencePlan =
    this.resolvePersonaReferencePlan(mediaGenerationPayloadBase, null, command);
  const personaDrivenMediaGeneration = this.shouldUsePersonaFrameReferences(personaReferencePlan);
  if (explicitSaveAsProfileMemory === null && personaDrivenMediaGeneration) {
    saveAsProfileMemoryForMedia = true;
  }
  const carriedMediaPresent =
    asNonEmptyString(payload.mediaUrl) !== null ||
    (Array.isArray(payload.mediaItems) && payload.mediaItems.length > 0) ||
    isRecord(payload.recentGeneratedAsset);
  if (personaDrivenMediaGeneration && carriedMediaPresent) {
    delete mediaGenerationPayloadBase.mediaUrl;
    delete mediaGenerationPayloadBase.mediaOriginalUrl;
    delete mediaGenerationPayloadBase.mediaOptimizedUrl;
    delete mediaGenerationPayloadBase.mediaContentHash;
    delete mediaGenerationPayloadBase.mediaIpfsCid;
    delete mediaGenerationPayloadBase.mediaSizeBytes;
    delete mediaGenerationPayloadBase.mediaType;
    delete mediaGenerationPayloadBase.mediaItems;
    delete mediaGenerationPayloadBase.recentGeneratedAsset;
    await this.ctx.memory
      .recordWrite({
        type: "media_post_persona_carryover_stripped",
        at: nowIso(),
        commandId: command.id,
        commandKind: command.kind,
        sourceDirectiveId,
        personaSlug: personaReferencePlan.targetPersonaSlug,
      })
      .catch(() => undefined);
  }
  const autonomousMediaTheme = this.resolveAutonomousTextTheme({
    commandId: command.id,
    postKind,
    caption: captionForWrite,
    textBody: mediaSeedText,
  });
  const captionPositionForWrite =
    this.normalizeCaptionPositionValue(payload.captionPosition) ??
    this.resolveAutonomousCaptionPosition({
      commandId: command.id,
      postKind,
      seedText: `${captionForWrite ?? ""} ${mediaSeedText}`,
    });
  const autonomousMediaSlides = this.buildAutonomousMediaSlides({
    commandId: command.id,
    postKind,
    caption: captionForWrite,
    mediaPrompt: mediaSeedText,
    theme: autonomousMediaTheme,
  });
  const explicitMultiMediaRequested = this.isExplicitMultiMediaRequest(payload);
  const shouldAttemptMediaSlides =
    explicitMultiMediaRequested && autonomousMediaSlides.length >= 2;
  if (!shouldAttemptMediaSlides && autonomousMediaSlides.length >= 2) {
    await this.ctx.memory
      .recordWrite({
        type: "media_post_slides_suppressed",
        at: nowIso(),
        commandId: command.id,
        sourceDirectiveId,
        reason: explicitMultiMediaRequested
          ? "insufficient_slide_candidates"
          : "single_prompt_policy",
      })
      .catch(() => undefined);
  }
  if (shouldAttemptMediaSlides) {
    const slideItems: Array<Record<string, unknown>> = [];
    const slidePrompts = autonomousMediaSlides.slice(0, 4);
    for (let index = 0; index < slidePrompts.length; index += 1) {
      const slide = slidePrompts[index];
      if (!slide) continue;
      const slidePrompt = stripEmDashCharacters(slide.imagePrompt).trim();
      if (slidePrompt.length < 8) continue;
      try {
        const slideMedia = await this.resolveMediaUpload({
          payload: {
            ...mediaGenerationPayloadBase,
            generatedAssetType: "image",
          },
          keepOriginal: true,
          promptFallbacks: [
            slidePrompt,
            mediaPromptForWrite,
            asNonEmptyString(payload.prompt),
          ],
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
          ...(slide.caption
            ? { caption: slide.caption }
            : captionForWrite
              ? { caption: captionForWrite }
              : {}),
          ...(captionPositionForWrite
            ? { captionPosition: captionPositionForWrite }
            : {}),
        });
      } catch (error: unknown) {
        await this.ctx.memory
          .recordWrite({
            type: "media_post_slide_generation_failed",
            at: nowIso(),
            commandId: command.id,
            slideIndex: index,
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
      }
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
        this.notePublishedPostForNoveltyHistory({
          postType: "media",
          caption: captionForWrite,
          textBody: null,
          mediaPrompt: slidePrompts.map((entry) => entry.imagePrompt).join(" | "),
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
            bodyPreview: truncateText(mediaCandidate, 260),
            visualRenderMode: "media_slides",
            slideCount: slideItems.length,
            captionPosition: captionPositionForWrite,
            textStyleTheme: autonomousMediaTheme,
          })
          .catch(() => undefined);
        return this.successOutcome(command, slideResult);
      }
    }
    await this.ctx.memory
      .recordWrite({
        type: "media_post_slides_fallback",
        at: nowIso(),
        commandId: command.id,
        slideCountRequested: slidePrompts.length,
        slideCountResolved: slideItems.length,
      })
      .catch(() => undefined);
  }
  const payloadForMedia: Record<string, unknown> = {
    ...mediaGenerationPayloadBase,
    ...(captionForWrite ? { caption: captionForWrite } : {}),
    ...(mediaPromptForWrite
      ? {
          mediaPrompt: mediaPromptForWrite,
          imagePrompt: mediaPromptForWrite,
          prompt: mediaPromptForWrite,
        }
      : {}),
  };
  const media = await this.resolveMediaUpload({
    payload: payloadForMedia,
    keepOriginal: true,
    promptFallbacks: [
      mediaPromptForWrite,
      asNonEmptyString(payload.prompt),
    ],
    command,
    skipPromptCuration: true,
  });
  const mediaMutation = await this.executeCreatePostMutationWithIdempotency({
    command,
    postType: "media",
    postKind,
    mutationInput: {
      ...buildBase(captionForWrite),
      mediaUrl: media.mediaUrl,
      ...(media.mediaOriginalUrl ? { mediaOriginalUrl: media.mediaOriginalUrl } : {}),
      ...(media.mediaOptimizedUrl ? { mediaOptimizedUrl: media.mediaOptimizedUrl } : {}),
      ...(media.mediaContentHash ? { mediaContentHash: media.mediaContentHash } : {}),
      ...(media.mediaIpfsCid ? { mediaIpfsCid: media.mediaIpfsCid } : {}),
      ...(typeof media.mediaSizeBytes === "number" ? { mediaSizeBytes: media.mediaSizeBytes } : {}),
      ...(media.mediaType ? { mediaType: media.mediaType } : {}),
      ...(captionPositionForWrite ? { captionPosition: captionPositionForWrite } : {}),
    },
  });
  if (mediaMutation.skipped) {
    return skippedPostOutcome(mediaMutation.reason);
  }
  const result = mediaMutation.result;
  this.notePublishedPostForNoveltyHistory({
    postType: "media",
    caption: captionForWrite,
    textBody: null,
    mediaPrompt: mediaPromptForWrite,
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
      postType,
      varietyMode: postVariety.mode,
      targetPostId: postDraftContext.targetPostId,
      bodyPreview: truncateText(mediaCandidate, 260),
      mediaUrl: media.mediaUrl,
    })
    .catch(() => undefined);
  return this.successOutcome(command, result);
}
