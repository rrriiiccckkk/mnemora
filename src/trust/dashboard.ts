import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";

export interface TrustDashboard {
  kind: "trust_dashboard";
  scope: string;
  generated_at: number;
  verification: { total: number; by_status: Record<string, number> };
  queue: { total: number; by_status: Record<string, number>; stale_leases: number };
  retrospective_audits: { total: number; by_status: Record<string, number> };
  sources: { total: number; by_status: Record<string, number> };
  recall: { adaptive_configured: boolean; canary_active: boolean; recent_canary_runs: number };
  governance: { enabled: boolean; principals: number; grants: { total: number; by_status: Record<string, number> }; approvals: { total: number; by_status: Record<string, number> }; decisions: { total: number; by_outcome: Record<string, number> } };
}

/**
 * Read-only trust operations projection. It intentionally exposes aggregate
 * state only: no claim text, snapshots, provider payloads, or local paths.
 */
export class TrustDashboardService {
  constructor(private readonly db: DatabaseSyncInstance, private readonly options: { scopeDefault?: string; adaptiveConfigured: boolean; governanceEnabled?: boolean; now?: () => number } = { adaptiveConfigured: false }) {}

  get(input: unknown = {}): TrustDashboard {
    const requested = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).scope : undefined;
    const scope = normalizeScope(typeof requested === "string" ? requested : this.options.scopeDefault);
    const now = (this.options.now ?? Date.now)();
    const counts = (table: "kg_claim_verifications" | "kg_anchor_verification_jobs" | "kg_retrospective_audits" | "kg_source_anchors") => byStatus(this.db, `SELECT status,COUNT(*) AS count FROM ${table} WHERE scope=? GROUP BY status`, scope);
    const verification = counts("kg_claim_verifications");
    const queue = counts("kg_anchor_verification_jobs");
    const audits = counts("kg_retrospective_audits");
    const sources = counts("kg_source_anchors");
    const stale = this.db.prepare("SELECT COUNT(*) AS count FROM kg_anchor_verification_jobs WHERE scope=? AND status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?").get(scope, now) as { count?: unknown };
    const canary = this.db.prepare("SELECT enabled FROM kg_recall_canaries WHERE scope=?").get(scope) as { enabled?: unknown } | undefined;
    const runs = this.db.prepare("SELECT COUNT(*) AS count FROM kg_recall_canary_runs WHERE scope=?").get(scope) as { count?: unknown };
    const principals = this.db.prepare("SELECT COUNT(*) AS count FROM kg_governance_principals WHERE status='active'").get() as { count?: unknown };
    const grants = byStatus(this.db, "SELECT status,COUNT(*) AS count FROM kg_governance_grants WHERE scope=? GROUP BY status", scope);
    const approvals = byStatus(this.db, "SELECT status,COUNT(*) AS count FROM kg_governance_approvals WHERE scope=? GROUP BY status", scope);
    const decisions = byStatus(this.db, "SELECT outcome AS status,COUNT(*) AS count FROM kg_governance_events WHERE scope=? GROUP BY outcome", scope);
    return {
      kind: "trust_dashboard", scope, generated_at: now,
      verification: { total: total(verification), by_status: verification },
      queue: { total: total(queue), by_status: queue, stale_leases: integer(stale.count) },
      retrospective_audits: { total: total(audits), by_status: audits },
      sources: { total: total(sources), by_status: sources },
      recall: { adaptive_configured: this.options.adaptiveConfigured, canary_active: this.options.adaptiveConfigured && Number(canary?.enabled) === 1, recent_canary_runs: integer(runs.count) },
      governance: { enabled: this.options.governanceEnabled === true, principals: integer(principals.count), grants: { total: total(grants), by_status: grants }, approvals: { total: total(approvals), by_status: approvals }, decisions: { total: total(decisions), by_outcome: decisions } }
    };
  }
}

function byStatus(db: DatabaseSyncInstance, sql: string, scope: string): Record<string, number> {
  const output: Record<string, number> = {};
  for (const row of db.prepare(sql).all(scope) as Array<{ status?: unknown; count?: unknown }>) if (typeof row.status === "string") output[row.status] = integer(row.count);
  return output;
}
function total(counts: Record<string, number>): number { return Object.values(counts).reduce((sum, value) => sum + value, 0); }
function integer(value: unknown): number { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0; }
