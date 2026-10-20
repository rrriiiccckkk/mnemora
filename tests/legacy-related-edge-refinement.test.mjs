import { createTempDir } from "./helpers/temp.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { GraphologyStore, Mnemora, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";

const entities = (left, right, quote) => [
  { name: left, type: "product", confidence: .95, evidence_span: quote },
  { name: right, type: "technology", confidence: .95, evidence_span: quote }
];

const related = (left, right, quote, confidence = .95) => [{
  source: left, target: right, type: "related_to", confidence, evidence_span: quote
}];

test("v72 related-edge refinement migration is additive and retains existing evidence", () => {
  const directory = createTempDir("mnemora-related-edge-refinement-"), path = join(directory, "memory.db");
  let store;
  try {
    store = new GraphologyStore(path);
    const now = Date.now();
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("product:existing", "product", "Existing", "", "[]", 0, now, now);
    store.db.prepare("INSERT INTO kg_observations(id,source_entity_id,payload,source,scope,quote,confidence,created_at) VALUES(?,?,?,?,?,?,?,?)").run("obs:existing", "product:existing", "{}", "fixture", "default", "existing evidence", .9, now);
    store.db.exec("DROP TABLE kg_related_edge_refinement_receipts; DROP TABLE kg_related_edge_refinement_candidates; PRAGMA user_version=71");
    store.close(); store = new GraphologyStore(path);
    assert.equal(SUPPORTED_SCHEMA_VERSION, 88);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM kg_observations WHERE id='obs:existing'").get().value, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='kg_related_edge_refinement_candidates'").get().value, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='kg_related_edge_refinement_receipts'").get().value, 1);
  } finally {
    try { store?.close(); } catch {}
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  }
});
