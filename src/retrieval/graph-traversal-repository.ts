import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { renderContext } from "../context-renderer.js";
import { mapEdge, mapNode, mapSourceSummary, type EdgeRow, type NodeRow } from "../graph-records.js";
import { effectiveDirection, isSemanticRelationship, isStructuralRelationship, relationshipDefinitions, semanticRelationshipTypes, semanticVocabularyRecommendation, structuralRelationshipTypes, type Direction, type RelationshipType } from "../relationships.js";
import { normalizeScope } from "../scope.js";
import type { EvidenceSummary, KgContextResult, KgEdge, KgMemorySearchResult, KgNode, KgRelatedResult, KgSearchResult, KgSourceSummary, RelatedSemanticLabelResult } from "../types.js";
import { GraphSearchRepository } from "./graph-search-repository.js";

/**
 * Read-only graph traversal and context projection. Its interface keeps
 * topology rules, scope checks, source attribution, and label projection
 * together while GraphologyStore remains the caller-facing compatibility
 * facade.
 */
export class GraphTraversalRepository {
  constructor(private readonly db: DatabaseSyncInstance, private readonly graphSearch: GraphSearchRepository) {}

  resolveEntity(input: string): KgNode | null {
    const exact = this.getNodeById(input);
    if (exact) return exact;
    const redirect = this.db.prepare("SELECT canonical_id FROM kg_entity_redirects WHERE retired_id=?").get(input) as { canonical_id: string } | undefined;
    if (redirect) return this.getNodeById(redirect.canonical_id);
    return this.graphSearch.lexicalCandidates(input, undefined, 1)[0]?.node ?? null;
  }

  getNodeById(id: string, includeDeleted = false): KgNode | null {
    const row = this.db.prepare(`SELECT * FROM kg_nodes WHERE id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"}`).get(id) as NodeRow | undefined;
    return row ? mapNode(row) : null;
  }

  related(entity: string, depth = 1, edgeTypes?: RelationshipType[], direction?: Direction, scope?: string, semanticPredicates?: readonly string[]): KgRelatedResult {
    const root = this.resolveEntity(entity);
    if (!root) throw new Error(`Entity not found: ${entity}`);
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    // Global node identities may have evidence in more than one collection.
    // A scoped traversal cannot reveal that a root exists in another one.
    if (normalizedScope && !this.hasGraphPresence(root.id, normalizedScope)) throw new Error(`Entity not found: ${entity}`);
    const maxDepth = Math.max(0, Math.min(depth, 5));
    // Semantic labels are returned only when explicitly requested; they never
    // become recursive topology arcs.
    const requested = edgeTypes?.length ? edgeTypes : undefined;
    const allowed = new Set((requested ?? structuralRelationshipTypes).filter(isStructuralRelationship));
    const requestedSemantic = new Set<string>([
      ...(requested ?? []).filter(isSemanticRelationship),
      ...(semanticPredicates ?? []).filter(isSemanticLabelPredicate)
    ]);
    const nodes = new Map<string, KgNode>([[root.id, root]]);
    const edgeResults = new Map<string, KgRelatedResult["edges"][number]>();
    const visitedAt = new Map<string, number>([[root.id, 0]]);
    const queue: Array<{ node: KgNode; depth: number }> = [{ node: root, depth: 0 }];
    const maxNodes = 200, maxEdges = 500;
    while (queue.length && nodes.size < maxNodes && edgeResults.size < maxEdges) {
      const current = queue.shift();
      if (!current || current.depth >= maxDepth) continue;
      for (const edge of this.edgesForNode(current.node.id, allowed, direction, normalizedScope).slice(0, maxEdges - edgeResults.size)) {
        const traversalDirection = edge.source_id === current.node.id ? "out" : "in";
        const nextId = traversalDirection === "out" ? edge.target_id : edge.source_id;
        const nextNode = this.getNodeById(nextId);
        const sourceNode = this.getNodeById(edge.source_id);
        const targetNode = this.getNodeById(edge.target_id);
        if (!nextNode || !sourceNode || !targetNode) continue;
        if (!nodes.has(nextNode.id) && nodes.size >= maxNodes) continue;
        nodes.set(nextNode.id, nextNode);
        edgeResults.set(`${edge.id}:${current.node.id}:${traversalDirection}`, { edge, source: sourceNode, target: targetNode, traversal_direction: traversalDirection, evidence: this.evidenceForEdge(edge.id, 3, normalizedScope) });
        const nextDepth = current.depth + 1;
        const previousDepth = visitedAt.get(nextNode.id);
        if (previousDepth == null || nextDepth < previousDepth) {
          visitedAt.set(nextNode.id, nextDepth);
          queue.push({ node: nextNode, depth: nextDepth });
        }
      }
    }
    const semantic_labels = requestedSemantic.size
      ? this.semanticLabelsForNode(root.id, requestedSemantic, normalizedScope, 100, direction)
      : [];
    for (const label of semantic_labels) {
      nodes.set(label.source.id, label.source);
      nodes.set(label.target.id, label.target);
    }
    semantic_labels.sort((a, b) => b.score - a.score || a.predicate.localeCompare(b.predicate) || a.id.localeCompare(b.id));
    return { root, nodes: [...nodes.values()].sort((a, b) => b.importance - a.importance || a.name.localeCompare(b.name)), edges: [...edgeResults.values()].sort((a, b) => b.edge.weight - a.edge.weight || a.edge.type.localeCompare(b.edge.type)), semantic_labels };
  }

