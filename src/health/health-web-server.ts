import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { loadDotEnv } from "../config/dotenv.js";
import { parseIntEnv, trimEnv } from "../lib/env-parse.js";
import { isRecord } from "../lib/guards.js";

import { buildMemoryEngagementDiagnostics } from "./health-web-diagnostics-memory-engagement.js";
import { buildMemoryMapDiagnostics } from "./health-web-diagnostics-memory-map.js";
import { buildRetrievalDiagnostics } from "./health-web-diagnostics-retrieval.js";
import {
  GRAPH_PAGE,
  HTML_PAGE,
  MAP_PAGE,
  METRICS_PAGE,
  PIPELINE_PAGE,
} from "./health-web-pages.js";
import {
  applyRetentionPatchFromQuery,
  readKthxConfig,
} from "./health-web-retention.js";
import {
  buildPipelineDiagnostics,
  buildRuntimeMetricsDiagnostics,
  getStateDb,
  parseJsonLines,
  readJsonRecord,
  readTailLines,
  resolveStateDir,
} from "./health-web-runtime-pipeline.js";
import {
  intFromUnknown,
  normalizeKeywordIndex,
  normalizeLongTermArchiveIndex,
  parseMetricsBucketMsFromQuery,
  parseRetrievalIntent,
  parseTopParticipantMetric,
  resolveRangeMsFromQuery,
  str,
  TAIL_MAX_BYTES,
  TAIL_MAX_LINES,
} from "./health-web-shared.js";
import {
  buildPublicProjection,
  buildSnapshot,
} from "./health-web-snapshot.js";

const json = (res: http.ServerResponse, code: number, value: unknown): void => {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
};

