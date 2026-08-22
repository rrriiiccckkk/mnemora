import { createHash } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import type { VerificationStatus } from "./types.js";

export type VerificationSupportType = "direct" | "inferred" | "contradicted" | "none";
export type VerificationKind = "rule" | "model" | "human";
export type VerificationReasonCode = "manual_review" | "direct_support" | "indirect_support" | "insufficient_source" | "source_changed" | "source_deleted" | "conflict";
export interface VerificationRecord {
  id: string;
  claim_id: string;
  source_anchor_id: string;
  scope: string;
  status: VerificationStatus;
  support_type: VerificationSupportType | null;
  extraction_confidence: number | null;
  verification_confidence: number | null;
  source_quality: number | null;
  verifier_kind: VerificationKind;
  created_at: number;
  verified_at: number | null;
}
export interface VerificationTransitionInput {
  verification_id: string;
  status: VerificationStatus;
  support_type?: VerificationSupportType;
  verification_confidence?: number;
  source_quality?: number;
  verifier_kind?: VerificationKind;
  reason_code?: VerificationReasonCode;
  verifier_model?: string;
  verifier_prompt_version?: string;
}
export interface VerificationTransitionResult { verification: VerificationRecord; transition_id: string; }
/** Redacted recall provenance. It intentionally excludes source labels, snapshots, quotes, notes, and provider payloads. */
export interface RecallClaimVerificationTrace {
  claim_id: string;
  eligible: boolean;
  pending_conflict: boolean;
  anchors: Array<{
    source_anchor_id: string;
    provider: string;
    source_status: "available" | "missing" | "deleted" | "changed" | "legacy";
    verification_status: VerificationStatus;
    support_type: VerificationSupportType | null;
    verifier_kind: VerificationKind;
    verified_at: number | null;
  }>;
}

const statuses = new Set<VerificationStatus>(["pending", "verified", "flagged", "rejected", "unverifiable", "contradicted", "stale", "superseded"]);
const allowed = new Map<VerificationStatus, Set<VerificationStatus>>([
  ["pending", new Set(["verified", "flagged", "rejected", "unverifiable"])],
  ["verified", new Set(["stale", "contradicted", "superseded"])],
  ["flagged", new Set(["verified", "rejected", "unverifiable", "contradicted"])],
  ["stale", new Set(["verified", "flagged", "rejected", "unverifiable", "superseded"])],
  ["contradicted", new Set(["verified", "superseded"])],
  ["unverifiable", new Set(["pending"])],
  ["rejected", new Set()],
  ["superseded", new Set()]
]);

/** Owns verification state and audit history; it does not own graph persistence or Provider calls. */
export class VerificationRepository {
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {}

