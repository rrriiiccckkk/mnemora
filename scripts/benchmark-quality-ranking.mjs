import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { personalizedPageRank } from "../dist/ppr.js";
import { rankQualityCandidates } from "../dist/ranking.js";

const nodeCount = 10000;
const arcCount = 50000;
const nodes = Array.from({ length: nodeCount }, (_, index) => `node:${String(index).padStart(5, "0")}`);
const arcs = Array.from({ length: arcCount }, (_, index) => ({
  from: nodes[index % nodeCount], to: nodes[(index * 17 + Math.floor(index / nodeCount) + 1) % nodeCount], weight: .25 + (index % 4) * .25
}));
const started = performance.now();
const ppr = personalizedPageRank({ nodes, arcs, seeds: { [nodes[0]]: 1 } }, { maxNodes: nodeCount, maxArcs: arcCount, maxIterations: 20, tolerance: 1e-6 });
const ranked = rankQualityCandidates({ candidates: nodes.slice(0, 100).map((id, index) => ({
  id, semantic: 1 - index / 100, lexical: index === 0 ? 1 : 0, confidence: .8, reference_time: null,
  source_count: 2, ppr: ppr[id], unresolved_conflict: false, degree: 10
})) });
const elapsed = performance.now() - started;
assert.equal(Object.keys(ppr).length, nodeCount);
assert.equal(ranked.length, 100);
assert.equal(ranked.every(item => Number.isFinite(item.score)), true);
console.log(`quality benchmark: nodes=${nodeCount} arcs=${arcCount} elapsed_ms=${elapsed.toFixed(1)}`);
