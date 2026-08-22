export function retrospectiveAuditTableSql(table = "kg_retrospective_audits"): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
  id TEXT PRIMARY KEY,
  verification_id TEXT NOT NULL REFERENCES kg_claim_verifications(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  risk_score REAL NOT NULL CHECK(risk_score>=0 AND risk_score<=1),
  risk_signals TEXT NOT NULL CHECK(length(risk_signals)<=512),
  status TEXT NOT NULL CHECK(status IN ('scheduled','running','review_required','reviewed','canceled','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0 AND attempts<=20),
  scheduled_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  error_code TEXT,
  reviewed_at INTEGER,
  UNIQUE(verification_id,policy_version)
);`;
}

/**
 * Trust-layer persistence is intentionally isolated from GraphologyStore.
 * The store's generic migration runner installs this additive schema but does
 * not own source, verification, or provider behaviour.
 */
export const trustSchemaSql = `
CREATE TABLE IF NOT EXISTS kg_trust_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO kg_trust_state(id,revision,updated_at) VALUES(1,0,0);

CREATE TABLE IF NOT EXISTS kg_source_anchors (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT,
  external_version TEXT,
  conversation_id TEXT,
  message_id TEXT,
  summary_id TEXT,
  source_label TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  snapshot_text TEXT,
  snapshot_truncated INTEGER NOT NULL DEFAULT 0 CHECK(snapshot_truncated IN (0,1)),
  span_start INTEGER,
  span_end INTEGER,
  span_encoding TEXT CHECK(span_encoding IN ('utf16-code-unit','unicode-code-point','utf8-byte')),
  source_created_at INTEGER,
  captured_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('available','missing','deleted','changed','legacy')),
  CHECK((span_start IS NULL AND span_end IS NULL AND span_encoding IS NULL) OR (span_start>=0 AND span_end>=span_start AND span_encoding IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_kg_source_anchors_scope_captured ON kg_source_anchors(scope,captured_at DESC,id);
CREATE INDEX IF NOT EXISTS idx_kg_source_anchors_external ON kg_source_anchors(scope,provider,external_id);
CREATE INDEX IF NOT EXISTS idx_kg_source_anchors_hash ON kg_source_anchors(scope,content_hash);

CREATE TABLE IF NOT EXISTS kg_external_refs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_version TEXT,
  object_type TEXT NOT NULL CHECK(object_type IN ('source','memory','message','summary','document','chunk')),
  claim_id TEXT,
  source_anchor_id TEXT REFERENCES kg_source_anchors(id) ON DELETE RESTRICT,
  content_hash TEXT CHECK(content_hash IS NULL OR length(content_hash)=64),
  status TEXT NOT NULL CHECK(status IN ('active','stale','missing','changed','detached')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE(scope,provider,external_id,object_type,claim_id,source_anchor_id)
);
CREATE INDEX IF NOT EXISTS idx_kg_external_refs_scope_provider ON kg_external_refs(scope,provider,external_id);

CREATE TABLE IF NOT EXISTS kg_claim_verifications (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  source_anchor_id TEXT NOT NULL REFERENCES kg_source_anchors(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','verified','flagged','rejected','unverifiable','contradicted','stale','superseded')),
  support_type TEXT CHECK(support_type IN ('direct','inferred','contradicted','none')),
  extraction_confidence REAL CHECK(extraction_confidence IS NULL OR (extraction_confidence>=0 AND extraction_confidence<=1)),
  verification_confidence REAL CHECK(verification_confidence IS NULL OR (verification_confidence>=0 AND verification_confidence<=1)),
  source_quality REAL CHECK(source_quality IS NULL OR (source_quality>=0 AND source_quality<=1)),
  verifier_kind TEXT NOT NULL CHECK(verifier_kind IN ('rule','model','human')),
  verifier_model TEXT,
  verifier_prompt_version TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  UNIQUE(claim_id,source_anchor_id)
);
CREATE INDEX IF NOT EXISTS idx_kg_claim_verifications_scope_status ON kg_claim_verifications(scope,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kg_claim_verifications_claim ON kg_claim_verifications(claim_id);

CREATE TABLE IF NOT EXISTS kg_verification_transitions (
  id TEXT PRIMARY KEY,
  verification_id TEXT NOT NULL REFERENCES kg_claim_verifications(id) ON DELETE RESTRICT,
  from_status TEXT NOT NULL CHECK(from_status IN ('pending','verified','flagged','rejected','unverifiable','contradicted','stale','superseded')),
  to_status TEXT NOT NULL CHECK(to_status IN ('pending','verified','flagged','rejected','unverifiable','contradicted','stale','superseded')),
  verifier_kind TEXT NOT NULL CHECK(verifier_kind IN ('rule','model','human')),
  support_type TEXT CHECK(support_type IN ('direct','inferred','contradicted','none')),
  verification_confidence REAL CHECK(verification_confidence IS NULL OR (verification_confidence>=0 AND verification_confidence<=1)),
  source_quality REAL CHECK(source_quality IS NULL OR (source_quality>=0 AND source_quality<=1)),
  reason_code TEXT NOT NULL CHECK(reason_code IN ('manual_review','direct_support','indirect_support','insufficient_source','source_changed','source_deleted','conflict')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_verification_transitions_verification ON kg_verification_transitions(verification_id,created_at DESC);

CREATE TABLE IF NOT EXISTS kg_recall_shadow_runs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  policy_version TEXT NOT NULL CHECK(policy_version IN ('adaptive-relative-v1')),
  candidate_count INTEGER NOT NULL CHECK(candidate_count>=0 AND candidate_count<=50),
  fixed_count INTEGER NOT NULL CHECK(fixed_count>=0 AND fixed_count<=50),
  adaptive_count INTEGER NOT NULL CHECK(adaptive_count>=0 AND adaptive_count<=50),
  overlap_count INTEGER NOT NULL CHECK(overlap_count>=0 AND overlap_count<=50),
  empty INTEGER NOT NULL CHECK(empty IN (0,1)),
  top_scores TEXT NOT NULL CHECK(length(top_scores)<=64),
  absolute_floor REAL NOT NULL CHECK(absolute_floor>=0 AND absolute_floor<=1),
  relative_floor REAL NOT NULL CHECK(relative_floor>=0 AND relative_floor<=1),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_recall_shadow_runs_scope_created ON kg_recall_shadow_runs(scope,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS kg_recall_calibrations (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  model_id TEXT NOT NULL CHECK(length(model_id)<=120),
  policy_version TEXT NOT NULL CHECK(policy_version IN ('adaptive-relative-v1')),
  minimum_runs INTEGER NOT NULL CHECK(minimum_runs>=1 AND minimum_runs<=10000),
  max_empty_rate REAL NOT NULL CHECK(max_empty_rate>=0 AND max_empty_rate<=1),
  min_overlap_rate REAL NOT NULL CHECK(min_overlap_rate>=0 AND min_overlap_rate<=1),
  total_runs INTEGER NOT NULL CHECK(total_runs>=0 AND total_runs<=10000),
  empty_runs INTEGER NOT NULL CHECK(empty_runs>=0 AND empty_runs<=10000),
  empty_rate REAL NOT NULL CHECK(empty_rate>=0 AND empty_rate<=1),
  mean_overlap_rate REAL NOT NULL CHECK(mean_overlap_rate>=0 AND mean_overlap_rate<=1),
  status TEXT NOT NULL CHECK(status IN ('ready','rejected')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_recall_calibrations_scope_created ON kg_recall_calibrations(scope,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS kg_recall_canaries (
  scope TEXT PRIMARY KEY,
  calibration_id TEXT NOT NULL REFERENCES kg_recall_calibrations(id) ON DELETE RESTRICT,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kg_recall_canary_runs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  calibration_id TEXT NOT NULL REFERENCES kg_recall_calibrations(id) ON DELETE RESTRICT,
  baseline_count INTEGER NOT NULL CHECK(baseline_count>=0 AND baseline_count<=50),
  adaptive_count INTEGER NOT NULL CHECK(adaptive_count>=0 AND adaptive_count<=50),
  fallback INTEGER NOT NULL CHECK(fallback IN (0,1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_recall_canary_runs_scope_created ON kg_recall_canary_runs(scope,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS kg_anchor_verification_jobs (
  id TEXT PRIMARY KEY,
  verification_id TEXT NOT NULL REFERENCES kg_claim_verifications(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('verify','retrospective_audit')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','canceled','review_required')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0 AND attempts<=20),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  verifier_model TEXT,
  prompt_version TEXT NOT NULL,
  result_code TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  lease_expires_at INTEGER,
  last_heartbeat_at INTEGER,
  retry_not_before INTEGER,
  last_retry_reason TEXT,
  UNIQUE(verification_id,kind,request_hash)
);
CREATE INDEX IF NOT EXISTS idx_kg_anchor_verification_jobs_scope_status ON kg_anchor_verification_jobs(scope,status,created_at,id);

CREATE TABLE IF NOT EXISTS kg_claim_recall_metrics (
  claim_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  recall_count INTEGER NOT NULL CHECK(recall_count>=0),
  first_recalled_at INTEGER NOT NULL,
  last_recalled_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_claim_recall_metrics_scope_count ON kg_claim_recall_metrics(scope,recall_count DESC,last_recalled_at DESC);

${retrospectiveAuditTableSql()}
CREATE INDEX IF NOT EXISTS idx_kg_retrospective_audits_scope_status ON kg_retrospective_audits(scope,status,scheduled_at DESC);
`;

/** Tables absent from historical backup artifacts are additive and empty. */
export const trustOptionalRestoreTables = ["kg_trust_state", "kg_source_anchors", "kg_external_refs", "kg_claim_verifications", "kg_verification_transitions", "kg_recall_shadow_runs", "kg_recall_calibrations", "kg_recall_canaries", "kg_recall_canary_runs", "kg_anchor_verification_jobs", "kg_claim_recall_metrics", "kg_retrospective_audits"] as const;
