import { createHash } from "node:crypto";
import type { GraphProjection } from "./types.js";

/** Version included in community identifiers and cache keys. */
export const ALGORITHM_VERSION = "louvain-v1";

const EPSILON = 1e-12;

export interface CommunityPartitionSummary {
  id: string;
  node_ids: string[];
  size: number;
  internal_weight: number;
  total_weight: number;
}

export interface CommunityPartition {
  membership: Record<string, string>;
  communities: CommunityPartitionSummary[];
  modularity: number;
  passes: number;
}

interface WeightedEdge {
  source: string;
  target: string;
  weight: number;
}

interface LevelGraph {
  nodes: Map<string, string[]>;
  edges: WeightedEdge[];
  adjacency: Map<string, Map<string, number>>;
  degree: Map<string, number>;
  totalWeight: number;
}

interface LocalMoveResult {
  labels: Map<string, string>;
  groups: Map<string, Set<string>>;
  moved: boolean;
}

function compareIds(a: string, b: string): number {
  return a.localeCompare(b);
}

function normalizedWeight(value: unknown): number {
  const weight = Number(value);
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

function edgeKey(source: string, target: string): string {
  return source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function communityId(memberIds: string[]): string {
  return `community:${digest(ALGORITHM_VERSION + memberIds.join("\u0000"))}`;
}

function candidateStableId(graph: LevelGraph, groups: Map<string, Set<string>>, candidate: string, nodeId: string): string {
  const candidateMembers = [...(groups.get(candidate) ?? [])]
    .flatMap((levelNodeId) => graph.nodes.get(levelNodeId) ?? []);
  const movingMembers = graph.nodes.get(nodeId) ?? [];
  return communityId([...new Set([...candidateMembers, ...movingMembers])].sort(compareIds));
}

function levelCommunityId(memberIds: string[]): string {
  // Including the lowest member in the intermediate ID makes tie-breaking
  // easy to inspect while the digest keeps IDs stable and compact.
  return `level:${memberIds[0]}:${digest(memberIds.join("\u0000"))}`;
}

function buildLevelGraph(nodeMembers: Map<string, string[]>, inputEdges: WeightedEdge[]): LevelGraph {
  const nodes = new Map<string, string[]>();
  for (const [id, members] of [...nodeMembers.entries()].sort(([a], [b]) => compareIds(a, b))) {
    nodes.set(id, [...new Set(members)].sort(compareIds));
  }

  const edgeWeights = new Map<string, WeightedEdge>();
  for (const input of inputEdges) {
    const source = String(input.source);
    const target = String(input.target);
    if (!nodes.has(source) || !nodes.has(target)) continue;
    const weight = normalizedWeight(input.weight);
    if (!weight || source === target && !nodes.has(source)) continue;
    const [left, right] = source < target ? [source, target] : [target, source];
    const key = edgeKey(left, right);
    const existing = edgeWeights.get(key);
    if (existing) existing.weight += weight;
    else edgeWeights.set(key, { source: left, target: right, weight });
  }

  const edges = [...edgeWeights.values()]
    .filter((edge) => Number.isFinite(edge.weight) && edge.weight > 0)
    .sort((a, b) => compareIds(a.source, b.source) || compareIds(a.target, b.target));
  const adjacency = new Map<string, Map<string, number>>();
  for (const nodeId of nodes.keys()) adjacency.set(nodeId, new Map());
  for (const edge of edges) {
    const sourceNeighbors = adjacency.get(edge.source)!;
    sourceNeighbors.set(edge.target, (sourceNeighbors.get(edge.target) ?? 0) + edge.weight);
    if (edge.source !== edge.target) {
      const targetNeighbors = adjacency.get(edge.target)!;
      targetNeighbors.set(edge.source, (targetNeighbors.get(edge.source) ?? 0) + edge.weight);
    }
  }

  const degree = new Map<string, number>();
  for (const [nodeId, neighbors] of adjacency) {
    let value = 0;
    for (const [neighbor, weight] of neighbors) value += neighbor === nodeId ? 2 * weight : weight;
    degree.set(nodeId, Number.isFinite(value) ? value : 0);
  }
  const totalWeight = edges.reduce((sum, edge) => sum + edge.weight, 0);
  return { nodes, edges, adjacency, degree, totalWeight: Number.isFinite(totalWeight) ? totalWeight : 0 };
}

function localMove(graph: LevelGraph, check?: () => void): LocalMoveResult {
  const labels = new Map<string, string>();
  const groups = new Map<string, Set<string>>();
  const communityWeights = new Map<string, number>();
  for (const nodeId of [...graph.nodes.keys()].sort(compareIds)) {
    check?.();
    labels.set(nodeId, nodeId);
    groups.set(nodeId, new Set([nodeId]));
    communityWeights.set(nodeId, graph.degree.get(nodeId) ?? 0);
  }

  if (graph.totalWeight <= EPSILON) return { labels, groups, moved: false };
  let moved = false;

  for (const nodeId of [...graph.nodes.keys()].sort(compareIds)) {
    check?.();
    const current = labels.get(nodeId)!;
    const nodeDegree = graph.degree.get(nodeId) ?? 0;
    const currentMembers = groups.get(current);
    currentMembers?.delete(nodeId);
    communityWeights.set(current, (communityWeights.get(current) ?? 0) - nodeDegree);

    const neighboringCommunities = new Set<string>();
    if (currentMembers?.size) neighboringCommunities.add(current);
    for (const neighbor of graph.adjacency.get(nodeId)?.keys() ?? []) {
      if (neighbor === nodeId) continue;
      const candidate = labels.get(neighbor);
      if (candidate) neighboringCommunities.add(candidate);
    }

    let bestId: string | undefined;
    let bestStableId: string | undefined;
    let bestGain = EPSILON;
    for (const candidate of [...neighboringCommunities].sort(compareIds)) {
      check?.();
      const candidateMembers = groups.get(candidate);
      if (!candidateMembers?.size) continue;
      let weightIntoCandidate = 0;
      for (const [neighbor, weight] of graph.adjacency.get(nodeId) ?? []) {
        if (neighbor !== nodeId && labels.get(neighbor) === candidate) weightIntoCandidate += weight;
      }
      const candidateTotal = communityWeights.get(candidate) ?? 0;
      const gain = weightIntoCandidate / graph.totalWeight
        - (candidateTotal * nodeDegree) / (2 * graph.totalWeight * graph.totalWeight);
      if (!Number.isFinite(gain) || gain <= EPSILON) continue;
      const stableId = candidateStableId(graph, groups, candidate, nodeId);
      if (bestId === undefined || gain > bestGain + EPSILON
        || Math.abs(gain - bestGain) <= EPSILON
          && (compareIds(stableId, bestStableId ?? "") < 0
            || stableId === bestStableId && compareIds(candidate, bestId) < 0)) {
        bestId = candidate;
        bestStableId = stableId;
        bestGain = gain;
      }
    }

    const destination = bestId ?? current;
    if (destination !== current) {
      labels.set(nodeId, destination);
      groups.get(destination)!.add(nodeId);
      communityWeights.set(destination, (communityWeights.get(destination) ?? 0) + nodeDegree);
      moved = true;
    } else {
      groups.get(current)!.add(nodeId);
      communityWeights.set(current, (communityWeights.get(current) ?? 0) + nodeDegree);
    }
  }

  for (const [id, members] of [...groups.entries()]) if (!members.size) groups.delete(id);
  return { labels, groups, moved };
}

function aggregateGraph(graph: LevelGraph, groups: Map<string, Set<string>>): LevelGraph {
  const groupedMembers = new Map<string, string[]>();
  const nodeToGroup = new Map<string, string>();
  for (const [groupId, levelNodes] of groups) {
    const members = [...levelNodes].flatMap((nodeId) => graph.nodes.get(nodeId) ?? []).sort(compareIds);
    if (!members.length) continue;
    const stableId = levelCommunityId(members);
    groupedMembers.set(stableId, members);
    for (const nodeId of levelNodes) nodeToGroup.set(nodeId, stableId);
  }
  const aggregatedEdges: WeightedEdge[] = [];
  for (const edge of graph.edges) {
    const source = nodeToGroup.get(edge.source);
    const target = nodeToGroup.get(edge.target);
    if (source && target) aggregatedEdges.push({ source, target, weight: edge.weight });
  }
  return buildLevelGraph(groupedMembers, aggregatedEdges);
}

function summaryForGroups(
  baseGraph: LevelGraph,
  groups: Map<string, string[]>
): { membership: Record<string, string>; communities: CommunityPartitionSummary[]; modularity: number } {
  const originalCommunityByNode = new Map<string, string>();
  const canonicalGroups = [...groups.values()]
    .map((members) => [...new Set(members)].sort(compareIds))
    .filter((members) => members.length)
    .sort((a, b) => compareIds(a[0], b[0]));
  const membership: Record<string, string> = {};
  for (const members of canonicalGroups) {
    const id = communityId(members);
    for (const nodeId of members) {
      originalCommunityByNode.set(nodeId, id);
    }
  }
  for (const nodeId of [...originalCommunityByNode.keys()].sort(compareIds)) {
    membership[nodeId] = originalCommunityByNode.get(nodeId)!;
  }

  const internalWeights = new Map<string, number>();
  const totalWeights = new Map<string, number>();
  for (const [nodeId, id] of originalCommunityByNode) {
    totalWeights.set(id, (totalWeights.get(id) ?? 0) + (baseGraph.degree.get(nodeId) ?? 0));
  }
  for (const edge of baseGraph.edges) {
    const sourceCommunity = originalCommunityByNode.get(edge.source);
    const targetCommunity = originalCommunityByNode.get(edge.target);
    if (sourceCommunity && sourceCommunity === targetCommunity) {
      internalWeights.set(sourceCommunity, (internalWeights.get(sourceCommunity) ?? 0) + edge.weight);
    }
  }

  const communities = [...canonicalGroups]
    .map((members) => {
      const id = originalCommunityByNode.get(members[0])!;
      return {
        id,
        node_ids: members,
        size: members.length,
        internal_weight: internalWeights.get(id) ?? 0,
        total_weight: totalWeights.get(id) ?? 0
      };
    })
    .sort((a, b) => compareIds(a.id, b.id));

  let modularity = 0;
  if (baseGraph.totalWeight > EPSILON) {
    for (const community of communities) {
      const internal = community.internal_weight / baseGraph.totalWeight;
      const expected = community.total_weight / (2 * baseGraph.totalWeight);
      modularity += internal - expected * expected;
    }
  }
  if (!Number.isFinite(modularity)) modularity = 0;
  modularity = Math.max(-1, Math.min(1, modularity));
  return { membership, communities, modularity };
}

function maxPassesFor(options?: { maxPasses?: number }): number {
  if (options?.maxPasses === undefined) return 20;
  const requested = Number(options.maxPasses);
  return Number.isFinite(requested) ? Math.min(20, Math.max(0, Math.trunc(requested))) : 20;
}

/** Detect weighted communities using deterministic local-moving Louvain. */
export function detectCommunities(
  projection: GraphProjection,
  options?: { maxPasses?: number; check?: () => void }
): CommunityPartition {
  options?.check?.();
  const nodeMembers = new Map<string, string[]>();
  for (const node of projection.nodes ?? []) {
    options?.check?.();
    const id = String(node.id);
    if (id && !nodeMembers.has(id)) nodeMembers.set(id, [id]);
  }
  const inputEdges: WeightedEdge[] = (projection.edges ?? []).map((edge) => ({
    source: String(edge.source), target: String(edge.target), weight: Number(edge.weight)
  }));
  const baseGraph = buildLevelGraph(nodeMembers, inputEdges);
  if (!nodeMembers.size) return { membership: {}, communities: [], modularity: 0, passes: 0 };

  let graph = baseGraph;
  let finalGroups = new Map<string, string[]>([...nodeMembers.entries()]);
  const limit = maxPassesFor(options);
  let passes = 0;
  while (passes < limit && graph.nodes.size) {
    options?.check?.();
    const local = localMove(graph, options?.check);
    passes += 1;
    finalGroups = new Map<string, string[]>();
    for (const [groupId, levelNodes] of local.groups) {
      options?.check?.();
      const members = [...levelNodes].flatMap((nodeId) => graph.nodes.get(nodeId) ?? []).sort(compareIds);
      if (members.length) finalGroups.set(groupId, members);
    }
    if (!local.moved || local.groups.size <= 1 || local.groups.size >= graph.nodes.size) break;
    options?.check?.();
    graph = aggregateGraph(graph, local.groups);
  }

  options?.check?.();
  const result = summaryForGroups(baseGraph, finalGroups);
  return { ...result, passes };
}
