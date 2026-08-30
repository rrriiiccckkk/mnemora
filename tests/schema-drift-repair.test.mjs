import assert from "node:assert/strict";
import test from "node:test";
import { Mnemora, GraphologyStore, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";

test("schema drift repair is scope-bound, preview-first, evidence-gated, and down-weighted", () => {
  const store = new GraphologyStore(":memory:");
  try {
    assert.equal(SUPPORTED_SCHEMA_VERSION, 73);
    const result = store.ingest([
      { name: "Widget", type: "product", confidence: .95, evidence_span: "Widget depends on Fabric." },
      { name: "Fabric", type: "technology", confidence: .95, evidence_span: "Widget depends on Fabric." }
    ], [{ source: "Widget", target: "Fabric", type: "works_at", confidence: .9, evidence_span: "Widget depends on Fabric." }], "manual:repair", 0, undefined, "work");
    assert.equal(result.relations.length, 1);
    const candidate = store.reviewSchemaDrift("work").items[0];
    assert.ok(candidate);
    const preview = store.previewSchemaDriftRepair(candidate.id, "depends_on", "work");
    assert.deepEqual({ confirmed: preview.confirmed, eligible: preview.eligible, type: preview.replacement_type }, { confirmed: false, eligible: true, type: "depends_on" });
    assert.throws(() => store.confirmSchemaDriftRepair(candidate.id, "depends_on", "wrong", "work"), /stale_schema_drift_repair_preview/);
    const admitted = store.confirmSchemaDriftRepair(candidate.id, "depends_on", preview.preview_hash, "work");
    assert.equal(admitted.confirmed, true);
    const edge = store.db.prepare("SELECT type,weight,edge_props FROM kg_edges WHERE id=?").get(admitted.edge_id);
    assert.equal(edge.type, "depends_on");
    assert.equal(JSON.parse(edge.edge_props).schema_drift_repair, true);
    assert.equal(Math.round(store.db.prepare("SELECT confidence,scope,source FROM kg_observations WHERE id=?").get(admitted.observation_id).confidence * 100), 72);
    assert.equal(store.db.prepare("SELECT scope FROM kg_observations WHERE id=?").get(admitted.observation_id).scope, "work");
    assert.equal(store.previewSchemaDriftRepair(candidate.id, "depends_on", "work").reason, "already_repaired");
    assert.equal(store.previewSchemaDriftRepair(candidate.id, "depends_on", "other").reason, "missing_candidate");
  } finally { store.close(); }
});

test("legacy schema-drift scan is cursor-bounded and confirmation retires only the reviewed invalid edge", () => {
  const store = new GraphologyStore(":memory:");
  try {
    store.ingest([
      { name: "Legacy Widget", type: "product", confidence: .95, evidence_span: "A product exists." },
      { name: "Legacy Fabric", type: "technology", confidence: .95, evidence_span: "A technology exists." }
    ], [], "manual:legacy", 0, undefined, "work");
    const source = store.db.prepare("SELECT id FROM kg_nodes WHERE name=?").get("Legacy Widget");
    const target = store.db.prepare("SELECT id FROM kg_nodes WHERE name=?").get("Legacy Fabric");
    const now = Date.now(), legacyId = "edge:legacy-invalid";
    store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,0,NULL,?,?)")
      .run(legacyId, source.id, target.id, "works_at", "{}", now, now);
    store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,scope,quote,confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("obs:legacy-invalid", legacyId, null, "{}", "legacy:source", "work", "Legacy Widget depends on Legacy Fabric.", .9, now);

    const scan = store.scanLegacySchemaDrift("work", undefined, 1);
    assert.deepEqual({ scanned: scan.scanned, created: scan.candidates_created, updated: scan.candidates_updated, next: scan.next_edge_id }, { scanned: 1, created: 1, updated: 0, next: legacyId });
    const candidate = store.reviewSchemaDrift("work", 10).items.find(item => item.legacy_edge_id === legacyId);
    assert.ok(candidate);
    const preview = store.previewSchemaDriftRepair(candidate.id, "depends_on", "work");
    assert.equal(preview.eligible, true);
    const confirmed = store.confirmSchemaDriftRepair(candidate.id, "depends_on", preview.preview_hash, "work");
    assert.equal(confirmed.retired_edge_id, legacyId);
    assert.equal(store.db.prepare("SELECT deleted_at IS NOT NULL AS retired FROM kg_edges WHERE id=?").get(legacyId).retired, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM kg_observations WHERE edge_id=?").get(legacyId).n, 1, "retiring the edge preserves its original observation");
    assert.equal(store.db.prepare("SELECT type FROM kg_edges WHERE id=? AND deleted_at IS NULL").get(confirmed.edge_id).type, "depends_on");
    assert.equal(store.reviewAnomalies({ limit: 10 }).items.some(item => item.edge.id === legacyId), false);
  } finally { store.close(); }
});

test("kg_review exposes legacy scanning only through the explicit scan mode", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    graph.store.ingest([
      { name: "Review Widget", type: "product", confidence: .9, evidence_span: "Widget exists." },
      { name: "Review Fabric", type: "technology", confidence: .9, evidence_span: "Fabric exists." }
    ], [], "manual:review", 0, undefined, "work");
    const source = graph.store.db.prepare("SELECT id FROM kg_nodes WHERE name=?").get("Review Widget");
    const target = graph.store.db.prepare("SELECT id FROM kg_nodes WHERE name=?").get("Review Fabric");
    const now = Date.now();
    graph.store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,0,NULL,?,?)")
      .run("edge:review-invalid", source.id, target.id, "works_at", "{}", now, now);
    graph.store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,scope,quote,confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("obs:review-invalid", "edge:review-invalid", null, "{}", "legacy:review", "work", "Review Widget depends on Review Fabric.", .9, now);
    const review = graph.kg_review("schema_drift", "pending", true, 1, undefined, undefined, undefined, "work");
    assert.equal(review.scan.candidates_created, 1);
    assert.throws(() => graph.kg_review("schema_drift", "pending", false, 1, "edge:review-invalid", undefined, undefined, "work"), /schema_drift_scan_required_for_cursor/);
  } finally { graph.close(); }
});

test("schema drift repair refuses endpoints without same-scope evidence", () => {
  const store = new GraphologyStore(":memory:");
  try {
    store.ingest([
      { name: "Widget", type: "product", confidence: .95, evidence_span: "x" },
      { name: "Fabric", type: "technology", confidence: .95, evidence_span: "x" }
    ], [{ source: "Widget", target: "Fabric", type: "works_at", confidence: .9, evidence_span: "x" }], "manual:repair", 0, undefined, "work");
    const candidate = store.reviewSchemaDrift("work").items[0];
    store.db.prepare("DELETE FROM kg_observations WHERE scope='work'").run();
    assert.equal(store.previewSchemaDriftRepair(candidate.id, "part_of", "work").reason, "missing_scope_evidence");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM kg_edges WHERE type='part_of'").get().n, 0);
  } finally { store.close(); }
});
