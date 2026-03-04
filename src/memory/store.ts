/** MemoryStore -- central persistence layer. Ported from agent-runtime.mjs lines 1658-2755. */

import fs from "node:fs/promises";
import path from "node:path";
import type {
  MemoryStoreConfig,
  MemoryEnvelope,
  StreamName,
  StreamPathMap,
  ViewState,
  MoodState,
  TemporalContext,
  ContextRequest,
  ContextBundle,
  RetentionCleanupResult,
  RefreshTemporalOptions,
  LongTermArchiveIndex,
  ArchiveCompressFn,
} from "~/types/memory.js";
import type { KthxRetentionConfig } from "~/types/config.js";
import type { StateSqliteStore } from "~/state/sqlite-state.js";
import { isRecord } from "~/lib/guards.js";
import { ensureDir, readJsonFile, writeJsonFile, appendJsonLine } from "~/lib/fs-helpers.js";
import { normalizeIso, unique } from "~/lib/time.js";
import { nowIso } from "~/lib/text.js";
import { extractKeysFromPayload } from "./extract.js";
import { archiveJsonl, createArchiveBasename } from "./archive.js";
import { defaultMoodState, computeMoodDelta, applyMoodSignal } from "./mood.js";
import { defaultTemporalContext } from "./temporal.js";
import { renderContextPrompt } from "./render.js";
import { runRetentionCleanup } from "./retention.js";
import {
  buildRetrievalSummary as _buildRetrievalSummary,
  buildViewSummary as _buildViewSummary,
} from "./store-context-builders.js";
import {
  buildKeywordDocForEnvelope as _buildKeywordDocForEnvelope,
  compactArchiveIndexToLongTerm as _compactArchiveIndexToLongTerm,
  deriveMemoryActivity as _deriveMemoryActivity,
  getLongTermCapsuleId as _getLongTermCapsuleId,
  runLongTermCompaction as _runLongTermCompaction,
  upsertLongTermArchiveCapsule as _upsertLongTermArchiveCapsule,
} from "./store-runtime-ops.js";
import {
  buildContext as _buildContext,
  readArchiveContext as _readArchiveContext,
  readArchiveWindow as _readArchiveWindow,
  readRecentEnvelopes as _readRecentEnvelopes,
  refreshTemporalContextCore as _refreshTemporalContextCore,
} from "./store-context-runtime.js";
import type { KeywordIndexDoc, KeywordMemoryIndex } from "./store-helpers.js";
import {
  buildRetentionStreamDaysMap,
  normalizeKeywordIndex,
  normalizeLongTermArchiveIndex,
  normalizeViewState,
} from "./store-helpers.js";
import {
  resolveViewStateEntity as _resolveViewStateEntity,
  upsertKeywordDoc as _upsertKeywordDoc,
  upsertViewStateItem as _upsertViewStateItem,
} from "./store-index-mutations.js";

export class MemoryStore {
  readonly stateDir: string;
  readonly rotateBytes: number;
  readonly tailMaxBytes: number;
  readonly tailMaxLines: number;
  readonly streamPaths: StreamPathMap;
  readonly stateDb: StateSqliteStore | null;

  private readonly viewStatePath: string;
  private viewState: ViewState;
  private viewStateDirty: boolean;
  private viewStateWriteTimer: ReturnType<typeof setTimeout> | null;
  private viewStateMutationCount: number;
  private readonly keywordIndexPath: string;
  private keywordIndex: KeywordMemoryIndex;
  private keywordIndexDirty: boolean;
  private keywordIndexWriteTimer: ReturnType<typeof setTimeout> | null;
  private keywordIndexMutationCount: number;
  private readonly longTermArchiveIndexPath: string;
  private longTermArchiveIndex: LongTermArchiveIndex;
  private longTermArchiveDirty: boolean;
  private longTermArchiveWriteTimer: ReturnType<typeof setTimeout> | null;

  private readonly memoryDir: string;
  private readonly memoryContextDir: string;
  private readonly moodStatePath: string;
  private readonly temporalContextPath: string;
  private readonly temporalTierPaths: Record<string, string>;

  moodState: MoodState;
  private moodDirty: boolean;
  private moodWriteTimer: ReturnType<typeof setTimeout> | null;

