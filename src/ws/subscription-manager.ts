/**
 * SubscriptionManager: manages user-topic and public-topic WebSocket
 * subscriptions, resync logic, and stuck-subscription recycling.
 *
 * Ported from agent-runtime.mjs lines 9488-9983.
 */

import { nowIso } from "../lib/text.js";
import { isRecord } from "../lib/guards.js";
import { unique } from "../lib/time.js";
import { trimEnv } from "../lib/env-parse.js";
import { getBotToken } from "../auth/bot-token.js";
import type { SubscriptionManagerLike, AuthManagerLike } from "../runtime-context.js";
import type { WsTrackingState } from "../debug/ws-state.js";

// ---------------------------------------------------------------------------
// Narrow context
// ---------------------------------------------------------------------------

export interface SubscriptionManagerContext {
  config: {
    subscribeGlobalFeed: boolean;
    subscribeActivityFeed: boolean;
    autoSubscribeLenses: boolean;
    lensRefreshMinMs: number;
    heartbeatIntervalMs: number;
    extraPublicTopics: string[];
    extraUserTopics: string[];
  };
  ws: WsTrackingState;
  misc: {
    subscriptionResyncRequested: boolean;
    subscriptionResyncReason: string | null;
    lastSubscriptionResyncAtMs: number;
    lastSubscriptionRefreshAtMs: number;
    lastWsOpenTransitionAtMs: number;
  };
  memory: { recordWrite(payload: unknown): Promise<void> };
  debugSnapshot: {
    auth: Record<string, unknown> | null;
    lastSubscriptionError: Record<string, unknown> | null;
  };
  trpc: {
    realtime: {
      heartbeat: { subscribe(i: { intervalMs: number }, o: SubOpts): SubHandle };
      userEvents: { subscribe(i: { topic: string }, o: SubOpts): SubHandle };
      publicEvents: { subscribe(i: { topic: string }, o: SubOpts): SubHandle };
    };
    lens?: { listMine: { query(input?: unknown): Promise<unknown> } };
  } | null;
  writeDebugSnapshot(): Promise<void>;
  markWsActivity(source: string): void;
  handleEnvelope(e: { receivedAt: string; source: string; topic: string; payload: unknown }): Promise<void>;
  authManager: AuthManagerLike | null;
  runBackendCall<T>(label: string, fn: () => Promise<T>): Promise<T>;
}

interface SubOpts { onStarted?(): void; onData?(e: unknown): void; onError?(e: unknown): void }
interface SubHandle { unsubscribe(): void }
interface TopicState { sub: SubHandle | null; started: boolean; createdAtMs: number; lastDataAtMs: number | null }

const ACTIVATION_GRACE_MS = 2_000;
const START_TIMEOUT_MS = 15_000;
const CRITICAL = new Set(["agent_auth_state", "agent_permission_state"]);

// ---------------------------------------------------------------------------
// SubscriptionManager
// ---------------------------------------------------------------------------

