/**
 * Standalone HTTP server serving an agent health dashboard.
 *
 * Ported from agent-health-web.mjs.
 *
 * Reads various state files (debug snapshot, queue state, chat status,
 * mood, temporal memory, writes JSONL, inbox JSONL) and serves:
 *   GET /api/health  - JSON health snapshot
 *   GET /            - HTML dashboard with auto-refresh
 *
 * Optional env:
 *   MG_AGENT_STATE_DIR
 *   MG_AGENT_HEALTH_HOST (default 127.0.0.1)
 *   MG_AGENT_HEALTH_PORT (default 4278)
 */

import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { loadDotEnv } from "../config/dotenv.js";
import { trimEnv, parseIntEnv } from "../lib/env-parse.js";
import { isRecord } from "../lib/guards.js";
import {
  createStateSqliteStoreFromEnv,
  type StateSqliteStore,
} from "../state/sqlite-state.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAIL_MAX_BYTES = 220_000;
const TAIL_MAX_LINES = 500;

const DIRECTIVE_STAGED_TYPES = new Set([
  "directive_staged_for_queue_execution",
  "directive_staged_waiting_terminal_run",
  "directive_queue_enqueued",
]);
const DIRECTIVE_EXECUTED = "directive_queue_executed";
const DIRECTIVE_FAILED = "directive_queue_execution_failed";
const PUBLISH_RESULT = "publish_attempt_result";
const CHAT_AUTO_REPLY = "chat_runtime_auto_reply_sent";
const MEMORY_REFRESH = "memory_temporal_refreshed";
const NOTIFICATIONS_FLUSHED = "notifications_buffer_flushed";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
};

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const bool = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : null;

const iso = (v: unknown): string | null => {
  const c = str(v);
  if (!c) return null;
  return Number.isFinite(Date.parse(c)) ? c : null;
};

const resolveStateDir = (): string => {
  const configured = trimEnv("MG_AGENT_STATE_DIR");
  if (configured) return path.resolve(configured);
  const agentHomeDir = trimEnv("MG_AGENT_HOME_DIR")
    ? path.resolve(trimEnv("MG_AGENT_HOME_DIR") ?? "kthx-agents")
    : path.resolve(process.cwd(), "kthx-agents");
  return path.resolve(agentHomeDir, "state");
};

let stateDb: StateSqliteStore | null = null;

const getStateDb = (): StateSqliteStore => {
  if (stateDb) return stateDb;
  const db = createStateSqliteStoreFromEnv(resolveStateDir());
  db.init();
  stateDb = db;
  return db;
};

const readJsonRecord = async (p: string): Promise<Record<string, unknown> | null> => {
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const readTailLines = async (filePath: string, maxBytes: number, maxLines: number): Promise<string[]> => {
  try {
    const stat = await fs.stat(filePath);
    if (!Number.isFinite(stat.size) || stat.size <= 0) return [];
    const total = Math.max(0, Math.floor(stat.size));
    const start = Math.max(0, total - Math.max(1, Math.floor(maxBytes)));
    const length = total - start;
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      const lines = buffer.toString("utf8").split(/\r?\n/u);
      return (start > 0 ? lines.slice(1) : lines).map((l) => l.trim()).filter((l) => l.length > 0).slice(-Math.max(1, Math.floor(maxLines)));
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
};

const parseJsonLines = (lines: string[]): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) out.push(parsed);
    } catch { /* skip */ }
  }
  return out;
};

const eventAt = (envelope: Record<string, unknown>, payload: Record<string, unknown> | null): string | null =>
  iso(envelope.receivedAt) ?? iso(payload?.at) ?? null;

