import type { Command, CommandOutcome } from "../types.js";
import { asNonEmptyString, normalizeProfileCropSpec, buildProfileCropSpec } from "../helpers.js";
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";
import {
  buildStreamPreviewMetadata,
  buildStreamPreviewDeltaMetadata,
  MAX_FINALIZE_STREAM_FRAMES,
} from "./chat-literal-preview-state.js";
import type { ChatLiteralPreviewStateHandle } from "./chat-literal-preview-state.js";
import type { ChatLiteralGenerateDeps } from "./chat-literal-generate-types.js";

export async function applyProfileUpdateResult(input: {
  kind: "avatar" | "banner";
  target: string;
  media: Record<string, unknown>;
  profileCropSpec: ReturnType<typeof normalizeProfileCropSpec>;
  chatDeliveryUrl: string;
  mimeType: string;
  sizeBytes: number;
  summary: string;
  previewClientMessageId: string;
  provenance: string | null;
  sourceDirectiveId: string | null;
  sourceDirectiveActionNonce: string | null;
  previewState: ChatLiteralPreviewStateHandle;
  deps: Pick<ChatLiteralGenerateDeps, "updateAvatar" | "updateBanner" | "memory" | "successOutcome">;
  command: Command;
  chatTarget: { conversationId?: string; channelId?: string };
}): Promise<CommandOutcome> {
  const {
    kind, target, media, profileCropSpec, chatDeliveryUrl,
    mimeType, sizeBytes, summary, previewClientMessageId,
    provenance, sourceDirectiveId, sourceDirectiveActionNonce,
    previewState, deps, command, chatTarget,
  } = input;

  const cropSpec =
    profileCropSpec?.target === kind
      ? profileCropSpec
      : normalizeProfileCropSpec(buildProfileCropSpec(kind));

  const mutationInput = {
    target,
    ...(kind === "avatar"
      ? { imageUrl: media.mediaUrl as string }
      : { bannerUrl: media.mediaUrl as string }),
    ...(media.mediaOriginalUrl ? { originalUrl: media.mediaOriginalUrl } : {}),
    ...(media.mediaOptimizedUrl ? { optimizedUrl: media.mediaOptimizedUrl } : {}),
    ...(media.mediaContentHash ? { contentHash: media.mediaContentHash } : {}),
    ...(media.mediaIpfsCid ? { ipfsCid: media.mediaIpfsCid } : {}),
    ...(typeof media.mediaSizeBytes === "number"
      ? { sizeBytes: media.mediaSizeBytes }
      : {}),
    ...(provenance ? { provenance } : {}),
    ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
    ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
  };

  const updateResult =
    kind === "avatar"
      ? await deps.updateAvatar(mutationInput as Record<string, unknown> & { target: string; imageUrl: string })
      : await deps.updateBanner(mutationInput as Record<string, unknown> & { target: string; bannerUrl: string });

  const resultData = isRecord(updateResult) ? updateResult : null;
  const user = isRecord(resultData?.user) ? resultData.user : null;
  const handle = asNonEmptyString(user?.handle);
  const userId = asNonEmptyString(user?.id);
  const profileHref =
    target === "owner" && handle
      ? `/u/${handle.replace(/^@+/u, "")}?edit=${kind}&crop=1`
      : null;

  const streamPreviewForSuccess = buildStreamPreviewMetadata({
    frames: previewState.snapshotStreamFrames(),
    maxFrames: MAX_FINALIZE_STREAM_FRAMES,
    finalPreviewUrl: chatDeliveryUrl,
  });
  const streamPreviewDeltaForSuccess = buildStreamPreviewDeltaMetadata({
    frames: previewState.snapshotStreamFrames(),
    deltaBaseCount: previewState.previewStreamFrameCursor,
    maxDeltaFrames: MAX_FINALIZE_STREAM_FRAMES,
    finalPreviewUrl: chatDeliveryUrl,
  });

  const isOwner = target === "owner";
  const kindLabel = kind === "avatar" ? "avatar" : "banner";
  const completionText =
    kind === "avatar"
      ? isOwner
        ? "Done. Here is your new avatar. If framing looks off, tap Crop avatar and keep your face in the center safe zone."
        : "Done. Here is my new avatar. If framing looks off, tap Crop avatar and keep the face in the center safe zone."
      : isOwner
        ? "Done. Here is your new banner. If framing looks off, tap Crop banner and keep key details in the center safe zone."
        : "Done. Here is my new banner. If framing looks off, keep key details in the center safe zone.";

  const previewType = kind === "avatar" ? "persona" : "banner";
  const chatDeliveryHandled = await previewState.sendOrEditPreviewMessage({
    kind: "success",
    body: completionText,
    attachments: [
      {
        url: chatDeliveryUrl,
        mimeType,
        sizeBytes,
        metadata: {
          source: `runtime.${kindLabel}`,
          generatedAssetType: previewType,
          ...(kind === "avatar" ? { personaType: "persona" } : {}),
          cropZones: cropSpec,
        },
      },
    ],
    metadata: {
      automated: true,
      sourceContext: "CHAT",
      actionPreview: {
        type: previewType,
        status: "success",
        title:
          kind === "avatar"
            ? "Persona avatar updated"
            : "Profile banner updated",
        summary,
        streamSessionId: previewClientMessageId,
        previewUrl: chatDeliveryUrl,
        href: chatDeliveryUrl,
        hrefLabel: `Open ${kindLabel} image`,
        ...(streamPreviewForSuccess ?? {}),
        ...(streamPreviewDeltaForSuccess?.metadata ?? {}),
        cropHint: cropSpec.guidance,
        cropZones: cropSpec,
        ...(profileHref
          ? {
              secondaryHref: profileHref,
              secondaryHrefLabel: `Crop ${kindLabel}`,
            }
          : {}),
        [`${kindLabel}Target`]: target,
        ...(handle ? { handle } : {}),
        ...(userId ? { userId } : {}),
      },
    },
  });

  if (!chatDeliveryHandled) {
    const editError = previewState.previewLastEditError ?? "preview_delivery_unresolved";
    throw new Error(
      `chat_preview_finalize_failed:chat_${kindLabel}_update:${editError}`,
    );
  }

  await deps.memory.recordWrite({
    type: `chat_${kindLabel}_updated`,
    at: nowIso(),
    commandId: command.id,
    [`${kindLabel}Target`]: target,
    mediaUrl: media.mediaUrl,
    prompt: summary,
    ...(kind === "avatar" ? { personaType: "persona" } : {}),
    cropZones: cropSpec,
    userId,
    handle,
    targetConversationId: chatTarget.conversationId ?? null,
    targetChannelId: chatTarget.channelId ?? null,
  });

  return deps.successOutcome(command, {
    mode: `chat_${kindLabel}_update`,
    [`${kindLabel}Target`]: target,
    mediaUrl: media.mediaUrl,
    prompt: summary,
    updateResult,
    chatDeliveryHandled,
  });
}
