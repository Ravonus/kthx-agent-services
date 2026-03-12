import { describe, expect, it, vi } from "vitest";

import type { ChatInboxEntry } from "./chat-reply.js";
import { buildAutoReply } from "./chat-intent.js";

const entry: ChatInboxEntry = {
  messageId: "msg-1",
  body: "Can you help me with this?",
  replyToMessageId: null,
  topic: null,
  eventType: "message.created",
  conversationId: "conv-1",
  channelId: null,
  authorIsAgent: false,
  authorMainUserId: "user-1",
  commandKind: "none",
  authorDisplay: "Casey",
  authorHandle: "casey",
  receivedAt: new Date().toISOString(),
  serverIntentCommand: null,
  serverIntentActionFamily: null,
  serverIntentConfidence: null,
};

describe("buildAutoReply", () => {
  it("skips drilldown loading when the first pass is already good enough", async () => {
    const recordWrite = vi.fn(async () => undefined);
    const runOpenClawPrompt = vi.fn(async () => ({
      parsed: {
        intent: "general_chat",
        reply: "Here is the short answer you asked for.",
      },
      raw: "",
      agentName: "tester",
      payloadText: null,
      envelope: null,
    }));
    const loadDrilldownContext = vi.fn(async () => "unused");

    const reply = await buildAutoReply(entry, {
      maxChars: 240,
      useOpenClaw: true,
      recordWrite,
      runOpenClawPrompt,
      fetchConversationHistory: async () => [],
      loadDrilldownContext,
    });

    expect(reply).toBe("Here is the short answer you asked for.");
    expect(runOpenClawPrompt).toHaveBeenCalledTimes(1);
    expect(loadDrilldownContext).not.toHaveBeenCalled();
  });

  it("loads drilldown only after a low-confidence first pass", async () => {
    const recordWrite = vi.fn(async () => undefined);
    const runOpenClawPrompt = vi.fn(async ({ purpose }: { purpose: string }) => {
      if (purpose === "chat_reply") {
        return {
          parsed: {
            intent: "greeting",
            reply: "Ask me anything.",
          },
          raw: "",
          agentName: "tester",
          payloadText: null,
          envelope: null,
        };
      }
      return {
        parsed: {
          intent: "general_chat",
          reply: "I checked the context and here is the answer.",
        },
        raw: "",
        agentName: "tester",
        payloadText: null,
        envelope: null,
      };
    });
    const loadDrilldownContext = vi.fn(async () => "extra context");

    const reply = await buildAutoReply(entry, {
      maxChars: 240,
      useOpenClaw: true,
      recordWrite,
      runOpenClawPrompt,
      fetchConversationHistory: async () => [],
      loadDrilldownContext,
    });

    expect(reply).toBe("I checked the context and here is the answer.");
    expect(runOpenClawPrompt).toHaveBeenCalledTimes(2);
    expect(loadDrilldownContext).toHaveBeenCalledTimes(1);
    expect(recordWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chat_runtime_reply_drilldown_attempted",
      }),
    );
  });
});
