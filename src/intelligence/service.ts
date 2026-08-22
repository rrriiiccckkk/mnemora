import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";

export type IntelligenceView = "provenance" | "changes";
export interface IntelligenceResult { kind: "memory_intelligence"; view: IntelligenceView; scope: string; items: Array<Record<string, unknown>>; truncated: boolean; }
const id = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 200 && !/[\u0000-\u001f]/.test(value) ? value.trim() : undefined;
const limit = (value: unknown) => Math.min(50, Math.max(1, Number.isSafeInteger(value) ? Number(value) : 20));
const rows = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
const text = (value: unknown, max = 160) => typeof value === "string" ? value.slice(0, max) : "";
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;

/** Read-only explainability projection. It never returns anchor labels, quotes, snapshots, prompts, provider bodies, or raw historical text. */
export class MemoryIntelligenceService {
  constructor(private readonly db: DatabaseSyncInstance) {}

  read(input: { view?: unknown; scope?: unknown; claim_id?: unknown; limit?: unknown } = {}): IntelligenceResult {
    const scope = normalizeScope(typeof input.scope === "string" ? input.scope : undefined, "default"), take = limit(input.limit);
    if (input.view === "provenance") return this.provenance(scope, id(input.claim_id), take);
    return this.changes(scope, take);
  }

  private provenance(scope: string, claimId: string | undefined, take: number): IntelligenceResult {
    if (!claimId) return { kind: "memory_intelligence", view: "provenance", scope, items: [{ status: "claim_id_required" }], truncated: false };
    const verification = rows(this.db.prepare(`SELECT v.id AS verification_id,v.claim_id,v.status AS verification_status,v.support_type,v.extraction_confidence,v.verification_confidence,v.source_quality,v.verifier_kind,v.created_at,v.verified_at,
      a.id AS anchor_id,a.provider,a.status AS source_status,a.captured_at,e.id AS event_id,s.id AS summary_id
      FROM kg_claim_verifications v JOIN kg_source_anchors a ON a.id=v.source_anchor_id
      LEFT JOIN mnemora_conversation_events e ON e.id=a.message_id AND e.scope=a.scope AND e.deleted_at IS NULL
      LEFT JOIN mnemora_summary_nodes s ON s.id=a.summary_id AND s.scope=a.scope AND s.deleted_at IS NULL
      WHERE v.scope=? AND v.claim_id=? ORDER BY v.created_at DESC,v.id DESC LIMIT ?`).all(scope, claimId, take + 1)).map(row => ({
      kind: "verification", verification_id: text(row.verification_id), claim_id: text(row.claim_id), status: text(row.verification_status, 40), support_type: text(row.support_type, 40) || null,
      extraction_confidence: row.extraction_confidence == null ? null : Number(row.extraction_confidence), verification_confidence: row.verification_confidence == null ? null : Number(row.verification_confidence), source_quality: row.source_quality == null ? null : Number(row.source_quality), verifier_kind: text(row.verifier_kind, 40), created_at: integer(row.created_at), verified_at: row.verified_at == null ? null : integer(row.verified_at), anchor: { id: text(row.anchor_id), provider: text(row.provider, 80), status: text(row.source_status, 40), captured_at: integer(row.captured_at) }, ...(text(row.event_id) ? { journal_event_id: text(row.event_id) } : {}), ...(text(row.summary_id) ? { summary_id: text(row.summary_id) } : {})
    }));
    const observation = rows(this.db.prepare(`SELECT o.id,o.edge_id,o.source_entity_id,o.confidence,o.valid_from,o.valid_to,o.created_at,e.type,e.source_id,e.target_id
      FROM kg_observations o LEFT JOIN kg_edges e ON e.id=o.edge_id WHERE o.scope=? AND o.id=? LIMIT 1`).all(scope, claimId)).map(row => ({ kind: "observation", id: text(row.id), edge_id: text(row.edge_id) || null, source_entity_id: text(row.source_entity_id) || null, confidence: Number(row.confidence) || 0, valid_from: row.valid_from == null ? null : integer(row.valid_from), valid_to: row.valid_to == null ? null : integer(row.valid_to), created_at: integer(row.created_at), ...(text(row.type) ? { relationship: { type: text(row.type, 80), source_id: text(row.source_id), target_id: text(row.target_id) } } : {}) }));
    const transitions = rows(this.db.prepare(`SELECT t.id,t.from_status,t.to_status,t.verifier_kind,t.support_type,t.reason_code,t.created_at
      FROM kg_verification_transitions t JOIN kg_claim_verifications v ON v.id=t.verification_id WHERE v.scope=? AND v.claim_id=? ORDER BY t.created_at DESC,t.id DESC LIMIT ?`).all(scope, claimId, take + 1)).map(row => ({ kind: "verification_transition", id: text(row.id), from_status: text(row.from_status, 40), to_status: text(row.to_status, 40), verifier_kind: text(row.verifier_kind, 40), support_type: text(row.support_type, 40) || null, reason_code: text(row.reason_code, 80), created_at: integer(row.created_at) }));
    const items = [...observation, ...verification, ...transitions].sort((a, b) => integer(b.created_at) - integer(a.created_at));
    return { kind: "memory_intelligence", view: "provenance", scope, items: items.slice(0, take), truncated: items.length > take };
  }

  private changes(scope: string, take: number): IntelligenceResult {
    const items = rows(this.db.prepare(`SELECT * FROM (
      SELECT 'verification_transition' AS kind,id,verification_id AS ref_id,to_status AS status,reason_code AS detail,created_at FROM kg_verification_transitions WHERE verification_id IN (SELECT id FROM kg_claim_verifications WHERE scope=?)
      UNION ALL SELECT 'profile_selection' AS kind,id,subject_id AS ref_id,action AS status,field_key AS detail,created_at FROM kg_profile_selection_audits WHERE scope=?
      UNION ALL SELECT 'profile_snapshot' AS kind,id,subject_id AS ref_id,'recorded' AS status,NULL AS detail,created_at FROM kg_profile_projection_snapshots WHERE scope=?
      UNION ALL SELECT 'episode' AS kind,id,id AS ref_id,status AS status,kind AS detail,COALESCE(deleted_at,archived_at,recorded_at) AS created_at FROM mnemora_episodes WHERE scope=?
      UNION ALL SELECT 'summary' AS kind,id,id AS ref_id,CASE WHEN deleted_at IS NULL THEN 'created' ELSE 'forgotten' END AS status,NULL AS detail,COALESCE(deleted_at,created_at) AS created_at FROM mnemora_summary_nodes WHERE scope=?
      UNION ALL SELECT 'consolidation_proposal' AS kind,id,id AS ref_id,status AS status,kind AS detail,COALESCE(reviewed_at,created_at) AS created_at FROM mnemora_consolidation_proposals WHERE scope=?
    ) WHERE created_at IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT ?`).all(scope, scope, scope, scope, scope, scope, take + 1)).map(row => ({ kind: text(row.kind, 80), id: text(row.id), ref_id: text(row.ref_id), status: text(row.status, 80), detail: text(row.detail, 80) || null, created_at: integer(row.created_at) }));
    return { kind: "memory_intelligence", view: "changes", scope, items: items.slice(0, take), truncated: items.length > take };
  }
}
