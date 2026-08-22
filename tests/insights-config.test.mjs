import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "@photostructure/sqlite";
import { normalizeConfig } from "../dist/config.js";
import plugin from "../dist/plugin.js";
import { GraphologyStore } from "../dist/store.js";

function temporaryStore() {
  const root = join(process.cwd(), ".tmp");
  mkdirSync(root, { recursive: true });
  return new GraphologyStore(join(mkdtempSync(join(root, "insights-test-")), "kg.db"));
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
  const snapshot = { graphRevision: 0, algorithmVersion: "test", createdAt: 1,
    truncated: false, communities: [], insights: [], warnings: [] };
  try {
    assert.equal(store.graphRevision(), 0);
    assert.doesNotThrow(() => store.writeInsightSnapshot("key", snapshot));
    assert.deepEqual(store.readInsightSnapshot("key"), snapshot);
  } finally {
    store.close();
  }
});

test("insight snapshots reject legacy snake_case metadata", () => {
  const store = temporaryStore();
  try {
    assert.throws(() => store.writeInsightSnapshot("legacy", {
      graph_revision: 0,
      algorithm_version: "test",
      generated_at: 1,
      truncated: false,
      communities: [],
      insights: [],
      warnings: []
    }), /invalid insight snapshot/);
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
  const root = join(process.cwd(), ".tmp");
  mkdirSync(root, { recursive: true });
  const dbPath = join(mkdtempSync(join(root, "insights-legacy-")), "kg.db");
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

test("insight snapshots never persist optional explanations", () => {
  const store = temporaryStore();
  const snapshot = {
    graphRevision: 1,
    algorithmVersion: "test",
    createdAt: 1,
    truncated: false,
    communities: [],
    insights: [{
      id: "insight:1", kind: "knowledge_gap", score: 1,
      community_ids: [], entity_ids: ["company:nvidia"], relationship_ids: [],
      reason: "weak_evidence", signals: { confidence: .2 }, explanation: "generated explanation"
    }],
    warnings: []
  };
  try {
    store.writeInsightSnapshot("without-explanation", snapshot);
    assert.deepEqual(store.readInsightSnapshot("without-explanation")?.insights, [{
      id: "insight:1", kind: "knowledge_gap", score: 1,
      community_ids: [], entity_ids: ["company:nvidia"], relationship_ids: [],
      reason: "weak_evidence", signals: { confidence: .2 }
    }]);
  } finally {
    store.close();
  }
});

test("insight snapshots whitelist deterministic fields at runtime", () => {
  const store = temporaryStore();
  const snapshot = {
    graphRevision: 1,
    algorithmVersion: "test",
    createdAt: 1,
    truncated: false,
    quote: "runtime-quote",
    payload: { marker: "runtime-payload" },
    url: "https://runtime.invalid/snapshot",
    conversation: "runtime-conversation",
    communities: [{
      id: "community:1", entity_ids: ["company:nvidia"], size: 1, internal_edge_count: 0,
      density: 0, average_confidence: .9, evidence_coverage: 1, source_concentration: 1,
      recent_growth: 0, bridge_score: 0, quote: "runtime-community-quote"
    }],
    insights: [{
      id: "insight:1", kind: "knowledge_gap", score: 1,
      community_ids: ["community:1"], entity_ids: ["company:nvidia"], relationship_ids: [],
      reason: "weak_evidence", signals: { confidence: .2 }, quote: "runtime-insight-quote",
      payload: { marker: "runtime-insight-payload" }, url: "https://runtime.invalid/insight",
      conversation: "runtime-insight-conversation",
      path: { entity_ids: ["company:nvidia", "company:mnemora"], edge_ids: ["edge:1"], quote: "runtime-path-quote" }
    }],
    warnings: [{ category: "test", url: "https://runtime.invalid/warning" }]
  };
  try {
    store.writeInsightSnapshot("whitelist", snapshot);
    const stored = store.db.prepare("SELECT snapshot FROM kg_insight_snapshots WHERE cache_key=?").get("whitelist").snapshot;
    const read = store.readInsightSnapshot("whitelist");
    for (const marker of ["runtime-quote", "runtime-payload", "runtime-conversation", "runtime-community-quote", "runtime-insight-quote", "runtime-insight-payload", "runtime-insight-conversation", "runtime.invalid"]) {
      assert.equal(stored.includes(marker), false);
      assert.equal(JSON.stringify(read).includes(marker), false);
    }
    assert.deepEqual(read.insights[0].path, { entity_ids: ["company:nvidia", "company:mnemora"], edge_ids: ["edge:1"] });
  } finally {
    store.close();
  }
});