export class SubscriptionManager implements SubscriptionManagerLike {
  private readonly ctx: SubscriptionManagerContext;
  private readonly userSubs = new Map<string, TopicState>();
  private readonly publicSubs = new Map<string, TopicState>();
  private readonly publicBase: string[];
  private publicTopics: string[];
  private readonly userTopics: string[];
  private heartbeatSub: SubHandle | null = null;
  private lastCriticalRecoveryMs = 0;
  private lastWaitingAuthMs = 0;
  private lensRefreshFlight = false;
  private lastLensRefreshMs = 0;
  private healTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: SubscriptionManagerContext) {
    this.ctx = ctx;
    this.userTopics = unique([
      "director", "notifications", "agent_auth_state",
      "agent_permission_state", ...ctx.config.extraUserTopics,
    ]);
    this.publicBase = [];
    if (ctx.config.subscribeGlobalFeed) this.publicBase.push("feed:global");
    if (ctx.config.subscribeActivityFeed) this.publicBase.push("feed:activity");
    this.publicBase.push(...ctx.config.extraPublicTopics);
    this.publicTopics = unique([...this.publicBase]);
  }

  // -- Public API ----------------------------------------------------------

  async subscribeUserTopics(): Promise<void> {
    if (!(await this.hasAuth())) {
      const now = Date.now();
      if (now - this.lastWaitingAuthMs >= 30_000) {
        this.lastWaitingAuthMs = now;
        await this.ctx.memory.recordWrite({
          type: "socket_subscription_waiting_auth", at: nowIso(),
          scope: "user", topics: this.userTopics,
        });
      }
      return;
    }
    for (const t of this.userTopics) this.subUser(t);
  }

  async subscribePublicTopics(): Promise<void> {
    for (const t of this.publicTopics) this.subPublic(t);
  }

  requestResync(reason: string): void {
    this.ctx.misc.subscriptionResyncRequested = true;
    this.ctx.misc.subscriptionResyncReason = reason;
  }

  userSubscriptionsReady(): boolean {
    const now = Date.now();
    return this.userTopics.every((t) => {
      const s = this.userSubs.get(t);
      if (!s) return false;
      return !CRITICAL.has(t) || this.isOperational(s, now);
    });
  }

  startHealLoop(): void {
    if (this.healTimer) return;
    this.healTimer = setInterval(() => { void this.healTick() }, 10_000);
  }

  dispose(): void {
    if (this.healTimer) { clearInterval(this.healTimer); this.healTimer = null }
    this.teardownAll();
  }

  // -- Subscribe helpers ---------------------------------------------------

  private subUser(topic: string): void {
    if (this.userSubs.has(topic) || !this.ctx.trpc) return;
    const st: TopicState = { sub: null, started: false, createdAtMs: Date.now(), lastDataAtMs: null };
    this.userSubs.set(topic, st);
    st.sub = this.ctx.trpc.realtime.userEvents.subscribe({ topic }, {
      onStarted: () => { this.markStarted(this.userSubs, topic) },
      onData: (ev: unknown) => {
        this.markData(this.userSubs, topic);
        this.ctx.markWsActivity("user_subscription_event");
        const p = isRecord(ev) ? ev : {};
        void this.ctx.handleEnvelope({
          receivedAt: nowIso(), source: "user",
          topic: typeof p.topic === "string" ? (p.topic as string) : topic,
          payload: p.payload,
        });
      },
      onError: (err: unknown) => {
        this.removeTopic(this.userSubs, topic);
        void this.logError("user", topic, err);
        void this.recoverUnauth(err);
        this.retry(() => { void (async () => { if (await this.hasAuth()) this.subUser(topic) })() });
      },
    });
    void this.ctx.memory.recordWrite({ type: "socket_subscription_started", at: nowIso(), scope: "user", topic });
  }

  private subPublic(topic: string): void {
    if (this.publicSubs.has(topic) || !this.ctx.trpc) return;
    const st: TopicState = { sub: null, started: false, createdAtMs: Date.now(), lastDataAtMs: null };
    this.publicSubs.set(topic, st);
    st.sub = this.ctx.trpc.realtime.publicEvents.subscribe({ topic }, {
      onStarted: () => { this.markStarted(this.publicSubs, topic) },
      onData: (ev: unknown) => {
        this.markData(this.publicSubs, topic);
        this.ctx.markWsActivity("public_subscription_event");
        const p = isRecord(ev) ? ev : {};
        void this.ctx.handleEnvelope({
          receivedAt: nowIso(), source: "public",
          topic: typeof p.topic === "string" ? (p.topic as string) : topic,
          payload: p.payload,
        });
      },
      onError: (err: unknown) => {
        this.removeTopic(this.publicSubs, topic);
        void this.logError("public", topic, err);
        void this.recoverUnauth(err);
        this.retry(() => { this.subPublic(topic) });
      },
    });
    void this.ctx.memory.recordWrite({ type: "socket_subscription_started", at: nowIso(), scope: "public", topic });
  }

  private subHeartbeat(): void {
    if (this.heartbeatSub || !this.ctx.trpc) return;
    const sub = this.ctx.trpc.realtime.heartbeat.subscribe(
      { intervalMs: Math.min(30_000, Math.max(1_000, this.ctx.config.heartbeatIntervalMs)) },
      {
        onData: () => { this.ctx.markWsActivity("heartbeat_subscription") },
        onError: (err: unknown) => {
          this.heartbeatSub = null;
          void this.logError("core", "heartbeat", err);
          void this.recoverUnauth(err);
          this.retry(() => { this.subHeartbeat() }, 2_000);
        },
      },
    );
    this.heartbeatSub = sub;
    void this.ctx.memory.recordWrite({ type: "socket_subscription_started", at: nowIso(), scope: "core", topic: "heartbeat" });
  }

  // -- Resync & heal -------------------------------------------------------

  private async runResync(): Promise<void> {
    if (!this.ctx.misc.subscriptionResyncRequested) return;
    const now = Date.now();
    if (now - this.ctx.misc.lastSubscriptionResyncAtMs < 2_000) return;
    this.ctx.misc.subscriptionResyncRequested = false;
    const reason = this.ctx.misc.subscriptionResyncReason ?? "requested";
    this.ctx.misc.subscriptionResyncReason = null;
    this.ctx.misc.lastSubscriptionResyncAtMs = now;
    this.teardownAll();
    await this.ctx.memory.recordWrite({
      type: "socket_subscription_resync", at: nowIso(), reason,
      wsState: this.ctx.ws.lastWsState, transportState: this.ctx.ws.lastWsTransportState,
      wsOpenTransitionAt: this.ctx.misc.lastWsOpenTransitionAtMs
        ? new Date(this.ctx.misc.lastWsOpenTransitionAtMs).toISOString() : null,
    });
    await this.refreshLens("resync");
    this.subHeartbeat();
    for (const t of this.publicTopics) this.subPublic(t);
    void this.subscribeUserTopics();
  }

  private async healTick(): Promise<void> {
    await this.runResync().catch(() => {});
    await this.refreshLens("periodic").catch(() => {});
    this.subHeartbeat();
    void this.subscribeUserTopics();
    for (const t of this.publicTopics) this.subPublic(t);
    await this.recycleStuck(this.userSubs, "user", (t) => this.subUser(t)).catch(() => {});
    await this.recycleStuck(this.publicSubs, "public", (t) => this.subPublic(t)).catch(() => {});
    await this.recoverCritical().catch(() => {});
  }

  // -- Lens topics ---------------------------------------------------------

  private async refreshLens(reason: string): Promise<void> {
    if (!this.ctx.config.autoSubscribeLenses || this.lensRefreshFlight || !this.ctx.trpc?.lens) return;
    const now = Date.now();
    if (reason === "periodic") {
      const minMs = this.ctx.config.lensRefreshMinMs;
      if (minMs <= 0) return;
      const hasLens = this.publicTopics.some((t) => t.startsWith("feed:lens:"));
      if (now - this.lastLensRefreshMs < (hasLens ? minMs : Math.min(minMs, 30_000))) return;
    }
    if (!(await this.hasAuth())) return;
    this.lensRefreshFlight = true;
    this.lastLensRefreshMs = now;
    try {
      const lensTopics = await this.fetchLensTopics();
      const next = unique([...this.publicBase, ...lensTopics]);
      const curSet = new Set(this.publicTopics);
      const nextSet = new Set(next);
      const added = next.filter((t) => !curSet.has(t));
      const removed = this.publicTopics.filter((t) => !nextSet.has(t));
      this.publicTopics = next;
      for (const t of removed) this.removeTopic(this.publicSubs, t);
      for (const t of added) this.subPublic(t);
      if (added.length || removed.length) {
        await this.ctx.memory.recordWrite({
          type: "socket_public_topics_refreshed", at: nowIso(), reason,
          addedTopics: added, removedTopics: removed, totalTopics: next.length,
        });
      }
    } catch (e: unknown) {
      await this.ctx.memory.recordWrite({
        type: "socket_public_topics_refresh_failed", at: nowIso(), reason,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally { this.lensRefreshFlight = false }
  }

  private async fetchLensTopics(): Promise<string[]> {
    if (!this.ctx.trpc?.lens) return [];
    let list: unknown;
    try {
      list = await this.ctx.runBackendCall("lens.listMine.query", () =>
        this.ctx.trpc!.lens!.listMine.query({ includeRules: true }));
    } catch {
      list = await this.ctx.runBackendCall("lens.listMine.query", () =>
        this.ctx.trpc!.lens!.listMine.query());
    }
    const rows = Array.isArray(list) ? list : [];
    const ids = unique(rows.map((r: unknown) => {
      if (!isRecord(r) || !isRecord(r.lens)) return null;
      const id = (r.lens as Record<string, unknown>).id;
      if (typeof id === "number" && Number.isFinite(id) && id > 0) return Math.floor(id);
      if (typeof id === "string" && id.trim().length > 0) {
        const p = Number.parseInt(id.trim(), 10);
        return Number.isFinite(p) && p > 0 ? p : null;
      }
      return null;
    }).filter((v): v is number => typeof v === "number"));
    return ids.map((id) => `feed:lens:${id}`);
  }

  // -- Recycle & recover ---------------------------------------------------

  private async recycleStuck(
    map: Map<string, TopicState>, scope: string, subFn: (t: string) => void,
  ): Promise<void> {
    const now = Date.now();
    for (const [topic, st] of map.entries()) {
      if ((this.isOperational(st, now) && st.sub) || now - st.createdAtMs < START_TIMEOUT_MS) continue;
      this.removeTopic(map, topic);
      await this.ctx.memory.recordWrite({
        type: "socket_subscription_recycled", at: nowIso(), scope, topic, reason: "stuck_not_started",
      });
      subFn(topic);
    }
  }

  private async recoverCritical(): Promise<void> {
    if (this.ctx.ws.lastWsState !== "open") return;
    if (!this.ctx.authManager || this.ctx.authManager.getAuthStateValue() !== "ok") return;
    const now = Date.now();
    if (now - this.lastCriticalRecoveryMs < 30_000) return;
    const thresh = Math.max(this.ctx.config.heartbeatIntervalMs * 3, 90_000);
    const topics = ["agent_auth_state", "agent_permission_state"];
    let stale = false;
    for (const t of topics) {
      const s = this.userSubs.get(t);
      if (!s?.started || typeof s.lastDataAtMs !== "number" || now - s.lastDataAtMs > thresh) { stale = true; break }
    }
    if (!stale) return;
    this.lastCriticalRecoveryMs = now;
    for (const t of Array.from(this.userSubs.keys())) this.removeTopic(this.userSubs, t);
    await this.ctx.memory.recordWrite({
      type: "socket_subscription_recovered", at: nowIso(), scope: "user",
      reason: "critical_topics_stale", topics,
    });
    void this.subscribeUserTopics();
  }

  // -- Topic state ---------------------------------------------------------

  private markStarted(map: Map<string, TopicState>, topic: string, src = "started"): void {
    const s = map.get(topic);
    if (!s) return;
    s.started = true;
    if (src === "data") s.lastDataAtMs = Date.now();
  }

  private markData(map: Map<string, TopicState>, topic: string): void {
    this.markStarted(map, topic, "data");
  }

  private removeTopic(map: Map<string, TopicState>, topic: string): void {
    const s = map.get(topic);
    if (!s) return;
    try { s.sub?.unsubscribe() } catch { /* ignore */ }
    map.delete(topic);
  }

  private isOperational(st: TopicState, now = Date.now()): boolean {
    return st.started || (Boolean(st.sub) && now - st.createdAtMs >= ACTIVATION_GRACE_MS);
  }

  // -- Error handling ------------------------------------------------------

  private async logError(scope: string, topic: string, err: unknown): Promise<void> {
    const code = this.errCode(err);
    const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "subscription_error";
    await this.ctx.memory.recordWrite({ type: "socket_subscription_error", at: nowIso(), scope, topic, code, message: msg });
    this.ctx.debugSnapshot.lastSubscriptionError = { at: nowIso(), scope, topic, code: code ?? null, message: msg };
    await this.ctx.writeDebugSnapshot();
  }

  private async recoverUnauth(err: unknown): Promise<void> {
    if (this.errCode(err) === "UNAUTHORIZED" && this.ctx.authManager) {
      await this.ctx.authManager.refreshIfNeeded();
    }
  }

  // -- Utility -------------------------------------------------------------

  private teardownAll(): void {
    if (this.heartbeatSub) { try { this.heartbeatSub.unsubscribe() } catch { /* */ } this.heartbeatSub = null }
    for (const t of Array.from(this.userSubs.keys())) this.removeTopic(this.userSubs, t);
    for (const t of Array.from(this.publicSubs.keys())) this.removeTopic(this.publicSubs, t);
  }

  private async hasAuth(): Promise<boolean> {
    const token = await getBotToken();
    const key = trimEnv("MG_AGENT_KEY_BOX");
    return Boolean(token || (key && key.trim().length > 0));
  }

  private retry(fn: () => void, ms = 1_500): void { setTimeout(fn, ms) }

  private errCode(err: unknown): string | null {
    if (!isRecord(err)) return null;
    const d = isRecord(err.data) ? err.data : null;
    if (d && typeof d.code === "string") return d.code as string;
    const s = isRecord(err.shape) ? err.shape : null;
    const sd = s && isRecord(s.data) ? s.data : null;
    if (sd && typeof sd.code === "string") return sd.code as string;
    return null;
  }
}
