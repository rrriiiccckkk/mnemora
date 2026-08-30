import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { edgeWeight } from "../schema.js";
import { normalizeScope } from "../scope.js";

export type RelatedEdgeRefinementType = "depends_on" | "part_of" | "instance_of";
type Decision = "accepted" | "rejected";

export interface RelatedEdgeRefinementCandidate {
  id: string;
  scope: string;
  legacy_edge_id: string;
  source: { id: string; name: string };
  target: { id: string; name: string };
  proposed_source: { id: string; name: string };
  proposed_target: { id: string; name: string };
  proposed_type: RelatedEdgeRefinementType;
  rationale: string;
  confidence: number;
  /** Hash only; the evidence text remains in the bounded evidence projection. */
  evidence_hash: string;
  status: "pending" | Decision;
  evidence: { observation_id: string; source: string; quote: string; confidence: number };
  first_seen_at: number;
  updated_at: number;
  reviewed_at: number | null;
}

export interface RelatedEdgeRefinementScanResult {
  scanned: number;
  candidates_created: number;
  candidates_updated: number;
  next_edge_id?: string;
}

export interface RelatedEdgeRefinementReviewResult {
  confirmed: boolean;
  candidate_id: string;
  decision: Decision;
  preview_hash: string;
  eligible: boolean;
  reason?: "missing_candidate" | "already_reviewed" | "legacy_edge_changed" | "missing_scope_evidence";
  audit_id?: string;
  edge_id?: string;
  observation_id?: string;
  retired_edge_id?: string;
}

interface CandidateRow {
  id: string; scope: string; legacy_edge_id: string; source_entity_id: string; target_entity_id: string;
  proposed_source_entity_id: string; proposed_target_entity_id: string; proposed_type: string;
  evidence_observation_id: string; evidence_hash: string; rationale: string; confidence: number;
  status: string; first_seen_at: number; updated_at: number; reviewed_at: number | null;
  source_name: string; target_name: string; proposed_source_name: string; proposed_target_name: string;
  evidence_source: string; evidence_quote: string; evidence_confidence: number;
}

interface LegacyRow {
  id: string; source_id: string; target_id: string; source_name: string; target_name: string;
  observation_id: string; quote: string; confidence: number;
}

const maxScan = 100;
const minimumConfidence = .85;
const quoteLimit = 512;
const topologyPatterns: Array<{ type: RelatedEdgeRefinementType; rationale: string; cue: string }> = [
  { type: "depends_on", rationale: "explicit_dependency_cue", cue: "(?:\\bdepends?\\s+on\\b|\\bdependency\\s+on\\b|依赖于?|依存于?)" },
  { type: "part_of", rationale: "explicit_part_whole_cue", cue: "(?:\\bpart\\s+of\\b|\\bcomponent\\s+of\\b|\\bbelongs\\s+to\\b|属于|组成部分|的一部分)" },
  { type: "instance_of", rationale: "explicit_type_cue", cue: "(?:\\btype\\s+of\\b|\\bkind\\s+of\\b|\\bis\\s+(?:an?|the)\\b|是一种|属于[^。；,，;]{0,32}(?:类|类型))" }
];

/** A deep, local module: scanning, cue validation, preview hashing, atomic
 * confirmation, and audit receipts sit behind the single review workflow. */
export class RelatedEdgeRefinementService {
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {}

