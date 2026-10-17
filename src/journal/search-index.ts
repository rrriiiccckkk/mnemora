import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { chunkText, contentTerms, ftsMatchExpression, indexText } from "../retrieval/lexical.js";

export interface RankedJournalHit {
  eventId: string;
  /** bm25 relevance relative to the best hit of this query, in (0,1]. */
  relevance: number;
  /** Raw positive bm25 score (higher is better). */
  bm25: number;
  start: number;
  end: number;
}

/** Index one event's searchable text. Callers own the transaction. */
export function indexJournalEvent(db: DatabaseSyncInstance, eventId: string, scope: string, text: string | undefined | null): void {
  if (!text) return;
  const insertChunk = db.prepare("INSERT INTO mnemora_conversation_event_chunks(event_id,scope,ordinal,start_offset,end_offset) VALUES(?,?,?,?,?)");
  const insertFts = db.prepare("INSERT INTO mnemora_conversation_event_chunks_fts(rowid,content) VALUES(?,?)");
  for (const chunk of chunkText(text)) {
    const content = indexText(chunk.text);
    if (!content) continue;
    const result = insertChunk.run(eventId, scope, chunk.ordinal, chunk.start, chunk.end);
    insertFts.run(Number(result.lastInsertRowid), content);
  }
}

/** Rebuild the derived index for every live event (schema v86 migration). */
export function rebuildJournalSearchIndex(db: DatabaseSyncInstance): number {
  db.exec("DELETE FROM mnemora_conversation_event_chunks");
  db.exec("DELETE FROM mnemora_conversation_event_chunks_fts");
  const rows = db.prepare("SELECT id, scope, normalized_text FROM mnemora_conversation_events WHERE deleted_at IS NULL AND normalized_text IS NOT NULL").all() as Array<{ id: string; scope: string; normalized_text: string }>;
  for (const row of rows) indexJournalEvent(db, row.id, row.scope, row.normalized_text);
  return rows.length;
}

/**
 * Inverse document frequency of each term over the journal chunk index, using
 * the same smoothed formula as bm25. Counts are corpus-wide aggregates (never
 * content) and capped, so a very common term costs one bounded index scan.
 */
export function journalTermWeights(db: DatabaseSyncInstance, terms: readonly string[]): Map<string, number> {
  const weights = new Map<string, number>();
  if (!terms.length) return weights;
  try {
    const total = Number((db.prepare("SELECT count(*) AS n FROM mnemora_conversation_event_chunks").get() as { n: number }).n);
    if (!(total > 0)) return weights;
    const count = db.prepare("SELECT count(*) AS n FROM (SELECT 1 FROM mnemora_conversation_event_chunks_fts WHERE mnemora_conversation_event_chunks_fts MATCH ? LIMIT 20000)");
    for (const term of terms) {
      const match = ftsMatchExpression([term]);
      if (!match) continue;
      const frequency = Number((count.get(match) as { n: number }).n);
      weights.set(term, Math.log((total - frequency + .5) / (frequency + .5) + 1));
    }
  } catch { return new Map(); }
  return weights;
}

/**
 * bm25-ranked journal search over content-bearing terms. One row per event
 * (its best chunk), best first. Returns [] when the query has no content terms.
 */
export function searchJournalRanked(db: DatabaseSyncInstance, input: { scope: string; query: string; limit: number; recordedBefore?: number; terms?: readonly string[] }): RankedJournalHit[] {
  const terms = input.terms?.length ? [...input.terms] : contentTerms(input.query);
  const match = ftsMatchExpression(terms);
  if (!match) return [];
  const take = Math.min(200, Math.max(1, Math.trunc(input.limit)));
  const cutoff = input.recordedBefore === undefined ? "" : " AND e.created_at<=?";
  let rows: Array<{ event_id: string; start_offset: number; end_offset: number; rank: number }>;
  try {
    rows = db.prepare(`SELECT c.event_id, c.start_offset, c.end_offset, bm25(mnemora_conversation_event_chunks_fts) AS rank
      FROM mnemora_conversation_event_chunks_fts
      JOIN mnemora_conversation_event_chunks c ON c.id=mnemora_conversation_event_chunks_fts.rowid
      JOIN mnemora_conversation_events e ON e.id=c.event_id
      WHERE mnemora_conversation_event_chunks_fts MATCH ? AND c.scope=? AND e.scope=? AND e.deleted_at IS NULL${cutoff}
      ORDER BY rank LIMIT ?`).all(match, input.scope, input.scope, ...(input.recordedBefore === undefined ? [] : [input.recordedBefore]), take * 3) as typeof rows;
  } catch { return []; }
  const best = new Map<string, RankedJournalHit>();
  for (const row of rows) {
    const score = -Number(row.rank);
    if (!Number.isFinite(score) || score <= 0 || best.has(row.event_id)) continue;
    best.set(row.event_id, { eventId: row.event_id, relevance: 0, bm25: score, start: row.start_offset, end: row.end_offset });
  }
  const hits = [...best.values()].slice(0, take);
  const top = hits[0]?.bm25 ?? 0;
  for (const hit of hits) hit.relevance = top > 0 ? Math.min(1, hit.bm25 / top) : 0;
  return hits;
}

