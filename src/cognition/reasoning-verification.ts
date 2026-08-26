import { randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { authorizeMnemoraContextRef } from "../context/context-ref.js";
import { normalizeScope } from "../scope.js";
import { ReasoningDeliveryFeedbackRepository } from "./reasoning-delivery-feedback.js";
import { ReasoningMemoryService, type ReasoningVerificationAssertion } from "./reasoning.js";

type ToolResult = "success" | "failure";
type OutcomeVerdict = "success" | "failure" | "partial" | "unknown";
type AssertionKind = ReasoningVerificationAssertion["kind"];
type VerificationVerdict = "matched" | "mismatched";
type VerificationStatus = "pending" | "processed";
type Row = Record<string, unknown>;

export interface ReasoningVerificationEvent {
  id: string;
  scope: string;
  deliveryItemId: string;
  memoryId: string;
  assertionKind: AssertionKind;
  assertionOrdinal: number;
  assertionKey: string;
  expected: "success" | "failure" | "partial" | "true";
  observed: "success" | "failure" | "partial" | "true";
  verdict: VerificationVerdict;
  sourceKind: "tool_result" | "task_outcome" | "strategy_adoption";
  sourceRef: string;
  status: VerificationStatus;
  createdAt: number;
  processedAt?: number;
}

export interface ReasoningVerificationRun { processed: number; matched: number; mismatched: number; circuitsOpened: number; }
export interface ReasoningVerificationSummary { version: "reasoning-verification-summary-v1"; scope: string; pending: number; processed: number; matched: number; mismatched: number; }

/**
 * A local, deterministic worker for an operator-confirmed strategy contract.
 * It stores only normalized assertion values and bounded references; it never
 * calls a model, inspects a tool payload, writes memory facts, or changes a
 * ReasoningMemory record.
 */
export class ReasoningVerificationService {
  private readonly memories: ReasoningMemoryService;
  private readonly feedback: ReasoningDeliveryFeedbackRepository;
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {
    this.memories = new ReasoningMemoryService(db, now);
    this.feedback = new ReasoningDeliveryFeedbackRepository(db, now);
  }

  /** Called by TaskOutcome after its operator-confirmed record is durable. A
   * cited receipt is also the only deterministic adoption signal. */
  enqueueTaskOutcome(input: { scope: string; outcomeRef: string; verdict: OutcomeVerdict; evidenceRefs: readonly string[] }): { queued: number } {
    if (!(["success", "failure", "partial", "unknown"] as const).includes(input.verdict)) throw new Error("invalid_reasoning_verification");
    if (input.verdict === "unknown") return { queued: 0 };
    const scope = normalizeScope(input.scope), sourceRef = contextRef(input.outcomeRef, scope, ["task-outcome"]), itemIds = deliveryItems(input.evidenceRefs, scope);
    let queued = 0;
    for (const itemId of itemIds) {
      queued += this.enqueue(itemId, scope, "task_outcome", sourceRef, input.verdict, undefined);
      queued += this.enqueue(itemId, scope, "strategy_adoption", sourceRef, "true", undefined);
    }
    return { queued };
  }

  /** Provider adapters and operators may report a normalized tool status. A
   * source reference is mandatory for idempotency; raw output is not accepted. */
  recordToolResult(input: { scope: string; itemRef: unknown; tool: string; result: ToolResult; sourceRef: string }): { queued: number } {
    if (!(["success", "failure"] as const).includes(input.result)) throw new Error("invalid_reasoning_verification");
    const scope = normalizeScope(input.scope), reference = authorizeMnemoraContextRef(input.itemRef, { scope, kinds: ["reasoning-delivery-item"] }), tool = identifier(input.tool), sourceRef = source(input.sourceRef);
    if (!tool || !sourceRef) throw new Error("invalid_reasoning_verification");
    return { queued: this.enqueue(reference.id, scope, "tool_result", sourceRef, input.result, tool) };
  }

  /** Processes a short local batch atomically. A crash leaves every event
   * pending, so the next run can retry without an external lease or model call. */
  run(input: { scope: string; limit?: number }): ReasoningVerificationRun {
    const scope = normalizeScope(input.scope), limit = bounded(input.limit, 5, 1, 20), now = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare("SELECT * FROM mnemora_reasoning_runtime_verification_events WHERE scope=? AND status='pending' ORDER BY created_at ASC,assertion_ordinal ASC,id ASC LIMIT ?").all(scope, limit) as Row[];
      let matched = 0, mismatched = 0, circuitsOpened = 0;
      for (const row of rows) {
        const event = eventRow(row);
        if (event.verdict === "mismatched") { mismatched++; if (this.feedback.openVerificationCircuit(scope, event.memoryId, true).opened) circuitsOpened++; }
        else matched++;
        this.db.prepare("UPDATE mnemora_reasoning_runtime_verification_events SET status='processed',processed_at=? WHERE id=? AND scope=? AND status='pending'").run(now, event.id, scope);
      }
      this.db.exec("COMMIT");
      return { processed: rows.length, matched, mismatched, circuitsOpened };
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  events(scope: string, limit = 50): ReasoningVerificationEvent[] {
    const safe = normalizeScope(scope);
    const rows = this.db.prepare("SELECT * FROM mnemora_reasoning_runtime_verification_events WHERE scope=? ORDER BY created_at ASC,assertion_ordinal ASC,id ASC LIMIT ?").all(safe, bounded(limit, 50, 1, 100)) as Row[];
    return rows.map(eventRow);
  }

  summary(scope: string): ReasoningVerificationSummary {
    const safe = normalizeScope(scope), row = this.db.prepare("SELECT SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN status='processed' THEN 1 ELSE 0 END) AS processed,SUM(CASE WHEN verdict='matched' THEN 1 ELSE 0 END) AS matched,SUM(CASE WHEN verdict='mismatched' THEN 1 ELSE 0 END) AS mismatched FROM mnemora_reasoning_runtime_verification_events WHERE scope=?").get(safe) as Row;
    return { version: "reasoning-verification-summary-v1", scope: safe, pending: count(row.pending), processed: count(row.processed), matched: count(row.matched), mismatched: count(row.mismatched) };
  }

  private enqueue(itemId: string, scope: string, sourceKind: "tool_result" | "task_outcome" | "strategy_adoption", sourceRef: string, observed: "success" | "failure" | "partial" | "true", tool: string | undefined): number {
    const item = this.db.prepare("SELECT memory_id FROM mnemora_reasoning_runtime_delivery_items WHERE id=? AND scope=?").get(itemId, scope) as { memory_id?: unknown } | undefined;
    if (!item) return 0;
    const memory = this.memories.get(String(item.memory_id), scope), assertions = memory?.verification?.assertions ?? [], now = this.now();
    let queued = 0;
    for (const [ordinal, assertion] of assertions.entries()) {
      if (assertion.kind !== sourceKind || assertion.kind === "tool_result" && assertion.tool !== tool) continue;
      const expected = assertion.kind === "strategy_adoption" ? "true" : assertion.expected;
      const key = assertionKey(assertion);
      const result = this.db.prepare("INSERT OR IGNORE INTO mnemora_reasoning_runtime_verification_events(id,scope,delivery_item_id,memory_id,assertion_kind,assertion_ordinal,assertion_key,expected_value,observed_value,verdict,source_kind,source_ref,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'pending',?)").run(`reasoning-verification:${randomUUID()}`, scope, itemId, memory!.id, assertion.kind, ordinal, key, expected, observed, expected === observed ? "matched" : "mismatched", sourceKind, sourceRef, now) as { changes?: unknown };
      queued += Number(result.changes) === 1 ? 1 : 0;
    }
    return queued;
  }
}

function deliveryItems(values: readonly string[], scope: string): string[] {
  const ids = new Set<string>();
  for (const value of values.slice(0, 50)) {
    try { ids.add(authorizeMnemoraContextRef(value, { scope, kinds: ["reasoning-delivery-item"] }).id); } catch { /* non-receipt evidence is irrelevant to verification */ }
  }
  return [...ids];
}
function contextRef(value: unknown, scope: string, kinds: readonly ["task-outcome"]): string { return authorizeMnemoraContextRef(value, { scope, kinds }).canonical; }
function source(value: unknown): string | undefined { return typeof value === "string" && /^[a-z0-9][a-z0-9:_-]{0,119}$/i.test(value) ? value : undefined; }
function identifier(value: unknown): string | undefined { return typeof value === "string" && /^[a-z0-9][a-z0-9:_-]{0,79}$/i.test(value) ? value.toLowerCase() : undefined; }
function assertionKey(value: ReasoningVerificationAssertion): string { return value.kind === "tool_result" ? `tool_result:${value.tool}:${value.expected}` : value.kind === "task_outcome" ? `task_outcome:${value.expected}` : "strategy_adoption:true"; }
function bounded(value: unknown, fallback: number, min: number, max: number): number { return Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.trunc(Number(value)))) : fallback; }
function count(value: unknown): number { return Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0; }
function eventRow(row: Row): ReasoningVerificationEvent { return { id: String(row.id), scope: String(row.scope), deliveryItemId: String(row.delivery_item_id), memoryId: String(row.memory_id), assertionKind: row.assertion_kind as AssertionKind, assertionOrdinal: Number(row.assertion_ordinal), assertionKey: String(row.assertion_key), expected: row.expected_value as ReasoningVerificationEvent["expected"], observed: row.observed_value as ReasoningVerificationEvent["observed"], verdict: row.verdict as VerificationVerdict, sourceKind: row.source_kind as ReasoningVerificationEvent["sourceKind"], sourceRef: String(row.source_ref), status: row.status as VerificationStatus, createdAt: Number(row.created_at), ...(row.processed_at == null ? {} : { processedAt: Number(row.processed_at) }) }; }