const buildPublicProjection = (
  snapshot: Record<string, unknown>,
): Record<string, unknown> => {
  const runtime = isRecord(snapshot.runtime)
    ? (snapshot.runtime as Record<string, unknown>)
    : {};
  const chatBridge = isRecord(snapshot.chatBridge)
    ? (snapshot.chatBridge as Record<string, unknown>)
    : {};
  const agent = isRecord(snapshot.agent)
    ? (snapshot.agent as Record<string, unknown>)
    : {};
  const memory = isRecord(snapshot.memory)
    ? (snapshot.memory as Record<string, unknown>)
    : {};
  const activity = isRecord(snapshot.activity)
    ? (snapshot.activity as Record<string, unknown>)
    : {};

  return {
    generatedAt: iso(snapshot.generatedAt) ?? new Date().toISOString(),
    available: bool(snapshot.available) ?? false,
    reason: str(snapshot.reason),
    runtime: {
      wsState: str(runtime.wsState),
      wsTransportState: str(runtime.wsTransportState),
      authEffective: str(runtime.authEffective),
      permissionState: str(runtime.permissionState),
      lastEnvelopeAt: iso(runtime.lastEnvelopeAt),
      lastPublishAt: iso(runtime.lastPublishAt),
      lastPublishError: str(runtime.lastPublishError),
    },
    chatBridge: {
      connected: bool(chatBridge.connected),
      state: str(chatBridge.state),
      subscribedTopics: num(chatBridge.subscribedTopics),
      subscriptionMode: str(chatBridge.subscriptionMode),
      requestedTopicCounts: isRecord(chatBridge.requestedTopicCounts)
        ? (chatBridge.requestedTopicCounts as Record<string, unknown>)
        : null,
      subscribedTopicCounts: isRecord(chatBridge.subscribedTopicCounts)
        ? (chatBridge.subscribedTopicCounts as Record<string, unknown>)
        : null,
      lastShellSummary: isRecord(chatBridge.lastShellSummary)
        ? (chatBridge.lastShellSummary as Record<string, unknown>)
        : null,
      lastTicketFailureCount: Array.isArray(chatBridge.lastTicketFailures)
        ? chatBridge.lastTicketFailures.length
        : null,
      lastError: str(chatBridge.lastError),
      updatedAt: iso(chatBridge.updatedAt),
      lastEventAt: iso(chatBridge.lastEventAt),
    },
    agent: {
      userId: str(agent.userId),
      handle: str(agent.handle),
      name: str(agent.name),
      profileSet: bool(agent.profileSet),
      openClawAgentName: str(agent.openClawAgentName),
      openClawBinaryOk: bool(agent.openClawBinaryOk),
      openClawBinarySource: str(agent.openClawBinarySource),
      openClawBinaryVersion: str(agent.openClawBinaryVersion),
      openClawBinaryError: str(agent.openClawBinaryError),
      identityUpdatedAt: iso(agent.identityUpdatedAt),
    },
    memory: {
      moodPrimary: str(memory.moodPrimary),
      moodScore: num(memory.moodScore),
      tier24hEvents: num(memory.tier24hEvents),
      tier7dEvents: num(memory.tier7dEvents),
    },
    activity: {
      publishSuccess: num(activity.publishSuccess),
      publishFailed: num(activity.publishFailed),
      directivesExecuted: num(activity.directivesExecuted),
      chatMessagesReceived: num(activity.chatMessagesReceived),
      chatAutoRepliesSent: num(activity.chatAutoRepliesSent),
      recentEvents: Array.isArray(activity.recentEvents)
        ? (activity.recentEvents as unknown[])
        : [],
    },
  };
};

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

