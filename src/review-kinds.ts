/** Graph review kinds served by kg_review. */
export type ReviewKind = "duplicates" | "anomalies" | "identity" | "semantic_patterns";

/**
 * Review kinds removed with the graph-governance modules in 1.38.0. Requests
 * for them fail with `review_kind_removed`; their tables stay so existing
 * databases keep loading.
 */
export const REMOVED_REVIEW_KINDS = ["schema_drift", "semantic_vocabulary", "related_edge_refinements", "related_edge_semantics", "hygiene", "worklist"] as const;
