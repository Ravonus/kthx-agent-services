/**
 * ChatManager: inbox polling, auto-reply orchestration, and text stream
 * simulation for the agent's chat runtime.
 *
 * Ported from agent-runtime.mjs lines 5815-6267 (send reply, text stream,
 * inbox parsing, poll loop) and portions of 20000+ (entry processing).
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";

import { sleep } from "../lib/async.js";
import { isRecord } from "../lib/guards.js";
import { nowIso, toAnswerPreview } from "../lib/text.js";
import { readJsonFile, writeJsonFile } from "../lib/fs.js";
import type { ChatManagerLike } from "../runtime-context.js";
import type { ContextBundle, RetrievalIntent } from "../types/memory.js";
import type {
  AgentReplyPolicyValue,
  ChatManagerContext,
  DeterministicRouteMatch,
  DeterministicRouteParseResult,
  DeterministicRoutePayload,
  DeterministicRoutePolicy,
  DeterministicRouteRegistration,
  DeterministicRouteTargetedPayload,
  DmAutomatedPolicyValue,
  DmPolicyValue,
  ProfileSettingsTarget,
  ReplyTargetContext,
  RetentionDialogState,
  StaleReplyDecision,
  StreamState,
} from "./chat-types.js";
import type { ChatInboxEntry } from "./chat-reply.js";
import {
  truncateChatReply,
  shouldReplyToChatInboxEntry,
  buildMentionTokens,
} from "./chat-reply.js";
import { normalizeInboxEntry, buildAutoReply } from "./chat-intent.js";
import {
  extractSentMessageId,
  stripEmDashCharacters,
} from "./chat-manager-context-utils.js";
import {
  BROWSE_AGENT_LOOKUP_PATTERN,
  BROWSE_ASSETS_LOOKUP_PATTERN,
  BROWSE_CHANNELS_LOOKUP_PATTERN,
  BROWSE_COMMENT_ACTIVITY_LOOKUP_PATTERN,
  BROWSE_COMMENT_LOOKUP_PATTERN,
  BROWSE_DIRECTIVE_QUEUE_LOOKUP_PATTERN,
  BROWSE_DRAFTS_LOOKUP_PATTERN,
  BROWSE_HOME_FEED_LOOKUP_PATTERN,
  BROWSE_LENSES_LOOKUP_PATTERN,
  BROWSE_MEMBERS_LOOKUP_PATTERN,
  BROWSE_NOTIFICATIONS_LOOKUP_PATTERN,
  BROWSE_POST_ACTIVITY_LOOKUP_PATTERN,
  BROWSE_POST_LOOKUP_PATTERN,
  BROWSE_RECENT_ACTIONS_LOOKUP_PATTERN,
  BROWSE_SERVERS_LOOKUP_PATTERN,
  BROWSE_TOP_ENGAGERS_LOOKUP_PATTERN,
  BROWSE_TRENDING_LOOKUP_PATTERN,
  BROWSE_UNANSWERED_MENTIONS_LOOKUP_PATTERN,
  COMMENT_LOOKUP_PATTERN,
  CUSTOM_ASSET_LOOKUP_PATTERN,
  FOLLOW_LOOKUP_PATTERN,
  GIF_LOOKUP_PATTERN,
  LATEST_POST_LOOKUP_PATTERN,
  LOOKUP_FORCE_PATTERN,
  RESOLVE_REFERENCE_LOOKUP_PATTERN,
  SEARCH_GLOBAL_LOOKUP_PATTERN,
  SITE_LOOKUP_TRIGGER_PATTERN,
  SUGGESTED_FOLLOW_LOOKUP_PATTERN,
  extractCustomAssetSearchQuery,
  extractGifSearchQuery,
  extractLookupQueryTerm,
  parseHandleMentions,
  parseLookupWindowHours,
  parseRetrievalHitCount,
  pickCommentRecordsFromLookup,
  pickCustomAssetRecordsFromLookup,
  pickGifRecordsFromLookup,
  pickPostRecordFromLookup,
  pickPostRecordsFromLookup,
  pickUserRecordsFromLookup,
  resolveRetrievalIntentForEntry,
  summarizeCommentRecord,
  summarizeCustomAssetRecord,
  summarizeGifRecord,
  summarizePostRecord,
  summarizeUserRecord,
  toFinitePositiveInt,
} from "./chat-manager-lookup-utils.js";
import {
  loadLiveSiteLookup as _loadLiveSiteLookup,
  shouldRunLiveSiteLookup as _shouldRunLiveSiteLookup,
  type LiveSiteLookupInput,
} from "./chat-manager-live-site-lookup.js";
import {
  parseRetentionDialogState,
} from "./chat-manager-retention-utils.js";
import { buildDrilldownMemorySummary } from "./chat-manager-drilldown-summary.js";
import { loadDrilldownContext as _loadDrilldownContext } from "./chat-manager-drilldown-context.js";
import { handleDeterministicRouteAction as _handleDeterministicRouteAction } from "./chat-manager-route-action.js";
import { resolveReplyTargetContext as _resolveReplyTargetContext } from "./chat-manager-reply-target-context.js";
import {
  fetchConversationHistory as _fetchConversationHistory,
  reportSystemProbe as _reportSystemProbe,
} from "./chat-manager-conversation-support.js";
import {
  createLinkedOwnerIdentityState,
  createSystemDocContextState,
  loadLinkedOwnerIdentity as _loadLinkedOwnerIdentity,
  loadSystemDocContext as _loadSystemDocContext,
} from "./chat-manager-owner-context.js";
import { handleRetentionPolicyDialog as _handleRetentionPolicyDialog } from "./chat-manager-retention-dialog.js";

const STALE_IMPORTANT_PATTERN =
  /\?|(\b(can you|could you|would you|please|help|urgent|asap|stuck|error|failed|fix|why|where|when|what|how|follow up|follow-up)\b)/iu;

// ---------------------------------------------------------------------------
// ChatManager
// ---------------------------------------------------------------------------

export class ChatManager implements ChatManagerLike {
  private readonly ctx: ChatManagerContext;
  private readonly retentionDialogs = new Map<string, RetentionDialogState>();
  private readonly systemDocContextState = createSystemDocContextState();
  private readonly linkedOwnerIdentityState = createLinkedOwnerIdentityState();
  constructor(ctx: ChatManagerContext) { this.ctx = ctx; }

  private logChatRuntime(
    level: "log" | "warn",
    event: string,
    details?: Record<string, unknown>,
  ): void {
    const logger = level === "warn" ? console.warn : console.log;
    if (!details || Object.keys(details).length === 0) {
      logger(`[agent-chat] ${event}`);
      return;
    }
    try {
      logger(`[agent-chat] ${event} ${JSON.stringify(details)}`);
    } catch {
      logger(`[agent-chat] ${event}`);
    }
  }

  async pollInbox(): Promise<void> {
    if (!this.ctx.config.chatRuntimeEnabled || this.ctx.chat.chatInboxPollInFlight) return;
    this.ctx.chat.chatInboxPollInFlight = true;
    try {
      await this.initializeCursor();
      const lines = await this.readDeltaLines();
      let staleReplySkippedCount = 0;
      for (const line of lines) {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        const entry = normalizeInboxEntry(parsed);
        if (!entry) continue;
        if (this.ctx.chat.chatSeenMessageIds.has(entry.messageId)) continue;
        this.rememberSeenMessageId(entry.messageId);
        void this.ctx.memory.recordWrite({
          type: entry.commandKind !== "none" ? "chat_runtime_command_received" : "chat_runtime_interaction_received",
          at: entry.receivedAt, messageId: entry.messageId, conversationId: entry.conversationId,
          channelId: entry.channelId, commandKind: entry.commandKind, authorHandle: entry.authorHandle,
          bodyPreview: toAnswerPreview(entry.body, 160),
        }).catch(() => undefined);
        this.logChatRuntime("log", "inbox_received", {
          messageId: entry.messageId,
          conversationId: entry.conversationId,
          channelId: entry.channelId,
          authorHandle: entry.authorHandle || null,
          authorMainUserId: entry.authorMainUserId,
          bodyPreview: toAnswerPreview(entry.body, 120),
        });
        const mentionTokens = await this.resolveMentionTokens();
        if (!shouldReplyToChatInboxEntry(entry, { channelRequireMention: this.ctx.config.chatRuntimeChannelRequireMention, mentionTokens })) {
          void this.ctx.memory.recordWrite({
            type: "chat_runtime_reply_skipped",
            at: nowIso(),
            reason: entry.authorIsAgent ? "author_is_agent"
              : entry.commandKind !== "none" ? "command_kind_not_none"
              : (entry.serverIntentActionFamily && entry.serverIntentActionFamily !== "conversation") ? "server_intent_non_conversation"
              : entry.channelId ? "channel_mention_not_matched"
              : "should_reply_check_failed",
            messageId: entry.messageId,
            conversationId: entry.conversationId,
            channelId: entry.channelId,
            authorHandle: entry.authorHandle,
            serverIntentActionFamily: entry.serverIntentActionFamily,
            commandKind: entry.commandKind,
            bodyPreview: toAnswerPreview(entry.body, 140),
          }).catch(() => undefined);
          continue;
        }
        const staleDecision = this.evaluateStaleReplyDecision(entry);
        if (staleDecision.skipReply) {
          staleReplySkippedCount += 1;
          void this.ctx.memory
            .recordWrite({
              type: "chat_runtime_stale_reply_skipped",
              at: nowIso(),
              messageId: entry.messageId,
              conversationId: entry.conversationId,
              channelId: entry.channelId,
              eventType: entry.eventType,
              reason: staleDecision.reason,
              ageMs: staleDecision.ageMs,
              important: staleDecision.important,
              bodyPreview: toAnswerPreview(entry.body, 180),
            })
            .catch(() => undefined);
          continue;
        }
        if (staleDecision.reason === "stale_important_allowed") {
          void this.ctx.memory
            .recordWrite({
              type: "chat_runtime_stale_reply_allowed",
              at: nowIso(),
              messageId: entry.messageId,
              conversationId: entry.conversationId,
              channelId: entry.channelId,
              ageMs: staleDecision.ageMs,
              important: true,
            })
            .catch(() => undefined);
        }
        let typingSent = false;
        try {
          await this.setTyping(entry, true).catch(() => undefined);
          typingSent = true;
          const retentionReply = await this.handleRetentionPolicyDialog(entry);
          if (retentionReply) {
            await this.sendReply(entry, retentionReply).catch(() => undefined);
            this.ctx.chat.chatReplyThrottleUntilMs = Date.now() + this.ctx.config.chatRuntimeReplyThrottleMs;
            void this.ctx.memory
              .recordWrite({
                type: "chat_runtime_retention_dialog_reply",
                at: nowIso(),
                messageId: entry.messageId,
                conversationId: entry.conversationId,
                channelId: entry.channelId,
                replyPreview: toAnswerPreview(retentionReply, 220),
              })
              .catch(() => undefined);
            continue;
          }
          const deterministicRouteEnabled = false;
          if (deterministicRouteEnabled) {
            const deterministicRouteReply =
              await this.handleDeterministicRouteAction(entry);
            if (deterministicRouteReply) {
              await this.sendReply(entry, deterministicRouteReply).catch(() => undefined);
              this.ctx.chat.chatReplyThrottleUntilMs = Date.now() + this.ctx.config.chatRuntimeReplyThrottleMs;
              void this.ctx.memory
                .recordWrite({
                  type: "chat_runtime_route_action_reply_sent",
                  at: nowIso(),
                  messageId: entry.messageId,
                  conversationId: entry.conversationId,
                  channelId: entry.channelId,
                  replyPreview: toAnswerPreview(deterministicRouteReply, 220),
                })
                .catch(() => undefined);
              continue;
            }
          }
          const shouldStream = this.ctx.config.chatRuntimeTextStreamEnabled && this.ctx.config.chatRuntimeUseOpenClaw;
          const streamState = shouldStream ? this.createStreamState(entry) : null;
          const replyBody = await buildAutoReply(entry, {
            maxChars: this.ctx.config.chatRuntimeReplyMaxChars,
            useOpenClaw: this.ctx.config.chatRuntimeUseOpenClaw,
            recordWrite: (p) => this.ctx.memory.recordWrite(p),
            runOpenClawPrompt: (o) => this.ctx.runOpenClawPrompt(o),
            fetchConversationHistory: (e) => this.fetchConversationHistory(e),
            loadDrilldownContext: (e, conversationHistory) =>
              this.loadDrilldownContext(e, conversationHistory),
            reportSystemProbe: ({ entry: flaggedEntry, reason }) =>
              this.reportSystemProbe(flaggedEntry, reason),
          });
          if (!replyBody.length) {
            void this.ctx.memory
              .recordWrite({
                type: "chat_runtime_auto_reply_suppressed",
                at: nowIso(),
                messageId: entry.messageId,
                conversationId: entry.conversationId,
                channelId: entry.channelId,
                reason: "empty_llm_reply",
                bodyPreview: toAnswerPreview(entry.body, 140),
              })
              .catch(() => undefined);
            this.logChatRuntime("warn", "auto_reply_suppressed", {
              reason: "empty_llm_reply",
              messageId: entry.messageId,
              conversationId: entry.conversationId,
              channelId: entry.channelId,
              bodyPreview: toAnswerPreview(entry.body, 120),
            });
            continue;
          }
          const nowMs = Date.now();
          if (this.ctx.chat.chatReplyThrottleUntilMs > nowMs) await sleep(this.ctx.chat.chatReplyThrottleUntilMs - nowMs);
          if (streamState) {
            // Do not emit partial placeholder edits unless native streaming actually
            // provided deltas. Partial writes can get stuck if finalization fails.
            let finalized = await this.finalizeStream(streamState, replyBody);
            if (!finalized && typeof streamState.messageId === "string" && streamState.messageId.trim().length > 0) {
              const normalized = truncateChatReply(replyBody, this.ctx.config.chatRuntimeReplyMaxChars);
              try { await this.editMessage(streamState.messageId, normalized); streamState.currentBody = normalized; streamState.lastUpdateAtMs = Date.now(); finalized = true; } catch { finalized = streamState.currentBody === normalized; }
            }
            if (!finalized && !streamState.messageId?.trim().length) {
              await this.sendReply(entry, replyBody);
            }
          } else {
            await this.sendReply(entry, replyBody);
          }
          this.ctx.chat.chatReplyThrottleUntilMs = Date.now() + this.ctx.config.chatRuntimeReplyThrottleMs;
          void this.ctx.memory.recordWrite({
            type: "chat_runtime_auto_reply_sent", at: nowIso(), messageId: entry.messageId,
            conversationId: entry.conversationId, channelId: entry.channelId, eventType: entry.eventType,
            sourceContext: "CHAT", topic: entry.topic, replyPreview: toAnswerPreview(replyBody, 220),
            replyStreamed: Boolean(streamState), replyStreamNative: Boolean(streamState) && (streamState?.nativeDeltaChars ?? 0) > 0,
          }).catch(() => undefined);
          this.logChatRuntime("log", "auto_reply_sent", {
            messageId: entry.messageId,
            conversationId: entry.conversationId,
            channelId: entry.channelId,
            replyPreview: toAnswerPreview(replyBody, 160),
            replyStreamed: Boolean(streamState),
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          void this.ctx.memory.recordWrite({
            type: "chat_runtime_auto_reply_failed",
            at: nowIso(),
            message,
            messageId: entry.messageId,
            conversationId: entry.conversationId,
            channelId: entry.channelId,
            bodyPreview: toAnswerPreview(entry.body, 140),
          }).catch(() => undefined);
          this.logChatRuntime("warn", "auto_reply_failed", {
            messageId: entry.messageId,
            conversationId: entry.conversationId,
            channelId: entry.channelId,
            error: toAnswerPreview(message, 220),
            bodyPreview: toAnswerPreview(entry.body, 120),
          });
          const failureReply = truncateChatReply(
            "I hit a snag handling that right now. Please try again in a moment.",
            this.ctx.config.chatRuntimeReplyMaxChars,
          );
          if (failureReply.length > 0) {
            // Retry once after a short delay if the first attempt fails, to
            // handle transient bridge hiccups that would otherwise leave the
            // user with typing-then-nothing.
            const sent = await this.sendReply(entry, failureReply).catch(() => null);
            if (sent === null) {
              await sleep(500);
              await this.sendReply(entry, failureReply).catch(() => undefined);
            }
            this.ctx.chat.chatReplyThrottleUntilMs = Date.now() + this.ctx.config.chatRuntimeReplyThrottleMs;
            void this.ctx.memory.recordWrite({
              type: "chat_runtime_auto_reply_error_sent",
              at: nowIso(),
              messageId: entry.messageId,
              conversationId: entry.conversationId,
              channelId: entry.channelId,
              error: toAnswerPreview(message, 220),
            }).catch(() => undefined);
          }
        } finally {
          if (typingSent) void this.setTyping(entry, false).catch(() => undefined);
          void this.ctx
            .runMemoryCheckpoint({
              force: false,
              source: "chat_runtime_interaction",
              allowAgentCompression: false,
            })
            .catch(() => undefined);
        }
      }
      if (staleReplySkippedCount > 0) {
        await this.ctx
          .runMemoryCheckpoint({
            force: false,
            source: "chat_runtime_stale_ingest",
            allowAgentCompression: true,
          })
          .catch(() => undefined);
      }
      await this.persistState("poll");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.ctx.memory.recordWrite({ type: "chat_runtime_auto_reply_failed", at: nowIso(), message });
      this.logChatRuntime("warn", "poll_failed", {
        error: toAnswerPreview(message, 220),
      });
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
      const savedOffset =
        state && typeof state.readOffset === "number" && Number.isFinite(state.readOffset)
          ? Math.max(0, Math.floor(state.readOffset))
          : null;
      this.ctx.chat.chatInboxReadOffset = savedOffset === null ? fileBytes : Math.min(savedOffset, fileBytes);
      this.ctx.chat.chatInboxPartialLine =
        state && typeof state.partialLine === "string" && state.partialLine.length <= 4096
          ? state.partialLine
          : "";
    }
    if (state && Array.isArray(state.seenMessageIds)) {
      for (const entry of state.seenMessageIds) {
        if (typeof entry === "string" && entry.trim().length > 0) this.rememberSeenMessageId(entry.trim());
      }
    }
    if (state && Array.isArray(state.retentionDialogs)) {
      this.retentionDialogs.clear();
      for (const entry of state.retentionDialogs) {
        const parsed = parseRetentionDialogState(entry);
        if (!parsed) continue;
        this.retentionDialogs.set(parsed.key, parsed);
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
  // Private: stale reply policy
  // -----------------------------------------------------------------------

  private evaluateStaleReplyDecision(entry: ChatInboxEntry): StaleReplyDecision {
    const receivedAtMs = this.parseEntryTimestampMs(entry.receivedAt);
    if (receivedAtMs === null) {
      return {
        skipReply: false,
        ageMs: null,
        important: false,
        reason: "invalid_timestamp",
      };
    }
    const ageMs = Date.now() - receivedAtMs;
    if (ageMs <= this.ctx.config.chatRuntimeStaleReplyMaxAgeMs) {
      return {
        skipReply: false,
        ageMs,
        important: false,
        reason: "fresh",
      };
    }
    const important = this.isImportantMissedMessage(entry);
    if (!important) {
      return {
        skipReply: true,
        ageMs,
        important: false,
        reason: "stale_not_important",
      };
    }
    if (ageMs > this.ctx.config.chatRuntimeStaleReplyMaxAgeImportantMs) {
      return {
        skipReply: true,
        ageMs,
        important: true,
        reason: "stale_important_expired",
      };
    }
    return {
      skipReply: false,
      ageMs,
      important: true,
      reason: "stale_important_allowed",
    };
  }

  private parseEntryTimestampMs(value: string): number | null {
    const raw = value.trim();
    if (!raw.length) return null;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) return null;
    return ms;
  }

  private isImportantMissedMessage(entry: ChatInboxEntry): boolean {
    const body = entry.body.trim();
    if (!body.length) return false;
    const bodyLower = body.toLowerCase();
    if (STALE_IMPORTANT_PATTERN.test(bodyLower)) return true;
    if (entry.channelId && bodyLower.includes("@")) return true;
    if (
      entry.serverIntentActionFamily === "conversation" &&
      typeof entry.serverIntentConfidence === "string" &&
      entry.serverIntentConfidence === "high"
    ) {
      return true;
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Private: send / edit / typing
  // -----------------------------------------------------------------------

  private async sendReply(entry: ChatInboxEntry, body: string): Promise<unknown> {
    const trimmedBody = truncateChatReply(
      stripEmDashCharacters(body),
      this.ctx.config.chatRuntimeReplyMaxChars,
    );
    if (!trimmedBody.length || /^(?:\u2026+|\.{3,})$/u.test(trimmedBody)) return null;
    const routeScope = entry.conversationId ?? entry.channelId ?? "";
    const clientMessageId = `runtime_chat_reply_${crypto
      .createHash("sha256")
      .update(`${entry.messageId}:${routeScope}`)
      .digest("hex")
      .slice(0, 28)}`;
    return this.ctx.callAgentChatBridge({
      action: "send_message",
      clientMessageId,
      body: trimmedBody, format: "markdown", replyToMessageId: entry.messageId,
      ...(entry.conversationId ? { conversationId: entry.conversationId } : { channelId: entry.channelId }),
    });
  }

  private async editMessage(messageId: string, body: string): Promise<unknown> {
    const trimmedBody = truncateChatReply(
      stripEmDashCharacters(body),
      this.ctx.config.chatRuntimeReplyMaxChars,
    );
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
    const nextBody = truncateChatReply(
      stripEmDashCharacters(state.targetBody),
      this.ctx.config.chatRuntimeReplyMaxChars,
    );
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

  private async finalizeStream(state: StreamState, finalBody: string): Promise<boolean> {
    const normalized = truncateChatReply(finalBody, this.ctx.config.chatRuntimeReplyMaxChars);
    if (!normalized.length) return false;
    state.targetBody = normalized;
    await this.flushStream(state, { force: true }).catch(() => undefined);
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
      retentionDialogs: [...this.retentionDialogs.values()],
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

  private resolveReplyTargetContext(
    entry: ChatInboxEntry,
    conversationHistory: unknown[],
  ): ReplyTargetContext | null {
    return _resolveReplyTargetContext(entry, conversationHistory);
  }

  private async fetchConversationHistory(entry: ChatInboxEntry): Promise<unknown[]> {
    return _fetchConversationHistory(
      { callAgentChatBridge: (payload) => this.ctx.callAgentChatBridge(payload) },
      entry,
    );
  }

  private async reportSystemProbe(
    entry: ChatInboxEntry,
    reason:
      | "system_disclosure_request_blocked"
      | "system_disclosure_reply_blocked",
  ): Promise<void> {
    return _reportSystemProbe(
      {
        callAgentChatBridge: (payload) => this.ctx.callAgentChatBridge(payload),
        recordWrite: (payload) => this.ctx.memory.recordWrite(payload),
      },
      { entry, reason },
    );
  }

  private async handleRetentionPolicyDialog(
    entry: ChatInboxEntry,
  ): Promise<string | null> {
    return _handleRetentionPolicyDialog(
      {
        retentionDialogs: this.retentionDialogs,
        markStateDirty: () => {
          this.ctx.chat.chatRuntimeStateDirty = true;
        },
        recordWrite: (payload) => this.ctx.memory.recordWrite(payload),
      },
      entry,
    );
  }

  private async handleDeterministicRouteAction(
    entry: ChatInboxEntry,
  ): Promise<string | null> {
    return _handleDeterministicRouteAction(
      {
        recordWrite: (payload) => this.ctx.memory.recordWrite(payload),
        callAgentChatBridge: (payload) => this.ctx.callAgentChatBridge(payload),
        replyMaxChars: this.ctx.config.chatRuntimeReplyMaxChars,
        loadLinkedOwnerIdentity: () => this.loadLinkedOwnerIdentity(),
      },
      entry,
    );
  }

  private async loadDrilldownContext(
    entry: ChatInboxEntry,
    conversationHistory: unknown[],
  ): Promise<string | null> {
    return _loadDrilldownContext(
      {
        buildContext: this.ctx.memory.buildContext,
        openClawInputMaxChars: this.ctx.config.chatRuntimeOpenClawInputMaxChars,
        resolveReplyTargetContext: (chatEntry, history) =>
          this.resolveReplyTargetContext(chatEntry, history),
        loadLiveSiteLookup: (input) => this.loadLiveSiteLookup(input),
        loadSystemDocContext: () => this.loadSystemDocContext(),
        loadLinkedOwnerIdentity: () => this.loadLinkedOwnerIdentity(),
      },
      entry,
      conversationHistory,
    );
  }

  private async loadSystemDocContext(): Promise<string | null> {
    return _loadSystemDocContext(this.systemDocContextState);
  }

  private async loadLinkedOwnerIdentity() {
    return _loadLinkedOwnerIdentity(
      { callAgentChatBridge: (payload) => this.ctx.callAgentChatBridge(payload) },
      this.linkedOwnerIdentityState,
    );
  }

  private shouldRunLiveSiteLookup(input: LiveSiteLookupInput): boolean {
    return _shouldRunLiveSiteLookup(input);
  }

  private async loadLiveSiteLookup(input: LiveSiteLookupInput): Promise<string[]> {
    return _loadLiveSiteLookup(
      {
        recordWrite: (payload) => this.ctx.memory.recordWrite(payload),
        callAgentChatBridge: (payload) => this.ctx.callAgentChatBridge(payload),
      },
      input,
    );
  }
}
