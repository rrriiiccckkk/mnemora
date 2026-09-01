import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphologyStore, Mnemora, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";

const entities = (left, right, quote) => [
  { name: left, type: "product", confidence: .95, evidence_span: quote },
  { name: right, type: "technology", confidence: .95, evidence_span: quote }
];

const related = (left, right, quote, confidence = .95) => [{
  source: left, target: right, type: "related_to", confidence, evidence_span: quote
}];

test("related-edge refinement is scope-bound, evidence-gated, and preview/confirm only", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const quote = "Build Tool depends on TypeScript.";
    const ingested = graph.store.ingest(entities("Build Tool", "TypeScript", quote), related("Build Tool", "TypeScript", quote), "fixture:related-refinement", 0, undefined, "project:code");
    const legacy = ingested.relations[0].edge;
    graph.store.ingest(entities("Loose Tool", "Package", "Loose Tool is associated with Package."), related("Loose Tool", "Package", "Loose Tool is associated with Package."), "fixture:related-refinement", 0, undefined, "project:code");

    const reviewed = graph.kg_review("related_edge_refinements", "pending", true, 20, undefined, undefined, undefined, "project:code");
    assert.deepEqual({ scanned: reviewed.scan.scanned, created: reviewed.scan.candidates_created }, { scanned: 2, created: 1 });
    assert.equal(reviewed.items.length, 1, "vague co-occurrence is never refined into topology");
    assert.deepEqual({ type: reviewed.items[0].proposed_type, scope: reviewed.items[0].scope, quote: reviewed.items[0].evidence.quote }, { type: "depends_on", scope: "project:code", quote });
    assert.deepEqual(graph.kg_review("related_edge_refinements", "pending", false, 20, undefined, undefined, undefined, "other"), { items: [] });

    const candidate = reviewed.items[0];
    const preview = graph.kg_review("related_edge_refinements", "pending", false, 20, undefined, candidate.id, "accepted", "project:code");
    assert.deepEqual({ confirmed: preview.confirmed, eligible: preview.eligible }, { confirmed: false, eligible: true });
    assert.throws(() => graph.kg_review("related_edge_refinements", "pending", false, 20, undefined, candidate.id, "accepted", "project:code", undefined, undefined, "wrong", true), /stale_related_edge_refinement_preview/);
    assert.equal(graph.store.getEdgeById(legacy.id)?.deleted_at, null, "preview must not mutate the old edge");

    const confirmed = graph.kg_review("related_edge_refinements", "pending", false, 20, undefined, candidate.id, "accepted", "project:code", undefined, undefined, preview.preview_hash, true);
    assert.equal(confirmed.confirmed, true);
    assert.equal(graph.store.db.prepare("SELECT deleted_at IS NOT NULL AS retired FROM kg_edges WHERE id=?").get(legacy.id).retired, 1);
    assert.equal(graph.store.getEdgeById(confirmed.edge_id)?.type, "depends_on");
    assert.equal(graph.store.db.prepare("SELECT source,confidence,scope,quote FROM kg_observations WHERE id=?").get(confirmed.observation_id).source, `related-edge-refinement:${candidate.id}`);
    assert.equal(Math.round(graph.store.db.prepare("SELECT confidence FROM kg_observations WHERE id=?").get(confirmed.observation_id).confidence * 100), 76);
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS value FROM kg_quality_audits WHERE action='confirm_related_edge_refinement'").get().value, 1);
    assert.equal(graph.store.qualityGraphSnapshot([candidate.proposed_source.id], { maxNodes: 10, maxArcs: 10 }).arcs.some(arc => arc.to === candidate.proposed_target.id), true);
    assert.equal(graph.kg_review("related_edge_refinements", "pending", false, 20, undefined, candidate.id, "accepted", "project:code").reason, "already_reviewed");
  } finally { graph.close(); }
});

test("related-edge refinement rejection is immutable and hard forget clears review references", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const quote = "Application is part of Platform.";
    const ingested = graph.store.ingest(entities("Application", "Platform", quote), related("Application", "Platform", quote), "fixture:related-refinement", 0, undefined, "work");
    const legacy = ingested.relations[0].edge;
    const candidate = graph.kg_review("related_edge_refinements", "pending", true, 20, undefined, undefined, undefined, "work").items[0];
    const rejected = graph.kg_review("related_edge_refinements", "pending", false, 20, undefined, candidate.id, "rejected", "work");
    assert.equal(rejected.eligible, true);
    assert.equal(graph.kg_review("related_edge_refinements", "pending", false, 20, undefined, candidate.id, "rejected", "work", undefined, undefined, rejected.preview_hash, true).confirmed, true);
    assert.equal(graph.store.getEdgeById(legacy.id)?.deleted_at, null, "rejection never retires the legacy edge");
    assert.deepEqual(graph.kg_review("related_edge_refinements", "pending", true, 20, undefined, undefined, undefined, "work").scan, { scanned: 1, candidates_created: 0, candidates_updated: 0 }, "a reviewed candidate is not reopened by a rescan");
    assert.doesNotThrow(() => graph.store.forget(candidate.source.id, true, true));
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS value FROM kg_related_edge_refinement_candidates").get().value, 0);
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS value FROM kg_related_edge_refinement_receipts").get().value, 0);
  } finally { graph.close(); }
});

test("v72 related-edge refinement migration is additive and retains existing evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-related-edge-refinement-")), path = join(directory, "memory.db");
  let store;
  try {
    store = new GraphologyStore(path);
    const now = Date.now();
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("product:existing", "product", "Existing", "", "[]", 0, now, now);
    store.db.prepare("INSERT INTO kg_observations(id,source_entity_id,payload,source,scope,quote,confidence,created_at) VALUES(?,?,?,?,?,?,?,?)").run("obs:existing", "product:existing", "{}", "fixture", "default", "existing evidence", .9, now);
    store.db.exec("DROP TABLE kg_related_edge_refinement_receipts; DROP TABLE kg_related_edge_refinement_candidates; PRAGMA user_version=71");
    store.close(); store = new GraphologyStore(path);
    assert.equal(SUPPORTED_SCHEMA_VERSION, 75);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM kg_observations WHERE id='obs:existing'").get().value, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='kg_related_edge_refinement_candidates'").get().value, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='kg_related_edge_refinement_receipts'").get().value, 1);
  } finally {
    try { store?.close(); } catch {}
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  }
});
