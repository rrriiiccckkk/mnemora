import type { InsightsConfig } from "../index.js";
import type { GraphProjection, GraphProjectionEdge, GraphProjectionNode } from "./types.js";
import type { CommunityPartition, CommunityPartitionSummary } from "./community.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BRIDGE_SOURCES = 64;

export interface CommunityMetrics {
  id: string;
  entity_ids: string[];
  size: number;
  internal_edge_count: number;
  density: number;
  average_confidence: number;
  evidence_coverage: number;
  source_concentration: number;
  recent_growth: number;
  bridge_score: number;
  weighted_boundary_ratio: number;
  /** Alias retained for callers that use the shorter name. */
  boundary_ratio: number;
  recent_count: number;
  baseline_count: number;
  recent_entity_count: number;
  baseline_entity_count: number;
  recent_relationship_count: number;
  baseline_relationship_count: number;
  recent_activity_count: number;
  baseline_activity_count: number;
  recent_novel_entity_count: number;
  recent_novel_relationship_count: number;
  recent_novel_activity_count: number;
  baseline_only_activity_count: number;
  normalized_baseline_count: number;
  absolute_growth: number;
}

interface WindowCounts {
  recentEntities: Set<string>;
  recentRelationships: Set<string>;
  baselineEntities: Set<string>;
  baselineRelationships: Set<string>;
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp01(value: unknown): number {
  const number = finite(value, 0);
  return Math.max(0, Math.min(1, number));
}

function positive(value: unknown, fallback = 0): number {
  const number = finite(value, fallback);
  return number > 0 ? number : 0;
}

function compareIds(a: string, b: string): number {
  return a.localeCompare(b);
}

function maxNodes(config: InsightsConfig): number {
  const value = Math.trunc(finite(config.maxNodes, 10000));
  return Math.max(1, Math.min(10000, value));
}

function maxEdges(config: InsightsConfig): number {
  const value = Math.trunc(finite(config.maxEdges, 50000));
  return Math.max(1, Math.min(50000, value));
}

function boundedNodes(projection: GraphProjection, config: InsightsConfig): GraphProjectionNode[] {
  return [...(projection.nodes ?? [])]
    .filter((node): node is GraphProjectionNode => typeof node?.id === "string" && node.id.length > 0)
    .sort((a, b) => compareIds(a.id, b.id))
    .filter((node, index, nodes) => index === 0 || node.id !== nodes[index - 1].id)
    .slice(0, maxNodes(config));
}

function boundedEdges(projection: GraphProjection, config: InsightsConfig, nodeIds: Set<string>): GraphProjectionEdge[] {
  return [...(projection.edges ?? [])]
    .filter((edge): edge is GraphProjectionEdge => typeof edge?.id === "string"
      && typeof edge.source === "string" && typeof edge.target === "string"
      && edge.source !== edge.target && nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .sort((a, b) => compareIds(a.id, b.id))
    .filter((edge, index, edges) => index === 0 || edge.id !== edges[index - 1].id)
    .slice(0, maxEdges(config));
}

function communityGroups(partition: CommunityPartition, nodeIds: Set<string>): Array<{ id: string; node_ids: string[] }> {
  const groups = new Map<string, Set<string>>();
  for (const summary of partition.communities ?? []) {
    if (!summary || typeof summary.id !== "string") continue;
    const members = groups.get(summary.id) ?? new Set<string>();
    for (const nodeId of summary.node_ids ?? []) if (nodeIds.has(nodeId)) members.add(nodeId);
    groups.set(summary.id, members);
  }
  for (const [nodeId, communityId] of Object.entries(partition.membership ?? {})) {
    if (!nodeIds.has(nodeId) || typeof communityId !== "string" || !communityId) continue;
    const members = groups.get(communityId) ?? new Set<string>();
    members.add(nodeId);
    groups.set(communityId, members);
  }
  return [...groups.entries()]
    .map(([id, members]) => ({ id, node_ids: [...members].sort(compareIds) }))
    .filter(group => group.node_ids.length > 0)
    .sort((a, b) => compareIds(a.id, b.id));
}

function edgeWeight(edge: GraphProjectionEdge): number {
  const supplied = positive(edge.weight);
  return supplied || clamp01(edge.confidence);
}

function edgeConfidence(edge: GraphProjectionEdge): number {
  return clamp01(edge.confidence);
}

function sourceConcentration(edges: GraphProjectionEdge[]): number {
  if (!edges.length) return 0;
  const totalEvidence = edges.reduce((sum, edge) => sum + positive(edge.evidenceCount), 0);
  if (!totalEvidence) return 0;
  // The projection carries only a distinct-source count per relationship, so
  // this is deliberately conservative: one source means full concentration,
  // while additional independent sources reduce it monotonically.
  const weightedSources = edges.reduce((sum, edge) => {
    const evidence = positive(edge.evidenceCount);
    return sum + evidence * Math.max(1, positive(edge.sourceCount, 1));
  }, 0);
  return clamp01(totalEvidence / Math.max(totalEvidence, weightedSources));
}

function timestamp(edge: GraphProjectionEdge, field: "firstSeenAt" | "lastSeenAt"): number {
  return finite(edge[field], Number.NaN);
}

function intervalIntersects(edge: GraphProjectionEdge, start: number, end: number): boolean {
  const first = timestamp(edge, "firstSeenAt");
  const last = timestamp(edge, "lastSeenAt");
  if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) return false;
  return last >= start && first <= end;
}

function differenceSize<T>(left: Set<T>, right: Set<T>): number {
  let count = 0;
  for (const value of left) if (!right.has(value)) count += 1;
  return count;
}

export function countCommunityWindows(
  projection: GraphProjection,
  partition: CommunityPartition,
  config: InsightsConfig
): Map<string, WindowCounts> {
  const nodes = boundedNodes(projection, config);
  const nodeIds = new Set(nodes.map(node => node.id));
  const edges = boundedEdges(projection, config, nodeIds);
  const groups = communityGroups(partition, nodeIds);
  const membership = new Map<string, string>();
  for (const group of groups) for (const nodeId of group.node_ids) membership.set(nodeId, group.id);
  const asOf = finite(projection.asOf, Date.now());
  const recentDays = Math.max(1, finite(config.recentWindowDays, 7));
  const baselineDays = Math.max(1, finite(config.baselineWindowDays, 28));
  const recentStart = asOf - recentDays * DAY_MS;
  const baselineStart = recentStart - baselineDays * DAY_MS;
  const counts = new Map<string, WindowCounts>();
  for (const group of groups) counts.set(group.id, {
    recentEntities: new Set(), recentRelationships: new Set(),
    baselineEntities: new Set(), baselineRelationships: new Set()
  });
  for (const edge of edges) {
    const recent = intervalIntersects(edge, recentStart, asOf);
    const baseline = intervalIntersects(edge, baselineStart, recentStart - 1);
    if (!recent && !baseline) continue;
    const sourceCommunity = membership.get(edge.source);
    const targetCommunity = membership.get(edge.target);
    const communities = new Set([sourceCommunity, targetCommunity]);
    for (const communityId of communities) {
      if (!communityId) continue;
      const target = counts.get(communityId);
      if (!target) continue;
      if (recent) {
        target.recentRelationships.add(edge.id);
        target.recentEntities.add(edge.source);
        target.recentEntities.add(edge.target);
      }
      if (baseline) {
        target.baselineRelationships.add(edge.id);
        target.baselineEntities.add(edge.source);
        target.baselineEntities.add(edge.target);
      }
    }
  }
  return counts;
}

function boundedBridgeScores(
  nodes: GraphProjectionNode[],
  edges: GraphProjectionEdge[],
  membership: Map<string, string>,
  config: InsightsConfig
): Map<string, number> {
  const adjacency = new Map<string, Array<{ node: string; edge: GraphProjectionEdge }>>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    if (!Number.isFinite(timestamp(edge, "firstSeenAt")) || !Number.isFinite(timestamp(edge, "lastSeenAt"))
      || timestamp(edge, "firstSeenAt") > timestamp(edge, "lastSeenAt")) continue;
    adjacency.get(edge.source)?.push({ node: edge.target, edge });
    adjacency.get(edge.target)?.push({ node: edge.source, edge });
  }
  for (const neighbors of adjacency.values()) neighbors.sort((a, b) => compareIds(a.edge.id, b.edge.id) || compareIds(a.node, b.node));
  const maxDepth = Math.max(2, Math.min(4, Math.trunc(finite(config.maxPathLength, 4))));
  const sources = nodes.map(node => node.id).sort(compareIds).slice(0, MAX_BRIDGE_SOURCES);
  const hits = new Map<string, number>();
  let successfulPaths = 0;
  for (const source of sources) {
    const sourceCommunity = membership.get(source);
    if (!sourceCommunity) continue;
    const queue: Array<{ node: string; path: string[] }> = [{ node: source, path: [source] }];
    const visited = new Set([source]);
    while (queue.length) {
      const current = queue.shift()!;
      if (current.path.length - 1 >= maxDepth) continue;
      for (const neighbor of adjacency.get(current.node) ?? []) {
        if (visited.has(neighbor.node)) continue;
        visited.add(neighbor.node);
        const path = [...current.path, neighbor.node];
        const community = membership.get(neighbor.node);
        if (community && community !== sourceCommunity) {
          successfulPaths += 1;
          for (const bridgeNode of path.slice(1, -1)) {
            hits.set(bridgeNode, (hits.get(bridgeNode) ?? 0) + 1);
          }
        }
        queue.push({ node: neighbor.node, path });
      }
    }
  }
  const result = new Map<string, number>();
  for (const node of nodes) {
    result.set(node.id, successfulPaths ? clamp01((hits.get(node.id) ?? 0) / successfulPaths) : 0);
  }
  return result;
}

