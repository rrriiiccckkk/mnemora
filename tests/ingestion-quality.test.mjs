import assert from "node:assert/strict";
import test from "node:test";
import { GraphologyStore } from "../dist/store.js";
import { SUPPORTED_SCHEMA_VERSION } from "../dist/schema.js";

const entity = (name, type, confidence = .95) => ({ name, type, confidence, evidence_span: name });
const relation = (source, target, type, confidence = .95) => ({ source, target, type, confidence, evidence_span: `${source} ${type} ${target}` });

test("ingestion rejects self-loops but retains semantic endpoint mismatches as reviewable evidence", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const result = store.ingest(
      [entity("NVIDIA", "company"), entity("Alice", "person"), entity("GPU", "product")],
      [
        relation("NVIDIA", "NVIDIA", "competes_with"),
        relation("NVIDIA", "Alice", "works_at"),
        relation("NVIDIA", "GPU", "supplies_product")
      ],
      "fixture:quality"
    );

    assert.deepEqual(result.skipped_relations.map(item => item.reason), ["self_loop"]);
    assert.equal(result.relations.length, 2);
    assert.equal(store.stats().edges.total, 2);
    assert.equal(store.stats().observations.total, 5);
    assert.equal(store.reviewSchemaDrift("default").items.length, 1);
  } finally {
    store.close();
  }
});

test("semantic vocabulary mismatch is durable, reviewable, and not topology", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const result = store.ingest(
      [entity("Build tool", "product"), entity("TypeScript", "technology")],
      [relation("Build tool", "TypeScript", "works_at")],
      "fixture:schema-drift",
      0,
      { edgeMinConfidence: 0, relatedToMinConfidence: .8, edgeTypeMinConfidence: {} },
      "project:code"
    );
    assert.deepEqual(result.skipped_relations, []);
    assert.equal(result.relations.length, 1);
    assert.equal(store.stats().edges.total, 1);
    const [candidate] = store.reviewSchemaDrift("project:code", 10).items;
    assert.deepEqual({ source: candidate.source_type, target: candidate.target_type, expectedSource: candidate.expected_source_types, expectedTarget: candidate.expected_target_types, occurrences: candidate.occurrence_count }, { source: "product", target: "technology", expectedSource: "person", expectedTarget: "company", occurrences: 1 });
    store.ingest([entity("Build tool", "product"), entity("TypeScript", "technology")], [relation("Build tool", "TypeScript", "works_at")], "fixture:schema-drift:second", 0, { edgeMinConfidence: 0, relatedToMinConfidence: .8, edgeTypeMinConfidence: {} }, "project:code");
    assert.equal(store.reviewSchemaDrift("project:code", 10).items[0].occurrence_count, 2);
  } finally { store.close(); }
});

test("related_to uses a stricter confidence threshold than specific relationships", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const result = store.ingest(
      [entity("NVIDIA", "company"), entity("CUDA", "technology")],
      [relation("NVIDIA", "CUDA", "related_to", .79), relation("NVIDIA", "CUDA", "uses", .79)],
      "fixture:threshold",
      0,
      { edgeMinConfidence: 0, relatedToMinConfidence: .8, edgeTypeMinConfidence: {} }
    );
    assert.deepEqual(result.skipped_relations.map(item => item.reason), ["below_edge_confidence"]);
    assert.deepEqual(result.relations.map(item => item.edge.type), ["uses"]);
  } finally {
    store.close();
  }
});

test("related_to requires retained evidence even for direct structured ingestion", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const result = store.ingest(
      [entity("NVIDIA", "company"), entity("CUDA", "technology")],
      [{ source: "NVIDIA", target: "CUDA", type: "related_to", confidence: .95, evidence_span: "" }],
      "fixture:missing-related-evidence"
    );
    assert.deepEqual(result.skipped_relations.map(item => item.reason), ["missing_related_to_evidence"]);
    assert.equal(result.relations.length, 0);
  } finally { store.close(); }
});

