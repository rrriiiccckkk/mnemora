import assert from "node:assert/strict";
import test from "node:test";
import { calculateCommunityMetrics } from "../dist/insights/metrics.js";
import {
  detectKnowledgeGaps,
  detectEmergingTopics,
  detectCrossCommunityPaths,
  rankInsights
} from "../dist/insights/detectors.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const config = {
  maxNodes: 100,
  maxEdges: 100,
  confidenceFloor: .6,
  recentWindowDays: 7,
  baselineWindowDays: 28,
  minEmergingEntities: 3,
  minEmergingGrowth: 2,
  maxPathLength: 4,
  maxResults: 20
};

function projection(nodeIds, edges, asOf = NOW) {
  return {
    nodes: nodeIds.map(id => ({ id, name: id, type: "company" })),
    edges: edges.map((edge, index) => ({
      id: edge.id ?? `edge:${index}`,
      source: edge.source,
      target: edge.target,
      type: "supplies",
      weight: edge.weight ?? 1,
      confidence: edge.confidence ?? .9,
      evidenceCount: edge.evidenceCount ?? 1,
      sourceCount: edge.sourceCount ?? 1,
      firstSeenAt: edge.firstSeenAt ?? asOf,
      lastSeenAt: edge.lastSeenAt ?? asOf
    })),
    truncated: false,
    graphRevision: 1,
    asOf
  };
}

function partition(groups) {
  const membership = {};
  const communities = groups.map((node_ids, index) => {
    const id = `community:${index}`;
    for (const nodeId of node_ids) membership[nodeId] = id;
    return { id, node_ids, size: node_ids.length, internal_weight: 0, total_weight: 0 };
  });
  return { membership, communities, modularity: 0, passes: 1 };
}

test("knowledge gaps report measured weakness without inventing missing facts", () => {
  const graph = projection(["isolated", "weak", "w1", "concentrated", "c1"], [
    { source: "weak", target: "w1", confidence: .2, evidenceCount: 0, sourceCount: 0 },
    { source: "concentrated", target: "c1", confidence: .9, evidenceCount: 6, sourceCount: 1 }
  ]);
  const candidates = detectKnowledgeGaps(graph, partition([["isolated"], ["weak", "w1"], ["concentrated", "c1"]]), config);
  assert.deepEqual(candidates.map(item => item.reason).sort(), ["isolated", "source_concentration", "weak_evidence"]);
  assert.equal(JSON.stringify(candidates).includes("should add"), false);
  assert.ok(candidates.every(item => Object.values(item.signals).every(Number.isFinite)));
});

test("community metrics expose bounded density, confidence, evidence, sources, boundaries, and bridge", () => {
  const graph = projection(["a", "b", "x"], [
    { source: "a", target: "b", weight: 2, confidence: .8, evidenceCount: 2, sourceCount: 2 },
    { source: "b", target: "x", weight: 1, confidence: .9, evidenceCount: 1, sourceCount: 1 }
  ]);
  const [metric] = calculateCommunityMetrics(graph, partition([["a", "b"], ["x"]]), config);
  assert.equal(metric.density, 1);
  assert.equal(metric.average_confidence, .8);
  assert.equal(metric.evidence_coverage, 1);
  assert.ok(metric.source_concentration >= 0 && metric.source_concentration <= 1);
  assert.ok(metric.weighted_boundary_ratio > 0 && metric.weighted_boundary_ratio <= 1);
  assert.ok(metric.bridge_score >= 0 && metric.bridge_score <= 1);
});

test("bounded bridge approximation distinguishes internal bridge nodes", () => {
  const graph = projection(["a", "b", "c", "x"], [
    { source: "a", target: "b" }, { source: "b", target: "c" }, { source: "c", target: "x" }
  ]);
  const metrics = calculateCommunityMetrics(graph, partition([["a"], ["b", "c"], ["x"]]), config);
  const byId = Object.fromEntries(metrics.map(metric => [metric.id, metric.bridge_score]));
  assert.ok(byId["community:1"] > byId["community:0"]);
  assert.ok(byId["community:1"] > byId["community:2"]);
  assert.ok(metrics.every(metric => metric.bridge_score >= 0 && metric.bridge_score <= 1));
});

