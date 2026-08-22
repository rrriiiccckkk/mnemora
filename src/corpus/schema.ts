/**
 * v60 keeps the optional canonical corpus outside graph, memory, evidence, and
 * cognition tables.  A corpus chunk is a local citation cache, never a fact.
 */
export const corpusSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_corpus_documents (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL REFERENCES kg_scopes(id),
  logical_path TEXT NOT NULL CHECK(length(logical_path) BETWEEN 1 AND 1024),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('memory','session','dreaming')),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  byte_length INTEGER NOT NULL CHECK(byte_length>=0),
  line_count INTEGER NOT NULL CHECK(line_count>=0),
  last_synced_at INTEGER NOT NULL,
  UNIQUE(scope,logical_path)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_corpus_documents_scope_kind
  ON mnemora_corpus_documents(scope,source_kind,logical_path);

CREATE TABLE IF NOT EXISTS mnemora_corpus_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES mnemora_corpus_documents(id) ON DELETE CASCADE,
  scope TEXT NOT NULL REFERENCES kg_scopes(id),
  start_line INTEGER NOT NULL CHECK(start_line>=1),
  end_line INTEGER NOT NULL CHECK(end_line>=start_line),
  content TEXT NOT NULL CHECK(length(content)<=8000),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mnemora_corpus_chunks_document
  ON mnemora_corpus_chunks(document_id,start_line);
CREATE VIRTUAL TABLE IF NOT EXISTS mnemora_corpus_chunks_fts
  USING fts5(id UNINDEXED, content, tokenize='trigram');
`;

export const corpusOptionalRestoreTables = ["mnemora_corpus_documents", "mnemora_corpus_chunks"];
