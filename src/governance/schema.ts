export const governanceSchemaSql = `
CREATE TABLE IF NOT EXISTS kg_governance_principals (
  id TEXT PRIMARY KEY CHECK(length(id)>=1 AND length(id)<=120),
  kind TEXT NOT NULL CHECK(kind IN ('human','agent','system')),
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kg_governance_grants (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES kg_governance_principals(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('verification.transition','conflict.resolve','profile.selection')),
  status TEXT NOT NULL CHECK(status IN ('active','revoked','expired')),
  issued_by TEXT NOT NULL REFERENCES kg_governance_principals(id) ON DELETE RESTRICT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE(principal_id,scope,action,status)
);
CREATE INDEX IF NOT EXISTS idx_kg_governance_grants_authority ON kg_governance_grants(principal_id,scope,action,status,expires_at);

CREATE TABLE IF NOT EXISTS kg_governance_approvals (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK(action IN ('verification.transition','conflict.resolve','profile.selection')),
  scope TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  requested_by TEXT NOT NULL REFERENCES kg_governance_principals(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','consumed','expired')),
  approved_by TEXT REFERENCES kg_governance_principals(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER,
  CHECK(expires_at>=created_at),
  UNIQUE(action,scope,resource_id,request_hash,requested_by,status)
);
CREATE INDEX IF NOT EXISTS idx_kg_governance_approvals_lookup ON kg_governance_approvals(action,scope,resource_id,request_hash,status,expires_at);

CREATE TABLE IF NOT EXISTS kg_governance_events (
  id TEXT PRIMARY KEY,
  principal_id TEXT,
  action TEXT NOT NULL CHECK(action IN ('verification.transition','conflict.resolve','profile.selection')),
  scope TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('allowed','denied')),
  reason TEXT NOT NULL CHECK(reason IN ('missing_actor','unknown_actor','revoked_actor','missing_grant','approval_required','approved')),
  grant_id TEXT,
  approval_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kg_governance_events_scope_created ON kg_governance_events(scope,created_at DESC,id DESC);
`;

/** Tables absent from historical backup artifacts are additive and empty. */
export const governanceOptionalRestoreTables = ["kg_governance_principals", "kg_governance_grants", "kg_governance_approvals", "kg_governance_events"] as const;
