import { normalizeScope } from "../scope.js";
import type { GraphologyStore } from "../store.js";
import { GraphHygieneService, type GraphHygienePolicy, type GraphHygieneReport } from "../hygiene/service.js";
import { SchemaDriftReviewRepository } from "../schema-drift/review.js";

export interface GraphReviewOutcomeSummary {
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
  invalidated: number;
  reviewed: number;
  acceptance_rate: number | null;
}

export interface SemanticVocabularyOutcomeSummary {
  total: number;
  collecting: number;
  pending: number;
  accepted: number;
  rejected: number;
  reviewed: number;
  acceptance_rate: number | null;
}

export interface GraphReviewDecisionGateReport {
  version: "graph-review-decision-gate-v1";
  scope: string;
  evaluated_at: number;
  hygiene: GraphHygieneReport;
  reviews: {
    related_edge_refinement: GraphReviewOutcomeSummary;
    related_edge_semantic: GraphReviewOutcomeSummary;
    schema_drift: GraphReviewOutcomeSummary;
    semantic_vocabulary: SemanticVocabularyOutcomeSummary;
  };
  actions: {
    topology_policy: "not_changed";
    reasoning_delivery: "not_changed";
    automatic_review_decision: "not_performed";
  };
}

/**
 * One read-only interface for the post-v1.16 operator decision gate. It
 * combines already-recorded review outcomes with bounded hygiene diagnostics;
 * it neither runs scans nor turns measurements into an automatic policy.
 */
export class GraphReviewDecisionGate {
  private readonly hygiene: GraphHygieneService;
  private readonly schemaDriftReviews: SchemaDriftReviewRepository;

  constructor(private readonly store: GraphologyStore, private readonly policy: Pick<GraphHygienePolicy, "relatedToWarningRatio" | "relatedToWarningMinimumEdges">, private readonly now: () => number = Date.now) {
    this.hygiene = new GraphHygieneService(store, now);
    this.schemaDriftReviews = new SchemaDriftReviewRepository(store.db, now);
  }

  report(scope: string): GraphReviewDecisionGateReport {
    const safe = normalizeScope(scope);
    return {
      version: "graph-review-decision-gate-v1",
      scope: safe,
      evaluated_at: this.now(),
      hygiene: this.hygiene.report(safe, this.policy),
      reviews: {
        related_edge_refinement: this.edgeOutcomes(safe, "related_edge_refinement", "kg_related_edge_refinement_candidates"),
        related_edge_semantic: this.edgeOutcomes(safe, "related_edge_semantic", "kg_related_edge_semantic_candidates"),
        schema_drift: this.schemaDriftReviews.summary(safe),
        semantic_vocabulary: this.vocabularyOutcomes(safe)
      },
      // A report is evidence for an operator decision, never the decision.
      actions: { topology_policy: "not_changed", reasoning_delivery: "not_changed", automatic_review_decision: "not_performed" }
    };
  }

  private edgeOutcomes(scope: string, kind: "related_edge_refinement" | "related_edge_semantic", table: "kg_related_edge_refinement_candidates" | "kg_related_edge_semantic_candidates"): GraphReviewOutcomeSummary {
    const row = this.store.db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN c.status='pending' AND i.candidate_id IS NULL THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN c.status='accepted' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN c.status='rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN i.candidate_id IS NOT NULL THEN 1 ELSE 0 END) AS invalidated
      FROM ${table} c
      LEFT JOIN kg_graph_review_invalidations i
        ON i.review_kind=? AND i.scope=c.scope AND i.candidate_id=c.id
      WHERE c.scope=?`).get(kind, scope) as CountRow;
    return outcomeSummary(row);
  }

  private vocabularyOutcomes(scope: string): SemanticVocabularyOutcomeSummary {
    const row = this.store.db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='collecting' THEN 1 ELSE 0 END) AS collecting,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected
      FROM kg_semantic_vocabulary_candidates WHERE scope=?`).get(scope) as CountRow;
    const reviewed = number(row.accepted) + number(row.rejected);
    return {
      total: number(row.total), collecting: number(row.collecting), pending: number(row.pending), accepted: number(row.accepted), rejected: number(row.rejected),
      reviewed, acceptance_rate: reviewed ? number(row.accepted) / reviewed : null
    };
  }
}

interface CountRow { total?: number; pending?: number; accepted?: number; rejected?: number; invalidated?: number; collecting?: number }

function outcomeSummary(row: CountRow): GraphReviewOutcomeSummary {
  const accepted = number(row.accepted), rejected = number(row.rejected), reviewed = accepted + rejected;
  return {
    total: number(row.total), pending: number(row.pending), accepted, rejected,
    invalidated: number(row.invalidated), reviewed, acceptance_rate: reviewed ? accepted / reviewed : null
  };
}

function number(value: unknown): number { return Number.isFinite(Number(value)) ? Number(value) : 0; }
