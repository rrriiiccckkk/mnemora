import { createHash } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";

export type GraphReviewCandidateKind = "related_edge_refinement" | "related_edge_semantic";
export type GraphReviewInvalidationReason = "legacy_edge_retired" | "evidence_removed" | "evidence_changed" | "node_evidence_removed";

interface CandidateRow {
  id: string; scope: string; legacy_edge_id: string; source_entity_id: string; target_entity_id: string;
  proposed_source_entity_id?: string; proposed_target_entity_id?: string; evidence_observation_id: string; evidence_hash: string;
}

/** Small, shared lifecycle repository for proposal validity. It records only
 * stale review metadata, never changes an edge, observation, or candidate's
 * operator decision. */
export class GraphReviewLifecycleRepository {
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {}

  reconcile(scope: string, kind: GraphReviewCandidateKind, limit = 100): { examined: number; invalidated: number } {
    const safe = normalizeScope(scope), bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
    const rows = this.db.prepare(`${candidateSql(kind)} WHERE c.scope=? AND c.status='pending'
      AND NOT EXISTS(SELECT 1 FROM kg_graph_review_invalidations i WHERE i.review_kind=? AND i.scope=c.scope AND i.candidate_id=c.id)
      ORDER BY c.id LIMIT ?`).all(safe, kind, bounded) as CandidateRow[];
    let invalidated = 0;
    for (const row of rows) if (this.reconcileCandidate(safe, kind, row.id, row)) invalidated++;
    return { examined: rows.length, invalidated };
  }

  reconcileCandidate(scope: string, kind: GraphReviewCandidateKind, candidateId: string, supplied?: CandidateRow): GraphReviewInvalidationReason | undefined {
    const safe = normalizeScope(scope), candidate = supplied ?? this.db.prepare(`${candidateSql(kind)} WHERE c.scope=? AND c.id=? AND c.status='pending'`).get(safe, boundedId(candidateId)) as CandidateRow | undefined;
    if (!candidate) return this.reason(kind, safe, candidateId);
    const reason = this.staleReason(candidate);
    if (!reason) return undefined;
    this.db.prepare(`INSERT INTO kg_graph_review_invalidations(review_kind,scope,candidate_id,reason,invalidated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(review_kind,scope,candidate_id) DO NOTHING`).run(kind, safe, candidate.id, reason, this.now());
    return reason;
  }

  reason(kind: GraphReviewCandidateKind, scope: string, candidateId: string): GraphReviewInvalidationReason | undefined {
    const row = this.db.prepare("SELECT reason FROM kg_graph_review_invalidations WHERE review_kind=? AND scope=? AND candidate_id=?").get(kind, normalizeScope(scope), boundedId(candidateId)) as { reason?: string } | undefined;
    return isReason(row?.reason) ? row.reason : undefined;
  }

  private staleReason(candidate: CandidateRow): GraphReviewInvalidationReason | undefined {
    const legacy = this.db.prepare("SELECT 1 FROM kg_edges WHERE id=? AND type='related_to' AND deleted_at IS NULL AND source_id=? AND target_id=?").get(candidate.legacy_edge_id, candidate.source_entity_id, candidate.target_entity_id);
    if (!legacy) return "legacy_edge_retired";
    const evidence = this.db.prepare("SELECT quote FROM kg_observations WHERE id=? AND edge_id=? AND scope=?").get(candidate.evidence_observation_id, candidate.legacy_edge_id, candidate.scope) as { quote?: string } | undefined;
    if (typeof evidence?.quote !== "string") return "evidence_removed";
    if (hash(evidence.quote) !== candidate.evidence_hash) return "evidence_changed";
    const endpoints = [candidate.proposed_source_entity_id ?? candidate.source_entity_id, candidate.proposed_target_entity_id ?? candidate.target_entity_id];
    for (const nodeId of endpoints) {
      const present = this.db.prepare("SELECT 1 FROM kg_observations WHERE source_entity_id=? AND scope=? LIMIT 1").get(nodeId, candidate.scope);
      if (!present) return "node_evidence_removed";
    }
    return undefined;
  }
}

function candidateSql(kind: GraphReviewCandidateKind): string {
  return kind === "related_edge_refinement"
    ? "SELECT c.id,c.scope,c.legacy_edge_id,c.source_entity_id,c.target_entity_id,c.proposed_source_entity_id,c.proposed_target_entity_id,c.evidence_observation_id,c.evidence_hash FROM kg_related_edge_refinement_candidates c"
    : "SELECT c.id,c.scope,c.legacy_edge_id,c.source_entity_id,c.target_entity_id,c.evidence_observation_id,c.evidence_hash FROM kg_related_edge_semantic_candidates c";
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function boundedId(value: string): string { return value.length > 0 && value.length <= 200 ? value : ""; }
function isReason(value: unknown): value is GraphReviewInvalidationReason { return value === "legacy_edge_retired" || value === "evidence_removed" || value === "evidence_changed" || value === "node_evidence_removed"; }
