import { normalizeScope } from "../scope.js";
import type { GraphologyStore } from "../store.js";
import type { DuplicateScanResult } from "../types.js";
import { personalizedPageRank, type PprArc } from "../ppr.js";
import { sourceDiversityScore } from "../ranking.js";

export interface GraphHygienePolicy {
  intervalHours: number;
  maxDuplicateScanNodes: number;
  relatedToWarningRatio: number;
  relatedToWarningMinimumEdges: number;
}

export interface GraphHygieneReport {
  version: "graph-hygiene-v1";
  scope: string;
  evaluated_at: number;
  scoped_edges: number;
  related_to: { edges: number; ratio: number; warning: boolean };
  /** Present for an explicit hygiene review, never on scheduled turn maintenance. */
  related_to_topology?: RelatedToTopologyAssessment;
  suspicious_self_links: number;
  pending_duplicate_candidates: number;
  recommendations: Array<"related_to_overrepresented" | "self_links_detected" | "duplicate_review_pending">;
}

type RelatedToPolicy = "baseline" | "downweighted" | "excluded";
type TopologyStatus = "ok" | "not_enough_topology" | "scale_limited";

export interface RelatedToTopologyAssessment {
  version: "related-to-topology-v1";
  scope: string;
  evaluated_at: number;
  status: TopologyStatus;
  node_count: number;
  structural_edge_count: number;
  related_to_edges: number;
  limits: { max_nodes: number; max_edges: number; representative_seeds: number; top_k: number };
  policies?: Record<RelatedToPolicy, {
    related_to_multiplier: number;
    weak_components: number;
    largest_component_nodes: number;
    isolated_nodes: number;
    largest_component_ratio: number;
    ppr_arcs: number;
  }>;
  top_k_comparison?: {
    excludes_seed: true;
    sampled_seed_count: number;
    baseline_to_downweighted: TopologyJaccard;
    baseline_to_excluded: TopologyJaccard;
  };
}

interface TopologyJaccard { mean: number; minimum: number; changed_seeds: number }
interface ScopedStructuralEdge { id: string; source_id: string; target_id: string; type: string; confidence: number; source_count: number }

const topologyLimits = { maxNodes: 2_000, maxEdges: 5_000, representativeSeeds: 20, topK: 20 } as const;

export interface GraphHygieneRun {
  status: "not_due" | "continued" | "completed";
  report: GraphHygieneReport;
  duplicate_scan?: DuplicateScanResult;
}

const scanState = "hygiene_duplicate_scan";
const completeState = `${scanState}_completed_at`;

/**
 * Bounded, review-only graph hygiene. It may create duplicate *candidates*,
 * but never merges entities, deletes edges, or changes graph evidence.
 */
export class GraphHygieneService {
  constructor(private readonly store: GraphologyStore, private readonly now: () => number = Date.now) {}

