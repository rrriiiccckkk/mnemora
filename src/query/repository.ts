import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import type { QueryAuditPlanV1, QueryPlanV1 } from "./types.js";
import { normalizeQueryPlan } from "./validation.js";
import { watchPlanHash, type DigestClaim, type KgDigestResult, type KgWatch, type WatchScheduleHint } from "./watch.js";

export interface QueryRunRecord {
  id: string; plan_hash: string; plan_metadata: QueryAuditPlanV1;
  scope: string;
  status: "succeeded" | "failed" | "truncated"; graph_revision: number; result_count: number;
  duration_ms: number; error_category?: string; created_at: number;
}

export interface NewQueryRunRecord extends Omit<QueryRunRecord, "id" | "plan_hash" | "plan_metadata" | "scope"> {
  id?: string;
  plan: QueryPlanV1;
  scope?: string;
  retention_days?: number;
}

/**
 * Owns the bounded persistence lifecycle for query watches, digest receipts,
 * and redacted query audit records. GraphologyStore remains the public
 * compatibility facade so callers do not need to know about its SQLite
 * transactions, scope-touching invariant, or retention bookkeeping.
 */
export class QueryPersistenceRepository {
  constructor(private readonly db: DatabaseSyncInstance, private readonly touchScope: (scope: string) => void) {}

