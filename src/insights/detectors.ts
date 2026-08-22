import { createHash } from "node:crypto";
import type { InsightsConfig } from "../index.js";
import type { KgInsight } from "../types.js";
import type { CommunityPartition } from "./community.js";
import { calculateCommunityMetrics } from "./metrics.js";
import type { GraphProjection, GraphProjectionEdge } from "./types.js";

export interface InsightPath {
  entity_ids: string[];
  edge_ids: string[];
}

export interface InsightCandidate extends KgInsight {
  path?: InsightPath;
}

const finite = (value: unknown, fallback = 0): number => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp01 = (value: unknown): number => Math.max(0, Math.min(1, finite(value)));
const compareIds = (a: string, b: string): number => a.localeCompare(b);
const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, Math.trunc(finite(value, fallback))));

function stableId(kind: string, parts: string[]): string {
  return `${kind}:${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16)}`;
}

function candidate(base: Omit<InsightCandidate, "id">): InsightCandidate {
  const pathParts = base.path ? [...base.path.entity_ids, ...base.path.edge_ids] : [];
  return { ...base, id: stableId(base.kind, [...base.community_ids, ...base.entity_ids, ...base.relationship_ids, base.reason, ...pathParts]) };
}

export function detectKnowledgeGaps(
  projection: GraphProjection,
  partition: CommunityPartition,
  config: InsightsConfig = {},
  collectionLimit = boundedInteger(config.maxResults, 20, 0, 1000)
): InsightCandidate[] {
  const floor = clamp01(config.confidenceFloor ?? .6);
  const results: InsightCandidate[] = [];
  for (const metric of calculateCommunityMetrics(projection, partition, config)) {
    let reason: InsightCandidate["reason"] | undefined;
    let score = 0;
    if (metric.internal_edge_count === 0) {
      reason = "isolated";
      score = clamp01(.7 + .3 * (1 - metric.weighted_boundary_ratio));
    } else if (metric.average_confidence < floor || metric.evidence_coverage < .5) {
      reason = "weak_evidence";
      score = clamp01(.6 * (1 - metric.average_confidence) + .4 * (1 - metric.evidence_coverage));
    } else if (metric.source_concentration >= .8) {
      reason = "source_concentration";
      score = clamp01(.7 * metric.source_concentration + .3 * (1 - metric.evidence_coverage));
    }
    if (!reason) continue;
    results.push(candidate({
      kind: "knowledge_gap", score, community_ids: [metric.id], entity_ids: metric.entity_ids,
      relationship_ids: [], reason,
      signals: {
        density: metric.density, average_confidence: metric.average_confidence,
        evidence_coverage: metric.evidence_coverage, source_concentration: metric.source_concentration,
        boundary_ratio: metric.weighted_boundary_ratio
      }
    }));
  }
  return rankInsights(results, collectionLimit);
}

export function detectEmergingTopics(
  projection: GraphProjection,
  partition: CommunityPartition,
  config: InsightsConfig = {},
  collectionLimit = boundedInteger(config.maxResults, 20, 0, 1000)
): InsightCandidate[] {
  const minimumEntities = boundedInteger(config.minEmergingEntities, 3, 1, 10000);
  const minimumGrowth = Math.max(0, finite(config.minEmergingGrowth, 2));
  const results = calculateCommunityMetrics(projection, partition, config)
    .filter(metric => metric.size >= minimumEntities
      && metric.recent_novel_activity_count > metric.normalized_baseline_count
      && metric.absolute_growth >= minimumGrowth)
    .map(metric => candidate({
      kind: "emerging_topic" as const,
      score: clamp01(.45 * Math.min(1, metric.recent_count / Math.max(minimumEntities, 1))
        + .45 * Math.min(1, metric.absolute_growth / Math.max(minimumGrowth, 1)) + .1 * metric.density),
      community_ids: [metric.id], entity_ids: metric.entity_ids, relationship_ids: [], reason: "rapid_growth" as const,
      signals: {
        recent_count: metric.recent_count, baseline_count: metric.baseline_count,
        recent_entity_count: metric.recent_entity_count,
        baseline_entity_count: metric.baseline_entity_count,
        recent_relationship_count: metric.recent_relationship_count,
        baseline_relationship_count: metric.baseline_relationship_count,
        recent_activity_count: metric.recent_activity_count,
        baseline_activity_count: metric.baseline_activity_count,
        recent_novel_entity_count: metric.recent_novel_entity_count,
        recent_novel_relationship_count: metric.recent_novel_relationship_count,
        recent_novel_activity_count: metric.recent_novel_activity_count,
        baseline_only_activity_count: metric.baseline_only_activity_count,
        normalized_baseline_count: metric.normalized_baseline_count,
        absolute_growth: metric.absolute_growth, recent_growth: metric.recent_growth, density: metric.density
      }
    }));
  return rankInsights(results, collectionLimit);
}

