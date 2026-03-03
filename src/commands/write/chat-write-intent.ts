/** Chat write permission gates, intent detection, and origin helpers. */

import type { Command } from "../../types/ipc.js";
import type { GeneratedDraft } from "../types.js";

import {
  asNonEmptyString,
} from "../helpers.js";

import { resolveChatCommandName } from "../follow/follow-actions.js";
import { resolveCommandSourceDirectiveId } from "../directives/resolution.js";
import {
  resolveRequestedGenerateKinds,
  normalizeRequestedGenerateKind,
  isPersonaMediaCompatibleDraft,
} from "../generate/generate-input.js";

import { isRecord } from "../../lib/guards.js";

// ---------------------------------------------------------------------------
// shouldEnforceExplicitPublishGate
// ---------------------------------------------------------------------------

export function shouldEnforceExplicitPublishGate(payload: Record<string, unknown>): boolean {
  if (payload.chatLiteralGenerate === true) return false;
  const goal = asNonEmptyString(payload.goal)?.toLowerCase() ?? "";
  if (goal === "chat" || goal === "settings" || goal === "moderation") {
    return false;
  }

  const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
  const commandName = asNonEmptyString(chatContext?.commandName)?.toLowerCase() ?? "";
  if (
    commandName === "follow" ||
    commandName === "follow-engagers" ||
    commandName === "followengagers" ||
    commandName === "follow-accept" ||
    commandName === "followaccept" ||
    commandName === "agent-status" ||
    commandName === "chat-status" ||
    commandName === "settings"
  ) {
    return false;
  }

  const serverIntentHint = isRecord(chatContext?.serverIntentHint)
    ? chatContext.serverIntentHint
    : null;
  const actionFamily =
    asNonEmptyString(serverIntentHint?.actionFamily)?.toLowerCase() ?? "";
  if (
    actionFamily === "conversation" ||
    actionFamily === "settings" ||
    actionFamily === "assist" ||
    actionFamily === "research"
  ) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// isWriteDraftAction
// ---------------------------------------------------------------------------

export function isWriteDraftAction(actionValue: string): boolean {
  const action = actionValue.trim().toLowerCase();
  return (
    action === "post" ||
    action === "story" ||
    action === "comment" ||
    action === "like" ||
    action === "repost" ||
    action === "avatar" ||
    action === "banner"
  );
}

// ---------------------------------------------------------------------------
// isChatWriteRequesterOwner
// ---------------------------------------------------------------------------

export function isChatWriteRequesterOwner(payload: Record<string, unknown>): boolean {
  const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
  const actorMainUserId =
    asNonEmptyString(chatContext?.actorMainUserId) ??
    asNonEmptyString(payload.actorMainUserId);
  const ownerMainUserId =
    asNonEmptyString(chatContext?.ownerMainUserId) ??
    asNonEmptyString(payload.ownerMainUserId);
  if (!ownerMainUserId) return true;
  if (!actorMainUserId) return false;
  return actorMainUserId === ownerMainUserId;
}

// ---------------------------------------------------------------------------
// isChatWriteCommandExplicitlyRequested
// ---------------------------------------------------------------------------

export function isChatWriteCommandExplicitlyRequested(
  payload: Record<string, unknown>,
): boolean {
  if (
    payload.explicitPublishRequested === true ||
    payload.explicitPublishVerbDetected === true
  ) {
    return true;
  }
  const chatCommandName = resolveChatCommandName(payload);
  if (chatCommandName) {
    const normalized = chatCommandName.trim().toLowerCase().replace(/[\s-]+/gu, "_");
    if (
      normalized === "post" ||
      normalized === "schedule" ||
      normalized === "reply_post" ||
      normalized === "replypost" ||
      normalized === "reply_commenters" ||
      normalized === "reply_comments" ||
      normalized === "comment" ||
      normalized === "like" ||
      normalized === "repost" ||
      normalized === "story" ||
      normalized === "stories"
    ) {
      return true;
    }
    if (normalized === "assist") {
      const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
      const args = Array.isArray(chatContext?.commandArgs)
        ? chatContext.commandArgs
            .map((entry) => asNonEmptyString(entry)?.trim().toLowerCase() ?? "")
            .filter((entry) => entry.length > 0)
        : [];
      const assistAction = args[0] ?? "";
      if (
        assistAction === "reply-circle" ||
        assistAction === "reply_circle" ||
        assistAction === "advertise-post" ||
        assistAction === "advertise_post" ||
        assistAction === "like-circle-stories" ||
        assistAction === "like_circle_stories"
      ) {
        return true;
      }
    }
  }
  const requestedAction = asNonEmptyString(payload.requestedAction)?.toLowerCase() ?? "";
  if (
    requestedAction === "post" ||
    requestedAction === "story" ||
    requestedAction === "comment" ||
    requestedAction === "reply" ||
    requestedAction === "like" ||
    requestedAction === "repost"
  ) {
    return true;
  }
  const goal = asNonEmptyString(payload.goal)?.toLowerCase() ?? "";
  return (
    goal === "post" ||
    goal === "story" ||
    goal === "comment" ||
    goal === "like" ||
    goal === "repost"
  );
}

// ---------------------------------------------------------------------------
// isChatMediaIntentPayload
// ---------------------------------------------------------------------------

export function isChatMediaIntentPayload(payload: Record<string, unknown>): boolean {
  if (payload.chatLiteralGenerate === true || payload.chatLiteralGenerate === "true") {
    return true;
  }
  const generatedAssetType = asNonEmptyString(payload.generatedAssetType)?.toLowerCase() ?? "";
  if (
    generatedAssetType === "image" ||
    generatedAssetType === "gif" ||
    generatedAssetType === "video" ||
    generatedAssetType === "mp4"
  ) {
    return true;
  }
  const requestedKinds = resolveRequestedGenerateKinds(payload, "media");
  if (requestedKinds.includes("media") || requestedKinds.includes("multi_media")) {
    return true;
  }
  const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
  const serverIntentHint = isRecord(chatContext?.serverIntentHint)
    ? chatContext.serverIntentHint
    : null;
  if (serverIntentHint?.wantsGeneratedImage === true) {
    return true;
  }
  const signal = [
    asNonEmptyString(payload.mediaPrompt),
    asNonEmptyString(payload.imagePrompt),
    asNonEmptyString(payload.prompt),
    asNonEmptyString(payload.topic),
    asNonEmptyString(payload.requestText),
    asNonEmptyString(chatContext?.originalMessage),
    asNonEmptyString(chatContext?.commandRawArgs),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return /\b(image|gif|photo|picture|visual|illustration|art|render|sticker|emote|emoji|avatar|banner)\b/iu.test(
    signal,
  );
}

// ---------------------------------------------------------------------------
// resolveChatLiteralFallbackPromptFromDrafts
// ---------------------------------------------------------------------------

export function resolveChatLiteralFallbackPromptFromDrafts(input: {
  payload: Record<string, unknown>;
  drafts: GeneratedDraft[];
}): string | null {
  for (const draft of input.drafts) {
    const draftPayload = isRecord(draft.payload) ? draft.payload : null;
    if (!draftPayload) continue;
    const resolved =
      asNonEmptyString(draftPayload.mediaPrompt) ??
      asNonEmptyString(draftPayload.imagePrompt) ??
      asNonEmptyString(draftPayload.prompt) ??
      asNonEmptyString(draftPayload.topic) ??
      asNonEmptyString(draftPayload.caption) ??
      asNonEmptyString(draftPayload.textBody) ??
      asNonEmptyString(draftPayload.body);
    if (resolved) return resolved;
  }
  return (
    asNonEmptyString(input.payload.mediaPrompt) ??
    asNonEmptyString(input.payload.imagePrompt) ??
    asNonEmptyString(input.payload.prompt) ??
    asNonEmptyString(input.payload.topic) ??
    asNonEmptyString(input.payload.requestText) ??
    null
  );
}

// ---------------------------------------------------------------------------
// isChatOriginPayload
// ---------------------------------------------------------------------------

export function isChatOriginPayload(payload: Record<string, unknown> | null): boolean {
  if (!payload) return false;
  const sourceContext = asNonEmptyString(payload.sourceContext)?.toLowerCase() ?? "";
  if (sourceContext === "chat") return true;
  if (
    sourceContext === "directive" ||
    sourceContext === "director" ||
    sourceContext === "admin" ||
    sourceContext === "autonomous"
  ) {
    return false;
  }
  return isRecord(payload.chatContext);
}

// ---------------------------------------------------------------------------
// didChatMessageExplicitlyRequestStory
// ---------------------------------------------------------------------------

export function didChatMessageExplicitlyRequestStory(
  payload: Record<string, unknown>,
): boolean {
  const commandName = resolveChatCommandName(payload);
  if (commandName) {
    const normalizedCommandName = commandName
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/gu, "_");
    if (
      normalizedCommandName === "story" ||
      normalizedCommandName === "stories" ||
      normalizedCommandName === "generate_story" ||
      normalizedCommandName === "generate_stories"
    ) {
      return true;
    }
  }
  const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
  const commandArgs = Array.isArray(chatContext?.commandArgs)
    ? chatContext.commandArgs
    : [];
  for (const entry of commandArgs) {
    if (normalizeRequestedGenerateKind(entry) === "story") {
      return true;
    }
  }

  const explicitTextCandidates = [
    asNonEmptyString(chatContext?.originalMessage),
    asNonEmptyString(chatContext?.commandRawArgs),
  ]
    .map((entry) => entry?.trim() ?? "")
    .filter((entry) => entry.length > 0);
  if (explicitTextCandidates.length === 0) return false;

  const messageText = explicitTextCandidates[0] ?? "";
  if (!/\bstor(?:y|ies)\b/iu.test(messageText)) return false;
  if (
    /\b(?:make|create|generate|post|publish|share|write|queue|start|do)\b[\w\s,.'"!?-]{0,64}\bstor(?:y|ies)\b/iu.test(
      messageText,
    )
  ) {
    return true;
  }
  if (
    /\bstor(?:y|ies)\b[\w\s,.'"!?-]{0,32}\b(?:post|publish|share|make|create|generate)\b/iu.test(
      messageText,
    )
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// isChatOriginCommand
// ---------------------------------------------------------------------------

export function isChatOriginCommand(
  command: Command,
  payloadOverride?: Record<string, unknown> | null,
): boolean {
  const runtimeOrigin = asNonEmptyString(command.runtimeOrigin)?.toLowerCase() ?? "";
  if (runtimeOrigin === "chat" || runtimeOrigin.startsWith("chat_")) {
    return true;
  }
  const payload =
    payloadOverride ??
    (isRecord(command.payload) ? command.payload : null);
  if (
    runtimeOrigin === "director_directive" ||
    runtimeOrigin === "pending_promotion"
  ) {
    return isChatOriginPayload(payload);
  }
  if (runtimeOrigin === "runtime_resealed") {
    const commandId = asNonEmptyString(command.id);
    const sourceDirectiveId = resolveCommandSourceDirectiveId({
      command,
      payload,
    });
    const pendingDirectiveId = asNonEmptyString(command.pendingDirectiveId);
    if (
      commandId &&
      (sourceDirectiveId === commandId || pendingDirectiveId === commandId)
    ) {
      return false;
    }
  }
  return isChatOriginPayload(payload);
}

// ---------------------------------------------------------------------------
// isStoryGenerateRequestFromChatPayload
// ---------------------------------------------------------------------------

export function isStoryGenerateRequestFromChatPayload(
  payload: Record<string, unknown>,
): boolean {
  if (!didChatMessageExplicitlyRequestStory(payload)) {
    return false;
  }
  const requestedKinds = resolveRequestedGenerateKinds(payload, "media");
  if (requestedKinds.includes("story")) return true;
  const commandName = resolveChatCommandName(payload);
  if (commandName) {
    const normalized = commandName.trim().toLowerCase().replace(/[\s-]+/gu, "_");
    if (
      normalized === "story" ||
      normalized === "stories" ||
      normalized === "generate_story" ||
      normalized === "generate_stories"
    ) {
      return true;
    }
  }
  const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
  const commandArgs = Array.isArray(chatContext?.commandArgs)
    ? chatContext.commandArgs
    : [];
  for (const entry of commandArgs) {
    if (normalizeRequestedGenerateKind(entry) === "story") {
      return true;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// shouldRedirectBlockedChatWritesToLiteralGenerate
// ---------------------------------------------------------------------------

export function shouldRedirectBlockedChatWritesToLiteralGenerate(input: {
  payload: Record<string, unknown>;
  blockedDrafts: GeneratedDraft[];
}): boolean {
  if (isChatMediaIntentPayload(input.payload)) {
    return true;
  }
  return input.blockedDrafts.some((draft) => isPersonaMediaCompatibleDraft(draft));
}
