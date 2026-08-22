import { createHash } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";

export interface RetrospectiveAuditConfig { enabled: boolean; maxJobsPerRun: number; minimumAgeDays: number; minimumRecallCount: number; }
export type RetrospectiveAuditStatus = "scheduled" | "running" | "review_required" | "reviewed" | "canceled" | "failed";
export interface RetrospectiveAudit {
  id: string; verification_id: string; scope: string; policy_version: "retrospective-risk-v1";
  risk_score: number; risk_signals: string[]; status: RetrospectiveAuditStatus; attempts: number;
  scheduled_at: number; started_at: number | null; finished_at: number | null; error_code: string | null; reviewed_at: number | null;
}

/** Owns review scheduling only: it cannot alter a claim verification outcome. */
export class RetrospectiveAuditService {
  private readonly config: Required<RetrospectiveAuditConfig>;
  constructor(private readonly db: DatabaseSyncInstance, config: RetrospectiveAuditConfig, private readonly now: () => number = Date.now) {
    this.config = { enabled: config.enabled === true, maxJobsPerRun: clamp(config.maxJobsPerRun, 1, 20, 5), minimumAgeDays: clamp(config.minimumAgeDays, 1, 3650, 30), minimumRecallCount: clamp(config.minimumRecallCount, 1, 10000, 3) };
  }
  get enabled(): boolean { return this.config.enabled; }
  schedule(scope: string, limit = this.config.maxJobsPerRun): { scheduled: number; candidates: number; disabled?: true } {
    if (!this.enabled) return { scheduled: 0, candidates: 0, disabled: true };
    const normalizedScope = normalizeScope(scope), now = this.now(), ageCutoff = now - this.config.minimumAgeDays * 86_400_000, max = clamp(limit, 1, this.config.maxJobsPerRun, this.config.maxJobsPerRun);
    const rows = this.db.prepare(`SELECT v.id AS verification_id,a.provider,a.captured_at,COALESCE(m.recall_count,0) AS recall_count,
      EXISTS(SELECT 1 FROM kg_conflict_candidates c WHERE c.status='pending' AND (c.observation_a=v.claim_id OR c.observation_b=v.claim_id)) AS conflict
      FROM kg_claim_verifications v JOIN kg_source_anchors a ON a.id=v.source_anchor_id
      LEFT JOIN kg_claim_recall_metrics m ON m.claim_id=v.claim_id
      WHERE v.scope=? AND v.status='verified' AND a.status='available'
      ORDER BY v.created_at,v.id LIMIT 200`).all(normalizedScope) as Array<{ verification_id: string; provider: string; captured_at: number; recall_count: number; conflict: number }>;
    const candidates = rows.map(row => ({ row, signals: signals(row, ageCutoff, this.config.minimumRecallCount) })).filter(item => item.signals.length > 0)
      .sort((a, b) => score(b.signals) - score(a.signals) || a.row.verification_id.localeCompare(b.row.verification_id)).slice(0, max);
    const insert = this.db.prepare(`INSERT OR IGNORE INTO kg_retrospective_audits(id,verification_id,scope,policy_version,risk_score,risk_signals,status,scheduled_at)
      VALUES(?,?,?,?,?,?,'scheduled',?)`);
    let scheduled = 0;
    for (const item of candidates) {
      const risk = score(item.signals), key = `${item.row.verification_id}\0retrospective-risk-v1`;
      scheduled += Number(insert.run(`retrospective:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`, item.row.verification_id, normalizedScope, "retrospective-risk-v1", risk, JSON.stringify(item.signals), now).changes ?? 0);
    }
    return { scheduled, candidates: candidates.length };
  }