/** Input format of journal chunk vectors; bump to re-embed after a change. */
export const JOURNAL_CHUNK_EMBEDDING_INPUT_VERSION = "journal-chunk-v1";

export interface JournalEmbeddingIdentity { provider: string; model: string; dimensions: number }
export interface PendingJournalChunk { chunkId: number; scope: string; text: string }
export interface SemanticJournalHit { eventId: string; similarity: number; start: number; end: number }

/**
 * Live chunks without a vector for this identity, newest first so recent
 * history becomes semantically searchable before an old backlog.
 */
export function pendingJournalChunks(db: DatabaseSyncInstance, identity: Pick<JournalEmbeddingIdentity, "provider" | "model">, limit: number, scope?: string): PendingJournalChunk[] {
  const bounded = Math.max(1, Math.min(1000, Math.trunc(limit)));
  const rows = db.prepare(`SELECT c.id AS chunk_id, c.scope, c.start_offset, c.end_offset, e.normalized_text
    FROM mnemora_conversation_event_chunks c JOIN mnemora_conversation_events e ON e.id=c.event_id
    LEFT JOIN mnemora_conversation_event_chunks_embeddings v ON v.chunk_id=c.id AND v.provider=? AND v.model=? AND v.input_version=?
    WHERE v.chunk_id IS NULL AND e.deleted_at IS NULL AND e.normalized_text IS NOT NULL ${scope === undefined ? "" : "AND c.scope=?"}
    ORDER BY c.id DESC LIMIT ?`).all(...[identity.provider, identity.model, JOURNAL_CHUNK_EMBEDDING_INPUT_VERSION, ...(scope === undefined ? [] : [scope]), bounded]) as Array<{ chunk_id: number; scope: string; start_offset: number; end_offset: number; normalized_text: string }>;
  return rows.map(row => ({ chunkId: Number(row.chunk_id), scope: row.scope, text: row.normalized_text.slice(row.start_offset, row.end_offset) }));
}

export function putJournalChunkEmbedding(db: DatabaseSyncInstance, chunk: Pick<PendingJournalChunk, "chunkId" | "scope">, identity: JournalEmbeddingIdentity, vector: readonly number[], embeddedAt = Date.now()): void {
  if (vector.length !== identity.dimensions) throw new Error("embedding dimensions do not match identity");
  const encoded = new Uint8Array(new Float32Array(vector).buffer);
  // The chunk may have been purged while its vector was being computed.
  db.prepare(`INSERT INTO mnemora_conversation_event_chunks_embeddings(chunk_id,scope,provider,model,dimensions,input_version,embedding,embedded_at)
    SELECT id,?,?,?,?,?,?,? FROM mnemora_conversation_event_chunks WHERE id=? AND scope=?
    ON CONFLICT(chunk_id) DO UPDATE SET provider=excluded.provider, model=excluded.model, dimensions=excluded.dimensions, input_version=excluded.input_version, embedding=excluded.embedding, embedded_at=excluded.embedded_at`)
    .run(chunk.scope, identity.provider, identity.model, identity.dimensions, JOURNAL_CHUNK_EMBEDDING_INPUT_VERSION, encoded, embeddedAt, chunk.chunkId, chunk.scope);
}

