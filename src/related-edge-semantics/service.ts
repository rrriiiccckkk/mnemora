import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import { GraphReviewLifecycleRepository, type GraphReviewInvalidationReason } from "../graph-review/lifecycle.js";
import { SemanticVocabularyRepository } from "../semantic-vocabulary/repository.js";

/** Built-in labels and operator-approved vocabulary labels share this narrow
 * projection path. Neither form is a graph edge type. */
export type RelatedEdgeSemanticType = string;
type Decision = "accepted" | "rejected";

export interface RelatedEdgeSemanticCandidate {
  id: string;
  scope: string;
  legacy_edge_id: string;
  source: { id: string; name: string; type: string };
  target: { id: string; name: string; type: string };
  proposed_type: RelatedEdgeSemanticType;
  rationale: string;
  confidence: number;
  evidence_hash: string;
  status: "pending" | Decision | "invalidated";
  invalidation?: { reason: GraphReviewInvalidationReason; invalidated_at: number };
  evidence: { observation_id: string; source: string; quote: string; confidence: number };
  first_seen_at: number;
  updated_at: number;
  reviewed_at: number | null;
}

export interface RelatedEdgeSemanticScanResult {
  scanned: number;
  candidates_created: number;
  candidates_updated: number;
  next_edge_id?: string;
}

export interface RelatedEdgeSemanticReviewResult {
  confirmed: boolean;
  candidate_id: string;
  decision: Decision;
  preview_hash: string;
  eligible: boolean;
  reason?: "missing_candidate" | "already_reviewed" | "invalidated" | "legacy_edge_changed" | "missing_scope_evidence";
  invalidation_reason?: GraphReviewInvalidationReason;
  audit_id?: string;
}

interface CandidateRow {
  id: string; scope: string; legacy_edge_id: string; source_entity_id: string; target_entity_id: string;
  proposed_type: string; evidence_observation_id: string; evidence_hash: string; rationale: string; confidence: number;
  status: string; first_seen_at: number; updated_at: number; reviewed_at: number | null;
  source_name: string; source_type: string; target_name: string; target_type: string;
  evidence_source: string; evidence_quote: string; evidence_confidence: number; invalidation_reason?: string; invalidated_at?: number;
}

interface LegacyRow {
  id: string; source_id: string; target_id: string; source_name: string; source_type: string; target_name: string; target_type: string;
  observation_id: string; quote: string; confidence: number;
}

const maxScan = 100;
const minimumConfidence = .85;
const quoteLimit = 512;
const semanticPatterns: Array<{ type: RelatedEdgeSemanticType; rationale: string; cue: string; source?: string; target?: string }> = [
  { type: "works_at", rationale: "explicit_employment_cue", cue: "(?:\\bworks?\\s+(?:at|for)\\b|\\bemployed\\s+by\\b|任职于|就职于|受雇于)", source: "person", target: "company" },
  { type: "invested_in", rationale: "explicit_investment_cue", cue: "(?:\\binvest(?:ed|s|ing)?\\s+in\\b|投资(?:了|于)?)", source: "person|fund", target: "company" },
  { type: "supplies_product", rationale: "explicit_product_supply_cue", cue: "(?:\\bsuppl(?:y|ies|ied)\\b|供应(?:了|给)?)", source: "company", target: "product" },
  { type: "supplied_to", rationale: "explicit_customer_supply_cue", cue: "(?:\\bsuppl(?:ied|y)\\s+to\\b|供货给)", source: "product", target: "company" },
  { type: "supplies", rationale: "explicit_supply_cue", cue: "(?:\\bsuppl(?:y|ies|ied)\\b|供应(?:了|给)?)", source: "company", target: "company" },
  { type: "competes_with", rationale: "explicit_competition_cue", cue: "(?:\\bcompetes?\\s+with\\b|竞争(?:对手)?)", source: "company", target: "company" },
  { type: "uses", rationale: "explicit_use_cue", cue: "(?:\\buses?\\b|\\busing\\b|采用|使用)", source: "company|product|technology|concept", target: "technology|product|concept" },
  { type: "develops", rationale: "explicit_development_cue", cue: "(?:\\bdevelop(?:s|ed|ing)?\\b|开发(?:了)?|研制(?:了)?)", source: "company|product|technology|concept", target: "product|technology|concept" },
  { type: "owns", rationale: "explicit_ownership_cue", cue: "(?:\\bowns?\\b|拥有)", source: "company|person", target: "company" },
  { type: "partners_with", rationale: "explicit_partnership_cue", cue: "(?:\\bpartners?\\s+with\\b|\\bpartnered\\s+with\\b|合作)", source: "company", target: "company" },
  { type: "in_portfolio", rationale: "explicit_portfolio_cue", cue: "(?:\\bin\\s+(?:the\\s+)?portfolio\\b|纳入[^。；,，;]{0,32}投资组合)", source: "company", target: "portfolio" }
];

