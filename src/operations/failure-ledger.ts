import type { DatabaseSyncInstance } from "@photostructure/sqlite";

/**
 * Fail-open operations used to discard their errors. The host must keep
 * working when optional memory work fails, but an operator must be able to see
 * that it failed. This ledger keeps per-day counts of failed operations and a
 * coarse category. It never stores error messages, stack traces, prompts,
 * record text or scope names: a provider error body or a SQL error can contain
 * user text.
 */
export const OPERATION_NAMES = [
  "capture",
  "recall_assemble",
  "recall_relevance_advice",
  "semantic_query",
  "journal_embed",
  "turn_lifecycle",
  "compaction",
  "compaction_projection",
  "tool_projection",
  "session_scope_lookup",
  "first_use_observation",
  "graph_signal",
  "audit_schedule",
  "formation_observe",
  "vector_mirror",
  "graph_embed",
  "auto_extract",
  "corrupt_record",
  "journal_search"
] as const;
export type OperationName = typeof OPERATION_NAMES[number];
export const FAILURE_CATEGORIES = ["timeout", "aborted", "busy", "corrupt", "network", "invalid_response", "unavailable", "error"] as const;
export type FailureCategory = typeof FAILURE_CATEGORIES[number];
export interface OperationFailureEvent { operation: OperationName; category: FailureCategory }

const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const prunedDay = new WeakMap<object, number>();

export const operationFailureSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_operation_failures (
  day INTEGER NOT NULL CHECK(day >= 0),
  operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 48 AND operation NOT GLOB '*[^a-z_]*'),
  category TEXT NOT NULL CHECK(category IN (${FAILURE_CATEGORIES.map(value => `'${value}'`).join(",")})),
  count INTEGER NOT NULL CHECK(count >= 1),
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY(day, operation, category)
) WITHOUT ROWID;
`;

/** Map an error to a coarse category from its name and code only, never its message. */
export function failureCategory(error: unknown): FailureCategory {
  const value = error as { name?: unknown; code?: unknown; errcode?: unknown; cause?: unknown } | undefined;
  const name = typeof value?.name === "string" ? value.name : "";
  const code = typeof value?.code === "string" ? value.code : "";
  const errcode = typeof value?.errcode === "number" ? value.errcode : undefined;
  if (name === "TimeoutError" || code === "ETIMEDOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") return "timeout";
  if (name === "AbortError") return "aborted";
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || errcode === 5 || errcode === 6) return "busy";
  if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB" || errcode === 11 || errcode === 26) return "corrupt";
  if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) return "network";
  if (name === "SyntaxError") return "invalid_response";
  if (name === "RuntimeStoppedError" || code === "ERR_DATABASE_CLOSED") return "unavailable";
  if (value?.cause && value.cause !== error) { const inner = failureCategory(value.cause); if (inner !== "error") return inner; }
  return "error";
}

/** Count a failure. Never throws: a broken database must not turn a fail-open path into a failure. */
export function recordOperationFailure(db: DatabaseSyncInstance | undefined, event: OperationFailureEvent, at = Date.now()): boolean {
  if (!db || !OPERATION_NAMES.includes(event.operation) || !FAILURE_CATEGORIES.includes(event.category)) return false;
  try {
    const day = Math.floor(at / DAY_MS);
    db.prepare(`INSERT INTO mnemora_operation_failures(day,operation,category,count,first_at,last_at) VALUES(?,?,?,1,?,?)
      ON CONFLICT(day,operation,category) DO UPDATE SET count=count+1, last_at=max(last_at, excluded.last_at)`).run(day, event.operation, event.category, at, at);
    // Prune once per day per handle; keeps the table bounded without a job.
    if (prunedDay.get(db) !== day) { db.prepare("DELETE FROM mnemora_operation_failures WHERE day < ?").run(day - RETENTION_DAYS); prunedDay.set(db, day); }
    return true;
  } catch { return false; /* the in-process counter and log line still carry the signal */ }
}

export interface OperationFailureSummary {
  window_days: number;
  total: number;
  operations: Array<{ operation: OperationName; category: FailureCategory; count: number; last_at: number }>;
}

/** Failures in the last `days` days, most frequent first. */
export function operationFailureSummary(db: DatabaseSyncInstance, days = 7, now = Date.now()): OperationFailureSummary {
  const window = Math.max(1, Math.min(RETENTION_DAYS, Math.floor(days)));
  let rows: Array<{ operation: string; category: string; count: number; last_at: number }> = [];
  try {
    rows = db.prepare(`SELECT operation, category, SUM(count) AS count, MAX(last_at) AS last_at FROM mnemora_operation_failures
      WHERE day >= ? GROUP BY operation, category ORDER BY count DESC, operation, category LIMIT 100`).all(Math.floor(now / DAY_MS) - window + 1) as typeof rows;
  } catch { rows = []; /* older or read-only databases without the table report no failures */ }
  const operations = rows.filter(row => OPERATION_NAMES.includes(row.operation as OperationName) && FAILURE_CATEGORIES.includes(row.category as FailureCategory))
    .map(row => ({ operation: row.operation as OperationName, category: row.category as FailureCategory, count: Number(row.count), last_at: Number(row.last_at) }));
  return { window_days: window, total: operations.reduce((sum, row) => sum + row.count, 0), operations };
}

/**
 * Process-local reporter: persists when a database is available, keeps an
 * in-memory count when it is not, and emits at most one log line per
 * operation and category per interval, so an outage cannot flood the host log.
 */
export class OperationFailureReporter {
  private readonly counts = new Map<string, number>();
  private readonly lastLogged = new Map<string, number>();
  private readonly suppressed = new Map<string, number>();
  constructor(private readonly options: { warn?: (message: string, fields: Record<string, string | number>) => void; now?: () => number; logIntervalMs?: number } = {}) {}

  report(operation: OperationName, error: unknown, db?: DatabaseSyncInstance, options?: { log?: boolean }): void {
    let category: FailureCategory = "error";
    try { category = failureCategory(error); } catch { /* unclassifiable errors count as "error" */ }
    this.reportCategory(operation, category, db, options);
  }

  /** `log: false` for callers that already emit their own bounded log line. */
  reportCategory(operation: OperationName, category: FailureCategory, db?: DatabaseSyncInstance, options?: { log?: boolean }): void {
    try {
      const key = `${operation}:${category}`, now = this.options.now?.() ?? Date.now();
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
      recordOperationFailure(db, { operation, category }, now);
      if (options?.log === false) return;
      const last = this.lastLogged.get(key);
      if (last !== undefined && now - last < (this.options.logIntervalMs ?? 600_000)) { this.suppressed.set(key, (this.suppressed.get(key) ?? 0) + 1); return; }
      const suppressed = this.suppressed.get(key) ?? 0;
      this.lastLogged.set(key, now); this.suppressed.delete(key);
      this.options.warn?.("Mnemora operation failed (fail-open)", { operation, category, ...(suppressed ? { suppressed } : {}) });
    } catch { /* reporting itself is fail-open */ }
  }

  /** Failures seen by this process, including ones that could not be persisted. */
  snapshot(): Array<{ operation: OperationName; category: FailureCategory; count: number }> {
    return [...this.counts].map(([key, count]) => { const [operation, category] = key.split(":"); return { operation: operation as OperationName, category: category as FailureCategory, count }; });
  }
}
