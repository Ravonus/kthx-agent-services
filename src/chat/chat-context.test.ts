import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { sendChatResultMessageFromOutcome } from "./chat-context.js";

const buildProgressClientMessageId = (commandId: string) =>
  `runtime_chat_progress_${crypto
    .createHash("sha256")
    .update(commandId)
    .digest("hex")
    .slice(0, 32)}`;

describe("sendChatResultMessageFromOutcome", () => {
  it("edits the existing progress card by clientMessageId and chat context", async () => {
    const commandId = "command-like-1";
    const callAgentChatBridge = vi.fn(async () => ({ ok: true }));
    const recordWrite = vi.fn(async () => undefined);

    const delivered = await sendChatResultMessageFromOutcome({
      command: {
        id: commandId,
        kind: "write.votePost",
        payload: {
          sourceContext: "CHAT",
          postId: 42,
          chatContext: {
            conversationId: "conv-1",
          },
        },
      },
      outcome: {
        ok: true,
        data: {
          skipped: false,
        },
      },
      deps: {
        callAgentChatBridge,
        memory: { recordWrite },
      },
    });

    expect(delivered).toBe(true);
    expect(callAgentChatBridge).toHaveBeenCalledTimes(1);
    expect(callAgentChatBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "edit_message",
        clientMessageId: buildProgressClientMessageId(commandId),
        conversationId: "conv-1",
      }),
    );
    expect(recordWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chat_command_result_edited",
        commandId,
      }),
    );
  });

  it("falls back to terminal send when progress edit is unavailable", async () => {
    const commandId = "command-like-2";
    const callAgentChatBridge = vi.fn(async (payload: unknown) => {
      const action =
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        typeof (payload as Record<string, unknown>).action === "string"
          ? (payload as Record<string, unknown>).action
          : "";
      if (action === "edit_message") {
        throw new Error("edit unavailable");
      }
      return { ok: true };
    });
    const recordWrite = vi.fn(async () => undefined);

    const delivered = await sendChatResultMessageFromOutcome({
      command: {
        id: commandId,
        kind: "write.votePost",
        payload: {
          sourceContext: "CHAT",
          postId: 77,
          chatContext: {
            conversationId: "conv-2",
          },
        },
      },
      outcome: {
        ok: true,
      },
      deps: {
        callAgentChatBridge,
        memory: { recordWrite },
      },
    });

    expect(delivered).toBe(true);
    expect(callAgentChatBridge).toHaveBeenCalledTimes(2);
    expect(callAgentChatBridge.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        action: "edit_message",
        clientMessageId: buildProgressClientMessageId(commandId),
        conversationId: "conv-2",
      }),
    );
    expect(callAgentChatBridge.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        action: "send_message",
        conversationId: "conv-2",
      }),
    );
  });
});
