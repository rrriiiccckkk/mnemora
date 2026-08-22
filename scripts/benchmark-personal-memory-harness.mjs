import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Mnemora, EvaluationRunner, createMnemoraContextRef } from "../dist/index.js";

const fixture = JSON.parse(readFileSync(new URL("../tests/fixtures/personal-memory-harness-phase0.json", import.meta.url), "utf8"));
assert.equal(fixture.fixture_version, 1);
const graph = new Mnemora({ config: { dbPath: ":memory:", recall: { mode: "lexical", tokenBudget: 800 }, memory: { maxResults: 3 } } });

try {
  const ingested = await graph.kg_ingest("synthetic personal memory harness graph", "fixture:phase0", { entities: fixture.entities, relations: fixture.relations }, fixture.scope);
  await graph.kg_ingest("synthetic foreign scope marker", "fixture:foreign", { entities: [fixture.foreign_entity], relations: [] }, fixture.foreign_scope);
  const nodeByName = new Map(ingested.entities.map(item => [item.node.name, item.node]));
  const foreignNode = graph.store.resolveEntity(fixture.foreign_entity.name, undefined, fixture.foreign_scope);
  assert.ok(foreignNode);
  const targetMemory = graph.kg_memory({ operation: "store", scope: fixture.scope, ...fixture.memory });
  for (let index = 0; index < fixture.distractor_memories; index++) graph.kg_memory({
    operation: "store", scope: fixture.scope, title: `Synthetic distractor ${index}`, source: "fixture:distractor",
    content: `Unrelated bounded session note number ${index} about routine archive maintenance.`
  });

  const toRef = (scope, domain, id) => createMnemoraContextRef({ scope, kind: domain === "memory" ? "episode" : "claim", id });
  const resolveFixtureRef = (entry, fallbackScope = fixture.scope) => {
    if (entry.domain === "memory") {
      assert.equal(entry.name, targetMemory.title);
      return toRef(entry.scope ?? fallbackScope, "memory", targetMemory.id);
    }
    const node = (entry.scope ?? fallbackScope) === fixture.foreign_scope ? foreignNode : nodeByName.get(entry.name);
    assert.ok(node, `missing fixture node ${entry.name}`);
    return toRef(entry.scope ?? fallbackScope, "node", node.id);
  };
  const dataset = {
    version: 1,
    id: fixture.dataset_id,
    description: "Synthetic, project-native Phase 0 retrieval baseline.",
    seed: fixture.seed,
    cases: fixture.cases.map(item => ({
      id: item.id, kind: item.kind, scope: fixture.scope, query: item.query,
      expectedRefs: item.expected.map(entry => resolveFixtureRef(entry)),
      ...(item.forbidden ? { forbiddenRefs: item.forbidden.map(entry => resolveFixtureRef(entry)) } : {}),
      topK: 5
    }))
  };

  const candidatesFromFind = async ({ query, scope, limit, signal }) => {
    const nodes = await graph.kg_search(query, undefined, limit, "lexical", signal, scope);
    const memories = graph.kg_memory({ operation: "search", query, scope, limit, mode: "lexical" });
    return { candidates: [
      ...nodes.map(item => ({ contextRef: toRef(scope, "node", item.node.id), score: item.score, sourceRecovered: item.evidence.length > 0, estimatedTokens: Math.ceil(JSON.stringify(item).length / 4), bytes: Buffer.byteLength(JSON.stringify(item)) })),
      ...memories.map(item => ({ contextRef: toRef(scope, "memory", item.id), score: item.score, sourceRecovered: Boolean(item.source), estimatedTokens: Math.ceil(JSON.stringify(item).length / 4), bytes: Buffer.byteLength(JSON.stringify(item)) }))
    ].slice(0, limit) };
  };
  const subject = {
    find: candidatesFromFind,
    search: async ({ query, scope, limit, signal }) => {
      const result = await graph.kg_context(query, limit, 1, 0, 800, "lexical", signal, scope, { recordMetrics: false });
      const candidates = [
        ...result.nodes.map(item => ({ contextRef: toRef(scope, "node", item.node.id), score: item.score, sourceRecovered: item.evidence.length > 0 })),
        ...(result.memories ?? []).map(item => ({ contextRef: toRef(scope, "memory", item.id), score: item.score, sourceRecovered: Boolean(item.source) }))
      ];
      if (candidates.length) {
        candidates[0].estimatedTokens = Math.ceil(result.context.length / 4);
        candidates[0].bytes = Buffer.byteLength(result.context);
      }
      return { candidates: candidates.slice(0, limit), plannedQueries: 1 };
    }
  };
  const report = await new EvaluationRunner(subject).run(dataset, { candidateLimit: 5, operationTimeoutMs: 1_000, deadlineMs: 10_000 });
  assert.equal(report.metrics.failed, 0);
  assert.equal(report.metrics.recallAtK, 1);
  assert.equal(report.metrics.emptyRecallPrecision, 1);
  assert.equal(report.metrics.sourceRecoveryRate, 1);
  assert.equal(report.metrics.scopeLeakageRate, 0);
  assert.ok(report.metrics.latencyMs.p95 < 1_000);
  assert.ok(report.metrics.selectedTokens.maximum <= 800);
  console.log(JSON.stringify({ benchmark: "personal-memory-harness-phase0", fixture: { dataset: report.dataset, cases: report.metrics.cases, graph_nodes: fixture.entities.length + 1, memory_documents: fixture.distractor_memories + 1 }, metrics: report.metrics }, null, 2));
} finally {
  graph.close();
}