  temporalContext: TemporalContext;
  private temporalDirty: boolean;
  private temporalWriteTimer: ReturnType<typeof setTimeout> | null;
  private temporalRefreshInFlight: Promise<TemporalContext> | null;
  private lastContextReadAtMs: number;

  constructor(config: MemoryStoreConfig) {
    this.stateDir = config.stateDir;
    this.rotateBytes = config.rotateBytes;
    this.tailMaxBytes = config.tailMaxBytes;
    this.tailMaxLines = config.tailMaxLines;
    this.stateDb = config.stateDb ?? null;

    this.streamPaths = {
      director: path.join(this.stateDir, "director.jsonl"),
      notifications: path.join(this.stateDir, "notifications.jsonl"),
      feed: path.join(this.stateDir, "feed.jsonl"),
      activity: path.join(this.stateDir, "activity.jsonl"),
      memory_activity: path.join(this.stateDir, "memory-activity.jsonl"),
      likes: path.join(this.stateDir, "likes.jsonl"),
      reposts: path.join(this.stateDir, "reposts.jsonl"),
      comments: path.join(this.stateDir, "comments.jsonl"),
      views: path.join(this.stateDir, "views.jsonl"),
      tags: path.join(this.stateDir, "tags.jsonl"),
      story_replies: path.join(this.stateDir, "story_replies.jsonl"),
      writes: path.join(this.stateDir, "writes.jsonl"),
      errors: path.join(this.stateDir, "errors.jsonl"),
    };

    this.viewStatePath = path.join(this.stateDir, "view-state.json");
    this.viewState = { version: 1, updatedAt: new Date(0).toISOString(), items: {} };
    this.viewStateDirty = false;
    this.viewStateWriteTimer = null;
    this.viewStateMutationCount = 0;

    this.memoryDir = path.join(this.stateDir, "memory");
    this.memoryContextDir = path.join(this.memoryDir, "context");
    this.moodStatePath = path.join(this.memoryDir, "mood.json");
    this.temporalContextPath = path.join(this.memoryContextDir, "temporal.json");
    this.keywordIndexPath = path.join(this.memoryContextDir, "keyword-index.json");
    this.longTermArchiveIndexPath = path.join(
      this.memoryContextDir,
      "long-term-archive-index.json",
    );
    this.temporalTierPaths = {
      "24h": path.join(this.memoryContextDir, "24h.json"),
      "7d": path.join(this.memoryContextDir, "7d.json"),
      "30d": path.join(this.memoryContextDir, "30d.json"),
      "365d": path.join(this.memoryContextDir, "365d.json"),
    };
    this.keywordIndex = { version: 1, updatedAt: new Date(0).toISOString(), docs: {}, inverted: {} };
    this.keywordIndexDirty = false;
    this.keywordIndexWriteTimer = null;
    this.keywordIndexMutationCount = 0;
    this.longTermArchiveIndex = {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      items: [],
    };
    this.longTermArchiveDirty = false;
    this.longTermArchiveWriteTimer = null;

    this.moodState = defaultMoodState();
    this.moodDirty = false;
    this.moodWriteTimer = null;
    this.temporalContext = defaultTemporalContext();
    this.temporalDirty = false;
    this.temporalWriteTimer = null;
    this.temporalRefreshInFlight = null;
    this.lastContextReadAtMs = 0;
  }

  // ---- init ---------------------------------------------------------------

