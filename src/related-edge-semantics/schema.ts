/**
 * Review-only labels for legacy fallback edges. An accepted label enriches an
 * explicit semantic query but never rewrites the fallback edge or its PPR /
 * traversal role; the v1.12 topology measurement remains authoritative.
 */
export const relatedEdgeSemanticSchemaSql = `
CREATE TABLE IF NOT EXISTS kg_related_edge_semantic_candidates (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL REFERENCES kg_scopes(id),
  legacy_edge_id TEXT NOT NULL REFERENCES kg_edges(id),
  source_entity_id TEXT NOT NULL REFERENCES kg_nodes(id),
  target_entity_id TEXT NOT NULL REFERENCES kg_nodes(id),
  proposed_type TEXT NOT NULL CHECK(length(proposed_type)>=1 AND length(proposed_type)<=64),
  evidence_observation_id TEXT NOT NULL REFERENCES kg_observations(id),
  evidence_hash TEXT NOT NULL CHECK(length(evidence_hash)=64),
  rationale TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence>=0 AND confidence<=1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  UNIQUE(scope,legacy_edge_id,evidence_observation_id,proposed_type)
);
CREATE INDEX IF NOT EXISTS idx_kg_related_edge_semantic_scope_status_updated
  ON kg_related_edge_semantic_candidates(scope,status,updated_at DESC,id);
CREATE TABLE IF NOT EXISTS kg_related_edge_semantic_reviews (
  candidate_id TEXT PRIMARY KEY REFERENCES kg_related_edge_semantic_candidates(id),
  scope TEXT NOT NULL REFERENCES kg_scopes(id),
  decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected')),
  preview_hash TEXT NOT NULL CHECK(length(preview_hash)=64),
  audit_id TEXT NOT NULL REFERENCES kg_quality_audits(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_related_edge_semantic_reviews_scope_created
  ON kg_related_edge_semantic_reviews(scope,created_at DESC);
`;

export const relatedEdgeSemanticOptionalRestoreTables = [
  "kg_related_edge_semantic_candidates",
  "kg_related_edge_semantic_reviews"
];
