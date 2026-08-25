import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { authorizeMnemoraContextRef, createMnemoraContextRef, parseMnemoraContextRef } from "../context/context-ref.js";
import { normalizeScope } from "../scope.js";

export type ReasoningDeliveryFeedback = "helpful" | "neutral" | "harmful";
export type ReasoningDeliveryItemStatus = "delivered" | ReasoningDeliveryFeedback;
export type ReasoningMemoryCircuitReason = "harmful_delivery_feedback" | "harmful_task_outcome" | "operator_reset";

export interface ReasoningDeliveryItem {
  id: string;
  scope: string;
  deliveryRunId: string;
  memoryId: string;
  ordinal: number;
  status: ReasoningDeliveryItemStatus;
  adopted: boolean;
  expiresAt: number;
  feedbackAt?: number;
  createdAt: number;
  ref: string;
}

export interface ReasoningMemoryCircuit {
  scope: string;
  memoryId: string;
  open: boolean;
  reason: ReasoningMemoryCircuitReason;
  openedAt?: number;
  updatedAt: number;
}

export interface ReasoningDeliveryFeedbackSummary {
  version: "reasoning-delivery-feedback-v1";
  scope: string;
  deliveredItems: number;
  adoptedItems: number;
  helpfulItems: number;
  neutralItems: number;
  harmfulItems: number;
  /** Immutable receipts remain available for audit after expiry, but they are
   * not eligible for new feedback or current-window coverage metrics. */
  feedbackEligibleItems: number;
  expiredItems: number;
  openMemoryCircuits: number;
  feedbackCoverage: number;
  adoptionRate: number;
  helpfulRate: number;
  harmfulRate: number;
}

type ItemRow = Record<string, unknown>;
const bounded = (value: unknown, fallback: number, min: number, max: number) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.floor(Number(value)))) : fallback;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const signalRef = (value: string | undefined) => typeof value === "string" ? value.slice(0, 1024) : "";

/**
 * Evidence-only link between an individual delivered strategy and an objective
 * signal. It never updates a ReasoningMemory, its utility, personal memory,
 * or graph facts. A harmful signal merely opens a local delivery circuit so
 * that strategy is withheld until an operator explicitly resets it.
 */
export class ReasoningDeliveryFeedbackRepository {
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {}

  createItems(input: { scope: string; deliveryRunId: string; items: Array<{ id: string; memoryId: string }>; retentionDays: number }): ReasoningDeliveryItem[] {
    const scope = normalizeScope(input.scope), now = this.now(), expiresAt = now + bounded(input.retentionDays, 30, 1, 365) * 86_400_000;
    const selected = input.items.slice(0, 12);
    if (!selected.length) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.db.prepare("SELECT 1 FROM mnemora_reasoning_runtime_delivery_runs WHERE id=? AND scope=? AND status='delivered'").get(input.deliveryRunId, scope);
      if (!run) throw new Error("invalid_reasoning_delivery_run");
      const memory = this.db.prepare("SELECT 1 FROM mnemora_reasoning_memories WHERE id=? AND scope=? AND state='admitted'");
      const insert = this.db.prepare("INSERT INTO mnemora_reasoning_runtime_delivery_items(id,scope,delivery_run_id,memory_id,ordinal,status,adopted,expires_at,created_at) VALUES(?,?,?,?,?,'delivered',0,?,?)");
      for (const [ordinal, item] of selected.entries()) {
        if (!validId(item.id) || !validId(item.memoryId) || !memory.get(item.memoryId, scope)) throw new Error("invalid_reasoning_delivery_item");
        insert.run(item.id, scope, input.deliveryRunId, item.memoryId, ordinal, expiresAt, now);
      }
      this.db.exec("COMMIT");
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
    return selected.map(item => this.get(item.id, scope)!).filter(Boolean);
  }

