import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { semanticVocabularyRecommendation, type RelationshipType } from "../relationships.js";
import { normalizeScope } from "../scope.js";

export type SchemaDriftWorklistStatus = "pending" | "rejected" | "invalidated";
export type SchemaDriftResolution = "pending" | "rejected" | "repaired" | "invalidated" | "missing";

export interface SchemaDriftWorklistItem {
  id: string;
  candidate_id: string;
  status: SchemaDriftWorklistStatus;
  relationship_type: string;
  source_type: string;
  target_type: string;
  expected_source_types: string;
  expected_target_types: string;
  occurrence_count: number;
  updated_at: number;
  legacy_edge_id?: string;
  invalidation_reason?: "endpoint_now_allowed";
  next_action?: "repair_or_reject";
}

export interface SchemaDriftOutcomeSummary {
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
  invalidated: number;
  reviewed: number;
  acceptance_rate: number | null;
}

export type SchemaDriftRejectionPreview =
  | { status: "preview"; candidate_id: string; scope: string; decision: "rejected"; preview_hash: string; confirmation_required: true }
  | { status: "not_found" | "already_repaired" | "already_rejected" | "invalidated"; candidate_id: string; scope: string; preview_hash: string; reason?: "endpoint_now_allowed" };

export interface SchemaDriftRejectionReceipt {
  status: "rejected";
  candidate_id: string;
  scope: string;
  decision: "rejected";
  preview_hash: string;
  audit_id: string;
  created_at: number;
}

interface CandidateRow {
  id: string;
  scope: string;
  relationship_type: string;
  source_type: string;
  target_type: string;
  expected_source_types: string;
  expected_target_types: string;
  occurrence_count: number;
  updated_at: number;
  legacy_edge_id?: string;
}

/**
 * Durable operator decisions for ontology-mismatch candidates. This module
 * owns only review metadata: it never retypes an entity, rewrites an edge, or
 * turns a rejected candidate into a graph fact.
 */
export class SchemaDriftReviewRepository {
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {}

  reconcile(scope: string, limit = 100, afterId?: string): { examined: number; invalidated: number } {
    const safe = normalizeScope(scope), take = boundedLimit(limit), after = boundedId(afterId);
    const rows = this.unresolvedCandidates(safe, take, after);
    let invalidated = 0;
    for (const row of rows) if (this.reconcileCandidate(row)) invalidated++;
    return { examined: rows.length, invalidated };
  }

  /** A schema upgrade must close every historic candidate newly made valid by
   * the versioned vocabulary. Batching bounds each database read; the only
   * writes are append-only invalidation receipts, never graph facts. */
  reconcileAll(): { examined: number; invalidated: number } {
    const scopes = this.db.prepare(`SELECT DISTINCT scope FROM kg_schema_drift_candidates
      ORDER BY scope`).all() as Array<{ scope: string }>;
    let examined = 0, invalidated = 0;
    for (const row of scopes) {
      const scope = normalizeScope(row.scope);
      let after = "";
      for (;;) {
        const candidates = this.unresolvedCandidates(scope, 100, after);
        if (!candidates.length) break;
        for (const candidate of candidates) if (this.reconcileCandidate(candidate)) invalidated++;
        examined += candidates.length;
        after = candidates.at(-1)!.id;
      }
    }
    return { examined, invalidated };
  }

  private unresolvedCandidates(scope: string, limit: number, afterId: string): CandidateRow[] {
    return this.db.prepare(`SELECT c.id,c.scope,c.relationship_type,c.source_type,c.target_type,c.expected_source_types,c.expected_target_types,c.occurrence_count,c.updated_at,c.legacy_edge_id
      FROM kg_schema_drift_candidates c
      WHERE c.scope=? AND c.id>?
        AND NOT EXISTS(SELECT 1 FROM kg_schema_drift_repairs p WHERE p.candidate_id=c.id AND p.scope=c.scope)
        AND NOT EXISTS(SELECT 1 FROM kg_schema_drift_reviews r WHERE r.candidate_id=c.id AND r.scope=c.scope)
        AND NOT EXISTS(SELECT 1 FROM kg_schema_drift_invalidations i WHERE i.candidate_id=c.id AND i.scope=c.scope)
      ORDER BY c.id LIMIT ?`).all(scope, afterId, limit) as CandidateRow[];
  }