function usableEdges(projection: GraphProjection, config: InsightsConfig, nodeIds: Set<string>): GraphProjectionEdge[] {
  const floor = clamp01(config.confidenceFloor ?? .6);
  const asOf = finite(projection.asOf, Date.now());
  return [...(projection.edges ?? [])]
    .filter(edge => typeof edge.id === "string" && nodeIds.has(edge.source) && nodeIds.has(edge.target)
      && edge.source !== edge.target && clamp01(edge.confidence) >= floor
      && Number.isFinite(Number(edge.firstSeenAt)) && Number.isFinite(Number(edge.lastSeenAt))
      && Number(edge.firstSeenAt) <= Number(edge.lastSeenAt) && Number(edge.firstSeenAt) <= asOf)
    .sort((a, b) => compareIds(a.id, b.id))
    .filter((edge, index, edges) => index === 0 || edge.id !== edges[index - 1].id)
    .slice(0, boundedInteger(config.maxEdges, 50000, 1, 50000));
}

export function detectCrossCommunityPaths(
  projection: GraphProjection,
  partition: CommunityPartition,
  config: InsightsConfig = {},
  collectionLimit = boundedInteger(config.maxResults, 20, 0, 1000)
): InsightCandidate[] {
  const nodes = [...(projection.nodes ?? [])].filter(node => typeof node.id === "string" && node.id)
    .sort((a, b) => compareIds(a.id, b.id))
    .filter((node, index, all) => index === 0 || node.id !== all[index - 1].id)
    .slice(0, boundedInteger(config.maxNodes, 10000, 1, 10000));
  const nodeIds = new Set(nodes.map(node => node.id));
  const edges = usableEdges(projection, config, nodeIds);
  const adjacency = new Map<string, Array<{ node: string; edge: GraphProjectionEdge }>>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    adjacency.get(edge.source)?.push({ node: edge.target, edge });
    adjacency.get(edge.target)?.push({ node: edge.source, edge });
  }
  for (const values of adjacency.values()) values.sort((a, b) => compareIds(a.edge.id, b.edge.id) || compareIds(a.node, b.node));
  const maxLength = boundedInteger(config.maxPathLength, 4, 2, 4);
  const limit = boundedInteger(collectionLimit, 20, 0, 660000);
  const results: InsightCandidate[] = [];
  const seenPairs = new Set<string>();
  for (const source of nodes.slice(0, 64)) {
    if (results.length >= limit) break;
    const sourceCommunity = partition.membership[source.id];
    if (!sourceCommunity) continue;
    const queue: Array<{ node: string; entities: string[]; edgeIds: string[]; confidence: number }> = [
      { node: source.id, entities: [source.id], edgeIds: [], confidence: 1 }
    ];
    const visited = new Set([source.id]);
    while (queue.length && results.length < limit) {
      const current = queue.shift()!;
      if (current.edgeIds.length >= maxLength) continue;
      for (const next of adjacency.get(current.node) ?? []) {
        if (visited.has(next.node)) continue;
        visited.add(next.node);
        const entities = [...current.entities, next.node];
        const edgeIds = [...current.edgeIds, next.edge.id];
        const confidence = Math.min(current.confidence, clamp01(next.edge.confidence));
        const targetCommunity = partition.membership[next.node];
        if (edgeIds.length >= 2 && targetCommunity && targetCommunity !== sourceCommunity) {
          const pair = [sourceCommunity, targetCommunity].sort(compareIds).join("\u0000");
          if (!seenPairs.has(pair)) {
            seenPairs.add(pair);
            results.push(candidate({
              kind: "cross_community_path", score: clamp01(.65 * confidence + .35 * (1 - (edgeIds.length - 2) / 3)),
              community_ids: [sourceCommunity, targetCommunity].sort(compareIds), entity_ids: entities,
              relationship_ids: edgeIds, reason: "bridge_path",
              signals: { path_length: edgeIds.length, minimum_confidence: confidence },
              path: { entity_ids: entities, edge_ids: edgeIds }
            }));
          }
        }
        queue.push({ node: next.node, entities, edgeIds, confidence });
      }
    }
  }
  return rankInsights(results, limit);
}

export function rankInsights(items: InsightCandidate[], limit: number): InsightCandidate[] {
  const boundedLimit = boundedInteger(limit, 0, 0, 660000);
  return items.map(item => ({
    ...item,
    score: clamp01(item.score),
    signals: Object.fromEntries(Object.entries(item.signals).map(([key, value]) => [key, finite(value)]))
  })).sort((a, b) => b.score - a.score || compareIds(a.id, b.id)).slice(0, boundedLimit);
}