  get(id: string, scope: string): ReasoningDeliveryItem | undefined {
    const row = this.db.prepare("SELECT * FROM mnemora_reasoning_runtime_delivery_items WHERE id=? AND scope=?").get(id, normalizeScope(scope)) as ItemRow | undefined;
    return row ? item(row) : undefined;
  }

  getByRef(value: unknown, scope: string): ReasoningDeliveryItem | undefined {
    const reference = authorizeMnemoraContextRef(value, { scope, kinds: ["reasoning-delivery-item"] });
    return this.get(reference.id, reference.scope);
  }

  items(scope: string, limit = 50): ReasoningDeliveryItem[] {
    const rows = this.db.prepare("SELECT * FROM mnemora_reasoning_runtime_delivery_items WHERE scope=? ORDER BY created_at DESC,id DESC LIMIT ?").all(normalizeScope(scope), bounded(limit, 50, 1, 100)) as ItemRow[];
    return rows.map(item);
  }

  circuit(scope: string, memoryId: string): ReasoningMemoryCircuit | undefined {
    const row = this.db.prepare("SELECT scope,memory_id,circuit_open,reason_code,opened_at,updated_at FROM mnemora_reasoning_memory_delivery_circuits WHERE scope=? AND memory_id=?").get(normalizeScope(scope), memoryId) as ItemRow | undefined;
    return row ? circuit(row) : undefined;
  }

  isCircuitOpen(scope: string, memoryId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM mnemora_reasoning_memory_delivery_circuits WHERE scope=? AND memory_id=? AND circuit_open=1").get(normalizeScope(scope), memoryId));
  }

  feedbackPreview(itemRef: unknown, scope: string, feedback: ReasoningDeliveryFeedback): { status: "not_found" | "expired" } | { status: "preview"; preview_hash: string; item: ReasoningDeliveryItem } {
    if (!["helpful", "neutral", "harmful"].includes(feedback)) throw new Error("invalid_reasoning_delivery_feedback");
    let value: ReasoningDeliveryItem | undefined;
    try { value = this.getByRef(itemRef, scope); } catch { return { status: "not_found" }; }
    if (!value) return { status: "not_found" };
    if (value.expiresAt < this.now()) return { status: "expired" };
    return { status: "preview", preview_hash: digest({ version: "reasoning-delivery-item-feedback-v1", itemId: value.id, scope: value.scope, feedback, updatedAt: value.feedbackAt ?? value.createdAt }), item: value };
  }

  feedback(itemRef: unknown, scope: string, feedback: ReasoningDeliveryFeedback, previewHash: string): { status: "not_found" | "expired" | "stale_preview" } | { status: "confirmed"; circuitOpened: boolean; item: ReasoningDeliveryItem } {
    const preview = this.feedbackPreview(itemRef, scope, feedback);
    if (preview.status !== "preview") return preview;
    if (!previewHash || previewHash !== preview.preview_hash) return { status: "stale_preview" };
    const result = this.apply({ item: preview.item, effect: feedback, signalKind: "operator_feedback", sourceRef: "operator" });
    return { status: "confirmed", circuitOpened: result.circuitOpened, item: result.item };
  }

  /** Record an immutable task outcome as deterministic feedback only when the
   * outcome explicitly cites a delivery-item reference. */
  observeTaskOutcome(input: { scope: string; outcomeRef: string; impact: ReasoningDeliveryFeedback; evidenceRefs: readonly string[]; withinTransaction?: boolean }): { observed: number; circuitOpened: number } {
    const scope = normalizeScope(input.scope);
    if (!["helpful", "neutral", "harmful"].includes(input.impact)) throw new Error("invalid_reasoning_delivery_feedback");
    let observed = 0, circuitOpened = 0;
    for (const evidenceRef of [...new Set(input.evidenceRefs)].slice(0, 50)) {
      let reference;
      try { reference = parseMnemoraContextRef(evidenceRef); } catch { continue; }
      if (reference.scope !== scope || reference.kind !== "reasoning-delivery-item") continue;
      const value = this.get(reference.id, scope);
      if (!value || value.expiresAt < this.now()) continue;
      const result = this.apply({ item: value, effect: input.impact, signalKind: "task_outcome", sourceRef: input.outcomeRef, adoption: true }, input.withinTransaction === true);
      observed++;
      if (result.circuitOpened) circuitOpened++;
    }
    return { observed, circuitOpened };
  }