  contextFromSeeds(query: string, nodes: KgSearchResult[], options: { maxDepth?: number; confidenceThreshold?: number; tokenBudget?: number; scope?: string; memories?: KgMemorySearchResult[] } = {}): KgContextResult {
    const maxDepth = clampInt(options.maxDepth ?? 1, 0, 5);
    const confidenceThreshold = clamp01(options.confidenceThreshold ?? 0);
    const tokenBudget = clampInt(options.tokenBudget ?? 800, 100, 8000);
    const edges = new Map<string, KgRelatedResult["edges"][number]>();
    const semanticLabels = new Map<string, RelatedSemanticLabelResult>();
    const sourceNames = new Set<string>();
    const requestedSemantic = semanticPredicatesForQuery(query);
    const boundedNodes = nodes.slice(0, 50);
    let projectionTruncated = nodes.length > boundedNodes.length;
    for (const result of boundedNodes) {
      for (const evidence of result.evidence) sourceNames.add(evidence.source);
      const related = this.related(result.node.id, maxDepth, undefined, undefined, options.scope);
      for (const edge of related.edges) {
        const filteredEvidence = edge.evidence.filter((evidence) => evidence.confidence >= confidenceThreshold);
        if (!filteredEvidence.length) continue;
        for (const evidence of filteredEvidence) sourceNames.add(evidence.source);
        if (!edges.has(edge.edge.id) && edges.size >= 500) { projectionTruncated = true; continue; }
        edges.set(edge.edge.id, { ...edge, evidence: filteredEvidence });
      }
      if (requestedSemantic.size) for (const label of this.semanticLabelsForNode(result.node.id, requestedSemantic, options.scope, 20)) {
        const evidence = label.evidence.filter(item => item.confidence >= confidenceThreshold);
        if (!evidence.length) continue;
        for (const item of evidence) sourceNames.add(item.source);
        semanticLabels.set(label.id, { ...label, evidence });
      }
    }
    const rankedEdges = [...edges.values()].sort((a, b) =>
      contextEdgeScore(b.edge) - contextEdgeScore(a.edge)
      || b.evidence[0]!.confidence - a.evidence[0]!.confidence
      || a.edge.type.localeCompare(b.edge.type));
    const sources = this.sources({ sources: [...sourceNames], scope: options.scope });
    const memories = options.memories ?? [];
    const labels = [...semanticLabels.values()].sort((a, b) => b.score - a.score || a.predicate.localeCompare(b.predicate) || a.id.localeCompare(b.id)).slice(0, 50);
    const rendered = renderContext({ query, nodes, edges: rankedEdges, semanticLabels: labels, sources, memories, tokenBudget });
    return { query, context: rendered.context, nodes: boundedNodes, edges: rankedEdges, semantic_labels: labels, sources, ...(memories.length ? { memories } : {}), truncated: rendered.truncated || projectionTruncated };
  }