  scan(input: { scope: string; afterEdgeId?: string; limit?: number }): RelatedEdgeRefinementScanResult {
    const scope = normalizeScope(input.scope), after = boundedId(input.afterEdgeId), limit = Math.min(maxScan, Math.max(1, Math.trunc(input.limit ?? 20)));
    const rows = this.db.prepare(`SELECT e.id,e.source_id,e.target_id,s.name AS source_name,t.name AS target_name,
      o.id AS observation_id,o.quote,o.confidence
      FROM kg_edges e JOIN kg_nodes s ON s.id=e.source_id AND s.deleted_at IS NULL
        JOIN kg_nodes t ON t.id=e.target_id AND t.deleted_at IS NULL
        JOIN kg_observations o ON o.id=(SELECT io.id FROM kg_observations io
          WHERE io.edge_id=e.id AND io.scope=? AND io.confidence>=? AND length(trim(io.quote))>0
          ORDER BY io.confidence DESC,io.created_at DESC,io.id LIMIT 1)
      WHERE e.deleted_at IS NULL AND e.type='related_to' AND e.source_id<>e.target_id AND e.id>?
      ORDER BY e.id LIMIT ?`).all(scope, minimumConfidence, after, limit) as LegacyRow[];
    let created = 0, updated = 0;
    for (const row of rows) {
      const proposal = classify(row);
      if (!proposal) continue;
      const id = candidateId(scope, row.id, row.observation_id, proposal.type, proposal.sourceId, proposal.targetId);
      const existing = this.db.prepare("SELECT status FROM kg_related_edge_refinement_candidates WHERE id=?").get(id) as { status?: string } | undefined;
      const now = this.now(), evidenceHash = hash(row.quote);
      this.db.prepare(`INSERT INTO kg_related_edge_refinement_candidates(
        id,scope,legacy_edge_id,source_entity_id,target_entity_id,proposed_source_entity_id,proposed_target_entity_id,
        proposed_type,evidence_observation_id,evidence_hash,rationale,confidence,status,first_seen_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?) ON CONFLICT(scope,legacy_edge_id,evidence_observation_id,proposed_type,proposed_source_entity_id,proposed_target_entity_id)
      DO UPDATE SET evidence_hash=excluded.evidence_hash,rationale=excluded.rationale,confidence=excluded.confidence,updated_at=excluded.updated_at
        WHERE kg_related_edge_refinement_candidates.status='pending'`)
        .run(id, scope, row.id, row.source_id, row.target_id, proposal.sourceId, proposal.targetId, proposal.type, row.observation_id, evidenceHash, proposal.rationale, clamp01(row.confidence), now, now);
      if (!existing) created++;
      else if (existing.status === "pending") updated++;
    }
    return { scanned: rows.length, candidates_created: created, candidates_updated: updated, ...(rows.length === limit ? { next_edge_id: rows[rows.length - 1]!.id } : {}) };
  }

  list(scope: string, limit = 20): { items: RelatedEdgeRefinementCandidate[] } {
    const safe = normalizeScope(scope), take = Math.min(maxScan, Math.max(1, Math.trunc(limit)));
    const rows = this.db.prepare(candidateSelect("WHERE c.scope=? ORDER BY c.status='pending' DESC,c.updated_at DESC,c.id LIMIT ?")).all(safe, take) as CandidateRow[];
    return { items: rows.map(mapCandidate) };
  }

  preview(candidateIdValue: string, decision: Decision, scope = "default"): RelatedEdgeRefinementReviewResult {
    const scopeSafe = normalizeScope(scope), candidate = this.find(candidateIdValue, scopeSafe);
    const basic = { confirmed: false, candidate_id: candidateIdValue, decision } as const;
    if (!candidate) return { ...basic, preview_hash: "", eligible: false, reason: "missing_candidate" };
    if (candidate.status !== "pending") return { ...basic, preview_hash: receiptHash(this.db, candidate.id) ?? "", eligible: false, reason: "already_reviewed" };
    const legacy = this.activeLegacy(candidate, scopeSafe);
    if (!legacy) return { ...basic, preview_hash: "", eligible: false, reason: "legacy_edge_changed" };
    if (!this.hasNodeEvidence(candidate.proposed_source.id, scopeSafe) || !this.hasNodeEvidence(candidate.proposed_target.id, scopeSafe)) return { ...basic, preview_hash: "", eligible: false, reason: "missing_scope_evidence" };
    const snapshot = {
      candidate_id: candidate.id, scope: scopeSafe, decision, proposed_type: candidate.proposed_type,
      proposed_source_id: candidate.proposed_source.id, proposed_target_id: candidate.proposed_target.id,
      candidate_updated_at: candidate.updated_at, evidence_observation_id: candidate.evidence.observation_id,
      evidence_hash: this.evidenceHash(candidate.evidence.observation_id), legacy_edge: { id: legacy.id, updated_at: legacy.updated_at }, graph_revision: graphRevision(this.db)
    };
    return { ...basic, preview_hash: hash(JSON.stringify(snapshot)), eligible: true };
  }