export function journalEmbeddingCoverage(db: DatabaseSyncInstance, identity: JournalEmbeddingIdentity, scope?: string): { chunks: number; embedded: number } {
  const where = scope === undefined ? "" : " WHERE scope=?";
  const chunks = Number((db.prepare(`SELECT count(*) AS n FROM mnemora_conversation_event_chunks${where}`).get(...(scope === undefined ? [] : [scope])) as { n: number }).n);
  const embedded = Number((db.prepare(`SELECT count(*) AS n FROM mnemora_conversation_event_chunks_embeddings WHERE provider=? AND model=? AND dimensions=? AND input_version=?${scope === undefined ? "" : " AND scope=?"}`)
    .get(...[identity.provider, identity.model, identity.dimensions, JOURNAL_CHUNK_EMBEDDING_INPUT_VERSION, ...(scope === undefined ? [] : [scope])]) as { n: number }).n);
  return { chunks, embedded };
}

/**
 * Exact cosine search over the newest `maxScan` vectors of one scope. The
 * query vector must be unit-length; stored vectors are normalised on read.
 * Returns the best chunk per event, highest similarity first.
 */
export function searchJournalSemantic(db: DatabaseSyncInstance, input: { scope: string; identity: JournalEmbeddingIdentity; vector: readonly number[]; limit: number; maxScan: number; minSimilarity: number }): SemanticJournalHit[] {
  if (input.vector.length !== input.identity.dimensions) return [];
  const rows = db.prepare(`SELECT c.event_id, c.start_offset, c.end_offset, v.embedding
    FROM mnemora_conversation_event_chunks_embeddings v JOIN mnemora_conversation_event_chunks c ON c.id=v.chunk_id
    JOIN mnemora_conversation_events e ON e.id=c.event_id
    WHERE v.scope=? AND v.provider=? AND v.model=? AND v.dimensions=? AND v.input_version=? AND e.deleted_at IS NULL
    ORDER BY v.chunk_id DESC LIMIT ?`).all(input.scope, input.identity.provider, input.identity.model, input.identity.dimensions, JOURNAL_CHUNK_EMBEDDING_INPUT_VERSION, Math.max(1, Math.trunc(input.maxScan))) as Array<{ event_id: string; start_offset: number; end_offset: number; embedding: Uint8Array }>;
  const best = new Map<string, SemanticJournalHit>();
  const dims = input.identity.dimensions;
  for (const row of rows) {
    const bytes = row.embedding;
    if (bytes.byteLength !== dims * 4) continue;
    const vector = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    let dot = 0, norm = 0;
    for (let index = 0; index < dims; index++) { dot += vector[index] * input.vector[index]; norm += vector[index] * vector[index]; }
    const similarity = norm > 0 ? dot / Math.sqrt(norm) : 0;
    if (!(similarity >= input.minSimilarity)) continue;
    const previous = best.get(row.event_id);
    if (!previous || similarity > previous.similarity) best.set(row.event_id, { eventId: row.event_id, similarity, start: row.start_offset, end: row.end_offset });
  }
  return [...best.values()].sort((left, right) => right.similarity - left.similarity).slice(0, Math.max(1, Math.trunc(input.limit)));
}

/** Whether any chunk of this event has a vector for the identity. */
export function journalEventEmbedded(db: DatabaseSyncInstance, eventId: string, identity: JournalEmbeddingIdentity): boolean {
  return db.prepare(`SELECT 1 FROM mnemora_conversation_event_chunks c JOIN mnemora_conversation_event_chunks_embeddings v ON v.chunk_id=c.id
    WHERE c.event_id=? AND v.provider=? AND v.model=? AND v.dimensions=? AND v.input_version=? LIMIT 1`).get(eventId, identity.provider, identity.model, identity.dimensions, JOURNAL_CHUNK_EMBEDDING_INPUT_VERSION) !== undefined;
}

/** Whether the scope has at least one vector for this provider and model. */
export function journalScopeHasEmbeddings(db: DatabaseSyncInstance, scope: string, identity: Pick<JournalEmbeddingIdentity, "provider" | "model">): boolean {
  try {
    return db.prepare("SELECT 1 FROM mnemora_conversation_event_chunks_embeddings WHERE scope=? AND provider=? AND model=? AND input_version=? LIMIT 1").get(scope, identity.provider, identity.model, JOURNAL_CHUNK_EMBEDDING_INPUT_VERSION) !== undefined;
  } catch { return false; }
}
