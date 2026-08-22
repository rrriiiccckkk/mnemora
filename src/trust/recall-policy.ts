import type { KgContextResult } from "../types.js";
import { normalizeScope } from "../scope.js";
import { renderContext } from "../context-renderer.js";
import { VerificationRepository } from "./verification.js";

export interface RecallPolicyDecision {
  allowed: boolean;
  evaluated_sources: number;
  excluded_sources: number;
  reason: "disabled" | "no_graph_evidence" | "verified" | "unverified_evidence";
  /** Present only when strict policy has removed non-verified claims. */
  context?: KgContextResult;
}

/** Strict policy for automatic Mnemora context only. Manual queries preserve their legacy result shape. */
export class RecallPolicyService {
  constructor(private readonly repository: VerificationRepository, private readonly enabled: boolean, private readonly tokenBudget = 800) {}

  evaluateAutomaticContext(context: KgContextResult, scope: string, options: { recordRecall?: boolean } = {}): RecallPolicyDecision {
    if (!this.enabled) return { allowed: true, evaluated_sources: 0, excluded_sources: 0, reason: "disabled" };
    const graphEvidence = [...context.nodes.flatMap(item => item.evidence), ...context.edges.flatMap(item => item.evidence), ...context.semantic_labels.flatMap(item => item.evidence)];
    if (!graphEvidence.length) {
      const hasGraphShape = context.nodes.length > 0 || context.edges.length > 0 || context.semantic_labels.length > 0;
      return hasGraphShape
        ? { allowed: false, evaluated_sources: 0, excluded_sources: 0, reason: "unverified_evidence" }
        : { allowed: true, evaluated_sources: 0, excluded_sources: 0, reason: "no_graph_evidence" };
    }
    const claimIds = graphEvidence.map(item => item.observation_id).filter((value): value is string => typeof value === "string").slice(0, 200);
    const eligibility = this.repository.claimEligibility(normalizeScope(scope), claimIds);
    const permitted = (evidence: typeof graphEvidence[number]) => typeof evidence.observation_id === "string" && eligibility.get(evidence.observation_id) === true;
    const nodes = context.nodes
      .map(item => ({ ...item, evidence: item.evidence.filter(permitted) }))
      .filter(item => item.evidence.length > 0);
    const edges = context.edges
      .map(item => ({ ...item, evidence: item.evidence.filter(permitted) }))
      .filter(item => item.evidence.length > 0);
    const semantic_labels = context.semantic_labels
      .map(item => ({ ...item, evidence: item.evidence.filter(permitted) }))
      .filter(item => item.evidence.length > 0);
    if (!nodes.length && !edges.length && !semantic_labels.length) {
      const sources = new Set(graphEvidence.map(item => item.source).filter(Boolean));
      return { allowed: false, evaluated_sources: sources.size, excluded_sources: sources.size, reason: "unverified_evidence" };
    }
    const renderedNodes = new Map(nodes.map(item => [item.node.id, item]));
    for (const edge of edges) for (const node of [edge.source, edge.target]) {
      if (!renderedNodes.has(node.id)) renderedNodes.set(node.id, { node, score: 0, evidence: [] });
    }
    for (const label of semantic_labels) for (const node of [label.source, label.target]) {
      if (!renderedNodes.has(node.id)) renderedNodes.set(node.id, { node, score: 0, evidence: [] });
    }
    const allowedEvidence = [...nodes.flatMap(item => item.evidence), ...edges.flatMap(item => item.evidence), ...semantic_labels.flatMap(item => item.evidence)];
    if (options.recordRecall !== false) try { this.repository.recordClaimRecall(normalizeScope(scope), allowedEvidence.map(item => item.observation_id).filter((value): value is string => typeof value === "string")); } catch { /* recall remains fail-open */ }
    const sourceRows = summary(allowedEvidence);
    const rendered = renderContext({ query: context.query, nodes: [...renderedNodes.values()], edges, semanticLabels: semantic_labels, sources: sourceRows, memories: context.memories ?? [], tokenBudget: this.tokenBudget });
    const allowedContext: KgContextResult = {
      query: context.query, context: rendered.context, nodes: [...renderedNodes.values()], edges, semantic_labels, sources: sourceRows,
      ...(context.memories?.length ? { memories: context.memories } : {}), truncated: context.truncated || rendered.truncated
    };
    const originalSources = new Set(graphEvidence.map(item => item.source).filter(Boolean));
    const admittedSources = new Set(allowedEvidence.map(item => item.source).filter(Boolean));
    return { allowed: true, evaluated_sources: originalSources.size, excluded_sources: Math.max(0, originalSources.size - admittedSources.size), reason: "verified", context: allowedContext };
  }
}

function summary(evidence: Array<{ source: string; confidence: number; created_at: number }>) {
  const grouped = new Map<string, Array<{ confidence: number; created_at: number }>>();
  for (const item of evidence) if (typeof item.source === "string" && item.source) grouped.set(item.source, [...(grouped.get(item.source) ?? []), item]);
  return [...grouped.entries()].map(([source, items]) => ({
    source, observations: items.length,
    average_confidence: items.reduce((total, item) => total + item.confidence, 0) / items.length,
    first_seen_at: Math.min(...items.map(item => item.created_at)), last_seen_at: Math.max(...items.map(item => item.created_at))
  })).sort((a, b) => b.last_seen_at - a.last_seen_at || b.average_confidence - a.average_confidence).slice(0, 8);
}
