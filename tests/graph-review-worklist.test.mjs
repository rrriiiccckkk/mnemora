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

const fallback = (source, target, quote) => [{ source, target, type: "related_to", confidence: .95, evidence_span: quote }];

test("graph review worklist marks stale pending legacy proposals invalid without mutating graph state", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const refinementQuote = "Build Tool depends on TypeScript.";
    graph.store.ingest(entities("Build Tool", "product", "TypeScript", "technology", refinementQuote), fallback("Build Tool", "TypeScript", refinementQuote), "fixture:worklist", 0, undefined, "project:code");
    const semanticQuote = "Acme develops Widget.";
    graph.store.ingest(entities("Acme", "company", "Widget", "product", semanticQuote), fallback("Acme", "Widget", semanticQuote), "fixture:worklist", 0, undefined, "project:code");
    const refinement = graph.kg_review("related_edge_refinements", "pending", true, 20, undefined, undefined, undefined, "project:code").items[0];
    const semantic = graph.kg_review("related_edge_semantics", "pending", true, 20, undefined, undefined, undefined, "project:code").items[0];
    const reviewRevision = graph.store.graphRevision();
    graph.store.forget(refinement.source.id, false, false);
    graph.store.forget(semantic.source.id, false, false);

    const invalidated = graph.kg_review("worklist", "invalidated", false, 20, undefined, undefined, undefined, "project:code");
    assert.deepEqual(invalidated.items.map(item => [item.kind, item.candidate_id, item.invalidation_reason]).sort(), [
      ["related_edge_refinement", refinement.id, "legacy_edge_retired"],
      ["related_edge_semantic", semantic.id, "legacy_edge_retired"]
    ]);
    assert.equal(graph.store.graphRevision(), reviewRevision + 2, "only the two explicit soft-forget operations changed graph revision");
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS value FROM kg_graph_review_invalidations").get().value, 2);
    const preview = graph.kg_review("related_edge_refinements", "pending", false, 20, undefined, refinement.id, "accepted", "project:code");
    assert.deepEqual({ eligible: preview.eligible, reason: preview.reason, invalidation: preview.invalidation_reason }, { eligible: false, reason: "invalidated", invalidation: "legacy_edge_retired" });
  } finally { graph.close(); }
});

test("graph review worklist retains rejected decisions and exposes self-links as read-only pending findings", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const quote = "Application is part of Platform.";
    const ingested = graph.store.ingest(entities("Application", "product", "Platform", "technology", quote), fallback("Application", "Platform", quote), "fixture:worklist", 0, undefined, "work");
    const candidate = graph.kg_review("related_edge_refinements", "pending", true, 20, undefined, undefined, undefined, "work").items[0];
    const preview = graph.kg_review("related_edge_refinements", "pending", false, 20, undefined, candidate.id, "rejected", "work");
    graph.kg_review("related_edge_refinements", "pending", false, 20, undefined, candidate.id, "rejected", "work", undefined, undefined, preview.preview_hash, true);
    const now = Date.now(), selfEdge = "edge:worklist:self";
    graph.store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,0,NULL,?,?)")
      .run(selfEdge, ingested.entities[0].node.id, ingested.entities[0].node.id, "related_to", "{}", now, now);
    graph.store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,scope,quote,confidence,created_at) VALUES(?,?,NULL,?,?,?,?,?,?)")
      .run("obs:worklist:self", selfEdge, "{}", "fixture:worklist", "work", "self-link fixture", .9, now);

    const rejected = graph.kg_review("worklist", "rejected", false, 20, undefined, undefined, undefined, "work");
    assert.deepEqual(rejected.items.map(item => [item.kind, item.candidate_id, item.status]), [["related_edge_refinement", candidate.id, "rejected"]]);
    const pending = graph.kg_review("worklist", "pending", false, 20, undefined, undefined, undefined, "work");
    assert.deepEqual(pending.items.filter(item => item.kind === "suspicious_self_link").map(item => [item.id, item.edge_id, item.entity_id, item.status]), [[`self-link:${selfEdge}`, selfEdge, ingested.entities[0].node.id, "pending"]]);
    assert.equal(graph.store.getEdgeById(selfEdge)?.deleted_at, null, "reading the worklist cannot remove a self-link");
  } finally { graph.close(); }
});

test("v74 graph review lifecycle migration is additive and does not alter existing evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-graph-review-worklist-")), path = join(directory, "memory.db");
  let store;
  try {
    store = new GraphologyStore(path);
    const now = Date.now();
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("product:existing", "product", "Existing", "", "[]", 0, now, now);
    store.db.prepare("INSERT INTO kg_observations(id,source_entity_id,payload,source,scope,quote,confidence,created_at) VALUES(?,?,?,?,?,?,?,?)").run("obs:existing", "product:existing", "{}", "fixture", "default", "existing evidence", .9, now);
    store.db.exec("DROP TABLE kg_graph_review_invalidations; PRAGMA user_version=73");
    store.close(); store = new GraphologyStore(path);
    assert.equal(SUPPORTED_SCHEMA_VERSION, 75);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM kg_observations WHERE id='obs:existing'").get().value, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='kg_graph_review_invalidations'").get().value, 1);
  } finally {
    try { store?.close(); } catch {}
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  }
});
