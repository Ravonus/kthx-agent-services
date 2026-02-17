/**
 * ChatManager: inbox polling, auto-reply orchestration, and text stream
 * simulation for the agent's chat runtime.
 *
 * Ported from agent-runtime.mjs lines 5815-6267 (send reply, text stream,
 * inbox parsing, poll loop) and portions of 20000+ (entry processing).
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";

import { isRecord } from "../lib/guards.js";
import { nowIso, toAnswerPreview } from "../lib/text.js";
import { readJsonFile, writeJsonFile } from "../lib/fs.js";
import type { ChatManagerLike } from "../runtime-context.js";
import type { ChatInboxEntry } from "./chat-reply.js";
import {
  truncateChatReply,
  shouldReplyToChatInboxEntry,
  buildMentionTokens,
  computeStreamStepChars,
} from "./chat-reply.js";
import { normalizeInboxEntry, buildAutoReply } from "./chat-intent.js";

// ---------------------------------------------------------------------------
// Narrow context interface
// ---------------------------------------------------------------------------

export interface ChatManagerContext {
  config: {
    chatRuntimeEnabled: boolean;
    chatRuntimePollMs: number;
    chatRuntimeReadChunkBytes: number;
    chatRuntimeSeenMessageLimit: number;
    chatRuntimeReplyMaxChars: number;
    chatRuntimeOpenClawInputMaxChars: number;
    chatRuntimeUseOpenClaw: boolean;
    chatRuntimeReplayOnStart: boolean;
    chatRuntimeChannelRequireMention: boolean;
    chatRuntimeMentionNames: string[];
    chatRuntimeTextStreamEnabled: boolean;
    chatRuntimeTextStreamNativeEnabled: boolean;
    chatRuntimeTextStreamNativeOnly: boolean;
    chatRuntimeTextStreamStepChars: number;
    chatRuntimeTextStreamStepMs: number;
    chatRuntimeTextStreamUpdateMinMs: number;
  };
  ipcPaths: {
    chatInboxPath: string;
    chatRuntimeStatePath: string;
  };
  memory: { recordWrite(payload: unknown): Promise<void> };
  chat: ChatTrackingState;
  callAgentChatBridge: (payload: unknown) => Promise<unknown>;
  runOpenClawPrompt: (opts: {
    prompt: string; purpose: string;
    onTextDelta?: ((delta: string) => void) | null;
  }) => Promise<OpenClawPromptResponse | null>;
  resolveOpenClawAgentName: () => Promise<string | null>;
  runMemoryCheckpoint: (opts: { force: boolean; source: string; allowAgentCompression: boolean }) => Promise<void>;
}

export interface ChatTrackingState {
  chatInboxPollInFlight: boolean;
  chatInboxCursorInitialized: boolean;
  chatInboxReadOffset: number;
  chatInboxPartialLine: string;
  chatRuntimeStateDirty: boolean;
  chatRuntimeStateWriteAtMs: number;
  chatReplyThrottleUntilMs: number;
  chatSeenMessageIds: Set<string>;
  chatSeenMessageIdQueue: string[];
  chatMentionTokensCache: string[];
  chatMentionTokensCachedAtMs: number;
}

interface OpenClawPromptResponse {
  parsed: unknown;
  raw: string;
  agentName: string | null;
  payloadText: string | null;
  envelope: Record<string, unknown> | null;
}

interface StreamState {
  entry: ChatInboxEntry;
  messageId: string | null;
  currentBody: string;
  targetBody: string;
  lastUpdateAtMs: number;
  nativeDeltaChars: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const extractSentMessageId = (response: unknown): string | null => {
  if (!isRecord(response)) return null;
  const primary = isRecord(response.primary) ? response.primary : null;
  const message = isRecord(primary?.message) ? primary.message : null;
  if (typeof message?.id === "string" && (message.id as string).trim().length > 0) return (message.id as string).trim();
  if (typeof response.messageId === "string" && (response.messageId as string).trim().length > 0) return (response.messageId as string).trim();
  if (typeof response.id === "string" && (response.id as string).trim().length > 0) return (response.id as string).trim();
  return null;
};

// ---------------------------------------------------------------------------
// ChatManager
// ---------------------------------------------------------------------------

export class ChatManager implements ChatManagerLike {
  private readonly ctx: ChatManagerContext;
  constructor(ctx: ChatManagerContext) { this.ctx = ctx; }

  async pollInbox(): Promise<void> {
    if (!this.ctx.config.chatRuntimeEnabled || this.ctx.chat.chatInboxPollInFlight) return;
    this.ctx.chat.chatInboxPollInFlight = true;
    try {
      await this.initializeCursor();
      const lines = await this.readDeltaLines();
      for (const line of lines) {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        const entry = normalizeInboxEntry(parsed);
        if (!entry) continue;
        if (this.ctx.chat.chatSeenMessageIds.has(entry.messageId)) continue;
        this.rememberSeenMessageId(entry.messageId);
        await this.ctx.memory.recordWrite({
          type: entry.commandKind !== "none" ? "chat_runtime_command_received" : "chat_runtime_interaction_received",
          at: entry.receivedAt, messageId: entry.messageId, conversationId: entry.conversationId,
          channelId: entry.channelId, commandKind: entry.commandKind, authorHandle: entry.authorHandle,
          bodyPreview: toAnswerPreview(entry.body, 160),
        }).catch(() => undefined);
        const mentionTokens = await this.resolveMentionTokens();
        if (!shouldReplyToChatInboxEntry(entry, { channelRequireMention: this.ctx.config.chatRuntimeChannelRequireMention, mentionTokens })) continue;
        await this.ctx.runMemoryCheckpoint({ force: true, source: "chat_runtime_interaction", allowAgentCompression: true }).catch(() => {});
        let typingSent = false;
        try {
          await this.setTyping(entry, true).catch(() => undefined);
          typingSent = true;
          const shouldStream = this.ctx.config.chatRuntimeTextStreamEnabled && this.ctx.config.chatRuntimeUseOpenClaw;
          const streamState = shouldStream ? this.createStreamState(entry) : null;
          const replyBody = await buildAutoReply(entry, {
            maxChars: this.ctx.config.chatRuntimeReplyMaxChars,
            useOpenClaw: this.ctx.config.chatRuntimeUseOpenClaw,
            recordWrite: (p) => this.ctx.memory.recordWrite(p),
            runOpenClawPrompt: (o) => this.ctx.runOpenClawPrompt(o),
            fetchConversationHistory: (e) => this.fetchConversationHistory(e),
          });
          if (!replyBody.length) {
            if (streamState) await this.finalizeStream(streamState, "I ran into an issue while drafting that reply. Please try again.").catch(() => {});
            continue;
          }
          const nowMs = Date.now();
          if (this.ctx.chat.chatReplyThrottleUntilMs > nowMs) await sleep(this.ctx.chat.chatReplyThrottleUntilMs - nowMs);
          if (streamState) {
            const hasNativeStream = streamState.nativeDeltaChars > 0;
            if (!hasNativeStream && !this.ctx.config.chatRuntimeTextStreamNativeOnly) await this.simulateStream(streamState, replyBody);
            let finalized = await this.finalizeStream(streamState, replyBody);
            if (!finalized && typeof streamState.messageId === "string" && streamState.messageId.trim().length > 0) {
              const normalized = truncateChatReply(replyBody, this.ctx.config.chatRuntimeReplyMaxChars);
              try { await this.editMessage(streamState.messageId, normalized); streamState.currentBody = normalized; streamState.lastUpdateAtMs = Date.now(); finalized = true; } catch { finalized = streamState.currentBody === normalized; }
            }
            if (!finalized && (!streamState.messageId || !streamState.messageId.trim().length)) await this.sendReply(entry, replyBody);
          } else {
            await this.sendReply(entry, replyBody);
          }
          this.ctx.chat.chatReplyThrottleUntilMs = Date.now() + 650;
          await this.ctx.memory.recordWrite({
            type: "chat_runtime_auto_reply_sent", at: nowIso(), messageId: entry.messageId,
            conversationId: entry.conversationId, channelId: entry.channelId, eventType: entry.eventType,
            sourceContext: "CHAT", topic: entry.topic, replyPreview: toAnswerPreview(replyBody, 220),
            replyStreamed: Boolean(streamState), replyStreamNative: Boolean(streamState) && (streamState?.nativeDeltaChars ?? 0) > 0,
          });
        } finally {
          if (typingSent) await this.setTyping(entry, false).catch(() => undefined);
        }
      }
      await this.persistState("poll");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.ctx.memory.recordWrite({ type: "chat_runtime_auto_reply_failed", at: nowIso(), message });
    } finally {
      this.ctx.chat.chatInboxPollInFlight = false;
    }
  }

  dispose(): void { /* No timers to clear. */ }

  // -----------------------------------------------------------------------
  // Private: cursor initialization
  // -----------------------------------------------------------------------

  private async initializeCursor(): Promise<void> {
    if (this.ctx.chat.chatInboxCursorInitialized) return;
    this.ctx.chat.chatInboxCursorInitialized = true;
    const stateRaw = await readJsonFile(this.ctx.ipcPaths.chatRuntimeStatePath);
    const state = isRecord(stateRaw) ? stateRaw : null;
    const fileStat = await fs.stat(this.ctx.ipcPaths.chatInboxPath).catch(() => null);
    const fileBytes = fileStat && typeof fileStat.size === "number" && Number.isFinite(fileStat.size)
      ? Math.max(0, Math.floor(fileStat.size)) : 0;
    if (this.ctx.config.chatRuntimeReplayOnStart) {
      this.ctx.chat.chatInboxReadOffset = 0;
      this.ctx.chat.chatInboxPartialLine = "";
    } else {
      const savedOffset = state && typeof state.readOffset === "number" && Number.isFinite(state.readOffset)
        ? Math.max(0, Math.floor(state.readOffset as number)) : null;
      this.ctx.chat.chatInboxReadOffset = savedOffset === null ? fileBytes : Math.min(savedOffset, fileBytes);
      this.ctx.chat.chatInboxPartialLine = state && typeof state.partialLine === "string" && (state.partialLine as string).length <= 4096
        ? (state.partialLine as string) : "";
    }
    if (state && Array.isArray(state.seenMessageIds)) {
      for (const entry of state.seenMessageIds) {
        if (typeof entry === "string" && entry.trim().length > 0) this.rememberSeenMessageId(entry.trim());
      }
    }
    this.ctx.chat.chatRuntimeStateDirty = true;
    await this.persistState("init");
    await this.ctx.memory.recordWrite({
      type: "chat_runtime_inbox_initialized", at: nowIso(), enabled: this.ctx.config.chatRuntimeEnabled,
      replayOnStart: this.ctx.config.chatRuntimeReplayOnStart, readOffset: this.ctx.chat.chatInboxReadOffset,
      seenMessageIds: this.ctx.chat.chatSeenMessageIds.size,
    });
  }

  // -----------------------------------------------------------------------
  // Private: JSONL cursor reading
  // -----------------------------------------------------------------------

  private async readDeltaLines(): Promise<string[]> {
    const handle = await fs.open(this.ctx.ipcPaths.chatInboxPath, "r").catch(() => null);
    if (!handle) return [];
    try {
      const stat = await handle.stat().catch(() => null);
      const size = stat && typeof stat.size === "number" && Number.isFinite(stat.size) ? Math.max(0, Math.floor(stat.size)) : 0;
      if (size < this.ctx.chat.chatInboxReadOffset) {
        this.ctx.chat.chatInboxReadOffset = 0; this.ctx.chat.chatInboxPartialLine = ""; this.ctx.chat.chatRuntimeStateDirty = true;
      }
      if (size <= this.ctx.chat.chatInboxReadOffset) return [];
      const remaining = size - this.ctx.chat.chatInboxReadOffset;
      const chunkSize = Math.max(1, Math.min(remaining, this.ctx.config.chatRuntimeReadChunkBytes));
      const buffer = Buffer.allocUnsafe(chunkSize);
      const readResult = await handle.read(buffer, 0, chunkSize, this.ctx.chat.chatInboxReadOffset);
      const bytesRead = typeof readResult.bytesRead === "number" && readResult.bytesRead > 0 ? readResult.bytesRead : 0;
      if (bytesRead <= 0) return [];
      this.ctx.chat.chatInboxReadOffset += bytesRead;
      this.ctx.chat.chatRuntimeStateDirty = true;
      const chunkText = buffer.subarray(0, bytesRead).toString("utf8");
      const merged = `${this.ctx.chat.chatInboxPartialLine}${chunkText}`;
      const lines = merged.split(/\r?\n/u);
      this.ctx.chat.chatInboxPartialLine = lines.pop() ?? "";
      if (this.ctx.chat.chatInboxPartialLine.length > 8192) this.ctx.chat.chatInboxPartialLine = "";
      return lines.map((l) => l.trim()).filter((l) => l.length > 0);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  // -----------------------------------------------------------------------
  // Private: seen message dedup (LRU queue)
  // -----------------------------------------------------------------------

  private rememberSeenMessageId(messageId: string): void {
    if (typeof messageId !== "string" || !messageId.trim().length) return;
    const normalized = messageId.trim();
    if (this.ctx.chat.chatSeenMessageIds.has(normalized)) return;
    this.ctx.chat.chatSeenMessageIds.add(normalized);
    this.ctx.chat.chatSeenMessageIdQueue.push(normalized);
    while (this.ctx.chat.chatSeenMessageIdQueue.length > this.ctx.config.chatRuntimeSeenMessageLimit) {
      const removed = this.ctx.chat.chatSeenMessageIdQueue.shift();
      if (removed) this.ctx.chat.chatSeenMessageIds.delete(removed);
    }
    this.ctx.chat.chatRuntimeStateDirty = true;
  }

  // -----------------------------------------------------------------------
  // Private: send / edit / typing
  // -----------------------------------------------------------------------

  private async sendReply(entry: ChatInboxEntry, body: string): Promise<unknown> {
    const trimmedBody = truncateChatReply(body, this.ctx.config.chatRuntimeReplyMaxChars);
    if (!trimmedBody.length || /^(?:\u2026+|\.{3,})$/u.test(trimmedBody)) return null;
    return this.ctx.callAgentChatBridge({
      action: "send_message",
      clientMessageId: `runtime_chat_${Date.now().toString(36)}_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`,
      body: trimmedBody, format: "markdown", replyToMessageId: entry.messageId,
      ...(entry.conversationId ? { conversationId: entry.conversationId } : { channelId: entry.channelId }),
    });
  }

  private async editMessage(messageId: string, body: string): Promise<unknown> {
    const trimmedBody = truncateChatReply(body, this.ctx.config.chatRuntimeReplyMaxChars);
    if (!trimmedBody.length || /^(?:\u2026+|\.{3,})$/u.test(trimmedBody)) return null;
    return this.ctx.callAgentChatBridge({ action: "edit_message", messageId, body: trimmedBody });
  }

  private async setTyping(entry: ChatInboxEntry, isTyping: boolean): Promise<unknown> {
    return this.ctx.callAgentChatBridge({
      action: "typing", ...(entry.conversationId ? { conversationId: entry.conversationId } : { channelId: entry.channelId }), isTyping,
    });
  }

  // -----------------------------------------------------------------------
  // Private: text stream simulation
  // -----------------------------------------------------------------------

  private createStreamState(entry: ChatInboxEntry): StreamState {
    return { entry, messageId: null, currentBody: "", targetBody: "", lastUpdateAtMs: 0, nativeDeltaChars: 0 };
  }

  private async flushStream(state: StreamState, opts?: { force?: boolean }): Promise<boolean> {
    const force = opts?.force ?? false;
    const nextBody = truncateChatReply(state.targetBody, this.ctx.config.chatRuntimeReplyMaxChars);
    if (!nextBody.length || /^(?:\u2026+|\.{3,})$/u.test(nextBody) || nextBody === state.currentBody) return false;
    if (!force && Date.now() - state.lastUpdateAtMs < this.ctx.config.chatRuntimeTextStreamUpdateMinMs) return false;
    if (typeof state.messageId === "string" && state.messageId.trim().length > 0) {
      await this.editMessage(state.messageId, nextBody);
    } else {
      const created = await this.sendReply(state.entry, nextBody);
      const createdId = extractSentMessageId(created);
      if (!createdId) return false;
      state.messageId = createdId;
    }
    state.currentBody = nextBody; state.lastUpdateAtMs = Date.now();
    return true;
  }

  private async simulateStream(state: StreamState, finalBody: string): Promise<void> {
    const normalized = truncateChatReply(finalBody, this.ctx.config.chatRuntimeReplyMaxChars);
    if (!normalized.length) return;
    const stepChars = computeStreamStepChars(normalized.length, this.ctx.config.chatRuntimeTextStreamStepChars);
    for (let cursor = stepChars; cursor < normalized.length; cursor += stepChars) {
      state.targetBody = normalized.slice(0, cursor);
      await this.flushStream(state, { force: true }).catch(() => {});
      await sleep(this.ctx.config.chatRuntimeTextStreamStepMs);
    }
  }

  private async finalizeStream(state: StreamState, finalBody: string): Promise<boolean> {
    const normalized = truncateChatReply(finalBody, this.ctx.config.chatRuntimeReplyMaxChars);
    if (!normalized.length) return false;
    state.targetBody = normalized;
    await this.flushStream(state, { force: true }).catch(() => {});
    return state.currentBody === normalized;
  }

  // -----------------------------------------------------------------------
  // Private: state persistence
  // -----------------------------------------------------------------------

  private async persistState(reason: string): Promise<void> {
    if (!this.ctx.config.chatRuntimeEnabled || !this.ctx.chat.chatRuntimeStateDirty) return;
    const nowMs = Date.now();
    if (reason !== "init" && nowMs - this.ctx.chat.chatRuntimeStateWriteAtMs < 1000) return;
    const lastId = this.ctx.chat.chatSeenMessageIdQueue.length > 0
      ? this.ctx.chat.chatSeenMessageIdQueue[this.ctx.chat.chatSeenMessageIdQueue.length - 1] : null;
    await writeJsonFile(this.ctx.ipcPaths.chatRuntimeStatePath, {
      updatedAt: nowIso(), reason, inboxPath: this.ctx.ipcPaths.chatInboxPath,
      readOffset: this.ctx.chat.chatInboxReadOffset, partialLine: this.ctx.chat.chatInboxPartialLine,
      seenMessageIds: [...this.ctx.chat.chatSeenMessageIdQueue],
      lastProcessedMessageId: lastId ?? null, lastProcessedAt: nowIso(),
    }).catch(() => undefined);
    this.ctx.chat.chatRuntimeStateDirty = false;
    this.ctx.chat.chatRuntimeStateWriteAtMs = nowMs;
  }

  // -----------------------------------------------------------------------
  // Private: mention tokens + conversation history
  // -----------------------------------------------------------------------

  private async resolveMentionTokens(): Promise<string[]> {
    const nowMs = Date.now();
    if (nowMs - this.ctx.chat.chatMentionTokensCachedAtMs < 60_000 && this.ctx.chat.chatMentionTokensCache.length > 0) {
      return this.ctx.chat.chatMentionTokensCache;
    }
    const openclawName = await this.ctx.resolveOpenClawAgentName().catch(() => null);
    const tokens = buildMentionTokens({ mentionNames: this.ctx.config.chatRuntimeMentionNames, openclawAgentName: openclawName });
    this.ctx.chat.chatMentionTokensCache = tokens;
    this.ctx.chat.chatMentionTokensCachedAtMs = nowMs;
    return tokens;
  }

  private async fetchConversationHistory(entry: ChatInboxEntry): Promise<unknown[]> {
    try {
      const payload = {
        action: "list_messages",
        ...(entry.conversationId ? { conversationId: entry.conversationId } : { channelId: entry.channelId }),
        limit: 10,
      };
      const result = await this.ctx.callAgentChatBridge(payload);
      if (isRecord(result) && Array.isArray(result.items)) return (result.items as unknown[]).slice(0, 10).reverse();
      return [];
    } catch { return []; }
  }
}