export const startHealthWebServer = async (): Promise<void> => {
  await loadDotEnv();
  const db = getStateDb();

  const host = trimEnv("MG_AGENT_HEALTH_HOST") ?? "127.0.0.1";
  const port = Math.max(1, Math.min(65_535, parseIntEnv("MG_AGENT_HEALTH_PORT", 4278)));
  const privateKey = trimEnv("MG_AGENT_HEALTH_PRIVATE_KEY");

  const isLocalRequest = (req: http.IncomingMessage): boolean => {
    const remoteRaw = (req.socket?.remoteAddress ?? "").trim().toLowerCase();
    if (!remoteRaw) return false;
    if (remoteRaw === "127.0.0.1" || remoteRaw === "::1" || remoteRaw === "::ffff:127.0.0.1") {
      return true;
    }
    return remoteRaw.startsWith("127.") || remoteRaw.startsWith("::ffff:127.");
  };

  const hasPrivateAccess = (req: http.IncomingMessage): boolean => {
    if (isLocalRequest(req)) return true;
    if (!privateKey) return true;
    const fromHeader = (
      req.headers["x-agent-health-key"] ??
      req.headers["x-health-key"] ??
      ""
    )
      .toString()
      .trim();
    return fromHeader === privateKey;
  };

  const handleRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
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
      if (!hasPrivateAccess(req)) {
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
    if (url.pathname === "/api/health/retrieval") {
      if (!hasPrivateAccess(req)) {
        json(res, 403, {
          ok: false,
          error: "forbidden",
          message: "Missing or invalid health private key.",
        });
        return;
      }
      try {
        const snapshot = await buildSnapshot();
        const files = isRecord(snapshot.files)
          ? snapshot.files
          : {};
        const agentRecord = isRecord(snapshot.agent) ? snapshot.agent : null;
        const keywordPath =
          str(files.keywordIndex) ??
          path.join(resolveStateDir(), "memory", "context", "keyword-index.json");
        const longTermArchivePath =
          str(files.longTermArchiveIndex) ??
          path.join(
            resolveStateDir(),
            "memory",
            "context",
            "long-term-archive-index.json",
          );
        const keywordIndex = normalizeKeywordIndex(
          await readJsonRecord(keywordPath),
        );
        const longTermIndex = normalizeLongTermArchiveIndex(
          await readJsonRecord(longTermArchivePath),
        );
        const intent = parseRetrievalIntent(url.searchParams.get("intent"));
        const diagnostics = buildRetrievalDiagnostics({
          index: keywordIndex,
          longTermIndex,
          query: (url.searchParams.get("q") ?? "").trim(),
          intent,
          postId: intFromUnknown(url.searchParams.get("postId")),
          commentId: intFromUnknown(url.searchParams.get("commentId")),
          limit: intFromUnknown(url.searchParams.get("limit")) ?? 12,
          agentHandle: str(agentRecord?.handle),
          agentName: str(agentRecord?.name),
        });
        json(res, 200, {
          ok: true,
          generatedAt: new Date().toISOString(),
          stateDir: resolveStateDir(),
          keywordIndexPath: keywordPath,
          longTermArchiveIndexPath: longTermArchivePath,
          keywordIndexUpdatedAt: keywordIndex.updatedAt,
          ...diagnostics,
        });
        return;
      } catch (error: unknown) {
        json(res, 500, {
          ok: false,
          error: "retrieval_debug_unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    if (url.pathname === "/api/health/memory-engagement") {
      if (!hasPrivateAccess(req)) {
        json(res, 403, {
          ok: false,
          error: "forbidden",
          message: "Missing or invalid health private key.",
        });
        return;
      }
      try {
        const snapshot = await buildSnapshot();
        const files = isRecord(snapshot.files) ? snapshot.files : {};
        const keywordPath =
          str(files.keywordIndex) ??
          path.join(resolveStateDir(), "memory", "context", "keyword-index.json");
        const keywordIndex = normalizeKeywordIndex(
          await readJsonRecord(keywordPath),
        );
        const diagnostics = buildMemoryEngagementDiagnostics({
          index: keywordIndex,
          rangeMs: resolveRangeMsFromQuery(url.searchParams),
          metric: parseTopParticipantMetric(url.searchParams.get("metric")),
          limit: intFromUnknown(url.searchParams.get("limit")) ?? 10,
          postId: intFromUnknown(url.searchParams.get("postId")),
          commentId: intFromUnknown(url.searchParams.get("commentId")),
          intent: parseRetrievalIntent(url.searchParams.get("intent")),
        });
        json(res, 200, {
          ok: true,
          generatedAt: new Date().toISOString(),
          stateDir: resolveStateDir(),
          keywordIndexPath: keywordPath,
          keywordIndexUpdatedAt: keywordIndex.updatedAt,
          ...diagnostics,
        });
        return;
      } catch (error: unknown) {
        json(res, 500, {
          ok: false,
          error: "memory_engagement_unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    if (url.pathname === "/api/health/memory-map") {
      if (!hasPrivateAccess(req)) {
        json(res, 403, {
          ok: false,
          error: "forbidden",
          message: "Missing or invalid health private key.",
        });
        return;
      }
      try {
        const snapshot = await buildSnapshot();
        const files = isRecord(snapshot.files) ? snapshot.files : {};
        const keywordPath =
          str(files.keywordIndex) ??
          path.join(resolveStateDir(), "memory", "context", "keyword-index.json");
        const longTermArchivePath =
          str(files.longTermArchiveIndex) ??
          path.join(
            resolveStateDir(),
            "memory",
            "context",
            "long-term-archive-index.json",
          );
        const keywordIndex = normalizeKeywordIndex(
          await readJsonRecord(keywordPath),
        );
        const longTermIndex = normalizeLongTermArchiveIndex(
          await readJsonRecord(longTermArchivePath),
        );
        const diagnostics = buildMemoryMapDiagnostics({
          index: keywordIndex,
          longTermIndex,
          rangeMs: resolveRangeMsFromQuery(url.searchParams),
          metric: parseTopParticipantMetric(url.searchParams.get("metric")),
          limit: intFromUnknown(url.searchParams.get("limit")) ?? 20,
          postId: intFromUnknown(url.searchParams.get("postId")),
          commentId: intFromUnknown(url.searchParams.get("commentId")),
          intent: parseRetrievalIntent(url.searchParams.get("intent")),
          query: (url.searchParams.get("q") ?? "").trim(),
        });
        json(res, 200, {
          ok: true,
          generatedAt: new Date().toISOString(),
          stateDir: resolveStateDir(),
          keywordIndexPath: keywordPath,
          longTermArchiveIndexPath: longTermArchivePath,
          keywordIndexUpdatedAt: keywordIndex.updatedAt,
          longTermArchiveUpdatedAt: longTermIndex.updatedAt,
          ...diagnostics,
        });
        return;
      } catch (error: unknown) {
        json(res, 500, {
          ok: false,
          error: "memory_map_unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    if (url.pathname === "/api/health/metrics") {
      if (!hasPrivateAccess(req)) {
        json(res, 403, {
          ok: false,
          error: "forbidden",
          message: "Missing or invalid health private key.",
        });
        return;
      }
      try {
        const snapshot = await buildSnapshot();
        const files = isRecord(snapshot.files) ? snapshot.files : {};
        const writesPath =
          str(files.writes) ?? path.join(resolveStateDir(), "writes.jsonl");
        const inboxPath =
          str(files.chatInbox) ??
          path.join(resolveStateDir(), "ipc", "chat", "inbox.jsonl");
        const writeLines = await readTailLines(
          writesPath,
          TAIL_MAX_BYTES,
          TAIL_MAX_LINES,
        );
        const inboxLines = await readTailLines(
          inboxPath,
          TAIL_MAX_BYTES,
          TAIL_MAX_LINES,
        );
        const writeRecords = parseJsonLines(writeLines);
        const inboxRecords = parseJsonLines(inboxLines);
        const rangeMs = resolveRangeMsFromQuery(url.searchParams);
        const diagnostics = buildRuntimeMetricsDiagnostics({
          writeRecords,
          inboxRecords,
          rangeMs,
          bucketMs: parseMetricsBucketMsFromQuery(url.searchParams, rangeMs),
        });
        json(res, 200, {
          ok: true,
          generatedAt: new Date().toISOString(),
          stateDir: resolveStateDir(),
          writesPath,
          inboxPath,
          scannedWrites: writeRecords.length,
          scannedInbox: inboxRecords.length,
          ...diagnostics,
        });
        return;
      } catch (error: unknown) {
        json(res, 500, {
          ok: false,
          error: "metrics_unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    if (url.pathname === "/api/health/pipeline") {
      if (!hasPrivateAccess(req)) {
        json(res, 403, {
          ok: false,
          error: "forbidden",
          message: "Missing or invalid health private key.",
        });
        return;
      }
      try {
        const snapshot = await buildSnapshot();
        const files = isRecord(snapshot.files) ? snapshot.files : {};
        const writesPath =
          str(files.writes) ?? path.join(resolveStateDir(), "writes.jsonl");
        const inboxPath =
          str(files.chatInbox) ??
          path.join(resolveStateDir(), "ipc", "chat", "inbox.jsonl");
        const notificationsPath =
          str(files.notifications) ??
          path.join(resolveStateDir(), "notifications.jsonl");
        const [writeLines, inboxLines, notificationLines] = await Promise.all([
          readTailLines(writesPath, Math.max(TAIL_MAX_BYTES, 450_000), TAIL_MAX_LINES * 2),
          readTailLines(inboxPath, Math.max(TAIL_MAX_BYTES, 450_000), TAIL_MAX_LINES * 2),
          readTailLines(
            notificationsPath,
            Math.max(TAIL_MAX_BYTES, 450_000),
            TAIL_MAX_LINES * 2,
          ),
        ]);
        const writeRecords = parseJsonLines(writeLines);
        const inboxRecords = parseJsonLines(inboxLines);
        const notificationRecords = parseJsonLines(notificationLines);
        let stateEvents: Record<string, unknown>[] = [];
        try {
          stateEvents = db.getRecentEvents(500, "private");
        } catch {
          stateEvents = [];
        }
        let lifecycleRows: Record<string, unknown>[] = [];
        try {
          lifecycleRows = db
            .getRecentCommandLifecycle(500)
            .map((row) => ({ ...row }));
        } catch {
          lifecycleRows = [];
        }
        const diagnostics = buildPipelineDiagnostics({
          writeRecords,
          stateEvents,
          inboxRecords,
          notificationRecords,
          lifecycleRows,
          rangeMs: resolveRangeMsFromQuery(url.searchParams),
        });
        json(res, 200, {
          ok: true,
          generatedAt: new Date().toISOString(),
          stateDir: resolveStateDir(),
          paths: {
            writes: writesPath,
            inbox: inboxPath,
            notifications: notificationsPath,
            sqlite: path.join(resolveStateDir(), "ipc", "state.sqlite"),
          },
          ...diagnostics,
        });
        return;
      } catch (error: unknown) {
        json(res, 500, {
          ok: false,
          error: "pipeline_unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    if (url.pathname === "/api/health/directive-lifecycle") {
      if (!hasPrivateAccess(req)) {
        json(res, 403, {
          ok: false,
          error: "forbidden",
          message: "Missing or invalid health private key.",
        });
        return;
      }
      try {
        const limitRaw = url.searchParams.get("limit");
        const limitParsed =
          typeof limitRaw === "string" ? Number.parseInt(limitRaw, 10) : Number.NaN;
        const limit =
          Number.isFinite(limitParsed) && limitParsed > 0
            ? Math.max(1, Math.min(200, Math.floor(limitParsed)))
            : 50;
        const rows = db.getRecentCommandLifecycle(limit);
        json(res, 200, {
          ok: true,
          generatedAt: new Date().toISOString(),
          count: rows.length,
          rows,
        });
        return;
      } catch (error: unknown) {
        json(res, 500, {
          ok: false,
          error: "directive_lifecycle_unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    if (url.pathname === "/api/health/retention") {
      if (!hasPrivateAccess(req)) {
        json(res, 403, {
          ok: false,
          error: "forbidden",
          message: "Missing or invalid health private key.",
        });
        return;
      }
      try {
        const stateDir = resolveStateDir();
        const { configPath, configRaw, retention } = await readKthxConfig(stateDir);
        const wantsSet = url.searchParams.has("set");
        if (wantsSet) {
          const patched = applyRetentionPatchFromQuery(configRaw, url.searchParams);
          if (patched.changed) {
            await fs.writeFile(
              configPath,
              `${JSON.stringify(configRaw, null, 2)}\n`,
              "utf8",
            );
          }
          json(res, 200, {
            ok: true,
            updated: patched.changed,
            configPath,
            retention: patched.retention,
          });
          return;
        }
        json(res, 200, {
          ok: true,
          configPath,
          retention,
        });
        return;
      } catch (error: unknown) {
        json(res, 500, {
          ok: false,
          error: "retention_unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    if (url.pathname === "/pipeline") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(PIPELINE_PAGE);
      return;
    }
    if (url.pathname === "/graphs") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(GRAPH_PAGE);
      return;
    }
    if (url.pathname === "/map") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(MAP_PAGE);
      return;
    }
    if (url.pathname === "/metrics") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(METRICS_PAGE);
      return;
    }
    if (url.pathname !== "/") { res.statusCode = 404; res.end("Not Found"); return; }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(HTML_PAGE);
  };
  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
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
