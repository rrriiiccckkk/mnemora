import { createHash } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { authorizeMnemoraContextRef, type MnemoraContextRef } from "../context/context-ref.js";
import { normalizeScope } from "../scope.js";
import { reasoningTaskType } from "./reasoning-task-types.js";

export type ReasoningMemoryKind = "strategy" | "procedure" | "failure_guard" | "anti_pattern";
export type ReasoningMemoryState = "proposed" | "provisional" | "admitted" | "needs_review" | "quarantined" | "disabled" | "retired";
export interface ReasoningApplicability { taskTypes: string[]; riskLevels: Array<"low" | "medium" | "high">; environments: string[]; requiredTools: string[]; }
export interface ReasoningMemoryInput { scope: string; kind: ReasoningMemoryKind; strategy: string; applicability?: Partial<ReasoningApplicability>; contraindications?: string[]; sourceTaskRefs: string[]; outcomeRefs: string[]; evidenceRefs: string[]; confidence?: number; supersedesId?: string; }
export interface ReasoningMemory { id: string; scope: string; kind: ReasoningMemoryKind; strategy: string; applicability: ReasoningApplicability; contraindications: string[]; sourceTaskRefs: string[]; outcomeRefs: string[]; evidenceRefs: string[]; confidence: number; utilityScore: number; successCount: number; failureCount: number; degradedCount: number; state: ReasoningMemoryState; supersedesId?: string; createdAt: number; updatedAt: number; }
export interface ReasoningMemoryPreview { status: "preview"; preview_hash: string; candidate: Omit<ReasoningMemory, "id" | "state" | "createdAt" | "updatedAt">; }
export interface ReasoningTransitionInput { id: string; scope: string; toState: Exclude<ReasoningMemoryState, "proposed">; reasonCode: string; evidenceRefs?: string[]; }
export interface ReasoningConflict { leftId: string; rightId: string; kind: ReasoningMemoryKind; sharedApplicability: string[]; reason: "applicability_overlap"; }
const kinds = new Set<ReasoningMemoryKind>(["strategy", "procedure", "failure_guard", "anti_pattern"]);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clean = (value: unknown, max: number) => typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, max) : undefined;
const identifiers = (value: unknown, max: number) => Array.isArray(value) ? [...new Set(value.flatMap(item => typeof item === "string" && /^[a-z0-9][a-z0-9:_-]{0,79}$/i.test(item.trim()) ? [item.trim().toLowerCase()] : []))].slice(0, max) : [];
const riskLevels = new Set(["low", "medium", "high"]);

/**
 * v4.1 procedural cognition. This service is intentionally independent from
 * Beliefs, Profiles, graph facts, and automatic prompt assembly.
 */
export class ReasoningMemoryService {
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {}

