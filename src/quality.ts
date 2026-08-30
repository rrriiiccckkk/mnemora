import { isSemanticRelationship, relationshipDefinitions, semanticVocabularyRecommendation, type RelationshipType } from "./relationships.js";
import type { KgNode } from "./types.js";

export type RelationshipSkipReason = "self_loop" | "invalid_endpoint_types" | "below_edge_confidence" | "missing_related_to_evidence";
export interface RelationshipQualityPolicy {
  edgeMinConfidence: number;
  relatedToMinConfidence: number;
  edgeTypeMinConfidence: Partial<Record<RelationshipType, number>>;
}

const accepts = (definition: string, actual: string) => definition === "*" || definition.split("|").includes(actual);

export function validateRelationship(
  source: KgNode,
  target: KgNode,
  type: RelationshipType,
  confidence: number,
  minimumConfidence = 0,
  evidenceSpan?: string
): { accepted: true; endpoint_match: boolean } | { accepted: false; reason: RelationshipSkipReason } {
  if (source.id === target.id) return { accepted: false, reason: "self_loop" };
  const definition = relationshipDefinitions[type];
  const endpointMatch = isSemanticRelationship(type)
    ? semanticVocabularyRecommendation(type, source.type, target.type).endpoint_match
    : accepts(definition.source, source.type) && accepts(definition.target, target.type);
  // Domain vocabulary is intentionally advisory.  Preserve the evidence as a
  // semantic label, mark a drift proposal, and let an operator decide whether
  // its aggregate pattern belongs in a future dictionary.
  if (!endpointMatch && !isSemanticRelationship(type)) {
    return { accepted: false, reason: "invalid_endpoint_types" };
  }
  // A generic association has no useful semantics unless its direct evidence
  // is retained. Existing rows are reviewed without this ingestion-only gate.
  if (type === "related_to" && evidenceSpan != null && !evidenceSpan.trim()) return { accepted: false, reason: "missing_related_to_evidence" };
  if (confidence < minimumConfidence) return { accepted: false, reason: "below_edge_confidence" };
  return { accepted: true, endpoint_match: endpointMatch };
}

export function relationshipMinimum(type: RelationshipType, policy: RelationshipQualityPolicy): number {
  return policy.edgeTypeMinConfidence[type] ?? (type === "related_to" ? policy.relatedToMinConfidence : policy.edgeMinConfidence);
}
