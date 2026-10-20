import { createTempDir } from "./helpers/temp.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { GraphologyStore, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";

test("v6.13 schema-drift migration is additive and preserves prior evidence", () => {
  const directory = createTempDir("mnemora-schema-drift-"), path = join(directory, "memory.db");
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
