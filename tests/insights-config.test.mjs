import { createTempDir } from "./helpers/temp.mjs";
import assert from "node:assert/strict";

import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "@photostructure/sqlite";
import { normalizeConfig } from "../dist/config.js";
import plugin from "../dist/plugin.js";
import { GraphologyStore } from "../dist/store.js";

function temporaryStore() {

  return new GraphologyStore(join(createTempDir("insights-test-"), "kg.db"));
}

test("insights defaults are bounded and exact", () => {
  assert.deepEqual(normalizeConfig({}).insights, {
    maxNodes: 10000,
    maxEdges: 50000,
    confidenceFloor: .6,
    recentWindowDays: 7,
    baselineWindowDays: 28,
    minEmergingEntities: 3,
    minEmergingGrowth: 2,
    maxPathLength: 4,
    maxResults: 20,
    explanationTimeoutMs: 10000,
    maxExplanationCandidates: 5
  });
});

test("insights limits clamp to their safe runtime bounds", () => {
  const insights = normalizeConfig({
    insights: {
      maxNodes: 0,
      maxEdges: 999999,
      confidenceFloor: -1,
      recentWindowDays: 0,
      baselineWindowDays: 999999,
      minEmergingEntities: 0,
      minEmergingGrowth: Number.MAX_VALUE,
      maxPathLength: 99,
      maxResults: 0,
      explanationTimeoutMs: 999999,
      maxExplanationCandidates: 99
    }
  }).insights;

  assert.deepEqual({
    maxNodes: insights.maxNodes,
    maxEdges: insights.maxEdges,
    confidenceFloor: insights.confidenceFloor,
    recentWindowDays: insights.recentWindowDays,
    baselineWindowDays: insights.baselineWindowDays,
    minEmergingEntities: insights.minEmergingEntities,
    minEmergingGrowth: insights.minEmergingGrowth,
    maxPathLength: insights.maxPathLength,
    maxResults: insights.maxResults,
    explanationTimeoutMs: insights.explanationTimeoutMs,
    maxExplanationCandidates: insights.maxExplanationCandidates
  }, {
    maxNodes: 1,
    maxEdges: 50000,
    confidenceFloor: 0,
    recentWindowDays: 1,
    baselineWindowDays: 3650,
    minEmergingEntities: 1,
    minEmergingGrowth: Number.MAX_SAFE_INTEGER,
    maxPathLength: 4,
    maxResults: 1,
    explanationTimeoutMs: 60000,
    maxExplanationCandidates: 5
  });
});

test("insights TypeBox configuration publishes matching bounds", () => {
  assert.equal(plugin.configSchema.safeParse({ insights: { maxNodes: 0 } }).success, false);
  assert.equal(plugin.configSchema.safeParse({ insights: { maxNodes: 10000, maxEdges: 50000, confidenceFloor: .6, recentWindowDays: 7, baselineWindowDays: 28, minEmergingEntities: 3, minEmergingGrowth: 2, maxPathLength: 4, maxResults: 20, explanationTimeoutMs: 10000, maxExplanationCandidates: 5 } }).success, true);
});

test("store initializes graph revision and insight cache tables", () => {
  const store = temporaryStore();
  try {
    assert.equal(store.graphRevision(), 0);
    // kg_insights was removed in 1.38.0; the table stays for the Inspector's read-only research page.
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='kg_insight_snapshots'").get().value, 1);
  } finally {
    store.close();
  }
});

test("graph revision increments atomically", () => {
  const store = temporaryStore();
  try {
    store.bumpGraphRevision();
    store.bumpGraphRevision();
    assert.equal(store.graphRevision(), 2);
  } finally {
    store.close();
  }
});

