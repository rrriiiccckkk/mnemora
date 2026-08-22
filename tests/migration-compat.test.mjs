import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "@photostructure/sqlite";
import { GraphologyStore } from "../dist/index.js";
import { inspectDatabaseCompatibility, SUPPORTED_SCHEMA_VERSION } from "../dist/operations/migration.js";

test("compatibility accepts current databases and rejects corrupt or forward schemas", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-migration-"));
  try {
    const current = join(directory, "current.sqlite"), store = new GraphologyStore(current); store.close();
    assert.deepEqual(inspectDatabaseCompatibility(current), { compatible: true, schema_version: SUPPORTED_SCHEMA_VERSION });
    const forward = join(directory, "forward.sqlite"), db = new DatabaseSync(forward); db.exec(`PRAGMA user_version=${SUPPORTED_SCHEMA_VERSION + 1}`); db.close();
    assert.throws(() => inspectDatabaseCompatibility(forward), /unsupported_schema/);
    const corrupt = join(directory, "corrupt.sqlite"); writeFileSync(corrupt, "not sqlite");
    assert.throws(() => inspectDatabaseCompatibility(corrupt), /invalid_artifact/);
  } finally { try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (error) { if (process.platform !== "win32" || error?.code !== "EPERM") throw error; } }
});

test("v1.3 migrates analytical records to a persisted default scope", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-migration-scope-"));
  try {
    const path = join(directory, "v12.sqlite"), db = new DatabaseSync(path);
    db.exec(`CREATE TABLE kg_watches (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_plan TEXT NOT NULL,
      plan_hash TEXT NOT NULL, schedule_hint TEXT NOT NULL, cursor TEXT,
      enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); PRAGMA user_version=12`);
    db.prepare("INSERT INTO kg_watches(id,name,normalized_plan,plan_hash,schedule_hint,cursor,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("watch:legacy", "legacy", JSON.stringify({ version: 1, steps: [{ op: "lookup", query: "company:legacy", mode: "lexical" }], order_by: "name", limit: 1 }), "hash", "manual", null, 1, 1, 1);
    db.close();
    const store = new GraphologyStore(path);
    try {
      const version = store.db.prepare("PRAGMA user_version").get().user_version;
      assert.equal(version, SUPPORTED_SCHEMA_VERSION);
      assert.equal(store.getWatch("watch:legacy")?.scope, "default");
      for (const table of ["kg_insight_snapshots", "kg_query_runs", "kg_watches", "kg_digest_runs"]) {
        assert.equal((store.db.prepare(`PRAGMA table_info(${table})`).all()).some(column => column.name === "scope"), true, table);
      }
    } finally { store.close(); }
  } finally { try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (error) { if (process.platform !== "win32" || error?.code !== "EPERM") throw error; } }
});
