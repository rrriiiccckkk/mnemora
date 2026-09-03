export type Direction = "out" | "in" | "both";

export type RelationshipType =
  | "works_at"
  | "invested_in"
  | "supplies"
  | "supplies_product"
  | "supplied_to"
  | "competes_with"
  | "uses"
  | "develops"
  | "owns"
  | "partners_with"
  | "in_portfolio"
  | "depends_on"
  | "part_of"
  | "instance_of"
  | "related_to";

export interface RelationshipDefinition {
  type: RelationshipType;
  source: string;
  target: string;
  directed: boolean;
  singleValued?: boolean;
}

/**
 * The topology layer is deliberately small and domain-neutral.  These are
 * the only relationships used for recursive traversal and graph ranking.
 * `transitive` describes traversal intent only: Mnemora never manufactures a
 * derived A→C fact from A→B and B→C evidence.
 */
export const structuralRelationshipTypes = ["depends_on", "part_of", "instance_of", "related_to"] as const;
export type StructuralRelationshipType = typeof structuralRelationshipTypes[number];
export const semanticRelationshipTypes = [
  "works_at", "invested_in", "supplies", "supplies_product", "supplied_to",
  "competes_with", "uses", "develops", "owns", "partners_with", "in_portfolio"
] as const;
export type SemanticRelationshipType = typeof semanticRelationshipTypes[number];
export type RelationshipLayer = "structural" | "semantic";

export interface StructuralRelationshipPolicy {
  type: StructuralRelationshipType;
  /** Whether PPR may use this asserted edge. */
  ppr: true;
  /** Whether a bounded traversal may follow the asserted edge. */
  traversal: true;
  /** No policy implies a new fact from a multi-hop path. */
  transitive: false;
}

export const structuralRelationshipPolicies: Record<StructuralRelationshipType, StructuralRelationshipPolicy> = {
  depends_on: { type: "depends_on", ppr: true, traversal: true, transitive: false },
  part_of: { type: "part_of", ppr: true, traversal: true, transitive: false },
  instance_of: { type: "instance_of", ppr: true, traversal: true, transitive: false },
  related_to: { type: "related_to", ppr: true, traversal: true, transitive: false }
};

/** A soft, versioned vocabulary.  It contributes a reviewable recommendation
 * only; it never blocks evidence persistence or partitions the global graph. */
export interface SemanticVocabularyEntry extends RelationshipDefinition {
  domain: "investment" | "code";
}

export const semanticVocabularies: readonly SemanticVocabularyEntry[] = [
  { domain: "investment", type: "works_at", source: "person", target: "company", directed: true },
  { domain: "investment", type: "invested_in", source: "person|fund", target: "company", directed: true },
  { domain: "investment", type: "supplies", source: "company", target: "company", directed: true },
  { domain: "investment", type: "supplies_product", source: "company", target: "product", directed: true },
  { domain: "investment", type: "supplied_to", source: "product", target: "company", directed: true },
  { domain: "investment", type: "competes_with", source: "company", target: "company", directed: false },
  { domain: "investment", type: "uses", source: "company|person", target: "technology|product", directed: true },
  { domain: "investment", type: "develops", source: "company", target: "product", directed: true },
  { domain: "investment", type: "owns", source: "company|person", target: "company", directed: true },
  { domain: "investment", type: "partners_with", source: "company", target: "company", directed: false },
  { domain: "investment", type: "in_portfolio", source: "company", target: "portfolio", directed: true },
  { domain: "code", type: "uses", source: "product|technology|concept", target: "technology|product|concept", directed: true },
  { domain: "code", type: "develops", source: "product|technology|concept", target: "product|technology|concept", directed: true }
];

export const relationshipDefinitions: Record<RelationshipType, RelationshipDefinition> = {
  works_at: { type: "works_at", source: "person", target: "company", directed: true },
  invested_in: { type: "invested_in", source: "person|fund", target: "company", directed: true },
  supplies: { type: "supplies", source: "company", target: "company", directed: true },
  supplies_product: { type: "supplies_product", source: "company", target: "product", directed: true },
  supplied_to: { type: "supplied_to", source: "product", target: "company", directed: true },
  competes_with: { type: "competes_with", source: "company", target: "company", directed: false },
  uses: { type: "uses", source: "company|person", target: "technology|product", directed: true },
  develops: { type: "develops", source: "company", target: "product", directed: true },
  owns: { type: "owns", source: "company|person", target: "company", directed: true },
  partners_with: { type: "partners_with", source: "company", target: "company", directed: false },
  in_portfolio: { type: "in_portfolio", source: "company", target: "portfolio", directed: true },
  // Structural relations retain useful topology when an extractor's domain
  // label is too narrow.  They are only admitted through explicit repair,
  // never as an automatic fallback during ingestion.
  depends_on: { type: "depends_on", source: "*", target: "*", directed: true },
  part_of: { type: "part_of", source: "*", target: "*", directed: true },
  instance_of: { type: "instance_of", source: "*", target: "*", directed: true },
  related_to: { type: "related_to", source: "*", target: "*", directed: false }
};

export function relationshipLayer(type: RelationshipType): RelationshipLayer {
  return (structuralRelationshipTypes as readonly string[]).includes(type) ? "structural" : "semantic";
}

export function isStructuralRelationship(type: RelationshipType): type is StructuralRelationshipType {
  return relationshipLayer(type) === "structural";
}

export function isSemanticRelationship(type: RelationshipType): type is SemanticRelationshipType {
  return relationshipLayer(type) === "semantic";
}

const accepts = (expected: string, actual: string) => expected === "*" || expected.split("|").includes(actual);

/** Choose the strongest built-in domain suggestion.  A mismatch remains a
 * stored semantic label and receives a drift candidate; it is not rejected. */
export function semanticVocabularyRecommendation(type: RelationshipType, sourceType: string, targetType: string): {
  domain: "investment" | "code" | "unknown";
  definition: RelationshipDefinition;
  endpoint_match: boolean;
} {
  const entries = semanticVocabularies.filter(entry => entry.type === type);
  if (!entries.length) return { domain: "unknown", definition: relationshipDefinitions[type], endpoint_match: true };
  const ranked = entries.map((entry, index) => ({ entry, index, score: Number(accepts(entry.source, sourceType)) + Number(accepts(entry.target, targetType)) }));
  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = ranked[0]!.entry;
  return { domain: selected.domain, definition: selected, endpoint_match: accepts(selected.source, sourceType) && accepts(selected.target, targetType) };
}

export function effectiveDirection(type: RelationshipType, requested?: Direction): Direction {
  if (!relationshipDefinitions[type].directed) {
    return "both";
  }
  return requested ?? "both";
}
