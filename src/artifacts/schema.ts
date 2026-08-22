export const artifactSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_artifacts (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, source_event_id TEXT, kind TEXT NOT NULL,
  mime_type TEXT NOT NULL, content BLOB NOT NULL, content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length>=0), preview TEXT NOT NULL, created_at INTEGER NOT NULL,
  archived_at INTEGER, deleted_at INTEGER,
  FOREIGN KEY(scope) REFERENCES kg_scopes(id),
  FOREIGN KEY(source_event_id) REFERENCES mnemora_conversation_events(id) ON DELETE SET NULL,
  CHECK(length(id)<=512 AND length(scope)<=80 AND length(mime_type)<=160)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_artifacts_scope_created ON mnemora_artifacts(scope,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mnemora_artifacts_source ON mnemora_artifacts(scope,source_event_id);
`;