  resetPreview(memoryId: string, scope: string): { status: "not_found" } | { status: "preview"; preview_hash: string; circuit: ReasoningMemoryCircuit } {
    const value = this.circuit(scope, memoryId);
    if (!value?.open) return { status: "not_found" };
    return { status: "preview", preview_hash: digest({ version: "reasoning-memory-circuit-reset-v1", scope: value.scope, memoryId: value.memoryId, updatedAt: value.updatedAt }), circuit: value };
  }

  reset(memoryId: string, scope: string, previewHash: string): { status: "not_found" | "stale_preview" } | { status: "confirmed"; circuit: ReasoningMemoryCircuit } {
    const preview = this.resetPreview(memoryId, scope);
    if (preview.status !== "preview") return preview;
    if (!previewHash || previewHash !== preview.preview_hash) return { status: "stale_preview" };
    const now = this.now(), changed = this.db.prepare("UPDATE mnemora_reasoning_memory_delivery_circuits SET circuit_open=0,reason_code='operator_reset',updated_at=? WHERE scope=? AND memory_id=? AND circuit_open=1 AND updated_at=?").run(now, preview.circuit.scope, preview.circuit.memoryId, preview.circuit.updatedAt).changes;
    if (!changed) return { status: "stale_preview" };
    return { status: "confirmed", circuit: this.circuit(preview.circuit.scope, preview.circuit.memoryId)! };
  }

  summary(scope: string): ReasoningDeliveryFeedbackSummary {
    const safe = normalizeScope(scope), now = this.now(), row = this.db.prepare(`SELECT COUNT(*) AS delivered,
      SUM(CASE WHEN expires_at>=? THEN 1 ELSE 0 END) AS feedback_eligible,
      SUM(CASE WHEN expires_at<? THEN 1 ELSE 0 END) AS expired,
      SUM(CASE WHEN expires_at>=? AND adopted=1 THEN 1 ELSE 0 END) AS adopted,
      SUM(CASE WHEN expires_at>=? AND status='helpful' THEN 1 ELSE 0 END) AS helpful,
      SUM(CASE WHEN expires_at>=? AND status='neutral' THEN 1 ELSE 0 END) AS neutral,
      SUM(CASE WHEN expires_at>=? AND status='harmful' THEN 1 ELSE 0 END) AS harmful
      FROM mnemora_reasoning_runtime_delivery_items WHERE scope=?`).get(now, now, now, now, now, now, safe) as ItemRow;
    const deliveredItems = number(row.delivered), feedbackEligibleItems = number(row.feedback_eligible), expiredItems = number(row.expired), adoptedItems = number(row.adopted), helpfulItems = number(row.helpful), neutralItems = number(row.neutral), harmfulItems = number(row.harmful), feedbacked = helpfulItems + neutralItems + harmfulItems;
    const openMemoryCircuits = number((this.db.prepare("SELECT COUNT(*) AS value FROM mnemora_reasoning_memory_delivery_circuits WHERE scope=? AND circuit_open=1").get(safe) as ItemRow).value);
    return { version: "reasoning-delivery-feedback-v1", scope: safe, deliveredItems, feedbackEligibleItems, expiredItems, adoptedItems, helpfulItems, neutralItems, harmfulItems, openMemoryCircuits, feedbackCoverage: ratio(feedbacked, feedbackEligibleItems), adoptionRate: ratio(adoptedItems, feedbackEligibleItems), helpfulRate: ratio(helpfulItems, feedbacked), harmfulRate: ratio(harmfulItems, feedbacked) };
  }

