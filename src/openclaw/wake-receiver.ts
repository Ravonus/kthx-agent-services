/**
 * Standalone HTTP webhook receiver for OpenClaw wake events.
 *
 * Ported from openclaw-wake-receiver.mjs.
 *
 * Receives wake POSTs from the Molkgram WS runtime and:
 *   1) Appends wake events to a durable JSONL queue file.
 *   2) Optionally forwards them to an OpenClaw gateway webhook endpoint.
 *
 * Security:
 *   If MG_OPENCLAW_WAKE_KEY is set, incoming requests must include
 *   x-mg-wake-ts and x-mg-wake-sig headers where
 *   sig = hex(HMAC_SHA256(key, ts + "." + rawBody)).
 *
 * Env:
 *   OPENCLAW_WAKE_HOST, OPENCLAW_WAKE_PORT, OPENCLAW_WAKE_ROUTE
 *   MG_OPENCLAW_WAKE_KEY, OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { loadDotEnv } from "../config/dotenv.js";
import { trimEnv, parseIntEnv } from "../lib/env-parse.js";
import { isRecord } from "../lib/guards.js";
import { sleep } from "../lib/async.js";
import { nowIso } from "../lib/text.js";
import { appendJsonLine, ensureDir } from "../lib/fs-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const timingSafeHexEqual = (left: string, right: string): boolean => {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (left.length !== right.length) return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

type ParsedBody = { raw: string; json: unknown };

const readJsonBody = (req: IncomingMessage, maxBytes = 64 * 1024): Promise<ParsedBody> =>
  new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { reject(new Error("Payload too large.")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim().length) { resolve({ raw, json: null }); return; }
      try { resolve({ raw, json: JSON.parse(raw) as unknown }); } catch { reject(new Error("Invalid JSON body.")); }
    });
    req.on("error", reject);
  });

const respond = (res: ServerResponse, code: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
};

// ---------------------------------------------------------------------------
// Wake hint builder
// ---------------------------------------------------------------------------

const buildDefaultHint = (wake: Record<string, unknown>): string => {
  const reason = typeof wake.reason === "string" ? wake.reason : "";
  const sd = typeof wake.stateDir === "string" ? wake.stateDir : "./state";

  if (reason === "media_request_prepared") return `Media payload is prepared. Monitor ${sd}/ipc/results.jsonl and ${sd}/ipc/events.jsonl.`;
  if (reason === "mention_directive") {
    const src = typeof wake.source === "string" ? wake.source : "message";
    const mode = ["image", "request", "reply"].includes(src) ? src : "message";
    return `Agent mention directive received (${mode}). Monitor ${sd}/ipc/results.jsonl and ${sd}/ipc/events.jsonl.`;
  }
  if (reason === "socket_challenge_required") return `Challenge required. Open the runtime terminal and answer the prompt.`;
  if (reason === "terminal_prompt_required") return `Runtime prompt requires input. Open the runtime terminal now.`;
  if (reason === "terminal_probe_written") return `Tunnel probe write completed. Check ${sd}/ipc/probes/tunnel-write-probe.txt.`;
  if (reason === "socket_state_change") return `Socket state changed; verify runtime health and connectivity.`;
  if (reason === "socket_subscription_error") return `Socket subscription failed. Inspect runtime terminal and state logs.`;
  if (reason === "actionable_batch") {
    const reasons = Array.isArray(wake.reasons) ? (wake.reasons as unknown[]).filter((v): v is string => typeof v === "string" && v.trim().length > 0).join(", ") : "";
    return reasons.length ? `Batched actionable wake reasons: ${reasons}.` : "Batched actionable wake events.";
  }
  return `Check ${sd}/ipc/events.jsonl.`;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  await loadDotEnv();

  const host = trimEnv("OPENCLAW_WAKE_HOST") ?? "127.0.0.1";
  const port = parseIntEnv("OPENCLAW_WAKE_PORT", 7072);
  const route = trimEnv("OPENCLAW_WAKE_ROUTE") ?? "/mg/wake";
  const wakeKey = trimEnv("MG_OPENCLAW_WAKE_KEY");
  const stateDirBase = trimEnv("MG_AGENT_STATE_DIR") ?? path.resolve(process.cwd(), "kthx-agents", "state");
  const queuePath = trimEnv("OPENCLAW_WAKE_QUEUE_PATH") ?? path.join(stateDirBase, "ipc", "openclaw-wake-queue.jsonl");
  const gatewayUrl = trimEnv("OPENCLAW_GATEWAY_URL");
  const gatewayToken = trimEnv("OPENCLAW_GATEWAY_TOKEN");
  const gatewayTimeoutMs = parseIntEnv("OPENCLAW_GATEWAY_TIMEOUT_MS", 3000);

  // Signature verification
  const verifySignature = (headers: http.IncomingHttpHeaders, rawBody: string): { ok: boolean; error?: string } => {
    if (!wakeKey) return { ok: true };

    const tsRaw = headers["x-mg-wake-ts"];
    const sigRaw = headers["x-mg-wake-sig"];
    const ts = typeof tsRaw === "string" ? Number.parseInt(tsRaw, 10) : Number.NaN;
    const sig = typeof sigRaw === "string" ? sigRaw.trim() : "";
    if (!Number.isFinite(ts) || !sig.length) return { ok: false, error: "Missing wake signature headers." };
    if (Math.abs(Date.now() - ts) > 60_000) return { ok: false, error: "Wake signature timestamp expired." };

    const expected = crypto.createHmac("sha256", wakeKey).update(`${ts}.${rawBody}`).digest("hex");
    if (!timingSafeHexEqual(sig, expected)) return { ok: false, error: "Wake signature mismatch." };
    return { ok: true };
  };

  // Gateway forwarding with retry
  const sendGatewayWake = async (wake: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> => {
    if (!gatewayUrl) return { ok: false, reason: "gateway_not_configured" };

    const hint = typeof wake.hint === "string" && wake.hint.trim().length ? wake.hint.trim() : buildDefaultHint(wake);
    const text = `Molkgram wake: ${wake.reason} arrived. ${hint}`;
    const bodyRaw = JSON.stringify({ text, mode: "now" });

    const retryDelays = [250, 1_000, 5_000];
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < retryDelays.length; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), gatewayTimeoutMs);
      try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (gatewayToken) headers.authorization = `Bearer ${gatewayToken}`;
        const res = await fetch(gatewayUrl, { method: "POST", headers, body: bodyRaw, signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) return { ok: true };
        lastError = new Error(`Gateway returned ${res.status}.`);
      } catch (e) {
        clearTimeout(timeout);
        lastError = e instanceof Error ? e : new Error(String(e));
      }
      if (attempt < retryDelays.length - 1) await sleep(retryDelays[attempt]!);
    }

    return { ok: false, reason: lastError?.message ?? "gateway_failed" };
  };

  // Ensure queue directory exists
  await ensureDir(path.dirname(queuePath));

  // HTTP server
  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    if (method === "GET" && (url === "/health" || url === "/healthz")) {
      respond(res, 200, { ok: true, at: nowIso() });
      return;
    }
    if (method !== "POST" || url !== route) {
      respond(res, 404, { ok: false, error: "Not found." });
      return;
    }

    let parsed: ParsedBody;
    try {
      parsed = await readJsonBody(req);
    } catch (e) {
      respond(res, 400, { ok: false, error: e instanceof Error ? e.message : "Invalid request body." });
      return;
    }

    const sigCheck = verifySignature(req.headers, parsed.raw);
    if (!sigCheck.ok) { respond(res, 401, { ok: false, error: sigCheck.error }); return; }
    if (!isRecord(parsed.json) || (parsed.json as Record<string, unknown>).type !== "mg_wake") {
      respond(res, 400, { ok: false, error: "Body must be a mg_wake object." });
      return;
    }

    const body = parsed.json as Record<string, unknown>;
    const wake: Record<string, unknown> = {
      type: "mg_wake",
      requestId: typeof body.requestId === "string" && body.requestId.trim().length ? body.requestId.trim() : null,
      reason: typeof body.reason === "string" ? body.reason : "unknown",
      topic: typeof body.topic === "string" ? body.topic : "",
      receivedAt: typeof body.receivedAt === "string" ? body.receivedAt : nowIso(),
      eventId: typeof body.eventId === "string" && body.eventId.trim().length ? body.eventId.trim() : null,
      stateDir: typeof body.stateDir === "string" && body.stateDir.trim().length ? body.stateDir.trim() : "./state",
      hint: typeof body.hint === "string" && body.hint.trim().length ? body.hint.trim() : null,
      source: typeof body.source === "string" && body.source.trim().length ? body.source.trim() : null,
      inboxFiles: Array.isArray(body.inboxFiles)
        ? (body.inboxFiles as unknown[]).filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter((v) => v.length > 0).slice(0, 20)
        : [],
    };

    await appendJsonLine(queuePath, { at: nowIso(), wake }).catch((e: unknown) => {
      console.warn("[openclaw-wake] failed to append queue entry (non-fatal)", e instanceof Error ? e.message : e);
    });

    const gatewayResult = await sendGatewayWake(wake);
    if (!gatewayResult.ok && gatewayResult.reason !== "gateway_not_configured") {
      console.warn("[openclaw-wake] gateway delivery failed; queued only", gatewayResult.reason);
    }

    const delivered = gatewayResult.ok ? "gateway+queue" : gatewayResult.reason === "gateway_not_configured" ? "queue_only" : "queue_fallback";
    respond(res, 200, { ok: true, delivered, queuedPath: queuePath, at: nowIso() });
  });

  server.listen(port, host, () => {
    console.log(`[openclaw-wake] listening on http://${host}:${port}${route} (queue=${queuePath}${gatewayUrl ? ", gateway=enabled" : ", gateway=disabled"})`);
  });

  const shutdown = (signal: string): void => {
    console.log(`[openclaw-wake] shutting down on ${signal}`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

await main();
