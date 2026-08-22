import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { authorizeMnemoraContextRef, createMnemoraContextRef } from "../context/context-ref.js";
import { normalizeScope } from "../scope.js";
import { CognitionReferenceRepository } from "./reference-repository.js";

export type RecallFeedbackKind = "helpful" | "unused" | "irrelevant" | "wrong" | "outdated" | "user_corrected" | "context_mismatch";
export type ReflectionCandidateKind = "pattern_candidate" | "staleness_review";
export interface ReflectionCandidate { id: string; scope: string; kind: ReflectionCandidateKind; sourceRefs: string[]; reasonCode: string; score: number; status: "proposed"; admissionEligible: false; nextAction: "formation_required"; createdAt: number; }
export interface ReflectionPreview { scope: string; preview_hash: string; candidates: Array<Omit<ReflectionCandidate, "id" | "status" | "admissionEligible" | "nextAction" | "createdAt">>; }
export interface ReflectionMetrics { jobs: Record<string, number>; candidates: Record<string, number>; unsafe_promotions: 0; }
const feedbackKinds = new Set<RecallFeedbackKind>(["helpful", "unused", "irrelevant", "wrong", "outdated", "user_corrected", "context_mismatch"]);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** Durable usage feedback. It changes retrieval salience only; never truth confidence. */
export class RecallFeedbackRepository {
  private readonly references: CognitionReferenceRepository;
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) { this.references = new CognitionReferenceRepository(db); }
  record(input: { scope: string; targetRef: string; kind: RecallFeedbackKind }): { id: string; created: boolean } {
    const scope = normalizeScope(input.scope);
    if (!feedbackKinds.has(input.kind)) throw new Error("invalid_recall_feedback");
    const reference = authorizeMnemoraContextRef(input.targetRef, { scope, kinds: ["belief", "decision", "memory-document"] });
    this.references.requireActive(reference);
    const now = this.now(), idempotency = hash({ scope, targetRef: reference.canonical, kind: input.kind, day: Math.floor(now / 86_400_000) });
    const id = `recall-feedback:${idempotency.slice(0, 40)}`;
    const result = this.db.prepare("INSERT OR IGNORE INTO mnemora_recall_feedback(id,scope,target_ref,kind,idempotency_key,created_at) VALUES(?,?,?,?,?,?)").run(id, scope, reference.canonical, input.kind, idempotency, now) as { changes?: unknown };
    return { id, created: Number(result.changes) === 1 };
  }
  salience(scope: string, targetRef: string): number {
    const rows = this.db.prepare("SELECT kind,COUNT(*) AS count FROM mnemora_recall_feedback WHERE scope=? AND target_ref=? GROUP BY kind").all(normalizeScope(scope), targetRef) as Array<{ kind: RecallFeedbackKind; count: number }>;
    const weights: Record<RecallFeedbackKind, number> = { helpful: .12, unused: -.02, irrelevant: -.15, wrong: -.2, outdated: -.12, user_corrected: -.2, context_mismatch: -.15 };
    return clamp(.5 + rows.reduce((total, row) => total + weights[row.kind] * Math.min(3, Number(row.count)), 0));
  }
  requiresReview(scope: string, targetRef: string): boolean {
    return this.db.prepare("SELECT 1 FROM mnemora_recall_feedback WHERE scope=? AND target_ref=? AND kind IN ('wrong','outdated','user_corrected','context_mismatch') LIMIT 1").get(normalizeScope(scope), targetRef) != null;
  }
  list(scope: string, limit = 50): Array<{ id: string; targetRef: string; kind: RecallFeedbackKind; createdAt: number }> {
    return (this.db.prepare("SELECT id,target_ref,kind,created_at FROM mnemora_recall_feedback WHERE scope=? ORDER BY created_at DESC,id DESC LIMIT ?").all(normalizeScope(scope), Math.min(100, Math.max(1, Math.trunc(limit)))) as Array<{ id: string; target_ref: string; kind: RecallFeedbackKind; created_at: number }>).map(row => ({ id: row.id, targetRef: row.target_ref, kind: row.kind, createdAt: Number(row.created_at) }));
  }
}

