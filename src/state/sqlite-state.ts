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

export type CommandLifecycleState =
  | "queued"
  | "context_ready"
  | "llm_running"
  | "action_running"
  | "acked"
  | "failed"
  | "requeue";

type CommandLifecycleRow = {
  commandId: string;
  directiveId: string;
  action: string;
  targetPostId: number | null;
  targetCommentId: number | null;
  targetHash: string | null;
  idempotencyKey: string;
  state: CommandLifecycleState;
  attempts: number;
  lastError: string | null;
  sourceKind: string | null;
  grantId: string | null;
  createdAt: string;
  updatedAt: string;
  payloadJson: string | null;
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

type StateDbMigration = {
  id: number;
  name: string;
  apply(db: DatabaseSync): void;
};

const STATE_SCHEMA_MIGRATIONS_TABLE = "state_schema_migrations";

const listSqliteTableColumns = (db: DatabaseSync, tableName: string): Set<string> => {
  const normalizedTable = tableName.trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(normalizedTable)) return new Set();
  const stmt = db.prepare(`PRAGMA table_info(${normalizedTable})`);
  const rows = stmt.all() as unknown[];
  const columns = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (name.length > 0) {
      columns.add(name);
    }
  }
  return columns;
};

const ensureRuntimeCommandLifecycleCoreColumns = (db: DatabaseSync): void => {
  const tableName = "runtime_command_lifecycle";
  const columns = listSqliteTableColumns(db, tableName);
  const requiredColumns: Array<{ name: string; sqlType: string }> = [
    { name: "source_kind", sqlType: "TEXT" },
    { name: "grant_id", sqlType: "TEXT" },
    { name: "payload_json", sqlType: "TEXT" },
  ];
  for (const column of requiredColumns) {
    if (columns.has(column.name)) continue;
    db.exec(
      `ALTER TABLE ${tableName} ADD COLUMN ${column.name} ${column.sqlType};`,
    );
    columns.add(column.name);
  }
};

const ensureStateSchemaMigrationsTable = (db: DatabaseSync): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${STATE_SCHEMA_MIGRATIONS_TABLE} (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
};

const listAppliedStateMigrationIds = (db: DatabaseSync): Set<number> => {
  const stmt = db.prepare(
    `SELECT id FROM ${STATE_SCHEMA_MIGRATIONS_TABLE} ORDER BY id ASC`,
  );
  const rows = stmt.all() as unknown[];
  const applied = new Set<number>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const rawId = row.id;
    if (typeof rawId === "number" && Number.isFinite(rawId) && rawId > 0) {
      applied.add(Math.floor(rawId));
      continue;
    }
    if (typeof rawId === "string") {
      const parsed = Number.parseInt(rawId.trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        applied.add(parsed);
      }
    }
  }
  return applied;
};

const STATE_DB_MIGRATIONS: ReadonlyArray<StateDbMigration> = [
  {
    id: 1,
    name: "runtime_command_lifecycle_add_source_kind_grant_id_payload_json",
    apply: (db) => {
      ensureRuntimeCommandLifecycleCoreColumns(db);
    },
  },
];

