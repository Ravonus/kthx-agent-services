/**
 * Standalone write.createPost executor extracted from CommandExecutor.
 */

import type {
  Command,
  CommandOutcome,
  CuratedPostDraft,
  PersonaReferencePlan,
  PostDraftContext,
  PostVarietyMode,
  ResolvedMediaUpload,
  TextPostVisualPlan,
  TextPostVisualSlide,
  TextStyleTheme,
} from "../types.js";
import {
  asNonEmptyString,
  normalizeAgentProvenanceValue,
} from "../helpers.js";
import { isRecord } from "../../lib/guards.js";
import { nowIso } from "../../lib/text.js";
import { executeWriteCreatePostMedia } from "./write-create-post-media.js";
import { executeWriteCreatePostText } from "./write-create-post-text.js";

export type ExecuteWriteCreatePostRuntime = {
  ctx: {
    memory: {
      recordWrite(entry: unknown): Promise<void>;
    };
  };
  failedOutcome: (
    command: Command,
    message: string,
    code?: string,
  ) => CommandOutcome;
  successOutcome: (command: Command, data: unknown) => CommandOutcome;
  isChatOriginCommand: (
    command: Command,
    payloadOverride?: Record<string, unknown> | null,
  ) => boolean;
  isChatWriteRequesterOwner: (payload: Record<string, unknown>) => boolean;
  resolveCommandSourceDirectiveId: (input: {
    command: Command;
    payload?: Record<string, unknown> | null;
  }) => string | null;
  extractTargetPostIdForPostDraft: (
    payload: Record<string, unknown>,
  ) => number | null;
  loadPostDraftContext: (input: {
    postId: number | null;
    payload: Record<string, unknown>;
  }) => Promise<PostDraftContext>;
  collectDirectiveSeedHints: (payload: Record<string, unknown>) => string[];
  collectDirectiveTaggedHandles: (payload: Record<string, unknown>) => string[];
  selectPostVarietyMode: (input: {
    commandId: string;
    postType: "text" | "media";
    payload: Record<string, unknown>;
    context: PostDraftContext;
    seedHints: string[];
  }) => {
    mode: PostVarietyMode;
    reason: string;
    recentModes: PostVarietyMode[];
    signal: string;
  };
  curatePostDraftWithOpenClaw: (input: {
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
  }) => Promise<CuratedPostDraft | null>;
  snapshotRecentPostNoveltyReferences: (
    postType: "text" | "media",
  ) => string[];
  validatePostDraftNovelty: (input: {
    postType: "text" | "media";
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
    context: PostDraftContext;
    seedHints: string[];
  }) =>
    | { ok: true; candidateText: string }
    | {
        ok: false;
        reason: string;
        candidateText: string;
        referencePreview: string | null;
      };
  buildPostNoveltyCandidateText: (input: {
    postType: "text" | "media";
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
  }) => string;
  buildDirectiveScopedMediaGenerationPayload: (input: {
    payload: Record<string, unknown>;
    selectedTaggedHandles: string[] | null;
    useTargetContext: boolean | null;
  }) => Record<string, unknown>;
  resolveAutonomousTextTheme: (input: {
    commandId: string;
    postKind: "post" | "thread";
    caption: string | null;
    textBody: string;
  }) => TextStyleTheme;
  resolveAutonomousCaptionPosition: (input: {
    commandId: string;
    postKind: "post" | "thread";
    seedText: string;
  }) => string;
  pickDeterministicIndex: (seed: string, modulo: number) => number;
  resolveAutonomousGradientBackground: (
    theme: TextStyleTheme,
    seed: string,
  ) => string;
  planTextPostVisualWithOpenClaw: (input: {
    commandId: string;
    postKind: "post" | "thread";
    caption: string | null;
    textBody: string;
    context: PostDraftContext;
  }) => Promise<TextPostVisualPlan | null>;
  normalizeCaptionPositionValue: (value: unknown) => string | null;
  sanitizeTextStyleValue: (value: unknown) => Record<string, unknown> | null;
  normalizeAgentTextStyle: (
    style: Record<string, unknown> | null,
    captionPosition: string | null,
    fallbackStyle?: Record<string, unknown> | null,
  ) => Record<string, unknown>;
  buildAutonomousThreadSlides: (input: {
    commandId: string;
    caption: string | null;
    textBody: string;
    theme: TextStyleTheme;
    postKind: "post" | "thread";
  }) => TextPostVisualSlide[];
  buildAutonomousTextBackgroundPrompt: (input: {
    commandId: string;
    caption: string | null;
    textBody: string;
    theme: TextStyleTheme;
    postKind: "post" | "thread";
  }) => string | null;
  resolveMediaUpload: (input: {
    payload: Record<string, unknown>;
    keepOriginal?: boolean;
    promptFallbacks: Array<string | null>;
    command?: Command;
    skipPromptCuration?: boolean;
  }) => Promise<ResolvedMediaUpload>;
  executeCreatePostMutationWithIdempotency: (input: {
    command: Command;
    postType: "text" | "media";
    postKind: "post" | "thread";
    mutationInput: Record<string, unknown>;
  }) => Promise<
    | {
        skipped: false;
        result: unknown;
      }
    | {
        skipped: true;
        reason: string;
      }
  >;
  notePublishedPostForNoveltyHistory: (input: {
    postType: "text" | "media";
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
    commandId: string;
    targetPostId: number | null;
  }) => void;
  notePublishedPostVarietyMode: (input: {
    commandId: string;
    postType: "text" | "media";
    targetPostId: number | null;
    mode: PostVarietyMode;
    signal: string;
  }) => void;
  consumeGrantedAction: (actionKeys: string[]) => string | null;
  resolvePersonaReferencePlan: (
    payload: Record<string, unknown>,
    mainPersonaSlugRaw?: string | null,
    command?: Command | null,
  ) => PersonaReferencePlan;
  shouldUsePersonaFrameReferences: (plan: PersonaReferencePlan) => boolean;
  isExplicitMultiMediaRequest: (payload: Record<string, unknown>) => boolean;
  buildAutonomousMediaSlides: (input: {
    commandId: string;
    postKind: "post" | "thread";
    caption: string | null;
    mediaPrompt: string;
    theme: TextStyleTheme;
  }) => TextPostVisualSlide[];
};

