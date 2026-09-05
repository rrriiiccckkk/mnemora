import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { cosineSimilarity, decodeEmbedding, type EmbeddingIdentity } from "../embeddings.js";
import { mapNode, type NodeRow } from "../graph-records.js";
import { normalizeScope } from "../scope.js";
import type { EvidenceSummary, KgNode, KgSearchResult, RankedNode } from "../types.js";

/**
 * Read-only node discovery and ranking.  GraphologyStore remains the public
 * compatibility facade; this repository owns the query rules so recovery and
 * mutation paths do not need to know about FTS or vector ranking details.
 */
export class GraphSearchRepository {
  constructor(private readonly db: DatabaseSyncInstance) {}

  lexicalCandidates(query: string, nodeType?: string, limit = 10, scope?: string): RankedNode[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    const scopePredicate = "(? IS NULL OR EXISTS (SELECT 1 FROM kg_observations so WHERE so.source_entity_id=kg_nodes.id AND so.scope=?))";
    const candidates = new Map<string, RankedNode>();
    const add = (node: KgNode, score: number) => {
      const previous = candidates.get(node.id);
      if (!previous || score > previous.score) candidates.set(node.id, { node, score });
    };

    const exactRows = this.db.prepare(`SELECT * FROM kg_nodes WHERE deleted_at IS NULL AND (? IS NULL OR type = ?) AND ${scopePredicate} AND (lower(name)=lower(?) OR lower(id)=lower(?)) LIMIT ?`).all(nodeType ?? null, nodeType ?? null, normalizedScope ?? null, normalizedScope ?? null, trimmed, trimmed, limit) as NodeRow[];
    for (const row of exactRows) add(mapNode(row), 1);

    const aliasRows = this.db.prepare(`SELECT DISTINCT n.* FROM kg_nodes n
      JOIN json_each(CASE WHEN json_valid(n.aliases) THEN n.aliases ELSE '[]' END) a
      WHERE n.deleted_at IS NULL AND (? IS NULL OR n.type=?) AND (? IS NULL OR EXISTS (SELECT 1 FROM kg_observations so WHERE so.source_entity_id=n.id AND so.scope=?)) AND lower(CAST(a.value AS TEXT))=lower(?) LIMIT ?`)
      .all(nodeType ?? null, nodeType ?? null, normalizedScope ?? null, normalizedScope ?? null, trimmed, limit) as NodeRow[];
    for (const row of aliasRows) add(mapNode(row), .95);

    try {
      const ftsQuery = toFtsQuery(trimmed);
      if (ftsQuery) {
        const rows = this.db.prepare(`SELECT n.*, bm25(kg_nodes_fts) AS rank FROM kg_nodes_fts f JOIN kg_nodes n ON n.id=f.id WHERE kg_nodes_fts MATCH ? AND n.deleted_at IS NULL AND (? IS NULL OR n.type=?) AND (? IS NULL OR EXISTS (SELECT 1 FROM kg_observations so WHERE so.source_entity_id=n.id AND so.scope=?)) ORDER BY rank LIMIT ?`).all(ftsQuery, nodeType ?? null, nodeType ?? null, normalizedScope ?? null, normalizedScope ?? null, limit) as Array<NodeRow & { rank: number }>;
        const ranks = rows.map(row => Number(row.rank ?? 0));
        const best = Math.min(...ranks), worst = Math.max(...ranks);
        rows.forEach((row, index) => add(mapNode(row), best === worst ? 1 : (worst - ranks[index]!) / (worst - best)));
      }
    } catch { /* malformed FTS input remains eligible for exact and LIKE matching */ }

    const like = `%${escapeLike(trimmed)}%`;
    const likeRows = this.db.prepare(`SELECT * FROM kg_nodes WHERE deleted_at IS NULL AND (? IS NULL OR type = ?) AND ${scopePredicate} AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\') LIMIT ?`).all(nodeType ?? null, nodeType ?? null, normalizedScope ?? null, normalizedScope ?? null, like, like, like, like, limit) as NodeRow[];
    for (const row of likeRows) add(mapNode(row), .5);

    return [...candidates.values()]
      .sort((a, b) => b.score - a.score || b.node.importance - a.node.importance)
      .slice(0, limit);
  }

