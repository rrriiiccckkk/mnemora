import { createHash } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import { decideAdmission, type AdmissionMode, type FormationAuthority, type FormationKind } from "./admission.js";
import { BeliefLifecycleService, type BeliefLifecycleOptions } from "./beliefs.js";
import { PreAdmissionRepository, type PreAdmissionDecision, type PreAdmissionMode } from "./pre-admission.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const shadowAuthority = (value: FormationAuthority): "manual_operator" | "assistant_inference" | "external_source" | "unknown" =>
  ["manual_operator", "assistant_inference", "external_source", "unknown"].includes(value)
    ? value as "manual_operator" | "assistant_inference" | "external_source" | "unknown"
    : "manual_operator";

export interface FormationOptions {
  mode?: AdmissionMode;
  /** `off` preserves the historical formation path. Shadow audits only;
   * enforce is the explicit automatic-ingestion gate. */
  preAdmissionMode?: PreAdmissionMode;
  beliefs?: BeliefLifecycleOptions;
}
export interface FormationInput {
  scope: string;
  origin: "explicit_ingest" | "automatic_extract" | "memory_store";
  authority: FormationAuthority;
  kind: FormationKind;
  source: string;
  entities?: number;
  relations?: number;
  content?: string;
  relatedCount?: number;
  priorBeliefId?: string;
}

export interface FormationObservation {
  id: string;
  status: "accepted_shadow" | "rejected_shadow" | "accept" | "reject" | "defer" | "episodic_only" | "requires_review";
  reason: string;
  created: boolean;
  lifecycle?: string;
  preAdmission?: PreAdmissionDecision;
}