const buildSnapshot = async (): Promise<Record<string, unknown>> => {
  const stateDir = resolveStateDir();
  const ipcDir = path.join(stateDir, "ipc");
  const chatDir = path.join(ipcDir, "chat");
  const debugDir = path.join(ipcDir, "debug");
  const memDir = path.join(stateDir, "memory");

  const files = {
    latestDebug: path.join(debugDir, "latest.json"),
    chatStatus: path.join(chatDir, "status.json"),
    chatRuntimeState: path.join(chatDir, "runtime-state.json"),
    agentIdentity: path.join(ipcDir, "auth", "agent-identity.json"),
    mood: path.join(memDir, "mood.json"),
    temporal: path.join(memDir, "context", "temporal.json"),
    writes: path.join(stateDir, "writes.jsonl"),
    chatInbox: path.join(chatDir, "inbox.jsonl"),
  };

  const [latestDebug, chatStatus, chatRuntimeState, agentIdentity, mood, temporal, writes, inbox] = await Promise.all([
    readJsonRecord(files.latestDebug),
    readJsonRecord(files.chatStatus),
    readJsonRecord(files.chatRuntimeState),
    readJsonRecord(files.agentIdentity),
    readJsonRecord(files.mood),
    readJsonRecord(files.temporal),
    readTailLines(files.writes, TAIL_MAX_BYTES, TAIL_MAX_LINES),
    readTailLines(files.chatInbox, TAIL_MAX_BYTES, TAIL_MAX_LINES),
  ]);

  const writeRecords = parseJsonLines(writes);
  const inboxRecords = parseJsonLines(inbox);

  let publishSuccess = 0, publishFailed = 0, directivesStaged = 0, directivesExecuted = 0, directivesFailed = 0;
  let chatAutoReplies = 0, memoryRefreshes = 0, notificationsFlushed = 0;
  let lastDirectiveAt: string | null = null, lastPublishAt: string | null = null;
  let lastInboundAt: string | null = null, lastAutoReplyAt: string | null = null;
  let lastOpenClawAgentName: string | null = null;
  let lastOpenClawProbe: Record<string, unknown> | null = null;
  const recentEvents: Array<{ at: string | null; type: string; detail: string | null }> = [];

  for (const envelope of writeRecords) {
    const payload = isRecord(envelope.payload) ? envelope.payload as Record<string, unknown> : null;
    if (!payload) continue;
    const type = str(payload.type);
    if (!type) continue;
    const at = eventAt(envelope, payload);

    if (type === PUBLISH_RESULT) { if (bool(payload.ok) === true) publishSuccess++; else publishFailed++; lastPublishAt = at ?? lastPublishAt; }
    if (DIRECTIVE_STAGED_TYPES.has(type)) { directivesStaged++; lastDirectiveAt = at ?? lastDirectiveAt; }
    if (type === DIRECTIVE_EXECUTED) { directivesExecuted++; lastDirectiveAt = at ?? lastDirectiveAt; }
    if (type === DIRECTIVE_FAILED) { directivesFailed++; lastDirectiveAt = at ?? lastDirectiveAt; }
    if (type === CHAT_AUTO_REPLY) { chatAutoReplies++; lastAutoReplyAt = at ?? lastAutoReplyAt; }
    if (type === MEMORY_REFRESH) memoryRefreshes++;
    if (type === NOTIFICATIONS_FLUSHED) notificationsFlushed++;
    if (type === "openclaw_prompt_result") {
      const agentName = str(payload.agentName);
      if (agentName) lastOpenClawAgentName = agentName;
    }
    if (type === "openclaw_binary_probe") {
      lastOpenClawProbe = payload;
    }

    const detail = type === PUBLISH_RESULT
      ? (bool(payload.ok) === true ? "publish ok" : str(payload.error) ?? "publish failed")
      : type.startsWith("directive_") ? str(payload.directiveId) : type === CHAT_AUTO_REPLY ? str(payload.replyToMessageId) : type === MEMORY_REFRESH ? str(payload.source) : null;
    recentEvents.push({ at, type, detail });
  }

  const inboundIds = new Set<string>();
  for (const row of inboxRecords) {
    const envelopeMsg = isRecord(row.message) ? row.message as Record<string, unknown> : null;
    const nested = envelopeMsg && isRecord(envelopeMsg.message) ? envelopeMsg.message as Record<string, unknown> : envelopeMsg;
    const msgId = str(nested?.id);
    if (msgId) { inboundIds.add(msgId); lastInboundAt = iso(row.at) ?? iso(row.receivedAt) ?? lastInboundAt; }
  }

  const ws = latestDebug && isRecord(latestDebug.ws) ? latestDebug.ws as Record<string, unknown> : null;
  const auth = latestDebug && isRecord(latestDebug.auth) ? latestDebug.auth as Record<string, unknown> : null;
  const authUser = auth && isRecord(auth.user) ? auth.user as Record<string, unknown> : null;
  const perm = latestDebug && isRecord(latestDebug.permission) ? latestDebug.permission as Record<string, unknown> : null;
  const pub = latestDebug && isRecord(latestDebug.publish) ? latestDebug.publish as Record<string, unknown> : null;

  const tiers = temporal && isRecord(temporal.tiers) ? temporal.tiers as Record<string, unknown> : null;
  const t24 = tiers && isRecord(tiers["24h"]) ? tiers["24h"] as Record<string, unknown> : null;
  const t7d = tiers && isRecord(tiers["7d"]) ? tiers["7d"] as Record<string, unknown> : null;
  const t30d = tiers && isRecord(tiers["30d"]) ? tiers["30d"] as Record<string, unknown> : null;
  const t365d = tiers && isRecord(tiers["365d"]) ? tiers["365d"] as Record<string, unknown> : null;

  const available = Boolean(latestDebug || chatStatus || mood || temporal);
  const snapshot: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    available,
    reason: available ? null : "No runtime state files found yet.",
    stateDir,
    files,
    runtime: {
      wsState: str(ws?.state), wsTransportState: str(ws?.transportState), wsAt: iso(ws?.at),
      wsActivityAt: iso(ws?.activityAt), wsActivitySource: str(ws?.activitySource),
      authState: str(auth?.state), authEffective: str(auth?.authEffective) ?? str(auth?.effective) ?? str(auth?.status),
      permissionState: str(perm?.state) ?? str(perm?.status), permissionReason: str(perm?.reason) ?? str(perm?.detail),
      lastEnvelopeAt: iso(latestDebug?.lastEnvelopeAt), lastPublishAt: iso(pub?.at),
      lastPublishOk: bool(pub?.ok), lastPublishError: str(pub?.error),
    },
    chatBridge: {
      connected: bool(chatStatus?.connected), state: str(chatStatus?.state), updatedAt: iso(chatStatus?.updatedAt),
      subscribedTopics: Array.isArray(chatStatus?.subscribedTopics) ? (chatStatus.subscribedTopics as unknown[]).length : 0,
      subscriptionMode: str(chatStatus?.subscriptionMode),
      requestedTopicCounts: isRecord(chatStatus?.requestedTopicCounts)
        ? (chatStatus?.requestedTopicCounts as Record<string, unknown>)
        : null,
      subscribedTopicCounts: isRecord(chatStatus?.subscribedTopicCounts)
        ? (chatStatus?.subscribedTopicCounts as Record<string, unknown>)
        : null,
      lastShellSummary: isRecord(chatStatus?.lastShellSummary)
        ? (chatStatus?.lastShellSummary as Record<string, unknown>)
        : null,
      lastTicketFailures: Array.isArray(chatStatus?.lastTicketFailures)
        ? (chatStatus?.lastTicketFailures as unknown[])
        : [],
      lastError: str(chatStatus?.lastError), lastEventAt: iso(chatStatus?.lastEventAt),
      runtimeReadOffset: num(chatRuntimeState?.readOffset),
      runtimeLastProcessedMessageId: str(chatRuntimeState?.lastProcessedMessageId),
      runtimeLastProcessedAt: iso(chatRuntimeState?.lastProcessedAt),
    },
    agent: {
      userId:
        str(chatStatus?.viewerMainUserId) ??
        str(auth?.userId) ??
        str(auth?.mainUserId) ??
        str(authUser?.id),
      handle:
        str(agentIdentity?.handle) ??
        str(auth?.handle) ??
        str(authUser?.handle),
      name:
        str(agentIdentity?.name) ??
        str(auth?.name) ??
        str(authUser?.name),
      profileSet: Boolean(
        str(agentIdentity?.handle) ??
          str(agentIdentity?.name) ??
          str(agentIdentity?.bio),
      ),
      bio: str(agentIdentity?.bio),
      personality: str(agentIdentity?.personality),
      identityUpdatedAt: iso(agentIdentity?.updatedAt),
      openClawAgentName: lastOpenClawAgentName,
      openClawBinaryCommand: str(lastOpenClawProbe?.command),
      openClawBinarySource: str(lastOpenClawProbe?.source),
      openClawBinaryOk: bool(lastOpenClawProbe?.probeOk),
      openClawBinaryVersion: str(lastOpenClawProbe?.probeVersion),
      openClawBinaryError: str(lastOpenClawProbe?.probeError),
    },
    memory: {
      moodPrimary: str(mood?.primary), moodScore: num(mood?.score), moodUpdatedAt: iso(mood?.updatedAt),
      temporalUpdatedAt: iso(temporal?.updatedAt),
      tier24hEvents: num(t24?.eventCount), tier7dEvents: num(t7d?.eventCount),
      tier30dEvents: num(t30d?.eventCount), tier365dEvents: num(t365d?.eventCount),
      tier30dCompressedBy: str(t30d?.compressedBy), tier365dCompressedBy: str(t365d?.compressedBy),
    },
    activity: {
      scannedWrites: writeRecords.length, scannedInbox: inboxRecords.length,
      publishSuccess, publishFailed, directivesStaged, directivesExecuted, directivesFailed,
      chatMessagesReceived: inboundIds.size, chatAutoRepliesSent: chatAutoReplies,
      memoryRefreshes, notificationsFlushed,
      lastDirectiveAt, lastPublishAt, lastInboundMessageAt: lastInboundAt, lastAutoReplyAt,
      recentEvents: recentEvents.slice(-12).reverse(),
    },
  };

  const publicSnapshot = buildPublicProjection(snapshot);
  try {
    const db = getStateDb();
    db.upsertSnapshot({
      scope: "health.public.v1",
      visibility: "public",
      at: iso(snapshot.generatedAt) ?? null,
      data: publicSnapshot,
    });
    db.upsertSnapshot({
      scope: "health.private.v1",
      visibility: "private",
      at: iso(snapshot.generatedAt) ?? null,
      data: snapshot,
    });
  } catch {
    // best effort: keep file-based health available
  }

  return snapshot;
};

