import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphologyStore, Mnemora, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";

const entity = (name, type, quote) => ({ name, type, confidence: .95, evidence_span: quote });
const fallback = (source, target, quote) => [{ source, target, type: "related_to", confidence: .95, evidence_span: quote }];

function ingestBasedOn(graph, name, runtime, source) {
  const quote = `${name} is based on ${runtime}.`;
  return graph.store.ingest([entity(name, "product", quote), entity(runtime, "technology", quote)], fallback(name, runtime, quote), source, 0, undefined, "work");
}

test("frequent operator-approved vocabulary classifies future explicit labels without changing topology", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const first = ingestBasedOn(graph, "System One", "Runtime One", "fixture:vocabulary:a");
    ingestBasedOn(graph, "System Two", "Runtime Two", "fixture:vocabulary:b");
    ingestBasedOn(graph, "System Three", "Runtime Three", "fixture:vocabulary:a");
    const before = graph.store.qualityGraphSnapshot([first.relations[0].edge.source_id], { maxNodes: 10, maxArcs: 10 });
    const revision = graph.store.graphRevision();

    assert.equal(graph.kg_review("related_edge_semantics", "pending", true, 20, undefined, undefined, undefined, "work").items.length, 0, "an unapproved vocabulary cannot classify a fallback edge");
    const discovered = graph.kg_review("semantic_vocabulary", "pending", true, 20, undefined, undefined, undefined, "work");
    assert.deepEqual(discovered.scan, { scanned: 3, evidence_recorded: 3, candidates_created: 1, candidates_promoted: 1 });
    const repeated = graph.kg_review("semantic_vocabulary", "pending", true, 20, undefined, undefined, undefined, "work");
    assert.deepEqual(repeated.scan, { scanned: 3, evidence_recorded: 0, candidates_created: 0, candidates_promoted: 0 });
    const candidate = repeated.items[0];
    assert.deepEqual({ predicate: candidate.predicate, source: candidate.source_type, target: candidate.target_type, occurrences: candidate.occurrence_count, sources: candidate.source_count, status: candidate.status }, {
      predicate: "based_on", source: "product", target: "technology", occurrences: 3, sources: 2, status: "pending"
    });

    const preview = graph.kg_review("semantic_vocabulary", "pending", false, 20, undefined, candidate.id, "accepted", "work");
    assert.equal(preview.eligible, true);
    assert.throws(() => graph.kg_review("semantic_vocabulary", "pending", false, 20, undefined, candidate.id, "accepted", "work", undefined, undefined, "wrong", true), /stale_semantic_vocabulary_preview/);
    assert.equal(graph.kg_review("semantic_vocabulary", "pending", false, 20, undefined, candidate.id, "accepted", "work", undefined, undefined, preview.preview_hash, true).confirmed, true);
    assert.equal(graph.store.graphRevision(), revision, "vocabulary approval has no graph mutation");
    assert.deepEqual(graph.store.qualityGraphSnapshot([first.relations[0].edge.source_id], { maxNodes: 10, maxArcs: 10 }), before, "vocabulary approval cannot alter PPR topology");

    const classified = graph.kg_review("related_edge_semantics", "pending", true, 20, undefined, undefined, undefined, "work");
    assert.equal(classified.items.filter(item => item.proposed_type === "based_on").length, 3);
    const labelCandidate = classified.items.find(item => item.proposed_type === "based_on");
    assert.ok(labelCandidate, "an accepted vocabulary produces a reviewable per-edge label candidate");
    const labelPreview = graph.kg_review("related_edge_semantics", "pending", false, 20, undefined, labelCandidate.id, "accepted", "work");
    assert.equal(labelPreview.eligible, true, "the accepted vocabulary still requires a valid per-edge review");
    assert.equal(graph.kg_review("related_edge_semantics", "pending", false, 20, undefined, labelCandidate.id, "accepted", "work", undefined, undefined, labelPreview.preview_hash, true).confirmed, true);
    assert.deepEqual(graph.kg_related(labelCandidate.source.id, 1, undefined, "out", "work", ["based_on"]).semantic_labels.map(item => [item.predicate, item.domain, item.source.name, item.target.name]), [["based_on", "neutral", labelCandidate.source.name, labelCandidate.target.name]]);
    assert.deepEqual(graph.kg_related(labelCandidate.source.id, 1, undefined, "out", "work").semantic_labels, [], "custom labels require an explicit predicate");
    assert.equal(graph.store.getEdgeById(first.relations[0].edge.id)?.type, "related_to");
  } finally { graph.close(); }
});

