// Graph governance (hygiene, graph review, related-edge refinement and
// semantics, semantic vocabulary, schema drift) and cognition graduation were
// removed in 1.38.0. Their tables stay so existing databases keep loading and
// hard forget keeps clearing references; these tests pin that boundary.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { createTempDir } from "./helpers/temp.mjs";
import { GraphologyStore, Mnemora, normalizeConfig, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";
import { createOpenClawToolDefinitions } from "../dist/openclaw.js";
import { REMOVED_REVIEW_KINDS } from "../dist/review-kinds.js";

const entity = (name, type, span) => ({ name, type, confidence: .9, evidence_span: span });

test("removed review kinds fail clearly instead of answering as duplicates", () => {
  const graph = new Mnemora({ config: normalizeConfig({ dbPath: ":memory:" }) });
  try {
    for (const kind of REMOVED_REVIEW_KINDS) assert.throws(() => graph.kg_review(kind), new RegExp(`review_kind_removed: ${kind} was removed in 1\\.38\\.0`, "u"));
    assert.ok(Array.isArray(graph.kg_review("duplicates").items));
    assert.ok(Array.isArray(graph.kg_review("anomalies").items));
    const tool = createOpenClawToolDefinitions(() => graph, "full").find(item => item.name === "kg_review");
    assert.ok(tool, "kg_review stays for duplicates, anomalies, identity and semantic patterns");
    assert.doesNotMatch(JSON.stringify(tool.parameters), /schema_drift|semantic_vocabulary|related_edge_|hygiene|worklist|repair_type/u);
  } finally { graph.close(); }
});

test("an endpoint mismatch no longer records a schema-drift candidate", () => {
  const store = new GraphologyStore(":memory:");
  try {
    store.ingest([entity("Widget", "product", "Widget works at Fabric."), entity("Fabric", "technology", "Widget works at Fabric.")],
      [{ source: "Widget", target: "Fabric", type: "works_at", confidence: .9, evidence_span: "Widget works at Fabric." }], "fixture:drift", 0, undefined, "work");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM kg_schema_drift_candidates").get().value, 0);
  } finally { store.close(); }
});

test("hard forget still clears legacy review rows that reference the entity", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const result = store.ingest([entity("Alpha", "concept", "Alpha relates to Beta."), entity("Beta", "concept", "Alpha relates to Beta.")], [], "fixture:forget", 0, undefined, "default");
    const [alpha, beta] = result.entities.map(item => item.node.id), now = Date.now(), hash = "a".repeat(64);
    store.db.exec("PRAGMA foreign_keys=OFF");
    store.db.prepare(`INSERT INTO kg_related_edge_refinement_candidates(id,scope,legacy_edge_id,source_entity_id,target_entity_id,proposed_source_entity_id,proposed_target_entity_id,proposed_type,evidence_observation_id,evidence_hash,rationale,confidence,first_seen_at,updated_at)
      VALUES('refine-1','default','edge-x',?,?,?,?,'depends_on','obs-x',?,'r',.5,?,?)`).run(alpha, beta, alpha, beta, hash, now, now);
    const semantic = store.db.prepare("PRAGMA table_info(kg_related_edge_semantic_candidates)").all().map(row => row.name);
    assert.ok(semantic.includes("source_entity_id") && semantic.includes("target_entity_id"));
    store.db.exec("PRAGMA foreign_keys=ON");
    const forgotten = store.forget(alpha, true, true);
    assert.ok(forgotten.deleted_nodes >= 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM kg_related_edge_refinement_candidates").get().value, 0);
  } finally { store.close(); }
});

test("a v55 database with drift candidates and repairs still upgrades", () => {
  const directory = createTempDir("mnemora-legacy-v55-"), path = join(directory, "memory.db");
  let store;
  try {
    store = new GraphologyStore(path);
    const result = store.ingest([entity("Widget", "product", "Widget uses Fabric."), entity("Fabric", "technology", "Widget uses Fabric.")], [], "fixture:v55", 0, undefined, "work");
    const [widget, fabric] = result.entities.map(item => item.node.id), now = Date.now();
    store.db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    store.db.exec(`DROP TABLE kg_schema_drift_candidates;
      CREATE TABLE kg_schema_drift_candidates (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL REFERENCES kg_scopes(id),
        source_entity_id TEXT NOT NULL REFERENCES kg_nodes(id), target_entity_id TEXT NOT NULL REFERENCES kg_nodes(id),
        relationship_type TEXT NOT NULL, source_type TEXT NOT NULL, target_type TEXT NOT NULL,
        expected_source_types TEXT NOT NULL, expected_target_types TEXT NOT NULL, relation_payload TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK(occurrence_count>=1), first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(scope,source_entity_id,target_entity_id,relationship_type),
        CHECK(json_valid(relation_payload) AND json_type(relation_payload)='object'));
      CREATE INDEX idx_kg_schema_drift_scope_updated ON kg_schema_drift_candidates(scope,updated_at DESC,id);`);
    store.db.prepare(`INSERT INTO kg_schema_drift_candidates(id,scope,source_entity_id,target_entity_id,relationship_type,source_type,target_type,expected_source_types,expected_target_types,relation_payload,first_seen_at,updated_at)
      VALUES('drift-1','work',?,?,'works_at','product','technology','person','company','{}',?,?)`).run(widget, fabric, now, now);
    store.db.exec("COMMIT; PRAGMA foreign_keys=ON; PRAGMA user_version=55");
    store.close();
    store = new GraphologyStore(path);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM kg_schema_drift_candidates WHERE id='drift-1'").get().value, 1);
    const columns = store.db.prepare("PRAGMA table_info(kg_schema_drift_candidates)").all().map(row => row.name);
    assert.ok(columns.includes("legacy_edge_id"));
    assert.ok(store.db.prepare("PRAGMA table_info(kg_schema_drift_repairs)").all().some(row => row.name === "retired_edge_id"));
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("removed features' configuration keys still load", () => {
  const config = normalizeConfig({ quality: { hygiene: { enabled: true, intervalHours: 24 } }, cognition: { graduation: { enabled: true } } });
  assert.equal(config.quality.hygiene.enabled, true, "accepted, though nothing reads it since 1.38.0");
});
