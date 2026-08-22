import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";

export type CompactionRunStatus = "pending" | "running" | "prepared" | "succeeded" | "failed" | "cancelled";
export type CompactionRun = {
  id: string; scope: string; sessionId: string; sourceFingerprint: string; status: CompactionRunStatus; summaryId?: string;
  selectedEventCount: number; inputChars: number; outputChars: number; estimatedInputTokens: number; estimatedOutputTokens: number;
  failureCategory?: string; createdAt: number; updatedAt: number; completedAt?: number;
};
export type CompactionReconciliationOutcome = "rewrite_confirmed" | "rewrite_not_applied";
type RunRow = {
  id: string; scope: string; session_id: string; source_fingerprint: string; status: CompactionRunStatus; summary_id: string | null;
  selected_event_count: number; input_chars: number; output_chars: number; estimated_input_tokens: number; estimated_output_tokens: number;
  failure_category: string | null; created_at: number; updated_at: number; completed_at: number | null;
};

const asRun = (row: RunRow): CompactionRun => ({ id: row.id, scope: row.scope, sessionId: row.session_id, sourceFingerprint: row.source_fingerprint, status: row.status, ...(row.summary_id ? { summaryId: row.summary_id } : {}), selectedEventCount: row.selected_event_count, inputChars: row.input_chars, outputChars: row.output_chars, estimatedInputTokens: row.estimated_input_tokens, estimatedOutputTokens: row.estimated_output_tokens, ...(row.failure_category ? { failureCategory: row.failure_category } : {}), createdAt: row.created_at, updatedAt: row.updated_at, ...(row.completed_at ? { completedAt: row.completed_at } : {}) });

/** Durable claims and accounting for external transcript rewrites. A source
 * fingerprint is never retried while a previous rewrite may be ambiguous. */
export class CompactionRunRepository {
  constructor(private readonly db: DatabaseSyncInstance) {}

  fingerprint(eventIds: string[], contents: string[]): string {
    const value = eventIds.map((id, index) => `${id}\u0000${createHash("sha256").update(contents[index] ?? "").digest("hex")}`).join("\u0001");
    return createHash("sha256").update(value).digest("hex");
  }

  limits(input: { scope: string; sessionId: string; now: number; maxRunsPerHour: number; maxDailyTokens: number; circuitCooldownMs: number; summaryMaxCallsPerWindow: number; summaryCallWindowMs: number; summarySpendBackoffMs: number }): "rate_limited" | "daily_budget_exhausted" | "circuit_open" | "summary_spend_backoff" | "summary_call_window_exhausted" | undefined {
    const { now, maxRunsPerHour, maxDailyTokens, circuitCooldownMs, summaryMaxCallsPerWindow, summaryCallWindowMs, summarySpendBackoffMs } = input;
    const normalized = normalizeScope(input.scope), sessionId = input.sessionId, hour = now - 60 * 60 * 1000, day = now - 24 * 60 * 60 * 1000;
    const attempts = Number((this.db.prepare("SELECT COUNT(*) AS n FROM mnemora_compaction_runs WHERE scope=? AND created_at>=? AND status<>'cancelled'").get(normalized, hour) as { n: number }).n);
    if (attempts >= maxRunsPerHour) return "rate_limited";
    const failures = Number((this.db.prepare("SELECT COUNT(*) AS n FROM mnemora_compaction_runs WHERE scope=? AND created_at>=? AND status='failed'").get(normalized, hour) as { n: number }).n);
    const latestFailure = this.db.prepare("SELECT updated_at FROM mnemora_compaction_runs WHERE scope=? AND status='failed' AND created_at>=? ORDER BY updated_at DESC LIMIT 1").get(normalized, hour) as { updated_at: number } | undefined;
    if (failures >= 3 && latestFailure && now - latestFailure.updated_at < circuitCooldownMs) return "circuit_open";
    // A failed run can have already called the model. Its bounded estimate is
    // therefore consumed budget, not a free retry. Only an explicitly
    // cancelled pre-call attempt is excluded.
    const used = Number((this.db.prepare("SELECT COALESCE(SUM(estimated_input_tokens + estimated_output_tokens),0) AS n FROM mnemora_compaction_runs WHERE scope=? AND created_at>=? AND status<>'cancelled'").get(normalized, day) as { n: number }).n);
    if (used >= maxDailyTokens) return "daily_budget_exhausted";
    const windowStart = now - summaryCallWindowMs;
    const callCount = Number((this.db.prepare("SELECT COUNT(*) AS n FROM mnemora_compaction_runs WHERE scope=? AND session_id=? AND created_at>=? AND status IN ('running','prepared','succeeded','failed')").get(normalized, sessionId, windowStart) as { n: number }).n);
    if (callCount < summaryMaxCallsPerWindow) return undefined;
    const latestCall = this.db.prepare("SELECT created_at FROM mnemora_compaction_runs WHERE scope=? AND session_id=? AND created_at>=? AND status IN ('running','prepared','succeeded','failed') ORDER BY created_at DESC LIMIT 1").get(normalized, sessionId, windowStart) as { created_at: number } | undefined;
    return latestCall && now - latestCall.created_at < summarySpendBackoffMs ? "summary_spend_backoff" : "summary_call_window_exhausted";
  }

