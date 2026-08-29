import { normalizeScope } from "../scope.js";
import type { GraphologyStore } from "../store.js";
import type { DuplicateScanResult } from "../types.js";

export interface GraphHygienePolicy {
  intervalHours: number;
  maxDuplicateScanNodes: number;
  relatedToWarningRatio: number;
  relatedToWarningMinimumEdges: number;
}

export interface GraphHygieneReport {
  version: "graph-hygiene-v1";
  scope: string;
  evaluated_at: number;
  scoped_edges: number;
  related_to: { edges: number; ratio: number; warning: boolean };
  suspicious_self_links: number;
  pending_duplicate_candidates: number;
  recommendations: Array<"related_to_overrepresented" | "self_links_detected" | "duplicate_review_pending">;
}

export interface GraphHygieneRun {
  status: "not_due" | "continued" | "completed";
  report: GraphHygieneReport;
  duplicate_scan?: DuplicateScanResult;
}

const scanState = "hygiene_duplicate_scan";
const completeState = `${scanState}_completed_at`;

/**
 * Bounded, review-only graph hygiene. It may create duplicate *candidates*,
 * but never merges entities, deletes edges, or changes graph evidence.
 */
export class GraphHygieneService {
  constructor(private readonly store: GraphologyStore, private readonly now: () => number = Date.now) {}

  report(scope: string, policy: Pick<GraphHygienePolicy, "relatedToWarningRatio" | "relatedToWarningMinimumEdges">): GraphHygieneReport {
    const normalizedScope = normalizeScope(scope), evaluatedAt = this.now();
    const counts = this.store.db.prepare(`SELECT
      COUNT(DISTINCT e.id) AS total,
      COUNT(DISTINCT CASE WHEN e.type='related_to' THEN e.id END) AS related_to,
      COUNT(DISTINCT CASE WHEN e.source_id=e.target_id THEN e.id END) AS self_links
      FROM kg_edges e
      WHERE e.deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM kg_observations o WHERE o.edge_id=e.id AND o.scope=?)`).get(normalizedScope) as { total?: number; related_to?: number; self_links?: number };
    const scopedEdges = Number(counts.total ?? 0), relatedTo = Number(counts.related_to ?? 0), selfLinks = Number(counts.self_links ?? 0);
    const ratio = scopedEdges ? relatedTo / scopedEdges : 0;
    const pending = this.store.db.prepare(`SELECT COUNT(*) AS count FROM kg_duplicate_candidates c
      WHERE c.status='pending'
        AND EXISTS(SELECT 1 FROM kg_observations o LEFT JOIN kg_edges e ON e.id=o.edge_id
          WHERE o.scope=? AND (o.source_entity_id=c.entity_a OR e.source_id=c.entity_a OR e.target_id=c.entity_a))
        AND EXISTS(SELECT 1 FROM kg_observations o LEFT JOIN kg_edges e ON e.id=o.edge_id
          WHERE o.scope=? AND (o.source_entity_id=c.entity_b OR e.source_id=c.entity_b OR e.target_id=c.entity_b))`).get(normalizedScope, normalizedScope) as { count?: number };
    const relatedWarning = scopedEdges >= policy.relatedToWarningMinimumEdges && ratio >= policy.relatedToWarningRatio;
    const recommendations: GraphHygieneReport["recommendations"] = [];
    if (relatedWarning) recommendations.push("related_to_overrepresented");
    if (selfLinks) recommendations.push("self_links_detected");
    if (Number(pending.count ?? 0)) recommendations.push("duplicate_review_pending");
    return {
      version: "graph-hygiene-v1", scope: normalizedScope, evaluated_at: evaluatedAt, scoped_edges: scopedEdges,
      related_to: { edges: relatedTo, ratio, warning: relatedWarning }, suspicious_self_links: selfLinks,
      pending_duplicate_candidates: Number(pending.count ?? 0), recommendations
    };
  }

  run(input: { scope: string; policy: GraphHygienePolicy; force?: boolean }): GraphHygieneRun {
    const now = this.now(), scope = normalizeScope(input.scope);
    const completedAt = this.stateNumber(completeState);
    const cursor = this.stateText(`${scanState}_cursor`);
    const due = input.force === true || Boolean(cursor) || completedAt == null || now - completedAt >= input.policy.intervalHours * 3_600_000;
    if (!due) return { status: "not_due", report: this.report(scope, input.policy) };
    const scan = this.store.scanDuplicateCandidates(undefined, input.policy.maxDuplicateScanNodes, { persistCursor: true, stateKey: scanState });
    return { status: scan.complete ? "completed" : "continued", duplicate_scan: scan, report: this.report(scope, input.policy) };
  }

  private stateText(key: string): string | undefined {
    const row = this.store.db.prepare("SELECT value FROM kg_maintenance_state WHERE key=?").get(key) as { value?: string } | undefined;
    return typeof row?.value === "string" && row.value.length > 0 ? row.value : undefined;
  }

  private stateNumber(key: string): number | undefined {
    const value = Number(this.stateText(key));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
}
