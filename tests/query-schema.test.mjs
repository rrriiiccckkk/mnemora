import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { GraphologyStore } from "../dist/store.js";

test("existing databases gain v0.9 tables without losing graph data", () => {
  const root = join(process.cwd(), ".tmp");
  mkdirSync(root, { recursive: true });
  const dbPath = join(mkdtempSync(join(root, "query-schema-")), "kg.db");
  let store = new GraphologyStore(dbPath);
  store.ingest([{ name: "Apple", type: "company", confidence: 1, evidence_span: "Apple" }], [], "fixture");
  store.close();
  store = new GraphologyStore(dbPath);
  try {
    assert.equal(store.resolveEntity("company:apple").id, "company:apple");
    for (const table of ["kg_query_runs", "kg_watches", "kg_digest_runs", "kg_import_previews"])
      assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
  } finally { store.close(); }
});

test("v0.9 persistence status columns are closed", () => {
  const root = join(process.cwd(), ".tmp");
  mkdirSync(root, { recursive: true });
  const store = new GraphologyStore(join(mkdtempSync(join(root, "query-status-")), "kg.db"));
  try {
    assert.throws(() => store.db.prepare("INSERT INTO kg_query_runs VALUES (?,?,?,?,?,?,?,?,?)").run("q", "h", "{}", "unknown", 0, 0, 0, null, 1));
    assert.throws(() => store.db.prepare("INSERT INTO kg_watches VALUES (?,?,?,?,?,?,?,?,?)").run("w", "n", "{}", "h", "daily", null, 2, 1, 1));
    assert.throws(() => store.db.prepare("INSERT INTO kg_digest_runs(idempotency_key,status,watch_ids,started_at) VALUES (?,?,?,?)").run("d", "unknown", "[]", 1));
  } finally { store.close(); }
});
