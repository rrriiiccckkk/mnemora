import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";

type Decision = "accepted" | "rejected";
type CandidateStatus = "collecting" | "pending" | Decision;
type VocabularyDomain = "neutral";

export interface SemanticVocabularyCandidate {
  id: string;
  scope: string;
  predicate: string;
  source_type: string;
  target_type: string;
  rationale: string;
  occurrence_count: number;
  source_count: number;
  status: CandidateStatus;
  first_seen_at: number;
  updated_at: number;
  reviewed_at: number | null;
}

export interface SemanticVocabularyScanResult {
  scanned: number;
  evidence_recorded: number;
  candidates_created: number;
  candidates_promoted: number;
  next_edge_id?: string;
}

export interface SemanticVocabularyReviewResult {
  confirmed: boolean;
  candidate_id: string;
  decision: Decision;
  preview_hash: string;
  eligible: boolean;
  reason?: "missing_candidate" | "not_ready" | "already_reviewed" | "evidence_changed";
  audit_id?: string;
}

export interface SemanticVocabularyProposal {
  predicate: string;
  rationale: string;
  domain: VocabularyDomain;
  endpoint_match: true;
}

interface CandidateRow {
  id: string; scope: string; predicate: string; source_type: string; target_type: string; cue_id: string; rationale: string;
  occurrence_count: number; source_count: number; status: string; first_seen_at: number; updated_at: number; reviewed_at: number | null;
}

interface LegacyRow {
  id: string; source_id: string; target_id: string; source_name: string; source_type: string; target_name: string; target_type: string;
  observation_id: string; source: string; quote: string; confidence: number;
}

interface Pattern {
  predicate: string;
  cue_id: string;
  rationale: string;
  cue: string;
  source: string;
  target: string;
}

const maximumScan = 100;
const minimumConfidence = .85;
const minimumOccurrences = 3;
const minimumSources = 2;

/** Deliberately small, domain-neutral seed set. A pattern is inert until its
 * exact type pair accumulates independent direct evidence and an operator
 * confirms it for the scope. */
const patterns: readonly Pattern[] = [
  { predicate: "located_in", cue_id: "location", rationale: "direct_location_cue", cue: "(?:\\blocated\\s+in\\b|\\bbased\\s+in\\b|\\bheadquartered\\s+in\\b|位于|坐落于|总部位于)", source: "company|person|product", target: "concept" },
  { predicate: "member_of", cue_id: "membership", rationale: "direct_membership_cue", cue: "(?:\\bmember\\s+of\\b|成员|隶属于)", source: "person", target: "company|concept" },
  { predicate: "created_by", cue_id: "creation", rationale: "direct_creation_cue", cue: "(?:\\bcreated\\s+by\\b|\\bcreated\\s+.*\\bby\\b|由[^。；,，;]{0,64}创建)", source: "product|technology|concept", target: "person|company" },
  { predicate: "authored_by", cue_id: "authorship", rationale: "direct_authorship_cue", cue: "(?:\\bauthored\\s+by\\b|\\bwritten\\s+by\\b|作者是|由[^。；,，;]{0,64}撰写)", source: "product|concept", target: "person" },
  { predicate: "based_on", cue_id: "basis", rationale: "direct_basis_cue", cue: "(?:\\bbased\\s+on\\b|基于)", source: "product|technology|concept", target: "product|technology|concept" }
];

/** Deep local module for the vocabulary lifecycle. Its one interface handles
 * bounded discovery, preview/confirm governance, and approved-cue matching. */
export class SemanticVocabularyRepository {
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {}