/** Owns one atomic local candidate, admission, belief, and audit change. */
export class FormationService {
  private readonly beliefs: BeliefLifecycleService;
  private readonly preAdmissions: PreAdmissionRepository;

  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now, private readonly options: FormationOptions = {}) {
    this.beliefs = new BeliefLifecycleService(db, now, options.beliefs);
    this.preAdmissions = new PreAdmissionRepository(db);
  }

  observe(input: FormationInput): FormationObservation {
    const scope = normalizeScope(input.scope);
    const entities = Math.max(0, Math.min(10000, Math.trunc(input.entities ?? 0)));
    const relations = Math.max(0, Math.min(10000, Math.trunc(input.relations ?? 0)));
    const now = this.now();
    const inputHash = hash({ scope, origin: input.origin, kind: input.kind, source: input.source, entities, relations, content: typeof input.content === "string" ? hash(input.content) : undefined });
    const id = `cognition-candidate:${inputHash.slice(0, 40)}`;
    const admissionId = `cognition-admission:${inputHash.slice(0, 40)}`;
    const changeSetId = `cognition-change:${inputHash.slice(0, 40)}`;
    const preAdmissionMode = this.options.preAdmissionMode ?? "off";
    const preAdmissionInput = { scope, origin: input.origin, kind: input.kind, source: input.source, content: input.content } as const;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const preAdmission = preAdmissionMode === "off" ? undefined : this.preAdmissions.assess(preAdmissionInput);
      // A duplicate already has a complete immutable candidate/audit chain.
      // Creating another change set would make a repeated observation look like
      // independent evidence, so drop it before any new rows are written.
      if (preAdmission?.reason === "same_source_duplicate") {
        this.db.exec("COMMIT");
        return { id, status: "rejected_shadow", reason: preAdmission.reason, created: false, preAdmission };
      }

      const empty = input.kind === "graph_extraction" ? entities + relations === 0 : !input.content?.trim();
      const low = input.kind === "graph_extraction" && entities + relations > 5000;
      const related = Math.max(0, Math.min(1000, Math.trunc(input.relatedCount ?? 0)));
      const gateRejected = preAdmission?.decision === "drop";
      const shadowReason = gateRejected ? "low_confidence" : empty ? "empty_candidate" : low ? "low_confidence" : input.authority === "assistant_inference" ? "assistant_inference" : related ? "related_memory_present" : "valid_shape";
      const shadowStatus = gateRejected || empty || low ? "rejected_shadow" : "accepted_shadow";
      // The pre-admission gate owns deterministic value/duplication decisions;
      // admission is intentionally not asked to manufacture a competing result.
      const decision = this.options.mode === "enforce" && !gateRejected
        ? decideAdmission({ authority: input.authority, kind: input.kind, content: input.content, entities, relations })
        : undefined;

      this.db.prepare("INSERT OR IGNORE INTO kg_scopes(id,created_at,updated_at) VALUES(?,?,?)").run(scope, now, now);
      this.db.prepare("INSERT OR IGNORE INTO mnemora_cognition_change_sets(id,scope,origin,authority,candidate_id,created_at) VALUES(?,?,?,?,?,?)").run(changeSetId, scope, input.origin, input.authority, id, now);
      const inserted = this.db.prepare("INSERT OR IGNORE INTO mnemora_cognition_candidates(id,scope,origin,authority,authority_detail,kind,input_hash,shape_version,entity_count,relation_count,status,created_at) VALUES(?,?,?,?,?,?,?, 'cognition-shape-v1',?,?,?,?)")
        .run(id, scope, input.origin, shadowAuthority(input.authority), input.authority, input.kind, inputHash, entities, relations, shadowStatus, now);
      this.db.prepare("INSERT OR IGNORE INTO mnemora_cognition_evidence_links(candidate_id,scope,reference_kind,reference_hash,created_at) VALUES(?,?, 'source_hash',?,?)").run(id, scope, hash(input.source), now);
      this.db.prepare("INSERT OR IGNORE INTO mnemora_cognition_admissions(id,candidate_id,scope,policy_version,status,reason_code,related_count,created_at) VALUES(?,?,?,'formation-shadow-v1',?,?,?,?)")
        .run(admissionId, id, scope, shadowStatus, shadowReason, related, now);
      if (preAdmission) this.preAdmissions.record(id, preAdmissionInput, preAdmissionMode as Exclude<PreAdmissionMode, "off">, preAdmission, now);
      if (decision) this.db.prepare("INSERT OR IGNORE INTO mnemora_cognition_enforcements(id,candidate_id,scope,authority,memory_shape,durability,outcome,reason_code,policy_version,created_at) VALUES(?,?,?,?,?,?,?,?, 'admission-enforce-v1',?)")
        .run(`cognition-enforcement:${inputHash.slice(0, 40)}`, id, scope, input.authority, decision.memoryShape, decision.durability, decision.outcome, decision.reasonCode, now);
      const previous = this.db.prepare("SELECT entry_hash FROM mnemora_cognition_audits WHERE scope=? ORDER BY created_at DESC,id DESC LIMIT 1").get(scope) as { entry_hash?: string } | undefined;
      const entry = hash({ scope, id, admissionId, changeSetId, previous: previous?.entry_hash ?? null });
      this.db.prepare("INSERT OR IGNORE INTO mnemora_cognition_audits(id,scope,candidate_id,admission_id,previous_hash,entry_hash,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(`cognition-audit:${entry.slice(0, 40)}`, scope, id, admissionId, previous?.entry_hash ?? null, entry, now);
      const lifecycle = decision ? this.beliefs.applyInTransaction({ scope, candidateId: id, authority: input.authority, decision, content: input.content, priorBeliefId: input.priorBeliefId, changeSetId }) : undefined;
      this.db.exec("COMMIT");
      const status = gateRejected && this.options.mode === "enforce" ? "reject" : decision?.outcome ?? shadowStatus;
      return { id, status, reason: preAdmission?.reason ?? decision?.reasonCode ?? shadowReason, created: Number(inserted.changes) > 0, lifecycle: lifecycle?.action, preAdmission };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    }
  }

  status(scope: string) {
    const safe = normalizeScope(scope);
    const counts = (table: string, column: string) => Object.fromEntries((this.db.prepare(`SELECT ${column} AS key,COUNT(*) AS value FROM ${table} WHERE scope=? GROUP BY ${column}`).all(safe) as Array<{ key: string; value: number }>).map(x => [x.key, Number(x.value)]));
    const beliefs = this.beliefs.status(safe);
    return { scope: safe, candidates: counts("mnemora_cognition_candidates", "status"), admissions: counts("mnemora_cognition_admissions", "status"), enforcement: counts("mnemora_cognition_enforcements", "outcome"), beliefs: beliefs.beliefs, belief_transitions: beliefs.transitions, shadow_only: this.options.mode !== "enforce" };
  }
}