  report(scope: string, policy: Pick<GraphHygienePolicy, "relatedToWarningRatio" | "relatedToWarningMinimumEdges">, includeTopology = true): GraphHygieneReport {
    const normalizedScope = normalizeScope(scope), evaluatedAt = this.now();
    const counts = this.store.db.prepare(`SELECT
      COUNT(DISTINCT e.id) AS total,
      COUNT(DISTINCT CASE WHEN e.type='related_to' THEN e.id END) AS related_to,
      COUNT(DISTINCT CASE WHEN e.source_id=e.target_id THEN e.id END) AS self_links
      FROM kg_edges e
      WHERE e.deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM kg_observations o WHERE o.edge_id=e.id AND o.scope=?)`).get(normalizedScope) as { total?: number; related_to?: number; self_links?: number };
    const scopedEdges = Number(counts.total ?? 0), relatedTo = Number(counts.related_to ?? 0), selfLinks = Number(counts.self_links ?? 0);
    const ratio = scopedEdges ? relatedTo / scopedEdges : 0;
    const pending = this.store.db.prepare(`SELECT COUNT(*) AS count FROM kg_duplicate_candidates c
      WHERE c.status='pending'
        AND EXISTS(SELECT 1 FROM kg_observations o LEFT JOIN kg_edges e ON e.id=o.edge_id
          WHERE o.scope=? AND (o.source_entity_id=c.entity_a OR e.source_id=c.entity_a OR e.target_id=c.entity_a))
        AND EXISTS(SELECT 1 FROM kg_observations o LEFT JOIN kg_edges e ON e.id=o.edge_id
          WHERE o.scope=? AND (o.source_entity_id=c.entity_b OR e.source_id=c.entity_b OR e.target_id=c.entity_b))`).get(normalizedScope, normalizedScope) as { count?: number };
    const relatedWarning = scopedEdges >= policy.relatedToWarningMinimumEdges && ratio >= policy.relatedToWarningRatio;
    const recommendations: GraphHygieneReport["recommendations"] = [];
    if (relatedWarning) recommendations.push("related_to_overrepresented");
    if (selfLinks) recommendations.push("self_links_detected");
    if (Number(pending.count ?? 0)) recommendations.push("duplicate_review_pending");
    return {
      version: "graph-hygiene-v1", scope: normalizedScope, evaluated_at: evaluatedAt, scoped_edges: scopedEdges,
      related_to: { edges: relatedTo, ratio, warning: relatedWarning }, ...(includeTopology ? { related_to_topology: this.assessRelatedToTopology(normalizedScope, evaluatedAt) } : {}), suspicious_self_links: selfLinks,
      pending_duplicate_candidates: Number(pending.count ?? 0), recommendations
    };
  }

  /**
   * Compares the current related_to multiplier with two candidate policies on
   * the same scope-local graph. The baseline equations intentionally match
   * GraphologyStore.qualityGraphSnapshot; the result is diagnostic only.
   */
  private assessRelatedToTopology(scope: string, evaluatedAt: number): RelatedToTopologyAssessment {
    const limits = { max_nodes: topologyLimits.maxNodes, max_edges: topologyLimits.maxEdges, representative_seeds: topologyLimits.representativeSeeds, top_k: topologyLimits.topK };
    const nodeCount = this.scopedNodeCount(scope), edgeCount = this.scopedStructuralEdgeCount(scope, evaluatedAt);
    const base = { version: "related-to-topology-v1" as const, scope, evaluated_at: evaluatedAt, node_count: nodeCount, structural_edge_count: edgeCount, related_to_edges: 0, limits };
    if (nodeCount > topologyLimits.maxNodes || edgeCount > topologyLimits.maxEdges) return { ...base, status: "scale_limited" };
    const nodes = this.scopedNodeIds(scope);
    const edges = this.scopedStructuralEdges(scope, evaluatedAt);
    const relatedToEdges = edges.filter(edge => edge.type === "related_to").length;
    if (!nodes.length || !edges.length) return { ...base, status: "not_enough_topology", related_to_edges: relatedToEdges };

    const projections = {
      baseline: this.projectTopology(nodes, edges, .35),
      downweighted: this.projectTopology(nodes, edges, .105),
      excluded: this.projectTopology(nodes, edges, 0)
    } as const;
    const seedIds = representativeSeeds(nodes, projections.baseline.arcs, topologyLimits.representativeSeeds);
    return {
      ...base,
      status: "ok",
      related_to_edges: relatedToEdges,
      policies: Object.fromEntries((Object.entries(projections) as Array<[RelatedToPolicy, ReturnType<GraphHygieneService["projectTopology"]>]>).map(([policy, projection]) => [policy, {
        related_to_multiplier: projection.relatedToMultiplier,
        ...topologySummary(nodes, projection.arcs)
      }])) as RelatedToTopologyAssessment["policies"],
      top_k_comparison: {
        excludes_seed: true,
        sampled_seed_count: seedIds.length,
        baseline_to_downweighted: compareTopK(nodes, seedIds, projections.baseline.arcs, projections.downweighted.arcs, topologyLimits.topK),
        baseline_to_excluded: compareTopK(nodes, seedIds, projections.baseline.arcs, projections.excluded.arcs, topologyLimits.topK)
      }
    };
  }

