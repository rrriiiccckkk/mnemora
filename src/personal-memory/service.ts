import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";

export const PERSONAL_MEMORY_SECTIONS = ["today", "episodes", "claims", "profile", "sources", "summaries", "artifacts", "conflicts", "corrections", "consolidation", "recall", "evaluation"] as const;
export type PersonalMemorySection = typeof PERSONAL_MEMORY_SECTIONS[number];
export interface PersonalMemoryView { kind: "personal_memory"; scope: string; section: PersonalMemorySection; items: Array<Record<string, unknown>>; counts: Record<string, number>; truncated: boolean; }

const sectionSet = new Set<string>(PERSONAL_MEMORY_SECTIONS);
const take = (value: unknown) => Math.min(50, Math.max(1, Number.isSafeInteger(value) ? Number(value) : 20));
const text = (value: unknown, max = 1200) => typeof value === "string" ? value.slice(0, max) : "";
const count = (value: unknown) => Math.max(0, Math.trunc(Number(value) || 0));
const rows = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value) ? value as Array<Record<string, unknown>> : [];

/**
 * Read-only, scope-bound assembly for the Personal Memory Inspector. This
 * service deliberately reads its canonical owners; it never replays history,
 * calls a model/provider, or changes recall, facts, profiles, or proposals.
 */
export class PersonalMemoryInspectorService {
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {}

  read(input: { scope?: unknown; section?: unknown; limit?: unknown; subject?: unknown } = {}): PersonalMemoryView {
    const scope = normalizeScope(typeof input.scope === "string" ? input.scope : undefined, "default");
    const section = typeof input.section === "string" && sectionSet.has(input.section) ? input.section as PersonalMemorySection : "today";
    const limit = take(input.limit);
    const counts = this.counts(scope);
    const items = this.items(scope, section, limit, typeof input.subject === "string" ? input.subject : undefined);
    return { kind: "personal_memory", scope, section, items: items.slice(0, limit), counts, truncated: items.length > limit };
  }

  private counts(scope: string): Record<string, number> {
    const one = (sql: string) => count((this.db.prepare(sql).get(scope) as { value?: unknown } | undefined)?.value);
    return {
      events: one("SELECT COUNT(*) AS value FROM mnemora_conversation_events WHERE scope=? AND deleted_at IS NULL"),
      episodes: one("SELECT COUNT(*) AS value FROM mnemora_episodes WHERE scope=? AND deleted_at IS NULL AND status='active'"),
      claims: one("SELECT COUNT(*) AS value FROM kg_claim_verifications WHERE scope=?"),
      summaries: one("SELECT COUNT(*) AS value FROM mnemora_summary_nodes WHERE scope=? AND deleted_at IS NULL"),
      artifacts: one("SELECT COUNT(*) AS value FROM mnemora_artifacts WHERE scope=? AND deleted_at IS NULL"),
      conflicts: one("SELECT COUNT(*) AS value FROM kg_conflict_candidates WHERE scope=? AND status='pending'"),
      proposals: one("SELECT COUNT(*) AS value FROM mnemora_consolidation_proposals WHERE scope=? AND status='proposed'")
    };
  }

