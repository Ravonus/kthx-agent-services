import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import { StateSqliteStore } from "./sqlite-state.js";

import type { DatabaseSync } from "node:sqlite";

const nodeRequire = createRequire(import.meta.url);
const sqliteModule = nodeRequire("node:sqlite") as {
  DatabaseSync: typeof DatabaseSync;
};

const tmpDirs: string[] = [];

const createLegacyRuntimeStateDb = (): { dbPath: string } => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-sqlite-migrate-"));
  tmpDirs.push(tmpDir);
  const dbPath = path.join(tmpDir, "state.sqlite");
  const db = new sqliteModule.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE runtime_command_lifecycle (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command_id TEXT NOT NULL,
      directive_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_post_id INTEGER,
      target_comment_id INTEGER,
      target_hash TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.close();
  return { dbPath };
};

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("StateSqliteStore schema migration", () => {
  it("adds required runtime lifecycle columns for legacy sqlite files", () => {
    const { dbPath } = createLegacyRuntimeStateDb();
    const store = new StateSqliteStore({
      enabled: true,
      dbPath,
      busyTimeoutMs: 50,
      busyRetryCount: 0,
    });
    store.init();

    store.upsertCommandLifecycle({
      commandId: "cmd-1",
      directiveId: "dir-1",
      action: "write.votePost",
      idempotencyKey: "idem-1",
      state: "queued",
      sourceKind: "chat",
      grantId: "grant-1",
      payload: { source: "test" },
    });
    store.close();

    const migratedDb = new sqliteModule.DatabaseSync(dbPath);
    const rows = migratedDb.prepare(
      "PRAGMA table_info(runtime_command_lifecycle)",
    ).all() as unknown[];
    const columns = new Set(
      rows
        .filter(
          (row): row is Record<string, unknown> =>
            typeof row === "object" && row !== null && !Array.isArray(row),
        )
        .map((row) =>
          typeof row.name === "string" ? row.name.trim() : "",
        )
        .filter((name) => name.length > 0),
    );

    expect(columns.has("source_kind")).toBe(true);
    expect(columns.has("grant_id")).toBe(true);
    expect(columns.has("payload_json")).toBe(true);

    const storedRow = migratedDb.prepare(
      "SELECT source_kind, grant_id, payload_json FROM runtime_command_lifecycle WHERE idempotency_key = ? LIMIT 1",
    ).get("idem-1") as {
      source_kind: string | null;
      grant_id: string | null;
      payload_json: string | null;
    } | undefined;
    expect(storedRow).toBeDefined();
    expect(storedRow?.source_kind).toBe("chat");
    expect(storedRow?.grant_id).toBe("grant-1");
    expect(storedRow?.payload_json).toBe(JSON.stringify({ source: "test" }));

    const appliedMigrations = migratedDb.prepare(
      "SELECT id, name FROM state_schema_migrations ORDER BY id ASC",
    ).all() as Array<{ id: number; name: string }>;
    expect(appliedMigrations).toEqual([
      {
        id: 1,
        name: "runtime_command_lifecycle_add_source_kind_grant_id_payload_json",
      },
    ]);

    migratedDb.close();

    const secondStore = new StateSqliteStore({
      enabled: true,
      dbPath,
      busyTimeoutMs: 50,
      busyRetryCount: 0,
    });
    secondStore.init();
    secondStore.close();

    const reopenedDb = new sqliteModule.DatabaseSync(dbPath);
    const migrationCountRow = reopenedDb.prepare(
      "SELECT COUNT(*) AS total FROM state_schema_migrations WHERE id = 1",
    ).get() as { total: number } | undefined;
    expect(migrationCountRow?.total).toBe(1);
    reopenedDb.close();
  });
});