  private scopedNodeCount(scope: string): number {
    const row = this.store.db.prepare(`WITH scoped_ids AS (
      SELECT source_entity_id AS id FROM kg_observations WHERE scope=? AND source_entity_id IS NOT NULL
      UNION SELECT e.source_id FROM kg_edges e JOIN kg_observations o ON o.edge_id=e.id WHERE e.deleted_at IS NULL AND o.scope=?
      UNION SELECT e.target_id FROM kg_edges e JOIN kg_observations o ON o.edge_id=e.id WHERE e.deleted_at IS NULL AND o.scope=?
    ) SELECT COUNT(*) AS count FROM kg_nodes n JOIN scoped_ids s ON s.id=n.id WHERE n.deleted_at IS NULL`).get(scope, scope, scope) as { count?: number };
    return Number(row.count ?? 0);
  }

  private scopedNodeIds(scope: string): string[] {
    return (this.store.db.prepare(`WITH scoped_ids AS (
      SELECT source_entity_id AS id FROM kg_observations WHERE scope=? AND source_entity_id IS NOT NULL
      UNION SELECT e.source_id FROM kg_edges e JOIN kg_observations o ON o.edge_id=e.id WHERE e.deleted_at IS NULL AND o.scope=?
      UNION SELECT e.target_id FROM kg_edges e JOIN kg_observations o ON o.edge_id=e.id WHERE e.deleted_at IS NULL AND o.scope=?
    ) SELECT n.id FROM kg_nodes n JOIN scoped_ids s ON s.id=n.id WHERE n.deleted_at IS NULL ORDER BY n.id LIMIT ?`)
      .all(scope, scope, scope, topologyLimits.maxNodes) as Array<{ id: string }>).map(row => row.id);
  }

  private scopedStructuralEdgeCount(scope: string, now: number): number {
    const row = this.store.db.prepare(`SELECT COUNT(DISTINCT e.id) AS count FROM kg_edges e JOIN kg_observations o ON o.edge_id=e.id
      WHERE e.deleted_at IS NULL AND e.source_id<>e.target_id AND e.type IN ('depends_on','part_of','instance_of','related_to') AND o.scope=?
        AND (o.valid_from IS NULL OR o.valid_from<=?) AND (o.valid_to IS NULL OR o.valid_to>=?)`).get(scope, now, now) as { count?: number };
    return Number(row.count ?? 0);
  }

  private scopedStructuralEdges(scope: string, now: number): ScopedStructuralEdge[] {
    return this.store.db.prepare(`SELECT e.id,e.source_id,e.target_id,e.type,AVG(o.confidence) AS confidence,COUNT(DISTINCT o.source) AS source_count
      FROM kg_edges e JOIN kg_observations o ON o.edge_id=e.id
      WHERE e.deleted_at IS NULL AND e.source_id<>e.target_id AND e.type IN ('depends_on','part_of','instance_of','related_to') AND o.scope=?
        AND (o.valid_from IS NULL OR o.valid_from<=?) AND (o.valid_to IS NULL OR o.valid_to>=?)
      GROUP BY e.id,e.source_id,e.target_id,e.type ORDER BY e.id LIMIT ?`).all(scope, now, now, topologyLimits.maxEdges) as ScopedStructuralEdge[];
  }

  private projectTopology(nodes: string[], edges: ScopedStructuralEdge[], relatedToMultiplier: number): { relatedToMultiplier: number; arcs: PprArc[] } {
    const arcs: PprArc[] = [];
    for (const edge of edges) {
      const scale = clamp01(Number(edge.confidence)) * sourceDiversityScore(Number(edge.source_count));
      if (edge.type === "related_to") {
        if (relatedToMultiplier > 0) arcs.push({ from: edge.source_id, to: edge.target_id, weight: relatedToMultiplier * scale }, { from: edge.target_id, to: edge.source_id, weight: relatedToMultiplier * scale });
      } else {
        arcs.push({ from: edge.source_id, to: edge.target_id, weight: scale }, { from: edge.target_id, to: edge.source_id, weight: .5 * scale });
      }
    }
    const nodeSet = new Set(nodes);
    return { relatedToMultiplier, arcs: arcs.filter(arc => arc.weight > 0 && nodeSet.has(arc.from) && nodeSet.has(arc.to)).sort(compareArc) };
  }

