import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { trimEnv } from "../lib/env-parse.js";
import { isRecord } from "../lib/guards.js";
import { nowIso } from "../lib/text.js";

import type { DatabaseSync, StatementSync } from "node:sqlite";

const nodeRequire = createRequire(import.meta.url);
const sqliteModule = nodeRequire("node:sqlite") as {
  DatabaseSync: typeof DatabaseSync;
};

export type StateVisibility = "public" | "private";

type SnapshotRow = {
  scope: string;
  visibility: StateVisibility;
  updatedAt: string;
  json: string;
};

type EventRow = {
  id: number;
  source: string;
  topic: string;
  eventType: string;
  visibility: StateVisibility;
  at: string;
  json: string;
};

type StateDbConfig = {
  enabled: boolean;
  dbPath: string;
  busyTimeoutMs: number;
  busyRetryCount: number;
};

const parseBool = (value: string | null, fallback: boolean): boolean => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const parseIntEnv = (value: string | null, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
};

const safeJsonStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify({ error: "serialize_failed" });
  }
};

const safeJsonParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

export class StateSqliteStore {
  readonly enabled: boolean;
  readonly dbPath: string;
  readonly busyTimeoutMs: number;
  readonly busyRetryCount: number;

  private db: DatabaseSync | null;
  private initialized: boolean;
  private lastBusyWarnAtMs: number;

  private upsertSnapshotStmt: StatementSync | null;
  private insertEventStmt: StatementSync | null;
  private getSnapshotStmt: StatementSync | null;
  private getRecentEventsStmt: StatementSync | null;

  constructor(config: StateDbConfig) {
    this.enabled = config.enabled;
    this.dbPath = path.resolve(config.dbPath);
    this.busyTimeoutMs = Math.max(0, Math.floor(config.busyTimeoutMs));
    this.busyRetryCount = Math.max(0, Math.floor(config.busyRetryCount));
    this.db = null;
    this.initialized = false;
    this.lastBusyWarnAtMs = 0;
    this.upsertSnapshotStmt = null;
    this.insertEventStmt = null;
    this.getSnapshotStmt = null;
    this.getRecentEventsStmt = null;
  }

