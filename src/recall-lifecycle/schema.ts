/**
 * Aggregate recall-use telemetry.  This deliberately contains no prompt,
 * document content, session ID, or provider output: a stable context ref is
 * sufficient for a bounded, operator-reviewable lifecycle signal.
 */
export const recallLifecycleSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_recall_usage (
  scope TEXT NOT NULL,
  target_ref TEXT NOT NULL CHECK(length(target_ref)<=1024),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('memory-document','belief','decision')),
  first_recalled_at INTEGER NOT NULL,
  last_recalled_at INTEGER NOT NULL,
  recall_count INTEGER NOT NULL CHECK(recall_count>=1 AND recall_count<=2147483647),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(scope,target_ref)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_recall_usage_scope_last
  ON mnemora_recall_usage(scope,last_recalled_at DESC,target_ref);
`;

/** Attachment evidence is recorded explicitly, never inferred from old usage or Journal rows. */
export const recallAttachmentSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_recall_attachment_receipts (
  scope TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id)<=80),
  payload_json TEXT NOT NULL CHECK(length(payload_json)<=131072),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(scope,id)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_recall_attachment_receipts_scope_created
  ON mnemora_recall_attachment_receipts(scope,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mnemora_recall_attachment_receipts_expires
  ON mnemora_recall_attachment_receipts(expires_at);
CREATE TABLE IF NOT EXISTS mnemora_recall_attachment_reviews (
  scope TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_version TEXT NOT NULL CHECK(length(source_version)=64),
  signal TEXT NOT NULL CHECK(signal IN ('assistant_citation','user_confirmation','user_correction')),
  review_hash TEXT NOT NULL CHECK(length(review_hash)=64),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(scope,receipt_id,target_ref,source_ref,signal),
  FOREIGN KEY(scope,receipt_id) REFERENCES mnemora_recall_attachment_receipts(scope,id) ON DELETE CASCADE
);
`;

export const recallLifecycleOptionalRestoreTables = [
  "mnemora_recall_usage",
  "mnemora_recall_attachment_receipts",
  "mnemora_recall_attachment_reviews"
] as const;