  private items(scope: string, section: PersonalMemorySection, limit: number, subject?: string): Array<Record<string, unknown>> {
    const extra = Math.min(100, limit + 1);
    if (section === "today") return rows(this.db.prepare(`SELECT id,session_id,branch_id,sequence,kind,role,identity_origin,normalized_text,created_at
      FROM mnemora_conversation_events WHERE scope=? AND deleted_at IS NULL AND created_at>=? ORDER BY created_at DESC,id DESC LIMIT ?`).all(scope, this.now() - 86400000, extra)).map(row => ({ id: text(row.id, 160), session_id: text(row.session_id, 160), branch_id: text(row.branch_id, 160), sequence: count(row.sequence), kind: text(row.kind, 40), role: text(row.role, 20) || null, identity_origin: text(row.identity_origin, 40), text: text(row.normalized_text, 1200), created_at: count(row.created_at) }));
    if (section === "episodes") return rows(this.db.prepare(`SELECT id,kind,title,summary,event_start,event_end,recorded_at,importance,confidence,status
      FROM mnemora_episodes WHERE scope=? AND deleted_at IS NULL ORDER BY recorded_at DESC,id DESC LIMIT ?`).all(scope, extra)).map(row => ({ id: text(row.id, 160), kind: text(row.kind, 40), title: text(row.title, 512) || null, summary: text(row.summary, 1200), event_start: row.event_start == null ? null : count(row.event_start), event_end: row.event_end == null ? null : count(row.event_end), recorded_at: count(row.recorded_at), importance: Number(row.importance) || 0, confidence: Number(row.confidence) || 0, status: text(row.status, 40) }));
    if (section === "claims") return rows(this.db.prepare(`SELECT claim_id,status,support_type,extraction_confidence,verification_confidence,source_quality,verifier_kind,created_at,verified_at
      FROM kg_claim_verifications WHERE scope=? ORDER BY created_at DESC,id DESC LIMIT ?`).all(scope, extra)).map(row => ({ claim_id: text(row.claim_id, 160), status: text(row.status, 40), support_type: text(row.support_type, 40) || null, extraction_confidence: row.extraction_confidence == null ? null : Number(row.extraction_confidence), verification_confidence: row.verification_confidence == null ? null : Number(row.verification_confidence), source_quality: row.source_quality == null ? null : Number(row.source_quality), verifier_kind: text(row.verifier_kind, 40), created_at: count(row.created_at), verified_at: row.verified_at == null ? null : count(row.verified_at) }));
    if (section === "profile" && subject?.trim()) {
      const matches = rows(this.db.prepare("SELECT id,name,type FROM kg_nodes WHERE deleted_at IS NULL AND (id=? OR lower(trim(name))=lower(trim(?))) ORDER BY id LIMIT 2").all(subject.trim().slice(0, 200), subject.trim().slice(0, 200)));
      if (matches.length !== 1) return [{ status: matches.length ? "ambiguous_subject" : "subject_not_found", subject: subject.trim().slice(0, 200) }];
      const node = matches[0], id = String(node.id);
      return rows(this.db.prepare(`SELECT e.id,e.type,e.source_id,e.target_id,source.name AS source_name,target.name AS target_name,
        MAX(o.confidence) AS confidence,MAX(o.created_at) AS observed_at,COUNT(*) AS evidence_count
        FROM kg_edges e JOIN kg_observations o ON o.edge_id=e.id JOIN kg_nodes source ON source.id=e.source_id JOIN kg_nodes target ON target.id=e.target_id
        WHERE e.deleted_at IS NULL AND o.scope=? AND (e.source_id=? OR e.target_id=?) AND source.deleted_at IS NULL AND target.deleted_at IS NULL
        GROUP BY e.id,e.type,e.source_id,e.target_id,source.name,target.name ORDER BY observed_at DESC,e.id DESC LIMIT ?`).all(scope, id, id, extra)).map(row => ({ subject_id: id, subject_name: text(node.name, 512), subject_type: text(node.type, 40), edge_id: text(row.id, 160), field: text(row.type, 80), direction: String(row.source_id) === id ? "out" : "in", related_entity: String(row.source_id) === id ? text(row.target_name, 512) : text(row.source_name, 512), confidence: Number(row.confidence) || 0, observed_at: count(row.observed_at), evidence_count: count(row.evidence_count) }));
    }
    if (section === "profile") return rows(this.db.prepare(`SELECT s.subject_id,s.field_key,s.target_id,s.updated_at,subject.name AS subject_name,target.name AS target_name
      FROM kg_profile_selections s JOIN kg_nodes subject ON subject.id=s.subject_id JOIN kg_nodes target ON target.id=s.target_id
      WHERE s.scope=? AND subject.deleted_at IS NULL AND target.deleted_at IS NULL ORDER BY s.updated_at DESC LIMIT ?`).all(scope, extra)).map(row => ({ subject_id: text(row.subject_id, 160), subject_name: text(row.subject_name, 512), field: text(row.field_key, 80), target_id: text(row.target_id, 160), target_name: text(row.target_name, 512), locked: true, updated_at: count(row.updated_at) }));
    if (section === "sources") return rows(this.db.prepare(`SELECT id,provider,status,snapshot_truncated,captured_at,last_checked_at,source_created_at
      FROM kg_source_anchors WHERE scope=? ORDER BY captured_at DESC,id DESC LIMIT ?`).all(scope, extra)).map(row => ({ id: text(row.id, 160), provider: text(row.provider, 80), status: text(row.status, 40), snapshot_truncated: Number(row.snapshot_truncated) === 1, captured_at: count(row.captured_at), last_checked_at: row.last_checked_at == null ? null : count(row.last_checked_at), source_created_at: row.source_created_at == null ? null : count(row.source_created_at) }));
    if (section === "summaries") return rows(this.db.prepare(`SELECT s.id,s.session_id,s.branch_id,s.level,s.estimated_tokens,s.created_at,
      (SELECT COUNT(*) FROM mnemora_summary_event_edges e WHERE e.summary_id=s.id AND e.scope=s.scope) AS event_count,
      (SELECT COUNT(*) FROM mnemora_summary_summary_edges c WHERE c.parent_summary_id=s.id AND c.scope=s.scope) AS child_count
      FROM mnemora_summary_nodes s WHERE s.scope=? AND s.deleted_at IS NULL ORDER BY s.created_at DESC,s.id DESC LIMIT ?`).all(scope, extra)).map(row => ({ id: text(row.id, 160), session_id: text(row.session_id, 160), branch_id: text(row.branch_id, 160), level: count(row.level), estimated_tokens: count(row.estimated_tokens), event_count: count(row.event_count), child_count: count(row.child_count), created_at: count(row.created_at) }));
    if (section === "artifacts") return rows(this.db.prepare(`SELECT id,source_event_id,kind,mime_type,byte_length,preview,created_at,archived_at
      FROM mnemora_artifacts WHERE scope=? AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT ?`).all(scope, extra)).map(row => ({ id: text(row.id, 160), source_event_id: text(row.source_event_id, 160) || null, kind: text(row.kind, 80), mime_type: text(row.mime_type, 160), byte_length: count(row.byte_length), preview: text(row.preview, 512), created_at: count(row.created_at), archived_at: row.archived_at == null ? null : count(row.archived_at) }));
    if (section === "conflicts") return rows(this.db.prepare(`SELECT id,status,category,confidence_a,confidence_b,discovered_at,updated_at FROM kg_conflict_candidates WHERE scope=? ORDER BY updated_at DESC,id DESC LIMIT ?`).all(scope, extra)).map(row => ({ id: text(row.id, 160), status: text(row.status, 40), category: text(row.category, 80), confidence_a: Number(row.confidence_a) || 0, confidence_b: Number(row.confidence_b) || 0, discovered_at: count(row.discovered_at), updated_at: count(row.updated_at) }));
    if (section === "corrections") return rows(this.db.prepare(`SELECT id,status,created_at,committed_at FROM mnemora_change_sets WHERE scope=? ORDER BY created_at DESC,id DESC LIMIT ?`).all(scope, extra)).map(row => ({ id: text(row.id, 160), status: text(row.status, 40), created_at: count(row.created_at), committed_at: row.committed_at == null ? null : count(row.committed_at) }));
    if (section === "consolidation") return rows(this.db.prepare(`SELECT id,kind,status,score,expires_at,created_at,reviewed_at FROM mnemora_consolidation_proposals WHERE scope=? ORDER BY created_at DESC,id DESC LIMIT ?`).all(scope, extra)).map(row => ({ id: text(row.id, 160), kind: text(row.kind, 40), status: text(row.status, 40), score: Number(row.score) || 0, expires_at: count(row.expires_at), created_at: count(row.created_at), reviewed_at: row.reviewed_at == null ? null : count(row.reviewed_at) }));
    if (section === "recall") return rows(this.db.prepare(`SELECT policy_version,candidate_count,fixed_count,adaptive_count,overlap_count,empty,created_at
      FROM kg_recall_shadow_runs WHERE scope=? ORDER BY created_at DESC,id DESC LIMIT ?`).all(scope, extra)).map(row => ({ policy_version: text(row.policy_version, 80), candidate_count: count(row.candidate_count), fixed_count: count(row.fixed_count), adaptive_count: count(row.adaptive_count), overlap_count: count(row.overlap_count), empty: Number(row.empty) === 1, created_at: count(row.created_at), query_explanation: "Use kg_recall_explain or the operator CLI for a bounded query-specific trace." }));
    return [{ report: "personal-memory-harness", status: "local_benchmark_available", command: "npm run benchmark:harness", scope, privacy: "Evaluation data is in-memory and never written to the production store." }];
  }
}