/** Deterministic reflection queue. It creates reviewable candidates only, never beliefs, facts, or admissions. */
export class ReflectionService {
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {}
  preview(input: { scope: string; staleAfterDays?: number }): ReflectionPreview {
    const scope = normalizeScope(input.scope), candidates = this.detect(scope, days(input.staleAfterDays));
    return { scope, preview_hash: hash({ version: "reflection-preview-v1", scope, candidates }), candidates };
  }
  runPreview(input: { scope: string; previewHash: string; staleAfterDays?: number; maxJobs?: number; signal?: AbortSignal }): { queued: number; proposed: number; reclaimed: number } {
    const preview = this.preview(input); if (!input.previewHash || input.previewHash !== preview.preview_hash) throw new Error("invalid_reflection_preview");
    return this.scheduleAndRun(preview.scope, preview.candidates, Math.min(20, Math.max(1, Math.trunc(input.maxJobs ?? 4))), input.signal);
  }
  candidates(scope: string, limit = 50): ReflectionCandidate[] {
    const rows = this.db.prepare("SELECT * FROM mnemora_reflection_candidates WHERE scope=? ORDER BY created_at DESC,id DESC LIMIT ?").all(normalizeScope(scope), Math.min(100, Math.max(1, Math.trunc(limit)))) as Array<Record<string, unknown>>;
    return rows.map(row => ({ id: String(row.id), scope: String(row.scope), kind: row.kind as ReflectionCandidateKind, sourceRefs: strings(row.source_refs), reasonCode: String(row.reason_code), score: Number(row.score), status: "proposed", admissionEligible: false, nextAction: "formation_required", createdAt: Number(row.created_at) }));
  }
  metrics(scope: string): ReflectionMetrics {
    const safe = normalizeScope(scope), counts = (table: string, column: string) => Object.fromEntries((this.db.prepare(`SELECT ${column} AS key,COUNT(*) AS value FROM ${table} WHERE scope=? GROUP BY ${column}`).all(safe) as Array<{ key: string; value: number }>).map(row => [row.key, Number(row.value)]));
    return { jobs: counts("mnemora_reflection_jobs", "status"), candidates: counts("mnemora_reflection_candidates", "kind"), unsafe_promotions: 0 };
  }
  private scheduleAndRun(scope: string, candidates: ReflectionPreview["candidates"], maxJobs: number, signal?: AbortSignal): { queued: number; proposed: number; reclaimed: number } {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const now = this.now(), inputHash = hash({ scope, candidates }), jobId = `reflection-job:${inputHash.slice(0, 40)}`;
    const queued = Number((this.db.prepare("INSERT OR IGNORE INTO mnemora_reflection_jobs(id,scope,input_hash,status,attempts,created_at,updated_at) VALUES(?,?,?,'queued',0,?,?)").run(jobId, scope, inputHash, now, now) as { changes?: unknown }).changes) === 1 ? 1 : 0;
    let proposed = 0;
    for (const candidate of candidates.slice(0, maxJobs * 20)) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const proposalHash = hash({ scope, kind: candidate.kind, refs: candidate.sourceRefs, reason: candidate.reasonCode });
      const result = this.db.prepare("INSERT OR IGNORE INTO mnemora_reflection_candidates(id,scope,kind,proposal_hash,source_refs,reason_code,score,status,created_at) VALUES(?,?,?,?,?,?,?,'proposed',?)").run(`reflection-candidate:${proposalHash.slice(0, 40)}`, scope, candidate.kind, proposalHash, JSON.stringify(candidate.sourceRefs), candidate.reasonCode, candidate.score, now) as { changes?: unknown};
      proposed += Number(result.changes ?? 0);
    }
    this.db.prepare("UPDATE mnemora_reflection_jobs SET status='succeeded',attempts=attempts+1,updated_at=?,finished_at=? WHERE id=? AND status IN ('queued','running')").run(now, now, jobId);
    return { queued, proposed, reclaimed: 0 };
  }
  private detect(scope: string, staleAfterDays: number): Array<Omit<ReflectionCandidate, "id" | "status" | "admissionEligible" | "nextAction" | "createdAt">> {
    const now = this.now(), staleBefore = now - staleAfterDays * 86_400_000;
    const repeated = this.db.prepare("SELECT id,support_count FROM mnemora_beliefs WHERE scope=? AND state IN ('supported','strong') AND support_count>=2 ORDER BY support_count DESC,id LIMIT 20").all(scope) as Array<{ id: string; support_count: number }>;
    const stale = this.db.prepare("SELECT id,updated_at FROM mnemora_beliefs WHERE scope=? AND state IN ('emerging','supported','strong','weakening') AND updated_at<=? ORDER BY updated_at,id LIMIT 20").all(scope, staleBefore) as Array<{ id: string; updated_at: number }>;
    const feedback = this.db.prepare("SELECT target_ref,COUNT(*) AS count FROM mnemora_recall_feedback WHERE scope=? AND kind IN ('wrong','outdated','user_corrected','context_mismatch') GROUP BY target_ref ORDER BY count DESC,target_ref LIMIT 20").all(scope) as Array<{ target_ref: string; count: number }>;
    const pattern = repeated.map(row => ({ scope, kind: "pattern_candidate" as const, sourceRefs: [createMnemoraContextRef({ scope, kind: "belief", id: row.id })], reasonCode: "repeated_explicit_belief", score: clamp(.4 + Number(row.support_count) * .1) }));
    const review = stale.map(row => ({ scope, kind: "staleness_review" as const, sourceRefs: [createMnemoraContextRef({ scope, kind: "belief", id: row.id })], reasonCode: "stale_belief", score: .5 }));
    const feedbackReview = feedback.map(row => ({ scope, kind: "staleness_review" as const, sourceRefs: [row.target_ref], reasonCode: "feedback_staleness", score: clamp(.55 + Number(row.count) * .1) }));
    return [...pattern, ...review, ...feedbackReview];
  }
}

function days(value: unknown): number { const number = Number(value); return Number.isSafeInteger(number) ? Math.min(3650, Math.max(1, number)) : 90; }
function strings(value: unknown): string[] { try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed.filter(item => typeof item === "string").slice(0, 20) : []; } catch { return []; } }