  list(input: { scope?: string; status?: VerificationStatus; after_id?: string; limit?: number } = {}): VerificationRecord[] {
    const scope = normalizeScope(input.scope), limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 20)),), after = boundedId(input.after_id) ?? "";
    const status = input.status && statuses.has(input.status) ? input.status : null;
    const rows = this.db.prepare(`SELECT id,claim_id,source_anchor_id,scope,status,support_type,extraction_confidence,verification_confidence,source_quality,verifier_kind,created_at,verified_at
      FROM kg_claim_verifications WHERE scope=? AND (? IS NULL OR status=?) AND id>? ORDER BY id LIMIT ?`).all(scope, status, status, after, limit) as Array<Record<string, unknown>>;
    return rows.flatMap(row => record(row));
  }

  /** Lookup used by the external governance policy before a privileged transition. */
  get(id: string): VerificationRecord | undefined { const value = boundedId(id); return value ? this.lookup(value) : undefined; }

  transition(input: VerificationTransitionInput): VerificationTransitionResult {
    const verificationId = boundedId(input.verification_id);
    if (!verificationId || !statuses.has(input.status)) throw new Error("invalid_verification_transition");
    const kind = input.verifier_kind ?? "human", support = input.support_type ?? impliedSupport(input.status), reason = input.reason_code ?? impliedReason(input.status);
    if (!["rule", "model", "human"].includes(kind) || !["direct", "inferred", "contradicted", "none"].includes(support) || !validUnit(input.verification_confidence) || !validUnit(input.source_quality) || !validReason(reason)) throw new Error("invalid_verification_transition");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.lookup(verificationId);
      if (!current || !allowed.get(current.status)?.has(input.status)) throw new Error("invalid_verification_transition");
      if (input.status === "verified" && support !== "direct") throw new Error("invalid_verification_transition");
      if (input.status === "contradicted" && support !== "contradicted" || input.status === "rejected" && support !== "none") throw new Error("invalid_verification_transition");
      const now = this.now();
      const transitionId = `verification-transition:${createHash("sha256").update(`${verificationId}\0${current.status}\0${input.status}\0${now}`).digest("hex").slice(0, 40)}`;
      this.db.prepare(`UPDATE kg_claim_verifications SET status=?,support_type=?,verification_confidence=?,source_quality=?,verifier_kind=?,verifier_model=?,verifier_prompt_version=?,verified_at=? WHERE id=?`)
        .run(input.status, support, input.verification_confidence ?? null, input.source_quality ?? null, kind, boundedMetadata(input.verifier_model), boundedMetadata(input.verifier_prompt_version), input.status === "verified" ? now : null, verificationId);
      this.db.prepare(`INSERT INTO kg_verification_transitions(id,verification_id,from_status,to_status,verifier_kind,support_type,verification_confidence,source_quality,reason_code,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(transitionId, verificationId, current.status, input.status, kind, support, input.verification_confidence ?? null, input.source_quality ?? null, reason, now);
      this.bump(now);
      const verification = this.lookup(verificationId);
      if (!verification) throw new Error("verification_persistence_failed");
      this.db.exec("COMMIT");
      return { verification, transition_id: transitionId };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  /** Model workers can only resolve still-pending claims through a closed outcome set. */
  transitionAutomated(input: { verification_id: string; status: "verified" | "flagged" | "unverifiable"; support_type?: VerificationSupportType; verification_confidence?: number; source_quality?: number; verifier_model: string; verifier_prompt_version: string }): VerificationTransitionResult {
    const support = input.status === "verified" ? "direct" : input.status === "flagged" ? "inferred" : "none";
    return this.transition({
      verification_id: input.verification_id, status: input.status, support_type: input.support_type ?? support,
      verification_confidence: input.verification_confidence, source_quality: input.source_quality, verifier_kind: "model",
      verifier_model: input.verifier_model, verifier_prompt_version: input.verifier_prompt_version,
      reason_code: input.status === "verified" ? "direct_support" : input.status === "flagged" ? "indirect_support" : "insufficient_source"
    });
  }

  recordClaimRecall(scope: string, claimIds: readonly string[], now = this.now()): void {
    const ids = [...new Set(claimIds.filter(value => boundedId(value)))].slice(0, 100);
    if (!ids.length) return;
    const normalizedScope = normalizeScope(scope);
    const statement = this.db.prepare(`INSERT INTO kg_claim_recall_metrics(claim_id,scope,recall_count,first_recalled_at,last_recalled_at)
      VALUES(?,?,1,?,?) ON CONFLICT(claim_id) DO UPDATE SET recall_count=kg_claim_recall_metrics.recall_count+1,last_recalled_at=excluded.last_recalled_at`);
    for (const id of ids) statement.run(id, normalizedScope, now, now);
  }

  /** Rules triggered by source change preserve the historical claim and record every stale transition. */
  markSourceChanged(input: { scope: string; provider: string; external_id: string; content_hash: string }): number {
    const scope = normalizeScope(input.scope), provider = boundedProvider(input.provider), externalId = boundedExternalId(input.external_id), hash = /^[a-f0-9]{64}$/.test(input.content_hash) ? input.content_hash : undefined;
    if (!provider || !externalId || !hash) return 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = this.now();
      const anchors = this.db.prepare(`SELECT id FROM kg_source_anchors WHERE scope=? AND provider=? AND external_id=? AND content_hash<>? AND status='available'`).all(scope, provider, externalId, hash) as Array<{ id: string }>;
      if (!anchors.length) { this.db.exec("COMMIT"); return 0; }
      const ids = anchors.map(row => row.id);
      for (const id of ids) this.db.prepare("UPDATE kg_source_anchors SET status='changed',last_checked_at=? WHERE id=?").run(now, id);
      for (const id of ids) this.db.prepare("UPDATE kg_external_refs SET status='changed',last_seen_at=? WHERE source_anchor_id=? AND status='active'").run(now, id);
      const changed: Array<{ id: string; status: VerificationStatus }> = [];
      for (const id of ids) changed.push(...this.db.prepare(`SELECT id,status FROM kg_claim_verifications WHERE source_anchor_id=? AND status IN ('pending','verified','flagged','unverifiable')`).all(id) as Array<{ id: string; status: VerificationStatus }>);
      for (const item of changed) {
        this.db.prepare("UPDATE kg_claim_verifications SET status='stale',verifier_kind='rule',verified_at=NULL WHERE id=?").run(item.id);
        const transitionId = `verification-transition:${createHash("sha256").update(`${item.id}\0${item.status}\0stale\0${hash}`).digest("hex").slice(0, 40)}`;
        this.db.prepare(`INSERT OR IGNORE INTO kg_verification_transitions(id,verification_id,from_status,to_status,verifier_kind,support_type,verification_confidence,source_quality,reason_code,created_at)
          VALUES(?,?,?,'stale','rule',NULL,NULL,NULL,'source_changed',?)`).run(transitionId, item.id, item.status, now);
      }
      if (changed.length) this.bump(now);
      this.db.exec("COMMIT");
      return changed.length;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  sourceEligibility(scope: string, sources: readonly string[]): Map<string, boolean> {
    const unique = [...new Set(sources.filter(value => typeof value === "string" && value.length > 0 && value.length <= 256))].slice(0, 100);
    const result = new Map(unique.map(source => [source, false]));
    if (!unique.length) return result;
    const rows = this.db.prepare(`SELECT a.source_label,v.status FROM kg_source_anchors a JOIN kg_claim_verifications v ON v.source_anchor_id=a.id
      WHERE a.scope=? AND a.source_label IN (${unique.map(() => "?").join(",")})`).all(normalizeScope(scope), ...unique) as Array<{ source_label: string; status: VerificationStatus }>;
    const grouped = new Map<string, VerificationStatus[]>();
    for (const row of rows) grouped.set(row.source_label, [...(grouped.get(row.source_label) ?? []), row.status]);
    for (const source of unique) {
      const values = grouped.get(source) ?? [];
      result.set(source, values.length > 0 && values.every(status => status === "verified"));
    }
    return result;
  }

  /** A strict recall decision is made per observation/claim, never per source. */
  claimEligibility(scope: string, claimIds: readonly string[]): Map<string, boolean> {
    const unique = [...new Set(claimIds.filter(value => boundedId(value)))].slice(0, 200);
    const result = new Map(unique.map(id => [id, false]));
    if (!unique.length) return result;
    const rows = this.db.prepare(`SELECT v.claim_id,v.status,a.status AS anchor_status FROM kg_claim_verifications v
      JOIN kg_source_anchors a ON a.id=v.source_anchor_id
      WHERE v.scope=? AND v.claim_id IN (${unique.map(() => "?").join(",")})`).all(normalizeScope(scope), ...unique) as Array<{ claim_id: string; status: VerificationStatus; anchor_status: string }>;
    const grouped = new Map<string, Array<{ status: VerificationStatus; anchor_status: string }>>();
    for (const row of rows) grouped.set(row.claim_id, [...(grouped.get(row.claim_id) ?? []), row]);
    for (const id of unique) {
      const records = grouped.get(id) ?? [];
      result.set(id, records.length > 0 && records.every(record => record.status === "verified" && record.anchor_status === "available"));
    }
    return result;
  }

  /**
   * Bounded claim-level provenance for an explain-only recall trace. This is
   * deliberately separate from graph persistence and never returns evidence
   * text, source labels, external IDs, snapshots, or verifier output.
   */
  recallTrace(scope: string, claimIds: readonly string[]): Map<string, RecallClaimVerificationTrace> {
    const unique = [...new Set(claimIds.filter(value => boundedId(value)))].slice(0, 200);
    const result = new Map<string, RecallClaimVerificationTrace>(unique.map(id => [id, { claim_id: id, eligible: false, pending_conflict: false, anchors: [] }]));
    if (!unique.length) return result;
    const placeholders = unique.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT v.claim_id,v.source_anchor_id,a.provider,a.status AS anchor_status,v.status AS verification_status,
        v.support_type,v.verifier_kind,v.verified_at,
        EXISTS(SELECT 1 FROM kg_conflict_candidates c WHERE c.status='pending' AND (c.observation_a=v.claim_id OR c.observation_b=v.claim_id)) AS pending_conflict
      FROM kg_claim_verifications v JOIN kg_source_anchors a ON a.id=v.source_anchor_id
      WHERE v.scope=? AND v.claim_id IN (${placeholders})
      ORDER BY v.claim_id,v.source_anchor_id`).all(normalizeScope(scope), ...unique) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const claimId = boundedId(row.claim_id), anchorId = boundedId(row.source_anchor_id), provider = boundedProvider(row.provider);
      const anchorStatus = anchorSourceStatus(row.anchor_status), verificationStatus = statuses.has(row.verification_status as VerificationStatus) ? row.verification_status as VerificationStatus : undefined;
      const kind = ["rule", "model", "human"].includes(row.verifier_kind as string) ? row.verifier_kind as VerificationKind : undefined;
      if (!claimId || !anchorId || !provider || !anchorStatus || !verificationStatus || !kind) continue;
      const trace = result.get(claimId);
      if (!trace) continue;
      const support = ["direct", "inferred", "contradicted", "none"].includes(row.support_type as string) ? row.support_type as VerificationSupportType : null;
      trace.pending_conflict ||= row.pending_conflict === 1;
      trace.anchors.push({ source_anchor_id: anchorId, provider, source_status: anchorStatus, verification_status: verificationStatus, support_type: support, verifier_kind: kind, verified_at: integerOrNull(row.verified_at) });
    }
    for (const trace of result.values()) trace.eligible = trace.anchors.length > 0 && trace.anchors.every(anchor => anchor.verification_status === "verified" && anchor.source_status === "available");
    return result;
  }

  private lookup(id: string): VerificationRecord | undefined { return record(this.db.prepare("SELECT id,claim_id,source_anchor_id,scope,status,support_type,extraction_confidence,verification_confidence,source_quality,verifier_kind,created_at,verified_at FROM kg_claim_verifications WHERE id=?").get(id) as Record<string, unknown> | undefined)[0]; }
  private bump(now: number): void { this.db.prepare("UPDATE kg_trust_state SET revision=revision+1,updated_at=? WHERE id=1").run(now); }
}

