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

export const recallLifecycleOptionalRestoreTables = ["mnemora_recall_usage"] as const;