export function calculateCommunityMetrics(
  projection: GraphProjection,
  partition: CommunityPartition,
  config: InsightsConfig = {}
): CommunityMetrics[] {
  const nodes = boundedNodes(projection, config);
  const nodeIds = new Set(nodes.map(node => node.id));
  const edges = boundedEdges(projection, config, nodeIds);
  const groups = communityGroups(partition, nodeIds);
  const membership = new Map<string, string>();
  for (const group of groups) for (const nodeId of group.node_ids) membership.set(nodeId, group.id);
  const bridgeScores = boundedBridgeScores(nodes, edges, membership, config);
  const windows = countCommunityWindows(projection, partition, config);
  const recentDays = Math.max(1, finite(config.recentWindowDays, 7));
  const baselineDays = Math.max(1, finite(config.baselineWindowDays, 28));
  return groups.map(group => {
    const members = new Set(group.node_ids);
    const internal = edges.filter(edge => membership.get(edge.source) === group.id && membership.get(edge.target) === group.id);
    const incident = edges.filter(edge => members.has(edge.source) || members.has(edge.target));
    const internalWeight = internal.reduce((sum, edge) => sum + edgeWeight(edge), 0);
    const boundaryWeight = incident.filter(edge => membership.get(edge.source) !== membership.get(edge.target))
      .reduce((sum, edge) => sum + edgeWeight(edge), 0);
    const density = group.node_ids.length > 1
      ? internal.length / (group.node_ids.length * (group.node_ids.length - 1) / 2)
      : 0;
    const confidence = internal.length
      ? internal.reduce((sum, edge) => sum + edgeConfidence(edge), 0) / internal.length
      : 0;
    const coveredNodes = new Set<string>();
    for (const edge of incident) if (positive(edge.evidenceCount) > 0) {
      if (members.has(edge.source)) coveredNodes.add(edge.source);
      if (members.has(edge.target)) coveredNodes.add(edge.target);
    }
    const counts = windows.get(group.id)!;
    const recentEntityCount = counts.recentEntities.size;
    const baselineEntityCount = counts.baselineEntities.size;
    const recentRelationshipCount = counts.recentRelationships.size;
    const baselineRelationshipCount = counts.baselineRelationships.size;
    const recentActivityCount = recentEntityCount + recentRelationshipCount;
    const baselineActivityCount = baselineEntityCount + baselineRelationshipCount;
    const recentNovelEntityCount = differenceSize(counts.recentEntities, counts.baselineEntities);
    const recentNovelRelationshipCount = differenceSize(counts.recentRelationships, counts.baselineRelationships);
    const baselineOnlyEntityCount = differenceSize(counts.baselineEntities, counts.recentEntities);
    const baselineOnlyRelationshipCount = differenceSize(counts.baselineRelationships, counts.recentRelationships);
    const recentNovelActivityCount = recentNovelEntityCount + recentNovelRelationshipCount;
    const baselineOnlyActivityCount = baselineOnlyEntityCount + baselineOnlyRelationshipCount;
    const normalizedBaseline = baselineOnlyActivityCount * recentDays / baselineDays;
    const absoluteGrowth = recentNovelActivityCount - normalizedBaseline;
    const recentGrowth = clamp01(absoluteGrowth / Math.max(1, recentNovelActivityCount));
    const ratio = clamp01(boundaryWeight / Math.max(Number.EPSILON, internalWeight + boundaryWeight));
    const bridgeTotal = group.node_ids.reduce((sum, nodeId) => sum + (bridgeScores.get(nodeId) ?? 0), 0);
    return {
      id: group.id,
      entity_ids: [...group.node_ids],
      size: group.node_ids.length,
      internal_edge_count: internal.length,
      density: clamp01(density),
      average_confidence: clamp01(confidence),
      evidence_coverage: clamp01(coveredNodes.size / Math.max(1, group.node_ids.length)),
      source_concentration: sourceConcentration(internal),
      recent_growth: recentGrowth,
      bridge_score: clamp01(bridgeTotal / Math.max(1, group.node_ids.length)),
      weighted_boundary_ratio: ratio,
      boundary_ratio: ratio,
      recent_count: recentActivityCount,
      baseline_count: baselineActivityCount,
      recent_entity_count: recentEntityCount,
      baseline_entity_count: baselineEntityCount,
      recent_relationship_count: recentRelationshipCount,
      baseline_relationship_count: baselineRelationshipCount,
      recent_activity_count: recentActivityCount,
      baseline_activity_count: baselineActivityCount,
      recent_novel_entity_count: recentNovelEntityCount,
      recent_novel_relationship_count: recentNovelRelationshipCount,
      recent_novel_activity_count: recentNovelActivityCount,
      baseline_only_activity_count: baselineOnlyActivityCount,
      normalized_baseline_count: normalizedBaseline,
      absolute_growth: Number.isFinite(absoluteGrowth) ? absoluteGrowth : 0
    } satisfies CommunityMetrics;
  });
}

export { DAY_MS, MAX_BRIDGE_SOURCES };