  createWatch(input: { id: string; name: string; plan: QueryPlanV1; scope: string; schedule_hint: WatchScheduleHint; enabled: boolean; now: number; maxWatches: number }): KgWatch {
    const plan = canonicalQueryPlan(normalizeQueryPlan(input.plan));
    const scope = normalizeScope(input.scope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const count = Number((this.db.prepare("SELECT COUNT(*) AS count FROM kg_watches").get() as { count: number }).count);
      if (count >= Math.min(100, Math.max(1, Math.trunc(input.maxWatches)))) throw new Error("watch limit reached");
      this.db.prepare("INSERT INTO kg_watches(id,name,normalized_plan,plan_hash,scope,schedule_hint,cursor,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?,?)")
        .run(input.id, input.name, JSON.stringify(plan), watchPlanHash(plan), scope, input.schedule_hint, input.enabled ? 1 : 0, input.now, input.now);
      this.touchScope(scope);
      this.db.exec("COMMIT");
      return this.getWatch(input.id)!;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  getWatch(id: string): KgWatch | undefined {
    const row = this.db.prepare("SELECT * FROM kg_watches WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? mapWatch(row) : undefined;
  }

  listWatches(limit = 100, scope?: string): KgWatch[] {
    const bounded = Math.min(100, Math.max(0, Number.isFinite(limit) ? Math.trunc(limit) : 0));
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    return (this.db.prepare("SELECT * FROM kg_watches WHERE (? IS NULL OR scope=?) ORDER BY created_at,id LIMIT ?").all(normalizedScope ?? null, normalizedScope ?? null, bounded) as Array<Record<string, unknown>>).map(mapWatch);
  }

  updateWatch(id: string, input: { name: string; plan: QueryPlanV1; scope: string; schedule_hint: WatchScheduleHint; enabled: boolean; now: number }): KgWatch {
    const plan = canonicalQueryPlan(normalizeQueryPlan(input.plan));
    const scope = normalizeScope(input.scope);
    const changed = this.db.prepare("UPDATE kg_watches SET name=?,normalized_plan=?,plan_hash=?,scope=?,schedule_hint=?,enabled=?,updated_at=? WHERE id=?")
      .run(input.name, JSON.stringify(plan), watchPlanHash(plan), scope, input.schedule_hint, input.enabled ? 1 : 0, input.now, id);
    if (Number(changed.changes) !== 1) throw new Error("watch not found");
    this.touchScope(scope);
    return this.getWatch(id)!;
  }

  removeWatch(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM kg_watches WHERE id=?").run(id).changes) === 1;
  }

  selectDigestWatches(ids: string[] | undefined, limit: number, scope?: string): KgWatch[] {
    const bounded = Math.min(25, Math.max(1, Math.trunc(limit)));
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    if (ids) return ids.map(id => this.getWatch(id)).filter((watch): watch is KgWatch => watch != null && watch.enabled && (!normalizedScope || watch.scope === normalizedScope)).slice(0, bounded);
    return (this.db.prepare("SELECT * FROM kg_watches WHERE enabled=1 AND (? IS NULL OR scope=?) ORDER BY id LIMIT ?").all(normalizedScope ?? null, normalizedScope ?? null, bounded) as Array<Record<string, unknown>>).map(mapWatch);
  }

  claimDigest(idempotencyKey: string, watchIds: string[], scope: string, now: number, staleAfterMs: number): DigestClaim {
    const normalizedScope = normalizeScope(scope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT status,summary,started_at,watch_ids,scope FROM kg_digest_runs WHERE idempotency_key=?").get(idempotencyKey) as { status: string; summary: string | null; started_at: number; watch_ids: string; scope: string } | undefined;
      if (!row) this.db.prepare("INSERT INTO kg_digest_runs(idempotency_key,status,scope,watch_ids,started_at) VALUES(?,'running',?,?,?)").run(idempotencyKey, normalizedScope, JSON.stringify(watchIds), now);
      else if (row.scope !== normalizedScope) throw new Error("idempotency_key belongs to another scope");
      else if (row.status === "succeeded" && row.summary) { const result = JSON.parse(row.summary) as KgDigestResult; this.db.exec("COMMIT"); return { status: "succeeded", result }; }
      else if (row.status === "running" && now - Number(row.started_at) < staleAfterMs) { this.db.exec("COMMIT"); return { status: "running", startedAt: Number(row.started_at), watchIds: JSON.parse(row.watch_ids) as string[] }; }
      else this.db.prepare("UPDATE kg_digest_runs SET status='running',watch_ids=?,cursor_updates='{}',summary=NULL,started_at=?,finished_at=NULL WHERE idempotency_key=?").run(JSON.stringify(watchIds), now, idempotencyKey);
      this.db.exec("COMMIT");
      return { status: "claimed", startedAt: now, watchIds };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  finishDigest(idempotencyKey: string, startedAt: number, result: KgDigestResult, cursorUpdates: Record<string, number>): KgDigestResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT status,started_at,summary,watch_ids FROM kg_digest_runs WHERE idempotency_key=?").get(idempotencyKey) as { status: string; started_at: number; summary: string | null; watch_ids: string } | undefined;
      if (!current || current.status !== "running" || Number(current.started_at) !== startedAt) {
        this.db.exec("COMMIT");
        if (current?.status === "succeeded" && current.summary) return JSON.parse(current.summary) as KgDigestResult;
        let selectedCount = 0;
        try { const ids = JSON.parse(current?.watch_ids ?? "[]"); selectedCount = Array.isArray(ids) ? ids.length : 0; } catch { /* bounded empty state */ }
        return { idempotency_key: idempotencyKey, status: "running", started_at: Number(current?.started_at ?? startedAt), selected_count: selectedCount, succeeded_count: 0, failed_count: 0, watches: [], warnings: [{ category: "already_running" }] };
      }
      for (const [id, cursor] of Object.entries(cursorUpdates)) this.db.prepare("UPDATE kg_watches SET cursor=?,updated_at=MAX(updated_at,?) WHERE id=?").run(String(cursor), cursor, id);
      this.db.prepare("UPDATE kg_digest_runs SET status='succeeded',cursor_updates=?,summary=?,finished_at=? WHERE idempotency_key=? AND status='running' AND started_at=?")
        .run(JSON.stringify(cursorUpdates), JSON.stringify(result), result.finished_at ?? startedAt, idempotencyKey, startedAt);
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  recordQueryRun(record: NewQueryRunRecord): void {
    const createdAt = Number.isFinite(record.created_at) ? Math.trunc(record.created_at) : Date.now();
    const scope = normalizeScope(record.scope ?? "default");
    const plan = canonicalQueryPlan(normalizeQueryPlan(record.plan));
    const canonical = JSON.stringify(plan);
    const hash = createHash("sha256").update(canonical).digest("hex");
    const serialized = JSON.stringify(safeAuditQueryPlan(plan));
    this.db.prepare("INSERT INTO kg_query_runs(id,plan_hash,normalized_plan,scope,status,graph_revision,result_count,duration_ms,error_category,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(record.id ?? `query:${randomUUID()}`, hash, serialized, scope, record.status, nonNegativeInteger(record.graph_revision), nonNegativeInteger(record.result_count), nonNegativeInteger(record.duration_ms), record.error_category ?? null, createdAt);
    this.maintainQueryRuns(createdAt, record.retention_days ?? 30);
  }

  listQueryRuns(limit: number, scope?: string): QueryRunRecord[] {
    const bounded = Number.isFinite(limit) ? Math.min(1000, Math.max(0, Math.trunc(limit))) : 0;
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    const rows = this.db.prepare("SELECT * FROM kg_query_runs WHERE (? IS NULL OR scope=?) ORDER BY created_at DESC,id DESC LIMIT ?").all(normalizedScope ?? null, normalizedScope ?? null, bounded) as Array<Record<string, unknown>>;
    return rows.map(row => ({ id: String(row.id), plan_hash: String(row.plan_hash), plan_metadata: JSON.parse(String(row.normalized_plan)) as QueryAuditPlanV1, scope: normalizeScope(row.scope, "default"), status: row.status as QueryRunRecord["status"], graph_revision: Number(row.graph_revision), result_count: Number(row.result_count), duration_ms: Number(row.duration_ms), ...(typeof row.error_category === "string" ? { error_category: row.error_category } : {}), created_at: Number(row.created_at) }));
  }

  private maintainQueryRuns(now: number, retentionDays: number): void {
    const retention = Number.isFinite(retentionDays) ? Math.min(3650, Math.max(1, Math.trunc(retentionDays))) : 30;
    const state = this.db.prepare("SELECT value FROM kg_maintenance_state WHERE key='query_audit_maintained_at'").get() as { value: string } | undefined;
    const previous = Number(state?.value ?? 0);
    if (Number.isFinite(previous) && now - previous < 86400000) return;
    const cutoff = now - retention * 86400000;
    this.db.prepare("DELETE FROM kg_query_runs WHERE id IN (SELECT id FROM kg_query_runs WHERE created_at < ? ORDER BY created_at LIMIT 1000)").run(cutoff);
    this.db.prepare("INSERT INTO kg_maintenance_state(key,value,updated_at) VALUES('query_audit_maintained_at',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(String(now), now);
  }
}

function canonicalQueryPlan(plan: QueryPlanV1): QueryPlanV1 {
  return { version: 1, steps: plan.steps.map(step => {
    if (step.op === "lookup") return { op: "lookup", query: step.query, ...(step.node_types === undefined ? {} : { node_types: [...step.node_types] }), ...(step.mode === undefined ? {} : { mode: step.mode }) };
    if (step.op === "traverse") return { op: "traverse", from: [...step.from], ...(step.edge_types === undefined ? {} : { edge_types: [...step.edge_types] }), direction: step.direction, depth: step.depth };
    if (step.op === "filter") return { op: "filter", ...(step.node_types === undefined ? {} : { node_types: [...step.node_types] }), ...(step.confidence_min === undefined ? {} : { confidence_min: step.confidence_min }), ...(step.valid_from === undefined ? {} : { valid_from: step.valid_from }), ...(step.valid_to === undefined ? {} : { valid_to: step.valid_to }) };
    if (step.op === "aggregate") return { op: "aggregate", by: step.by, metric: step.metric };
    throw new Error("invalid query audit plan");
  }), order_by: plan.order_by, limit: plan.limit };
}

function safeAuditQueryPlan(plan: QueryPlanV1): QueryAuditPlanV1 {
  return { kind: "query_audit_plan", version: 1, steps: plan.steps.map(step => {
    if (step.op === "lookup") return { op: "lookup", query_redacted: true, ...(step.node_types === undefined ? {} : { node_types: [...step.node_types] }), ...(step.mode === undefined ? {} : { mode: step.mode }) };
    if (step.op === "traverse") return { op: "traverse", from_previous: step.from.includes("$previous"), explicit_entity_count: step.from.filter(value => value !== "$previous").length, ...(step.edge_types === undefined ? {} : { edge_types: [...step.edge_types] }), direction: step.direction, depth: step.depth };
    if (step.op === "filter") return { op: "filter", ...(step.node_types === undefined ? {} : { node_types: [...step.node_types] }), ...(step.confidence_min === undefined ? {} : { confidence_min: step.confidence_min }), ...(step.valid_from === undefined ? {} : { valid_from: step.valid_from }), ...(step.valid_to === undefined ? {} : { valid_to: step.valid_to }) };
    if (step.op === "aggregate") return { op: "aggregate", by: step.by, metric: step.metric };
    throw new Error("invalid query audit plan");
  }), order_by: plan.order_by, limit: plan.limit };
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function mapWatch(row: Record<string, unknown>): KgWatch {
  return { id: String(row.id), name: String(row.name), plan: normalizeQueryPlan(JSON.parse(String(row.normalized_plan))), plan_hash: String(row.plan_hash), scope: normalizeScope(row.scope, "default"), schedule_hint: row.schedule_hint as WatchScheduleHint, cursor: row.cursor == null ? null : Number(row.cursor), enabled: Number(row.enabled) === 1, created_at: Number(row.created_at), updated_at: Number(row.updated_at) };
}
