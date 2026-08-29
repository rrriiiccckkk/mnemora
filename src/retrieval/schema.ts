/** Schema v71 stores bounded, redacted ContextEngine recall decisions. It
 * deliberately excludes prompts, candidate text, IDs, sources, and refs. */
export const unifiedRecallShadowSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_unified_recall_shadow_runs (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL,
 query_hash TEXT NOT NULL CHECK(length(query_hash)=64),
 local_candidate_count INTEGER NOT NULL CHECK(local_candidate_count>=0 AND local_candidate_count<=20),
 local_selected_count INTEGER NOT NULL CHECK(local_selected_count>=0 AND local_selected_count<=20),
 local_suppressed_count INTEGER NOT NULL CHECK(local_suppressed_count>=0 AND local_suppressed_count<=20),
 graph_candidate_count INTEGER NOT NULL CHECK(graph_candidate_count>=0 AND graph_candidate_count<=20),
 graph_attached INTEGER NOT NULL CHECK(graph_attached IN (0,1)),
 graph_suppression TEXT CHECK(graph_suppression IN ('no_anchor_terms','no_anchor_match')),
 attached INTEGER NOT NULL CHECK(attached IN (0,1)),
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mnemora_unified_recall_shadow_scope_created
  ON mnemora_unified_recall_shadow_runs(scope,created_at DESC,id DESC);
`;