export type WriteCreatePostCommonInput = {
  command: Command;
  payload: Record<string, unknown>;
  postType: "text" | "media";
  postKind: "post" | "thread";
  sourceDirectiveId: string | null;
  sourceDirectiveActionNonce: string | null;
  explicitSaveAsProfileMemory: boolean | null;
  provenance: string | null;
  postDraftContext: PostDraftContext;
  requiresCuration: boolean;
  directiveSinglePromptMode: boolean;
  directiveSeedHints: string[];
  directiveTaggedHandles: string[];
  postVariety: {
    mode: PostVarietyMode;
    reason: string;
    recentModes: PostVarietyMode[];
    signal: string;
  };
};

export async function executeWriteCreatePost(
  this: ExecuteWriteCreatePostRuntime,
  command: Command,
): Promise<CommandOutcome> {
  const payload = isRecord(command.payload) ? command.payload : null;
  if (!payload) {
    return this.failedOutcome(command, "Invalid payload for write.createPost.");
  }

  const postTypeRaw = asNonEmptyString(payload.postType)?.toLowerCase();
  const postType = postTypeRaw === "text" ? "text" : "media";
  const kindRaw = asNonEmptyString(payload.kind)?.toLowerCase();
  const postKind = kindRaw === "thread" ? "thread" : "post";
  if (
    this.isChatOriginCommand(command, payload) &&
    !this.isChatWriteRequesterOwner(payload)
  ) {
    return this.failedOutcome(
      command,
      "Chat write actions are owner-only unless explicitly granted.",
      "chat_write_owner_only",
    );
  }

  const provenance = normalizeAgentProvenanceValue(payload.provenance);
  const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
    command,
    payload,
  });
  const sourceDirectiveActionNonce =
    asNonEmptyString(payload.sourceDirectiveActionNonce) ??
    command.actionNonce ??
    null;
  const explicitSaveAsProfileMemory =
    typeof payload.saveAsProfileMemory === "boolean"
      ? payload.saveAsProfileMemory
      : null;
  const runtimeOrigin = asNonEmptyString(command.runtimeOrigin)?.toLowerCase() ?? "";
  const isDirectiveRuntimeOrigin =
    runtimeOrigin === "director_directive" || runtimeOrigin === "pending_promotion";

  const targetPostId = this.extractTargetPostIdForPostDraft(payload);
  const postDraftContext = await this.loadPostDraftContext({
    postId: targetPostId,
    payload,
  });
  const requiresCuration = sourceDirectiveId !== null ? true : isDirectiveRuntimeOrigin;
  const directiveSinglePromptMode = requiresCuration;
  const directiveSeedHints = this.collectDirectiveSeedHints(payload);
  const directiveTaggedHandles = this.collectDirectiveTaggedHandles(payload);
  const postVariety = this.selectPostVarietyMode({
    commandId: command.id,
    postType,
    payload,
    context: postDraftContext,
    seedHints: directiveSeedHints,
  });
  await this.ctx.memory
    .recordWrite({
      type: "post_variety_mode_selected",
      at: nowIso(),
      commandId: command.id,
      postType,
      mode: postVariety.mode,
      reason: postVariety.reason,
      recentModes: postVariety.recentModes,
      targetPostId: postDraftContext.targetPostId,
    })
    .catch(() => undefined);

  const commonInput: WriteCreatePostCommonInput = {
    command,
    payload,
    postType,
    postKind,
    sourceDirectiveId,
    sourceDirectiveActionNonce,
    explicitSaveAsProfileMemory,
    provenance,
    postDraftContext,
    requiresCuration,
    directiveSinglePromptMode,
    directiveSeedHints,
    directiveTaggedHandles,
    postVariety,
  };

  if (postType === "text") {
    return executeWriteCreatePostText.call(this, commonInput);
  }
  return executeWriteCreatePostMedia.call(this, commonInput);
}
