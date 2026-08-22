export const memoryLifecycleSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_memory_document_lifecycle (
  document_id TEXT PRIMARY KEY REFERENCES kg_memory_documents(id) ON DELETE CASCADE,
  -- The memory-document row is the authority for scope. Do not add a new scope
  -- foreign key here: legacy databases may retain a valid historical document
  -- before that scope has a modern scope projection.
  scope TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'working' CHECK(tier IN ('core','working','peripheral')),
  access_count INTEGER NOT NULL DEFAULT 0 CHECK(access_count>=0),
  last_accessed_at INTEGER,
  expires_at INTEGER,
  expiry_reason TEXT,
  expiry_inferred_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK(expires_at IS NULL OR expires_at>=0),
  CHECK(expiry_reason IS NULL OR length(expiry_reason)<=80)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_memory_document_lifecycle_scope_tier
  ON mnemora_memory_document_lifecycle(scope,tier,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mnemora_memory_document_lifecycle_scope_expiry
  ON mnemora_memory_document_lifecycle(scope,expires_at);
CREATE TRIGGER IF NOT EXISTS trg_mnemora_memory_document_lifecycle_insert
AFTER INSERT ON kg_memory_documents BEGIN
  INSERT OR IGNORE INTO mnemora_memory_document_lifecycle(document_id,scope,tier,access_count,updated_at)
  VALUES(NEW.id,NEW.scope,'working',0,NEW.updated_at);
END;
`;