  sources(options: { sources?: string[]; limit?: number; scope?: string } = {}): KgSourceSummary[] {
    const limit = clampInt(options.limit ?? 20, 1, 100);
    const scope = options.scope == null ? undefined : normalizeScope(options.scope);
    if (options.sources?.length) {
      const sourceSet = new Set(options.sources.filter((source) => source.trim().length > 0));
      if (!sourceSet.size) return [];
      return [...sourceSet]
        .flatMap((source) => this.sourceSummary(source, scope))
        .sort((a, b) => b.last_seen_at - a.last_seen_at || b.average_confidence - a.average_confidence)
        .slice(0, limit);
    }
    const rows = this.db.prepare(`
      SELECT source, COUNT(*) AS observations, AVG(confidence) AS average_confidence, MIN(created_at) AS first_seen_at, MAX(created_at) AS last_seen_at
      FROM kg_observations WHERE (? IS NULL OR scope=?)
      GROUP BY source
      ORDER BY last_seen_at DESC, average_confidence DESC
      LIMIT ?
    `).all(scope ?? null, scope ?? null, limit) as Array<{ source: string; observations: number; average_confidence: number; first_seen_at: number; last_seen_at: number }>;
    return rows.map(mapSourceSummary);
  }

  /** Used by integrity checks that need the same scope filtering as traversal. */
  evidenceForEdge(edgeId: string, limit: number, scope?: string): EvidenceSummary[] {
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    return this.db.prepare("SELECT id AS observation_id,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at FROM kg_observations WHERE edge_id = ? AND (? IS NULL OR scope=?) ORDER BY confidence DESC,created_at DESC,id LIMIT ?").all(edgeId, normalizedScope ?? null, normalizedScope ?? null, limit) as EvidenceSummary[];
  }