  init(): void {
    if (!this.enabled || this.initialized) return;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });
    const db = new sqliteModule.DatabaseSync(this.dbPath);
    try {
      fs.chmodSync(this.dbPath, 0o600);
    } catch {
      // best effort
    }
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec("PRAGMA synchronous=NORMAL;");
    db.exec(`PRAGMA busy_timeout=${this.busyTimeoutMs};`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS state_snapshots (
        scope TEXT PRIMARY KEY,
        visibility TEXT NOT NULL CHECK (visibility IN ('public','private')),
        updated_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS state_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        topic TEXT NOT NULL,
        event_type TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('public','private')),
        at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_state_events_at ON state_events(at DESC);
      CREATE INDEX IF NOT EXISTS idx_state_events_visibility_at ON state_events(visibility, at DESC);
    `);
    this.db = db;
    this.upsertSnapshotStmt = db.prepare(`
      INSERT INTO state_snapshots (scope, visibility, updated_at, json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        visibility = excluded.visibility,
        updated_at = excluded.updated_at,
        json = excluded.json
    `);
    this.insertEventStmt = db.prepare(`
      INSERT INTO state_events (source, topic, event_type, visibility, at, json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.getSnapshotStmt = db.prepare(`
      SELECT scope, visibility, updated_at AS updatedAt, json
      FROM state_snapshots
      WHERE scope = ?
      LIMIT 1
    `);
    this.getRecentEventsStmt = db.prepare(`
      SELECT id, source, topic, event_type AS eventType, visibility, at, json
      FROM state_events
      WHERE visibility = ?
      ORDER BY id DESC
      LIMIT ?
    `);
    this.initialized = true;
  }

  private isBusyOrLockedError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const text = error.message.toLowerCase();
    return (
      text.includes("database is locked") ||
      text.includes("database is busy") ||
      text.includes("sqlite_busy") ||
      text.includes("sqlite_locked")
    );
  }

  private warnBusyOncePerWindow(context: string, error: Error): void {
    const now = Date.now();
    if (now - this.lastBusyWarnAtMs < 5_000) return;
    this.lastBusyWarnAtMs = now;
    console.warn(`[state-sqlite] busy/locked (${context}); dropping state write/read this cycle`, {
      dbPath: this.dbPath,
      busyTimeoutMs: this.busyTimeoutMs,
      busyRetryCount: this.busyRetryCount,
      error: error.message,
    });
  }

  private runWithBusyRetry<T>(context: string, fallback: T, op: () => T): T {
    const attempts = this.busyRetryCount + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return op();
      } catch (error) {
        if (!this.isBusyOrLockedError(error)) throw error;
        if (error instanceof Error) this.warnBusyOncePerWindow(`${context}#${attempt}`, error);
        if (attempt >= attempts) return fallback;
      }
    }
    return fallback;
  }

  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
    this.initialized = false;
    this.upsertSnapshotStmt = null;
    this.insertEventStmt = null;
    this.getSnapshotStmt = null;
    this.getRecentEventsStmt = null;
  }

  upsertSnapshot(input: {
    scope: string;
    visibility: StateVisibility;
    at?: string | null;
    data: unknown;
  }): void {
    if (!this.enabled) return;
    this.init();
    if (!this.upsertSnapshotStmt) return;
    const at = typeof input.at === "string" && input.at.trim().length > 0
      ? input.at.trim()
      : nowIso();
    this.runWithBusyRetry<void>("upsertSnapshot", undefined, () => {
      this.upsertSnapshotStmt?.run(
        input.scope,
        input.visibility,
        at,
        safeJsonStringify(input.data),
      );
    });
  }

  appendEvent(input: {
    source: string;
    topic: string;
    eventType: string;
    visibility: StateVisibility;
    at?: string | null;
    payload: unknown;
  }): void {
    if (!this.enabled) return;
    this.init();
    if (!this.insertEventStmt) return;
    const at = typeof input.at === "string" && input.at.trim().length > 0
      ? input.at.trim()
      : nowIso();
    this.runWithBusyRetry<void>("appendEvent", undefined, () => {
      this.insertEventStmt?.run(
        input.source,
        input.topic,
        input.eventType,
        input.visibility,
        at,
        safeJsonStringify(input.payload),
      );
    });
  }

  getSnapshot<T>(scope: string): T | null {
    if (!this.enabled) return null;
    this.init();
    const rowUnknown = this.runWithBusyRetry<unknown>(
      "getSnapshot",
      null,
      () => this.getSnapshotStmt?.get(scope) as unknown,
    );
    if (!isRecord(rowUnknown)) return null;
    const row = rowUnknown as unknown as SnapshotRow;
    const parsed = safeJsonParse(row.json);
    return parsed as T;
  }

  getRecentEvents(limit: number, visibility: StateVisibility): Array<Record<string, unknown>> {
    if (!this.enabled) return [];
    this.init();
    if (!this.getRecentEventsStmt) return [];
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
    const rowsUnknown = this.runWithBusyRetry<unknown>(
      "getRecentEvents",
      [],
      () => this.getRecentEventsStmt?.all(visibility, bounded) as unknown,
    );
    if (!Array.isArray(rowsUnknown)) return [];
    const rows = rowsUnknown as unknown as EventRow[];
    const out: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const payload = safeJsonParse(row.json);
      out.push({
        id: row.id,
        source: row.source,
        topic: row.topic,
        eventType: row.eventType,
        visibility: row.visibility,
        at: row.at,
        payload,
      });
    }
    return out;
  }
}

export const createStateSqliteStoreFromEnv = (stateDir: string): StateSqliteStore => {
  const enabled = parseBool(trimEnv("MG_AGENT_STATE_DB_ENABLED"), true);
  const pathFromEnv = trimEnv("MG_AGENT_STATE_DB_PATH");
  const busyTimeoutRaw = trimEnv("MG_AGENT_STATE_DB_BUSY_TIMEOUT_MS");
  const busyRetryRaw = trimEnv("MG_AGENT_STATE_DB_BUSY_RETRY_COUNT");
  const busyTimeoutMs = Math.max(0, parseIntEnv(busyTimeoutRaw, 5000));
  const busyRetryCount = Math.max(0, parseIntEnv(busyRetryRaw, 2));
  const dbPath = pathFromEnv
    ? path.resolve(pathFromEnv)
    : path.resolve(stateDir, "ipc", "state.sqlite");
  return new StateSqliteStore({
    enabled,
    dbPath,
    busyTimeoutMs,
    busyRetryCount,
  });
};