  semanticCandidates(queryVector: number[], identity: EmbeddingIdentity, inputVersion: string, nodeType?: string, limit = 10, minimum = .35, maxScanNodes = 10000, scope?: string): RankedNode[] {
    const budget = Math.min(Math.max(0, Math.trunc(maxScanNodes)), Math.max(limit * 8, 64));
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    const valid: Array<{ node: KgNode; vector: number[] }> = []; let afterId = ""; let scanned = 0;
    while (valid.length < budget && scanned < maxScanNodes) {
      const pageSize = Math.min(64, maxScanNodes - scanned);
      const rows = this.db.prepare(`SELECT * FROM kg_nodes WHERE deleted_at IS NULL AND embedding IS NOT NULL AND embedding_provider=? AND embedding_model=? AND embedding_dimensions=? AND embedding_input_version=? AND (? IS NULL OR type=?) AND (? IS NULL OR EXISTS (SELECT 1 FROM kg_observations so WHERE so.source_entity_id=kg_nodes.id AND so.scope=?)) AND id>? ORDER BY id LIMIT ?`).all(identity.provider, identity.model, identity.dimensions, inputVersion, nodeType ?? null, nodeType ?? null, normalizedScope ?? null, normalizedScope ?? null, afterId, pageSize) as Array<NodeRow & { embedding: Uint8Array }>;
      if (!rows.length) break;
      scanned += rows.length; afterId = rows.at(-1)!.id;
      for (const row of rows) try { valid.push({ node: mapNode(row), vector: decodeEmbedding(row.embedding, identity.dimensions) }); } catch { /* isolate one corrupt cached vector */ }
    }
    return valid
      .map(({ node, vector }) => ({ node, score: (cosineSimilarity(queryVector, vector) + 1) / 2 }))
      .filter(({ score }) => score >= minimum)
      .sort((a, b) => b.score - a.score || b.node.importance - a.node.importance)
      .slice(0, limit);
  }

  embeddingCandidateCount(identity: EmbeddingIdentity, inputVersion: string, scope?: string): number {
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    const row = this.db.prepare(`SELECT count(*) AS count FROM kg_nodes WHERE deleted_at IS NULL AND embedding IS NOT NULL AND embedding_provider=? AND embedding_model=? AND embedding_dimensions=? AND embedding_input_version=? AND (? IS NULL OR EXISTS (SELECT 1 FROM kg_observations so WHERE so.source_entity_id=kg_nodes.id AND so.scope=?))`).get(identity.provider, identity.model, identity.dimensions, inputVersion, normalizedScope ?? null, normalizedScope ?? null) as { count: number };
    return Number(row.count);
  }

  evidenceForNode(nodeId: string, limit: number, scope?: string): EvidenceSummary[] {
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    return this.db.prepare("SELECT id AS observation_id,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at FROM kg_observations WHERE source_entity_id = ? AND (? IS NULL OR scope=?) ORDER BY confidence DESC,created_at DESC,id LIMIT ?").all(nodeId, normalizedScope ?? null, normalizedScope ?? null, limit) as EvidenceSummary[];
  }

  rankHybrid(input: { lexical: RankedNode[]; semantic: RankedNode[]; limit: number; now: number; weights?: { semantic: number; lexical: number; confidence: number; freshness: number }; scope?: string }): KgSearchResult[] {
    const weights = input.weights ?? { semantic: .45, lexical: .25, confidence: .20, freshness: .10 };
    const merged = new Map<string, { node: KgNode; lexical: number; semantic: number }>();
    for (const item of input.lexical) merged.set(item.node.id, { node: item.node, lexical: item.score, semantic: 0 });
    for (const item of input.semantic) {
      const current = merged.get(item.node.id);
      if (current) current.semantic = item.score; else merged.set(item.node.id, { node: item.node, lexical: 0, semantic: item.score });
    }
    return [...merged.values()].map(item => {
      const evidence = this.evidenceForNode(item.node.id, 3, input.scope);
      const confidence = evidence.length ? evidence.reduce((sum, evidenceItem) => sum + evidenceItem.confidence, 0) / evidence.length : 0;
      const freshness = Math.exp(-Math.log(2) * Math.max(0, input.now - item.node.updated_at) / 86400000 / 180);
      const score_components = { semantic: item.semantic, lexical: item.lexical, confidence, freshness };
      const score = weights.semantic * item.semantic + weights.lexical * item.lexical + weights.confidence * confidence + weights.freshness * freshness;
      return { node: item.node, evidence, score, score_components };
    }).sort((a, b) => b.score - a.score || b.node.importance - a.node.importance).slice(0, input.limit);
  }
}

function toFtsQuery(query: string): string { return (query.match(/[\p{L}\p{N}_-]+/gu) ?? []).map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR "); }
function escapeLike(value: string): string { return value.replace(/[\\%_]/g, (char) => `\\${char}`); }
