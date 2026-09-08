/** Schema v80 stores only opaque, short-lived first-use acceptance links.
 * It never retains an acceptance marker, prompt, candidate, event id, or
 * host session id. */
export const firstUseVerificationSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_first_use_verifications (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, marker_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('started','captured','attached','expired')),
  source_session_hash TEXT, attached_session_hash TEXT,
  started_at INTEGER NOT NULL, captured_at INTEGER, attached_at INTEGER,
  expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(scope,marker_hash),
  CHECK(length(id)<=128 AND length(scope)<=80 AND length(marker_hash)=64 AND
    (source_session_hash IS NULL OR length(source_session_hash)=64) AND
    (attached_session_hash IS NULL OR length(attached_session_hash)=64) AND
    expires_at>=started_at),
  FOREIGN KEY(scope) REFERENCES kg_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_first_use_verifications_scope_status_expiry
  ON mnemora_first_use_verifications(scope,status,expires_at DESC,started_at DESC);
`;
