import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import { GraphReviewLifecycleRepository, type GraphReviewCandidateKind, type GraphReviewInvalidationReason } from "./lifecycle.js";
import { SchemaDriftReviewRepository, type SchemaDriftWorklistItem } from "../schema-drift/review.js";

export type GraphReviewWorklistStatus = "pending" | "rejected" | "invalidated";
export type GraphReviewWorklistKind = GraphReviewCandidateKind | "schema_drift" | "suspicious_self_link";
export interface GraphReviewWorklistItem {
  id: string;
  kind: GraphReviewWorklistKind;
  status: GraphReviewWorklistStatus;
  candidate_id?: string;
  legacy_edge_id?: string;
  proposed_type?: string;
  invalidation_reason?: GraphReviewInvalidationReason | "endpoint_now_allowed";
  updated_at: number;
  edge_id?: string;
  entity_id?: string;
  relationship_type?: string;
  source_type?: string;
  target_type?: string;
  expected_source_types?: string;
  expected_target_types?: string;
  occurrence_count?: number;
  next_action?: "repair_or_reject";
}

/** Read model for the graph-remediation queue. It is deliberately separate
 * from candidate mutation services so a worklist cannot accept, reject, merge,
 * or delete graph state. */
export class GraphReviewWorklistService {
  constructor(private readonly db: DatabaseSyncInstance, private readonly lifecycle: GraphReviewLifecycleRepository, private readonly schemaDriftReviews: SchemaDriftReviewRepository) {}

  list(input: { scope: string; status: GraphReviewWorklistStatus; limit?: number; afterId?: string }): { items: GraphReviewWorklistItem[]; next_after_id?: string; reconciliation: Record<GraphReviewCandidateKind, { examined: number; invalidated: number }> } {
    const scope = normalizeScope(input.scope), limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 20))), after = boundedId(input.afterId);
    const reconciliation = {
      related_edge_refinement: this.lifecycle.reconcile(scope, "related_edge_refinement"),
      related_edge_semantic: this.lifecycle.reconcile(scope, "related_edge_semantic")
    };
    const candidates = [
      ...this.candidates(scope, "related_edge_refinement", after, limit + 1),
      ...this.candidates(scope, "related_edge_semantic", after, limit + 1)
    ];
    for (const item of candidates) if (item.candidate_id) this.lifecycle.reconcileCandidate(scope, item.kind as GraphReviewCandidateKind, item.candidate_id);
    const rows = [
      ...this.candidates(scope, "related_edge_refinement", after, limit + 1),
      ...this.candidates(scope, "related_edge_semantic", after, limit + 1),
      ...this.schemaDrift(scope, input.status, after, limit + 1),
      ...this.selfLinks(scope, after, limit + 1)
    ].filter(item => item.status === input.status).sort((left, right) => left.id.localeCompare(right.id));
    const items = rows.slice(0, limit), last = items.at(-1);
    return { items, ...(rows.length > limit && last ? { next_after_id: last.id } : {}), reconciliation };
  }

  private schemaDrift(scope: string, status: GraphReviewWorklistStatus, after: string, limit: number): GraphReviewWorklistItem[] {
    this.schemaDriftReviews.reconcile(scope, limit, after);
    return this.schemaDriftReviews.worklist({ scope, status, afterId: after, limit }).map(item => this.schemaDriftItem(item));
  }

  private schemaDriftItem(item: SchemaDriftWorklistItem): GraphReviewWorklistItem {
    return {
      id: item.id, kind: "schema_drift", candidate_id: item.candidate_id, status: item.status,
      relationship_type: item.relationship_type, source_type: item.source_type, target_type: item.target_type,
      expected_source_types: item.expected_source_types, expected_target_types: item.expected_target_types,
      occurrence_count: item.occurrence_count, updated_at: item.updated_at,
      ...(item.legacy_edge_id ? { legacy_edge_id: item.legacy_edge_id } : {}),
      ...(item.invalidation_reason ? { invalidation_reason: item.invalidation_reason } : {}),
      ...(item.next_action ? { next_action: item.next_action } : {})
    };
  }

  private candidates(scope: string, kind: GraphReviewCandidateKind, after: string, limit: number): GraphReviewWorklistItem[] {
    const table = kind === "related_edge_refinement" ? "kg_related_edge_refinement_candidates" : "kg_related_edge_semantic_candidates";
    const rows = this.db.prepare(`SELECT c.id,c.legacy_edge_id,c.proposed_type,c.status,c.updated_at,i.reason AS invalidation_reason
      FROM ${table} c LEFT JOIN kg_graph_review_invalidations i ON i.review_kind=? AND i.scope=c.scope AND i.candidate_id=c.id
      WHERE c.scope=? AND c.id>? AND (c.status IN ('pending','rejected') OR i.candidate_id IS NOT NULL)
      ORDER BY c.id LIMIT ?`).all(kind, scope, after, limit) as Array<{ id: string; legacy_edge_id: string; proposed_type: string; status: string; updated_at: number; invalidation_reason?: string }>;
    return rows.map(row => ({
      id: row.id, kind, candidate_id: row.id, legacy_edge_id: row.legacy_edge_id, proposed_type: row.proposed_type,
      status: isReason(row.invalidation_reason) ? "invalidated" : row.status === "rejected" ? "rejected" : "pending",
      ...(isReason(row.invalidation_reason) ? { invalidation_reason: row.invalidation_reason } : {}), updated_at: Number(row.updated_at)
    }));
  }

  private selfLinks(scope: string, after: string, limit: number): GraphReviewWorklistItem[] {
    const rows = this.db.prepare(`SELECT e.id,e.source_id,e.updated_at FROM kg_edges e WHERE e.deleted_at IS NULL AND e.source_id=e.target_id
      AND EXISTS(SELECT 1 FROM kg_observations o WHERE o.edge_id=e.id AND o.scope=?) AND ('self-link:' || e.id)>?
      ORDER BY e.id LIMIT ?`).all(scope, after, limit) as Array<{ id: string; source_id: string; updated_at: number }>;
    return rows.map(row => ({ id: `self-link:${row.id}`, kind: "suspicious_self_link", status: "pending", edge_id: row.id, entity_id: row.source_id, updated_at: Number(row.updated_at) }));
  }
}

function boundedId(value: string | undefined): string { return typeof value === "string" && value.length <= 240 ? value : ""; }
function isReason(value: unknown): value is GraphReviewInvalidationReason { return value === "legacy_edge_retired" || value === "evidence_removed" || value === "evidence_changed" || value === "node_evidence_removed"; }
