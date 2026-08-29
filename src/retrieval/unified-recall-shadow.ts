import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import type { InjectionSuppressionReason } from "./injection-policy.js";

export interface UnifiedRecallShadowRun {
  id: string;
  scope: string;
  query_hash: string;
  local_candidate_count: number;
  local_selected_count: number;
  local_suppressed_count: number;
  graph_candidate_count: number;
  graph_attached: boolean;
  graph_suppression?: InjectionSuppressionReason;
  attached: boolean;
  created_at: number;
}

export interface UnifiedRecallShadowMetrics {
  items: UnifiedRecallShadowRun[];
  summary: { total_runs: number; attached_runs: number; graph_suppressed_runs: number; empty_runs: number; };
}

/** A read-only observability repository for real ContextEngine recall. It
 * stores only a query hash and bounded aggregate decision counts. */
export class UnifiedRecallShadowRepository {
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {}

  record(input: {
    scope: string;
    query: string;
    localCandidates: number;
    localSelected: number;
    localSuppressed: number;
    graphCandidates: number;
    graphAttached: boolean;
    graphSuppression?: InjectionSuppressionReason;
    attached: boolean;
  }): void {
    const scope = normalizeScope(input.scope), now = this.now();
    this.db.prepare(`INSERT INTO mnemora_unified_recall_shadow_runs(
      id,scope,query_hash,local_candidate_count,local_selected_count,local_suppressed_count,graph_candidate_count,graph_attached,graph_suppression,attached,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      `unified-recall-shadow:${randomUUID()}`, scope, digest(input.query), count(input.localCandidates), count(input.localSelected), count(input.localSuppressed), count(input.graphCandidates), input.graphAttached ? 1 : 0, input.graphSuppression ?? null, input.attached ? 1 : 0, now
    );
    this.db.exec(`DELETE FROM mnemora_unified_recall_shadow_runs WHERE id NOT IN (
      SELECT id FROM mnemora_unified_recall_shadow_runs ORDER BY created_at DESC,id DESC LIMIT 10000
    )`);
  }

  list(scope: string, limit = 20): UnifiedRecallShadowMetrics {
    const normalized = normalizeScope(scope), bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.db.prepare(`SELECT id,scope,query_hash,local_candidate_count,local_selected_count,local_suppressed_count,graph_candidate_count,graph_attached,graph_suppression,attached,created_at
      FROM mnemora_unified_recall_shadow_runs WHERE scope=? ORDER BY created_at DESC,id DESC LIMIT ?`).all(normalized, bounded) as Array<Record<string, unknown>>;
    const totals = this.db.prepare(`SELECT COUNT(*) AS total_runs,SUM(attached) AS attached_runs,SUM(CASE WHEN graph_suppression IS NOT NULL THEN 1 ELSE 0 END) AS graph_suppressed_runs,
      SUM(CASE WHEN local_selected_count=0 AND graph_attached=0 THEN 1 ELSE 0 END) AS empty_runs
      FROM mnemora_unified_recall_shadow_runs WHERE scope=?`).get(normalized) as Record<string, unknown>;
    return { items: rows.flatMap(run), summary: { total_runs: count(totals.total_runs, 10000), attached_runs: count(totals.attached_runs, 10000), graph_suppressed_runs: count(totals.graph_suppressed_runs, 10000), empty_runs: count(totals.empty_runs, 10000) } };
  }
}

function run(row: Record<string, unknown>): UnifiedRecallShadowRun[] {
  if (typeof row.id !== "string" || typeof row.scope !== "string" || typeof row.query_hash !== "string" || !/^[a-f0-9]{64}$/i.test(row.query_hash)) return [];
  const graphSuppression = row.graph_suppression === "no_anchor_terms" || row.graph_suppression === "no_anchor_match" ? row.graph_suppression : undefined;
  return [{ id: row.id, scope: row.scope, query_hash: row.query_hash, local_candidate_count: count(row.local_candidate_count, 20), local_selected_count: count(row.local_selected_count, 20), local_suppressed_count: count(row.local_suppressed_count, 20), graph_candidate_count: count(row.graph_candidate_count, 20), graph_attached: row.graph_attached === 1, ...(graphSuppression ? { graph_suppression: graphSuppression } : {}), attached: row.attached === 1, created_at: count(row.created_at, Number.MAX_SAFE_INTEGER) }];
}
function count(value: unknown, maximum = 20): number { const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.min(maximum, Math.trunc(number))) : 0; }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