test("rejected vocabulary remains inactive and cannot classify future fallback edges", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    for (const [person, organization, source] of [["Person One", "Group One", "fixture:member:a"], ["Person Two", "Group Two", "fixture:member:b"], ["Person Three", "Group Three", "fixture:member:a"]]) {
      const quote = `${person} is a member of ${organization}.`;
      graph.store.ingest([entity(person, "person", quote), entity(organization, "company", quote)], fallback(person, organization, quote), source, 0, undefined, "work");
    }
    const candidate = graph.kg_review("semantic_vocabulary", "pending", true, 20, undefined, undefined, undefined, "work").items[0];
    assert.equal(candidate.predicate, "member_of");
    const preview = graph.kg_review("semantic_vocabulary", "pending", false, 20, undefined, candidate.id, "rejected", "work");
    assert.equal(graph.kg_review("semantic_vocabulary", "pending", false, 20, undefined, candidate.id, "rejected", "work", undefined, undefined, preview.preview_hash, true).confirmed, true);
    assert.equal(graph.kg_review("related_edge_semantics", "pending", true, 20, undefined, undefined, undefined, "work").items.length, 0);
    assert.equal(graph.kg_review("semantic_vocabulary", "rejected", false, 20, undefined, undefined, undefined, "work").items[0].id, candidate.id);
  } finally { graph.close(); }
});

test("v75 preserves existing related semantic reviews while widening only their label contract", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-semantic-vocabulary-")), path = join(directory, "memory.db");
  let store;
  try {
    store = new GraphologyStore(path);
    const quote = "Build Tool uses Runtime.";
    const seeded = store.ingest([entity("Build Tool", "product", quote), entity("Runtime", "technology", quote)], fallback("Build Tool", "Runtime", quote), "fixture:migration", 0, undefined, "work");
    const edge = seeded.relations[0].edge, observation = store.db.prepare("SELECT id FROM kg_observations WHERE edge_id=?").get(edge.id).id, now = Date.now();
    store.db.exec("DROP TABLE kg_semantic_vocabulary_reviews; DROP TABLE kg_semantic_vocabulary_candidate_evidence; DROP TABLE kg_semantic_vocabulary_candidates; DROP TABLE kg_related_edge_semantic_reviews; DROP TABLE kg_related_edge_semantic_candidates");
    store.db.exec(`CREATE TABLE kg_related_edge_semantic_candidates (
      id TEXT PRIMARY KEY,scope TEXT NOT NULL REFERENCES kg_scopes(id),legacy_edge_id TEXT NOT NULL REFERENCES kg_edges(id),source_entity_id TEXT NOT NULL REFERENCES kg_nodes(id),target_entity_id TEXT NOT NULL REFERENCES kg_nodes(id),
      proposed_type TEXT NOT NULL CHECK(proposed_type IN ('works_at','invested_in','supplies','supplies_product','supplied_to','competes_with','uses','develops','owns','partners_with','in_portfolio')),
      evidence_observation_id TEXT NOT NULL REFERENCES kg_observations(id),evidence_hash TEXT NOT NULL,rationale TEXT NOT NULL,confidence REAL NOT NULL,status TEXT NOT NULL,first_seen_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,reviewed_at INTEGER
    );
    CREATE TABLE kg_related_edge_semantic_reviews (candidate_id TEXT PRIMARY KEY REFERENCES kg_related_edge_semantic_candidates(id),scope TEXT NOT NULL REFERENCES kg_scopes(id),decision TEXT NOT NULL,preview_hash TEXT NOT NULL,audit_id TEXT NOT NULL REFERENCES kg_quality_audits(id),created_at INTEGER NOT NULL);`);
    store.db.prepare("INSERT INTO kg_quality_audits(id,action,snapshot_version,snapshot,created_at) VALUES(?,?,1,'{}',?)").run("audit:semantic-v74", "fixture", now);
    store.db.prepare("INSERT INTO kg_related_edge_semantic_candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("candidate:semantic-v74", "work", edge.id, edge.source_id, edge.target_id, "uses", observation, "a".repeat(64), "fixture", .9, "accepted", now, now, now);
    store.db.prepare("INSERT INTO kg_related_edge_semantic_reviews VALUES(?,?,?,?,?,?)").run("candidate:semantic-v74", "work", "accepted", "b".repeat(64), "audit:semantic-v74", now);
    store.db.exec("PRAGMA user_version=74");
    store.close(); store = new GraphologyStore(path);
    assert.equal(SUPPORTED_SCHEMA_VERSION, 77);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM kg_related_edge_semantic_candidates WHERE id='candidate:semantic-v74'").get().value, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM kg_related_edge_semantic_reviews WHERE candidate_id='candidate:semantic-v74'").get().value, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM kg_observations WHERE edge_id=?").get(edge.id).value, 1);
    assert.equal(String(store.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='kg_related_edge_semantic_candidates'").get().sql).includes("proposed_type IN"), false);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='kg_semantic_vocabulary_candidates'").get().value, 1);
  } finally {
    try { store?.close(); } catch {}
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  }
});
