import { trustSchemaSql } from "./trust/schema.js";
import { integrationSchemaSql } from "./integrations/schema.js";
import { profileSchemaSql } from "./profiles/schema.js";
import { governanceSchemaSql } from "./governance/schema.js";
import { memoryLifecycleSchemaSql } from "./memory-lifecycle/schema.js";

export const schemaSql = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS kg_graph_state (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO kg_graph_state(key,value,updated_at)
VALUES('content_revision',0,0);

CREATE TABLE IF NOT EXISTS kg_source_trust_state (
  id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO kg_source_trust_state(id,revision,updated_at) VALUES(1,0,0);

CREATE TABLE IF NOT EXISTS kg_source_trust (
  source TEXT PRIMARY KEY, weight REAL NOT NULL CHECK(weight>=0 AND weight<=2), updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kg_source_trust_audits (
  id TEXT PRIMARY KEY, source_hash TEXT NOT NULL, previous_weight REAL NOT NULL,
  new_weight REAL NOT NULL, graph_revision INTEGER NOT NULL, config_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kg_scopes (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kg_insight_snapshots (
  cache_key TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'default',
  graph_revision INTEGER NOT NULL,
  algorithm_version TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kg_query_runs (
  id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL, normalized_plan TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL CHECK(status IN ('succeeded','failed','truncated')),
  graph_revision INTEGER NOT NULL, result_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0, error_category TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_query_runs_created ON kg_query_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS kg_watches (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_plan TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'default',
  plan_hash TEXT NOT NULL, schedule_hint TEXT NOT NULL,
  cursor TEXT, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kg_digest_runs (
  idempotency_key TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
  scope TEXT NOT NULL DEFAULT 'default',
  watch_ids TEXT NOT NULL, cursor_updates TEXT NOT NULL DEFAULT '{}', summary TEXT,
  started_at INTEGER NOT NULL, finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS kg_import_previews (
  preview_hash TEXT PRIMARY KEY, graph_revision INTEGER NOT NULL,
  summary TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kg_nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  aliases TEXT NOT NULL DEFAULT '[]',
  embedding BLOB,
  importance REAL NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(type IN ('person','company','product','technology','concept','industry','fund','policy','portfolio')),
  CHECK(json_valid(aliases) AND json_type(aliases)='array'),
  CHECK(importance>=0 AND importance<=1)
);

CREATE TABLE IF NOT EXISTS kg_edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES kg_nodes(id),
  target_id TEXT NOT NULL REFERENCES kg_nodes(id),
  type TEXT NOT NULL,
  edge_props TEXT NOT NULL DEFAULT '{}',
  weight REAL NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(source_id, target_id, type),
  CHECK(type IN ('works_at','invested_in','supplies','supplies_product','supplied_to','competes_with','uses','develops','owns','partners_with','in_portfolio','depends_on','part_of','instance_of','related_to')),
  CHECK(json_valid(edge_props) AND json_type(edge_props)='object'),
  CHECK(weight>=0 AND weight<=1)
);

CREATE TABLE IF NOT EXISTS kg_observations (
  id TEXT PRIMARY KEY,
  edge_id TEXT REFERENCES kg_edges(id),
  source_entity_id TEXT REFERENCES kg_nodes(id),
  payload TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'default',
  quote TEXT NOT NULL,
  confidence REAL NOT NULL,
  valid_from INTEGER,
  valid_to INTEGER,
  temporal_confidence REAL,
  created_at INTEGER NOT NULL,
  CHECK((edge_id IS NOT NULL AND source_entity_id IS NULL) OR (edge_id IS NULL AND source_entity_id IS NOT NULL)),
  CHECK(json_valid(payload) AND json_type(payload)='object'),
  CHECK(confidence>=0 AND confidence<=1),
  CHECK(temporal_confidence IS NULL OR (temporal_confidence>=0 AND temporal_confidence<=1)),
  CHECK(valid_from IS NULL OR valid_to IS NULL OR valid_from<=valid_to)
);

CREATE VIRTUAL TABLE IF NOT EXISTS kg_nodes_fts USING fts5(
  id UNINDEXED,
  name,
  description,
  aliases,
  tokenize = 'trigram'
);

CREATE INDEX IF NOT EXISTS idx_kg_nodes_type ON kg_nodes(type);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_deleted_at ON kg_nodes(deleted_at);
CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(target_id);
CREATE INDEX IF NOT EXISTS idx_kg_edges_type ON kg_edges(type);
CREATE INDEX IF NOT EXISTS idx_kg_edges_deleted_at ON kg_edges(deleted_at);
CREATE INDEX IF NOT EXISTS idx_kg_observations_edge ON kg_observations(edge_id);
CREATE INDEX IF NOT EXISTS idx_kg_observations_source_entity ON kg_observations(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_kg_observations_source ON kg_observations(source);

CREATE TABLE IF NOT EXISTS kg_memory_documents (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle_state IN ('active','archived')),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Normalized identities are owned by EntityRepository and maintained by
-- triggers. They replace every-active-node alias scans on write paths.
CREATE TABLE IF NOT EXISTS kg_entity_identities (
  node_id TEXT NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  value_normalized TEXT NOT NULL,
  value_display TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('name','alias')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(node_id,value_normalized)
);
CREATE INDEX IF NOT EXISTS idx_kg_entity_identities_lookup ON kg_entity_identities(type,value_normalized,node_id);

CREATE TRIGGER IF NOT EXISTS trg_kg_entity_identities_insert
AFTER INSERT ON kg_nodes BEGIN
  INSERT OR IGNORE INTO kg_entity_identities(node_id,type,value_normalized,value_display,kind,created_at,updated_at)
    SELECT NEW.id,NEW.type,lower(trim(NEW.name)),NEW.name,'name',NEW.created_at,NEW.updated_at
    WHERE typeof(NEW.name)='text' AND length(trim(NEW.name))>0;
  INSERT OR IGNORE INTO kg_entity_identities(node_id,type,value_normalized,value_display,kind,created_at,updated_at)
    SELECT NEW.id,NEW.type,lower(trim(CAST(value AS TEXT))),CAST(value AS TEXT),'alias',NEW.created_at,NEW.updated_at
    FROM json_each(CASE WHEN json_valid(NEW.aliases) THEN NEW.aliases ELSE '[]' END)
    WHERE typeof(value)='text' AND length(trim(CAST(value AS TEXT)))>0;
END;
CREATE TRIGGER IF NOT EXISTS trg_kg_entity_identities_update
AFTER UPDATE OF id,type,name,aliases ON kg_nodes BEGIN
  DELETE FROM kg_entity_identities WHERE node_id=OLD.id;
  INSERT OR IGNORE INTO kg_entity_identities(node_id,type,value_normalized,value_display,kind,created_at,updated_at)
    SELECT NEW.id,NEW.type,lower(trim(NEW.name)),NEW.name,'name',NEW.created_at,NEW.updated_at
    WHERE typeof(NEW.name)='text' AND length(trim(NEW.name))>0;
  INSERT OR IGNORE INTO kg_entity_identities(node_id,type,value_normalized,value_display,kind,created_at,updated_at)
    SELECT NEW.id,NEW.type,lower(trim(CAST(value AS TEXT))),CAST(value AS TEXT),'alias',NEW.created_at,NEW.updated_at
    FROM json_each(CASE WHEN json_valid(NEW.aliases) THEN NEW.aliases ELSE '[]' END)
    WHERE typeof(value)='text' AND length(trim(CAST(value AS TEXT)))>0;
END;
CREATE INDEX IF NOT EXISTS idx_kg_memory_documents_scope_updated ON kg_memory_documents(scope, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_kg_memory_documents_scope_hash ON kg_memory_documents(scope, content_hash);
CREATE VIRTUAL TABLE IF NOT EXISTS kg_memory_documents_fts USING fts5(
  id UNINDEXED,
  title,
  content,
  tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS kg_memory_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES kg_memory_documents(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding BLOB,
  embedding_provider TEXT,
  embedding_model TEXT,
  embedding_dimensions INTEGER,
  embedding_input_version TEXT,
  embedded_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(document_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_kg_memory_chunks_scope_document ON kg_memory_chunks(scope, document_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_kg_memory_chunks_embedding ON kg_memory_chunks(embedding_provider, embedding_model, embedding_dimensions, embedding_input_version);
CREATE VIRTUAL TABLE IF NOT EXISTS kg_memory_chunks_fts USING fts5(
  id UNINDEXED,
  content,
  tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS kg_memory_lifecycle_audits (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('archive','recover','delete')),
  from_state TEXT NOT NULL CHECK(from_state IN ('active','archived')),
  to_state TEXT NOT NULL CHECK(to_state IN ('active','archived','deleted')),
  content_hash TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  document_updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_memory_lifecycle_audits_scope_created ON kg_memory_lifecycle_audits(scope, created_at DESC);

CREATE TABLE IF NOT EXISTS kg_memory_import_previews (
  preview_hash TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_updated_at INTEGER NOT NULL,
  summary TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kg_memory_import_audits (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  imported_count INTEGER NOT NULL,
  archived_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_memory_import_audits_scope_created ON kg_memory_import_audits(scope, created_at DESC);

${memoryLifecycleSchemaSql}

CREATE TABLE IF NOT EXISTS kg_auto_runs (
  turn_key TEXT PRIMARY KEY,
  feature TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kg_auto_runs_status ON kg_auto_runs(status, started_at);

CREATE TABLE IF NOT EXISTS kg_auto_metrics (
  day INTEGER NOT NULL, feature TEXT NOT NULL CHECK(feature IN ('extract','recall')),
  outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','failed')), count INTEGER NOT NULL CHECK(count>=0),
  PRIMARY KEY(day,feature,outcome)
);

CREATE TABLE IF NOT EXISTS kg_duplicate_candidates (
  id TEXT PRIMARY KEY,
  pair_key TEXT NOT NULL UNIQUE,
  entity_a TEXT NOT NULL REFERENCES kg_nodes(id),
  entity_b TEXT NOT NULL REFERENCES kg_nodes(id),
  signals TEXT NOT NULL DEFAULT '[]',
  reasons TEXT NOT NULL DEFAULT '[]',
  score REAL NOT NULL,
  fingerprint_a TEXT NOT NULL,
  fingerprint_b TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','ignored','rejected','merged')),
  discovered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kg_duplicate_candidates_status ON kg_duplicate_candidates(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_kg_duplicate_candidates_entities ON kg_duplicate_candidates(entity_a, entity_b);

CREATE TABLE IF NOT EXISTS kg_conflict_candidates (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'default',
  pair_key TEXT NOT NULL UNIQUE,
  edge_a TEXT NOT NULL,
  edge_b TEXT NOT NULL,
  observation_a TEXT NOT NULL,
  observation_b TEXT NOT NULL,
  category TEXT NOT NULL,
  overlap_from INTEGER,
  overlap_to INTEGER,
  confidence_a REAL NOT NULL,
  confidence_b REAL NOT NULL,
  source_count_a INTEGER NOT NULL,
  source_count_b INTEGER NOT NULL,
  fingerprint_a TEXT NOT NULL,
  fingerprint_b TEXT NOT NULL,
  preview_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','ignored','rejected','invalid')),
  discovered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kg_conflict_candidates_status ON kg_conflict_candidates(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_kg_conflict_candidates_edges ON kg_conflict_candidates(edge_a, edge_b);

CREATE TABLE IF NOT EXISTS kg_maintenance_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kg_quality_audits (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kg_merge_audits (
  id TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL,
  duplicate_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('merged','undone')),
  snapshot_version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  preview_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  undone_at INTEGER
);

CREATE TABLE IF NOT EXISTS kg_entity_redirects (
  retired_id TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL REFERENCES kg_nodes(id),
  audit_id TEXT NOT NULL REFERENCES kg_merge_audits(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_entity_redirects_canonical ON kg_entity_redirects(canonical_id);

CREATE TABLE IF NOT EXISTS kg_ingestion_records (
  fingerprint TEXT PRIMARY KEY,
  input_fingerprint TEXT NOT NULL,
  fingerprint_version TEXT NOT NULL,
  source TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL CHECK(status IN ('completed')),
  error_category TEXT,
  error_summary TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_ingestion_records_source ON kg_ingestion_records(source, completed_at);
${trustSchemaSql}
${integrationSchemaSql}
${profileSchemaSql}
${governanceSchemaSql}
CREATE TABLE IF NOT EXISTS kg_schema_quarantine (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  record_json TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
  quarantined_at INTEGER NOT NULL,
  UNIQUE(schema_version,table_name,row_id,reason)
);
CREATE INDEX IF NOT EXISTS idx_kg_schema_quarantine_version ON kg_schema_quarantine(schema_version,table_name,quarantined_at DESC);
`;

/** Re-installed after a core-table rebuild because DROP TABLE removes triggers. */
export const entityIdentityTriggerSql = `
CREATE TRIGGER IF NOT EXISTS trg_kg_entity_identities_insert
AFTER INSERT ON kg_nodes BEGIN
  INSERT OR IGNORE INTO kg_entity_identities(node_id,type,value_normalized,value_display,kind,created_at,updated_at)
    SELECT NEW.id,NEW.type,lower(trim(NEW.name)),NEW.name,'name',NEW.created_at,NEW.updated_at
    WHERE typeof(NEW.name)='text' AND length(trim(NEW.name))>0;
  INSERT OR IGNORE INTO kg_entity_identities(node_id,type,value_normalized,value_display,kind,created_at,updated_at)
    SELECT NEW.id,NEW.type,lower(trim(CAST(value AS TEXT))),CAST(value AS TEXT),'alias',NEW.created_at,NEW.updated_at
    FROM json_each(CASE WHEN json_valid(NEW.aliases) THEN NEW.aliases ELSE '[]' END)
    WHERE typeof(value)='text' AND length(trim(CAST(value AS TEXT)))>0;
END;
CREATE TRIGGER IF NOT EXISTS trg_kg_entity_identities_update
AFTER UPDATE OF id,type,name,aliases ON kg_nodes BEGIN
  DELETE FROM kg_entity_identities WHERE node_id=OLD.id;
  INSERT OR IGNORE INTO kg_entity_identities(node_id,type,value_normalized,value_display,kind,created_at,updated_at)
    SELECT NEW.id,NEW.type,lower(trim(NEW.name)),NEW.name,'name',NEW.created_at,NEW.updated_at
    WHERE typeof(NEW.name)='text' AND length(trim(NEW.name))>0;
  INSERT OR IGNORE INTO kg_entity_identities(node_id,type,value_normalized,value_display,kind,created_at,updated_at)
    SELECT NEW.id,NEW.type,lower(trim(CAST(value AS TEXT))),CAST(value AS TEXT),'alias',NEW.created_at,NEW.updated_at
    FROM json_each(CASE WHEN json_valid(NEW.aliases) THEN NEW.aliases ELSE '[]' END)
    WHERE typeof(value)='text' AND length(trim(CAST(value AS TEXT)))>0;
END;
`;

export const coreTablesV21Sql = `
CREATE TABLE kg_nodes_v21 (
  id TEXT PRIMARY KEY,type TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',aliases TEXT NOT NULL DEFAULT '[]',
  embedding BLOB,importance REAL NOT NULL DEFAULT 0,deleted_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
  embedding_provider TEXT,embedding_model TEXT,embedding_dimensions INTEGER,embedding_input_version TEXT,embedded_at INTEGER,
  CHECK(type IN ('person','company','product','technology','concept','industry','fund','policy','portfolio')),
  CHECK(json_valid(aliases) AND json_type(aliases)='array'),CHECK(importance>=0 AND importance<=1)
);
CREATE TABLE kg_edges_v21 (
  id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES kg_nodes(id),target_id TEXT NOT NULL REFERENCES kg_nodes(id),type TEXT NOT NULL,
  edge_props TEXT NOT NULL DEFAULT '{}',weight REAL NOT NULL DEFAULT 0,deleted_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
  UNIQUE(source_id,target_id,type),
  CHECK(type IN ('works_at','invested_in','supplies','supplies_product','supplied_to','competes_with','uses','develops','owns','partners_with','in_portfolio','depends_on','part_of','instance_of','related_to')),
  CHECK(json_valid(edge_props) AND json_type(edge_props)='object'),CHECK(weight>=0 AND weight<=1)
);
CREATE TABLE kg_observations_v21 (
  id TEXT PRIMARY KEY,edge_id TEXT REFERENCES kg_edges(id),source_entity_id TEXT REFERENCES kg_nodes(id),payload TEXT NOT NULL DEFAULT '{}',source TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'default',quote TEXT NOT NULL,confidence REAL NOT NULL,valid_from INTEGER,valid_to INTEGER,temporal_confidence REAL,created_at INTEGER NOT NULL,
  CHECK((edge_id IS NOT NULL AND source_entity_id IS NULL) OR (edge_id IS NULL AND source_entity_id IS NOT NULL)),
  CHECK(json_valid(payload) AND json_type(payload)='object'),CHECK(confidence>=0 AND confidence<=1),
  CHECK(temporal_confidence IS NULL OR (temporal_confidence>=0 AND temporal_confidence<=1)),CHECK(valid_from IS NULL OR valid_to IS NULL OR valid_from<=valid_to)
);
`;

export const SUPPORTED_SCHEMA_VERSION = 65;

export function edgeWeight(observationCount: number, averageConfidence: number): number {
  return Math.min(1, (observationCount * averageConfidence) / 5);
}

export function nodeImportance(entityObservationCount: number, averageConfidence = 0, sourceCount = 0, degree = 0): number {
  // Observation volume alone made repeated low-value auto-extraction look
  // maximally important. Evidence quality, independent sources, and graph
  // connectivity now contribute separately, with no one signal able to hit 1.
  const observations = Math.min(.35, Math.max(0, entityObservationCount) * .07);
  const confidence = Math.min(.35, Math.max(0, Math.min(1, averageConfidence)) * .35);
  const sources = Math.min(.20, Math.max(0, sourceCount) * .10);
  const connections = Math.min(.10, Math.max(0, degree) * .025);
  return Math.round(Math.min(1, observations + confidence + sources + connections) * 1_000_000) / 1_000_000;
}