/** A deep, local module for semantic enrichment. It emits no graph fact:
 * acceptance creates a narrow, source-backed read projection only. */
export class RelatedEdgeSemanticService {
  private readonly lifecycle: GraphReviewLifecycleRepository;
  private readonly vocabulary: SemanticVocabularyRepository;
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now, lifecycle?: GraphReviewLifecycleRepository, vocabulary?: SemanticVocabularyRepository) {
    this.lifecycle = lifecycle ?? new GraphReviewLifecycleRepository(db, now);
    this.vocabulary = vocabulary ?? new SemanticVocabularyRepository(db, now);
  }

  scan(input: { scope: string; afterEdgeId?: string; limit?: number }): RelatedEdgeSemanticScanResult {
    const scope = normalizeScope(input.scope), after = boundedId(input.afterEdgeId), limit = boundedLimit(input.limit);
    const rows = this.db.prepare(`SELECT e.id,e.source_id,e.target_id,s.name AS source_name,s.type AS source_type,t.name AS target_name,t.type AS target_type,
      o.id AS observation_id,o.quote,o.confidence
      FROM kg_edges e JOIN kg_nodes s ON s.id=e.source_id AND s.deleted_at IS NULL
        JOIN kg_nodes t ON t.id=e.target_id AND t.deleted_at IS NULL
        JOIN kg_observations o ON o.id=(SELECT io.id FROM kg_observations io
          WHERE io.edge_id=e.id AND io.scope=? AND io.confidence>=? AND length(trim(io.quote))>0
          ORDER BY io.confidence DESC,io.created_at DESC,io.id LIMIT 1)
      WHERE e.deleted_at IS NULL AND e.type='related_to' AND e.source_id<>e.target_id AND e.id>?
      ORDER BY e.id LIMIT ?`).all(scope, minimumConfidence, after, limit) as LegacyRow[];
    let candidates_created = 0, candidates_updated = 0;
    for (const row of rows) {
      const proposal = classify(row) ?? this.vocabulary.classify({
        scope, source_name: row.source_name, source_type: row.source_type, target_name: row.target_name, target_type: row.target_type, quote: row.quote
      });
      if (!proposal) continue;
      const id = candidateId(scope, row.id, row.observation_id, proposal.predicate);
      const existing = this.db.prepare("SELECT status FROM kg_related_edge_semantic_candidates WHERE id=?").get(id) as { status?: string } | undefined;
      const now = this.now(), evidenceHash = hash(row.quote);
      this.db.prepare(`INSERT INTO kg_related_edge_semantic_candidates(
        id,scope,legacy_edge_id,source_entity_id,target_entity_id,proposed_type,evidence_observation_id,evidence_hash,rationale,confidence,status,first_seen_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?) ON CONFLICT(scope,legacy_edge_id,evidence_observation_id,proposed_type)
      DO UPDATE SET evidence_hash=excluded.evidence_hash,rationale=excluded.rationale,confidence=excluded.confidence,updated_at=excluded.updated_at
        WHERE kg_related_edge_semantic_candidates.status='pending'`)
        .run(id, scope, row.id, row.source_id, row.target_id, proposal.predicate, row.observation_id, evidenceHash, proposal.rationale, clamp01(row.confidence), now, now);
      if (!existing) candidates_created++; else if (existing.status === "pending") candidates_updated++;
    }
    return { scanned: rows.length, candidates_created, candidates_updated, ...(rows.length === limit ? { next_edge_id: rows[rows.length - 1]!.id } : {}) };
  }

  list(scope: string, limit = 20): { items: RelatedEdgeSemanticCandidate[] } {
    const safe = normalizeScope(scope), take = boundedLimit(limit);
    this.lifecycle.reconcile(safe, "related_edge_semantic", maxScan);
    const rows = this.db.prepare(candidateSelect("WHERE c.scope=? ORDER BY c.status='pending' DESC,c.updated_at DESC,c.id LIMIT ?")).all(safe, take) as CandidateRow[];
    return { items: rows.map(mapCandidate) };
  }

  preview(candidateIdValue: string, decision: Decision, scope = "default"): RelatedEdgeSemanticReviewResult {
    const safe = normalizeScope(scope);
    this.lifecycle.reconcileCandidate(safe, "related_edge_semantic", candidateIdValue);
    const candidate = this.find(candidateIdValue, safe);
    const basic = { confirmed: false, candidate_id: candidateIdValue, decision } as const;
    if (!candidate) return { ...basic, preview_hash: "", eligible: false, reason: "missing_candidate" };
    if (candidate.status === "invalidated") return { ...basic, preview_hash: "", eligible: false, reason: "invalidated", ...(candidate.invalidation ? { invalidation_reason: candidate.invalidation.reason } : {}) };
    if (candidate.status !== "pending") return { ...basic, preview_hash: receiptHash(this.db, candidate.id) ?? "", eligible: false, reason: "already_reviewed" };
    const legacy = this.activeLegacy(candidate, safe);
    if (!legacy) return { ...basic, preview_hash: "", eligible: false, reason: "legacy_edge_changed" };
    if (!this.hasNodeEvidence(candidate.source.id, safe) || !this.hasNodeEvidence(candidate.target.id, safe)) return { ...basic, preview_hash: "", eligible: false, reason: "missing_scope_evidence" };
    return { ...basic, preview_hash: hash(JSON.stringify({
      candidate_id: candidate.id, scope: safe, decision, proposed_type: candidate.proposed_type,
      candidate_updated_at: candidate.updated_at, evidence_observation_id: candidate.evidence.observation_id,
      evidence_hash: this.evidenceHash(candidate.evidence.observation_id), legacy_edge: legacy, graph_revision: graphRevision(this.db)
    })), eligible: true };
  }

  confirm(candidateIdValue: string, decision: Decision, expectedPreviewHash: string, scope = "default"): RelatedEdgeSemanticReviewResult {
    const safe = normalizeScope(scope), preview = this.preview(candidateIdValue, decision, safe);
    if (!preview.eligible) return preview;
    if (!expectedPreviewHash || expectedPreviewHash !== preview.preview_hash) throw new Error("stale_related_edge_semantic_preview");
    const now = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.preview(candidateIdValue, decision, safe);
      if (!current.eligible || current.preview_hash !== expectedPreviewHash) throw new Error("stale_related_edge_semantic_preview");
      const candidate = this.find(candidateIdValue, safe)!;
      const auditId = `related-edge-semantic:${randomUUID()}`;
      if (Number(this.db.prepare("UPDATE kg_related_edge_semantic_candidates SET status=?,reviewed_at=?,updated_at=? WHERE id=? AND scope=? AND status='pending'").run(decision, now, now, candidate.id, safe).changes) !== 1) throw new Error("stale_related_edge_semantic_preview");
      this.db.prepare("INSERT INTO kg_quality_audits(id,action,snapshot_version,snapshot,created_at) VALUES(?,?,1,?,?)")
        .run(auditId, "confirm_related_edge_semantic", JSON.stringify({ candidate_id: candidate.id, scope: safe, decision, proposed_type: candidate.proposed_type, evidence_observation_id: candidate.evidence.observation_id, preview_hash: expectedPreviewHash }), now);
      this.db.prepare("INSERT INTO kg_related_edge_semantic_reviews(candidate_id,scope,decision,preview_hash,audit_id,created_at) VALUES(?,?,?,?,?,?)")
        .run(candidate.id, safe, decision, expectedPreviewHash, auditId, now);
      if (decision === "accepted") bumpGraphRevision(this.db, now);
      this.db.exec("COMMIT");
      return { confirmed: true, candidate_id: candidate.id, decision, preview_hash: expectedPreviewHash, eligible: true, audit_id: auditId };
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  private find(id: string, scope: string): RelatedEdgeSemanticCandidate | undefined {
    const row = this.db.prepare(candidateSelect("WHERE c.id=? AND c.scope=?")).get(boundedId(id), scope) as CandidateRow | undefined;
    return row ? mapCandidate(row) : undefined;
  }

  private activeLegacy(candidate: RelatedEdgeSemanticCandidate, scope: string): { id: string; updated_at: number } | undefined {
    return this.db.prepare(`SELECT e.id,e.updated_at FROM kg_edges e JOIN kg_observations o ON o.id=? AND o.edge_id=e.id AND o.scope=?
      WHERE e.id=? AND e.deleted_at IS NULL AND e.type='related_to' AND e.source_id=? AND e.target_id=?`).get(candidate.evidence.observation_id, scope, candidate.legacy_edge_id, candidate.source.id, candidate.target.id) as { id: string; updated_at: number } | undefined;
  }

  private hasNodeEvidence(nodeId: string, scope: string): boolean {
    return this.db.prepare("SELECT 1 AS present FROM kg_observations WHERE source_entity_id=? AND scope=? LIMIT 1").get(nodeId, scope) != null;
  }

  private evidenceHash(observationId: string): string | undefined {
    const row = this.db.prepare("SELECT quote FROM kg_observations WHERE id=?").get(observationId) as { quote?: string } | undefined;
    return typeof row?.quote === "string" ? hash(row.quote) : undefined;
  }
}

