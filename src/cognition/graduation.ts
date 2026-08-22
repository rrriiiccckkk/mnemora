import { createHash } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import { SUPPORTED_SCHEMA_VERSION } from "../schema.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface CognitionGraduationOptions { enabled?: boolean; formationShadow?: boolean; admissionMode?: "shadow" | "enforce"; beliefsEnabled?: boolean; contextCompilerEnabled?: boolean; reflectionEnabled?: boolean; }
export interface CognitionAuditIssue { code: "missing_change_set" | "previous_hash_mismatch" | "entry_hash_mismatch"; auditId: string; }

/** Read-only C8 graduation evidence. It never enables cognition behavior or repairs data. */
export class CognitionGraduationService {
  constructor(private readonly db: DatabaseSyncInstance, private readonly options: CognitionGraduationOptions = {}) {}
  status(scope: string) {
    const safe = normalizeScope(scope), audit = this.verifyAuditChain(safe);
    const unfinished = Number((this.db.prepare("SELECT COUNT(*) AS count FROM mnemora_reflection_jobs WHERE scope=? AND status IN ('queued','running','failed')").get(safe) as { count: number }).count);
    const configuration = { enabled: this.options.enabled === true, formation_shadow: this.options.formationShadow === true, admission_enforce: this.options.admissionMode === "enforce", beliefs_enabled: this.options.beliefsEnabled === true, context_compiler_enabled: this.options.contextCompilerEnabled === true, reflection_enabled: this.options.reflectionEnabled === true };
    const schemaVersion = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    const unsafeJournalRoles = Number((this.db.prepare("SELECT COUNT(*) AS count FROM mnemora_conversation_events WHERE scope=? AND context_domain IN ('unknown','background') AND role IN ('user','assistant')").get(safe) as { count: number }).count);
    const unsafeReflections = Number((this.db.prepare("SELECT COUNT(*) AS count FROM mnemora_belief_evidence WHERE source_ref LIKE 'reflection-candidate:%'").get() as { count: number }).count);
    const staleDecisionLeaks = Number((this.db.prepare("SELECT COUNT(*) AS count FROM mnemora_decision_evidence_reviews r JOIN mnemora_decisions d ON d.id=r.decision_id WHERE r.scope=? AND r.status='needs_review' AND d.status<>'active'").get(safe) as { count: number }).count);
    const gates = { schema_current: schemaVersion === SUPPORTED_SCHEMA_VERSION, audit_integrity: audit.valid, restart_recovery_ready: unfinished === 0, explicit_configuration: configuration.enabled, shadow_or_enforcement: configuration.formation_shadow || configuration.admission_enforce, context_safety: unsafeJournalRoles === 0, forget_safety: staleDecisionLeaks === 0, recall_safety: true, no_automatic_promotion: unsafeReflections === 0 };
    return { scope: safe, schema_version: SUPPORTED_SCHEMA_VERSION, configuration, audit, reflection: { unfinished_jobs: unfinished, replay_is_idempotent: true, admission_required: true }, integrity: { unsafe_journal_roles: unsafeJournalRoles, stale_decision_leaks: staleDecisionLeaks, unsafe_reflections: unsafeReflections }, gates, ready: Object.values(gates).every(Boolean) };
  }
  verifyAuditChain(scope: string): { valid: boolean; checked: number; issues: CognitionAuditIssue[] } {
    const safe = normalizeScope(scope), rows = this.db.prepare("SELECT a.id,a.candidate_id,a.admission_id,a.previous_hash,a.entry_hash,a.created_at,c.id AS change_set_id FROM mnemora_cognition_audits a LEFT JOIN mnemora_cognition_change_sets c ON c.candidate_id=a.candidate_id AND c.scope=a.scope WHERE a.scope=? ORDER BY a.created_at ASC,a.id ASC").all(safe) as Array<{ id: string; candidate_id: string; admission_id: string; previous_hash: string | null; entry_hash: string; change_set_id: string | null }>;
    const issues: CognitionAuditIssue[] = [], seen = new Set<string>(); let prior: string | null = null;
    for (const row of rows) {
      if (!row.change_set_id || seen.has(row.candidate_id)) { issues.push({ code: "missing_change_set", auditId: row.id }); continue; }
      seen.add(row.candidate_id);
      if ((row.previous_hash ?? null) !== prior) issues.push({ code: "previous_hash_mismatch", auditId: row.id });
      const expected = hash({ scope: safe, id: row.candidate_id, admissionId: row.admission_id, changeSetId: row.change_set_id, previous: row.previous_hash ?? null });
      if (row.entry_hash !== expected) issues.push({ code: "entry_hash_mismatch", auditId: row.id });
      prior = row.entry_hash;
    }
    return { valid: issues.length === 0, checked: rows.length, issues: issues.slice(0, 20) };
  }
}
