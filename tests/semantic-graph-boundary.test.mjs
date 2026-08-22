import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphologyStore, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";

const entity = (name, type) => ({ name, type, confidence: .9, evidence_span: `${name} evidence` });
const relation = (source, target, type) => ({ source, target, type, confidence: .9, evidence_span: `${source} ${type} ${target}` });

test("semantic relations persist as labels, while default traversal and PPR use stable topology only", () => {
  const store = new GraphologyStore(":memory:");
  try {
    store.ingest([
      entity("Build Tool", "product"), entity("TypeScript", "technology"), entity("Package", "product")
    ], [
      relation("Build Tool", "TypeScript", "uses"),
      relation("Build Tool", "Package", "depends_on")
    ], "fixture:semantic", 0, undefined, "project:code");

    const defaultRelated = store.related("Build Tool", 2, undefined, undefined, "project:code");
    assert.deepEqual([...new Set(defaultRelated.edges.map(item => item.edge.type))], ["depends_on"]);
    assert.deepEqual(defaultRelated.semantic_labels, []);
    assert.equal(defaultRelated.nodes.some(node => node.name === "TypeScript"), false, "labels must not expand topology traversal");
    assert.deepEqual(store.stats().edges.by_layer, { structural: 1, semantic: 1 });

    const exactLabels = store.related("Build Tool", 5, ["uses"], undefined, "project:code");
    assert.deepEqual(exactLabels.edges, []);
    assert.deepEqual(exactLabels.semantic_labels.map(item => [item.predicate, item.domain, item.endpoint_match]), [["uses", "code", true]]);
    assert.equal(store.related("Build Tool", 1, ["uses"], "out", "project:code").semantic_labels.length, 1);
    assert.equal(store.related("Build Tool", 1, ["uses"], "in", "project:code").semantic_labels.length, 0);

    const snapshot = store.qualityGraphSnapshot(["product:build-tool"], { maxNodes: 10, maxArcs: 10 });
    assert.equal(snapshot.arcs.every(arc => arc.from !== "product:build-tool" || arc.to !== "technology:typescript"), true);
    assert.equal(snapshot.arcs.some(arc => arc.to === "product:package"), true);

    const bare = store.contextFromSeeds("Build Tool", [{ node: store.getNodeById("product:build-tool"), score: 1, evidence: [] }], { scope: "project:code" });
    assert.deepEqual(bare.semantic_labels, []);
    const explicit = store.contextFromSeeds("What uses does Build Tool have?", [{ node: store.getNodeById("product:build-tool"), score: 1, evidence: [] }], { scope: "project:code" });
    assert.deepEqual(explicit.semantic_labels.map(item => item.predicate), ["uses"]);
    assert.match(explicit.context, /Semantic labels \(not graph topology\)/);
  } finally { store.close(); }
});

test("mismatched semantic evidence is soft-flagged and pattern promotion remains preview/confirm only", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const result = store.ingest([entity("Widget", "product"), entity("Fabric", "technology")], [relation("Widget", "Fabric", "works_at")], "fixture:drift", 0, undefined, "work");
    assert.equal(result.relations.length, 1);
    const edge = result.relations[0].edge;
    assert.deepEqual(edge.edge_props.semantics, { version: 1, layer: "semantic", predicate: "works_at", domain: "investment", endpoint_match: false });
    assert.equal(store.related("Widget", 1, ["works_at"], undefined, "work").semantic_labels[0].score, .675, "dictionary drift must lower label selection without changing evidence");
    assert.equal(store.reviewSchemaDrift("work").items.length, 1);

    const [candidate] = store.reviewSemanticPatterns("work").items;
    assert.deepEqual({ status: candidate.status, count: candidate.occurrence_count, predicate: candidate.predicate }, { status: "pending", count: 1, predicate: "works_at" });
    const preview = store.previewSemanticPatternReview(candidate.id, "accepted", "work");
    assert.equal(preview.eligible, true);
    assert.throws(() => store.confirmSemanticPatternReview(candidate.id, "accepted", "wrong", "work"), /stale_semantic_pattern_review_preview/);
    const receipt = store.confirmSemanticPatternReview(candidate.id, "accepted", preview.preview_hash, "work");
    assert.equal(receipt.confirmed, true);
    assert.equal(store.reviewSemanticPatterns("work").items[0].status, "accepted");
    assert.equal(store.getEdgeById(edge.id)?.type, "works_at", "review cannot rewrite historical evidence");
    assert.equal(store.qualityGraphSnapshot([edge.source_id], { maxNodes: 10, maxArcs: 10 }).arcs.length, 0, "acceptance cannot promote an edge into PPR");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM kg_quality_audits WHERE action='confirm_semantic_pattern_review'").get().n, 1);
  } finally { store.close(); }
});

test("v59 migration is additive and historic semantic edges are projected as legacy labels", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-semantic-v59-")), path = join(directory, "memory.db");
  let store;
  try {
    store = new GraphologyStore(path);
    const now = Date.now();
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("company:legacy", "company", "Legacy", "", "[]", 0, now, now);
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("technology:legacy", "technology", "Legacy Tech", "", "[]", 0, now, now);
    store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,0,NULL,?,?)").run("edge:legacy-semantic", "company:legacy", "technology:legacy", "uses", "{}", now, now);
    store.db.prepare("INSERT INTO kg_observations(id,edge_id,payload,source,scope,quote,confidence,created_at) VALUES(?,?,?,?,?,?,?,?)").run("obs:legacy-semantic", "edge:legacy-semantic", "{}", "fixture:legacy", "work", "Legacy uses legacy tech", .9, now);
    store.db.exec("DROP TABLE kg_semantic_pattern_reviews; DROP TABLE kg_semantic_pattern_candidates; PRAGMA user_version=58");
    store.close(); store = new GraphologyStore(path);
    assert.equal(SUPPORTED_SCHEMA_VERSION, 61);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 61);
    assert.equal(store.getEdgeById("edge:legacy-semantic")?.edge_props.semantics, undefined);
    const labels = store.related("Legacy", 1, ["uses"], undefined, "work").semantic_labels;
    assert.deepEqual(labels.map(item => [item.id, item.legacy]), [["edge:legacy-semantic", true]]);
    assert.equal(store.qualityGraphSnapshot(["company:legacy"], { maxNodes: 10, maxArcs: 10 }).arcs.length, 0);
    assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    try { store?.close(); } catch {}
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  }
});