function classify(row: LegacyRow): { predicate: RelatedEdgeSemanticType; rationale: string } | undefined {
  const quote = row.quote.normalize("NFKC");
  for (const pattern of semanticPatterns) {
    if (!typeMatches(pattern.source, row.source_type) || !typeMatches(pattern.target, row.target_type)) continue;
    if (matchesOrderedCue(quote, row.source_name, row.target_name, pattern.cue)) return { predicate: pattern.type, rationale: pattern.rationale };
  }
  return undefined;
}

function matchesOrderedCue(quote: string, source: string, target: string, cue: string): boolean {
  if (!source.trim() || !target.trim() || source === target) return false;
  return new RegExp(`${escapeRegex(source.normalize("NFKC"))}[\\s\\S]{0,96}${cue}[\\s\\S]{0,96}${escapeRegex(target.normalize("NFKC"))}`, "iu").test(quote);
}

function candidateSelect(suffix: string): string {
  return `SELECT c.*,s.name AS source_name,s.type AS source_type,t.name AS target_name,t.type AS target_type,
    COALESCE(o.source,'') AS evidence_source,COALESCE(o.quote,'') AS evidence_quote,COALESCE(o.confidence,0) AS evidence_confidence,i.reason AS invalidation_reason,i.invalidated_at
    FROM kg_related_edge_semantic_candidates c
      JOIN kg_nodes s ON s.id=c.source_entity_id
      JOIN kg_nodes t ON t.id=c.target_entity_id
      LEFT JOIN kg_observations o ON o.id=c.evidence_observation_id
      LEFT JOIN kg_graph_review_invalidations i ON i.review_kind='related_edge_semantic' AND i.scope=c.scope AND i.candidate_id=c.id ${suffix}`;
}

