export const consolidationSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_consolidation_jobs (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, input_hash TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_at INTEGER,
  error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER,
  UNIQUE(scope,kind,input_hash),
  CHECK(kind IN ('duplicate','conflict','stale','digest')),
  CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
  CHECK(attempts>=0), FOREIGN KEY(scope) REFERENCES kg_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_consolidation_jobs_scope_status ON mnemora_consolidation_jobs(scope,status,updated_at);
CREATE TABLE IF NOT EXISTS mnemora_consolidation_proposals (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, proposal_hash TEXT NOT NULL,
  source_refs TEXT NOT NULL, metadata TEXT NOT NULL, score REAL NOT NULL,
  status TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, reviewed_at INTEGER,
  UNIQUE(scope,proposal_hash),
  CHECK(kind IN ('duplicate_episode','conflict_review','staleness_review','session_digest')),
  CHECK(status IN ('proposed','approved','rejected','expired')),
  CHECK(json_valid(source_refs) AND length(source_refs)<=4096),
  CHECK(json_valid(metadata) AND length(metadata)<=4096),
  CHECK(score>=0 AND score<=1), FOREIGN KEY(scope) REFERENCES kg_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_consolidation_proposals_scope_status ON mnemora_consolidation_proposals(scope,status,created_at DESC);
CREATE TABLE IF NOT EXISTS mnemora_consolidation_adoptions (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, proposal_id TEXT NOT NULL,
  action TEXT NOT NULL, retained_refs TEXT NOT NULL, archived_refs TEXT NOT NULL,
  preview_hash TEXT NOT NULL, adopted_at INTEGER NOT NULL,
  UNIQUE(scope,proposal_id),
  CHECK(action IN ('archive_duplicate_episodes','archive_stale_episode')),
  CHECK(json_valid(retained_refs) AND length(retained_refs)<=4096),
  CHECK(json_valid(archived_refs) AND length(archived_refs)<=4096),
  FOREIGN KEY(scope) REFERENCES kg_scopes(id),
  FOREIGN KEY(proposal_id) REFERENCES mnemora_consolidation_proposals(id)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_consolidation_adoptions_scope_adopted ON mnemora_consolidation_adoptions(scope,adopted_at DESC);
`;
export const consolidationOptionalRestoreTables = ["mnemora_consolidation_jobs", "mnemora_consolidation_proposals", "mnemora_consolidation_adoptions"];