export class ClaimVerificationService {
  constructor(private readonly repository: VerificationRepository) {}
  list(input: { scope?: string; status?: VerificationStatus; after_id?: string; limit?: number } = {}): VerificationRecord[] { return this.repository.list(input); }
  transition(input: VerificationTransitionInput & { confirm?: boolean }): VerificationTransitionResult { if (input.confirm !== true) throw new Error("verification_confirmation_required"); return this.repository.transition(input); }
}

function record(value: Record<string, unknown> | undefined): VerificationRecord[] {
  if (!value || !boundedId(value.id) || !boundedId(value.claim_id) || !boundedId(value.source_anchor_id) || typeof value.scope !== "string" || !statuses.has(value.status as VerificationStatus) || !["rule", "model", "human"].includes(value.verifier_kind as string)) return [];
  const support = ["direct", "inferred", "contradicted", "none"].includes(value.support_type as string) ? value.support_type as VerificationSupportType : null;
  return [{ id: value.id as string, claim_id: value.claim_id as string, source_anchor_id: value.source_anchor_id as string, scope: value.scope, status: value.status as VerificationStatus, support_type: support, extraction_confidence: numberOrNull(value.extraction_confidence), verification_confidence: numberOrNull(value.verification_confidence), source_quality: numberOrNull(value.source_quality), verifier_kind: value.verifier_kind as VerificationKind, created_at: integer(value.created_at), verified_at: integerOrNull(value.verified_at) }];
}
function boundedId(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value) ? value : undefined; }
function boundedProvider(value: unknown): string | undefined { return typeof value === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(value) ? value : undefined; }
function anchorSourceStatus(value: unknown): RecallClaimVerificationTrace["anchors"][number]["source_status"] | undefined { return ["available", "missing", "deleted", "changed", "legacy"].includes(value as string) ? value as RecallClaimVerificationTrace["anchors"][number]["source_status"] : undefined; }
function boundedExternalId(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/.test(value) ? value : undefined; }
function boundedMetadata(value: unknown): string | null { return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f]/.test(value) ? value : null; }
function validUnit(value: unknown): boolean { return value === undefined || typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function numberOrNull(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null; }
function integer(value: unknown): number { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0; }
function integerOrNull(value: unknown): number | null { return value == null ? null : integer(value); }
function impliedSupport(status: VerificationStatus): VerificationSupportType { return status === "verified" ? "direct" : status === "contradicted" ? "contradicted" : status === "rejected" ? "none" : "inferred"; }
function impliedReason(status: VerificationStatus): VerificationReasonCode { return status === "verified" ? "direct_support" : status === "flagged" ? "indirect_support" : status === "rejected" || status === "unverifiable" ? "insufficient_source" : status === "contradicted" ? "conflict" : "manual_review"; }
function validReason(value: unknown): value is VerificationReasonCode { return ["manual_review", "direct_support", "indirect_support", "insufficient_source", "source_changed", "source_deleted", "conflict"].includes(value as string); }