  private hasGraphPresence(nodeId: string, scope: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1
      FROM kg_observations o
      LEFT JOIN kg_edges e ON e.id=o.edge_id
      WHERE o.scope=? AND (o.source_entity_id=? OR e.source_id=? OR e.target_id=?)
      LIMIT 1`).get(scope, nodeId, nodeId, nodeId));
  }

  private sourceSummary(source: string, scope?: string): KgSourceSummary[] {
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    const row = this.db.prepare(`
      SELECT source, COUNT(*) AS observations, AVG(confidence) AS average_confidence, MIN(created_at) AS first_seen_at, MAX(created_at) AS last_seen_at
      FROM kg_observations
      WHERE source = ? AND (? IS NULL OR scope=?)
      GROUP BY source
    `).get(source, normalizedScope ?? null, normalizedScope ?? null) as { source: string; observations: number; average_confidence: number; first_seen_at: number; last_seen_at: number } | undefined;
    return row ? [mapSourceSummary(row)] : [];
  }

  /** Domain labels stay projections: never a recursive graph arc. */
  private semanticLabelsForNode(nodeId: string, predicates: ReadonlySet<string>, scope?: string, limit = 100, direction?: Direction): RelatedSemanticLabelResult[] {
    if (!predicates.size) return [];
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    const statement = this.db.prepare("SELECT * FROM kg_edges WHERE deleted_at IS NULL AND type=? AND (source_id=? OR target_id=?) AND (? IS NULL OR EXISTS (SELECT 1 FROM kg_observations so WHERE so.edge_id=kg_edges.id AND so.scope=?)) ORDER BY id LIMIT ?");
    const acceptedLegacyLabel = this.db.prepare(`SELECT c.id AS candidate_id,c.proposed_type,c.legacy_edge_id,c.source_entity_id,c.target_entity_id,
      o.id AS observation_id,o.source,o.quote,o.confidence,o.valid_from,o.valid_to,o.temporal_confidence,o.created_at
      FROM kg_related_edge_semantic_candidates c
        JOIN kg_related_edge_semantic_reviews r ON r.candidate_id=c.id AND r.scope=c.scope AND r.decision='accepted'
        JOIN kg_edges e ON e.id=c.legacy_edge_id AND e.deleted_at IS NULL AND e.type='related_to'
        JOIN kg_observations o ON o.id=c.evidence_observation_id AND o.edge_id=e.id AND o.scope=c.scope
      WHERE c.proposed_type=? AND (c.source_entity_id=? OR c.target_entity_id=?) AND (? IS NULL OR c.scope=?)
      ORDER BY c.id LIMIT ?`);
    const labels: RelatedSemanticLabelResult[] = [];
    for (const predicate of [...predicates].sort()) {
      if (isBuiltInSemanticPredicate(predicate)) {
        for (const row of statement.all(predicate, nodeId, nodeId, normalizedScope ?? null, normalizedScope ?? null, boundedLimit(limit)) as EdgeRow[]) {
          const edge = mapEdge(row), source = this.getNodeById(edge.source_id), target = this.getNodeById(edge.target_id);
          if (!source || !target) continue;
          const requestedDirection = effectiveDirection(edge.type, direction);
          if (requestedDirection === "out" && edge.source_id !== nodeId) continue;
          if (requestedDirection === "in" && edge.target_id !== nodeId) continue;
          const recommendation = semanticVocabularyRecommendation(edge.type, source.type, target.type);
          const stored = edge.edge_props.semantics;
          const metadata = stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Record<string, unknown> : undefined;
          const domain = metadata?.domain === "investment" || metadata?.domain === "code" ? metadata.domain : recommendation.domain;
          const endpoint_match = typeof metadata?.endpoint_match === "boolean" ? metadata.endpoint_match : recommendation.endpoint_match;
          const evidence = this.evidenceForEdge(edge.id, 3, normalizedScope);
          if (!evidence.length) continue;
          const confidence = evidence.reduce((total, item) => total + item.confidence, 0) / evidence.length;
          labels.push({ id: edge.id, predicate: edge.type, domain, source, target, evidence, legacy: metadata?.layer !== "semantic", endpoint_match, score: confidence * (endpoint_match ? 1 : .75) });
          if (labels.length >= limit) return labels;
        }
      }
      for (const row of acceptedLegacyLabel.all(predicate, nodeId, nodeId, normalizedScope ?? null, normalizedScope ?? null, boundedLimit(limit)) as Array<{
        candidate_id: string; proposed_type: string; source_entity_id: string; target_entity_id: string;
        observation_id: string; source: string; quote: string; confidence: number; valid_from: number | null; valid_to: number | null; temporal_confidence: number | null; created_at: number;
      }>) {
        const source = this.getNodeById(row.source_entity_id), target = this.getNodeById(row.target_entity_id);
        if (!source || !target) continue;
        const requestedDirection = semanticLabelDirection(row.proposed_type, direction);
        if (requestedDirection === "out" && row.source_entity_id !== nodeId) continue;
        if (requestedDirection === "in" && row.target_entity_id !== nodeId) continue;
        const recommendation = isBuiltInSemanticPredicate(row.proposed_type)
          ? semanticVocabularyRecommendation(row.proposed_type, source.type, target.type)
          : { domain: "neutral" as const, endpoint_match: true };
        const evidence: EvidenceSummary[] = [{ observation_id: row.observation_id, source: row.source, quote: row.quote, confidence: clamp01(Number(row.confidence)), valid_from: row.valid_from, valid_to: row.valid_to, temporal_confidence: row.temporal_confidence, created_at: Number(row.created_at) }];
        labels.push({ id: `related-edge-semantic:${row.candidate_id}`, predicate: row.proposed_type, domain: recommendation.domain, source, target, evidence, legacy: true, endpoint_match: recommendation.endpoint_match, score: evidence[0]!.confidence * (recommendation.endpoint_match ? 1 : .75) });
        if (labels.length >= limit) return labels;
      }
    }
    return labels;
  }

  private edgesForNode(nodeId: string, allowed: Set<RelationshipType> | null, direction?: Direction, scope?: string): KgEdge[] {
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    const statement = this.db.prepare("SELECT * FROM kg_edges WHERE deleted_at IS NULL AND type = ? AND (source_id = ? OR target_id = ?) AND (? IS NULL OR EXISTS (SELECT 1 FROM kg_observations so WHERE so.edge_id=kg_edges.id AND so.scope=?))");
    const result: KgEdge[] = [];
    for (const type of Object.keys(relationshipDefinitions) as RelationshipType[]) {
      if (allowed && !allowed.has(type)) continue;
      const requested = effectiveDirection(type, direction);
      for (const row of statement.all(type, nodeId, nodeId, normalizedScope ?? null, normalizedScope ?? null) as EdgeRow[]) {
        const edge = mapEdge(row);
        if (requested === "out" && edge.source_id !== nodeId) continue;
        if (requested === "in" && edge.target_id !== nodeId) continue;
        result.push(edge);
      }
    }
    return result;
  }
}

const semanticQueryAliases: Partial<Record<RelationshipType, readonly string[]>> = {
  works_at: ["works_at", "works at", "工作于", "任职"],
  invested_in: ["invested_in", "invested in", "投资"],
  supplies: ["supplies", "supply", "供应"],
  supplies_product: ["supplies_product", "supplies product", "供应产品"],
  supplied_to: ["supplied_to", "供货给"],
  competes_with: ["competes_with", "competes with", "竞争"],
  uses: ["uses", "using", "使用"],
  develops: ["develops", "developed", "开发"],
  owns: ["owns", "owned", "拥有"],
  partners_with: ["partners_with", "partners with", "合作"],
  in_portfolio: ["in_portfolio", "portfolio", "投资组合"]
};

function semanticPredicatesForQuery(query: string): Set<RelationshipType> {
  const normalized = query.normalize("NFKC").toLocaleLowerCase();
  const selected = new Set<RelationshipType>();
  for (const predicate of semanticRelationshipTypes) {
    const aliases = semanticQueryAliases[predicate] ?? [predicate];
    if (aliases.some(alias => /[a-z_]/i.test(alias)
      ? new RegExp(`(?:^|[^a-z0-9_])${escapeRegex(alias.toLocaleLowerCase())}(?:$|[^a-z0-9_])`, "i").test(normalized)
      : normalized.includes(alias))) selected.add(predicate);
  }
  if (selected.has("supplies") && hasSupplyObject(normalized)) selected.add("supplies_product");
  return selected;
}

function isSemanticLabelPredicate(value: string): boolean { return /^[a-z][a-z0-9_]{0,63}$/.test(value); }
function isBuiltInSemanticPredicate(value: string): value is RelationshipType { return value in relationshipDefinitions && isSemanticRelationship(value as RelationshipType); }
function semanticLabelDirection(predicate: string, requested?: Direction): Direction { return isBuiltInSemanticPredicate(predicate) ? effectiveDirection(predicate, requested) : requested ?? "both"; }
function hasSupplyObject(query: string): boolean { return /\b(?:supplies|supply)\s+(?:(?:the|a|an)\s+)?(?!to\b)[\p{L}\p{N}_-]+/iu.test(query) || /供应\s*[\p{L}\p{N}_-]/u.test(query); }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function clampInt(value: number, min: number, max: number): number { return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : min; }
function boundedLimit(value: number): number { return Math.min(100, Math.max(1, Math.trunc(value))); }
function contextEdgeScore(edge: KgEdge): number { return edge.weight * (edge.type === "related_to" ? .75 : 1); }