test("emerging topics require coherent size and absolute growth", () => {
  const tiny = projection(["a", "b"], [{ source: "a", target: "b", firstSeenAt: NOW - DAY, lastSeenAt: NOW - DAY }]);
  assert.equal(detectEmergingTopics(tiny, partition([["a", "b"]]), config).length, 0);
  const ids = ["a", "b", "c", "d", "e"];
  const growth = projection(ids, ids.slice(1).map((target, index) => ({
    id: `new:${index}`,
    source: ids[0], target,
    firstSeenAt: NOW - DAY,
    lastSeenAt: NOW - DAY
  })));
  const [topic] = detectEmergingTopics(growth, partition([ids]), config);
  assert.equal(topic.kind, "emerging_topic");
  assert.equal(topic.signals.recent_entity_count, 5);
  assert.equal(topic.signals.absolute_growth >= config.minEmergingGrowth, true);
});

test("emerging topic windows deduplicate stable entity and relationship identifiers", () => {
  const ids = ["a", "b", "c"];
  const graph = projection(ids, [
    { id: "same", source: "a", target: "b", firstSeenAt: NOW - DAY, lastSeenAt: NOW - DAY },
    { id: "same", source: "a", target: "b", firstSeenAt: NOW - DAY, lastSeenAt: NOW - DAY },
    { id: "other", source: "a", target: "c", firstSeenAt: NOW - DAY, lastSeenAt: NOW - DAY }
  ]);
  const [topic] = detectEmergingTopics(graph, partition([ids]), { ...config, minEmergingGrowth: 1 });
  assert.equal(topic.signals.recent_entity_count, 3);
  assert.equal(topic.signals.recent_relationship_count, 2);
  assert.equal(topic.signals.recent_activity_count, 5);
  assert.equal(topic.signals.baseline_activity_count, 0);
});

test("normalized activity growth can qualify below the raw 28-day baseline", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const graph = projection(ids, [
    { id: "recent:1", source: "a", target: "b", firstSeenAt: NOW - DAY, lastSeenAt: NOW - DAY },
    { id: "recent:2", source: "a", target: "b", firstSeenAt: NOW - DAY, lastSeenAt: NOW - DAY },
    { id: "base:1", source: "a", target: "b", firstSeenAt: NOW - 10 * DAY, lastSeenAt: NOW - 10 * DAY },
    { id: "base:2", source: "a", target: "c", firstSeenAt: NOW - 12 * DAY, lastSeenAt: NOW - 12 * DAY },
    { id: "base:3", source: "a", target: "d", firstSeenAt: NOW - 14 * DAY, lastSeenAt: NOW - 14 * DAY }
  ]);
  const [topic] = detectEmergingTopics(graph, partition([ids]), { ...config, minEmergingGrowth: .5 });
  assert.ok(topic.signals.recent_activity_count < topic.signals.baseline_activity_count);
  assert.ok(topic.signals.recent_novel_activity_count > topic.signals.normalized_baseline_count);
  assert.ok(topic.signals.absolute_growth >= .5);
});

test("identical long-lived aggregate identities do not create emerging growth", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const graph = projection(ids, ids.slice(1).map((target, index) => ({
    id: `spanning:${index}`, source: "a", target,
    firstSeenAt: NOW - 30 * DAY, lastSeenAt: NOW - DAY
  })));
  assert.equal(detectEmergingTopics(graph, partition([ids]), config).length, 0);
});