  reserve(input: { scope: string; sessionId: string; fingerprint: string; selectedEventCount: number; inputChars: number; estimatedInputTokens: number; now: number; staleRunningMs: number }): { run?: CompactionRun; reason?: "already_compacted" | "replay_pending" } {
    const scope = normalizeScope(input.scope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT * FROM mnemora_compaction_runs WHERE scope=? AND session_id=? AND source_fingerprint=?").get(scope, input.sessionId, input.fingerprint) as RunRow | undefined;
      if (current?.status === "succeeded") { this.db.exec("COMMIT"); return { reason: "already_compacted" }; }
      if (current?.status === "prepared") { this.db.exec("COMMIT"); return { reason: "replay_pending" }; }
      if (current?.status === "running" && current.updated_at > input.now - input.staleRunningMs) { this.db.exec("COMMIT"); return { reason: "replay_pending" }; }
      const id = current?.id ?? randomUUID(), summaryId = randomUUID();
      // A stale running attempt can die after SummaryRepository.create() but
      // before it records `prepared`. Its old summary was never rewritten or
      // activated, so retire that non-injectable orphan before a new attempt.
      if (current?.summary_id) this.db.prepare("UPDATE mnemora_summary_nodes SET deleted_at=?,injection_eligible=0 WHERE id=? AND scope=? AND injection_eligible=0 AND deleted_at IS NULL").run(input.now, current.summary_id, scope);
      if (current) this.db.prepare("UPDATE mnemora_compaction_runs SET status='pending',summary_id=?,selected_event_count=?,input_chars=?,output_chars=0,estimated_input_tokens=?,estimated_output_tokens=0,failure_category=NULL,updated_at=?,completed_at=NULL WHERE id=?").run(summaryId, input.selectedEventCount, input.inputChars, input.estimatedInputTokens, input.now, id);
      else this.db.prepare("INSERT INTO mnemora_compaction_runs(id,scope,session_id,source_fingerprint,status,summary_id,selected_event_count,input_chars,estimated_input_tokens,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id, scope, input.sessionId, input.fingerprint, "pending", summaryId, input.selectedEventCount, input.inputChars, input.estimatedInputTokens, input.now, input.now);
      const row = this.db.prepare("SELECT * FROM mnemora_compaction_runs WHERE id=?").get(id) as RunRow;
      this.db.exec("COMMIT"); return { run: asRun(row) };
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  update(id: string, status: CompactionRunStatus, now: number, details: { outputChars?: number; estimatedOutputTokens?: number; failureCategory?: string } = {}): void {
    const final = status === "succeeded" || status === "failed" || status === "cancelled" ? now : null;
    this.db.prepare("UPDATE mnemora_compaction_runs SET status=?,output_chars=COALESCE(?,output_chars),estimated_output_tokens=COALESCE(?,estimated_output_tokens),failure_category=?,updated_at=?,completed_at=? WHERE id=?").run(status, details.outputChars ?? null, details.estimatedOutputTokens ?? null, details.failureCategory ?? null, now, final, id);
  }

  /**
   * A host rewrite can fail after it has committed remotely. Never guess at
   * that outcome or retry automatically. This explicit operator-only result
   * is the one recovery path for a durable prepared claim.
   */
  reconcilePrepared(input: { scope: string; id: string; outcome: CompactionReconciliationOutcome; now?: number }): CompactionRun | undefined {
    const scope = normalizeScope(input.scope), now = input.now ?? Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT * FROM mnemora_compaction_runs WHERE id=? AND scope=? AND status='prepared'").get(input.id, scope) as RunRow | undefined;
      if (!current?.summary_id) { this.db.exec("COMMIT"); return undefined; }
      const summary = this.db.prepare("SELECT id FROM mnemora_summary_nodes WHERE id=? AND scope=? AND deleted_at IS NULL").get(current.summary_id, scope) as { id: string } | undefined;
      if (!summary) { this.db.exec("COMMIT"); return undefined; }
      if (input.outcome === "rewrite_confirmed") {
        this.db.prepare("UPDATE mnemora_summary_nodes SET injection_eligible=1 WHERE id=? AND scope=? AND deleted_at IS NULL").run(current.summary_id, scope);
        this.db.prepare("UPDATE mnemora_compaction_runs SET status='succeeded',failure_category=NULL,updated_at=?,completed_at=? WHERE id=? AND scope=? AND status='prepared'").run(now, now, current.id, scope);
      } else {
        this.db.prepare("UPDATE mnemora_summary_nodes SET deleted_at=?,injection_eligible=0 WHERE id=? AND scope=? AND deleted_at IS NULL").run(now, current.summary_id, scope);
        this.db.prepare("UPDATE mnemora_compaction_runs SET status='failed',failure_category='operator_confirmed_not_rewritten',updated_at=?,completed_at=? WHERE id=? AND scope=? AND status='prepared'").run(now, now, current.id, scope);
      }
      const row = this.db.prepare("SELECT * FROM mnemora_compaction_runs WHERE id=? AND scope=?").get(current.id, scope) as RunRow;
      this.db.exec("COMMIT");
      return asRun(row);
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  prepared(scope: string, limit = 20): CompactionRun[] {
    const bounded = Math.min(100, Math.max(1, Math.floor(limit)));
    const rows = this.db.prepare("SELECT * FROM mnemora_compaction_runs WHERE scope=? AND status='prepared' ORDER BY updated_at ASC,id ASC LIMIT ?").all(normalizeScope(scope), bounded) as RunRow[];
    return rows.map(asRun);
  }

  hasSucceededSourceEvent(scope: string, eventId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS value FROM mnemora_compaction_runs r JOIN mnemora_summary_event_edges e ON e.summary_id=r.summary_id AND e.scope=r.scope WHERE r.scope=? AND r.status='succeeded' AND e.event_id=? LIMIT 1").get(normalizeScope(scope), eventId));
  }
}
