export const episodeSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_episodes (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, title TEXT, summary TEXT NOT NULL, content_hash TEXT NOT NULL,
 event_start INTEGER, event_end INTEGER, recorded_at INTEGER NOT NULL, importance REAL NOT NULL, confidence REAL NOT NULL,
 status TEXT NOT NULL DEFAULT 'active', superseded_by TEXT, archived_at INTEGER, deleted_at INTEGER,
 CHECK(kind IN ('interaction','task','decision','experience','milestone','incident')),
 CHECK(status IN ('active','archived','superseded','deleted')), CHECK(importance>=0 AND importance<=1), CHECK(confidence>=0 AND confidence<=1),
 CHECK(event_start IS NULL OR event_end IS NULL OR event_start<=event_end), FOREIGN KEY(scope) REFERENCES kg_scopes(id), FOREIGN KEY(superseded_by) REFERENCES mnemora_episodes(id)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_episodes_scope_status_recorded ON mnemora_episodes(scope,status,recorded_at DESC);
CREATE TABLE IF NOT EXISTS mnemora_episode_event_edges (episode_id TEXT NOT NULL,event_id TEXT NOT NULL,scope TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(episode_id,event_id),FOREIGN KEY(episode_id) REFERENCES mnemora_episodes(id) ON DELETE CASCADE,FOREIGN KEY(event_id) REFERENCES mnemora_conversation_events(id) ON DELETE RESTRICT,FOREIGN KEY(scope) REFERENCES kg_scopes(id));
CREATE TABLE IF NOT EXISTS mnemora_episode_artifact_edges (episode_id TEXT NOT NULL,artifact_id TEXT NOT NULL,scope TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(episode_id,artifact_id),FOREIGN KEY(episode_id) REFERENCES mnemora_episodes(id) ON DELETE CASCADE,FOREIGN KEY(artifact_id) REFERENCES mnemora_artifacts(id) ON DELETE RESTRICT,FOREIGN KEY(scope) REFERENCES kg_scopes(id));
CREATE TABLE IF NOT EXISTS mnemora_episode_participants (episode_id TEXT NOT NULL,entity_id TEXT NOT NULL,scope TEXT NOT NULL,PRIMARY KEY(episode_id,entity_id),FOREIGN KEY(episode_id) REFERENCES mnemora_episodes(id) ON DELETE CASCADE,FOREIGN KEY(entity_id) REFERENCES kg_nodes(id) ON DELETE RESTRICT,FOREIGN KEY(scope) REFERENCES kg_scopes(id));
`;
