import { createHash } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { authorizeMnemoraContextRef, type MnemoraContextRef } from "../context/context-ref.js";
import { normalizeScope } from "../scope.js";

export type OutcomeVerdict = "success" | "partial" | "failure" | "unknown";
export type OutcomeImpact = "helpful" | "neutral" | "harmful";
export type OutcomeStatus = "recorded" | "superseded";
const verdicts = new Set<OutcomeVerdict>(["success", "partial", "failure", "unknown"]);
const impacts = new Set<OutcomeImpact>(["helpful", "neutral", "harmful"]);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value: unknown, max: number) => typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, max) : undefined;

export interface TaskOutcomeInput {
  scope: string;
  taskRef: string;
  verdict: OutcomeVerdict;
  impact: OutcomeImpact;
  confidence?: number;
  summary?: string;
  evidenceRefs: string[];
  supersedesId?: string;
}
export interface TaskOutcome {
  id: string; scope: string; taskRef: string; verdict: OutcomeVerdict; impact: OutcomeImpact; confidence: number; summary?: string; evidenceRefs: string[];
  supersedesId?: string; status: OutcomeStatus; recordedAt: number;
}
export interface OutcomePreview { status: "preview"; preview_hash: string; outcome: Omit<TaskOutcome, "id" | "status" | "recordedAt">; }

/**
 * The v4.0 evidence ledger: operator-confirmed outcomes only. It deliberately
 * does not score strategies, create reasoning memory, or alter personal memory.
 */
export class TaskOutcomeService {
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {}

  preview(input: TaskOutcomeInput): OutcomePreview {
    const outcome = this.normalize(input);
    return { status: "preview", preview_hash: hash({ version: "task-outcome-preview-v1", ...outcome }), outcome };
  }

