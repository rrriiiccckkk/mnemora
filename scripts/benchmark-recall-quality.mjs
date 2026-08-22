import assert from "node:assert/strict";
import { Mnemora, EvaluationRunner, UnifiedRetrievalService, createMnemoraContextRef } from "../dist/index.js";

// This is a fixed, entirely fictional regression corpus. It deliberately
// contains no conversation, artifact, or operator data. A passing result is a
// repeatable implementation signal, not evidence about a person's memory or
// an AutoExtract model's real-world quality.
const policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" };
const graph = new Mnemora({ config: { dbPath: ":memory:" } });

try {
  const scope = "fixture:quality";
  const ref = (id, valueScope = scope) => createMnemoraContextRef({ scope: valueScope, kind: "memory-document", id });
  const stored = [];
  for (const index of Array.from({ length: 40 }, (_, value) => value + 1)) {
    const lane = index <= 20 ? "explicit" : "auto-extract-proxy";
    const token = `mnemorafixturebeacon${String(index).padStart(2, "0")}`;
    const item = graph.kg_memory({
      operation: "store", scope,
      title: `${lane} quality fixture ${index}`,
      source: `fixture:${lane}`,
      content: `${token} is a fictional, source-linked memory quality fixture ${index}.`
    });
    stored.push({ index, lane, token, id: item.id });
  }
  const foreign = Array.from({ length: 5 }, (_, value) => {
    const token = `mnemoraforeignbeacon${String(value + 1).padStart(2, "0")}`;
    const item = graph.kg_memory({ operation: "store", scope: "fixture:foreign", title: `foreign fixture ${value + 1}`, source: "fixture:foreign", content: `${token} stays outside the selected scope.` });
    return { token, id: item.id };
  });
  const cases = [
    ...stored.map(item => ({
      id: `${item.lane}-${item.index}`, kind: item.index % 3 === 0 ? "source_recovery" : item.index % 5 === 0 ? "complex_search" : "simple_find",
      scope, query: item.token, expectedRefs: [ref(item.id)], topK: 10,
      cohort: item.lane === "explicit" ? "explicit" : "auto_extract"
    })),
    ...Array.from({ length: 5 }, (_, value) => ({ id: `empty-${value + 1}`, kind: "empty_recall", scope, query: `mnemoraabsentbeacon${value + 1}`, expectedRefs: [], topK: 4 })),
    ...foreign.map((item, value) => ({ id: `scope-${value + 1}`, kind: "scope_isolation", scope, query: item.token, expectedRefs: [], forbiddenRefs: [ref(item.id, "fixture:foreign")], topK: 4 }))
  ];
  assert.equal(cases.length, 50);
  const dataset = {
    version: 1,
    id: "recall-quality.synthetic-golden.v3",
    description: "Fixed fictional release regression corpus; not production or user data.",
    seed: 622,
    cases
  };
  const service = new UnifiedRetrievalService(graph.store.db, policy);
  const find = async ({ scope: requestScope, query, limit, signal }) => {
    const result = service.find({ scope: requestScope, query, limit, tokenBudget: 800, signal });
    return { candidates: result.candidates.map(item => ({ contextRef: item.contextRef, score: item.score, sourceRecovered: item.sourceRefs.length > 0, estimatedTokens: item.estimatedTokens, bytes: item.bytes })) };
  };
  const report = await new EvaluationRunner({ find, search: find }).run(dataset, { candidateLimit: 10, operationTimeoutMs: 1_000, deadlineMs: 20_000 });
  assert.equal(report.metrics.failed, 0);
  assert.equal(report.metrics.recallAtK, 1);
  assert.deepEqual(report.metrics.recallCurve, { k3: 1, k5: 1, k10: 1 });
  assert.deepEqual(report.metrics.precisionCurve, { k3: 1, k5: 1, k10: 1 });
  assert.equal(report.metrics.emptyRecallPrecision, 1);
  assert.equal(report.metrics.sourceRecoveryRate, 1);
  assert.equal(report.metrics.scopeLeakageRate, 0);
  assert.equal(report.metrics.selectedTokens.maximum <= 800, true);
  const comparison = { kind: "synthetic_policy_proxy", explicit: report.cohorts?.explicit, auto_extract_proxy: report.cohorts?.auto_extract };
  assert.equal(comparison.explicit?.recallAtK, 1);
  assert.equal(comparison.auto_extract_proxy?.recallAtK, 1);
  // Metrics-only output: never serialize fixture queries, document bodies,
  // scopes, session identifiers, or provider responses.
  console.log(JSON.stringify({ benchmark: "recall-quality-v3", dataset: report.dataset, metrics: report.metrics, comparison, evidence_kind: "fictional_regression_only", admission_policy_eligible: false }, null, 2));
} finally {
  graph.close();
}
