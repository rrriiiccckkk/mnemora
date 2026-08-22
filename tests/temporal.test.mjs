import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "@photostructure/sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { GraphologyStore } from "../dist/store.js";
import { intervalsOverlap, isCurrentlyApplicable, normalizeTemporalEvidence, recencyScore } from "../dist/temporal.js";

function pathFor(name) {
  const root = join(process.cwd(), ".tmp");
  mkdirSync(root, { recursive: true });
  return join(mkdtempSync(join(root, `${name}-`)), "kg.db");
}

test("temporal evidence normalizes strict dates, timestamps, and milliseconds", () => {
  assert.deepEqual(normalizeTemporalEvidence({ valid_from: "2026-01-01", valid_to: "2026-01-31", temporal_confidence: .8 }), {
    valid_from: Date.parse("2026-01-01T00:00:00.000Z"),
    valid_to: Date.parse("2026-01-31T23:59:59.999Z"),
    temporal_confidence: .8
  });
  assert.deepEqual(normalizeTemporalEvidence({ valid_from: "2026-01-01T08:00:00+08:00", valid_to: 1767225600000 }), {
    valid_from: Date.parse("2026-01-01T00:00:00.000Z"), valid_to: 1767225600000, temporal_confidence: null
  });
  assert.deepEqual(normalizeTemporalEvidence({}), { valid_from: null, valid_to: null, temporal_confidence: null });
});

test("temporal evidence rejects ambiguous or reversed values", () => {
  for (const input of [
    { valid_from: "01/02/2026" },
    { valid_from: "2026-01-01T00:00:00" },
    { valid_from: Number.NaN },
    { valid_from: "2026-02-01", valid_to: "2026-01-01" }
  ]) assert.equal(normalizeTemporalEvidence(input), undefined);
});

test("temporal intervals are inclusive and open-ended", () => {
  assert.equal(intervalsOverlap({ valid_from: 10, valid_to: 20 }, { valid_from: 20, valid_to: 30 }), true);
  assert.equal(intervalsOverlap({ valid_from: null, valid_to: 9 }, { valid_from: 10, valid_to: null }), false);
  assert.equal(intervalsOverlap({ valid_from: null, valid_to: null }, { valid_from: 10, valid_to: 20 }), true);
  assert.equal(isCurrentlyApplicable({ valid_from: 10, valid_to: 20 }, 10), true);
  assert.equal(isCurrentlyApplicable({ valid_from: 10, valid_to: 20 }, 21), false);
});

test("recency uses a half-life and unknown time is neutral", () => {
  const now = Date.parse("2026-07-14T00:00:00Z");
  assert.equal(recencyScore({ reference_time: now - 90 * 86400000 }, now, 90), .5);
  assert.equal(recencyScore({ reference_time: null }, now, 90), .5);
  assert.equal(recencyScore({ reference_time: now + 1000 }, now, 90), 1);
});

test("ingestion persists normalized temporal evidence on entity and relation observations", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const result = store.ingest([
      { name: "Nvidia", type: "company", confidence: .9, evidence_span: "Nvidia", valid_from: "2026-01-01", temporal_confidence: .8 },
      { name: "TSMC", type: "company", confidence: .9, evidence_span: "TSMC" }
    ], [
      { source: "TSMC", target: "Nvidia", type: "competes_with", confidence: .9, evidence_span: "competes", valid_to: "2026-12-31", temporal_confidence: .7 }
    ], "fixture");
    const rows = result.observations.map(({ valid_from, valid_to, temporal_confidence }) => ({ valid_from, valid_to, temporal_confidence }));
    assert.deepEqual(rows, [
      { valid_from: Date.parse("2026-01-01T00:00:00Z"), valid_to: null, temporal_confidence: .8 },
      { valid_from: null, valid_to: null, temporal_confidence: null },
      { valid_from: null, valid_to: Date.parse("2026-12-31T23:59:59.999Z"), temporal_confidence: .7 }
    ]);
    const persisted = store.db.prepare("SELECT valid_from,valid_to,temporal_confidence FROM kg_observations").all().map(row => ({ ...row }));
    assert.deepEqual(persisted.map(JSON.stringify).sort(), rows.map(JSON.stringify).sort());
  } finally { store.close(); }
});

test("legacy observation tables gain nullable temporal columns without data loss", () => {
  const dbPath = pathFor("temporal-migration");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE kg_nodes (
    id TEXT PRIMARY KEY, type TEXT, name TEXT, description TEXT, aliases TEXT,
    importance REAL, deleted_at INTEGER, created_at INTEGER, updated_at INTEGER
  )`);
  legacy.exec(`CREATE TABLE kg_observations (
    id TEXT PRIMARY KEY, edge_id TEXT, source_entity_id TEXT, payload TEXT NOT NULL DEFAULT '{}',
    source TEXT NOT NULL, quote TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);
  legacy.prepare("INSERT INTO kg_observations VALUES (?,?,?,?,?,?,?,?)")
    .run("obs:legacy", null, "company:nvidia", "{}", "legacy", "quote", .9, 100);
  legacy.prepare("INSERT INTO kg_nodes VALUES (?,?,?,?,?,?,?,?,?)")
    .run("company:nvidia", "company", "NVIDIA", "", "[]", 0, null, 1, 1);
  legacy.close();

  const store = new GraphologyStore(dbPath);
  try {
    assert.deepEqual({ ...store.db.prepare("SELECT valid_from,valid_to,temporal_confidence,scope FROM kg_observations WHERE id='obs:legacy'").get() }, {
      valid_from: null, valid_to: null, temporal_confidence: null, scope: "default"
    });
  } finally { store.close(); }
});