test("existing databases migrate graph revision and insight cache tables", () => {

  const dbPath = join(createTempDir("insights-legacy-"), "kg.db");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE kg_nodes (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    aliases TEXT NOT NULL DEFAULT '[]', embedding BLOB, importance REAL NOT NULL DEFAULT 0,
    deleted_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  legacy.prepare("INSERT INTO kg_nodes VALUES (?,?,?,?,?,NULL,0,NULL,?,?)")
    .run("company:legacy", "company", "Legacy", "preserved", "[]", 1, 1);
  legacy.close();

  const store = new GraphologyStore(dbPath);
  try {
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('kg_graph_state','kg_insight_snapshots') ORDER BY name").all().map(row => row.name);
    assert.deepEqual(tables, ["kg_graph_state", "kg_insight_snapshots"]);
    assert.equal(store.getNodeById("company:legacy")?.name, "Legacy");
    assert.equal(store.graphRevision(), 0);
  } finally {
    store.close();
  }
});

test("successful ingestion bumps revision once while no-op maintenance writes do not", () => {
  const store = temporaryStore();
  try {
    const entity = { name: "Nvidia", type: "company", confidence: .9, evidence_span: "Nvidia" };
    const ingested = store.ingest([entity], [], "fixture:revision");
    assert.equal(store.graphRevision(), 1);

    assert.equal(store.ingestOnce([entity], [], "fixture:revision").skipped, true);
    store.scanDuplicateCandidates();
    store.putEmbedding(ingested.entities[0].node.id, { provider: "ollama", model: "tiny", dimensions: 2 }, "node-v1", [1, 0]);
    store.ingest([], [], "fixture:no-op");
    assert.equal(store.graphRevision(), 1);
  } finally {
    store.close();
  }
});

test("confirmed quality cleanup bumps revision once", () => {
  const store = temporaryStore();
  try {
    const ingested = store.ingest([{ name: "Nvidia", type: "company", confidence: .9, evidence_span: "Nvidia" }], [], "fixture:cleanup");
    const now = Date.now();
    const nodeId = ingested.entities[0].node.id;
    store.db.prepare(`INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at)
      VALUES(?,?,?,?,?,0,NULL,?,?)`).run("edge:self", nodeId, nodeId, "competes_with", "{}", now, now);

    const preview = store.cleanupAnomalies(["edge:self"], false);
    assert.equal(store.graphRevision(), 1);
    store.cleanupAnomalies(["edge:self"], true, preview.preview_hash);
    assert.equal(store.graphRevision(), 2);
  } finally {
    store.close();
  }
});

test("empty confirmed quality cleanup preserves graph revision", () => {
  const store = temporaryStore();
  try {
    const preview = store.cleanupAnomalies([], false);
    const cleaned = store.cleanupAnomalies([], true, preview.preview_hash);
    assert.equal(cleaned.cleaned, 0);
    assert.equal(store.graphRevision(), 0);
  } finally {
    store.close();
  }
});

test("successful forget bumps revision once", () => {
  const store = temporaryStore();
  try {
    const ingested = store.ingest([{ name: "Nvidia", type: "company", confidence: .9, evidence_span: "Nvidia" }], [], "fixture:forget");
    store.forget(ingested.entities[0].node.id);
    assert.equal(store.graphRevision(), 2);
  } finally {
    store.close();
  }
});

test("confirmed merge and merge undo bump revision once each", () => {
  const store = temporaryStore();
  try {
    const ingested = store.ingest([
      { name: "Nvidia Corporation", type: "company", confidence: .9, evidence_span: "Nvidia Corporation" },
      { name: "Nvidia Corp", type: "company", confidence: .9, evidence_span: "Nvidia Corp" }
    ], [], "fixture:merge-revision");
    const [canonicalId, duplicateId] = ingested.entities.map(item => item.node.id);
    const mergePreview = store.merge(canonicalId, duplicateId, false);
    const merged = store.merge(canonicalId, duplicateId, true, mergePreview.preview_hash);
    assert.equal(store.graphRevision(), 2);

    const undoPreview = store.undoMerge(merged.audit_id, false);
    store.undoMerge(merged.audit_id, true, undoPreview.preview_hash);
    assert.equal(store.graphRevision(), 3);
  } finally {
    store.close();
  }
});