  async init(): Promise<void> {
    this.stateDb?.init();
    await ensureDir(this.stateDir);
    await ensureDir(this.memoryDir);
    await ensureDir(this.memoryContextDir);

    const existing = await readJsonFile(this.viewStatePath);
    this.viewState = normalizeViewState(existing);
    const keywordExisting = await readJsonFile(this.keywordIndexPath);
    this.keywordIndex = normalizeKeywordIndex(keywordExisting);
    const longTermExisting = await readJsonFile(this.longTermArchiveIndexPath);
    this.longTermArchiveIndex = normalizeLongTermArchiveIndex(longTermExisting);
    const moodExisting = await readJsonFile(this.moodStatePath);
    if (isRecord(moodExisting) && moodExisting.version === 1) {
      this.moodState = { ...defaultMoodState(), ...(moodExisting as MoodState) };
    }
    const temporalExisting = await readJsonFile(this.temporalContextPath);
    if (isRecord(temporalExisting) && temporalExisting.version === 1 && isRecord(temporalExisting.tiers)) {
      this.temporalContext = {
        ...defaultTemporalContext(),
        ...(temporalExisting as TemporalContext),
        tiers: { ...defaultTemporalContext().tiers, ...((temporalExisting as TemporalContext).tiers ?? {}) },
      };
    }

    await Promise.all(
      Object.values(this.streamPaths).map(async (filePath) => {
        await ensureDir(path.dirname(filePath));
        await fs.access(filePath).catch(async () => { await fs.writeFile(filePath, "", "utf8"); });
      }),
    );
    await fs.access(this.moodStatePath).catch(async () => { await writeJsonFile(this.moodStatePath, this.moodState); });
    await fs.access(this.temporalContextPath).catch(async () => { await writeJsonFile(this.temporalContextPath, this.temporalContext); });
    await fs.access(this.keywordIndexPath).catch(async () => { await writeJsonFile(this.keywordIndexPath, this.keywordIndex); });
    await fs
      .access(this.longTermArchiveIndexPath)
      .catch(async () => {
        await writeJsonFile(
          this.longTermArchiveIndexPath,
          this.longTermArchiveIndex,
        );
      });
    await Promise.all(
      Object.entries(this.temporalTierPaths).map(async ([tier, filePath]) => {
        await fs.access(filePath).catch(async () => {
          await writeJsonFile(filePath, { version: 1, tier, updatedAt: new Date(0).toISOString(), bullets: [] });
        });
      }),
    );
  }

  // ---- flush helpers ------------------------------------------------------

  private scheduleViewStateWrite(): void {
    if (this.viewStateWriteTimer) return;
    this.viewStateWriteTimer = setTimeout(() => {
      this.viewStateWriteTimer = null;
      void this.flushViewState().catch(() => undefined);
    }, 250);
  }

  async flushViewState(): Promise<void> {
    if (!this.viewStateDirty) return;
    this.viewState.updatedAt = nowIso();
    await writeJsonFile(this.viewStatePath, this.viewState);
    this.stateDb?.upsertSnapshot({
      scope: "memory.view_state",
      visibility: "private",
      at: this.viewState.updatedAt,
      data: this.viewState,
    });
    this.viewStateDirty = false;
  }

  private scheduleKeywordIndexWrite(): void {
    if (this.keywordIndexWriteTimer) return;
    this.keywordIndexWriteTimer = setTimeout(() => {
      this.keywordIndexWriteTimer = null;
      void this.flushKeywordIndex().catch(() => undefined);
    }, 400);
  }

  async flushKeywordIndex(): Promise<void> {
    if (!this.keywordIndexDirty) return;
    this.keywordIndex.updatedAt = nowIso();
    await writeJsonFile(this.keywordIndexPath, this.keywordIndex);
    this.stateDb?.upsertSnapshot({
      scope: "memory.keyword_index",
      visibility: "private",
      at: this.keywordIndex.updatedAt,
      data: {
        version: 1,
        updatedAt: this.keywordIndex.updatedAt,
        docs: Object.keys(this.keywordIndex.docs).length,
        keywords: Object.keys(this.keywordIndex.inverted).length,
      },
    });
    this.keywordIndexDirty = false;
  }

  private scheduleLongTermArchiveWrite(): void {
    if (this.longTermArchiveWriteTimer) return;
    this.longTermArchiveWriteTimer = setTimeout(() => {
      this.longTermArchiveWriteTimer = null;
      void this.flushLongTermArchiveIndex().catch(() => undefined);
    }, 600);
  }

  async flushLongTermArchiveIndex(): Promise<void> {
    if (!this.longTermArchiveDirty) return;
    this.longTermArchiveIndex.updatedAt = nowIso();
    await writeJsonFile(this.longTermArchiveIndexPath, this.longTermArchiveIndex);
    this.stateDb?.upsertSnapshot({
      scope: "memory.long_term_archive_index",
      visibility: "private",
      at: this.longTermArchiveIndex.updatedAt,
      data: {
        version: 1,
        updatedAt: this.longTermArchiveIndex.updatedAt,
        items: this.longTermArchiveIndex.items.length,
        latestCompactedAt:
          this.longTermArchiveIndex.items[0]?.compactedAt ?? null,
      },
    });
    this.longTermArchiveDirty = false;
  }

