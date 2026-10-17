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
