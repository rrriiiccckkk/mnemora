import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "@photostructure/sqlite";
import { GraphologyStore } from "../dist/store.js";

const identity = { provider: "ollama", model: "qwen3-embedding:4b", dimensions: 2 };
const entity = { name: "Nvidia", type: "company", description: "GPU company", confidence: 0.9, evidence_span: "Nvidia makes GPUs" };

function pathFor(name) {
  const root = join(process.cwd(), ".tmp");
  mkdirSync(root, { recursive: true });
  return join(mkdtempSync(join(root, `${name}-`)), "kg.db");
}

test("existing databases gain embedding metadata without losing graph data", () => {
  const dbPath = pathFor("embedding-migration");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE kg_nodes (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    aliases TEXT NOT NULL DEFAULT '[]', embedding BLOB, importance REAL NOT NULL DEFAULT 0,
    deleted_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  legacy.prepare("INSERT INTO kg_nodes VALUES (?,?,?,?,?,NULL,0,NULL,?,?)")
    .run("company:nvidia", "company", "Nvidia", "GPU company", "[]", 100, 100);
  legacy.close();

  const store = new GraphologyStore(dbPath);
  assert.equal(store.getNodeById("company:nvidia")?.name, "Nvidia");
  store.putEmbedding("company:nvidia", identity, "node-v1", [0.6, 0.8], 1234);
  store.close();

  const reopened = new GraphologyStore(dbPath);
  assert.deepEqual(reopened.getEmbedding("company:nvidia"), {
    provider: "ollama", model: "qwen3-embedding:4b", dimensions: 2,
    input_version: "node-v1", embedded_at: 1234, vector: [0.6000000238418579, 0.800000011920929]
  });
  reopened.close();
  new GraphologyStore(dbPath).close();
});

test("embedding candidates require an exact identity and input version", () => {
  const store = new GraphologyStore(pathFor("embedding-candidates"));
  try {
    store.ingest([entity, { ...entity, name: "AMD" }], [], "fixture");
    store.putEmbedding("company:nvidia", identity, "node-v1", [1, 0], 1234);
    store.putEmbedding("company:amd", { ...identity, model: "other" }, "node-v1", [0, 1], 1234);
    assert.deepEqual(store.listEmbeddingCandidates(identity, "node-v1", 10).map(({ node, vector }) => [node.id, vector]), [["company:nvidia", [1, 0]]]);
    assert.deepEqual(store.listEmbeddingCandidates(identity, "node-v2", 10), []);
  } finally { store.close(); }
});

test("putEmbedding rejects a missing node", () => { const store = new GraphologyStore(":memory:"); try { assert.throws(() => store.putEmbedding("missing", identity, "node-v1", [1,0]), /persistence/i); } finally { store.close(); } });

test("stale embedding selection is deterministic, paginated, and detects every stale condition", () => {
  const store = new GraphologyStore(pathFor("stale-embeddings"));
  try {
    for (const name of ["Alpha", "Beta", "Delta", "Epsilon", "Gamma", "Zeta"])
      store.ingest([{ ...entity, name }], [], `fixture:${name}`);
    const ids = ["company:alpha", "company:beta", "company:delta", "company:epsilon", "company:gamma", "company:zeta"];
    for (const id of ids) store.putEmbedding(id, identity, "node-v1", [1, 0], Date.now() + 10000);
    store.db.prepare("UPDATE kg_nodes SET embedding=NULL WHERE id='company:alpha'").run();
    store.db.prepare("UPDATE kg_nodes SET embedding_provider='other' WHERE id='company:beta'").run();
    store.db.prepare("UPDATE kg_nodes SET embedding_input_version='node-v0' WHERE id='company:delta'").run();
    store.db.prepare("UPDATE kg_nodes SET embedded_at=updated_at-1 WHERE id='company:epsilon'").run();
    store.db.prepare("UPDATE kg_nodes SET embedding_model='other' WHERE id='company:gamma'").run();

    assert.deepEqual(store.listStaleEmbeddingNodes({ provider: identity.provider, model: identity.model }, "node-v1", undefined, 2).map(n => n.id), ["company:alpha", "company:beta"]);
    assert.deepEqual(store.listStaleEmbeddingNodes({ provider: identity.provider, model: identity.model }, "node-v1", "company:beta", 10).map(n => n.id), ["company:delta", "company:epsilon", "company:gamma"]);
  } finally { store.close(); }
});
