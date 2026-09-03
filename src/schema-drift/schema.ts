/** Durable, review-only records for relationships that are structurally safe
 * but do not fit the current domain endpoint dictionary.  They are not graph
 * edges and therefore cannot affect recall until a later explicit review. */
export const schemaDriftSchemaSql = `
CREATE TABLE IF NOT EXISTS kg_schema_drift_candidates (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL REFERENCES kg_scopes(id),
  source_entity_id TEXT NOT NULL REFERENCES kg_nodes(id),
  target_entity_id TEXT NOT NULL REFERENCES kg_nodes(id),
  relationship_type TEXT NOT NULL,
  source_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  expected_source_types TEXT NOT NULL,
  expected_target_types TEXT NOT NULL,
  legacy_edge_id TEXT NOT NULL DEFAULT '',
  relation_payload TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK(occurrence_count>=1),
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(scope,source_entity_id,target_entity_id,relationship_type,legacy_edge_id),
  CHECK(json_valid(relation_payload) AND json_type(relation_payload)='object')
);
CREATE INDEX IF NOT EXISTS idx_kg_schema_drift_scope_updated
  ON kg_schema_drift_candidates(scope,updated_at DESC,id);
CREATE TABLE IF NOT EXISTS kg_schema_drift_repairs (
  candidate_id TEXT PRIMARY KEY REFERENCES kg_schema_drift_candidates(id),
  scope TEXT NOT NULL REFERENCES kg_scopes(id),
  replacement_type TEXT NOT NULL CHECK(replacement_type IN ('depends_on','part_of','instance_of','related_to')),
  preview_hash TEXT NOT NULL CHECK(length(preview_hash)=64),
  edge_id TEXT NOT NULL REFERENCES kg_edges(id),
  observation_id TEXT NOT NULL REFERENCES kg_observations(id),
  audit_id TEXT NOT NULL REFERENCES kg_quality_audits(id),
  retired_edge_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_schema_drift_repairs_scope_created
  ON kg_schema_drift_repairs(scope,created_at DESC);
CREATE TABLE IF NOT EXISTS kg_schema_drift_reviews (
  candidate_id TEXT PRIMARY KEY REFERENCES kg_schema_drift_candidates(id),
  scope TEXT NOT NULL REFERENCES kg_scopes(id),
  decision TEXT NOT NULL CHECK(decision IN ('rejected')),
  preview_hash TEXT NOT NULL CHECK(length(preview_hash)=64),
  audit_id TEXT NOT NULL REFERENCES kg_quality_audits(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_schema_drift_reviews_scope_created
  ON kg_schema_drift_reviews(scope,created_at DESC);
CREATE TABLE IF NOT EXISTS kg_schema_drift_invalidations (
  candidate_id TEXT PRIMARY KEY REFERENCES kg_schema_drift_candidates(id),
  scope TEXT NOT NULL REFERENCES kg_scopes(id),
  reason TEXT NOT NULL CHECK(reason IN ('endpoint_now_allowed')),
  invalidated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_schema_drift_invalidations_scope_created
  ON kg_schema_drift_invalidations(scope,invalidated_at DESC);
`;

/** Added after v52; replacement imports may omit these review-only overlays. */
export const schemaDriftOptionalRestoreTables = [
  "kg_schema_drift_reviews",
  "kg_schema_drift_invalidations"
];