  /** A conflict scan may request bounded, local-only review scheduling. No verifier or Provider is run here. */
  scheduleContradictions(scope: string, limit = this.config.maxJobsPerRun): { scheduled: number; candidates: number; disabled?: true } {
    if (!this.enabled) return { scheduled: 0, candidates: 0, disabled: true };
    const normalizedScope = normalizeScope(scope), maximum = clamp(limit, 1, this.config.maxJobsPerRun, this.config.maxJobsPerRun), now = this.now();
    const rows = this.db.prepare(`SELECT v.id AS verification_id FROM kg_claim_verifications v JOIN kg_source_anchors a ON a.id=v.source_anchor_id
      WHERE v.scope=? AND v.status='verified' AND a.status='available'
        AND EXISTS(SELECT 1 FROM kg_conflict_candidates c WHERE c.status='pending' AND (c.observation_a=v.claim_id OR c.observation_b=v.claim_id))
      ORDER BY v.created_at,v.id LIMIT ?`).all(normalizedScope, maximum) as Array<{ verification_id: string }>;
    const insert = this.db.prepare(`INSERT OR IGNORE INTO kg_retrospective_audits(id,verification_id,scope,policy_version,risk_score,risk_signals,status,scheduled_at)
      VALUES(?,?,?,?,?,?,'scheduled',?)`);
    let scheduled = 0;
    for (const row of rows) {
      const key = `${row.verification_id}\0retrospective-risk-v1`;
      scheduled += Number(insert.run(`retrospective:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`, row.verification_id, normalizedScope, "retrospective-risk-v1", 1, JSON.stringify(["contradiction_evidence"]), now).changes ?? 0);
    }
    return { scheduled, candidates: rows.length };
  }
  list(scope: string, limit = 20): RetrospectiveAudit[] {
    const rows = this.db.prepare(`SELECT id,verification_id,scope,policy_version,risk_score,risk_signals,status,attempts,scheduled_at,started_at,finished_at,error_code,reviewed_at
      FROM kg_retrospective_audits WHERE scope=? ORDER BY scheduled_at DESC,id DESC LIMIT ?`).all(normalizeScope(scope), clamp(limit, 1, 100, 20)) as Array<Record<string, unknown>>;
    return rows.flatMap(record);
  }

  run(scope: string, limit = this.config.maxJobsPerRun): { processed: number; review_required: number; reviewed: number; disabled?: true } {
    if (!this.enabled) return { processed: 0, review_required: 0, reviewed: 0, disabled: true };
    const normalizedScope = normalizeScope(scope), maximum = clamp(limit, 1, this.config.maxJobsPerRun, this.config.maxJobsPerRun);
    let processed = 0, reviewRequired = 0, reviewed = 0;
    while (processed < maximum) {
      const next = this.claimNext(normalizedScope);
      if (!next) break;
      processed++;
      try {
        const current = this.currentSignals(next.id);
        if (current.length) { this.finish(next.id, "review_required", current); reviewRequired++; }
        else { this.finish(next.id, "reviewed", []); reviewed++; }
      } catch {
        this.fail(next.id, "audit_execution");
      }
    }
    return { processed, review_required: reviewRequired, reviewed };
  }

  cancel(auditId: string): boolean {
    return Number(this.db.prepare(`UPDATE kg_retrospective_audits
      SET status='canceled',finished_at=?,error_code=NULL WHERE id=? AND status IN ('scheduled','running','review_required')`).run(this.now(), boundedId(auditId)).changes) === 1;
  }

  requeue(auditId: string): boolean {
    return Number(this.db.prepare(`UPDATE kg_retrospective_audits
      SET status='scheduled',started_at=NULL,finished_at=NULL,error_code=NULL,reviewed_at=NULL
      WHERE id=? AND status IN ('review_required','reviewed','canceled','failed')`).run(boundedId(auditId)).changes) === 1;
  }

  review(auditId: string): boolean {
    return Number(this.db.prepare(`UPDATE kg_retrospective_audits
      SET status='reviewed',reviewed_at=?,finished_at=?,error_code=NULL WHERE id=? AND status='review_required'`).run(this.now(), this.now(), boundedId(auditId)).changes) === 1;
  }

  reclaimStale(scope: string, olderThanMs = 300000): number {
    const now = this.now(), age = clamp(olderThanMs, 5000, 3_600_000, 300000);
    return Number(this.db.prepare(`UPDATE kg_retrospective_audits
      SET status='scheduled',started_at=NULL,finished_at=NULL,error_code='stale_execution'
      WHERE scope=? AND status='running' AND started_at IS NOT NULL AND started_at<=?`).run(normalizeScope(scope), now - age).changes ?? 0);
  }

