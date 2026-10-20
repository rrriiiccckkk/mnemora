import { createTempDir } from "./helpers/temp.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

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
    const analyst = store.getNodeById(result.entities[0].node.id);
    assert.equal(analyst?.type, "person", "a compatible relation must not require identity relabeling");
    assert.equal(store.qualityGraphSnapshot([result.entities[0].node.id], { maxNodes: 10, maxArcs: 10 }).arcs.length, 0, "semantic coverage must not add a PPR arc");
  } finally { store.close(); }
});

test("company develops concept is accepted by the ontology without rewriting graph topology", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const result = store.ingest(
      entities("Warp", "company", "Self-improving agents", "concept", "Warp develops self-improving agents."),
      [{ source: "Warp", target: "Self-improving agents", type: "develops", confidence: .92, evidence_span: "Warp develops self-improving agents." }],
      "fixture:company-develops-concept", 0, undefined, "research"
    );
    assert.equal(result.relations.length, 1);
    assert.equal(store.getNodeById(result.entities[0].node.id)?.type, "company");
    assert.equal(store.getNodeById(result.entities[1].node.id)?.type, "concept");
    assert.equal(store.qualityGraphSnapshot([result.entities[0].node.id], { maxNodes: 10, maxArcs: 10 }).arcs.length, 0, "semantic coverage must not add a PPR arc");
  } finally { store.close(); }
});

test("v75 schema drift review migration is additive and retains historic candidates", () => {
  const directory = createTempDir("mnemora-schema-drift-review-"), path = join(directory, "memory.db");
  let store;
  try {
    store = new GraphologyStore(path);
    const now = Date.now();
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("product:existing", "product", "Existing", "", "[]", 0, now, now);
    store.db.prepare("INSERT INTO kg_observations(id,source_entity_id,payload,source,scope,quote,confidence,created_at) VALUES(?,?,?,?,?,?,?,?)").run("obs:existing", "product:existing", "{}", "fixture", "default", "existing evidence", .9, now);
    store.db.exec("DROP TABLE kg_schema_drift_reviews; DROP TABLE kg_schema_drift_invalidations; PRAGMA user_version=75");
    store.close(); store = new GraphologyStore(path);
    assert.equal(SUPPORTED_SCHEMA_VERSION, 88);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM kg_observations WHERE id='obs:existing'").get().value, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='kg_schema_drift_reviews'").get().value, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='kg_schema_drift_invalidations'").get().value, 1);
  } finally {
    try { store?.close(); } catch {}
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  }
});