  scan(input: { scope: string; afterEdgeId?: string; limit?: number }): SemanticVocabularyScanResult {
    const scope = normalizeScope(input.scope), after = boundedId(input.afterEdgeId), limit = boundedLimit(input.limit);
    const rows = this.db.prepare(`SELECT e.id,e.source_id,e.target_id,s.name AS source_name,s.type AS source_type,t.name AS target_name,t.type AS target_type,
      o.id AS observation_id,o.source,o.quote,o.confidence
      FROM kg_edges e JOIN kg_nodes s ON s.id=e.source_id AND s.deleted_at IS NULL
        JOIN kg_nodes t ON t.id=e.target_id AND t.deleted_at IS NULL
        JOIN kg_observations o ON o.id=(SELECT io.id FROM kg_observations io
          WHERE io.edge_id=e.id AND io.scope=? AND io.confidence>=? AND length(trim(io.quote))>0
          ORDER BY io.confidence DESC,io.created_at DESC,io.id LIMIT 1)
      WHERE e.deleted_at IS NULL AND e.type='related_to' AND e.source_id<>e.target_id AND e.id>?
      ORDER BY e.id LIMIT ?`).all(scope, minimumConfidence, after, limit) as LegacyRow[];
    let evidence_recorded = 0, candidates_created = 0, candidates_promoted = 0;
    for (const row of rows) {
      const pattern = matchPattern(row);
      if (!pattern) continue;
      const id = candidateId(scope, pattern, row.source_type, row.target_type);
      const existing = this.getRow(id, scope);
      if (existing?.status === "accepted" || existing?.status === "rejected") continue;
      const now = this.now();
      if (!existing) {
        this.db.prepare(`INSERT INTO kg_semantic_vocabulary_candidates(
          id,scope,predicate,source_type,target_type,cue_id,rationale,occurrence_count,source_count,status,first_seen_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,0,0,'collecting',?,?)`).run(id, scope, pattern.predicate, row.source_type, row.target_type, pattern.cue_id, pattern.rationale, now, now);
        candidates_created++;
      }
      const inserted = this.db.prepare(`INSERT INTO kg_semantic_vocabulary_candidate_evidence(candidate_id,edge_id,observation_id,evidence_hash,source_hash)
        VALUES(?,?,?,?,?) ON CONFLICT(candidate_id,observation_id) DO NOTHING`)
        .run(id, row.id, row.observation_id, hash(row.quote), hash(row.source));
      if (Number(inserted.changes) !== 1) continue;
      evidence_recorded++;
      const counts = this.countEvidence(id);
      const previous = existing?.status ?? "collecting";
      const status = previous === "collecting" && counts.occurrence_count >= minimumOccurrences && counts.source_count >= minimumSources ? "pending" : previous;
      if (previous !== "pending" && status === "pending") candidates_promoted++;
      this.db.prepare("UPDATE kg_semantic_vocabulary_candidates SET occurrence_count=?,source_count=?,status=?,updated_at=? WHERE id=? AND scope=?")
        .run(counts.occurrence_count, counts.source_count, status, now, id, scope);
    }
    return { scanned: rows.length, evidence_recorded, candidates_created, candidates_promoted, ...(rows.length === limit ? { next_edge_id: rows[rows.length - 1]!.id } : {}) };
  }

  list(scope: string, status: Exclude<CandidateStatus, "collecting"> = "pending", limit = 20): { items: SemanticVocabularyCandidate[] } {
    const safe = normalizeScope(scope), take = boundedLimit(limit);
    const rows = this.db.prepare("SELECT * FROM kg_semantic_vocabulary_candidates WHERE scope=? AND status=? ORDER BY occurrence_count DESC,source_count DESC,updated_at DESC,id LIMIT ?")
      .all(safe, status, take) as CandidateRow[];
    return { items: rows.map(mapCandidate) };
  }

  preview(candidateIdValue: string, decision: Decision, scope = "default"): SemanticVocabularyReviewResult {
    const safe = normalizeScope(scope), candidate = this.getRow(candidateIdValue, safe);
    const basic = { confirmed: false, candidate_id: candidateIdValue, decision } as const;
    if (!candidate) return { ...basic, preview_hash: "", eligible: false, reason: "missing_candidate" };
    if (candidate.status !== "pending") return { ...basic, preview_hash: reviewHash(this.db, candidate.id) ?? "", eligible: false, reason: candidate.status === "collecting" ? "not_ready" : "already_reviewed" };
    const evidence = this.activeEvidence(candidate);
    if (evidence.occurrence_count < minimumOccurrences || evidence.source_count < minimumSources) return { ...basic, preview_hash: "", eligible: false, reason: "evidence_changed" };
    const snapshot = {
      candidate_id: candidate.id, scope: safe, predicate: candidate.predicate, source_type: candidate.source_type, target_type: candidate.target_type,
      cue_id: candidate.cue_id, occurrence_count: evidence.occurrence_count, source_count: evidence.source_count, evidence: evidence.identities, decision
    };
    return { ...basic, preview_hash: hash(JSON.stringify(snapshot)), eligible: true };
  }

