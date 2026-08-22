import assert from "node:assert/strict";
import test from "node:test";
import { Mnemora, evaluateAdaptiveRecallShadow, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";

const config = { shadowMode: true, absoluteFloor: 0, relativeCutoffRatio: .9, confidenceGate: .6, minKeep: 2, candidateMultiplier: 5 };

test("adaptive recall cutoff is deterministic, bounded, and only falls back when the top score clears its confidence gate", () => {
  const selected = evaluateAdaptiveRecallShadow({
    candidates: [{ id: "a", score: .7 }, { id: "b", score: .2 }, { id: "c", score: .1 }, { id: "bad\u0000", score: 1 }],
    fixed: [{ id: "a", score: .7 }, { id: "b", score: .2 }], limit: 3, config
  });
  assert.deepEqual(selected, {
    policy_version: "adaptive-relative-v1", candidate_count: 3, fixed_count: 2, adaptive_count: 2, overlap_count: 2,
    empty: false, top_scores: [.7, .2, .1], absolute_floor: 0, relative_floor: .3
  });
  const withheld = evaluateAdaptiveRecallShadow({
    candidates: [{ id: "a", score: .59 }, { id: "b", score: .2 }], fixed: [], limit: 3, config
  });
  assert.equal(withheld.adaptive_count, 1);
  assert.equal(withheld.relative_floor, .3555);
});

test("shadow mode records bounded redacted metrics without changing the original context seeds", async () => {
  const extraction = { entities: [{ name: "Acme", type: "company", confidence: .9, evidence_span: "Acme supplies packaging." }], relations: [] };
  const base = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { recall: { shadowMode: false } } }, extractor: { extract: async () => extraction }, now: () => 1_700_000_000_000 });
  const shadow = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { recall: { shadowMode: true } } }, extractor: { extract: async () => extraction }, now: () => 1_700_000_000_000 });
  try {
    await base.ingestItem({ text: "Acme supplies packaging.", source: "manual:acme" });
    await shadow.ingestItem({ text: "Acme supplies packaging.", source: "manual:acme" });
    const expected = await base.kg_context("Acme", 5, 1, 0, 800, "lexical");
    const actual = await shadow.kg_context("Acme", 5, 1, 0, 800, "lexical");
    assert.deepEqual(actual.nodes.map(item => ({ id: item.node.id, score: item.score })), expected.nodes.map(item => ({ id: item.node.id, score: item.score })));
    assert.equal(actual.context, expected.context);
    assert.deepEqual(base.kg_recall_metrics(), { items: [], summary: { total_runs: 0, empty_runs: 0, empty_rate: 0 } });
    const metrics = shadow.kg_recall_metrics();
    assert.equal(metrics.items.length, 1);
    assert.deepEqual(metrics.summary, { total_runs: 1, empty_runs: 0, empty_rate: 0 });
    assert.equal(metrics.items[0].candidate_count, 1);
    assert.equal(metrics.items[0].fixed_count, 1);
    assert.equal(metrics.items[0].adaptive_count, 1);
    const raw = shadow.store.db.prepare("SELECT * FROM kg_recall_shadow_runs").get();
    assert.doesNotMatch(JSON.stringify(raw), /Acme|company:acme|query/i);
  } finally { base.close(); shadow.close(); }
});

test("recall shadow metrics remain scope-isolated and schema migration is additive", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { recall: { shadowMode: true } } } });
  try {
    await graph.kg_context("nothing", 3, 1, 0, 800, "lexical", undefined, "project:a");
    assert.equal(graph.store.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
    assert.equal(graph.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kg_recall_shadow_runs'").get().name, "kg_recall_shadow_runs");
    assert.equal(graph.kg_recall_metrics({ scope: "project:a" }).summary.empty_runs, 1);
    assert.equal(graph.kg_recall_metrics({ scope: "project:b" }).summary.total_runs, 0);
  } finally { graph.close(); }
});

test("shadow evaluation failures remain fail-open but emit bounded operator telemetry", async () => {
  const events = [];
  const graph = new Mnemora({
    config: { dbPath: ":memory:", trustLayer: { recall: { shadowMode: true } } },
    onRecallEvaluationFailure: event => events.push(event)
  });
  try {
    graph.recallShadow.observe = () => { throw new Error("sqlite details must not escape"); };
    await graph.kg_context("nothing", 3, 1, 0, 800, "lexical");
    assert.deepEqual(events, [{ stage: "shadow_record", category: "operation_failed" }]);
  } finally { graph.close(); }
});