  private apply(input: { item: ReasoningDeliveryItem; effect: ReasoningDeliveryFeedback; signalKind: "operator_feedback" | "task_outcome"; sourceRef: string; adoption?: boolean }, withinTransaction = false): { item: ReasoningDeliveryItem; circuitOpened: boolean } {
    const now = this.now(), scope = input.item.scope;
    if (!withinTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      let circuitOpened = false;
      if (input.adoption) this.event(scope, input.item.id, input.item.memoryId, "task_outcome", "adopted", input.sourceRef, now);
      const inserted = this.event(scope, input.item.id, input.item.memoryId, input.signalKind, input.effect, input.sourceRef, now);
      if (inserted) {
        const status = input.item.status === "harmful" ? "harmful" : input.effect;
        this.db.prepare("UPDATE mnemora_reasoning_runtime_delivery_items SET status=?,adopted=CASE WHEN ? THEN 1 ELSE adopted END,feedback_at=? WHERE id=? AND scope=?").run(status, input.adoption ? 1 : 0, now, input.item.id, scope);
        if (input.effect === "harmful") {
          const reason: ReasoningMemoryCircuitReason = input.signalKind === "task_outcome" ? "harmful_task_outcome" : "harmful_delivery_feedback";
          const prior = this.isCircuitOpen(scope, input.item.memoryId);
          this.db.prepare(`INSERT INTO mnemora_reasoning_memory_delivery_circuits(scope,memory_id,circuit_open,reason_code,opened_at,updated_at) VALUES(?,?,1,?,?,?)
            ON CONFLICT(scope,memory_id) DO UPDATE SET circuit_open=1,reason_code=excluded.reason_code,opened_at=excluded.opened_at,updated_at=excluded.updated_at`).run(scope, input.item.memoryId, reason, now, now);
          circuitOpened = !prior;
        }
      }
      const value = this.get(input.item.id, scope);
      if (!withinTransaction) this.db.exec("COMMIT");
      return { item: value!, circuitOpened };
    } catch (error) { if (!withinTransaction) try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  private event(scope: string, itemId: string, memoryId: string, signalKind: "operator_feedback" | "task_outcome", effect: "helpful" | "neutral" | "harmful" | "adopted", sourceRef: string, now: number): boolean {
    const id = `reasoning-delivery-feedback:${randomUUID()}`;
    const result = this.db.prepare("INSERT OR IGNORE INTO mnemora_reasoning_runtime_delivery_feedback_events(id,scope,delivery_item_id,memory_id,signal_kind,effect,source_ref,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, scope, itemId, memoryId, signalKind, effect, signalRef(sourceRef), now) as { changes?: unknown };
    return Number(result.changes) === 1;
  }
}

function item(row: ItemRow): ReasoningDeliveryItem {
  const scope = normalizeScope(String(row.scope));
  return { id: String(row.id), scope, deliveryRunId: String(row.delivery_run_id), memoryId: String(row.memory_id), ordinal: number(row.ordinal), status: row.status as ReasoningDeliveryItemStatus, adopted: Number(row.adopted) === 1, expiresAt: Number(row.expires_at), ...(row.feedback_at == null ? {} : { feedbackAt: Number(row.feedback_at) }), createdAt: Number(row.created_at), ref: createMnemoraContextRef({ scope, kind: "reasoning-delivery-item", id: String(row.id) }) };
}
function circuit(row: ItemRow): ReasoningMemoryCircuit { return { scope: normalizeScope(String(row.scope)), memoryId: String(row.memory_id), open: Number(row.circuit_open) === 1, reason: row.reason_code as ReasoningMemoryCircuitReason, ...(row.opened_at == null ? {} : { openedAt: Number(row.opened_at) }), updatedAt: Number(row.updated_at) }; }
function number(value: unknown): number { return Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0; }
function ratio(value: number, total: number): number { return total ? Number((value / total).toFixed(4)) : 0; }
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\\/%?#]/u.test(value); }