  run(input: { scope: string; policy: GraphHygienePolicy; force?: boolean }): GraphHygieneRun {
    const now = this.now(), scope = normalizeScope(input.scope);
    const completedAt = this.stateNumber(completeState);
    const cursor = this.stateText(`${scanState}_cursor`);
    const due = input.force === true || Boolean(cursor) || completedAt == null || now - completedAt >= input.policy.intervalHours * 3_600_000;
    if (!due) return { status: "not_due", report: this.report(scope, input.policy, false) };
    const scan = this.store.scanDuplicateCandidates(undefined, input.policy.maxDuplicateScanNodes, { persistCursor: true, stateKey: scanState });
    return { status: scan.complete ? "completed" : "continued", duplicate_scan: scan, report: this.report(scope, input.policy, false) };
  }

  private stateText(key: string): string | undefined {
    const row = this.store.db.prepare("SELECT value FROM kg_maintenance_state WHERE key=?").get(key) as { value?: string } | undefined;
    return typeof row?.value === "string" && row.value.length > 0 ? row.value : undefined;
  }

  private stateNumber(key: string): number | undefined {
    const value = Number(this.stateText(key));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
}

function topologySummary(nodes: string[], arcs: PprArc[]): Omit<NonNullable<RelatedToTopologyAssessment["policies"]>[RelatedToPolicy], "related_to_multiplier"> {
  const adjacency = new Map(nodes.map(node => [node, new Set<string>()]));
  for (const arc of arcs) {
    adjacency.get(arc.from)?.add(arc.to);
    adjacency.get(arc.to)?.add(arc.from);
  }
  const visited = new Set<string>();
  let components = 0, largest = 0, isolated = 0;
  for (const node of nodes) {
    if (visited.has(node)) continue;
    components++;
    const queue = [node]; visited.add(node);
    let size = 0;
    while (queue.length) {
      const current = queue.shift()!; size++;
      for (const neighbor of adjacency.get(current) ?? []) if (!visited.has(neighbor)) { visited.add(neighbor); queue.push(neighbor); }
    }
    if (size === 1 && (adjacency.get(node)?.size ?? 0) === 0) isolated++;
    largest = Math.max(largest, size);
  }
  return {
    weak_components: components,
    largest_component_nodes: largest,
    isolated_nodes: isolated,
    largest_component_ratio: round(nodes.length ? largest / nodes.length : 0),
    ppr_arcs: arcs.length
  };
}

function representativeSeeds(nodes: string[], arcs: PprArc[], limit: number): string[] {
  const degree = new Map(nodes.map(node => [node, 0]));
  for (const arc of arcs) degree.set(arc.from, (degree.get(arc.from) ?? 0) + arc.weight);
  return [...nodes].sort((left, right) => (degree.get(right)! - degree.get(left)!) || left.localeCompare(right)).slice(0, limit);
}

function compareTopK(nodes: string[], seeds: string[], baseline: PprArc[], candidate: PprArc[], limit: number): TopologyJaccard {
  if (!seeds.length) return { mean: 1, minimum: 1, changed_seeds: 0 };
  const scores = seeds.map(seed => jaccard(topK(nodes, baseline, seed, limit), topK(nodes, candidate, seed, limit)));
  return { mean: round(scores.reduce((sum, score) => sum + score, 0) / scores.length), minimum: round(Math.min(...scores)), changed_seeds: scores.filter(score => score < 1).length };
}

function topK(nodes: string[], arcs: PprArc[], seed: string, limit: number): string[] {
  const ranks = personalizedPageRank({ nodes, arcs, seeds: { [seed]: 1 } }, { maxNodes: topologyLimits.maxNodes, maxArcs: topologyLimits.maxEdges * 2 });
  return Object.entries(ranks).filter(([id]) => id !== seed).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, limit).map(([id]) => id);
}

function jaccard(left: string[], right: string[]): number {
  const a = new Set(left), b = new Set(right), union = new Set([...a, ...b]);
  if (!union.size) return 1;
  return [...a].filter(id => b.has(id)).length / union.size;
}

function clamp01(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
function round(value: number): number { return Math.round(value * 10_000) / 10_000; }
function compareArc(left: PprArc, right: PprArc): number { return left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.weight - right.weight; }