  confirm(candidateIdValue: string, decision: Decision, expectedPreviewHash: string, scope = "default"): SemanticVocabularyReviewResult {
    const safe = normalizeScope(scope), preview = this.preview(candidateIdValue, decision, safe);
    if (!preview.eligible) return preview;
    if (!expectedPreviewHash || expectedPreviewHash !== preview.preview_hash) throw new Error("stale_semantic_vocabulary_preview");
    const now = this.now(), auditId = `semantic-vocabulary-review:${randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.preview(candidateIdValue, decision, safe);
      if (!current.eligible || current.preview_hash !== expectedPreviewHash) throw new Error("stale_semantic_vocabulary_preview");
      if (Number(this.db.prepare("UPDATE kg_semantic_vocabulary_candidates SET status=?,reviewed_at=?,updated_at=? WHERE id=? AND scope=? AND status='pending'")
        .run(decision, now, now, candidateIdValue, safe).changes) !== 1) throw new Error("stale_semantic_vocabulary_preview");
      this.db.prepare("INSERT INTO kg_quality_audits(id,action,snapshot_version,snapshot,created_at) VALUES(?,?,1,?,?)")
        .run(auditId, "confirm_semantic_vocabulary", JSON.stringify({ candidate_id: candidateIdValue, scope: safe, decision, preview_hash: expectedPreviewHash }), now);
      this.db.prepare("INSERT INTO kg_semantic_vocabulary_reviews(candidate_id,scope,decision,preview_hash,audit_id,created_at) VALUES(?,?,?,?,?,?)")
        .run(candidateIdValue, safe, decision, expectedPreviewHash, auditId, now);
      this.db.exec("COMMIT");
      return { confirmed: true, candidate_id: candidateIdValue, decision, preview_hash: expectedPreviewHash, eligible: true, audit_id: auditId };
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  classify(input: { scope: string; source_name: string; source_type: string; target_name: string; target_type: string; quote: string }): SemanticVocabularyProposal | undefined {
    const safe = normalizeScope(input.scope);
    const rows = this.db.prepare("SELECT * FROM kg_semantic_vocabulary_candidates WHERE scope=? AND status='accepted' ORDER BY id LIMIT 100").all(safe) as CandidateRow[];
    for (const row of rows) {
      const pattern = patterns.find(item => item.predicate === row.predicate && item.cue_id === row.cue_id);
      if (!pattern || row.source_type !== input.source_type || row.target_type !== input.target_type) continue;
      if (matchesOrderedCue(input.quote, input.source_name, input.target_name, pattern.cue)) return { predicate: row.predicate, rationale: row.rationale, domain: "neutral", endpoint_match: true };
    }
    return undefined;
  }

  private getRow(id: string, scope: string): CandidateRow | undefined {
    return this.db.prepare("SELECT * FROM kg_semantic_vocabulary_candidates WHERE id=? AND scope=?").get(boundedId(id), normalizeScope(scope)) as CandidateRow | undefined;
  }

  private countEvidence(candidateIdValue: string): { occurrence_count: number; source_count: number } {
    const row = this.db.prepare("SELECT COUNT(*) AS occurrence_count,COUNT(DISTINCT source_hash) AS source_count FROM kg_semantic_vocabulary_candidate_evidence WHERE candidate_id=?").get(candidateIdValue) as { occurrence_count?: number; source_count?: number } | undefined;
    return { occurrence_count: Number(row?.occurrence_count ?? 0), source_count: Number(row?.source_count ?? 0) };
  }

  private activeEvidence(candidate: CandidateRow): { occurrence_count: number; source_count: number; identities: string[] } {
    const rows = this.db.prepare(`SELECT ce.observation_id,ce.evidence_hash,ce.source_hash,o.quote,o.source
      FROM kg_semantic_vocabulary_candidate_evidence ce JOIN kg_edges e ON e.id=ce.edge_id AND e.deleted_at IS NULL AND e.type='related_to'
        JOIN kg_observations o ON o.id=ce.observation_id AND o.edge_id=e.id AND o.scope=?
      WHERE ce.candidate_id=? ORDER BY ce.observation_id LIMIT 100`).all(candidate.scope, candidate.id) as Array<{ observation_id: string; evidence_hash: string; source_hash: string; quote: string; source: string }>;
    const current = rows.filter(row => hash(row.quote) === row.evidence_hash && hash(row.source) === row.source_hash);
    return { occurrence_count: current.length, source_count: new Set(current.map(row => row.source_hash)).size, identities: current.map(row => `${row.observation_id}:${row.evidence_hash}`) };
  }
}

function matchPattern(row: LegacyRow): Pattern | undefined {
  return patterns.find(pattern => typeMatches(pattern.source, row.source_type) && typeMatches(pattern.target, row.target_type) && matchesOrderedCue(row.quote, row.source_name, row.target_name, pattern.cue));
}
function mapCandidate(row: CandidateRow): SemanticVocabularyCandidate {
  return {
    id: row.id, scope: row.scope, predicate: row.predicate, source_type: row.source_type, target_type: row.target_type, rationale: row.rationale,
    occurrence_count: Number(row.occurrence_count), source_count: Number(row.source_count), status: row.status === "accepted" || row.status === "rejected" || row.status === "pending" ? row.status : "collecting",
    first_seen_at: Number(row.first_seen_at), updated_at: Number(row.updated_at), reviewed_at: row.reviewed_at == null ? null : Number(row.reviewed_at)
  };
}
function candidateId(scope: string, pattern: Pattern, sourceType: string, targetType: string): string { return `semantic-vocabulary:${hash([scope, pattern.predicate, sourceType, targetType, pattern.cue_id].join("\u0000")).slice(0, 40)}`; }
function reviewHash(db: DatabaseSyncInstance, candidateIdValue: string): string | undefined { return (db.prepare("SELECT preview_hash FROM kg_semantic_vocabulary_reviews WHERE candidate_id=?").get(candidateIdValue) as { preview_hash?: string } | undefined)?.preview_hash; }
function typeMatches(expected: string, actual: string): boolean { return expected.split("|").includes(actual); }
function matchesOrderedCue(quote: string, source: string, target: string, cue: string): boolean {
  if (!source.trim() || !target.trim() || source === target) return false;
  return new RegExp(`${escapeRegex(source.normalize("NFKC"))}[\\s\\S]{0,96}${cue}[\\s\\S]{0,96}${escapeRegex(target.normalize("NFKC"))}`, "iu").test(quote.normalize("NFKC"));
}
function boundedLimit(value: number | undefined): number { return Math.min(maximumScan, Math.max(1, Math.trunc(value ?? 20))); }
function boundedId(value: string | undefined): string { return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : ""; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
