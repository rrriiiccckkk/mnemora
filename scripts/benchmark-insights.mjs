import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { detectCommunities } from "../dist/insights/community.js";
import { calculateCommunityMetrics } from "../dist/insights/metrics.js";
import { detectCrossCommunityPaths, detectEmergingTopics, detectKnowledgeGaps } from "../dist/insights/detectors.js";

const nodeCount = 10000;
const edgeCount = 50000;
const communitySize = 100;
const asOf = Date.UTC(2026, 6, 16);
const nodes = Array.from({ length: nodeCount }, (_, index) => ({
  id: `node:${String(index).padStart(5, "0")}`,
  name: `Benchmark node ${index}`,
  type: "concept"
}));
const edges = Array.from({ length: edgeCount }, (_, index) => {
  const sourceIndex = Math.floor(index / 5);
  const offset = index % 5 + 1;
  const communityStart = Math.floor(sourceIndex / communitySize) * communitySize;
  const isBridge = offset === 5 && sourceIndex % communitySize === 0;
  const targetIndex = isBridge
    ? (sourceIndex + communitySize) % nodeCount
    : communityStart + (sourceIndex - communityStart + offset) % communitySize;
  const recent = sourceIndex % 4 !== 0;
  return {
    id: `edge:${String(index).padStart(5, "0")}`,
    source: nodes[sourceIndex].id,
    target: nodes[targetIndex].id,
    type: "related_to",
    weight: isBridge ? .2 : 1 + (offset % 3) * .25,
    confidence: .65 + (index % 4) * .1,
    evidenceCount: 1 + index % 3,
    sourceCount: 1 + index % 2,
    firstSeenAt: asOf - (recent ? 3 : 20) * 86400000,
    lastSeenAt: asOf - (recent ? 1 : 15) * 86400000
  };
});
const projection = { nodes, edges, truncated: false, graphRevision: 1, asOf };
const config = {
  maxNodes: nodeCount, maxEdges: edgeCount, confidenceFloor: .6,
  recentWindowDays: 7, baselineWindowDays: 28, minEmergingEntities: 3,
  minEmergingGrowth: 2, maxPathLength: 4, maxResults: 20
};

function run() {
  const partition = detectCommunities(projection);
  const metrics = calculateCommunityMetrics(projection, partition, config);
  const insights = [
    ...detectKnowledgeGaps(projection, partition, config, config.maxResults),
    ...detectEmergingTopics(projection, partition, config, config.maxResults),
    ...detectCrossCommunityPaths(projection, partition, config, config.maxResults)
  ];
  return { partition, metrics, insights };
}

assert.equal(nodes.length, 10000);
assert.equal(edges.length, 50000);
const started = performance.now();
const first = run();
const second = run();
const elapsed = performance.now() - started;
assert.deepEqual(second.partition.membership, first.partition.membership);
assert.deepEqual(second.insights.map(item => item.id), first.insights.map(item => item.id));
assert.equal(first.partition.communities.length <= nodeCount, true);
assert.equal(first.partition.modularity >= -1 && first.partition.modularity <= 1, true);
assert.equal(first.metrics.length <= nodeCount, true);
assert.equal(first.metrics.every(item => Object.values(item)
  .filter(value => typeof value === "number")
  .every(value => Number.isFinite(value))), true);
assert.equal(first.metrics.every(item => [item.density, item.average_confidence, item.evidence_coverage, item.source_concentration, item.bridge_score, item.weighted_boundary_ratio].every(value => Number.isFinite(value) && value >= 0 && value <= 1)), true);
assert.equal(first.insights.length <= config.maxResults * 3, true);
assert.equal(first.insights.every(item => Number.isFinite(item.score) && item.score >= 0 && item.score <= 1), true);
assert.equal(Number.isFinite(elapsed), true);
console.log(`insights benchmark: nodes=${nodes.length} edges=${edges.length} elapsed_ms=${elapsed.toFixed(1)}`);