const applyStateDbMigrations = (db: DatabaseSync): void => {
  ensureStateSchemaMigrationsTable(db);
  const appliedMigrationIds = listAppliedStateMigrationIds(db);
  const insertStmt = db.prepare(
    `INSERT INTO ${STATE_SCHEMA_MIGRATIONS_TABLE} (id, name, applied_at) VALUES (?, ?, ?)`,
  );
  for (const migration of STATE_DB_MIGRATIONS) {
    if (appliedMigrationIds.has(migration.id)) continue;
    db.exec("BEGIN");
    try {
      migration.apply(db);
      insertStmt.run(migration.id, migration.name, nowIso());
      db.exec("COMMIT");
      appliedMigrationIds.add(migration.id);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
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
  private upsertCommandLifecycleStmt: StatementSync | null;
  private getCommandLifecycleByKeyStmt: StatementSync | null;
  private getRecentCommandLifecycleStmt: StatementSync | null;

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
    this.upsertCommandLifecycleStmt = null;
    this.getCommandLifecycleByKeyStmt = null;
    this.getRecentCommandLifecycleStmt = null;
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
      CREATE TABLE IF NOT EXISTS runtime_command_lifecycle (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command_id TEXT NOT NULL,
        directive_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_post_id INTEGER,
        target_comment_id INTEGER,
        target_hash TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (
          state IN (
            'queued',
            'context_ready',
            'llm_running',
            'action_running',
            'acked',
            'failed',
            'requeue'
          )
        ),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        source_kind TEXT,
        grant_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_command_lifecycle_directive
        ON runtime_command_lifecycle(directive_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runtime_command_lifecycle_state
        ON runtime_command_lifecycle(state, updated_at DESC);
    `);
    applyStateDbMigrations(db);
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
    this.upsertCommandLifecycleStmt = db.prepare(`
      INSERT INTO runtime_command_lifecycle (
        command_id,
        directive_id,
        action,
        target_post_id,
        target_comment_id,
        target_hash,
        idempotency_key,
        state,
        attempts,
        last_error,
        source_kind,
        grant_id,
        created_at,
        updated_at,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        command_id = excluded.command_id,
        directive_id = excluded.directive_id,
        action = excluded.action,
        target_post_id = excluded.target_post_id,
        target_comment_id = excluded.target_comment_id,
        target_hash = excluded.target_hash,
        state = excluded.state,
        attempts = runtime_command_lifecycle.attempts + CASE
          WHEN excluded.attempts > 0 THEN excluded.attempts
          ELSE 0
        END,
        last_error = excluded.last_error,
        source_kind = COALESCE(excluded.source_kind, runtime_command_lifecycle.source_kind),
        grant_id = COALESCE(excluded.grant_id, runtime_command_lifecycle.grant_id),
        updated_at = excluded.updated_at,
        payload_json = COALESCE(excluded.payload_json, runtime_command_lifecycle.payload_json)
    `);
    this.getCommandLifecycleByKeyStmt = db.prepare(`
      SELECT
        command_id AS commandId,
        directive_id AS directiveId,
        action,
        target_post_id AS targetPostId,
        target_comment_id AS targetCommentId,
        target_hash AS targetHash,
        idempotency_key AS idempotencyKey,
        state,
        attempts,
        last_error AS lastError,
        source_kind AS sourceKind,
        grant_id AS grantId,
        created_at AS createdAt,
        updated_at AS updatedAt,
        payload_json AS payloadJson
      FROM runtime_command_lifecycle
      WHERE idempotency_key = ?
      LIMIT 1
    `);
    this.getRecentCommandLifecycleStmt = db.prepare(`
      SELECT
        command_id AS commandId,
        directive_id AS directiveId,
        action,
        target_post_id AS targetPostId,
        target_comment_id AS targetCommentId,
        target_hash AS targetHash,
        idempotency_key AS idempotencyKey,
        state,
        attempts,
        last_error AS lastError,
        source_kind AS sourceKind,
        grant_id AS grantId,
        created_at AS createdAt,
        updated_at AS updatedAt,
        payload_json AS payloadJson
      FROM runtime_command_lifecycle
      ORDER BY updated_at DESC
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
    this.upsertCommandLifecycleStmt = null;
    this.getCommandLifecycleByKeyStmt = null;
    this.getRecentCommandLifecycleStmt = null;
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

  upsertCommandLifecycle(input: {
    commandId: string;
    directiveId: string;
    action: string;
    targetPostId?: number | null;
    targetCommentId?: number | null;
    targetHash?: string | null;
    idempotencyKey: string;
    state: CommandLifecycleState;
    attemptDelta?: number;
    lastError?: string | null;
    sourceKind?: string | null;
    grantId?: string | null;
    at?: string | null;
    payload?: unknown;
  }): void {
    if (!this.enabled) return;
    this.init();
    if (!this.upsertCommandLifecycleStmt) return;
    const at = typeof input.at === "string" && input.at.trim().length > 0
      ? input.at.trim()
      : nowIso();
    const attemptDeltaRaw =
      typeof input.attemptDelta === "number" && Number.isFinite(input.attemptDelta)
        ? Math.floor(input.attemptDelta)
        : 0;
    const attemptDelta = Math.max(0, attemptDeltaRaw);
    this.runWithBusyRetry<void>("upsertCommandLifecycle", undefined, () => {
      this.upsertCommandLifecycleStmt?.run(
        input.commandId,
        input.directiveId,
        input.action,
        typeof input.targetPostId === "number" ? input.targetPostId : null,
        typeof input.targetCommentId === "number" ? input.targetCommentId : null,
        typeof input.targetHash === "string" ? input.targetHash : null,
        input.idempotencyKey,
        input.state,
        attemptDelta,
        typeof input.lastError === "string" ? input.lastError : null,
        typeof input.sourceKind === "string" ? input.sourceKind : null,
        typeof input.grantId === "string" ? input.grantId : null,
        at,
        at,
        input.payload === undefined ? null : safeJsonStringify(input.payload),
      );
    });
  }

  getCommandLifecycleByIdempotencyKey(
    idempotencyKey: string,
  ): CommandLifecycleRow | null {
    if (!this.enabled) return null;
    this.init();
    if (!this.getCommandLifecycleByKeyStmt) return null;
    const rowUnknown = this.runWithBusyRetry<unknown>(
      "getCommandLifecycleByIdempotencyKey",
      null,
      () => this.getCommandLifecycleByKeyStmt?.get(idempotencyKey) as unknown,
    );
    if (!isRecord(rowUnknown)) return null;
    const row = rowUnknown as unknown as CommandLifecycleRow;
    return {
      ...row,
      payloadJson:
        typeof row.payloadJson === "string" && row.payloadJson.trim().length > 0
          ? row.payloadJson
          : null,
    };
  }

  getRecentCommandLifecycle(limit: number): CommandLifecycleRow[] {
    if (!this.enabled) return [];
    this.init();
    if (!this.getRecentCommandLifecycleStmt) return [];
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
    const rowsUnknown = this.runWithBusyRetry<unknown>(
      "getRecentCommandLifecycle",
      [],
      () => this.getRecentCommandLifecycleStmt?.all(bounded) as unknown,
    );
    if (!Array.isArray(rowsUnknown)) return [];
    const rows = rowsUnknown as unknown as CommandLifecycleRow[];
    return rows.map((row) => ({
      ...row,
      payloadJson:
        typeof row.payloadJson === "string" && row.payloadJson.trim().length > 0
          ? row.payloadJson
          : null,
    }));
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