  preview(input: ReasoningMemoryInput): ReasoningMemoryPreview {
    const candidate = this.normalize(input);
    return { status: "preview", preview_hash: hash({ version: "reasoning-memory-preview-v1", ...candidate }), candidate };
  }
  propose(input: ReasoningMemoryInput, previewHash: string): ReasoningMemory {
    const value = this.normalize(input), expected = hash({ version: "reasoning-memory-preview-v1", ...value });
    if (!previewHash || previewHash !== expected) throw new Error("invalid_reasoning_preview");
    const now = this.now(), contentHash = hash(value), id = `reasoning-memory:${contentHash.slice(0, 40)}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR IGNORE INTO kg_scopes(id,created_at,updated_at) VALUES(?,?,?)").run(value.scope, now, now);
      const existing = this.db.prepare("SELECT id FROM mnemora_reasoning_memories WHERE scope=? AND content_hash=?").get(value.scope, contentHash) as { id: string } | undefined;
      if (existing) { this.db.exec("COMMIT"); return this.get(existing.id, value.scope)!; }
      if (value.supersedesId) { const prior = this.get(value.supersedesId, value.scope); if (!prior || prior.state !== "admitted") throw new Error("invalid_reasoning_supersession"); }
      this.db.prepare("INSERT INTO mnemora_reasoning_memories(id,scope,kind,strategy,applicability_json,contraindications_json,source_task_refs_json,outcome_refs_json,evidence_refs_json,confidence,utility_score,success_count,failure_count,degraded_count,state,supersedes_id,content_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'proposed',?,?,?,?)").run(id, value.scope, value.kind, value.strategy, JSON.stringify(value.applicability), JSON.stringify(value.contraindications), JSON.stringify(value.sourceTaskRefs), JSON.stringify(value.outcomeRefs), JSON.stringify(value.evidenceRefs), value.confidence, value.utilityScore, value.successCount, value.failureCount, value.degradedCount, value.supersedesId ?? null, contentHash, now, now);
      this.event(value.scope, id, null, "proposed", "PROPOSE", "operator_confirmed", value.evidenceRefs, now);
      this.db.exec("COMMIT"); return this.get(id, value.scope)!;
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }
  admissionPreview(id: string, scope: string): { status: "preview"; preview_hash: string; memory: ReasoningMemory } {
    const memory = this.get(id, scope); if (!memory || memory.state !== "proposed") throw new Error("invalid_reasoning_admission");
    this.validateLineage(memory);
    return { status: "preview", preview_hash: hash({ version: "reasoning-admission-v1", id: memory.id, scope: memory.scope, evidence: memory.evidenceRefs, outcomes: memory.outcomeRefs, updatedAt: memory.updatedAt }), memory };
  }
  admit(id: string, scope: string, previewHash: string): ReasoningMemory {
    const preview = this.admissionPreview(id, scope); if (!previewHash || previewHash !== preview.preview_hash) throw new Error("invalid_reasoning_admission_preview");
    const now = this.now(); this.db.exec("BEGIN IMMEDIATE");
    try {
      const safe = normalizeScope(scope);
      if (preview.memory.supersedesId) {
        const prior = this.get(preview.memory.supersedesId, safe);
        if (!prior || prior.state !== "admitted") throw new Error("invalid_reasoning_supersession");
        const retired = this.db.prepare("UPDATE mnemora_reasoning_memories SET state='retired',updated_at=? WHERE id=? AND scope=? AND state='admitted'").run(now, prior.id, safe);
        if (retired.changes !== 1) throw new Error("stale_reasoning_admission");
        this.event(safe, prior.id, "admitted", "retired", "SUPERSEDE", "explicit_supersession", prior.evidenceRefs, now);
      }
      const admitted = this.db.prepare("UPDATE mnemora_reasoning_memories SET state='admitted',updated_at=? WHERE id=? AND scope=? AND state='proposed'").run(now, id, safe);
      if (admitted.changes !== 1) throw new Error("stale_reasoning_admission");
      this.event(safe, id, "proposed", "admitted", "ADMIT", "evidence_complete", preview.memory.evidenceRefs, now);
      this.db.exec("COMMIT"); return this.get(id, scope)!;
    }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }
  get(id: string, scope: string): ReasoningMemory | undefined { const row = this.db.prepare("SELECT * FROM mnemora_reasoning_memories WHERE id=? AND scope=?").get(id, normalizeScope(scope)) as Record<string, unknown> | undefined; return row ? this.read(row) : undefined; }
  list(scope: string, state?: ReasoningMemoryState, limit = 20): ReasoningMemory[] { const safe = normalizeScope(scope), rows = this.db.prepare(`SELECT * FROM mnemora_reasoning_memories WHERE scope=?${state ? " AND state=?" : ""} ORDER BY updated_at DESC,id DESC LIMIT ?`).all(safe, ...(state ? [state] : []), bounded(limit)) as Array<Record<string, unknown>>; return rows.map(row => this.read(row)); }
  find(scope: string, query: string, limit = 20): ReasoningMemory[] { const safe = normalizeScope(scope), q = clean(query, 512)?.toLowerCase(); if (!q) return []; const rows = this.db.prepare("SELECT * FROM mnemora_reasoning_memories WHERE scope=? AND state='admitted' AND instr(lower(strategy),?)>0 ORDER BY utility_score DESC,confidence DESC,updated_at DESC,id DESC LIMIT ?").all(safe, q, bounded(limit)) as Array<Record<string, unknown>>; return rows.map(row => this.read(row)); }
  summary(scope: string) { const safe = normalizeScope(scope), rows = this.db.prepare("SELECT state,kind,COUNT(*) AS value FROM mnemora_reasoning_memories WHERE scope=? GROUP BY state,kind").all(safe) as Array<{ state: string; kind: string; value: number }>; return { scope: safe, memories: rows.reduce((out, row) => ({ ...out, [`${row.state}:${row.kind}`]: Number(row.value) }), {} as Record<string, number>) }; }

  outcomeLinkPreview(id: string, scope: string, outcomeRef: string) {
    const memory = this.requireGovernable(id, scope), outcome = this.references([outcomeRef], memory.scope, "outcome")[0];
    return { status: "preview" as const, preview_hash: hash({ version: "reasoning-outcome-link-v1", id: memory.id, outcome, updatedAt: memory.updatedAt }), memory, outcomeRef: outcome };
  }
  linkOutcome(id: string, scope: string, outcomeRef: string, previewHash: string): ReasoningMemory {
    const preview = this.outcomeLinkPreview(id, scope, outcomeRef); if (!previewHash || previewHash !== preview.preview_hash) throw new Error("invalid_reasoning_outcome_preview");
    if (preview.memory.outcomeRefs.includes(preview.outcomeRef)) return preview.memory;
    const utility = this.utility([...preview.memory.outcomeRefs, preview.outcomeRef], preview.memory.scope), now = this.now(); this.db.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.db.prepare("UPDATE mnemora_reasoning_memories SET outcome_refs_json=?,utility_score=?,success_count=?,failure_count=?,degraded_count=?,updated_at=? WHERE id=? AND scope=? AND updated_at=?").run(JSON.stringify([...preview.memory.outcomeRefs, preview.outcomeRef]), utility.utilityScore, utility.successCount, utility.failureCount, utility.degradedCount, now, preview.memory.id, preview.memory.scope, preview.memory.updatedAt);
      if (updated.changes !== 1) throw new Error("stale_reasoning_governance");
      this.db.prepare("INSERT OR IGNORE INTO mnemora_reasoning_memory_outcomes(memory_id,scope,outcome_ref,linked_at) VALUES(?,?,?,?)").run(preview.memory.id, preview.memory.scope, preview.outcomeRef, now);
      this.governanceEvent(preview.memory.scope, preview.memory.id, null, null, "OUTCOME_LINK", "operator_confirmed", [preview.outcomeRef], now);
      this.db.exec("COMMIT"); return this.get(preview.memory.id, preview.memory.scope)!;
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }
  utilityPreview(id: string, scope: string) {
    const memory = this.requireGovernable(id, scope), utility = this.utility(memory.outcomeRefs, memory.scope);
    return { status: "preview" as const, preview_hash: hash({ version: "reasoning-utility-refresh-v1", id: memory.id, utility, updatedAt: memory.updatedAt }), memory, utility };
  }
  refreshUtility(id: string, scope: string, previewHash: string): ReasoningMemory {
    const preview = this.utilityPreview(id, scope); if (!previewHash || previewHash !== preview.preview_hash) throw new Error("invalid_reasoning_utility_preview");
    const now = this.now(), updated = this.db.prepare("UPDATE mnemora_reasoning_memories SET utility_score=?,success_count=?,failure_count=?,degraded_count=?,updated_at=? WHERE id=? AND scope=? AND updated_at=?").run(preview.utility.utilityScore, preview.utility.successCount, preview.utility.failureCount, preview.utility.degradedCount, now, preview.memory.id, preview.memory.scope, preview.memory.updatedAt);
    if (updated.changes !== 1) throw new Error("stale_reasoning_governance");
    this.governanceEvent(preview.memory.scope, preview.memory.id, null, null, "UTILITY_REFRESH", "operator_confirmed", preview.memory.outcomeRefs, now); return this.get(id, scope)!;
  }
  transitionPreview(input: ReasoningTransitionInput) {
    const memory = this.get(input.id, input.scope), reasonCode = reason(input.reasonCode); if (!memory || !reasonCode || !this.allowed(memory.state, input.toState)) throw new Error("invalid_reasoning_transition");
    const evidenceRefs = input.evidenceRefs === undefined ? memory.evidenceRefs : this.references(input.evidenceRefs, memory.scope, "evidence");
    if (!evidenceRefs.length) throw new Error("invalid_reasoning_evidence");
    return { status: "preview" as const, preview_hash: hash({ version: "reasoning-transition-v1", id: memory.id, from: memory.state, to: input.toState, reasonCode, evidenceRefs, updatedAt: memory.updatedAt }), memory, toState: input.toState, reasonCode, evidenceRefs };
  }
  transition(input: ReasoningTransitionInput, previewHash: string): ReasoningMemory {
    const preview = this.transitionPreview(input); if (!previewHash || previewHash !== preview.preview_hash) throw new Error("invalid_reasoning_transition_preview"); const now = this.now(); this.db.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.db.prepare("UPDATE mnemora_reasoning_memories SET state=?,updated_at=? WHERE id=? AND scope=? AND state=? AND updated_at=?").run(preview.toState, now, preview.memory.id, preview.memory.scope, preview.memory.state, preview.memory.updatedAt);
      if (updated.changes !== 1) throw new Error("stale_reasoning_governance");
      this.governanceEvent(preview.memory.scope, preview.memory.id, preview.memory.state, preview.toState, "TRANSITION", preview.reasonCode, preview.evidenceRefs, now);
      this.db.exec("COMMIT"); return this.get(preview.memory.id, preview.memory.scope)!;
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }
  rollbackPreview(id: string, scope: string) {
    const current = this.get(id, scope); if (!current?.supersedesId || current.state !== "admitted") throw new Error("invalid_reasoning_rollback");
    const prior = this.get(current.supersedesId, current.scope); if (!prior || prior.state !== "retired") throw new Error("invalid_reasoning_rollback");
    return { status: "preview" as const, preview_hash: hash({ version: "reasoning-rollback-v1", current: current.id, prior: prior.id, currentUpdatedAt: current.updatedAt, priorUpdatedAt: prior.updatedAt }), current, prior };
  }
  rollback(id: string, scope: string, previewHash: string): ReasoningMemory {
    const preview = this.rollbackPreview(id, scope); if (!previewHash || previewHash !== preview.preview_hash) throw new Error("invalid_reasoning_rollback_preview"); const now = this.now(); this.db.exec("BEGIN IMMEDIATE");
    try {
      const retired = this.db.prepare("UPDATE mnemora_reasoning_memories SET state='retired',updated_at=? WHERE id=? AND scope=? AND state='admitted' AND updated_at=?").run(now, preview.current.id, preview.current.scope, preview.current.updatedAt);
      const restored = this.db.prepare("UPDATE mnemora_reasoning_memories SET state='admitted',updated_at=? WHERE id=? AND scope=? AND state='retired' AND updated_at=?").run(now, preview.prior.id, preview.prior.scope, preview.prior.updatedAt);
      if (retired.changes !== 1 || restored.changes !== 1) throw new Error("stale_reasoning_governance");
      this.governanceEvent(preview.current.scope, preview.current.id, "admitted", "retired", "ROLLBACK", "operator_confirmed", preview.current.evidenceRefs, now, preview.prior.id);
      this.governanceEvent(preview.prior.scope, preview.prior.id, "retired", "admitted", "ROLLBACK", "operator_confirmed", preview.prior.evidenceRefs, now, preview.current.id);
      this.db.exec("COMMIT"); return this.get(preview.prior.id, preview.prior.scope)!;
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }
  history(id: string, scope: string, limit = 50) { const memory = this.get(id, scope); if (!memory) return []; return this.db.prepare("SELECT from_state AS fromState,to_state AS toState,action,reason_code AS reasonCode,evidence_refs_json AS evidenceRefs,created_at AS createdAt,related_memory_id AS relatedMemoryId FROM mnemora_reasoning_memory_governance_events WHERE memory_id=? AND scope=? ORDER BY created_at DESC,id DESC LIMIT ?").all(memory.id, memory.scope, bounded(limit)) as Array<Record<string, unknown>>; }
  conflicts(scope: string, limit = 50): ReasoningConflict[] { const values = this.list(normalizeScope(scope), undefined, 100).filter(item => item.state === "provisional" || item.state === "admitted"), result: ReasoningConflict[] = []; for (let left = 0; left < values.length; left++) for (let right = left + 1; right < values.length; right++) { const a = values[left], b = values[right]; if (a.kind !== b.kind || a.strategy === b.strategy) continue; const shared = applicabilityOverlap(a.applicability, b.applicability); if (shared.length) result.push({ leftId: a.id, rightId: b.id, kind: a.kind, sharedApplicability: shared, reason: "applicability_overlap" }); } return result.slice(0, bounded(limit)); }

  private normalize(input: ReasoningMemoryInput) {
    const scope = normalizeScope(input.scope), kind = input.kind, strategy = clean(input.strategy, 4096);
    if (!kinds.has(kind) || !strategy) throw new Error("invalid_reasoning_memory");
    const raw = input.applicability ?? {}, applicability: ReasoningApplicability = { taskTypes: [...new Set(identifiers(raw.taskTypes, 20).map(reasoningTaskType).filter((value): value is string => Boolean(value)))], riskLevels: identifiers(raw.riskLevels, 3).filter((value): value is "low" | "medium" | "high" => riskLevels.has(value)), environments: identifiers(raw.environments, 20), requiredTools: identifiers(raw.requiredTools, 20) };
    const contraindications = Array.isArray(input.contraindications) ? [...new Set(input.contraindications.flatMap(value => clean(value, 256) ?? []))].slice(0, 20) : [];
    const sourceTaskRefs = this.references(input.sourceTaskRefs, scope, "task"), outcomeRefs = this.references(input.outcomeRefs, scope, "outcome"), evidenceRefs = this.references(input.evidenceRefs, scope, "evidence");
    if (!sourceTaskRefs.length || !outcomeRefs.length || !evidenceRefs.length) throw new Error("invalid_reasoning_lineage");
    const confidence = input.confidence === undefined ? .5 : Number(input.confidence); if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("invalid_reasoning_memory");
    const utility = this.utility(outcomeRefs, scope), supersedesId = clean(input.supersedesId, 256);
    return { scope, kind, strategy, applicability, contraindications, sourceTaskRefs, outcomeRefs, evidenceRefs, confidence, ...utility, supersedesId };
  }
  private references(values: unknown, scope: string, purpose: "task" | "outcome" | "evidence"): string[] {
    const allowed = purpose === "task" ? ["episode", "decision"] as const : purpose === "outcome" ? ["task-outcome"] as const : ["conversation-event", "artifact", "episode", "claim", "decision"] as const;
    const refs = Array.isArray(values) ? values.slice(0, 50).map(value => authorizeMnemoraContextRef(value, { scope, kinds: allowed }).canonical) : [];
    for (const ref of refs) this.exists(authorizeMnemoraContextRef(ref, { scope, kinds: allowed }), purpose);
    return [...new Set(refs)];
  }
  private exists(reference: MnemoraContextRef, purpose: "task" | "outcome" | "evidence") {
    const sql = reference.kind === "episode" ? "SELECT 1 FROM mnemora_episodes WHERE id=? AND scope=? AND deleted_at IS NULL" : reference.kind === "decision" ? "SELECT 1 FROM mnemora_decisions WHERE id=? AND scope=?" : reference.kind === "task-outcome" ? "SELECT 1 FROM mnemora_task_outcomes WHERE id=? AND scope=? AND status='recorded'" : reference.kind === "conversation-event" ? "SELECT 1 FROM mnemora_conversation_events WHERE id=? AND scope=? AND deleted_at IS NULL" : reference.kind === "artifact" ? "SELECT 1 FROM mnemora_artifacts WHERE id=? AND scope=? AND deleted_at IS NULL" : "SELECT 1 FROM kg_observations WHERE id=? AND scope=?";
    if (!this.db.prepare(sql).get(reference.id, reference.scope)) throw new Error(purpose === "outcome" ? "invalid_reasoning_outcome" : purpose === "task" ? "invalid_reasoning_task" : "invalid_reasoning_evidence");
  }
  private utility(outcomes: string[], scope: string) { const rows = outcomes.flatMap(ref => { const parsed = authorizeMnemoraContextRef(ref, { scope, kinds: ["task-outcome"] }); const row = this.db.prepare("SELECT verdict,impact,status FROM mnemora_task_outcomes WHERE id=? AND scope=?").get(parsed.id, scope) as { verdict: string; impact: string; status: string } | undefined; return row?.status === "recorded" ? [row] : []; }); const successCount = rows.filter(row => row.verdict === "success").length, failureCount = rows.filter(row => row.verdict === "failure").length, degradedCount = rows.filter(row => row.verdict === "partial").length; const score = rows.length ? rows.reduce((total, row) => total + (row.impact === "helpful" ? 1 : row.impact === "harmful" ? -1 : 0), 0) / rows.length : 0; return { utilityScore: Number(score.toFixed(3)), successCount, failureCount, degradedCount }; }
  private validateLineage(memory: ReasoningMemory) { for (const ref of memory.sourceTaskRefs) this.exists(authorizeMnemoraContextRef(ref, { scope: memory.scope, kinds: ["episode", "decision"] }), "task"); for (const ref of memory.outcomeRefs) this.exists(authorizeMnemoraContextRef(ref, { scope: memory.scope, kinds: ["task-outcome"] }), "outcome"); for (const ref of memory.evidenceRefs) this.exists(authorizeMnemoraContextRef(ref, { scope: memory.scope, kinds: ["conversation-event", "artifact", "episode", "claim", "decision"] }), "evidence"); }
  private event(scope: string, memoryId: string, from: ReasoningMemoryState | null, to: ReasoningMemoryState, action: "PROPOSE" | "ADMIT" | "SUPERSEDE", reason: "operator_confirmed" | "evidence_complete" | "explicit_supersession", evidence: string[], now: number) { const id = `reasoning-event:${hash({ scope, memoryId, from, to, action, now }).slice(0, 40)}`; this.db.prepare("INSERT INTO mnemora_reasoning_memory_events(id,scope,memory_id,from_state,to_state,action,reason_code,evidence_refs_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, scope, memoryId, from, to, action, reason, JSON.stringify(evidence), now); }
  private requireGovernable(id: string, scope: string) { const memory = this.get(id, scope); if (!memory || !["provisional", "admitted", "needs_review"].includes(memory.state)) throw new Error("invalid_reasoning_governance"); return memory; }
  private allowed(from: ReasoningMemoryState, to: ReasoningMemoryState) { return ({ proposed: ["provisional", "admitted", "disabled", "retired"], provisional: ["admitted", "needs_review", "quarantined", "disabled", "retired"], admitted: ["needs_review", "quarantined", "disabled", "retired"], needs_review: ["provisional", "admitted", "quarantined", "disabled", "retired"], quarantined: ["provisional", "admitted", "disabled", "retired"], disabled: ["provisional", "retired"], retired: [] } as Record<ReasoningMemoryState, ReasoningMemoryState[]>)[from].includes(to); }
  private governanceEvent(scope: string, memoryId: string, from: ReasoningMemoryState | null, to: ReasoningMemoryState | null, action: "TRANSITION" | "OUTCOME_LINK" | "UTILITY_REFRESH" | "ROLLBACK", reasonCode: string, evidenceRefs: string[], now: number, relatedMemoryId?: string) { const id = `reasoning-governance:${hash({ scope, memoryId, from, to, action, reasonCode, relatedMemoryId, now }).slice(0, 40)}`; this.db.prepare("INSERT INTO mnemora_reasoning_memory_governance_events(id,scope,memory_id,related_memory_id,from_state,to_state,action,reason_code,evidence_refs_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, scope, memoryId, relatedMemoryId ?? null, from, to, action, reasonCode, JSON.stringify(evidenceRefs), now); }
  private read(row: Record<string, unknown>): ReasoningMemory { return { id: String(row.id), scope: String(row.scope), kind: row.kind as ReasoningMemoryKind, strategy: String(row.strategy), applicability: parseApplicability(row.applicability_json), contraindications: strings(row.contraindications_json), sourceTaskRefs: strings(row.source_task_refs_json), outcomeRefs: strings(row.outcome_refs_json), evidenceRefs: strings(row.evidence_refs_json), confidence: Number(row.confidence), utilityScore: Number(row.utility_score), successCount: Number(row.success_count), failureCount: Number(row.failure_count), degradedCount: Number(row.degraded_count), state: row.state as ReasoningMemoryState, ...(row.supersedes_id ? { supersedesId: String(row.supersedes_id) } : {}), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }; }
}
function strings(value: unknown): string[] { try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed.filter(item => typeof item === "string").slice(0, 50) : []; } catch { return []; } }
function parseApplicability(value: unknown): ReasoningApplicability { try { const parsed = JSON.parse(String(value)); return { taskTypes: [...new Set(identifiers(parsed?.taskTypes, 20).map(reasoningTaskType).filter((item): item is string => Boolean(item)))], riskLevels: identifiers(parsed?.riskLevels, 3).filter((item): item is "low" | "medium" | "high" => riskLevels.has(item)), environments: identifiers(parsed?.environments, 20), requiredTools: identifiers(parsed?.requiredTools, 20) }; } catch { return { taskTypes: [], riskLevels: [], environments: [], requiredTools: [] }; } }
function bounded(value: number): number { return Math.min(100, Math.max(1, Math.trunc(value))); }
function reason(value: unknown): string | undefined { return typeof value === "string" && /^[a-z][a-z0-9_]{1,79}$/.test(value) ? value : undefined; }
function applicabilityOverlap(left: ReasoningApplicability, right: ReasoningApplicability): string[] { const fields: Array<[string, string[], string[]]> = [["task_type", left.taskTypes, right.taskTypes], ["risk_level", left.riskLevels, right.riskLevels], ["environment", left.environments, right.environments], ["required_tool", left.requiredTools, right.requiredTools]]; return fields.flatMap(([label, a, b]) => a.filter(value => b.includes(value)).map(value => `${label}:${value}`)).slice(0, 20); }
