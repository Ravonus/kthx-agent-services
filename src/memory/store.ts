/** MemoryStore -- central persistence layer. Ported from agent-runtime.mjs lines 1658-2755. */

import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryStoreConfig, MemoryEnvelope, StreamName, StreamPathMap, ViewState, MoodState, TemporalContext, TierSummary, ContextRequest, ContextBundle, MemoryActivity, RetentionCleanupResult, RefreshTemporalOptions } from "~/types/memory.js";
import type { KthxRetentionConfig } from "~/types/config.js";
import { isRecord } from "~/lib/guards.js";
import { ensureDir, readJsonFile, writeJsonFile, appendJsonLine, readLastJsonLines } from "~/lib/fs-helpers.js";
import { nowIso, normalizeIso, toShortLine, unique } from "~/lib/time.js";
import { extractKeysFromPayload, extractActorHintFromPayload, extractTextHintFromPayload, parseMemoryEnvelope } from "./extract.js";
import { archiveJsonl, createArchiveBasename, listArchiveIndexes, findArchiveGzPath, readEventsFromGzArchive, pickWeightedArchiveBasenames } from "./archive.js";
import { defaultMoodState, computeMoodDelta, applyMoodSignal } from "./mood.js";
import { defaultTemporalContext, uniqueEventsBySignature, summarizeEventsForTier, summarizeTargetFocus } from "./temporal.js";
import { renderContextPrompt } from "./render.js";
import { runRetentionCleanup } from "./retention.js";

