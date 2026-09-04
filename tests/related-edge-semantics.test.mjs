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

const fallback = (source, target, quote, confidence = .95) => [{
  source, target, type: "related_to", confidence, evidence_span: quote
}];

test("related-edge semantic enrichment is evidence-gated, scope-bound, and preserves topology", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const quote = "Build Tool uses TypeScript.";
    const ingested = graph.store.ingest(entities("Build Tool", "product", "TypeScript", "technology", quote), fallback("Build Tool", "TypeScript", quote), "fixture:related-semantics", 0, undefined, "project:code");
    const legacy = ingested.relations[0].edge;
    graph.store.ingest(entities("Loose Tool", "product", "Package", "technology", "Loose Tool is associated with Package."), fallback("Loose Tool", "Package", "Loose Tool is associated with Package."), "fixture:related-semantics", 0, undefined, "project:code");
    const before = graph.store.qualityGraphSnapshot([legacy.source_id], { maxNodes: 10, maxArcs: 10 });

    const reviewed = graph.kg_review("related_edge_semantics", "pending", true, 20, undefined, undefined, undefined, "project:code");
    assert.deepEqual({ scanned: reviewed.scan.scanned, created: reviewed.scan.candidates_created }, { scanned: 2, created: 1 });
    assert.deepEqual({ type: reviewed.items[0].proposed_type, rationale: reviewed.items[0].rationale, quote: reviewed.items[0].evidence.quote }, { type: "uses", rationale: "explicit_use_cue", quote });
    assert.equal(graph.kg_related("Build Tool", 1, ["uses"], undefined, "project:code").semantic_labels.length, 0, "a scan alone must not alter semantic retrieval");
    assert.deepEqual(graph.kg_review("related_edge_semantics", "pending", false, 20, undefined, undefined, undefined, "other"), { items: [] });

    const candidate = reviewed.items[0];
    const preview = graph.kg_review("related_edge_semantics", "pending", false, 20, undefined, candidate.id, "accepted", "project:code");
    assert.equal(preview.eligible, true);
    assert.throws(() => graph.kg_review("related_edge_semantics", "pending", false, 20, undefined, candidate.id, "accepted", "project:code", undefined, undefined, "wrong", true), /stale_related_edge_semantic_preview/);
    const confirmed = graph.kg_review("related_edge_semantics", "pending", false, 20, undefined, candidate.id, "accepted", "project:code", undefined, undefined, preview.preview_hash, true);
    assert.equal(confirmed.confirmed, true);
    assert.equal(graph.store.getEdgeById(legacy.id)?.type, "related_to", "semantic acceptance must not rewrite the legacy edge");
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS value FROM kg_edges WHERE type='uses'").get().value, 0, "semantic acceptance must not create a graph edge");
    assert.deepEqual(graph.store.qualityGraphSnapshot([legacy.source_id], { maxNodes: 10, maxArcs: 10 }), before, "semantic labels must not change PPR topology");
    const labels = graph.kg_related("Build Tool", 1, ["uses"], undefined, "project:code").semantic_labels;
    assert.deepEqual(labels.map(item => [item.predicate, item.source.name, item.target.name, item.evidence[0].quote]), [["uses", "Build Tool", "TypeScript", quote]]);
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS value FROM kg_quality_audits WHERE action='confirm_related_edge_semantic'").get().value, 1);
    assert.equal(graph.kg_review("related_edge_semantics", "pending", false, 20, undefined, candidate.id, "accepted", "project:code").reason, "already_reviewed");
  } finally { graph.close(); }
});

test("rejected related-edge semantic candidates remain inert and hard forget clears review metadata", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const quote = "Acme develops Widget.";
    const ingested = graph.store.ingest(entities("Acme", "company", "Widget", "product", quote), fallback("Acme", "Widget", quote), "fixture:related-semantics", 0, undefined, "work");
    const candidate = graph.kg_review("related_edge_semantics", "pending", true, 20, undefined, undefined, undefined, "work").items[0];
    const preview = graph.kg_review("related_edge_semantics", "pending", false, 20, undefined, candidate.id, "rejected", "work");
    assert.equal(graph.kg_review("related_edge_semantics", "pending", false, 20, undefined, candidate.id, "rejected", "work", undefined, undefined, preview.preview_hash, true).confirmed, true);
    assert.equal(graph.kg_related("Acme", 1, ["develops"], undefined, "work").semantic_labels.length, 0);
    assert.deepEqual(graph.kg_review("related_edge_semantics", "pending", true, 20, undefined, undefined, undefined, "work").scan, { scanned: 1, candidates_created: 0, candidates_updated: 0 }, "a reviewed candidate cannot reopen on rescan");
    assert.equal(graph.store.getEdgeById(ingested.relations[0].edge.id)?.deleted_at, null);
    assert.doesNotThrow(() => graph.store.forget(candidate.source.id, true, true));
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS value FROM kg_related_edge_semantic_candidates").get().value, 0);
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS value FROM kg_related_edge_semantic_reviews").get().value, 0);
  } finally { graph.close(); }
});

test("v73 related-edge semantic migration is additive and preserves existing evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-related-edge-semantics-")), path = join(directory, "memory.db");
  let store;
  try {
    store = new GraphologyStore(path);
    const now = Date.now();
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("product:existing", "product", "Existing", "", "[]", 0, now, now);
    store.db.prepare("INSERT INTO kg_observations(id,source_entity_id,payload,source,scope,quote,confidence,created_at) VALUES(?,?,?,?,?,?,?,?)").run("obs:existing", "product:existing", "{}", "fixture", "default", "existing evidence", .9, now);
    store.db.exec("DROP TABLE kg_related_edge_semantic_reviews; DROP TABLE kg_related_edge_semantic_candidates; PRAGMA user_version=72");
    store.close(); store = new GraphologyStore(path);
    assert.equal(SUPPORTED_SCHEMA_VERSION, 77);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM kg_observations WHERE id='obs:existing'").get().value, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='kg_related_edge_semantic_candidates'").get().value, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='kg_related_edge_semantic_reviews'").get().value, 1);
  } finally {
    try { store?.close(); } catch {}
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  }
});
