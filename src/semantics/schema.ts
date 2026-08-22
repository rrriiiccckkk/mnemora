/** Durable aggregate-only review records for semantic vocabulary evolution.
 * They never alter a dictionary or rewrite an edge without explicit review. */
export const semanticSchemaSql = `
CREATE TABLE IF NOT EXISTS kg_semantic_pattern_candidates (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL REFERENCES kg_scopes(id),
  domain TEXT NOT NULL CHECK(domain IN ('investment','code','unknown')),
  source_type TEXT NOT NULL,
  predicate TEXT NOT NULL,
  target_type TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK(occurrence_count>=1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  UNIQUE(scope,domain,source_type,predicate,target_type)
);
CREATE INDEX IF NOT EXISTS idx_kg_semantic_pattern_scope_updated
  ON kg_semantic_pattern_candidates(scope,status,updated_at DESC,id);
CREATE TABLE IF NOT EXISTS kg_semantic_pattern_reviews (
  candidate_id TEXT PRIMARY KEY REFERENCES kg_semantic_pattern_candidates(id),
  scope TEXT NOT NULL REFERENCES kg_scopes(id),
  decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected')),
  preview_hash TEXT NOT NULL CHECK(length(preview_hash)=64),
  audit_id TEXT NOT NULL REFERENCES kg_quality_audits(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_semantic_pattern_reviews_scope_created
  ON kg_semantic_pattern_reviews(scope,created_at DESC);
`;

export const semanticOptionalRestoreTables = ["kg_semantic_pattern_candidates", "kg_semantic_pattern_reviews"];
