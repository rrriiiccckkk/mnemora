export const contextEngineSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_summary_nodes (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, session_id TEXT NOT NULL, branch_id TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 0 CHECK(level>=0), content TEXT NOT NULL, content_hash TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL CHECK(estimated_tokens>=0), injection_eligible INTEGER NOT NULL DEFAULT 0 CHECK(injection_eligible IN (0,1)),
  safety_version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, stale_at INTEGER, deleted_at INTEGER,
  FOREIGN KEY(scope) REFERENCES kg_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_summaries_session ON mnemora_summary_nodes(scope,session_id,branch_id,level,created_at DESC);
CREATE TABLE IF NOT EXISTS mnemora_summary_event_edges (
  summary_id TEXT NOT NULL, event_id TEXT NOT NULL, scope TEXT NOT NULL, ordinal INTEGER NOT NULL,
  PRIMARY KEY(summary_id,event_id),
  FOREIGN KEY(summary_id) REFERENCES mnemora_summary_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY(event_id) REFERENCES mnemora_conversation_events(id) ON DELETE RESTRICT,
  FOREIGN KEY(scope) REFERENCES kg_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_summary_event_edges_event ON mnemora_summary_event_edges(scope,event_id);
CREATE TABLE IF NOT EXISTS mnemora_summary_summary_edges (
  parent_summary_id TEXT NOT NULL, child_summary_id TEXT NOT NULL, scope TEXT NOT NULL, ordinal INTEGER NOT NULL,
  PRIMARY KEY(parent_summary_id,child_summary_id),
  CHECK(parent_summary_id<>child_summary_id),
  FOREIGN KEY(parent_summary_id) REFERENCES mnemora_summary_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY(child_summary_id) REFERENCES mnemora_summary_nodes(id) ON DELETE RESTRICT,
  FOREIGN KEY(scope) REFERENCES kg_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_summary_summary_edges_child ON mnemora_summary_summary_edges(scope,child_summary_id);
CREATE TABLE IF NOT EXISTS mnemora_compaction_runs (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, session_id TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','prepared','succeeded','failed','cancelled')),
  summary_id TEXT, selected_event_count INTEGER NOT NULL CHECK(selected_event_count>=0),
  input_chars INTEGER NOT NULL CHECK(input_chars>=0), output_chars INTEGER NOT NULL DEFAULT 0 CHECK(output_chars>=0),
  estimated_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(estimated_input_tokens>=0),
  estimated_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(estimated_output_tokens>=0),
  failure_category TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER,
  UNIQUE(scope,session_id,source_fingerprint),
  FOREIGN KEY(scope) REFERENCES kg_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_compaction_runs_scope_created ON mnemora_compaction_runs(scope,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mnemora_compaction_runs_session_status ON mnemora_compaction_runs(scope,session_id,status,updated_at DESC);
CREATE TABLE IF NOT EXISTS mnemora_runtime_safety_flags (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
  CHECK(key IN ('automatic_recall_disabled')), CHECK(value IN ('0','1'))
);
`;
