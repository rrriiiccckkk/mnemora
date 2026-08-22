import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Mnemora } from "../dist/tools.js";
import { GraphologyStore } from "../dist/store.js";

const fixture = JSON.parse(readFileSync(new URL("../tests/fixtures/hybrid-retrieval.json", import.meta.url), "utf8"));
const vectors = new Map([
  ...fixture.nodes.map((node) => [node.name, node.vector]),
  ...fixture.queries.map((item) => [item.query, item.queryVector])
]);
const identity = { provider: "ollama", model: "benchmark-fake", dimensions: 3 };
const fakeEmbedder = {
  async embed(inputs) {
    return {
      identity,
      vectors: inputs.map((input) => {
        const name = input.match(/^name: (.+)$/m)?.[1] ?? input;
        const vector = vectors.get(name);
        assert.ok(vector, `missing deterministic fake vector for ${name}`);
        return vector;
      })
    };
  }
};
const entities = fixture.nodes.map(({ vector: _vector, ...node }) => ({ ...node, aliases: [], confidence: 1, evidence_span: node.name }));
const extraction = { entities, relations: [] };
const recallAt5 = (results, relevant) => {
  const returned = new Set(results.slice(0, 5).map((result) => result.node.id));
  return relevant.filter((id) => returned.has(id)).length / relevant.length;
};

const graph = new Mnemora({
  config: { dbPath: ":memory:", embeddings: { enabled: true, model: identity.model } },
  embedder: fakeEmbedder
});

try {
  assert.ok(graph.store instanceof GraphologyStore);
  const ingested = await graph.kg_ingest("deterministic hybrid retrieval fixture", "benchmark", extraction);
  assert.equal(ingested.entities.length, fixture.nodes.length);
  for (const { node } of ingested.entities) {
    assert.ok(graph.store.getEmbedding(node.id), `${node.id}: kg_ingest must persist its fake embedding through GraphologyStore.putEmbedding`);
  }

  const evaluated = [];
  for (const item of fixture.queries) {
    const lexicalResults = await graph.kg_search(item.query, undefined, 5, "lexical");
    const hybridResults = await graph.kg_search(item.query, undefined, 5, "hybrid");
    evaluated.push({ item, lexicalRecall: recallAt5(lexicalResults, item.relevant), hybridRecall: recallAt5(hybridResults, item.relevant) });
  }
  const mean = (key) => evaluated.reduce((sum, entry) => sum + entry[key], 0) / evaluated.length;
  const lexical = mean("lexicalRecall");
  const hybrid = mean("hybridRecall");
  const improvement = hybrid - lexical;
  for (const entry of evaluated.filter(({ item }) => item.exactName)) {
    assert.equal(entry.lexicalRecall, 1, `${entry.item.query}: lexical exact-name recall must remain 1.0`);
    assert.equal(entry.hybridRecall, 1, `${entry.item.query}: hybrid exact-name recall must remain 1.0`);
  }
  assert.ok(improvement >= 0.20, `hybrid recall improvement ${improvement.toFixed(3)} is below 0.20`);
  console.log(`hybrid benchmark: lexical recall@5=${lexical.toFixed(3)} hybrid recall@5=${hybrid.toFixed(3)} improvement=${improvement.toFixed(3)}`);
} finally {
  graph.close();
}
