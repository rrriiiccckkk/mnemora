import assert from "node:assert/strict";
import test from "node:test";
import {
  EvaluationDatasetRepository,
  EvaluationRunner,
  createMnemoraContextRef,
  serializeEvaluationReport,
  validateEvaluationDataset
} from "../dist/index.js";

const ref = (scope, kind, id) => createMnemoraContextRef({ scope, kind, id });
const refs = {
  simple: ref("project:a", "claim", "claim:simple"),
  complex: ref("project:a", "episode", "episode:complex"),
  source: ref("project:a", "artifact", "artifact:source"),
  long: ref("project:a", "conversation-event", "event:long"),
  distractor: ref("project:a", "claim", "claim:distractor"),
  foreign: ref("project:b", "claim", "claim:foreign")
};

const dataset = {
  version: 1,
  id: "phase0.synthetic.v1",
  description: "contains-query-that-must-not-be-reported",
  seed: 42,
  cases: [
    { id: "simple", kind: "simple_find", scope: "project:a", query: "private-simple-query", expectedRefs: [refs.simple], topK: 5, cohort: "explicit" },
    { id: "complex", kind: "complex_search", scope: "project:a", query: "private-complex-query", expectedRefs: [refs.complex], cohort: "auto_extract" },
    { id: "source", kind: "source_recovery", scope: "project:a", query: "private-source-query", expectedRefs: [refs.source] },
    { id: "long", kind: "long_session_recall", scope: "project:a", query: "private-long-query", expectedRefs: [refs.long] },
    { id: "empty", kind: "empty_recall", scope: "project:a", query: "private-empty-query", expectedRefs: [] },
    { id: "scope", kind: "scope_isolation", scope: "project:a", query: "private-scope-query", expectedRefs: [], forbiddenRefs: [refs.foreign] }
  ]
};

test("evaluation datasets are validated, copied, bounded, and kept in memory", () => {
  const repository = new EvaluationDatasetRepository();
  const registered = repository.register(dataset);
  registered.cases[0].query = "mutated";
  assert.equal(repository.get(dataset.id).cases[0].query, "private-simple-query");
  assert.deepEqual(repository.list(), [{ id: dataset.id, version: 1, cases: 6 }]);
  assert.throws(() => repository.register(dataset), /duplicate_dataset/);
  assert.throws(() => validateEvaluationDataset({ ...dataset, cases: [{ ...dataset.cases[0], expectedRefs: [refs.foreign] }] }), /invalid_dataset/);
  assert.throws(() => validateEvaluationDataset({ ...dataset, cases: [{ ...dataset.cases[0], query: "x".repeat(20_000) }] }), /invalid_dataset/);
  assert.throws(() => validateEvaluationDataset({ ...dataset, cases: [{ ...dataset.cases[0], cohort: "unreviewed" }] }), /invalid_dataset/);
});

test("evaluation runner records retrieval, source, empty, latency, token, and scope baselines without raw data", async () => {
  const find = async ({ query }) => {
    const candidates = query.includes("simple")
      ? [{ contextRef: refs.simple, estimatedTokens: 12, bytes: 48 }, { contextRef: refs.distractor, estimatedTokens: 4, bytes: 16 }]
      : query.includes("source")
        ? [{ contextRef: refs.source, sourceRecovered: true, estimatedTokens: 20, bytes: 80 }]
        : query.includes("long")
          ? [{ contextRef: refs.long, estimatedTokens: 10, bytes: 40 }]
          : query.includes("scope") ? [{ contextRef: refs.foreign, estimatedTokens: 3, bytes: 12 }] : [];
    return { candidates };
  };
  const runner = new EvaluationRunner({ find, search: async () => ({ candidates: [{ contextRef: refs.complex, estimatedTokens: 16, bytes: 64 }], plannedQueries: 2 }) });
  const report = await runner.run(dataset, { operationTimeoutMs: 100, deadlineMs: 2_000, now: () => 1_000 });
  assert.equal(report.metrics.cases, 6);
  assert.equal(report.metrics.recallAtK, 1);
  assert.deepEqual(report.metrics.recallCurve, { k3: 1, k5: 1, k10: 1 });
  assert.deepEqual(report.metrics.precisionCurve, { k3: .875, k5: .875, k10: .875 });
  assert.equal(report.cohorts.explicit.recallAtK, 1);
  assert.equal(report.cohorts.auto_extract.recallAtK, 1);
  assert.equal(report.metrics.emptyRecallPrecision, 1);
  assert.equal(report.metrics.sourceRecoveryRate, 1);
  assert.equal(report.metrics.scopeLeakageRate, .166667);
  assert.equal(report.metrics.selectedTokens.average, 10.833333);
  assert.equal(report.results.find(item => item.caseId === "complex").route, "search");
  assert.equal(report.results.find(item => item.caseId === "simple").cohort, "explicit");
  assert.equal(report.results.find(item => item.caseId === "scope").crossScopeReturned, 1);
  const json = serializeEvaluationReport(report);
  for (const secret of ["private-simple-query", "private-complex-query", "project:a", "contains-query-that-must-not-be-reported", "Provider response body"]) assert.doesNotMatch(json, new RegExp(secret, "i"));
});

test("complex search accepts zero planned queries and falls back to find on bounded failures", async () => {
  let findCalls = 0;
  const zero = await new EvaluationRunner({
    find: async () => (findCalls++, { candidates: [{ contextRef: refs.complex }] }),
    search: async () => ({ candidates: [], plannedQueries: 0 })
  }).run({ ...dataset, cases: [dataset.cases[1]] });
  assert.equal(zero.results[0].route, "search");
  assert.equal(zero.results[0].returned, 0);
  assert.equal(findCalls, 0);

  const fallback = await new EvaluationRunner({
    find: async () => (findCalls++, { candidates: [{ contextRef: refs.complex }] }),
    search: async () => { throw new Error("Provider response body: secret"); }
  }).run({ ...dataset, cases: [dataset.cases[1]] });
  assert.equal(fallback.results[0].route, "find_fallback");
  assert.equal(fallback.results[0].fallbackCategory, "search_provider");
  assert.equal(fallback.results[0].status, "succeeded");
  assert.doesNotMatch(JSON.stringify(fallback), /Provider response body|secret/);
});

test("evaluation calls receive cancellation and expose only bounded failure categories", async () => {
  let aborted = false;
  const runner = new EvaluationRunner({
    find: async ({ signal }) => await new Promise((resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("private body")); }, { once: true }))
  });
  const report = await runner.run({ ...dataset, cases: [dataset.cases[0]] }, { operationTimeoutMs: 10, deadlineMs: 100 });
  assert.equal(aborted, true);
  assert.equal(report.results[0].status, "failed");
  assert.equal(report.results[0].failureCategory, "deadline");
  assert.doesNotMatch(JSON.stringify(report), /private body|private-simple-query/);
});
