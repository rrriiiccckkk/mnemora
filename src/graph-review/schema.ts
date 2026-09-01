/** Lifecycle overlays for review proposals. They never own graph facts or
 * delete candidate history; a row only says that an unreviewed proposal can
 * no longer be safely previewed against its exact source state. */
export const graphReviewSchemaSql = `
CREATE TABLE IF NOT EXISTS kg_graph_review_invalidations (
  review_kind TEXT NOT NULL CHECK(review_kind IN ('related_edge_refinement','related_edge_semantic')),
  scope TEXT NOT NULL REFERENCES kg_scopes(id),
  candidate_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('legacy_edge_retired','evidence_removed','evidence_changed','node_evidence_removed')),
  invalidated_at INTEGER NOT NULL,
  PRIMARY KEY(review_kind,scope,candidate_id)
);
CREATE INDEX IF NOT EXISTS idx_kg_graph_review_invalidations_scope_kind_time
  ON kg_graph_review_invalidations(scope,review_kind,invalidated_at DESC,candidate_id);
`;

export const graphReviewOptionalRestoreTables = ["kg_graph_review_invalidations"];