  confirm(candidateIdValue: string, decision: Decision, expectedPreviewHash: string, scope = "default"): RelatedEdgeRefinementReviewResult {
    const scopeSafe = normalizeScope(scope), preview = this.preview(candidateIdValue, decision, scopeSafe);
    if (!preview.eligible) return preview;
    if (!expectedPreviewHash || expectedPreviewHash !== preview.preview_hash) throw new Error("stale_related_edge_refinement_preview");
    const now = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.preview(candidateIdValue, decision, scopeSafe);
      if (!current.eligible || current.preview_hash !== expectedPreviewHash) throw new Error("stale_related_edge_refinement_preview");
      const candidate = this.find(candidateIdValue, scopeSafe)!;
      const auditId = `related-edge-refinement:${randomUUID()}`;
      let edgeId: string | undefined, observationId: string | undefined, retiredEdgeId: string | undefined;
      if (decision === "accepted") {
        const legacy = this.activeLegacy(candidate, scopeSafe);
        if (!legacy) throw new Error("related_edge_refinement_legacy_changed");
        edgeId = graphEdgeId(candidate.proposed_source.id, candidate.proposed_target.id, candidate.proposed_type);
        const existing = this.db.prepare("SELECT edge_props FROM kg_edges WHERE id=?").get(edgeId) as { edge_props?: string } | undefined;
        const edgeProps = { ...parseObject(existing?.edge_props), related_edge_refinement: { version: 1, candidate_id: candidate.id, legacy_edge_id: candidate.legacy_edge_id, rationale: candidate.rationale } };
        this.db.prepare(`INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at)
          VALUES(?,?,?,?,?,0,NULL,?,?) ON CONFLICT(source_id,target_id,type) DO UPDATE SET edge_props=excluded.edge_props,deleted_at=NULL,updated_at=excluded.updated_at`)
          .run(edgeId, candidate.proposed_source.id, candidate.proposed_target.id, candidate.proposed_type, JSON.stringify(edgeProps), now, now);
        const evidence = this.db.prepare("SELECT source,quote,confidence,valid_from,valid_to,temporal_confidence FROM kg_observations WHERE id=? AND edge_id=? AND scope=?").get(candidate.evidence.observation_id, candidate.legacy_edge_id, scopeSafe) as { source: string; quote: string; confidence: number; valid_from: number | null; valid_to: number | null; temporal_confidence: number | null } | undefined;
        if (!evidence || hash(evidence.quote) !== candidate.evidence_hash) throw new Error("related_edge_refinement_evidence_changed");
        observationId = `obs:${randomUUID()}`;
        this.db.prepare(`INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,scope,quote,confidence,valid_from,valid_to,temporal_confidence,created_at)
          VALUES(?,?,NULL,?,?,?,?,?,?,?,?,?)`).run(observationId, edgeId, JSON.stringify({ related_edge_refinement_candidate_id: candidate.id, legacy_edge_id: candidate.legacy_edge_id, proposed_type: candidate.proposed_type, rationale: candidate.rationale }), `related-edge-refinement:${candidate.id}`, scopeSafe, evidence.quote.slice(0, 2000), clamp01(evidence.confidence * .8), evidence.valid_from, evidence.valid_to, evidence.temporal_confidence, now);
        const aggregate = this.db.prepare("SELECT COUNT(*) AS count,AVG(confidence) AS confidence FROM kg_observations WHERE edge_id=?").get(edgeId) as { count?: number; confidence?: number };
        this.db.prepare("UPDATE kg_edges SET weight=?,updated_at=? WHERE id=?").run(edgeWeight(Number(aggregate.count ?? 0), Number(aggregate.confidence ?? 0)), now, edgeId);
        if (Number(this.db.prepare("UPDATE kg_edges SET deleted_at=?,updated_at=? WHERE id=? AND type='related_to' AND deleted_at IS NULL").run(now, now, legacy.id).changes) !== 1) throw new Error("related_edge_refinement_legacy_changed");
        retiredEdgeId = legacy.id;
        bumpGraphRevision(this.db, now);
      }
      if (Number(this.db.prepare("UPDATE kg_related_edge_refinement_candidates SET status=?,reviewed_at=?,updated_at=? WHERE id=? AND scope=? AND status='pending'").run(decision, now, now, candidate.id, scopeSafe).changes) !== 1) throw new Error("stale_related_edge_refinement_preview");
      this.db.prepare("INSERT INTO kg_quality_audits(id,action,snapshot_version,snapshot,created_at) VALUES(?,?,1,?,?)")
        .run(auditId, "confirm_related_edge_refinement", JSON.stringify({ candidate_id: candidate.id, scope: scopeSafe, decision, proposed_type: candidate.proposed_type, preview_hash: expectedPreviewHash, ...(edgeId ? { edge_id: edgeId, observation_id: observationId, retired_edge_id: retiredEdgeId } : {}) }), now);
      this.db.prepare(`INSERT INTO kg_related_edge_refinement_receipts(candidate_id,scope,decision,preview_hash,audit_id,edge_id,observation_id,retired_edge_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(candidate.id, scopeSafe, decision, expectedPreviewHash, auditId, edgeId ?? null, observationId ?? null, retiredEdgeId ?? null, now);
      this.db.exec("COMMIT");
      return { confirmed: true, candidate_id: candidate.id, decision, preview_hash: expectedPreviewHash, eligible: true, audit_id: auditId, ...(edgeId ? { edge_id: edgeId, observation_id: observationId, retired_edge_id: retiredEdgeId } : {}) };
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  private find(id: string, scope: string): RelatedEdgeRefinementCandidate | undefined {
    const row = this.db.prepare(candidateSelect("WHERE c.id=? AND c.scope=?")).get(boundedId(id), scope) as CandidateRow | undefined;
    return row ? mapCandidate(row) : undefined;
  }

  private activeLegacy(candidate: RelatedEdgeRefinementCandidate, scope: string): { id: string; updated_at: number } | undefined {
    const row = this.db.prepare(`SELECT e.id,e.updated_at FROM kg_edges e JOIN kg_observations o ON o.id=? AND o.edge_id=e.id AND o.scope=?
      WHERE e.id=? AND e.deleted_at IS NULL AND e.type='related_to' AND e.source_id=? AND e.target_id=?`).get(candidate.evidence.observation_id, scope, candidate.legacy_edge_id, candidate.source.id, candidate.target.id) as { id: string; updated_at: number } | undefined;
    return row;
  }

  private hasNodeEvidence(nodeId: string, scope: string): boolean {
    return this.db.prepare("SELECT 1 AS present FROM kg_observations WHERE source_entity_id=? AND scope=? LIMIT 1").get(nodeId, scope) != null;
  }

  private evidenceHash(observationId: string): string | undefined {
    const row = this.db.prepare("SELECT quote FROM kg_observations WHERE id=?").get(observationId) as { quote?: string } | undefined;
    return typeof row?.quote === "string" ? hash(row.quote) : undefined;
  }
}

function classify(row: LegacyRow): { type: RelatedEdgeRefinementType; rationale: string; sourceId: string; targetId: string } | undefined {
  const quote = row.quote.normalize("NFKC"), pairs = [
    { sourceName: row.source_name, targetName: row.target_name, sourceId: row.source_id, targetId: row.target_id },
    { sourceName: row.target_name, targetName: row.source_name, sourceId: row.target_id, targetId: row.source_id }
  ];
  for (const pattern of topologyPatterns) for (const pair of pairs) {
    if (matchesOrderedCue(quote, pair.sourceName, pair.targetName, pattern.cue)) return { type: pattern.type, rationale: pattern.rationale, sourceId: pair.sourceId, targetId: pair.targetId };
  }
  return undefined;
}

function matchesOrderedCue(quote: string, source: string, target: string, cue: string): boolean {
  if (!source.trim() || !target.trim() || source === target) return false;
  return new RegExp(`${escapeRegex(source.normalize("NFKC"))}[\\s\\S]{0,96}${cue}[\\s\\S]{0,96}${escapeRegex(target.normalize("NFKC"))}`, "iu").test(quote);
}

function candidateSelect(suffix: string): string {
  return `SELECT c.*,s.name AS source_name,t.name AS target_name,ps.name AS proposed_source_name,pt.name AS proposed_target_name,
    o.source AS evidence_source,o.quote AS evidence_quote,o.confidence AS evidence_confidence
    FROM kg_related_edge_refinement_candidates c
      JOIN kg_nodes s ON s.id=c.source_entity_id
      JOIN kg_nodes t ON t.id=c.target_entity_id
      JOIN kg_nodes ps ON ps.id=c.proposed_source_entity_id
      JOIN kg_nodes pt ON pt.id=c.proposed_target_entity_id
      JOIN kg_observations o ON o.id=c.evidence_observation_id ${suffix}`;
}

function mapCandidate(row: CandidateRow): RelatedEdgeRefinementCandidate {
  const type = row.proposed_type as RelatedEdgeRefinementType;
  return {
    id: row.id, scope: row.scope, legacy_edge_id: row.legacy_edge_id,
    source: { id: row.source_entity_id, name: row.source_name }, target: { id: row.target_entity_id, name: row.target_name },
    proposed_source: { id: row.proposed_source_entity_id, name: row.proposed_source_name }, proposed_target: { id: row.proposed_target_entity_id, name: row.proposed_target_name },
    proposed_type: type, rationale: row.rationale, confidence: clamp01(row.confidence), evidence_hash: row.evidence_hash, status: row.status === "accepted" ? "accepted" : row.status === "rejected" ? "rejected" : "pending",
    evidence: { observation_id: row.evidence_observation_id, source: row.evidence_source, quote: row.evidence_quote.slice(0, quoteLimit), confidence: clamp01(row.evidence_confidence) },
    first_seen_at: Number(row.first_seen_at), updated_at: Number(row.updated_at), reviewed_at: row.reviewed_at == null ? null : Number(row.reviewed_at)
  };
}

function candidateId(scope: string, edgeId: string, observationId: string, type: string, sourceId: string, targetId: string): string {
  return `related-edge-refinement:${hash([scope, edgeId, observationId, type, sourceId, targetId].join("\u0000")).slice(0, 40)}`;
}
function graphEdgeId(source: string, target: string, type: RelatedEdgeRefinementType): string { return `edge:${hash(`${source}\0${target}\0${type}`).slice(0, 24)}`; }
function graphRevision(db: DatabaseSyncInstance): number { return Number((db.prepare("SELECT value FROM kg_graph_state WHERE key='content_revision'").get() as { value?: number } | undefined)?.value ?? 0); }
function bumpGraphRevision(db: DatabaseSyncInstance, now: number): void { db.prepare("UPDATE kg_graph_state SET value=value+1,updated_at=? WHERE key='content_revision'").run(now); }
function receiptHash(db: DatabaseSyncInstance, candidateIdValue: string): string | undefined { return (db.prepare("SELECT preview_hash FROM kg_related_edge_refinement_receipts WHERE candidate_id=?").get(candidateIdValue) as { preview_hash?: string } | undefined)?.preview_hash; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function clamp01(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
function boundedId(value: string | undefined): string { return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : ""; }
function parseObject(value: string | undefined): Record<string, unknown> { try { const parsed = JSON.parse(value ?? "{}"); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
