import { appendJsonLine } from "../lib/fs-helpers.js";
import { nowIso } from "../lib/text.js";
import type { StateVisibility, StateSqliteStore } from "../state/sqlite-state.js";

type BridgeStateEventInput = {
  source: string;
  topic: string;
  eventType: string;
  visibility: StateVisibility;
  at: string;
  payload: unknown;
};

type BridgeStateSnapshotInput = {
  scope: string;
  visibility: StateVisibility;
  at: string;
  data: unknown;
};

export const createBridgeStateStoreWriters = (
  stateDb: StateSqliteStore,
  stateDbReady: boolean,
): {
  safeStateAppendEvent: (input: BridgeStateEventInput) => void;
  safeStateUpsertSnapshot: (input: BridgeStateSnapshotInput) => void;
} => {
  const safeStateAppendEvent = (input: BridgeStateEventInput): void => {
    if (!stateDbReady) return;
    try {
      stateDb.appendEvent(input);
    } catch (error) {
      console.warn(
        "[chat-bridge] failed to append sqlite state event; continuing.",
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  };

  const safeStateUpsertSnapshot = (input: BridgeStateSnapshotInput): void => {
    if (!stateDbReady) return;
    try {
      stateDb.upsertSnapshot(input);
    } catch (error) {
      console.warn(
        "[chat-bridge] failed to upsert sqlite state snapshot; continuing.",
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  };

  return { safeStateAppendEvent, safeStateUpsertSnapshot };
};

export const createChatBridgeEventWriters = (input: {
  eventsPath: string;
  inboxPath: string;
  safeStateAppendEvent: (event: BridgeStateEventInput) => void;
}): {
  appendBridgeEvent: (payload: Record<string, unknown>) => Promise<void>;
  appendInboxEvent: (payload: Record<string, unknown>) => Promise<void>;
} => {
  const appendBridgeEvent = async (
    payload: Record<string, unknown>,
  ): Promise<void> => {
    await appendJsonLine(input.eventsPath, payload).catch(() => undefined);
    const eventType =
      typeof payload.type === "string" && payload.type.trim().length > 0
        ? payload.type.trim()
        : "event";
    const at =
      typeof payload.at === "string" && payload.at.trim().length > 0
        ? payload.at.trim()
        : nowIso();
    input.safeStateAppendEvent({
      source: "chat-bridge",
      topic: "chat.bridge",
      eventType,
      visibility: "private",
      at,
      payload,
    });
  };

  const appendInboxEvent = async (
    payload: Record<string, unknown>,
  ): Promise<void> => {
    await appendJsonLine(input.inboxPath, payload).catch(() => undefined);
    const at =
      typeof payload.at === "string" && payload.at.trim().length > 0
        ? payload.at.trim()
        : nowIso();
    input.safeStateAppendEvent({
      source: "chat-bridge",
      topic: "chat.inbox",
      eventType: "message.created",
      visibility: "private",
      at,
      payload,
    });
  };

  return { appendBridgeEvent, appendInboxEvent };
};