  private scheduleMoodStateWrite(): void {
    if (this.moodWriteTimer) return;
    this.moodWriteTimer = setTimeout(() => {
      this.moodWriteTimer = null;
      void this.flushMoodState().catch(() => undefined);
    }, 300);
  }

  async flushMoodState(): Promise<void> {
    if (!this.moodDirty) return;
    this.moodState.updatedAt = nowIso();
    await writeJsonFile(this.moodStatePath, this.moodState);
    this.stateDb?.upsertSnapshot({
      scope: "memory.mood_state",
      visibility: "private",
      at: this.moodState.updatedAt,
      data: this.moodState,
    });
    this.moodDirty = false;
  }

  private scheduleTemporalContextWrite(): void {
    if (this.temporalWriteTimer) return;
    this.temporalWriteTimer = setTimeout(() => {
      this.temporalWriteTimer = null;
      void this.flushTemporalContext().catch(() => undefined);
    }, 350);
  }

  async flushTemporalContext(): Promise<void> {
    if (!this.temporalDirty) return;
    this.temporalContext.updatedAt = nowIso();
    await writeJsonFile(this.temporalContextPath, this.temporalContext);
    await Promise.all(
      Object.entries(this.temporalTierPaths).map(async ([tier, filePath]) => {
        const tierPayload = isRecord(this.temporalContext.tiers?.[tier])
          ? this.temporalContext.tiers[tier]
          : { version: 1, tier, updatedAt: nowIso(), bullets: [] };
        await writeJsonFile(filePath, tierPayload);
      }),
    );
    this.stateDb?.upsertSnapshot({
      scope: "memory.temporal_context",
      visibility: "private",
      at: this.temporalContext.updatedAt,
      data: this.temporalContext,
    });
    this.temporalDirty = false;
  }

  // ---- rotation -----------------------------------------------------------

  async maybeRotate(stream: StreamName): Promise<void> {
    const activePath = this.streamPaths[stream];
    const stat = await fs.stat(activePath).catch(() => null);
    if (!stat || stat.size < this.rotateBytes) return;
    await archiveJsonl({ stream, stateDir: this.stateDir, activePath, archiveBasename: createArchiveBasename() });
  }

  getMoodSnapshot(): MoodState {
    return isRecord(this.moodState) ? this.moodState : defaultMoodState();
  }

  private upsertViewStateItem(input: {
    key: string;
    status: "unviewed" | "viewed";
    receivedAt: string;
    postId: number | null;
    commentId: number | null;
    sourceType: string | null;
    topic: string | null;
  }): { created: boolean } {
    const result = _upsertViewStateItem({
      viewState: this.viewState,
      viewStateMutationCount: this.viewStateMutationCount,
      ...input,
    });
    this.viewStateMutationCount = result.mutationCount;
    this.viewStateDirty = true;
    this.scheduleViewStateWrite();
    return { created: result.created };
  }

  private upsertKeywordDoc(doc: KeywordIndexDoc): void {
    const result = _upsertKeywordDoc({
      keywordIndex: this.keywordIndex,
      keywordIndexMutationCount: this.keywordIndexMutationCount,
      doc,
    });
    this.keywordIndexMutationCount = result.mutationCount;
    this.keywordIndexDirty = true;
    this.scheduleKeywordIndexWrite();
  }

  // ---- ingest -------------------------------------------------------------

