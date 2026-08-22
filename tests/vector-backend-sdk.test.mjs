import assert from "node:assert/strict";
import test from "node:test";
import { Mnemora, VECTOR_BACKEND_CONTRACT_V1, VectorBackendContractError, VectorBackendRegistry } from "../dist/index.js";

const identity = { provider: "ollama", model: "fixture", dimensions: 2 };
const entity = (name) => ({ name, type: "company", description: `${name} description`, aliases: [], confidence: .9, evidence_span: name });

function backend(overrides = {}) {
  const calls = [];
  return {
    calls,
    adapter: {
      id: "fixture-ann",
      contractVersion: VECTOR_BACKEND_CONTRACT_V1,
      capabilities: { upsertNodes: true, searchNodes: true, deleteNodes: true, listNodeIds: true, supportsAbortSignal: true },
      async probe(options) { calls.push({ operation: "probe", options }); return { backendId: "fixture-ann", detectedVersion: "0.1.0", ...this.capabilities }; },
      async upsertNodes(records, options) { calls.push({ operation: "upsert", records, options }); },
      async searchNodes(input, options) { calls.push({ operation: "search", input, options }); return []; },
      async deleteNodes(input, options) { calls.push({ operation: "delete", input, options }); },
      async listNodeIds(input, options) { calls.push({ operation: "list", input, options }); return { ids: [], nextCursor: null }; },
      ...overrides
    }
  };
}

test("Vector Backend SDK validates contracts, keeps payloads opaque, and bounds calls", async () => {
  const { adapter, calls } = backend();
  const registry = new VectorBackendRegistry([{ backend: adapter, limits: { timeoutMs: 1000, maxBatchRecords: 1, maxCandidates: 3 } }]);
  const probe = await registry.probe("fixture-ann");
  await registry.upsertNodes("fixture-ann", [
    { id: "company:one", identity, inputVersion: "node-v1", vector: [1, 0] },
    { id: "company:two", identity, inputVersion: "node-v1", vector: [0, 1] }
  ]);
  assert.equal(probe.detectedVersion, "0.1.0");
  assert.equal(calls.filter(call => call.operation === "upsert").length, 2);
  assert.deepEqual(Object.keys(calls.find(call => call.operation === "upsert").records[0]).sort(), ["id", "identity", "inputVersion", "vector"]);
  assert.equal(calls.find(call => call.operation === "upsert").options.signal instanceof AbortSignal, true);
  assert.throws(() => new VectorBackendRegistry([{ backend: { ...adapter, id: "Bad_ID" } }]), error => error instanceof VectorBackendContractError && error.code === "invalid_vector_backend");
});

test("an optional backend is locally reauthorized by scope and falls back to SQLite on failure", async () => {
  let projectId, otherId;
  const { adapter, calls } = backend({
    async searchNodes(input, options) {
      calls.push({ operation: "search", input, options });
      return [{ id: otherId, score: .99 }, { id: projectId, score: .91 }, { id: "company:missing", score: .98 }];
    }
  });
  const graph = new Mnemora({
    config: { dbPath: ":memory:", embeddings: { enabled: true, model: "fixture" } },
    embedder: { async embed() { return { identity, vectors: [[1, 0]] }; } },
    vectorBackends: [{ backend: adapter }],
    vectorBackendId: "fixture-ann"
  });
  try {
    const project = graph.store.ingest([entity("Project only")], [], "fixture", 0, undefined, "project").entities[0].node;
    const other = graph.store.ingest([entity("Other only")], [], "fixture", 0, undefined, "other").entities[0].node;
    projectId = project.id; otherId = other.id;
    graph.store.putEmbedding(project.id, identity, "node-v1", [1, 0]);
    graph.store.putEmbedding(other.id, identity, "node-v1", [1, 0]);
    const result = await graph.kg_search("opaque query", undefined, 5, "semantic", undefined, "project");
    assert.deepEqual(result.map(item => item.node.id), [project.id]);
    assert.equal(calls.find(call => call.operation === "search").input.scope, "project");
    assert.equal(calls.find(call => call.operation === "search").options.signal instanceof AbortSignal, true);

    adapter.searchNodes = async () => { throw new Error("offline"); };
    const fallback = await graph.kg_search("opaque query", undefined, 5, "semantic", undefined, "project");
    assert.deepEqual(fallback.map(item => item.node.id), [project.id]);

    adapter.searchNodes = async () => [];
    const emptyIndexFallback = await graph.kg_search("opaque query", undefined, 5, "semantic", undefined, "project");
    assert.deepEqual(emptyIndexFallback.map(item => item.node.id), [project.id]);
  } finally { graph.close(); }
});

