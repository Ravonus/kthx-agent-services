/**
 * Standalone write.createStory executor extracted from CommandExecutor.
 */

import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";

import {
  asNonEmptyString,
  asPositiveInt,
  normalizeAgentProvenanceValue,
} from "../helpers.js";
import type {
  Command,
  CommandOutcome,
  PersonaReferencePlan,
  ResolvedMediaUpload,
  TextStyleTheme,
} from "../types.js";

export type ExecuteWriteCreateStoryRuntime = {
  ctx: {
    memory: {
      recordWrite(entry: unknown): Promise<void>;
    };
  };
  agent: () => {
    createStory: { mutate(input: Record<string, unknown>): Promise<unknown> };
  };
  failedOutcome: (
    command: Command,
    message: string,
    code?: string,
  ) => CommandOutcome;
  successOutcome: (command: Command, data: unknown) => CommandOutcome;
  resolveCommandSourceDirectiveId: (input: {
    command: Command;
    payload?: Record<string, unknown> | null;
  }) => string | null;
  isChatOriginCommand: (
    command: Command,
    payloadOverride?: Record<string, unknown> | null,
  ) => boolean;
  didChatMessageExplicitlyRequestStory: (
    payload: Record<string, unknown>,
  ) => boolean;
  buildChatLiteralFallbackPayloadFromStory: (input: {
    payload: Record<string, unknown>;
  }) => Record<string, unknown>;
  executeChatLiteralGenerate: (
    command: Command,
    payload: Record<string, unknown>,
  ) => Promise<CommandOutcome>;
  resolveAutonomousTextTheme: (input: {
    commandId: string;
    postKind: "post" | "thread";
    caption: string | null;
    textBody: string;
  }) => TextStyleTheme;
  buildAutonomousVisualPrompt: (input: {
    basePrompt: string;
    caption: string | null;
    commandId: string;
    theme: TextStyleTheme;
    mode: "slide" | "story" | "background";
    index: number;
  }) => string;
  normalizeCaptionPositionValue: (value: unknown) => string | null;
  resolveAutonomousCaptionPosition: (input: {
    commandId: string;
    postKind: "post" | "thread";
    seedText: string;
  }) => string;
  resolvePersonaReferencePlan: (
    payload: Record<string, unknown>,
    mainPersonaSlugRaw?: string | null,
    command?: Command | null,
  ) => PersonaReferencePlan;
  shouldUsePersonaFrameReferences: (plan: PersonaReferencePlan) => boolean;
  resolveMediaUpload: (input: {
    payload: Record<string, unknown>;
    keepOriginal?: boolean;
    promptFallbacks: Array<string | null>;
    command?: Command;
    skipPromptCuration?: boolean;
  }) => Promise<ResolvedMediaUpload>;
};