  async ingest(envelope: MemoryEnvelope): Promise<void> {
    const keys = extractKeysFromPayload(envelope.payload);
    const type = keys.type;
    const activityRecord = _deriveMemoryActivity(envelope, keys);
    this.stateDb?.appendEvent({
      source: envelope.source,
      topic: envelope.topic,
      eventType: type ?? "unknown",
      visibility: "private",
      at: envelope.receivedAt,
      payload: envelope,
    });

    const shouldIndexForRetrieval =
      type === "post_created" ||
      type === "post_comment" ||
      type === "post_like" ||
      type === "post_repost" ||
      type === "post_view" ||
      type === "notification_created" ||
      type === "story_reply" ||
      type === "chat_runtime_site_lookup" ||
      envelope.source !== "local";
    if (shouldIndexForRetrieval) {
      const keywordDoc = _buildKeywordDocForEnvelope(envelope, keys);
      if (keywordDoc) {
        this.upsertKeywordDoc(keywordDoc);
      }
    }

    const streams: StreamName[] = [];
    if (type === "director_grant") streams.push("director");
    else if (type === "notification_created") streams.push("notifications");
    else if (type === "post_created") streams.push("feed");
    else if (type === "post_like") streams.push("likes", "activity");
    else if (type === "post_repost") streams.push("reposts", "activity");
    else if (type === "post_comment") streams.push("comments", "activity");
    else if (type === "post_view") streams.push("views", "activity");
    else streams.push(envelope.source === "local" ? "writes" : "errors");

    await Promise.all(unique(streams).map(async (stream) => {
      await appendJsonLine(this.streamPaths[stream], envelope);
      await this.maybeRotate(stream);
    }));

    await appendJsonLine(this.streamPaths.memory_activity, {
      receivedAt: envelope.receivedAt, source: "local", topic: "derived:memory_activity", payload: activityRecord,
    });
    await this.maybeRotate("memory_activity");

    const moodSignal = computeMoodDelta(envelope, keys);
    if (moodSignal.delta !== 0 || activityRecord.activityType === "read" || activityRecord.activityType === "comment" || activityRecord.activityType === "publish_result") {
      this.moodState = applyMoodSignal(this.moodState, { delta: moodSignal.delta, reason: moodSignal.reason, at: envelope.receivedAt, activityType: activityRecord.activityType });
      this.moodDirty = true;
      this.scheduleMoodStateWrite();
    }

    if (keys.postId && (keys.tags.length || keys.categories.length)) {
      await appendJsonLine(this.streamPaths.tags, { receivedAt: envelope.receivedAt, source: "local", topic: "derived:tags", payload: { postId: keys.postId, tags: keys.tags, categories: keys.categories, origin: envelope.topic } });
      await this.maybeRotate("tags");
    }

    const shouldTrackViewState =
      type === "post_created" ||
      type === "notification_created" ||
      type === "post_view" ||
      type === "post_like" ||
      type === "post_repost" ||
      type === "post_comment";
    const viewEntity = shouldTrackViewState
      ? _resolveViewStateEntity(keys)
      : null;
    if (viewEntity) {
      const viewStatus: "unviewed" | "viewed" =
        type === "post_created" || type === "notification_created"
          ? "unviewed"
          : "viewed";
      const { created } = this.upsertViewStateItem({
        key: viewEntity.key,
        status: viewStatus,
        receivedAt: envelope.receivedAt,
        postId: viewEntity.postId,
        commentId: viewEntity.commentId,
        sourceType: type,
        topic: envelope.topic,
      });
      if (created && viewStatus === "unviewed") {
        const receivedAt = normalizeIso(envelope.receivedAt);
        await appendJsonLine(this.streamPaths.views, {
          receivedAt,
          source: "local",
          topic: "derived:view_queue",
          payload: {
            postId: viewEntity.postId,
            commentId: viewEntity.commentId,
            status: "unviewed",
            receivedAt,
          },
        });
        await this.maybeRotate("views");
      }
    }

    const at = activityRecord.activityType;
    const shouldRefreshTemporalContext =
      at === "read" ||
      at === "comment" ||
      at === "publish_result" ||
      at === "directive_executed";
    if (shouldRefreshTemporalContext) {
      void this.refreshTemporalContext({
        force: false,
        allowAgentCompression: false,
      }).catch(() => undefined);
    }
  }

  async recordWrite(payload: unknown): Promise<void> {
    await this.ingest({ receivedAt: nowIso(), source: "local", topic: "agent_write", payload });
  }

  // ---- context ------------------------------------------------------------

  async buildContext(request: ContextRequest): Promise<ContextBundle> {
    return _buildContext(
      {
        stateDir: this.stateDir,
        lastContextReadAtMs: this.lastContextReadAtMs,
        setLastContextReadAtMs: (value) => { this.lastContextReadAtMs = value; },
        refreshTemporalContext: (options) => this.refreshTemporalContext(options),
        readRecentEnvelopes: (input) => _readRecentEnvelopes({ streamPaths: this.streamPaths, tailMaxBytes: this.tailMaxBytes }, input),
        readArchiveContext: (input) => _readArchiveContext({ stateDir: this.stateDir }, input),
        buildViewSummary: (req) => _buildViewSummary({ request: req, viewState: this.viewState }),
        buildRetrievalSummary: (req) => _buildRetrievalSummary({ request: req, keywordIndex: this.keywordIndex, longTermArchiveItems: this.longTermArchiveIndex.items }),
        getMoodSnapshot: () => this.getMoodSnapshot(),
        recordWrite: (payload) => this.recordWrite(payload),
        getTemporalContext: () => this.temporalContext,
      },
      request,
    );
  }

