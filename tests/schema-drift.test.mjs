import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphologyStore, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";

test("v6.13 schema-drift migration is additive and preserves prior evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-schema-drift-")), path = join(directory, "memory.db");
  let store;
  try {
    store = new GraphologyStore(path);
    const now = Date.now();
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("company:existing", "company", "Existing", "", "[]", 0, now, now);
    store.db.prepare("INSERT INTO kg_observations(id,source_entity_id,payload,source,scope,quote,confidence,created_at) VALUES(?,?,?,?,?,?,?,?)").run("obs:existing", "company:existing", "{}", "fixture", "default", "existing evidence", .9, now);
    store.db.exec("DROP TABLE kg_schema_drift_candidates; PRAGMA user_version=51");
    store.close(); store = new GraphologyStore(path);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM kg_nodes WHERE id='company:existing'").get().value, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM kg_observations WHERE id='obs:existing'").get().value, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='kg_schema_drift_candidates'").get().value, 1);
  } finally {
    try { store?.close(); } catch {}
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  }
});

test("hard forget removes review-only schema-drift references before deleting an endpoint", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const ingested = store.ingest([
      { name: "Acme", type: "company", confidence: .9, evidence_span: "Acme" },
      { name: "Widget", type: "product", confidence: .9, evidence_span: "Widget" }
    ], [], "fixture:drift");
    const [source, target] = ingested.entities.map(item => item.node);
    const now = Date.now();
    store.db.prepare(`INSERT INTO kg_schema_drift_candidates(
      id,scope,source_entity_id,target_entity_id,relationship_type,source_type,target_type,expected_source_types,expected_target_types,relation_payload,occurrence_count,first_seen_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)`).run("schema-drift:fixture", "default", source.id, target.id, "works_at", source.type, target.type, "person", "company", "{}", now, now);
    assert.doesNotThrow(() => store.forget(source.id, true, true));
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM kg_schema_drift_candidates").get().value, 0);
    assert.equal(store.getNodeById(source.id, true), null);
  } finally { store.close(); }
});

test("v6.18 preserves v55 drift candidates and repair receipts while adding legacy-edge review identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-schema-drift-v56-")), path = join(directory, "memory.db");
  let store;
  try {
    store = new GraphologyStore(path);
    const ingested = store.ingest([
      { name: "Widget", type: "product", confidence: .9, evidence_span: "Widget uses Fabric." },
      { name: "Fabric", type: "technology", confidence: .9, evidence_span: "Widget uses Fabric." }
    ], [{ source: "Widget", target: "Fabric", type: "works_at", confidence: .9, evidence_span: "Widget uses Fabric." }], "fixture:v56", 0, undefined, "work");
    const candidate = store.reviewSchemaDrift("work").items[0];
    const preview = store.previewSchemaDriftRepair(candidate.id, "depends_on", "work");
    store.confirmSchemaDriftRepair(candidate.id, "depends_on", preview.preview_hash, "work");
    store.db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    store.db.exec(`CREATE TABLE kg_schema_drift_candidates_v55 (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL REFERENCES kg_scopes(id),
      source_entity_id TEXT NOT NULL REFERENCES kg_nodes(id), target_entity_id TEXT NOT NULL REFERENCES kg_nodes(id),
      relationship_type TEXT NOT NULL, source_type TEXT NOT NULL, target_type TEXT NOT NULL,
      expected_source_types TEXT NOT NULL, expected_target_types TEXT NOT NULL, relation_payload TEXT NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK(occurrence_count>=1), first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(scope,source_entity_id,target_entity_id,relationship_type),
      CHECK(json_valid(relation_payload) AND json_type(relation_payload)='object')
    );
    INSERT INTO kg_schema_drift_candidates_v55(
      id,scope,source_entity_id,target_entity_id,relationship_type,source_type,target_type,expected_source_types,expected_target_types,relation_payload,occurrence_count,first_seen_at,updated_at
    ) SELECT id,scope,source_entity_id,target_entity_id,relationship_type,source_type,target_type,expected_source_types,expected_target_types,relation_payload,occurrence_count,first_seen_at,updated_at FROM kg_schema_drift_candidates;
    DROP TABLE kg_schema_drift_candidates;
    ALTER TABLE kg_schema_drift_candidates_v55 RENAME TO kg_schema_drift_candidates;
    CREATE INDEX idx_kg_schema_drift_scope_updated ON kg_schema_drift_candidates(scope,updated_at DESC,id);
    PRAGMA user_version=55;
    COMMIT; PRAGMA foreign_keys=ON;`);
    store.close(); store = new GraphologyStore(path);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
    assert.equal(store.db.prepare("SELECT legacy_edge_id FROM kg_schema_drift_candidates WHERE id=?").get(candidate.id).legacy_edge_id, "");
    assert.equal(store.schemaDrift.repair(candidate.id, "work").edge_id.length > 0, true);
    assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    try { store?.close(); } catch {}
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  }
});