  private claimNext(scope: string): RetrospectiveAudit | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT id,verification_id,scope,policy_version,risk_score,risk_signals,status,attempts,scheduled_at,started_at,finished_at,error_code,reviewed_at
        FROM kg_retrospective_audits WHERE scope=? AND status='scheduled' ORDER BY scheduled_at,id LIMIT 1`).get(scope) as Record<string, unknown> | undefined;
      if (!row) { this.db.exec("COMMIT"); return undefined; }
      const now = this.now();
      const changed = this.db.prepare(`UPDATE kg_retrospective_audits
        SET status='running',attempts=attempts+1,started_at=?,finished_at=NULL,error_code=NULL WHERE id=? AND status='scheduled'`).run(now, row.id);
      this.db.exec("COMMIT");
      return Number(changed.changes) === 1 ? record({ ...row, status: "running", attempts: Number(row.attempts ?? 0) + 1, started_at: now, finished_at: null, error_code: null })[0] : undefined;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private currentSignals(auditId: string): string[] {
    const row = this.db.prepare(`SELECT a.provider,a.captured_at,COALESCE(m.recall_count,0) AS recall_count,
      EXISTS(SELECT 1 FROM kg_conflict_candidates c WHERE c.status='pending' AND (c.observation_a=v.claim_id OR c.observation_b=v.claim_id)) AS conflict
      FROM kg_retrospective_audits r JOIN kg_claim_verifications v ON v.id=r.verification_id
      JOIN kg_source_anchors a ON a.id=v.source_anchor_id LEFT JOIN kg_claim_recall_metrics m ON m.claim_id=v.claim_id
      WHERE r.id=? AND v.status='verified' AND a.status='available'`).get(auditId) as { provider: string; captured_at: number; recall_count: number; conflict: number } | undefined;
    return row ? signals(row, this.now() - this.config.minimumAgeDays * 86_400_000, this.config.minimumRecallCount) : [];
  }

  private finish(auditId: string, status: "review_required" | "reviewed", riskSignals: string[]): void {
    const now = this.now();
    this.db.prepare(`UPDATE kg_retrospective_audits
      SET status=?,risk_score=?,risk_signals=?,finished_at=?,reviewed_at=?,error_code=NULL WHERE id=? AND status='running'`)
      .run(status, score(riskSignals), JSON.stringify(riskSignals), now, status === "reviewed" ? now : null, auditId);
  }

  private fail(auditId: string, errorCode: string): void {
    this.db.prepare("UPDATE kg_retrospective_audits SET status='failed',finished_at=?,error_code=? WHERE id=? AND status='running'")
      .run(this.now(), errorCode, auditId);
  }
}

function signals(row: { provider: string; captured_at: number; recall_count: number; conflict: number }, ageCutoff: number, minRecall: number): string[] {
  const values: string[] = [];
  if (row.provider !== "mnemora-local") values.push("mutable_source");
  if (Number(row.captured_at) <= ageCutoff) values.push("aged_source");
  if (Number(row.recall_count) >= minRecall) values.push("frequently_recalled");
  if (Number(row.conflict) === 1) values.push("contradiction_evidence");
  return values;
}
function score(signals: string[]): number { return Math.min(1, Math.round((signals.length / 4) * 1e6) / 1e6); }
function clamp(value: unknown, min: number, max: number, fallback: number): number { const number = Number(value); return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback; }
function record(value: Record<string, unknown>): RetrospectiveAudit[] {
  if (typeof value.id !== "string" || typeof value.verification_id !== "string" || typeof value.scope !== "string" || value.policy_version !== "retrospective-risk-v1" || !["scheduled","running","review_required","reviewed","canceled","failed"].includes(String(value.status))) return [];
  try { const risk = JSON.parse(String(value.risk_signals)); if (!Array.isArray(risk) || !risk.every(item => typeof item === "string")) return []; return [{ id: value.id, verification_id: value.verification_id, scope: value.scope, policy_version: "retrospective-risk-v1", risk_score: Number(value.risk_score), risk_signals: risk.slice(0, 4), status: value.status as RetrospectiveAuditStatus, attempts: nonNegativeInteger(value.attempts), scheduled_at: nonNegativeInteger(value.scheduled_at), started_at: integerOrNull(value.started_at), finished_at: integerOrNull(value.finished_at), error_code: boundedError(value.error_code), reviewed_at: integerOrNull(value.reviewed_at) }]; }
  catch { return []; }
}
function boundedId(value: unknown): string { return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : ""; }
function boundedError(value: unknown): string | null { return typeof value === "string" && value.length > 0 && value.length <= 80 ? value : null; }
function nonNegativeInteger(value: unknown): number { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0; }
function integerOrNull(value: unknown): number | null { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null; }