  confirm(input: TaskOutcomeInput, previewHash: string): TaskOutcome {
    const value = this.normalize(input), expected = hash({ version: "task-outcome-preview-v1", ...value });
    if (!previewHash || previewHash !== expected) throw new Error("invalid_outcome_preview");
    const now = this.now(), outcomeHash = hash({ ...value }), id = `task-outcome:${outcomeHash.slice(0, 40)}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR IGNORE INTO kg_scopes(id,created_at,updated_at) VALUES(?,?,?)").run(value.scope, now, now);
      const existing = this.db.prepare("SELECT id FROM mnemora_task_outcomes WHERE scope=? AND outcome_hash=?").get(value.scope, outcomeHash) as { id: string } | undefined;
      if (existing) { this.db.exec("COMMIT"); return this.get(existing.id, value.scope)!; }
      if (value.supersedesId) {
        const prior = this.get(value.supersedesId, value.scope);
        if (!prior || prior.status !== "recorded" || prior.taskRef !== value.taskRef) throw new Error("invalid_outcome_supersession");
        this.db.prepare("UPDATE mnemora_task_outcomes SET status='superseded',updated_at=? WHERE id=? AND scope=?").run(now, prior.id, value.scope);
        this.event(value.scope, prior.id, "recorded", "superseded", "SUPERSEDE", "explicit_correction", prior.evidenceRefs, now);
      }
      this.db.prepare("INSERT INTO mnemora_task_outcomes(id,scope,task_ref,verdict,impact,confidence,summary,evidence_refs_json,supersedes_id,status,outcome_hash,recorded_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?, 'recorded',?,?,?,?)").run(id, value.scope, value.taskRef, value.verdict, value.impact, value.confidence, value.summary ?? null, JSON.stringify(value.evidenceRefs), value.supersedesId ?? null, outcomeHash, now, now, now);
      this.event(value.scope, id, null, "recorded", "RECORD", "operator_confirmed", value.evidenceRefs, now);
      this.db.exec("COMMIT"); return this.get(id, value.scope)!;
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  get(id: string, scope: string): TaskOutcome | undefined {
    const row = this.db.prepare("SELECT * FROM mnemora_task_outcomes WHERE id=? AND scope=?").get(id, normalizeScope(scope)) as Record<string, unknown> | undefined;
    return row ? this.read(row) : undefined;
  }
  list(scope: string, limit = 20): TaskOutcome[] {
    const rows = this.db.prepare("SELECT * FROM mnemora_task_outcomes WHERE scope=? ORDER BY recorded_at DESC,id DESC LIMIT ?").all(normalizeScope(scope), bound(limit)) as Array<Record<string, unknown>>;
    return rows.map(row => this.read(row));
  }
  forTask(scope: string, taskRef: string, limit = 20): TaskOutcome[] {
    const safe = normalizeScope(scope), task = this.taskReference(taskRef, safe).canonical;
    const rows = this.db.prepare("SELECT * FROM mnemora_task_outcomes WHERE scope=? AND task_ref=? ORDER BY recorded_at DESC,id DESC LIMIT ?").all(safe, task, bound(limit)) as Array<Record<string, unknown>>;
    return rows.map(row => this.read(row));
  }
  summary(scope: string) {
    const safe = normalizeScope(scope), rows = this.db.prepare("SELECT verdict,impact,COUNT(*) AS value FROM mnemora_task_outcomes WHERE scope=? AND status='recorded' GROUP BY verdict,impact").all(safe) as Array<{ verdict: OutcomeVerdict; impact: OutcomeImpact; value: number }>;
    return { scope: safe, outcomes: rows.reduce((result, row) => ({ ...result, [`${row.verdict}:${row.impact}`]: Number(row.value) }), {} as Record<string, number>) };
  }

  private normalize(input: TaskOutcomeInput) {
    const scope = normalizeScope(input.scope), taskRef = this.taskReference(input.taskRef, scope).canonical;
    if (!verdicts.has(input.verdict) || !impacts.has(input.impact)) throw new Error("invalid_task_outcome");
    const confidence = input.confidence === undefined ? .5 : Number(input.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("invalid_task_outcome");
    const evidenceRefs = [...new Set((Array.isArray(input.evidenceRefs) ? input.evidenceRefs : []).slice(0, 50).map(value => this.evidenceReference(value, scope).canonical))];
    if (!evidenceRefs.length) throw new Error("invalid_task_outcome_evidence");
    const supersedesId = text(input.supersedesId, 256);
    return { scope, taskRef, verdict: input.verdict, impact: input.impact, confidence, summary: text(input.summary, 2048), evidenceRefs, supersedesId };
  }
  private taskReference(value: unknown, scope: string): MnemoraContextRef {
    const reference = authorizeMnemoraContextRef(value, { scope, kinds: ["episode", "decision"] });
    const exists = reference.kind === "episode"
      ? this.db.prepare("SELECT 1 FROM mnemora_episodes WHERE id=? AND scope=? AND deleted_at IS NULL").get(reference.id, scope)
      : this.db.prepare("SELECT 1 FROM mnemora_decisions WHERE id=? AND scope=?").get(reference.id, scope);
    if (!exists) throw new Error("invalid_task_outcome_task");
    return reference;
  }
  private evidenceReference(value: unknown, scope: string): MnemoraContextRef {
    const reference = authorizeMnemoraContextRef(value, { scope, kinds: ["conversation-event", "artifact", "episode", "claim", "decision"] });
    const exists = reference.kind === "conversation-event" ? this.db.prepare("SELECT 1 FROM mnemora_conversation_events WHERE id=? AND scope=? AND deleted_at IS NULL").get(reference.id, scope)
      : reference.kind === "artifact" ? this.db.prepare("SELECT 1 FROM mnemora_artifacts WHERE id=? AND scope=? AND deleted_at IS NULL").get(reference.id, scope)
      : reference.kind === "episode" ? this.db.prepare("SELECT 1 FROM mnemora_episodes WHERE id=? AND scope=? AND deleted_at IS NULL").get(reference.id, scope)
      : reference.kind === "claim" ? this.db.prepare("SELECT 1 FROM kg_observations WHERE id=? AND scope=?").get(reference.id, scope)
      : this.db.prepare("SELECT 1 FROM mnemora_decisions WHERE id=? AND scope=?").get(reference.id, scope);
    if (!exists) throw new Error("invalid_task_outcome_evidence");
    return reference;
  }
  private event(scope: string, outcomeId: string, from: OutcomeStatus | null, to: OutcomeStatus, action: "RECORD" | "SUPERSEDE", reason: "operator_confirmed" | "explicit_correction", evidenceRefs: string[], now: number) {
    const id = `task-outcome-event:${hash({ scope, outcomeId, from, to, action, now }).slice(0, 40)}`;
    this.db.prepare("INSERT INTO mnemora_task_outcome_events(id,scope,outcome_id,from_status,to_status,action,reason_code,evidence_refs_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, scope, outcomeId, from, to, action, reason, JSON.stringify(evidenceRefs), now);
  }
  private read(row: Record<string, unknown>): TaskOutcome {
    return { id: String(row.id), scope: String(row.scope), taskRef: String(row.task_ref), verdict: row.verdict as OutcomeVerdict, impact: row.impact as OutcomeImpact, confidence: Number(row.confidence), ...(row.summary ? { summary: String(row.summary) } : {}), evidenceRefs: json(row.evidence_refs_json), ...(row.supersedes_id ? { supersedesId: String(row.supersedes_id) } : {}), status: row.status as OutcomeStatus, recordedAt: Number(row.recorded_at) };
  }
}
function json(value: unknown): string[] { try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed.filter(item => typeof item === "string").slice(0, 50) : []; } catch { return []; } }
function bound(value: number): number { return Math.min(100, Math.max(1, Math.trunc(value))); }