  worklist(input: { scope: string; status: SchemaDriftWorklistStatus; afterId?: string; limit?: number }): SchemaDriftWorklistItem[] {
    const scope = normalizeScope(input.scope), after = boundedId(input.afterId), take = boundedLimit(input.limit ?? 20);
    const statusWhere = input.status === "pending"
      ? "p.candidate_id IS NULL AND r.candidate_id IS NULL AND i.candidate_id IS NULL"
      : input.status === "rejected" ? "r.candidate_id IS NOT NULL"
        : "i.candidate_id IS NOT NULL";
    const rows = this.db.prepare(`SELECT c.id,c.relationship_type,c.source_type,c.target_type,c.expected_source_types,c.expected_target_types,c.occurrence_count,c.updated_at,c.legacy_edge_id,i.reason AS invalidation_reason
      FROM kg_schema_drift_candidates c
      LEFT JOIN kg_schema_drift_repairs p ON p.candidate_id=c.id AND p.scope=c.scope
      LEFT JOIN kg_schema_drift_reviews r ON r.candidate_id=c.id AND r.scope=c.scope
      LEFT JOIN kg_schema_drift_invalidations i ON i.candidate_id=c.id AND i.scope=c.scope
      WHERE c.scope=? AND c.id>? AND ${statusWhere}
      ORDER BY c.id LIMIT ?`).all(scope, after, take) as Array<CandidateRow & { invalidation_reason?: string }>;
    return rows.map(row => ({
      id: row.id,
      candidate_id: row.id,
      status: input.status,
      relationship_type: row.relationship_type,
      source_type: row.source_type,
      target_type: row.target_type,
      expected_source_types: row.expected_source_types,
      expected_target_types: row.expected_target_types,
      occurrence_count: Number(row.occurrence_count),
      updated_at: Number(row.updated_at),
      ...(row.legacy_edge_id ? { legacy_edge_id: row.legacy_edge_id } : {}),
      ...(row.invalidation_reason === "endpoint_now_allowed" ? { invalidation_reason: "endpoint_now_allowed" as const } : {}),
      ...(input.status === "pending" ? { next_action: "repair_or_reject" as const } : {})
    }));
  }

