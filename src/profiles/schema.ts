/**
 * Profile selections are a small, additive user-preference layer. They never
 * replace graph edges, observations, or verification records.
 */
export const profileSchemaSql = `
CREATE TABLE IF NOT EXISTS kg_profile_selections (
  scope TEXT NOT NULL,
  subject_id TEXT NOT NULL REFERENCES kg_nodes(id) ON DELETE RESTRICT,
  field_key TEXT NOT NULL,
  target_id TEXT NOT NULL REFERENCES kg_nodes(id) ON DELETE RESTRICT,
  locked INTEGER NOT NULL DEFAULT 1 CHECK(locked IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(scope,subject_id,field_key)
);
CREATE INDEX IF NOT EXISTS idx_kg_profile_selections_subject ON kg_profile_selections(scope,subject_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS kg_profile_selection_audits (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('set','clear')),
  previous_target_id TEXT,
  target_id TEXT,
  graph_revision INTEGER NOT NULL,
  trust_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_profile_selection_audits_subject ON kg_profile_selection_audits(scope,subject_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS kg_profile_projection_snapshots (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  subject_id TEXT NOT NULL REFERENCES kg_nodes(id) ON DELETE RESTRICT,
  projection_version TEXT NOT NULL CHECK(projection_version='profile-projection-v1'),
  graph_revision INTEGER NOT NULL CHECK(graph_revision>=0),
  trust_revision INTEGER NOT NULL CHECK(trust_revision>=0),
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64),
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot) AND json_type(snapshot)='object'),
  created_at INTEGER NOT NULL,
  UNIQUE(scope,subject_id,snapshot_hash)
);
CREATE INDEX IF NOT EXISTS idx_kg_profile_projection_snapshots_subject ON kg_profile_projection_snapshots(scope,subject_id,created_at DESC,id DESC);
`;

/** Tables absent from historical backup artifacts are additive and empty. */
export const profileOptionalRestoreTables = ["kg_profile_selections", "kg_profile_selection_audits", "kg_profile_projection_snapshots"] as const;