// ---------------------------------------------------------------------------
// HTML dashboard (inline)
// ---------------------------------------------------------------------------

const HTML_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Agent Health</title>
<style>
:root{--bg:#f5f7fb;--card:#fff;--ink:#0f172a;--muted:#475569;--line:#dbe3ef;--ok:#15803d;--warn:#a16207;--bad:#b91c1c}
*{box-sizing:border-box}body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:linear-gradient(145deg,#eef3ff,#f8fafc);color:var(--ink)}
.wrap{max-width:1100px;margin:24px auto;padding:0 16px;display:grid;gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;box-shadow:0 8px 22px rgba(15,23,42,.06)}
.top{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.h1{font-size:22px;font-weight:700;margin:2px 0}.muted{color:var(--muted);font-size:13px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 10px;font-size:13px}.k{color:var(--muted)}
.badge{display:inline-block;padding:3px 8px;border-radius:999px;font-weight:600;font-size:12px}
.ok{background:#dcfce7;color:var(--ok)}.warn{background:#fef3c7;color:var(--warn)}.bad{background:#fee2e2;color:var(--bad)}.neutral{background:#e2e8f0;color:#334155}
.list{display:grid;gap:8px}.evt{border:1px solid var(--line);border-radius:10px;padding:8px;font-size:13px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
</style></head><body>
<div class="wrap">
<div class="card top"><div><div class="muted">Agent Host</div><div class="h1">Read-Only Health</div></div><div class="muted" id="ts">refreshing...</div></div>
<div class="grid">
<div class="card"><div class="muted">Runtime</div><div id="rt"></div></div>
<div class="card"><div class="muted">Chat Bridge</div><div id="cb"></div></div>
<div class="card"><div class="muted">Agent</div><div id="ag"></div></div>
<div class="card"><div class="muted">Memory</div><div id="mm"></div></div>
<div class="card"><div class="muted">Activity</div><div id="ac"></div></div>
</div>
<div class="card"><div class="muted">Recent Events</div><div id="events" class="list"></div></div>
<div class="card"><div class="muted">State Paths</div><div id="paths" class="kv"></div></div>
</div>
<script>
const esc=v=>String(v??'n/a').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const badge=v=>{const s=(v??'').toString().toLowerCase();if(['open','ok','ready','true'].includes(s))return['ok',v??'ok'];if(['pending','connecting','reconnecting'].includes(s))return['warn',v??'pending'];if(!s||s==='null'||s==='undefined')return['neutral','n/a'];return['bad',v??'down']};
const fmt=iso=>{if(!iso)return'n/a';const ms=Date.parse(iso);return Number.isFinite(ms)?new Date(ms).toLocaleString():'n/a'};
const kv=obj=>Object.entries(obj).map(([k,v])=>'<div class="k">'+esc(k)+'</div><div>'+esc(v??'n/a')+'</div>').join('');
const fmtTopicCounts=v=>{if(!v||typeof v!=='object')return'n/a';const o=v;return ['user','conversation','channel','server'].map(k=>k+':'+String(o[k]??0)).join(' · ')};
const shellCounts=v=>{if(!v||typeof v!=='object')return'n/a';const c=v.counts; if(!c||typeof c!=='object')return'n/a'; return ['dms','agentDms','groups','servers','channels'].map(k=>k+':'+String(c[k]??0)).join(' · ')};
const qs=new URLSearchParams(window.location.search);const k=(qs.get('key')??'').trim();const healthUrl=k?('/api/health/private?key='+encodeURIComponent(k)):'/api/health';
const render=snap=>{if(!snap)return;document.getElementById('ts').textContent='updated '+fmt(snap.generatedAt)+(snap.available===false&&snap.reason?' · '+snap.reason:'');
const[rC,rT]=badge(snap.runtime?.wsState);document.getElementById('rt').innerHTML='<div class="badge '+esc(rC)+'">'+esc(rT)+'</div><div class="kv" style="margin-top:8px">'+kv({auth:snap.runtime?.authEffective,permission:snap.runtime?.permissionState,wsTransport:snap.runtime?.wsTransportState,lastEnvelope:fmt(snap.runtime?.lastEnvelopeAt),lastPublish:fmt(snap.runtime?.lastPublishAt),publishError:snap.runtime?.lastPublishError??'none'})+'</div>';
const[cC,cT]=badge(snap.chatBridge?.connected===true?'ready':(snap.chatBridge?.state??'unknown'));document.getElementById('cb').innerHTML='<div class="badge '+esc(cC)+'">'+esc(cT)+'</div><div class="kv" style="margin-top:8px">'+kv({connected:String(snap.chatBridge?.connected),mode:snap.chatBridge?.subscriptionMode,topics:snap.chatBridge?.subscribedTopics,requested:fmtTopicCounts(snap.chatBridge?.requestedTopicCounts),subscribed:fmtTopicCounts(snap.chatBridge?.subscribedTopicCounts),shell:shellCounts(snap.chatBridge?.lastShellSummary),ticketFailures:snap.chatBridge?.lastTicketFailureCount,lastError:snap.chatBridge?.lastError??'none'})+'</div>';
document.getElementById('ag').innerHTML='<div class="kv">'+kv({userId:snap.agent?.userId,handle:snap.agent?.handle,name:snap.agent?.name,openclawAgent:snap.agent?.openClawAgentName,openclawBinOk:String(snap.agent?.openClawBinaryOk),openclawBinSource:snap.agent?.openClawBinarySource,openclawBinVersion:snap.agent?.openClawBinaryVersion??'n/a',openclawBinError:snap.agent?.openClawBinaryError??'none',identityUpdated:fmt(snap.agent?.identityUpdatedAt)})+'</div>';
document.getElementById('mm').innerHTML='<div class="kv">'+kv({mood:snap.memory?.moodPrimary,moodScore:snap.memory?.moodScore,tier24h:snap.memory?.tier24hEvents,tier7d:snap.memory?.tier7dEvents})+'</div>';
document.getElementById('ac').innerHTML='<div class="kv">'+kv({publishOk:snap.activity?.publishSuccess,publishFail:snap.activity?.publishFailed,directives:snap.activity?.directivesExecuted,messages:snap.activity?.chatMessagesReceived,autoReplies:snap.activity?.chatAutoRepliesSent})+'</div>';
const evts=Array.isArray(snap.activity?.recentEvents)?snap.activity.recentEvents:[];document.getElementById('events').innerHTML=evts.length?evts.map(e=>'<div class="evt"><strong>'+esc(e?.type)+'</strong><br/><span class="muted">'+esc(e?.detail??'-')+' · '+esc(fmt(e?.at))+'</span></div>').join(''):'<div class="muted">No recent events.</div>';
const files=snap.files&&typeof snap.files==='object'?snap.files:{};const pathRows=Object.entries(files);document.getElementById('paths').innerHTML=pathRows.length?pathRows.map(([k,v])=>'<div class="k">'+esc(k)+'</div><div><code>'+esc(v)+'</code></div>').join(''):'<div class="muted">Public projection only. Add ?key=... for private view.</div>'};
const tick=async()=>{try{const r=await fetch(healthUrl,{cache:'no-store'});render(await r.json())}catch(e){document.getElementById('ts').textContent='refresh failed: '+e}};
void tick();setInterval(tick,3000);
</script></body></html>`;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const json = (res: http.ServerResponse, code: number, value: unknown): void => {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
};

const main = async (): Promise<void> => {
  await loadDotEnv();
  const db = getStateDb();

  const host = trimEnv("MG_AGENT_HEALTH_HOST") ?? "127.0.0.1";
  const port = Math.max(1, Math.min(65_535, parseIntEnv("MG_AGENT_HEALTH_PORT", 4278)));
  const privateKey = trimEnv("MG_AGENT_HEALTH_PRIVATE_KEY");

  const hasPrivateAccess = (req: http.IncomingMessage, url: URL): boolean => {
    if (!privateKey) return true;
    const fromQuery = (url.searchParams.get("key") ?? "").trim();
    const fromHeader = (req.headers["x-agent-health-key"] ?? "").toString().trim();
    return fromQuery === privateKey || fromHeader === privateKey;
  };

  const server = http.createServer(async (req, res) => {
    if ((req.method ?? "GET").toUpperCase() !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    if (url.pathname === "/api/health") {
      try {
        const fresh = await buildSnapshot();
        json(res, 200, buildPublicProjection(fresh));
        return;
      } catch {
        const fromDb = db.getSnapshot<Record<string, unknown>>("health.public.v1");
        if (fromDb && isRecord(fromDb)) {
          json(res, 200, fromDb);
          return;
        }
      }
      json(res, 500, { ok: false, error: "health_unavailable" });
      return;
    }
    if (url.pathname === "/api/health/private") {
      if (!hasPrivateAccess(req, url)) {
        json(res, 403, {
          ok: false,
          error: "forbidden",
          message: "Missing or invalid health private key.",
        });
        return;
      }
      try {
        json(res, 200, await buildSnapshot());
        return;
      } catch {
        const fromDb = db.getSnapshot<Record<string, unknown>>("health.private.v1");
        if (fromDb && isRecord(fromDb)) {
          json(res, 200, fromDb);
          return;
        }
      }
      json(res, 500, { ok: false, error: "health_unavailable" });
      return;
    }
    if (url.pathname !== "/") { res.statusCode = 404; res.end("Not Found"); return; }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(HTML_PAGE);
  });

  server.listen(port, host, () => {
    process.stdout.write(`[agent-health-web] listening on http://${host}:${port}\n`);
    process.stdout.write(`[agent-health-web] stateDir=${resolveStateDir()}\n`);
  });

  const shutdown = (): void => {
    db.close();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

void main();