function mapCandidate(row: CandidateRow): RelatedEdgeSemanticCandidate {
  return {
    id: row.id, scope: row.scope, legacy_edge_id: row.legacy_edge_id,
    source: { id: row.source_entity_id, name: row.source_name, type: row.source_type }, target: { id: row.target_entity_id, name: row.target_name, type: row.target_type },
    proposed_type: row.proposed_type, rationale: row.rationale, confidence: clamp01(row.confidence), evidence_hash: row.evidence_hash,
    status: invalidationReason(row.invalidation_reason) ? "invalidated" : row.status === "accepted" ? "accepted" : row.status === "rejected" ? "rejected" : "pending",
    ...(invalidationReason(row.invalidation_reason) ? { invalidation: { reason: invalidationReason(row.invalidation_reason)!, invalidated_at: Number(row.invalidated_at ?? 0) } } : {}),
    evidence: { observation_id: row.evidence_observation_id, source: row.evidence_source, quote: row.evidence_quote.slice(0, quoteLimit), confidence: clamp01(row.evidence_confidence) },
    first_seen_at: Number(row.first_seen_at), updated_at: Number(row.updated_at), reviewed_at: row.reviewed_at == null ? null : Number(row.reviewed_at)
  };
}

function candidateId(scope: string, edgeId: string, observationId: string, type: string): string { return `related-edge-semantic:${hash([scope, edgeId, observationId, type].join("\u0000")).slice(0, 40)}`; }
function graphRevision(db: DatabaseSyncInstance): number { return Number((db.prepare("SELECT value FROM kg_graph_state WHERE key='content_revision'").get() as { value?: number } | undefined)?.value ?? 0); }
function bumpGraphRevision(db: DatabaseSyncInstance, now: number): void { db.prepare("UPDATE kg_graph_state SET value=value+1,updated_at=? WHERE key='content_revision'").run(now); }
function receiptHash(db: DatabaseSyncInstance, candidateIdValue: string): string | undefined { return (db.prepare("SELECT preview_hash FROM kg_related_edge_semantic_reviews WHERE candidate_id=?").get(candidateIdValue) as { preview_hash?: string } | undefined)?.preview_hash; }
function typeMatches(expected: string | undefined, actual: string): boolean { return !expected || expected.split("|").includes(actual); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function clamp01(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
function boundedId(value: string | undefined): string { return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : ""; }
function boundedLimit(value: number | undefined): number { return Math.min(maxScan, Math.max(1, Math.trunc(value ?? 20))); }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function invalidationReason(value: unknown): GraphReviewInvalidationReason | undefined { return value === "legacy_edge_retired" || value === "evidence_removed" || value === "evidence_changed" || value === "node_evidence_removed" ? value : undefined; }
