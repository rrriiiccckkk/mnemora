/**
 * Review-only proposals that turn an evidence-backed legacy `related_to` edge
 * into one of the small topology predicates. No migration backfills or
 * changes graph evidence; confirmation is the only mutation path.
 */
export const relatedEdgeRefinementSchemaSql = `
CREATE TABLE IF NOT EXISTS kg_related_edge_refinement_candidates (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL REFERENCES kg_scopes(id),
  legacy_edge_id TEXT NOT NULL REFERENCES kg_edges(id),
  source_entity_id TEXT NOT NULL REFERENCES kg_nodes(id),
  target_entity_id TEXT NOT NULL REFERENCES kg_nodes(id),
  proposed_source_entity_id TEXT NOT NULL REFERENCES kg_nodes(id),
  proposed_target_entity_id TEXT NOT NULL REFERENCES kg_nodes(id),
  proposed_type TEXT NOT NULL CHECK(proposed_type IN ('depends_on','part_of','instance_of')),
  evidence_observation_id TEXT NOT NULL REFERENCES kg_observations(id),
  evidence_hash TEXT NOT NULL CHECK(length(evidence_hash)=64),
  rationale TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence>=0 AND confidence<=1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  UNIQUE(scope,legacy_edge_id,evidence_observation_id,proposed_type,proposed_source_entity_id,proposed_target_entity_id)
);
CREATE INDEX IF NOT EXISTS idx_kg_related_edge_refinement_scope_status_updated
  ON kg_related_edge_refinement_candidates(scope,status,updated_at DESC,id);
CREATE TABLE IF NOT EXISTS kg_related_edge_refinement_receipts (
  candidate_id TEXT PRIMARY KEY REFERENCES kg_related_edge_refinement_candidates(id),
  scope TEXT NOT NULL REFERENCES kg_scopes(id),
  decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected')),
  preview_hash TEXT NOT NULL CHECK(length(preview_hash)=64),
  audit_id TEXT NOT NULL REFERENCES kg_quality_audits(id),
  edge_id TEXT REFERENCES kg_edges(id),
  observation_id TEXT REFERENCES kg_observations(id),
  retired_edge_id TEXT REFERENCES kg_edges(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_related_edge_refinement_receipts_scope_created
  ON kg_related_edge_refinement_receipts(scope,created_at DESC);
`;

export const relatedEdgeRefinementOptionalRestoreTables = [
  "kg_related_edge_refinement_candidates",
  "kg_related_edge_refinement_receipts"
];