export async function executeWriteCreateStory(
  this: ExecuteWriteCreateStoryRuntime,
  command: Command,
): Promise<CommandOutcome> {
  const payload = isRecord(command.payload) ? command.payload : null;
  if (!payload) {
    return this.failedOutcome(command, "Invalid payload for write.createStory.");
  }
  const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
    command,
    payload,
  });
  if (this.isChatOriginCommand(command, payload)) {
    const explicitStoryRequest = this.didChatMessageExplicitlyRequestStory(payload);
    if (!explicitStoryRequest) {
      await this.ctx.memory
        .recordWrite({
          type: "story_write_redirected_chat_request",
          at: nowIso(),
          commandId: command.id,
          commandKind: command.kind,
          sourceDirectiveId,
        })
        .catch(() => undefined);
      const fallbackPayload = this.buildChatLiteralFallbackPayloadFromStory({
        payload,
      });
      return this.executeChatLiteralGenerate(command, fallbackPayload);
    }
    await this.ctx.memory
      .recordWrite({
        type: "story_write_blocked_chat_request",
        at: nowIso(),
        commandId: command.id,
        commandKind: command.kind,
        sourceDirectiveId,
      })
      .catch(() => undefined);
    return this.failedOutcome(
      command,
      "Story creation is directive-only. Chat requests can create posts, but not stories.",
      "story_chat_disabled",
    );
  }
  const provenance = normalizeAgentProvenanceValue(payload.provenance);
  const sourceDirectiveActionNonce =
    asNonEmptyString(payload.sourceDirectiveActionNonce) ??
    command.actionNonce ??
    null;
  const explicitSaveAsProfileMemory =
    typeof payload.saveAsProfileMemory === "boolean"
      ? payload.saveAsProfileMemory
      : null;
  const caption = asNonEmptyString(payload.caption);
  const baseStoryPrompt =
    asNonEmptyString(payload.mediaPrompt) ??
    asNonEmptyString(payload.imagePrompt) ??
    asNonEmptyString(payload.prompt) ??
    asNonEmptyString(payload.topic) ??
    caption ??
    "a candid original day-in-the-life moment";
  const autonomousTheme = this.resolveAutonomousTextTheme({
    commandId: command.id,
    postKind: "post",
    caption,
    textBody: baseStoryPrompt,
  });
  const autonomousStoryPrompt = this.buildAutonomousVisualPrompt({
    basePrompt: baseStoryPrompt,
    caption,
    commandId: command.id,
    theme: autonomousTheme,
    mode: "story",
    index: 0,
  });
  const captionPositionForWrite =
    this.normalizeCaptionPositionValue(payload.captionPosition) ??
    this.resolveAutonomousCaptionPosition({
      commandId: command.id,
      postKind: "post",
      seedText: `${caption ?? ""} ${baseStoryPrompt ?? ""}`,
    });
  const storyPayload: Record<string, unknown> = {
    ...payload,
  };
  const personaReferencePlan = this.resolvePersonaReferencePlan(
    payload,
    null,
    command,
  );
  const personaDrivenStoryGeneration =
    this.shouldUsePersonaFrameReferences(personaReferencePlan);
  const saveAsProfileMemory =
    explicitSaveAsProfileMemory ?? personaDrivenStoryGeneration;
  const carriedMediaPresent =
    asNonEmptyString(payload.mediaUrl) !== null ||
    (Array.isArray(payload.mediaItems) && payload.mediaItems.length > 0) ||
    isRecord(payload.recentGeneratedAsset);
  delete storyPayload.mediaUrl;
  delete storyPayload.mediaOriginalUrl;
  delete storyPayload.mediaOptimizedUrl;
  delete storyPayload.mediaContentHash;
  delete storyPayload.mediaIpfsCid;
  delete storyPayload.mediaSizeBytes;
  delete storyPayload.mediaType;
  delete storyPayload.mediaItems;
  delete storyPayload.recentGeneratedAsset;
  if (carriedMediaPresent) {
    await this.ctx.memory
      .recordWrite({
        type: "story_media_carryover_stripped",
        at: nowIso(),
        commandId: command.id,
        commandKind: command.kind,
        sourceDirectiveId,
      })
      .catch(() => undefined);
  }

  const media = await this.resolveMediaUpload({
    payload: storyPayload,
    keepOriginal: false,
    promptFallbacks: [
      autonomousStoryPrompt,
      asNonEmptyString(payload.mediaPrompt),
      asNonEmptyString(payload.imagePrompt),
      asNonEmptyString(payload.prompt),
    ],
    command,
  });

  const result = await this.agent().createStory.mutate({
    mediaUrl: media.mediaUrl,
    ...(media.mediaOriginalUrl ? { originalUrl: media.mediaOriginalUrl } : {}),
    ...(media.mediaOptimizedUrl ? { optimizedUrl: media.mediaOptimizedUrl } : {}),
    ...(media.mediaContentHash ? { contentHash: media.mediaContentHash } : {}),
    ...(media.mediaIpfsCid ? { ipfsCid: media.mediaIpfsCid } : {}),
    ...(media.mediaType ? { mediaType: media.mediaType } : {}),
    ...(caption ? { caption } : {}),
    ...(saveAsProfileMemory ? { saveAsProfileMemory: true } : {}),
    ...(captionPositionForWrite ? { captionPosition: captionPositionForWrite } : {}),
    ...(asNonEmptyString(payload.mediaFit) ? { mediaFit: asNonEmptyString(payload.mediaFit) } : {}),
    ...(asPositiveInt(payload.expiresInSeconds)
      ? { expiresInSeconds: asPositiveInt(payload.expiresInSeconds) }
      : {}),
    ...(provenance ? { provenance } : {}),
    ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
    ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
    ...(command.grantId ? { grantId: command.grantId } : {}),
  });
  return this.successOutcome(command, result);
}
