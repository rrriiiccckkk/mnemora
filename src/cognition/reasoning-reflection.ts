import { createHash } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { createMnemoraContextRef } from "../context/context-ref.js";
import { normalizeScope } from "../scope.js";

export type ReasoningReflectionKind = "outcome_contrast" | "harmful_outcomes";
export interface ReasoningReflectionProposal { id: string; scope: string; memoryId: string; kind: ReasoningReflectionKind; sourceRefs: string[]; reasonCode: "contrasting_recorded_outcomes" | "harmful_recorded_outcomes"; score: number; status: "proposed"; createdAt: number; }
export interface ReasoningReflectionPreview { scope: string; preview_hash: string; proposals: Array<Omit<ReasoningReflectionProposal, "id" | "status" | "createdAt">>; }

/**
 * Deterministic contrast detection over already recorded outcomes. It creates
 * review proposals only; an operator must separately use Reasoning Governance
 * to transition a memory or create a successor.
 */
export class ReasoningReflectionService {
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {}

  preview(scope: string): ReasoningReflectionPreview {
    const safe = normalizeScope(scope), proposals = this.detect(safe);
    return { scope: safe, preview_hash: hash({ version: "reasoning-reflection-preview-v1", scope: safe, proposals }), proposals };
  }
  run(scope: string, previewHash: string): { proposed: number; existing: number } {
    const preview = this.preview(scope); if (!previewHash || previewHash !== preview.preview_hash) throw new Error("invalid_reasoning_reflection_preview"); const now = this.now(); let proposed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const proposal of preview.proposals) {
        const proposalHash = hash({ scope: preview.scope, memoryId: proposal.memoryId, kind: proposal.kind, sourceRefs: proposal.sourceRefs, reasonCode: proposal.reasonCode });
        const result = this.db.prepare("INSERT OR IGNORE INTO mnemora_reasoning_reflection_proposals(id,scope,memory_id,kind,proposal_hash,source_refs_json,reason_code,score,status,created_at) VALUES(?,?,?,?,?,?,?,?, 'proposed',?)").run(`reasoning-reflection:${proposalHash.slice(0, 40)}`, preview.scope, proposal.memoryId, proposal.kind, proposalHash, JSON.stringify(proposal.sourceRefs), proposal.reasonCode, proposal.score, now) as { changes?: unknown };
        proposed += Number(result.changes ?? 0);
      }
      this.db.exec("COMMIT"); return { proposed, existing: preview.proposals.length - proposed };
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }
  proposals(scope: string, limit = 50): ReasoningReflectionProposal[] {
    const rows = this.db.prepare("SELECT * FROM mnemora_reasoning_reflection_proposals WHERE scope=? ORDER BY created_at DESC,id DESC LIMIT ?").all(normalizeScope(scope), bounded(limit)) as Array<Record<string, unknown>>;
    return rows.map(row => ({ id: String(row.id), scope: String(row.scope), memoryId: String(row.memory_id), kind: row.kind as ReasoningReflectionKind, sourceRefs: strings(row.source_refs_json), reasonCode: row.reason_code as ReasoningReflectionProposal["reasonCode"], score: Number(row.score), status: "proposed", createdAt: Number(row.created_at) }));
  }
  metrics(scope: string) { const safe = normalizeScope(scope), rows = this.db.prepare("SELECT kind,COUNT(*) AS value FROM mnemora_reasoning_reflection_proposals WHERE scope=? GROUP BY kind").all(safe) as Array<{ kind: string; value: number }>; return { scope: safe, proposals: Object.fromEntries(rows.map(row => [row.kind, Number(row.value)])), unsafe_promotions: 0 }; }

  private detect(scope: string): ReasoningReflectionPreview["proposals"] {
    const rows = this.db.prepare("SELECT id,outcome_refs_json,utility_score,success_count,failure_count,state FROM mnemora_reasoning_memories WHERE scope=? AND state IN ('provisional','admitted','needs_review') ORDER BY updated_at DESC,id DESC LIMIT 100").all(scope) as Array<Record<string, unknown>>, proposals: ReasoningReflectionPreview["proposals"] = [];
    for (const row of rows) {
      const outcomeRefs = strings(row.outcome_refs_json).filter(reference => this.recordedOutcome(scope, reference)); if (!outcomeRefs.length) continue;
      const memoryId = String(row.id), sourceRefs = [createMnemoraContextRef({ scope, kind: "reasoning-memory", id: memoryId }), ...outcomeRefs].slice(0, 50), success = Number(row.success_count), failure = Number(row.failure_count), utility = Number(row.utility_score);
      if (success > 0 && failure > 0) proposals.push({ scope, memoryId, kind: "outcome_contrast", sourceRefs, reasonCode: "contrasting_recorded_outcomes", score: .8 });
      else if (failure > 0 && utility <= -.5) proposals.push({ scope, memoryId, kind: "harmful_outcomes", sourceRefs, reasonCode: "harmful_recorded_outcomes", score: .7 });
    }
    return proposals;
  }
  private recordedOutcome(scope: string, reference: string): boolean {
    const match = /^mnemora:\/\/v1\/scope\/[^/]+\/task-outcome\/([^/]+)$/.exec(reference); if (!match) return false;
    try { return this.db.prepare("SELECT 1 FROM mnemora_task_outcomes WHERE id=? AND scope=? AND status='recorded'").get(decodeURIComponent(match[1]), scope) != null; } catch { return false; }
  }
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function strings(value: unknown): string[] { try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed.filter(item => typeof item === "string").slice(0, 50) : []; } catch { return []; } }
function bounded(value: number): number { return Math.min(100, Math.max(1, Math.trunc(value))); }
