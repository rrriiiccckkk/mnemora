export const journalSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_conversation_events (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, session_id TEXT NOT NULL, branch_id TEXT NOT NULL,
  parent_id TEXT, sequence INTEGER NOT NULL, kind TEXT NOT NULL, role TEXT,
  context_domain TEXT NOT NULL DEFAULT 'unknown',
  identity_origin TEXT NOT NULL, host_correlation TEXT, content_hash TEXT NOT NULL,
  normalized_text TEXT, created_at INTEGER NOT NULL, deleted_at INTEGER,
  UNIQUE(scope,session_id,branch_id,sequence), UNIQUE(scope,host_correlation),
  CHECK(kind IN ('user_message','assistant_message','tool_call','tool_result','system_marker','compaction_marker')),
  CHECK(role IS NULL OR role IN ('user','assistant','tool','system')),
  CHECK(context_domain IN ('user_chat','system','tool','background','unknown')),
  CHECK(identity_origin IN ('host','derived','local_receipt')),
  CHECK(length(id)<=512 AND length(scope)<=80 AND length(session_id)<=512 AND length(branch_id)<=512),
  FOREIGN KEY(scope) REFERENCES kg_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_events_scope_session_sequence ON mnemora_conversation_events(scope,session_id,branch_id,sequence);
CREATE INDEX IF NOT EXISTS idx_mnemora_events_scope_created ON mnemora_conversation_events(scope,created_at DESC);
CREATE TABLE IF NOT EXISTS mnemora_conversation_parts (
  event_id TEXT NOT NULL, scope TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL,
  payload TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(event_id,ordinal),
  CHECK(kind IN ('text','image_ref','attachment_ref','context_ref','artifact_ref','tool_call','tool_result')),
  CHECK(json_valid(payload) AND length(payload)<=262144),
  FOREIGN KEY(event_id) REFERENCES mnemora_conversation_events(id) ON DELETE CASCADE,
  FOREIGN KEY(scope) REFERENCES kg_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_parts_scope_event ON mnemora_conversation_parts(scope,event_id,ordinal);
CREATE TABLE IF NOT EXISTS mnemora_capture_receipts (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, correlation_key TEXT NOT NULL, event_id TEXT,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, committed_at INTEGER,
  UNIQUE(scope,correlation_key), CHECK(status IN ('accepted','committed','failed')),
  FOREIGN KEY(event_id) REFERENCES mnemora_conversation_events(id), FOREIGN KEY(scope) REFERENCES kg_scopes(id)
);
CREATE TABLE IF NOT EXISTS mnemora_commits (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, receipt_id TEXT NOT NULL, status TEXT NOT NULL,
  event_count INTEGER NOT NULL, content_hash TEXT NOT NULL, created_at INTEGER NOT NULL, committed_at INTEGER,
  UNIQUE(scope,receipt_id), CHECK(status IN ('pending','committed','failed')), CHECK(event_count>=0),
  FOREIGN KEY(receipt_id) REFERENCES mnemora_capture_receipts(id), FOREIGN KEY(scope) REFERENCES kg_scopes(id)
);
CREATE TABLE IF NOT EXISTS mnemora_derived_tasks (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, commit_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_at INTEGER, deadline_at INTEGER,
  error_category TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK(status IN ('pending','running','succeeded','failed','cancelled')), CHECK(attempts>=0),
  FOREIGN KEY(commit_id) REFERENCES mnemora_commits(id), FOREIGN KEY(scope) REFERENCES kg_scopes(id)
);
CREATE TABLE IF NOT EXISTS mnemora_change_sets (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, status TEXT NOT NULL, content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, committed_at INTEGER, CHECK(status IN ('open','committed','rejected')),
  FOREIGN KEY(scope) REFERENCES kg_scopes(id)
);
CREATE TABLE IF NOT EXISTS mnemora_change_set_entries (
  change_set_id TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL, payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY(change_set_id,ordinal),
  FOREIGN KEY(change_set_id) REFERENCES mnemora_change_sets(id) ON DELETE CASCADE
);
-- v5.1: a completed host turn has one durable receipt and commit. Event rows
-- remain independently addressable, while this link makes a retry/restart
-- observable and atomically recoverable without interpreting host internals.
CREATE TABLE IF NOT EXISTS mnemora_turn_receipt_events (
  receipt_id TEXT NOT NULL, event_id TEXT NOT NULL, scope TEXT NOT NULL, ordinal INTEGER NOT NULL,
  PRIMARY KEY(receipt_id,ordinal), UNIQUE(receipt_id,event_id),
  FOREIGN KEY(receipt_id) REFERENCES mnemora_capture_receipts(id) ON DELETE CASCADE,
  FOREIGN KEY(event_id) REFERENCES mnemora_conversation_events(id) ON DELETE CASCADE,
  FOREIGN KEY(scope) REFERENCES kg_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_turn_receipt_events_scope_event ON mnemora_turn_receipt_events(scope,event_id);
-- Durable accounting for exact-correlation replays. It retains no message
-- content and lets the capture path distinguish host from local-origin floods.
CREATE TABLE IF NOT EXISTS mnemora_replay_flood_guards (
  scope TEXT NOT NULL, session_id TEXT NOT NULL, correlation_key TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('external','internal')), delivery_count INTEGER NOT NULL DEFAULT 0 CHECK(delivery_count>=0),
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, suppressed_at INTEGER,
  PRIMARY KEY(scope,session_id,correlation_key,origin),
  FOREIGN KEY(scope) REFERENCES kg_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_replay_flood_guards_scope_session_seen ON mnemora_replay_flood_guards(scope,session_id,last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_mnemora_replay_flood_guards_scope_seen ON mnemora_replay_flood_guards(scope,last_seen_at ASC);
-- Opaque host entry identifiers are only used with the public
-- rewriteTranscriptEntries contract during Mnemora-owned compaction.
CREATE TABLE IF NOT EXISTS mnemora_host_message_links (
  event_id TEXT PRIMARY KEY, scope TEXT NOT NULL, entry_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  CHECK(length(entry_id)<=512),
  FOREIGN KEY(event_id) REFERENCES mnemora_conversation_events(id) ON DELETE CASCADE,
  FOREIGN KEY(scope) REFERENCES kg_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_host_message_links_scope_entry ON mnemora_host_message_links(scope,entry_id);
CREATE INDEX IF NOT EXISTS idx_mnemora_derived_tasks_recovery ON mnemora_derived_tasks(scope,status,lease_expires_at,created_at);
-- Public-provider migration state deliberately contains references and hashes
-- only. Provider content is never copied into migration metadata.
CREATE TABLE IF NOT EXISTS mnemora_provider_migration_runs (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('lossless-claw','memory-lancedb-pro')),
  scope TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('previewed','running','completed','completed_with_failures','rollback_requires_restore')),
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(request_json)<=8192),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER,
  UNIQUE(provider,scope,id), FOREIGN KEY(scope) REFERENCES kg_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_provider_migration_runs_scope ON mnemora_provider_migration_runs(provider,scope,updated_at DESC);
CREATE TABLE IF NOT EXISTS mnemora_provider_migration_items (
  run_id TEXT NOT NULL, ordinal INTEGER NOT NULL, external_id TEXT NOT NULL, source_ref_json TEXT NOT NULL CHECK(json_valid(source_ref_json) AND length(source_ref_json)<=2048),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64), metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json) AND length(metadata_json)<=8192), status TEXT NOT NULL CHECK(status IN ('pending','imported','skipped_duplicate','failed','source_changed')),
  error_code TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY(run_id,ordinal), UNIQUE(run_id,external_id), FOREIGN KEY(run_id) REFERENCES mnemora_provider_migration_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mnemora_provider_migration_items_run_status ON mnemora_provider_migration_items(run_id,status,ordinal);
`;