test("node importance combines evidence quality and independent sources instead of only mention count", () => {
  const store = new GraphologyStore(":memory:");
  try {
    for (let index = 0; index < 5; index++) store.ingest([entity("Repeated", "company", .4)], [], "fixture:one-source");
    const repeated = store.search("Repeated")[0].node.importance;
    assert.ok(repeated > 0 && repeated < 1);
    store.ingest([entity("Corroborated", "company", .9)], [], "fixture:source-a");
    store.ingest([entity("Corroborated", "company", .9)], [], "fixture:source-b");
    const corroborated = store.search("Corroborated")[0].node.importance;
    assert.ok(corroborated > repeated);

    store.db.exec("PRAGMA user_version=47");
    store.migrate();
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
    assert.equal(store.search("Repeated")[0].node.importance, repeated);
  } finally { store.close(); }
});

test("graph traversal honours the documented recall depth of five", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const entities = ["A", "B", "C", "D", "E", "F"].map(name => entity(name, "company"));
    const relations = [["A", "B"], ["B", "C"], ["C", "D"], ["D", "E"], ["E", "F"]].map(([source, target]) => relation(source, target, "related_to"));
    store.ingest(entities, relations, "fixture:depth");
    assert.equal(store.related("A", 5).nodes.some(node => node.name === "F"), true);
  } finally { store.close(); }
});

test("historical relationship anomalies are previewed and audited before cleanup", () => {
  const store = new GraphologyStore(":memory:");
  try {
    store.ingest([entity("NVIDIA", "company"), entity("Alice", "person")], [], "fixture:nodes");
    const now = Date.now();
    store.db.prepare(`INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at)
      VALUES(?,?,?,?,?,0,NULL,?,?)`).run("edge:self", "company:nvidia", "company:nvidia", "competes_with", "{}", now, now);
    store.db.prepare(`INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at)
      VALUES(?,?,?,?,?,0,NULL,?,?)`).run("edge:type", "company:nvidia", "person:alice", "depends_on", "{}", now, now);

    const anomalies = store.reviewAnomalies({ limit: 10 });
    assert.deepEqual(anomalies.items.map(item => item.reason), ["self_loop"]);

    const preview = store.cleanupAnomalies(anomalies.items.map(item => item.edge.id), false);
    assert.equal(preview.confirmed, false);
    assert.equal(store.stats().edges.total, 2);

    const cleaned = store.cleanupAnomalies(anomalies.items.map(item => item.edge.id), true, preview.preview_hash);
    assert.equal(cleaned.confirmed, true);
    assert.equal(cleaned.cleaned, 1);
    assert.equal(store.stats().edges.total, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM kg_quality_audits").get().count, 1);
  } finally {
    store.close();
  }
});

test("context renders exact semantic-label predicates separately from topology", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const result = store.ingest(
      [entity("NVIDIA", "company"), entity("CUDA", "technology"), entity("AI", "concept")],
      [relation("NVIDIA", "AI", "related_to", .9), relation("NVIDIA", "CUDA", "uses", .9)],
      "fixture:ranking"
    );
    const seed = result.entities.find(item => item.node.name === "NVIDIA").node;
    const bare = store.contextFromSeeds("NVIDIA", [{ node: seed, score: 1, evidence: [] }], { maxDepth: 1 });
    assert.deepEqual(bare.edges.map(item => item.edge.type), ["related_to"]);
    assert.deepEqual(bare.semantic_labels, []);
    const context = store.contextFromSeeds("NVIDIA uses", [{ node: seed, score: 1, evidence: [] }], { maxDepth: 1 });
    assert.deepEqual(context.semantic_labels.map(item => item.predicate), ["uses"]);
    assert.match(context.context, /Semantic labels \(not graph topology\)/);
  } finally {
    store.close();
  }
});

test("generic supplies wording does not also request the more specific supplies_product label", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const result = store.ingest(
      [entity("Acme", "company"), entity("Component", "product")],
      [relation("Acme", "Component", "supplies", .9), relation("Acme", "Component", "supplies_product", .9)],
      "fixture:semantic-alias"
    );
    const seed = result.entities.find(item => item.node.name === "Acme").node;
    const context = store.contextFromSeeds("Acme supplies", [{ node: seed, score: 1, evidence: [] }], { maxDepth: 1 });
    assert.deepEqual(context.semantic_labels.map(item => item.predicate), ["supplies"]);
    const withObject = store.contextFromSeeds("Acme supplies Component", [{ node: seed, score: 1, evidence: [] }], { maxDepth: 1 });
    assert.deepEqual(withObject.semantic_labels.map(item => item.predicate).sort(), ["supplies", "supplies_product"]);
  } finally {
    store.close();
  }
});