  summary(scope: string): SchemaDriftOutcomeSummary {
    const row = this.db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN p.candidate_id IS NULL AND r.candidate_id IS NULL AND i.candidate_id IS NULL THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN p.candidate_id IS NOT NULL THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN r.candidate_id IS NOT NULL THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN i.candidate_id IS NOT NULL THEN 1 ELSE 0 END) AS invalidated
      FROM kg_schema_drift_candidates c
      LEFT JOIN kg_schema_drift_repairs p ON p.candidate_id=c.id AND p.scope=c.scope
      LEFT JOIN kg_schema_drift_reviews r ON r.candidate_id=c.id AND r.scope=c.scope
      LEFT JOIN kg_schema_drift_invalidations i ON i.candidate_id=c.id AND i.scope=c.scope
      WHERE c.scope=?`).get(normalizeScope(scope)) as Record<string, unknown>;
    const accepted = number(row.accepted), rejected = number(row.rejected), reviewed = accepted + rejected;
    return {
      total: number(row.total), pending: number(row.pending), accepted, rejected, invalidated: number(row.invalidated),
      reviewed, acceptance_rate: reviewed ? accepted / reviewed : null
    };
  }

  resolution(candidateId: string, scope: string): SchemaDriftResolution {
    const candidate = this.candidate(candidateId, scope);
    if (!candidate) return "missing";
    const safe = normalizeScope(scope);
    if (this.db.prepare("SELECT 1 FROM kg_schema_drift_repairs WHERE candidate_id=? AND scope=?").get(candidate.id, safe)) return "repaired";
    if (this.db.prepare("SELECT 1 FROM kg_schema_drift_reviews WHERE candidate_id=? AND scope=?").get(candidate.id, safe)) return "rejected";
    this.reconcileCandidate(candidate);
    if (this.db.prepare("SELECT 1 FROM kg_schema_drift_invalidations WHERE candidate_id=? AND scope=?").get(candidate.id, safe)) return "invalidated";
    return "pending";
  }

  previewReject(candidateId: string, scope: string): SchemaDriftRejectionPreview {
    const safe = normalizeScope(scope), candidate = this.candidate(candidateId, safe);
    if (!candidate) return { status: "not_found", candidate_id: candidateId, scope: safe, preview_hash: "" };
    const resolution = this.resolution(candidate.id, safe);
    if (resolution === "repaired") return { status: "already_repaired", candidate_id: candidate.id, scope: safe, preview_hash: this.repairPreviewHash(candidate.id, safe) };
    if (resolution === "rejected") return { status: "already_rejected", candidate_id: candidate.id, scope: safe, preview_hash: this.reviewPreviewHash(candidate.id, safe) };
    if (resolution === "invalidated") return { status: "invalidated", candidate_id: candidate.id, scope: safe, preview_hash: "", reason: "endpoint_now_allowed" };
    const preview_hash = hash({ version: "schema-drift-review-v1", scope: safe, candidate: candidateSnapshot(candidate), decision: "rejected" });
    return { status: "preview", candidate_id: candidate.id, scope: safe, decision: "rejected", preview_hash, confirmation_required: true };
  }

  confirmReject(candidateId: string, scope: string, expectedPreviewHash: string): SchemaDriftRejectionReceipt | SchemaDriftRejectionPreview {
    const safe = normalizeScope(scope), preview = this.previewReject(candidateId, safe);
    if (preview.status !== "preview") return preview;
    if (!expectedPreviewHash || expectedPreviewHash !== preview.preview_hash) throw new Error("stale_schema_drift_review_preview");
    const now = this.now(), auditId = `schema-drift-review:${randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.previewReject(candidateId, safe);
      if (current.status !== "preview") { this.db.exec("COMMIT"); return current; }
      if (current.preview_hash !== expectedPreviewHash) throw new Error("stale_schema_drift_review_preview");
      this.db.prepare("INSERT INTO kg_quality_audits(id,action,snapshot_version,snapshot,created_at) VALUES(?,?,1,?,?)")
        .run(auditId, "reject_schema_drift_candidate", JSON.stringify({ candidate_id: candidateId, scope: safe, decision: "rejected", preview_hash: expectedPreviewHash }), now);
      this.db.prepare("INSERT INTO kg_schema_drift_reviews(candidate_id,scope,decision,preview_hash,audit_id,created_at) VALUES(?,?,?,?,?,?)")
        .run(candidateId, safe, "rejected", expectedPreviewHash, auditId, now);
      this.db.exec("COMMIT");
      return { status: "rejected", candidate_id: candidateId, scope: safe, decision: "rejected", preview_hash: expectedPreviewHash, audit_id: auditId, created_at: now };
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  private reconcileCandidate(candidate: CandidateRow): boolean {
    if (!isRelationshipType(candidate.relationship_type)) return false;
    const recommendation = semanticVocabularyRecommendation(candidate.relationship_type, candidate.source_type, candidate.target_type);
    if (!recommendation.endpoint_match) return false;
    const result = this.db.prepare(`INSERT INTO kg_schema_drift_invalidations(candidate_id,scope,reason,invalidated_at)
      VALUES(?,?,?,?) ON CONFLICT(candidate_id) DO NOTHING`).run(candidate.id, candidate.scope, "endpoint_now_allowed", this.now()) as { changes?: unknown };
    return Number(result.changes) === 1;
  }

  private candidate(candidateId: string, scope: string): CandidateRow | undefined {
    return this.db.prepare(`SELECT id,scope,relationship_type,source_type,target_type,expected_source_types,expected_target_types,occurrence_count,updated_at,legacy_edge_id
      FROM kg_schema_drift_candidates WHERE id=? AND scope=?`).get(boundedId(candidateId), normalizeScope(scope)) as CandidateRow | undefined;
  }

  private repairPreviewHash(candidateId: string, scope: string): string {
    return String((this.db.prepare("SELECT preview_hash FROM kg_schema_drift_repairs WHERE candidate_id=? AND scope=?").get(candidateId, scope) as { preview_hash?: string } | undefined)?.preview_hash ?? "");
  }

  private reviewPreviewHash(candidateId: string, scope: string): string {
    return String((this.db.prepare("SELECT preview_hash FROM kg_schema_drift_reviews WHERE candidate_id=? AND scope=?").get(candidateId, scope) as { preview_hash?: string } | undefined)?.preview_hash ?? "");
  }
}

function isRelationshipType(value: string): value is RelationshipType {
  return ["works_at", "invested_in", "supplies", "supplies_product", "supplied_to", "competes_with", "uses", "develops", "owns", "partners_with", "in_portfolio", "depends_on", "part_of", "instance_of", "related_to"].includes(value);
}

function candidateSnapshot(candidate: CandidateRow): Record<string, unknown> {
  return {
    id: candidate.id, scope: candidate.scope, relationship_type: candidate.relationship_type,
    source_type: candidate.source_type, target_type: candidate.target_type,
    expected_source_types: candidate.expected_source_types, expected_target_types: candidate.expected_target_types,
    occurrence_count: Number(candidate.occurrence_count), updated_at: Number(candidate.updated_at), legacy_edge_id: candidate.legacy_edge_id ?? ""
  };
}

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function boundedId(value: string | undefined): string { return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : ""; }
function boundedLimit(value: number): number { return Math.min(100, Math.max(1, Math.trunc(value))); }
function number(value: unknown): number { return Number.isFinite(Number(value)) ? Number(value) : 0; }