test("explicit vector-index sync is cursor-based and transfers existing vectors without graph content", async () => {
  const { adapter, calls } = backend();
  const graph = new Mnemora({ config: { dbPath: ":memory:" }, vectorBackends: [{ backend: adapter }], vectorBackendId: "fixture-ann" });
  try {
    const nodes = graph.store.ingest([entity("Alpha"), entity("Beta")], [], "fixture").entities.map(item => item.node);
    for (const node of nodes) graph.store.putEmbedding(node.id, identity, "node-v1", [1, 0]);
    const first = await graph.syncVectorBackend({ identity, limit: 1 });
    assert.equal(first.backend_id, "fixture-ann");
    assert.equal(first.processed, 1);
    assert.ok(first.next_after_id);
    const second = await graph.syncVectorBackend({ identity, after_id: first.next_after_id, limit: 1 });
    assert.equal(second.processed, 1);
    assert.equal(second.next_after_id, null);
    const records = calls.filter(call => call.operation === "upsert").flatMap(call => call.records);
    assert.equal(records.length, 2);
    assert.equal(JSON.stringify(records).includes("Alpha"), false);
  } finally { graph.close(); }
});

test("optional indexes delete retired vectors and reconcile only stale opaque ids", async () => {
  const remote = new Set();
  const { adapter, calls } = backend({
    async upsertNodes(records, options) { calls.push({ operation: "upsert", records, options }); for (const record of records) remote.add(record.id); },
    async deleteNodes(input, options) { calls.push({ operation: "delete", input, options }); for (const id of input.ids) remote.delete(id); },
    async listNodeIds(input, options) { calls.push({ operation: "list", input, options }); return { ids: [...remote].sort().slice(0, input.limit), nextCursor: null }; }
  });
  const graph = new Mnemora({ config: { dbPath: ":memory:" }, vectorBackends: [{ backend: adapter }], vectorBackendId: "fixture-ann" });
  try {
    const [alpha, beta] = graph.store.ingest([entity("Alpha"), entity("Beta")], [], "fixture").entities.map(item => item.node);
    graph.store.putEmbedding(alpha.id, identity, "node-v1", [1, 0]);
    graph.store.putEmbedding(beta.id, identity, "node-v1", [0, 1]);
    await graph.syncVectorBackend({ identity, limit: 10 });
    remote.add("company:stale");
    const cleanup = await graph.kg_forget(alpha.id);
    assert.equal(cleanup.vector_index_cleanup, "removed");
    assert.equal(remote.has(alpha.id), false);
    const reconciled = await graph.reconcileVectorBackend({ identity, inputVersion: "node-v1" });
    assert.deepEqual(reconciled, { backend_id: "fixture-ann", examined: 2, deleted: 1, next_cursor: null, status: "supported" });
    assert.equal(remote.has("company:stale"), false);
    const health = await graph.vectorBackendHealth({ identity, inputVersion: "node-v1" });
    assert.equal(health.status, "healthy");
    assert.equal(health.lifecycle, "supported");
    assert.equal(health.indexed_local_nodes, 1);
    assert.equal(JSON.stringify(calls.filter(call => call.operation === "list")).includes("Alpha"), false);
  } finally { graph.close(); }
});
