/**
 * Execute a chat-initiated literal media generation request.
 *
 * Handles avatar updates, banner updates, and generic image/GIF generation
 * with real-time stream preview updates delivered back to the chat.
 */

import type {
  Command,
  CommandOutcome,
  CommandLifecycleCheckpointStage,
  GeneratedAssetType,
  GeneratedCustomAssetSaveResult,
  MediaGenerationProgress,
} from "../types.js";
import { RequeueCommandError } from "../types.js";
import {
  asNonEmptyString,
  truncateText,
  normalizeAgentProvenanceValue,
  normalizeProfileCropSpec,
  buildProfileCropSpec,
  buildProfileCropPromptHint,
} from "../helpers.js";
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";
import { resolveChatTargetFromPayload } from "../../chat/chat-context.js";
import {
  REQUIRED_PERSONA_REFERENCE_FRAME_COUNT,
  IMAGE_GENERATION_SETUP_HINT,
} from "../constants.js";
import {
  createChatLiteralPreviewState,
  buildStreamPreviewMetadata,
  buildStreamPreviewDeltaMetadata,
  MAX_FINALIZE_STREAM_FRAMES,
} from "./chat-literal-preview-state.js";
import type { ChatLiteralGenerateDeps } from "./chat-literal-generate-types.js";
import { applyProfileUpdateResult } from "./chat-literal-profile-update.js";

// ---------------------------------------------------------------------------
// executeChatLiteralGenerate
// ---------------------------------------------------------------------------

