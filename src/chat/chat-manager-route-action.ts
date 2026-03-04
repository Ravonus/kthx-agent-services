import { isRecord } from "../lib/guards.js";
import { nowIso, toAnswerPreview } from "../lib/text.js";
import { truncateChatReply } from "./chat-reply.js";
import type { ChatInboxEntry } from "./chat-reply.js";
import type { LinkedOwnerIdentity } from "./chat-types.js";
import {
  hasDeterministicRouteTarget,
  parseDeterministicRouteAction,
} from "./chat-manager-route-parse.js";

export type HandleDeterministicRouteActionDeps = {
  recordWrite: (payload: Record<string, unknown>) => Promise<unknown>;
  callAgentChatBridge: (payload: Record<string, unknown>) => Promise<unknown>;
  replyMaxChars: number;
  loadLinkedOwnerIdentity: () => Promise<LinkedOwnerIdentity | null>;
};

export const handleDeterministicRouteAction = async (
  deps: HandleDeterministicRouteActionDeps,
  entry: ChatInboxEntry,
): Promise<string | null> => {
  const body = entry.body.trim();
  if (!body.length) return null;
  const matched = parseDeterministicRouteAction(body);
  if (!matched) return null;
  if (matched.kind === "clarify") {
    await deps
      .recordWrite({
        type: "chat_runtime_route_action_clarify",
        at: nowIso(),
        messageId: entry.messageId,
        conversationId: entry.conversationId,
        channelId: entry.channelId,
        bodyPreview: toAnswerPreview(body, 180),
        clarification: toAnswerPreview(matched.reply, 220),
      })
      .catch(() => undefined);
    return truncateChatReply(
      matched.reply,
      deps.replyMaxChars,
    );
  }

  const { payload, registration } = matched;
  const policy = registration.policy;
  if (policy.dmOnly && !entry.conversationId) return null;
  if (!policy.allowChannel && entry.channelId) return null;
  const payloadTarget = hasDeterministicRouteTarget(payload)
    ? payload.target
    : null;
  if (
    payloadTarget &&
    Array.isArray(policy.allowedTargets) &&
    !policy.allowedTargets.includes(payloadTarget)
  ) {
    const blockedTargetReply = `I can’t apply that route target (${payloadTarget}) for this action.`;
    await deps
      .recordWrite({
        type: "chat_runtime_route_action_permission_denied",
        at: nowIso(),
        messageId: entry.messageId,
        conversationId: entry.conversationId,
        channelId: entry.channelId,
        action: payload.action,
        target: payloadTarget,
        reason: "target_not_allowed",
        bodyPreview: toAnswerPreview(body, 180),
      })
      .catch(() => undefined);
    return truncateChatReply(
      blockedTargetReply,
      deps.replyMaxChars,
    );
  }
  if (
    payloadTarget === "owner" &&
    policy.requireLinkedOwnerForOwnerTarget
  ) {
    const linkedOwner = await deps.loadLinkedOwnerIdentity();
    if (!linkedOwner) {
      const missingOwnerReply =
        "This agent is not linked to an owner account, so I can only update agent-side profile/settings right now.";
      await deps
        .recordWrite({
          type: "chat_runtime_route_action_owner_unlinked",
          at: nowIso(),
          messageId: entry.messageId,
          conversationId: entry.conversationId,
          channelId: entry.channelId,
          action: payload.action,
          target: payloadTarget,
          bodyPreview: toAnswerPreview(body, 180),
        })
        .catch(() => undefined);
      return truncateChatReply(
        missingOwnerReply,
        deps.replyMaxChars,
      );
    }
  }

  await deps
    .recordWrite({
      type: "chat_runtime_route_action_started",
      at: nowIso(),
      messageId: entry.messageId,
      conversationId: entry.conversationId,
      channelId: entry.channelId,
      action: payload.action,
      target: payloadTarget,
      payload,
    })
    .catch(() => undefined);
  try {
    const response = await deps.callAgentChatBridge(payload);
    const reply = registration.summarizeSuccess(payload, response);
    await deps
      .recordWrite({
        type: "chat_runtime_route_action_applied",
        at: nowIso(),
        messageId: entry.messageId,
        conversationId: entry.conversationId,
        channelId: entry.channelId,
        action: payload.action,
        target: payloadTarget,
        payload,
        response: isRecord(response) ? response : null,
        replyPreview: toAnswerPreview(reply, 220),
      })
      .catch(() => undefined);
    return truncateChatReply(reply, deps.replyMaxChars);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const label = registration.failureLabel;
    const reply = `I could not apply that ${label} right now: ${toAnswerPreview(message, 200)}.`;
    await deps
      .recordWrite({
        type: "chat_runtime_route_action_failed",
        at: nowIso(),
        messageId: entry.messageId,
        conversationId: entry.conversationId,
        channelId: entry.channelId,
        action: payload.action,
        target: payloadTarget,
        payload,
        error: toAnswerPreview(message, 220),
      })
      .catch(() => undefined);
    return truncateChatReply(reply, deps.replyMaxChars);
  }
};