test("new relationships among existing entities contribute to emerging activity", () => {
  const ids = ["a", "b", "c"];
  const graph = projection(ids, [
    { id: "old:1", source: "a", target: "b", firstSeenAt: NOW - 10 * DAY, lastSeenAt: NOW - DAY },
    { id: "old:2", source: "a", target: "c", firstSeenAt: NOW - 10 * DAY, lastSeenAt: NOW - DAY },
    { id: "new:1", source: "b", target: "c", firstSeenAt: NOW - DAY, lastSeenAt: NOW - DAY },
    { id: "new:2", source: "a", target: "c", firstSeenAt: NOW - DAY, lastSeenAt: NOW - DAY }
  ]);
  const [topic] = detectEmergingTopics(graph, partition([ids]), { ...config, minEmergingGrowth: 2 });
  assert.equal(topic.signals.recent_entity_count, topic.signals.baseline_entity_count);
  assert.ok(topic.signals.recent_relationship_count > topic.signals.baseline_relationship_count);
  assert.equal(topic.signals.recent_novel_entity_count, 0);
  assert.equal(topic.signals.recent_novel_relationship_count, 2);
  assert.ok(topic.signals.absolute_growth >= 2);
});

test("cross-community paths are valid, reconstructable, and at most four hops", () => {
  const graph = projection(["a", "b", "c", "x"], [
    { id: "e1", source: "a", target: "b" },
    { id: "e2", source: "b", target: "c" },
    { id: "e3", source: "c", target: "x" }
  ]);
  const candidates = detectCrossCommunityPaths(graph, partition([["a", "b"], ["c", "x"]]), config);
  const [candidate] = candidates;
  assert.ok(candidate.path.edge_ids.length >= 2);
  assert.ok(candidate.path.edge_ids.length <= 4);
  const reconstructed = [candidate.path.entity_ids[0]];
  for (const edgeId of candidate.path.edge_ids) {
    const edge = graph.edges.find(item => item.id === edgeId);
    const last = reconstructed.at(-1);
    reconstructed.push(edge.source === last ? edge.target : edge.source);
  }
  assert.deepEqual(reconstructed, candidate.path.entity_ids);
});

test("cross-community paths exclude low-confidence and future edges", () => {
  const graph = projection(["a", "b", "x"], [
    { id: "low", source: "a", target: "b", confidence: .1 },
    { id: "future", source: "b", target: "x", firstSeenAt: NOW + DAY, lastSeenAt: NOW + DAY },
    { id: "good", source: "a", target: "x", confidence: .9 }
  ]);
  const candidates = detectCrossCommunityPaths(graph, partition([["a"], ["b", "x"]]), config);
  assert.ok(candidates.every(item => !item.relationship_ids.includes("low") && !item.relationship_ids.includes("future")));
});

test("cross-community traversal obeys projection and path bounds", () => {
  const graph = projection(["a", "b", "c", "d", "x"], [
    { id: "e1", source: "a", target: "b" },
    { id: "e2", source: "b", target: "c" },
    { id: "e3", source: "c", target: "d" },
    { id: "e4", source: "d", target: "x" },
    { id: "invalid-time", source: "b", target: "x", firstSeenAt: NOW, lastSeenAt: NOW - DAY }
  ]);
  const groups = partition([["a", "b"], ["c", "d", "x"]]);
  assert.equal(detectCrossCommunityPaths(graph, groups, { ...config, maxNodes: 2 }).length, 0);
  const paths = detectCrossCommunityPaths(graph, groups, { ...config, maxPathLength: 2, maxResults: 1 });
  assert.equal(paths.length, 1);
  assert.equal(paths[0].path.edge_ids.length, 2);
  assert.equal(paths[0].relationship_ids.includes("invalid-time"), false);
});

test("rankInsights clamps and deterministically limits candidates", () => {
  const ranked = rankInsights([
    { id: "z", kind: "knowledge_gap", score: 2, community_ids: [], entity_ids: [], relationship_ids: [], reason: "isolated", signals: {} },
    { id: "a", kind: "knowledge_gap", score: 2, community_ids: [], entity_ids: [], relationship_ids: [], reason: "isolated", signals: {} },
    { id: "n", kind: "knowledge_gap", score: -1, community_ids: [], entity_ids: [], relationship_ids: [], reason: "isolated", signals: {} }
  ], 2);
  assert.deepEqual(ranked.map(item => item.id), ["a", "z"]);
  assert.ok(ranked.every(item => item.score >= 0 && item.score <= 1));
});