export async function executeChatLiteralGenerate(
  deps: ChatLiteralGenerateDeps,
  command: Command,
  payload: Record<string, unknown>,
): Promise<CommandOutcome> {
  // -- S1: Input validation & payload parsing --------------------------------

  const chatTarget = resolveChatTargetFromPayload(payload);
  if (!chatTarget) {
    return deps.failedOutcome(
      command,
      "Missing chat context for literal generate request.",
      "chat_context_missing",
    );
  }
  if (!deps.callAgentChatBridge) {
    return deps.failedOutcome(
      command,
      "Chat bridge unavailable for literal generate request.",
      "chat_bridge_unavailable",
    );
  }

  const requestedAction =
    asNonEmptyString(payload.requestedAction)?.toLowerCase() ?? "";
  const avatarRequest =
    payload.avatarRequest === true || requestedAction === "avatar";
  const bannerRequest =
    !avatarRequest &&
    (payload.bannerRequest === true || requestedAction === "banner");
  const avatarTargetRaw =
    asNonEmptyString(payload.avatarTarget)?.toLowerCase();
  const avatarTarget = avatarTargetRaw === "owner" ? "owner" : "agent";
  const bannerTargetRaw =
    asNonEmptyString(payload.bannerTarget)?.toLowerCase();
  const bannerTarget = bannerTargetRaw === "owner" ? "owner" : "agent";
  const defaultAvatarPrompt =
    avatarTarget === "owner"
      ? "Create a profile avatar for my account on this social app."
      : "Create a profile avatar for your account on this social app.";
  const defaultBannerPrompt =
    bannerTarget === "owner"
      ? "Create a profile banner for my account on this social app."
      : "Create a profile banner for your account on this social app.";
  const basePrompt =
    asNonEmptyString(payload.mediaPrompt) ??
    asNonEmptyString(payload.imagePrompt) ??
    asNonEmptyString(payload.prompt) ??
    asNonEmptyString(payload.topic) ??
    asNonEmptyString(payload.requestText) ??
    (avatarRequest
      ? defaultAvatarPrompt
      : bannerRequest
        ? defaultBannerPrompt
        : null);
  if (!basePrompt) {
    return deps.failedOutcome(
      command,
      "No prompt provided for literal generate request.",
      "missing_prompt",
    );
  }
  const recentGeneratedAsset = isRecord(payload.recentGeneratedAsset)
    ? payload.recentGeneratedAsset
    : null;
  const recentGeneratedAssetType =
    asNonEmptyString(recentGeneratedAsset?.type)?.toLowerCase() ?? "";
  const recentGeneratedAssetSummary = asNonEmptyString(
    recentGeneratedAsset?.summary,
  );
  const recentGeneratedAssetHref = asNonEmptyString(
    recentGeneratedAsset?.href,
  );
  const shouldReusePersonaReference =
    avatarRequest &&
    avatarTarget === "agent" &&
    (recentGeneratedAssetType === "persona" ||
      recentGeneratedAssetType === "avatar");
  const profileCropSpec = avatarRequest
    ? normalizeProfileCropSpec(buildProfileCropSpec("avatar"))
    : bannerRequest
      ? normalizeProfileCropSpec(buildProfileCropSpec("banner"))
      : null;
  const promptBase = shouldReusePersonaReference
    ? [
        basePrompt,
        "Maintain visual persona continuity with the previous avatar.",
        recentGeneratedAssetSummary
          ? `Previous persona summary: ${recentGeneratedAssetSummary}`
          : null,
        recentGeneratedAssetHref
          ? `Previous persona reference URL: ${recentGeneratedAssetHref}`
          : null,
      ]
        .filter((entry): entry is string => Boolean(entry))
        .join("\n")
    : basePrompt;
  const prompt = profileCropSpec
    ? [promptBase, buildProfileCropPromptHint(profileCropSpec)]
        .filter((entry) => entry.trim().length > 0)
        .join("\n\n")
    : promptBase;
  const provenance = normalizeAgentProvenanceValue(payload.provenance);
  const sourceDirectiveId = deps.resolveCommandSourceDirectiveId({
    command,
    payload,
  });
  const sourceDirectiveActionNonce =
    deps.resolveCommandSourceDirectiveActionNonce({ command, payload });

  // -- S2: Persona reference resolution & asset intent ----------------------

  const generatedAssetType = deps.resolveGeneratedAssetType(
    payload.generatedAssetType,
  );
  const fallbackReferenceInputs =
    deps.collectMediaReferenceInputs(payload);
  const personaReferences = await deps.resolvePersonaFrameReferences({
    payload,
    command,
    fallbackReferenceInputs,
  });
  const referenceInputs =
    personaReferences.personaSlug !== null
      ? [...personaReferences.frameReferences]
      : [...fallbackReferenceInputs];
  const personaSetupRequiredSlug =
    personaReferences.personaSlug !== null &&
    referenceInputs.length < REQUIRED_PERSONA_REFERENCE_FRAME_COUNT
      ? personaReferences.personaSlug
      : null;
  if (
    personaReferences.personaSlug === null &&
    shouldReusePersonaReference &&
    recentGeneratedAssetHref &&
    !referenceInputs.includes(recentGeneratedAssetHref)
  ) {
    referenceInputs.unshift(recentGeneratedAssetHref);
  }
  const generatedLabel = bannerRequest
    ? "banner"
    : generatedAssetType === "gif"
      ? "GIF"
      : "image";
  const generatedCustomAssetSaveIntent =
    !avatarRequest && !bannerRequest
      ? deps.resolveGeneratedCustomAssetSaveIntent(payload, basePrompt)
      : null;
  const summary = truncateText(basePrompt, 220);
  const chatRoute = chatTarget.conversationId
    ? { conversationId: chatTarget.conversationId }
    : { channelId: chatTarget.channelId };
  const previewType = avatarRequest
    ? "persona"
    : bannerRequest
      ? "banner"
      : generatedAssetType;
  const processingTitle = avatarRequest
    ? "Generating avatar"
    : bannerRequest
      ? "Generating banner"
      : `${generatedLabel.charAt(0).toUpperCase()}${generatedLabel.slice(1)} in progress`;
  const processingBody = avatarRequest
    ? "Working on your avatar now..."
    : bannerRequest
      ? "Working on your banner now..."
      : `Generating ${generatedLabel} for "${summary}".`;

  // -- S3: Create preview state (closures now in preview-state module) ------

  const existingProcessingClientMessageId =
    deps.resolveChatProcessingClientMessageId(command);
  const previewClientMessageId =
    existingProcessingClientMessageId ?? `runtime_generate_${command.id}`;

  const previewState = createChatLiteralPreviewState(
    {
      callAgentChatBridge: deps.callAgentChatBridge,
      memoryRecordWrite: (entry) => deps.memory.recordWrite(entry),
      isStreamPartArtifactReference: deps.isStreamPartArtifactReference,
    },
    {
      previewClientMessageId,
      chatRoute,
      previewType,
      processingTitle,
      summary,
      processingBody,
      commandId: command.id,
    },
    {
      previewMessageCreateAttempted: Boolean(
        existingProcessingClientMessageId,
      ),
    },
  );

  // -- S4-S8: Generation, success flows, error handling ---------------------

  try {
    await previewState.sendOrEditPreviewMessage({
      kind: "processing",
      body: processingBody,
      metadata: {
        automated: true,
        sourceContext: "CHAT",
        actionPreview: previewState.buildProcessingActionPreview(),
      },
    });
    if (personaSetupRequiredSlug) {
      throw new Error(
        `persona_reference_setup_required:${personaSetupRequiredSlug}`,
      );
    }
    const media = await deps.generateAndUploadMediaFromPrompt(prompt, {
      generatedAssetType:
        avatarRequest || bannerRequest ? "image" : generatedAssetType,
      mode: avatarRequest
        ? "chat_avatar_update"
        : bannerRequest
          ? "chat_banner_update"
          : "chat_literal_generate",
      referenceInputs,
      commandId: command.id,
      onProgress: (progress: MediaGenerationProgress) =>
        previewState.emitStreamProgress(progress),
    });
    const mediaUrl = media.mediaUrl as string;
    const mediaType = media.mediaType as "image" | "video" | undefined;
    const mimeType = deps.resolveGeneratedAttachmentMimeType({
      generatedAssetType: generatedAssetType as GeneratedAssetType,
      mediaUrl,
      ...(mediaType ? { mediaType } : {}),
    });
    const sizeBytes =
      typeof media.mediaSizeBytes === "number" &&
      Number.isFinite(media.mediaSizeBytes) &&
      (media.mediaSizeBytes as number) > 0
        ? Math.max(1, Math.floor(media.mediaSizeBytes as number))
        : 1;
    const mode = avatarRequest
      ? "chat_avatar_update"
      : bannerRequest
        ? "chat_banner_update"
        : "chat_literal_generate";
    await deps.recordCommandLifecycleCheckpoint({
      command,
      stage: "generated",
      status: "ok",
      metadata: { generatedAssetType, mode },
    });
    await deps.recordCommandLifecycleCheckpoint({
      command,
      stage: "uploaded",
      status: "ok",
      metadata: {
        generatedAssetType,
        mediaUrl: media.mediaUrl,
        mimeType,
        mode,
      },
    });
    const chatDeliveryUrl = previewState.resolveChatDeliveryUrl(
      media.mediaUrl as string | null,
      media.mediaOriginalUrl as string | null,
      media.mediaOptimizedUrl as string | null,
    );
    if (!chatDeliveryUrl) {
      throw new Error("chat_delivery_media_url_invalid");
    }

    // -- Avatar / Banner success flow (merged) ----------------------------

    if (avatarRequest || bannerRequest) {
      return applyProfileUpdateResult({
        kind: avatarRequest ? "avatar" : "banner",
        target: avatarRequest ? avatarTarget : bannerTarget,
        media,
        profileCropSpec: profileCropSpec!,
        chatDeliveryUrl,
        mimeType,
        sizeBytes,
        summary,
        previewClientMessageId,
        provenance,
        sourceDirectiveId,
        sourceDirectiveActionNonce,
        previewState,
        deps,
        command,
        chatTarget,
      });
    }

    // -- Generic generate success flow ------------------------------------

    let generatedCustomAssetSaveResult: GeneratedCustomAssetSaveResult | null =
      null;
    let generatedCustomAssetSaveError: string | null = null;
    if (generatedCustomAssetSaveIntent) {
      try {
        generatedCustomAssetSaveResult = await deps.saveGeneratedCustomAsset({
          command,
          payload,
          intent: generatedCustomAssetSaveIntent,
          sourcePrompt: basePrompt,
          mediaUrl,
          mimeType,
          chatTarget,
        });
      } catch (error: unknown) {
        generatedCustomAssetSaveError =
          error instanceof Error ? error.message : String(error);
      }
    }
    const customAssetScopeLabel =
      generatedCustomAssetSaveResult?.scope === "group"
        ? "this group"
        : generatedCustomAssetSaveResult?.scope === "server"
          ? "this server"
          : "your library";
    const successBody = generatedCustomAssetSaveResult
      ? `Generated ${generatedLabel} for "${summary}". Saved as ${generatedCustomAssetSaveResult.kind} \`${generatedCustomAssetSaveResult.name}\` in ${customAssetScopeLabel}.`
      : generatedCustomAssetSaveError && generatedCustomAssetSaveIntent
        ? `Generated ${generatedLabel} for "${summary}". Could not save to ${generatedCustomAssetSaveIntent.scope} ${generatedCustomAssetSaveIntent.kind}s (${truncateText(generatedCustomAssetSaveError, 120)}).`
        : `Generated ${generatedLabel} for "${summary}".`;
    const finalChatDeliveryUrl = previewState.resolveChatDeliveryUrl(
      generatedCustomAssetSaveResult?.url ?? null,
      chatDeliveryUrl,
      media.mediaUrl as string | null,
      media.mediaOriginalUrl as string | null,
      media.mediaOptimizedUrl as string | null,
    );
    if (!finalChatDeliveryUrl) {
      throw new Error("chat_delivery_media_url_invalid");
    }
    const finalMimeType =
      generatedCustomAssetSaveResult?.mimeType ?? mimeType;
    const streamPreviewForSuccess = buildStreamPreviewMetadata({
      frames: previewState.snapshotStreamFrames(),
      maxFrames: MAX_FINALIZE_STREAM_FRAMES,
      finalPreviewUrl: finalChatDeliveryUrl,
    });
    const streamPreviewDeltaForSuccess = buildStreamPreviewDeltaMetadata({
      frames: previewState.snapshotStreamFrames(),
      deltaBaseCount: previewState.previewStreamFrameCursor,
      maxDeltaFrames: MAX_FINALIZE_STREAM_FRAMES,
      finalPreviewUrl: finalChatDeliveryUrl,
    });
    const chatDeliveryHandled = await previewState.sendOrEditPreviewMessage({
      kind: "success",
      body: successBody,
      attachments: [
        {
          url: finalChatDeliveryUrl,
          mimeType: finalMimeType,
          sizeBytes,
          metadata: {
            source: "runtime.generate",
            generatedAssetType,
          },
        },
      ],
      metadata: {
        automated: true,
        sourceContext: "CHAT",
        actionPreview: {
          type: generatedAssetType,
          status: "success",
          title: `${generatedLabel.charAt(0).toUpperCase()}${generatedLabel.slice(1)} generated`,
          summary,
          streamSessionId: previewClientMessageId,
          previewUrl: finalChatDeliveryUrl,
          href: finalChatDeliveryUrl,
          hrefLabel: `Open ${generatedLabel}`,
          ...(generatedCustomAssetSaveResult
            ? {
                customAsset: {
                  kind: generatedCustomAssetSaveResult.kind,
                  scope: generatedCustomAssetSaveResult.scope,
                  name: generatedCustomAssetSaveResult.name,
                  id: generatedCustomAssetSaveResult.id,
                },
              }
            : generatedCustomAssetSaveError && generatedCustomAssetSaveIntent
              ? {
                  customAssetSaveError: truncateText(
                    generatedCustomAssetSaveError,
                    180,
                  ),
                }
              : {}),
          ...(streamPreviewForSuccess ?? {}),
          ...(streamPreviewDeltaForSuccess?.metadata ?? {}),
        },
      },
    });
    if (!chatDeliveryHandled) {
      const editError =
        previewState.previewLastEditError ?? "preview_delivery_unresolved";
      throw new Error(
        `chat_preview_finalize_failed:chat_literal_generate:${editError}`,
      );
    }
    await deps.memory.recordWrite({
      type: "chat_literal_generate_sent",
      at: nowIso(),
      commandId: command.id,
      generatedAssetType,
      mediaUrl: finalChatDeliveryUrl,
      prompt: summary,
      customAssetKind: generatedCustomAssetSaveResult?.kind ?? null,
      customAssetScope: generatedCustomAssetSaveResult?.scope ?? null,
      customAssetName: generatedCustomAssetSaveResult?.name ?? null,
      customAssetId: generatedCustomAssetSaveResult?.id ?? null,
      customAssetSaveError: generatedCustomAssetSaveError,
      targetConversationId: chatTarget.conversationId ?? null,
      targetChannelId: chatTarget.channelId ?? null,
    });
    return deps.successOutcome(command, {
      generatedAssetType,
      mediaUrl: finalChatDeliveryUrl,
      prompt: summary,
      ...(generatedCustomAssetSaveResult
        ? { customAsset: generatedCustomAssetSaveResult }
        : {}),
      ...(generatedCustomAssetSaveError && generatedCustomAssetSaveIntent
        ? { customAssetSaveError: generatedCustomAssetSaveError }
        : {}),
      mode: "chat_literal_generate",
      chatDeliveryHandled,
    });
  } catch (error: unknown) {
    if (error instanceof RequeueCommandError) {
      throw error;
    }
    const message =
      error instanceof Error ? error.message : String(error);
    const isPromptCurationFailure = /prompt_curation_/iu.test(message);
    const isChatDeliveryFailure =
      /chat_preview_finalize_failed:/iu.test(message);
    const deferred = deps.classifyMediaGenerationDeferral({
      error,
      hasPrompt: true,
    });
    const isImageGenerationSetupFailure =
      deferred.imageGeneratorSetupRequired;
    const imageGenerationSetupHint = isImageGenerationSetupFailure
      ? IMAGE_GENERATION_SETUP_HINT
      : "";
    const isPersonaReferenceSetupFailure =
      deferred.reasonCode === "persona_reference_setup_required";
    const personaReferenceSetupSlug = deferred.personaSlug;
    const failureStreamFrames = previewState.snapshotStreamFrames();
    const streamPreviewForFailure =
      failureStreamFrames.length > 0
        ? buildStreamPreviewDeltaMetadata({
            frames: failureStreamFrames,
            deltaBaseCount: previewState.previewStreamFrameCursor,
            maxDeltaFrames: MAX_FINALIZE_STREAM_FRAMES,
          })
        : null;
    const failureStage: CommandLifecycleCheckpointStage =
      isChatDeliveryFailure ? "chat_delivery" : "generated";
    if (deferred.shouldRequeue && deferred.reason) {
      const deferredBody = avatarRequest
        ? "Avatar prerequisites are still in progress. I queued this request and will retry automatically."
        : bannerRequest
          ? "Banner prerequisites are still in progress. I queued this request and will retry automatically."
          : isPersonaReferenceSetupFailure
            ? `Persona setup for ${personaReferenceSetupSlug ? `\`${personaReferenceSetupSlug}\`` : "that persona"} is incomplete (need selfie, midshot, fullbody). I queued this request and will retry automatically.`
            : isImageGenerationSetupFailure
              ? `Image generation setup is still unavailable. I queued this request and will retry automatically once setup is ready.${imageGenerationSetupHint}`
              : "I did not receive a final media asset yet. I queued this request and will retry automatically.";
      const previewDeferredDelivered =
        await previewState
          .sendOrEditPreviewMessage({
            kind: "processing",
            body: deferredBody,
            metadata: {
              automated: true,
              sourceContext: "CHAT",
              actionPreview: {
                type: avatarRequest
                  ? "persona"
                  : bannerRequest
                    ? "banner"
                    : generatedAssetType,
                status: "processing",
                streamSessionId: previewClientMessageId,
                title: avatarRequest
                  ? "Avatar update queued"
                  : bannerRequest
                    ? "Banner update queued"
                    : `${generatedLabel.charAt(0).toUpperCase()}${generatedLabel.slice(1)} queued`,
                summary,
                deferred: true,
                deferredReason: deferred.reason,
                personaSetupRequired: isPersonaReferenceSetupFailure,
                imageGenerationSetupRequired:
                  isImageGenerationSetupFailure,
                ...(streamPreviewForFailure?.metadata ?? {}),
              },
            },
          })
          .catch(() => false);
      await deps.recordCommandLifecycleCheckpoint({
        command,
        stage: failureStage,
        status: "failed",
        message,
        metadata: {
          generatedAssetType,
          avatarRequest,
          bannerRequest,
          requeued: true,
          requeueReason: deferred.reason,
          requeueReasonCode: deferred.reasonCode,
          requeuePersonaSlug: deferred.personaSlug,
          previewDeferredDelivered,
        },
      });
      await deps.memory.recordWrite({
        type: "chat_literal_generate_deferred",
        at: nowIso(),
        commandId: command.id,
        generatedAssetType,
        avatarRequest,
        bannerRequest,
        reason: deferred.reason,
        reasonCode: deferred.reasonCode,
        personaSlug: deferred.personaSlug,
        error: message,
      });
      throw new RequeueCommandError(deferred.reason);
    }
    const previewFailureDelivered =
      await previewState
        .sendOrEditPreviewMessage({
          kind: "failed",
          body: avatarRequest
            ? "I could not update that avatar right now. Please retry in a moment."
            : bannerRequest
              ? "I could not update that banner right now. Please retry in a moment."
              : isPersonaReferenceSetupFailure
                ? `I couldn't prepare persona references for ${personaReferenceSetupSlug ? `\`${personaReferenceSetupSlug}\`` : "that persona"} yet. I need three photorealistic baseline frames (selfie, midshot, fullbody) before generating with persona continuity.${imageGenerationSetupHint}`
                : isChatDeliveryFailure
                  ? `I generated that ${generatedLabel}, but failed to finalize delivery in chat. Please retry.`
                  : isPromptCurationFailure
                    ? `I could not prepare a generation prompt for that ${generatedLabel} right now. Please retry in a moment.`
                    : `I could not generate that ${generatedLabel} right now. Please retry in a moment.${imageGenerationSetupHint}`,
          metadata: {
            automated: true,
            sourceContext: "CHAT",
            actionPreview: {
              type: avatarRequest
                ? "persona"
                : bannerRequest
                  ? "banner"
                  : generatedAssetType,
              status: "failed",
              streamSessionId: previewClientMessageId,
              title: avatarRequest
                ? "Avatar update failed"
                : bannerRequest
                  ? "Banner update failed"
                  : isChatDeliveryFailure
                    ? "Delivery failed"
                    : isPromptCurationFailure
                      ? "Prompt curation failed"
                      : `${generatedLabel.charAt(0).toUpperCase()}${generatedLabel.slice(1)} generation failed`,
              error: truncateText(message, 240),
              imageGenerationSetupRequired:
                isImageGenerationSetupFailure,
              ...(streamPreviewForFailure?.metadata ?? {}),
            },
          },
        })
        .catch(() => false);
    await deps.recordCommandLifecycleCheckpoint({
      command,
      stage: failureStage,
      status:
        failureStage === "chat_delivery" && previewFailureDelivered
          ? "ok"
          : "failed",
      message:
        failureStage === "chat_delivery" && previewFailureDelivered
          ? null
          : message,
      metadata: {
        generatedAssetType,
        avatarRequest,
        bannerRequest,
        ...(failureStage === "chat_delivery"
          ? { recoveredWithFailureMessage: previewFailureDelivered }
          : {}),
      },
    });
    await deps.memory.recordWrite({
      type: "chat_literal_generate_failed",
      at: nowIso(),
      commandId: command.id,
      generatedAssetType,
      avatarRequest,
      bannerRequest,
      error: message,
    });
    const failed = deps.failedOutcome(
      command,
      avatarRequest
        ? `Avatar update failed: ${message}`
        : bannerRequest
          ? `Banner update failed: ${message}`
          : isPersonaReferenceSetupFailure
            ? `Persona reference setup failed: ${message}`
            : isChatDeliveryFailure
              ? `Literal generate delivery failed: ${message}`
              : `Literal generate failed: ${message}`,
      avatarRequest
        ? "avatar_update_failed"
        : bannerRequest
          ? "banner_update_failed"
          : isChatDeliveryFailure
            ? "chat_delivery_failed"
            : "literal_generate_failed",
    );
    return {
      ...failed,
      data: {
        mode: "chat_literal_generate",
        generatedAssetType,
        chatDeliveryHandled: previewFailureDelivered,
        chatDeliveryCheckpointRecorded: failureStage === "chat_delivery",
        chatPreviewDeliveryError: previewState.previewLastEditError,
      },
    };
  }
}
