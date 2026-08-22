import assert from "node:assert/strict";
import test from "node:test";
import { personalizedPageRank, PprUnavailableError } from "../dist/ppr.js";
import { GraphologyStore } from "../dist/store.js";

test("PPR is deterministic, normalized, and returns dangling mass to personalization", () => {
  const input = { nodes: ["a", "b", "c"], arcs: [{ from: "a", to: "b", weight: 1 }, { from: "b", to: "c", weight: 1 }], seeds: { a: 1 } };
  const first = personalizedPageRank(input);
  const second = personalizedPageRank({ ...input, nodes: [...input.nodes].reverse(), arcs: [...input.arcs].reverse() });
  assert.deepEqual(first, second);
  assert.ok(Math.abs(Object.values(first).reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
  assert.equal(first.c > 0, true);
});

test("PPR respects direction, weights, and convergence configuration", () => {
  const ranks = personalizedPageRank({
    nodes: ["seed", "strong", "weak"], seeds: { seed: 1 },
    arcs: [{ from: "seed", to: "strong", weight: 1 }, { from: "seed", to: "weak", weight: .25 }]
  }, { damping: .85, maxIterations: 20, tolerance: 1e-6 });
  assert.equal(ranks.strong > ranks.weak, true);
});

test("PPR rejects non-finite input and every hard scale limit", () => {
  assert.throws(() => personalizedPageRank({ nodes: ["a"], arcs: [], seeds: { a: Number.NaN } }), PprUnavailableError);
  assert.throws(() => personalizedPageRank({ nodes: ["a", "b"], arcs: [], seeds: { a: 1 } }, { maxNodes: 1 }), /node limit/);
  assert.throws(() => personalizedPageRank({ nodes: ["a", "b"], arcs: [{ from: "a", to: "b", weight: 1 }], seeds: { a: 1 } }, { maxArcs: 0 }), /arc limit/);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => personalizedPageRank({ nodes: ["a"], arcs: [], seeds: { a: 1 } }, { signal: controller.signal }), /aborted/);
});

test("store builds a current-time direction-aware quality projection without evidence text", () => {
  const store = new GraphologyStore(":memory:");
  const companies = ["A", "B", "C"].map(name => ({ name, type: "company", confidence: 1, evidence_span: name }));
  try {
    store.ingest(companies, [
      { source: "A", target: "B", type: "supplies", confidence: 1, evidence_span: "secret supply" },
      { source: "A", target: "C", type: "related_to", confidence: .9, evidence_span: "secret relation" },
      { source: "B", target: "C", type: "supplies", confidence: 1, evidence_span: "expired", valid_to: 50 }
    ], "source:one");
    store.ingest([], [{ source: "A", target: "B", type: "supplies", confidence: 1, evidence_span: "second" }], "source:two");
    const ids = Object.fromEntries(["A", "B", "C"].map(name => [name, store.resolveEntity(name).id]));
    const snapshot = store.qualityGraphSnapshot([ids.A], { maxNodes: 10, maxArcs: 20 }, 100);
    const diversityOne = Math.log1p(1) / Math.log1p(5);
    const weights = Object.fromEntries(snapshot.arcs.map(arc => [`${arc.from}>${arc.to}`, arc.weight]));
    assert.deepEqual(snapshot.nodes, [ids.A, ids.C].sort());
    assert.equal(weights[`${ids.A}>${ids.B}`], undefined);
    assert.equal(weights[`${ids.B}>${ids.A}`], undefined);
    assert.ok(Math.abs(weights[`${ids.A}>${ids.C}`] - .35 * .9 * diversityOne) < 1e-12);
    assert.ok(Math.abs(weights[`${ids.C}>${ids.A}`] - .35 * .9 * diversityOne) < 1e-12);
    assert.equal(weights[`${ids.B}>${ids.C}`], undefined);
    assert.doesNotMatch(JSON.stringify(snapshot), /secret|quote|payload/i);
    assert.throws(() => store.qualityGraphSnapshot([ids.A], { maxNodes: 1, maxArcs: 20 }, 100), /node limit/);
  } finally { store.close(); }
});