const safeTextMemory = (value: unknown): string | null => {
  if (!isRecord(value)) return null;
  return typeof value.content === "string" ? value.content : null;
};

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export class MemoryStore {
  readonly stateDir: string;
  readonly rotateBytes: number;
  readonly tailMaxBytes: number;
  readonly tailMaxLines: number;
  readonly streamPaths: StreamPathMap;

  private readonly viewStatePath: string;
  private viewState: ViewState;
  private viewStateDirty: boolean;
  private viewStateWriteTimer: ReturnType<typeof setTimeout> | null;

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

    this.memoryDir = path.join(this.stateDir, "memory");
    this.memoryContextDir = path.join(this.memoryDir, "context");
    this.moodStatePath = path.join(this.memoryDir, "mood.json");
    this.temporalContextPath = path.join(this.memoryContextDir, "temporal.json");
    this.temporalTierPaths = {
      "24h": path.join(this.memoryContextDir, "24h.json"),
      "7d": path.join(this.memoryContextDir, "7d.json"),
      "30d": path.join(this.memoryContextDir, "30d.json"),
      "365d": path.join(this.memoryContextDir, "365d.json"),
    };

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
    await ensureDir(this.stateDir);
    await ensureDir(this.memoryDir);
    await ensureDir(this.memoryContextDir);

    const existing = await readJsonFile(this.viewStatePath);
    if (isRecord(existing) && existing.version === 1 && isRecord(existing.items)) {
      this.viewState = existing as ViewState;
    }
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
    this.viewStateWriteTimer = setTimeout(() => { this.viewStateWriteTimer = null; void this.flushViewState().catch(() => {}); }, 250);
  }

  async flushViewState(): Promise<void> {
    if (!this.viewStateDirty) return;
    this.viewState.updatedAt = nowIso();
    await writeJsonFile(this.viewStatePath, this.viewState);
    this.viewStateDirty = false;
  }

  private scheduleMoodStateWrite(): void {
    if (this.moodWriteTimer) return;
    this.moodWriteTimer = setTimeout(() => { this.moodWriteTimer = null; void this.flushMoodState().catch(() => {}); }, 300);
  }

  async flushMoodState(): Promise<void> {
    if (!this.moodDirty) return;
    this.moodState.updatedAt = nowIso();
    await writeJsonFile(this.moodStatePath, this.moodState);
    this.moodDirty = false;
  }

  private scheduleTemporalContextWrite(): void {
    if (this.temporalWriteTimer) return;
    this.temporalWriteTimer = setTimeout(() => { this.temporalWriteTimer = null; void this.flushTemporalContext().catch(() => {}); }, 350);
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
    this.temporalDirty = false;
  }

  // ---- rotation -----------------------------------------------------------

  async maybeRotate(stream: StreamName): Promise<void> {
    const activePath = this.streamPaths[stream];
    const stat = await fs.stat(activePath).catch(() => null);
    if (!stat || stat.size < this.rotateBytes) return;
    await archiveJsonl({ stream, stateDir: this.stateDir, activePath, archiveBasename: createArchiveBasename() });
  }

  // ---- derive memory activity ---------------------------------------------

  private deriveMemoryActivity(envelope: MemoryEnvelope, keys: ReturnType<typeof extractKeysFromPayload>): MemoryActivity {
    const type = keys.type ?? "";
    const actor = extractActorHintFromPayload(envelope.payload);
    const textHint = extractTextHintFromPayload(envelope.payload);
    const postId = typeof keys.postId === "number" ? keys.postId : null;
    const commentId = typeof keys.commentId === "number" ? keys.commentId : null;

    let activityType = "";
    if (type === "post_view") activityType = "read";
    else if (type === "post_comment") activityType = "comment";
    else if (type === "post_like") activityType = "like";
    else if (type === "post_repost") activityType = "repost";
    else if (type === "post_created") activityType = "post_created";
    else if (type === "publish_attempt_result") activityType = "publish_result";
    else if (type === "publish_attempt") activityType = "publish_attempt";
    else if (type === "directive_queue_executed") activityType = "directive_executed";
    else if (type === "directive_staged_for_queue_execution" || type === "directive_staged_waiting_terminal_run") activityType = "directive_staged";
    else if (type.endsWith("_failed") || type.includes("error")) activityType = "error";
    else if (envelope.source === "local") activityType = "runtime";
    else activityType = "event";

    return {
      type: "memory_activity", activityType, postId, commentId,
      actor: actor || null, summary: textHint || null,
      sourceTopic: typeof envelope.topic === "string" ? envelope.topic : "unknown",
      sourceType: type || "unknown",
    };
  }

  getMoodSnapshot(): MoodState {
    return isRecord(this.moodState) ? this.moodState : defaultMoodState();
  }

  // ---- ingest -------------------------------------------------------------

  async ingest(envelope: MemoryEnvelope): Promise<void> {
    const keys = extractKeysFromPayload(envelope.payload);
    const type = keys.type;
    const activityRecord = this.deriveMemoryActivity(envelope, keys);

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

    if (type === "post_created" && keys.postId) {
      const key = String(keys.postId);
      if (!this.viewState.items[key]) {
        const receivedAt = normalizeIso(envelope.receivedAt);
        this.viewState.items[key] = { status: "unviewed", receivedAt };
        this.viewStateDirty = true;
        this.scheduleViewStateWrite();
        await appendJsonLine(this.streamPaths.views, { receivedAt, source: "local", topic: "derived:view_queue", payload: { postId: keys.postId, status: "unviewed", receivedAt } });
        await this.maybeRotate("views");
      }
    }

    const at = activityRecord.activityType;
    if (at === "read" || at === "comment" || at === "publish_result" || at === "directive_executed") {
      void this.refreshTemporalContext({ force: false, allowAgentCompression: false }).catch(() => {});
    }
  }

  async recordWrite(payload: unknown): Promise<void> {
    await this.ingest({ receivedAt: nowIso(), source: "local", topic: "agent_write", payload });
  }

  // ---- read ---------------------------------------------------------------

  async readRecentEnvelopes({ maxLines }: { maxLines: number }): Promise<MemoryEnvelope[]> {
    const streams: StreamName[] = ["notifications", "feed", "activity", "memory_activity", "likes", "reposts", "comments", "views", "director"];
    const perStream = Math.max(30, Math.ceil(maxLines / streams.length));
    const reads = await Promise.all(streams.map(async (stream) => {
      const items = await readLastJsonLines({ filePath: this.streamPaths[stream], maxLines: perStream, maxBytes: this.tailMaxBytes });
      return items.map(parseMemoryEnvelope).filter((env): env is MemoryEnvelope => Boolean(env));
    }));
    const merged = reads.flat();
    merged.sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0));
    return merged;
  }

  async readArchiveContext({ request, maxEvents, targetFilter }: { request: ContextRequest; maxEvents: number; targetFilter: (env: MemoryEnvelope) => boolean }): Promise<MemoryEnvelope[]> {
    if (maxEvents <= 0) return [];
    const streams: StreamName[] = ["feed", "activity", "memory_activity", "notifications"];
    const results: MemoryEnvelope[] = [];
    const wantTargeted = typeof request.postId === "number" || typeof request.commentId === "number";

    for (const stream of streams) {
      if (results.length >= maxEvents) break;
      const indexes = await listArchiveIndexes({ stateDir: this.stateDir, stream });
      if (!indexes.length) continue;
      const picks = wantTargeted
        ? indexes.filter((idx) => (typeof request.postId === "number" && idx.postIds?.includes(request.postId)) || (typeof request.commentId === "number" && idx.commentIds?.includes(request.commentId))).slice(0, 4).map((idx) => idx.archiveBasename)
        : pickWeightedArchiveBasenames(indexes, 2);
      for (const basename of picks) {
        if (results.length >= maxEvents) break;
        const gzPath = findArchiveGzPath({ stateDir: this.stateDir, stream, archiveBasename: basename });
        const batch = await readEventsFromGzArchive({ gzPath, filter: wantTargeted ? targetFilter : () => true, maxEvents: Math.min(maxEvents - results.length, 30) });
        results.push(...batch);
      }
    }
    results.sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0));
    return results.slice(-maxEvents);
  }

  async readArchiveWindow({ maxAgeDays, maxEvents, filter }: { maxAgeDays: number; maxEvents: number; filter?: (env: MemoryEnvelope) => boolean }): Promise<MemoryEnvelope[]> {
    const safeMax = Math.max(0, Math.floor(maxEvents));
    if (safeMax <= 0) return [];
    const minMs = Date.now() - Math.max(1, Math.floor(maxAgeDays)) * 86_400_000;
    const scanStreams: StreamName[] = ["feed", "activity", "memory_activity", "notifications", "comments", "views"];
    const out: MemoryEnvelope[] = [];
    for (const stream of scanStreams) {
      if (out.length >= safeMax) break;
      const indexes = await listArchiveIndexes({ stateDir: this.stateDir, stream });
      for (const idx of indexes.slice(0, 16)) {
        if (out.length >= safeMax) break;
        const maxAtMs = idx.receivedAtMax ? Date.parse(idx.receivedAtMax) : NaN;
        if (!Number.isFinite(maxAtMs) || maxAtMs < minMs) continue;
        const batch = await readEventsFromGzArchive({ gzPath: findArchiveGzPath({ stateDir: this.stateDir, stream, archiveBasename: idx.archiveBasename }), filter: filter ?? ((e) => Date.parse(e.receivedAt) >= minMs), maxEvents: Math.min(safeMax - out.length, 120) });
        out.push(...batch);
      }
    }
    return uniqueEventsBySignature(out).sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0)).slice(-safeMax);
  }

  // ---- context ------------------------------------------------------------

  async buildContext(request: ContextRequest): Promise<ContextBundle> {
    const maxRecent = request.maxRecentEvents ?? 80;
    const maxArchive = request.maxArchiveEvents ?? 40;
    await this.refreshTemporalContext({ force: false, allowAgentCompression: false }).catch(() => {});

    const identityPath = path.join(this.stateDir, "memory", "identity.json");
    const modePath = request.mode ? path.join(this.stateDir, "memory", "modes", `${request.mode}.json`) : null;
    const [identityRaw, modeRaw] = await Promise.all([readJsonFile(identityPath), modePath ? readJsonFile(modePath) : Promise.resolve(null)]);

    const notesDir = path.join(this.stateDir, "memory", "notes");
    const noteFiles = await fs.readdir(notesDir).catch(() => []);
    const notes: Array<{ version: number; title: string; content: string; appliesTo?: { modes?: string[]; audiences?: string[] } }> = [];
    for (const name of noteFiles) {
      if (!name.endsWith(".json")) continue;
      const note = await readJsonFile(path.join(notesDir, name));
      if (!isRecord(note) || note.version !== 1) continue;
      if (typeof note.title !== "string" || typeof note.content !== "string") continue;
      notes.push(note as { version: number; title: string; content: string; appliesTo?: { modes?: string[]; audiences?: string[] } });
    }

    const eligible = notes.filter((n) => {
      const a = isRecord(n.appliesTo) ? n.appliesTo : null;
      if (!a) return true;
      if (request.mode && Array.isArray(a.modes) && (a.modes as string[]).length && !(a.modes as string[]).includes(request.mode)) return false;
      if (request.audience && Array.isArray(a.audiences) && (a.audiences as string[]).length && !(a.audiences as string[]).includes(request.audience)) return false;
      return true;
    });

    const recent = await this.readRecentEnvelopes({ maxLines: Math.max(maxRecent, 120) });
    const tf = (env: MemoryEnvelope): boolean => {
      const k = extractKeysFromPayload(env.payload);
      return (typeof request.postId === "number" && k.postId === request.postId) || (typeof request.commentId === "number" && k.commentId === request.commentId);
    };
    const targetEvents = recent.filter(tf).slice(-maxRecent);
    const archiveEvents = await this.readArchiveContext({ request, maxEvents: maxArchive, targetFilter: tf });
    const targetFocus = summarizeTargetFocus({ request, targetEvents: uniqueEventsBySignature([...targetEvents, ...archiveEvents.filter(tf)]) });

    const nowMs = Date.now();
    if (nowMs - this.lastContextReadAtMs > 12_000) {
      this.lastContextReadAtMs = nowMs;
      void this.recordWrite({ type: "memory_context_read", at: nowIso(), mode: request.mode ?? null, audience: request.audience ?? null, postId: request.postId ?? null, commentId: request.commentId ?? null });
    }

    return {
      generatedAt: nowIso(), identity: identityRaw ? safeTextMemory(identityRaw) : null, mode: modeRaw ? safeTextMemory(modeRaw) : null, audience: request.audience ?? null,
      mood: this.getMoodSnapshot(), temporal: isRecord(this.temporalContext) ? this.temporalContext : defaultTemporalContext(),
      target: { postId: request.postId ?? null, commentId: request.commentId ?? null, events: targetEvents, focus: targetFocus },
      recent: recent.slice(-maxRecent), archive: archiveEvents, notes: eligible,
    };
  }

  renderContextPrompt(bundle: ContextBundle): string { return renderContextPrompt(bundle); }

  // ---- temporal refresh ---------------------------------------------------

  async refreshTemporalContext(options: RefreshTemporalOptions = {}): Promise<TemporalContext> {
    const { force = false, allowAgentCompression = false, agentCompressFn = null } = options;

    const run = async (): Promise<TemporalContext> => {
      const nowMs = Date.now();
      const updMs = Date.parse(this.temporalContext.updatedAt ?? "");
      if (!force && Number.isFinite(updMs) && nowMs - updMs < 120_000) return this.temporalContext;

      const recent = await this.readRecentEnvelopes({ maxLines: 1600 });
      const archived = await this.readArchiveWindow({ maxAgeDays: 365, maxEvents: 900 });
      const combined = uniqueEventsBySignature([...archived, ...recent]).sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0));
      const byAge = (d: number): MemoryEnvelope[] => { const m = nowMs - d * 86_400_000; return combined.filter((e) => { const t = Date.parse(e.receivedAt); return Number.isFinite(t) && t >= m; }); };

      const specs = [{ key: "24h", days: 1, label: "last 24 hours", maxBullets: 20 }, { key: "7d", days: 7, label: "last 7 days", maxBullets: 16 }, { key: "30d", days: 30, label: "last 30 days", maxBullets: 12 }, { key: "365d", days: 365, label: "last 365 days", maxBullets: 8 }];
      const nextTiers: Record<string, TierSummary> = {};
      const specByKey = new Map<string, (typeof specs)[number]>();

      for (const s of specs) { nextTiers[s.key] = summarizeEventsForTier({ tier: s.key, label: s.label, events: byAge(s.days), maxBullets: s.maxBullets }); specByKey.set(s.key, s); }

      if (allowAgentCompression && typeof agentCompressFn === "function") {
        const targets: Record<string, unknown> = {};
        for (const tk of ["30d", "365d"]) { const sm = nextTiers[tk]; if (!sm) continue; targets[tk] = { tier: tk, label: sm.windowLabel, eventCount: sm.eventCount, topTypes: sm.topTypes, topPosts: sm.topPosts, topActors: sm.topActors, bullets: sm.algorithmBullets }; }
        if (Object.keys(targets).length > 0) {
          try {
            const ac = await agentCompressFn({ tiers: targets as Parameters<typeof agentCompressFn>[0]["tiers"] }) as Record<string, unknown>;
            const te = isRecord(ac) && isRecord(ac.tiers) ? ac.tiers as Record<string, unknown> : null;
            const normBullets = (c: unknown, max: number): string[] => { if (!Array.isArray(c)) return []; return unique(c.filter((l): l is string => typeof l === "string").map((l) => toShortLine(l, 140)).filter((l) => l.length > 0)).slice(0, max); };
            for (const tk of Object.keys(targets)) {
              const sm = nextTiers[tk]; if (!sm) continue;
              const mx = specByKey.get(tk)?.maxBullets ?? 8;
              const fe = te ? te[tk] : null; const dv = isRecord(ac) ? ac[tk] : null; const pref = fe ?? dv;
              const cb = Array.isArray(pref) ? pref : isRecord(pref) && Array.isArray((pref as Record<string, unknown>).bullets) ? (pref as Record<string, unknown>).bullets : Object.keys(targets).length === 1 && Array.isArray(ac) ? ac : [];
              const nb = normBullets(cb, mx);
              if (nb.length > 0) { sm.bullets = nb; sm.compressedBy = "agent"; } else { sm.bullets = sm.algorithmBullets; sm.compressedBy = "algorithm"; }
            }
          } catch { /* keep algorithm summary */ }
        }
      }

      this.temporalContext = { version: 1, updatedAt: nowIso(), algorithmVersion: 1, tiers: { ...defaultTemporalContext().tiers, ...nextTiers } };
      this.temporalDirty = true;
      this.scheduleTemporalContextWrite();
      return this.temporalContext;
    };

    if (this.temporalRefreshInFlight) return this.temporalRefreshInFlight;
    this.temporalRefreshInFlight = run().finally(() => { this.temporalRefreshInFlight = null; });
    return this.temporalRefreshInFlight;
  }

  // ---- retention (delegated) ----------------------------------------------

  async runRetentionCleanup({ retentionConfig }: { retentionConfig: KthxRetentionConfig }): Promise<RetentionCleanupResult | null> {
    const { result, moodDirty, updatedMoodState } = await runRetentionCleanup({ retentionConfig, streamPaths: this.streamPaths, tailMaxBytes: this.tailMaxBytes, stateDir: this.stateDir, moodState: this.moodState });
    if (moodDirty) { this.moodState = updatedMoodState; this.moodDirty = true; }
    return result;
  }
}
