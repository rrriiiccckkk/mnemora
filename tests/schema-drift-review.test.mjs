import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphologyStore, Mnemora, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";

const entities = (source, sourceType, target, targetType, quote) => [
  { name: source, type: sourceType, confidence: .95, evidence_span: quote },
  { name: target, type: targetType, confidence: .95, evidence_span: quote }
];

test("person uses product is accepted by the ontology without relabeling the person", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const result = store.ingest(
      entities("Analyst", "person", "Research Terminal", "product", "Analyst uses Research Terminal."),
      [{ source: "Analyst", target: "Research Terminal", type: "uses", confidence: .92, evidence_span: "Analyst uses Research Terminal." }],
      "fixture:person-uses", 0, undefined, "research"
    );
    assert.equal(result.relations.length, 1);
    assert.equal(store.reviewSchemaDrift("research").items.length, 0);
    const analyst = store.getNodeById(result.entities[0].node.id);
    assert.equal(analyst?.type, "person", "a compatible relation must not require identity relabeling");
    assert.equal(store.qualityGraphSnapshot([result.entities[0].node.id], { maxNodes: 10, maxArcs: 10 }).arcs.length, 0, "semantic coverage must not add a PPR arc");
  } finally { store.close(); }
});

test("schema drift rejection is preview-confirmed, scope-bound, and cannot mutate graph state", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    graph.store.ingest(
      entities("Widget", "product", "Fabric", "technology", "Widget works at Fabric."),
      [{ source: "Widget", target: "Fabric", type: "works_at", confidence: .9, evidence_span: "Widget works at Fabric." }],
      "fixture:schema-drift-review", 0, undefined, "work"
    );
    const [candidate] = graph.store.reviewSchemaDrift("work").items;
    assert.ok(candidate);
    const pending = graph.kg_review("worklist", "pending", false, 20, undefined, undefined, undefined, "work");
    assert.deepEqual(pending.items.filter(item => item.kind === "schema_drift").map(item => ({
      id: item.candidate_id, source: item.source_type, target: item.target_type, expectedSource: item.expected_source_types, expectedTarget: item.expected_target_types, action: item.next_action
    })), [{ id: candidate.id, source: "product", target: "technology", expectedSource: "person", expectedTarget: "company", action: "repair_or_reject" }]);

    const revision = graph.store.graphRevision();
    const preview = graph.kg_review("schema_drift", "pending", false, 20, undefined, candidate.id, "rejected", "work");
    assert.equal(preview.status, "preview");
    assert.throws(() => graph.kg_review("schema_drift", "pending", false, 20, undefined, candidate.id, "rejected", "work", undefined, undefined, "wrong", true), /stale_schema_drift_review_preview/);
    const receipt = graph.kg_review("schema_drift", "pending", false, 20, undefined, candidate.id, "rejected", "work", undefined, undefined, preview.preview_hash, true);
    assert.deepEqual({ status: receipt.status, candidate: receipt.candidate_id, decision: receipt.decision }, { status: "rejected", candidate: candidate.id, decision: "rejected" });
    assert.equal(graph.store.graphRevision(), revision, "a review disposition never changes graph facts");
    const rejected = graph.kg_review("worklist", "rejected", false, 20, undefined, undefined, undefined, "work");
    assert.deepEqual(rejected.items.filter(item => item.kind === "schema_drift").map(item => item.candidate_id), [candidate.id]);
    assert.equal(graph.store.previewSchemaDriftRepair(candidate.id, "depends_on", "work").reason, "already_rejected");
    assert.equal(graph.kg_review("schema_drift", "pending", false, 20, undefined, candidate.id, "rejected", "other").status, "not_found");
  } finally { graph.close(); }
});

test("ontology-covered historic drift is invalidated as review metadata without changing its edge", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const candidateIds = [];
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      const quote = `${name} uses Research Terminal.`;
      const ingested = graph.store.ingest(entities(name, "person", `${name} Terminal`, "product", quote), [], "fixture:historic-drift", 0, undefined, "research");
      const candidateId = `schema-drift:historic-${name.toLowerCase()}`, now = Date.now();
      graph.store.db.prepare(`INSERT INTO kg_schema_drift_candidates(
        id,scope,source_entity_id,target_entity_id,relationship_type,source_type,target_type,expected_source_types,expected_target_types,legacy_edge_id,relation_payload,occurrence_count,first_seen_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(candidateId, "research", ingested.entities[0].node.id, ingested.entities[1].node.id, "uses", "person", "product", "company", "technology|product", "", JSON.stringify({ source: name, target: `${name} Terminal`, type: "uses", confidence: .9, evidence_span: quote }), now, now);
      candidateIds.push(candidateId);
    }
    const revision = graph.store.graphRevision();
    const first = graph.kg_review("worklist", "invalidated", false, 1, undefined, undefined, undefined, "research");
    const second = graph.kg_review("worklist", "invalidated", false, 1, first.next_after_id, undefined, undefined, "research");
    const third = graph.kg_review("worklist", "invalidated", false, 1, second.next_after_id, undefined, undefined, "research");
    assert.deepEqual([first, second, third].map(page => page.items.filter(item => item.kind === "schema_drift").map(item => [item.candidate_id, item.invalidation_reason])), candidateIds.sort().map(id => [[id, "endpoint_now_allowed"]]));
    assert.equal(graph.store.graphRevision(), revision, "lifecycle invalidation must not rewrite graph state");
    assert.equal(graph.store.previewSchemaDriftRepair(candidateIds[0], "related_to", "research").reason, "endpoint_now_allowed");
  } finally { graph.close(); }
});

test("v75 schema drift review migration is additive and retains historic candidates", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-schema-drift-review-")), path = join(directory, "memory.db");
  let store;
  try {
    store = new GraphologyStore(path);
    const now = Date.now();
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("product:existing", "product", "Existing", "", "[]", 0, now, now);
    store.db.prepare("INSERT INTO kg_observations(id,source_entity_id,payload,source,scope,quote,confidence,created_at) VALUES(?,?,?,?,?,?,?,?)").run("obs:existing", "product:existing", "{}", "fixture", "default", "existing evidence", .9, now);
    store.db.exec("DROP TABLE kg_schema_drift_reviews; DROP TABLE kg_schema_drift_invalidations; PRAGMA user_version=75");
    store.close(); store = new GraphologyStore(path);
    assert.equal(SUPPORTED_SCHEMA_VERSION, 76);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM kg_observations WHERE id='obs:existing'").get().value, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='kg_schema_drift_reviews'").get().value, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='kg_schema_drift_invalidations'").get().value, 1);
  } finally {
    try { store?.close(); } catch {}
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  }
});