  renderContextPrompt(bundle: ContextBundle): string { return renderContextPrompt(bundle); }

  // ---- temporal refresh ---------------------------------------------------

  async refreshTemporalContext(options: RefreshTemporalOptions = {}): Promise<TemporalContext> {
    const { force = false, allowAgentCompression = false, agentCompressFn = null } = options;

    const run = async (): Promise<TemporalContext> => {
      return _refreshTemporalContextCore(
        {
          temporalContext: this.temporalContext,
          setTemporalContext: (value) => { this.temporalContext = value; },
          setTemporalDirty: (value) => { this.temporalDirty = value; },
          scheduleTemporalContextWrite: () => this.scheduleTemporalContextWrite(),
          readRecentEnvelopes: (input) => _readRecentEnvelopes({ streamPaths: this.streamPaths, tailMaxBytes: this.tailMaxBytes }, input),
          readArchiveWindow: (input) => {
            const readInput = typeof input.filter === "function" ? input : { maxAgeDays: input.maxAgeDays, maxEvents: input.maxEvents };
            return _readArchiveWindow({ stateDir: this.stateDir }, readInput);
          },
        },
        { force, allowAgentCompression, agentCompressFn },
      );
    };

    if (this.temporalRefreshInFlight) return this.temporalRefreshInFlight;
    this.temporalRefreshInFlight = run().finally(() => { this.temporalRefreshInFlight = null; });
    return this.temporalRefreshInFlight;
  }

  // ---- retention (delegated) ----------------------------------------------

  async runRetentionCleanup({
    retentionConfig,
    archiveCompressFn = null,
  }: {
    retentionConfig: KthxRetentionConfig;
    archiveCompressFn?: ArchiveCompressFn | null;
  }): Promise<RetentionCleanupResult | null> {
    const streamRetentionMap = buildRetentionStreamDaysMap(retentionConfig);
    const longTermOps = {
      stateDir: this.stateDir,
      longTermArchiveItems: this.longTermArchiveIndex.items,
      compactArchiveIndexToLongTerm: async (input: { stream: StreamName; index: import("~/types/memory.js").ArchiveIndex; retentionConfig: KthxRetentionConfig; archiveCompressFn: ArchiveCompressFn | null; }) =>
        _compactArchiveIndexToLongTerm(
          {
            stateDir: this.stateDir,
            longTermArchiveItems: this.longTermArchiveIndex.items,
            upsertLongTermArchiveCapsule: (capsule, maxCapsules) => {
              this.longTermArchiveIndex = _upsertLongTermArchiveCapsule({ longTermArchiveIndex: this.longTermArchiveIndex, capsule, maxCapsules });
              this.longTermArchiveDirty = true;
              this.scheduleLongTermArchiveWrite();
            },
          },
          input,
        ),
    };
    const { compactions, deletableArchiveIds } = await _runLongTermCompaction(longTermOps, { retentionConfig, streamRetentionMap, archiveCompressFn });

    const longTermEnabled = retentionConfig.longTerm.enabled === true;
    const { result, moodDirty, updatedMoodState } = await runRetentionCleanup({
      retentionConfig,
      streamPaths: this.streamPaths,
      tailMaxBytes: this.tailMaxBytes,
      stateDir: this.stateDir,
      moodState: this.moodState,
      streamRetentionMap,
      archiveDeleteGuard: ({ stream, index }) => {
        if (!longTermEnabled) return true;
        return deletableArchiveIds.has(_getLongTermCapsuleId(stream, index.archiveBasename));
      },
      longTermCompactions: compactions,
    });

    if (this.longTermArchiveDirty) {
      await this.flushLongTermArchiveIndex().catch(() => undefined);
    }
    if (moodDirty) {
      this.moodState = updatedMoodState;
      this.moodDirty = true;
      this.scheduleMoodStateWrite();
    }
    return result;
  }
}
