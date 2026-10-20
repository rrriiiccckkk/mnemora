import { createTempDir } from "./helpers/temp.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { GraphologyStore, Mnemora, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";

const entity = (name, type, quote) => ({ name, type, confidence: .95, evidence_span: quote });
const fallback = (source, target, quote) => [{ source, target, type: "related_to", confidence: .95, evidence_span: quote }];

function ingestBasedOn(graph, name, runtime, source) {
  const quote = `${name} is based on ${runtime}.`;
  return graph.store.ingest([entity(name, "product", quote), entity(runtime, "technology", quote)], fallback(name, runtime, quote), source, 0, undefined, "work");
}

test("v75 preserves existing related semantic reviews while widening only their label contract", () => {
  const directory = createTempDir("mnemora-semantic-vocabulary-"), path = join(directory, "memory.db");
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
    assert.equal(SUPPORTED_SCHEMA_VERSION, 88);
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
