import type { ContextBundle } from "../types/memory.js";
import type { ChatInboxEntry } from "./chat-reply.js";

export type LiveSiteLookupInput = {
  entry: ChatInboxEntry;
  retrievalQuery: string;
  hints: { postId?: number; commentId?: number };
  bundle: ContextBundle;
};

export type LiveSiteLookupDeps = {
  recordWrite: (payload: Record<string, unknown>) => Promise<unknown>;
  callAgentChatBridge: (payload: Record<string, unknown>) => Promise<unknown>;
};

export type LiveSiteLookupRuntime = {
  input: LiveSiteLookupInput;
  lines: string[];
  remember: (payload: Record<string, unknown>) => Promise<void>;
  lookupCall: (payload: Record<string, unknown>) => Promise<unknown>;
  listServers: () => Promise<Array<Record<string, unknown>>>;
};
