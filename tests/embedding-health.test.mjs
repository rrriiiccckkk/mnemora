import assert from "node:assert/strict";
import test from "node:test";
import { Mnemora } from "../dist/index.js";

const healthyEmbedder = {
  async embed(inputs) {
    return { identity: { provider: "ollama", model: "fixture-health", dimensions: 2 }, vectors: inputs.map(() => [1, 0]) };
  }
};

test("embedding health is disabled by default and declares deterministic fallback behavior", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    assert.deepEqual(graph.kg_stats().embedding_health, {
      configured: false,
      state: "disabled",
      fallback: { hybrid: "lexical_on_unavailable", semantic: "bounded_error" }
    });
  } finally { graph.close(); }
});

test("hybrid retrieval records local embedding health while preserving lexical fallback on provider failure", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:", embeddings: { enabled: true, model: "fixture-health" } }, embedder: healthyEmbedder });
  try {
    graph.store.ingest([{ name: "NVIDIA", type: "company", confidence: .9, evidence_span: "NVIDIA" }], [], "fixture:health");
    await graph.kg_search("NVIDIA", undefined, 5, "hybrid");
    assert.equal(graph.kg_stats().embedding_health?.state, "healthy");

    const failing = new Mnemora({ config: { dbPath: ":memory:", embeddings: { enabled: true, model: "fixture-health" } }, embedder: { async embed() { throw new TypeError("local provider unavailable"); } } });
    try {
      failing.store.ingest([{ name: "NVIDIA", type: "company", confidence: .9, evidence_span: "NVIDIA" }], [], "fixture:health");
      const lexical = await failing.kg_search("NVIDIA", undefined, 5, "hybrid");
      assert.equal(lexical[0]?.node.name, "NVIDIA");
      assert.deepEqual(failing.kg_stats().embedding_health, {
        configured: true,
        state: "degraded",
        provider: "ollama",
        model: "fixture-health",
        last_failure_at: failing.kg_stats().embedding_health?.last_failure_at,
        last_failure_category: "provider",
        fallback: { hybrid: "lexical_on_unavailable", semantic: "bounded_error" }
      });
    } finally { failing.close(); }
  } finally { graph.close(); }
});
