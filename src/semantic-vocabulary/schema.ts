/** Candidate vocabulary is a scope-local read projection. Accepted entries
 * classify only future explicit review proposals; they never become graph
 * relationship types or authorize automatic extraction. */
export const semanticVocabularySchemaSql = `
CREATE TABLE IF NOT EXISTS kg_semantic_vocabulary_candidates (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL REFERENCES kg_scopes(id),
  predicate TEXT NOT NULL CHECK(length(predicate)>=1 AND length(predicate)<=64),
  source_type TEXT NOT NULL CHECK(length(source_type)>=1 AND length(source_type)<=64),
  target_type TEXT NOT NULL CHECK(length(target_type)>=1 AND length(target_type)<=64),
  cue_id TEXT NOT NULL CHECK(length(cue_id)>=1 AND length(cue_id)<=64),
  rationale TEXT NOT NULL CHECK(length(rationale)>=1 AND length(rationale)<=160),
  occurrence_count INTEGER NOT NULL DEFAULT 0 CHECK(occurrence_count>=0),
  source_count INTEGER NOT NULL DEFAULT 0 CHECK(source_count>=0),
  status TEXT NOT NULL DEFAULT 'collecting' CHECK(status IN ('collecting','pending','accepted','rejected')),
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  UNIQUE(scope,predicate,source_type,target_type,cue_id)
);
CREATE INDEX IF NOT EXISTS idx_kg_semantic_vocabulary_scope_status_updated
  ON kg_semantic_vocabulary_candidates(scope,status,updated_at DESC,id);
CREATE TABLE IF NOT EXISTS kg_semantic_vocabulary_candidate_evidence (
  candidate_id TEXT NOT NULL REFERENCES kg_semantic_vocabulary_candidates(id) ON DELETE CASCADE,
  edge_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  evidence_hash TEXT NOT NULL CHECK(length(evidence_hash)=64),
  source_hash TEXT NOT NULL CHECK(length(source_hash)=64),
  PRIMARY KEY(candidate_id,observation_id)
);
CREATE INDEX IF NOT EXISTS idx_kg_semantic_vocabulary_evidence_candidate
  ON kg_semantic_vocabulary_candidate_evidence(candidate_id,edge_id,observation_id);
CREATE TABLE IF NOT EXISTS kg_semantic_vocabulary_reviews (
  candidate_id TEXT PRIMARY KEY REFERENCES kg_semantic_vocabulary_candidates(id),
  scope TEXT NOT NULL REFERENCES kg_scopes(id),
  decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected')),
  preview_hash TEXT NOT NULL CHECK(length(preview_hash)=64),
  audit_id TEXT NOT NULL REFERENCES kg_quality_audits(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_semantic_vocabulary_reviews_scope_created
  ON kg_semantic_vocabulary_reviews(scope,created_at DESC);
`;

export const semanticVocabularyOptionalRestoreTables = [
  "kg_semantic_vocabulary_candidates",
  "kg_semantic_vocabulary_candidate_evidence",
  "kg_semantic_vocabulary_reviews"
];
