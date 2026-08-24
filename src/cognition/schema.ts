export const cognitionSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_cognition_candidates (
 id TEXT PRIMARY KEY,scope TEXT NOT NULL,origin TEXT NOT NULL CHECK(origin IN ('explicit_ingest','automatic_extract','memory_store')),authority TEXT NOT NULL CHECK(authority IN ('manual_operator','assistant_inference','external_source','unknown')),authority_detail TEXT NOT NULL CHECK(authority_detail IN ('manual_operator','assistant_inference','external_source','unknown','user_correction','user_self_report','user_explicit_preference','tool_observation','assistant_summary','system_derivation')),kind TEXT NOT NULL CHECK(kind IN ('graph_extraction','memory_document')),input_hash TEXT NOT NULL CHECK(length(input_hash)=64),shape_version TEXT NOT NULL,entity_count INTEGER NOT NULL DEFAULT 0,relation_count INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL CHECK(status IN ('observed','rejected_shadow','accepted_shadow')),created_at INTEGER NOT NULL,UNIQUE(scope,origin,input_hash)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_cognition_candidates_scope_created ON mnemora_cognition_candidates(scope,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS mnemora_cognition_evidence_links (
 candidate_id TEXT NOT NULL REFERENCES mnemora_cognition_candidates(id) ON DELETE CASCADE,scope TEXT NOT NULL,reference_kind TEXT NOT NULL CHECK(reference_kind IN ('source_hash','journal_event','memory_document')),reference_hash TEXT NOT NULL CHECK(length(reference_hash)=64),created_at INTEGER NOT NULL,PRIMARY KEY(candidate_id,reference_kind,reference_hash)
);
CREATE TABLE IF NOT EXISTS mnemora_cognition_admissions (
 id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL UNIQUE REFERENCES mnemora_cognition_candidates(id) ON DELETE CASCADE,scope TEXT NOT NULL,policy_version TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('accepted_shadow','rejected_shadow')),reason_code TEXT NOT NULL CHECK(reason_code IN ('valid_shape','assistant_inference','empty_candidate','low_confidence','related_memory_present')),related_count INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mnemora_cognition_admissions_scope_created ON mnemora_cognition_admissions(scope,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS mnemora_cognition_audits (
 id TEXT PRIMARY KEY,scope TEXT NOT NULL,candidate_id TEXT NOT NULL REFERENCES mnemora_cognition_candidates(id) ON DELETE CASCADE,admission_id TEXT NOT NULL REFERENCES mnemora_cognition_admissions(id) ON DELETE CASCADE,previous_hash TEXT,entry_hash TEXT NOT NULL CHECK(length(entry_hash)=64),created_at INTEGER NOT NULL,UNIQUE(candidate_id)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_cognition_audits_scope_created ON mnemora_cognition_audits(scope,created_at DESC,id DESC);
`;
export const cognitionEnforcementSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_cognition_enforcements (
 id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL UNIQUE REFERENCES mnemora_cognition_candidates(id) ON DELETE CASCADE,scope TEXT NOT NULL,authority TEXT NOT NULL,memory_shape TEXT NOT NULL CHECK(memory_shape IN ('preference','self_report','correction','observation','event','note','inference','unknown')),durability TEXT NOT NULL CHECK(durability IN ('transient','episodic','persistent')),outcome TEXT NOT NULL CHECK(outcome IN ('accept','reject','defer','episodic_only','requires_review')),reason_code TEXT NOT NULL,policy_version TEXT NOT NULL,created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mnemora_cognition_enforcements_scope_outcome_created ON mnemora_cognition_enforcements(scope,outcome,created_at DESC,id DESC);
`;
/**
 * Schema v53 records deterministic formation-quality decisions separately from
 * admission.  The rows contain only fingerprints and bounded counters: no
 * source text, session id, or model output is persisted here.
 */
export const cognitionPreAdmissionSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_cognition_pre_admissions (
 candidate_id TEXT PRIMARY KEY REFERENCES mnemora_cognition_candidates(id) ON DELETE CASCADE,
 scope TEXT NOT NULL REFERENCES kg_scopes(id),
 kind TEXT NOT NULL CHECK(kind IN ('graph_extraction','memory_document')),
 mode TEXT NOT NULL CHECK(mode IN ('shadow','enforce')),
 decision TEXT NOT NULL CHECK(decision IN ('accept','drop')),
 reason_code TEXT NOT NULL CHECK(reason_code IN ('new_evidence','multi_source_support','same_session_repeat','low_information')),
 content_hash TEXT,
 source_hash TEXT NOT NULL CHECK(length(source_hash)=64),
 session_hash TEXT CHECK(session_hash IS NULL OR length(session_hash)=64),
 source_count INTEGER NOT NULL CHECK(source_count>=1 AND source_count<=1000),
 session_count INTEGER NOT NULL CHECK(session_count>=0 AND session_count<=1000),
 confidence_multiplier REAL NOT NULL CHECK(confidence_multiplier>=0 AND confidence_multiplier<=1.25),
 policy_version TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mnemora_cognition_pre_admissions_scope_content
 ON mnemora_cognition_pre_admissions(scope,kind,content_hash,created_at DESC,candidate_id);
`;
export const cognitionBeliefSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_beliefs (
 id TEXT PRIMARY KEY,scope TEXT NOT NULL,type TEXT NOT NULL CHECK(type IN ('preference','correction')),subject_ref TEXT NOT NULL,predicate TEXT NOT NULL,value_json TEXT NOT NULL CHECK(length(value_json)<=1024),value_hash TEXT NOT NULL CHECK(length(value_hash)=64),state TEXT NOT NULL CHECK(state IN ('emerging','supported','strong','weakening','superseded','contradicted','invalidated','unknown')),epistemic_confidence REAL NOT NULL CHECK(epistemic_confidence>=0 AND epistemic_confidence<=1),support_count INTEGER NOT NULL DEFAULT 0 CHECK(support_count>=0),contradiction_count INTEGER NOT NULL DEFAULT 0 CHECK(contradiction_count>=0),recorded_at INTEGER NOT NULL,superseded_at INTEGER,invalidated_at INTEGER,previous_version_id TEXT REFERENCES mnemora_beliefs(id),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(scope,value_hash)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_beliefs_scope_predicate_state ON mnemora_beliefs(scope,subject_ref,predicate,state);
CREATE INDEX IF NOT EXISTS idx_mnemora_beliefs_scope_created ON mnemora_beliefs(scope,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS mnemora_belief_evidence (
 belief_id TEXT NOT NULL REFERENCES mnemora_beliefs(id) ON DELETE CASCADE,source_ref TEXT NOT NULL,relation TEXT NOT NULL CHECK(relation IN ('supports','contradicts','derived_from','correction_source')),authority TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(belief_id,source_ref,relation)
);
CREATE TABLE IF NOT EXISTS mnemora_belief_transitions (
 id TEXT PRIMARY KEY,scope TEXT NOT NULL,belief_id TEXT NOT NULL REFERENCES mnemora_beliefs(id) ON DELETE CASCADE,from_state TEXT,to_state TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('CREATE','CORROBORATE','REFINE','WEAKEN','SUPERSEDE','CONTRADICT','CORRECT','INVALIDATE','NO_CHANGE')),candidate_id TEXT REFERENCES mnemora_cognition_candidates(id),reason_codes_json TEXT NOT NULL CHECK(json_valid(reason_codes_json) AND length(reason_codes_json)<=512),change_set_id TEXT NOT NULL,created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mnemora_belief_transitions_scope_created ON mnemora_belief_transitions(scope,created_at DESC,id DESC);
`;
export const cognitionDecisionSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_decisions (
 id TEXT PRIMARY KEY,scope TEXT NOT NULL,objective TEXT NOT NULL CHECK(length(objective)<=1024),scenario TEXT CHECK(scenario IS NULL OR length(scenario)<=2048),alternatives_json TEXT CHECK(alternatives_json IS NULL OR (json_valid(alternatives_json) AND length(alternatives_json)<=4096)),chosen_action TEXT CHECK(chosen_action IS NULL OR length(chosen_action)<=2048),outcome TEXT CHECK(outcome IS NULL OR length(outcome)<=2048),rationale TEXT CHECK(rationale IS NULL OR length(rationale)<=4096),constraints_json TEXT CHECK(constraints_json IS NULL OR (json_valid(constraints_json) AND length(constraints_json)<=4096)),confidence REAL CHECK(confidence IS NULL OR (confidence>=0 AND confidence<=1)),decision_maker TEXT NOT NULL CHECK(decision_maker IN ('user','assistant','joint','tool','external')),decided_at INTEGER,valid_from INTEGER,valid_until INTEGER,recorded_at INTEGER NOT NULL,superseded_at INTEGER,invalidated_at INTEGER,previous_version_id TEXT REFERENCES mnemora_decisions(id),status TEXT NOT NULL CHECK(status IN ('active','superseded','invalidated','archived')),content_hash TEXT NOT NULL CHECK(length(content_hash)=64),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(scope,content_hash),CHECK(valid_until IS NULL OR valid_from IS NULL OR valid_until>=valid_from)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_decisions_scope_status_recorded ON mnemora_decisions(scope,status,recorded_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS mnemora_decision_evidence (
 decision_id TEXT NOT NULL REFERENCES mnemora_decisions(id) ON DELETE CASCADE,source_ref TEXT NOT NULL CHECK(length(source_ref)<=1024),relation TEXT NOT NULL CHECK(relation IN ('supports','constraint','rationale_source','outcome_source','derived_from')),created_at INTEGER NOT NULL,PRIMARY KEY(decision_id,source_ref,relation)
);
CREATE TABLE IF NOT EXISTS mnemora_decision_episodes (
 decision_id TEXT NOT NULL REFERENCES mnemora_decisions(id) ON DELETE CASCADE,episode_id TEXT NOT NULL,PRIMARY KEY(decision_id,episode_id)
);
CREATE TABLE IF NOT EXISTS mnemora_decision_transitions (
 id TEXT PRIMARY KEY,scope TEXT NOT NULL,decision_id TEXT NOT NULL REFERENCES mnemora_decisions(id) ON DELETE CASCADE,from_status TEXT,to_status TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('CREATE','SUPERSEDE','INVALIDATE','ARCHIVE')),reason_code TEXT NOT NULL,previous_version_id TEXT REFERENCES mnemora_decisions(id),created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mnemora_decision_transitions_scope_created ON mnemora_decision_transitions(scope,created_at DESC,id DESC);
`;
export const cognitionIntegritySchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_cognition_change_sets (
 id TEXT PRIMARY KEY,scope TEXT NOT NULL,origin TEXT NOT NULL,authority TEXT NOT NULL,candidate_id TEXT NOT NULL,created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mnemora_cognition_change_sets_scope_created ON mnemora_cognition_change_sets(scope,created_at DESC,id DESC);
`;
export const cognitionReflectionSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_reflection_jobs (
 id TEXT PRIMARY KEY,scope TEXT NOT NULL,input_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')),attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,finished_at INTEGER,UNIQUE(scope,input_hash)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_reflection_jobs_scope_status ON mnemora_reflection_jobs(scope,status,updated_at DESC);
CREATE TABLE IF NOT EXISTS mnemora_reflection_candidates (
 id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('pattern_candidate','staleness_review')),proposal_hash TEXT NOT NULL,source_refs TEXT NOT NULL CHECK(json_valid(source_refs) AND length(source_refs)<=4096),reason_code TEXT NOT NULL CHECK(reason_code IN ('repeated_explicit_belief','stale_belief','feedback_staleness')),score REAL NOT NULL CHECK(score>=0 AND score<=1),status TEXT NOT NULL CHECK(status IN ('proposed')),created_at INTEGER NOT NULL,UNIQUE(scope,proposal_hash)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_reflection_candidates_scope_kind ON mnemora_reflection_candidates(scope,kind,created_at DESC);
CREATE TABLE IF NOT EXISTS mnemora_recall_feedback (
 id TEXT PRIMARY KEY,scope TEXT NOT NULL,target_ref TEXT NOT NULL CHECK(length(target_ref)<=1024),kind TEXT NOT NULL CHECK(kind IN ('helpful','unused','irrelevant','wrong','outdated','user_corrected','context_mismatch')),idempotency_key TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(scope,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_recall_feedback_scope_target ON mnemora_recall_feedback(scope,target_ref,created_at DESC);
`;
/**
 * v3.7.1 keeps the immutable decision record intact and stores a derived
 * review state separately.  This is deliberately additive: older databases
 * retain their decision history while callers observe a safe `needs_review`
 * effective status until a human resolves the evidence loss.
 */
export const cognitionDecisionReviewSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_decision_evidence_reviews (
 decision_id TEXT PRIMARY KEY REFERENCES mnemora_decisions(id) ON DELETE CASCADE,
 scope TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('needs_review','resolved','invalidated')),
 reason_code TEXT NOT NULL CHECK(reason_code IN ('evidence_forgotten','evidence_unavailable')),
 source_refs_json TEXT NOT NULL CHECK(json_valid(source_refs_json) AND length(source_refs_json)<=4096),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mnemora_decision_evidence_reviews_scope_status ON mnemora_decision_evidence_reviews(scope,status,updated_at DESC);
`;
/** Immutable, operator-confirmed task outcomes. No model output is admitted here. */
export const cognitionOutcomeSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_task_outcomes (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL,
 task_ref TEXT NOT NULL CHECK(length(task_ref)<=1024),
 verdict TEXT NOT NULL CHECK(verdict IN ('success','partial','failure','unknown')),
 impact TEXT NOT NULL CHECK(impact IN ('helpful','neutral','harmful')),
 confidence REAL NOT NULL CHECK(confidence>=0 AND confidence<=1),
 summary TEXT CHECK(summary IS NULL OR length(summary)<=2048),
 evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json) AND length(evidence_refs_json)<=8192),
 supersedes_id TEXT REFERENCES mnemora_task_outcomes(id),
 status TEXT NOT NULL CHECK(status IN ('recorded','superseded')),
 outcome_hash TEXT NOT NULL CHECK(length(outcome_hash)=64),
 recorded_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(scope,outcome_hash)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_task_outcomes_scope_task ON mnemora_task_outcomes(scope,task_ref,status,recorded_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS mnemora_task_outcome_events (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL,
 outcome_id TEXT NOT NULL REFERENCES mnemora_task_outcomes(id) ON DELETE CASCADE,
 from_status TEXT,
 to_status TEXT NOT NULL CHECK(to_status IN ('recorded','superseded')),
 action TEXT NOT NULL CHECK(action IN ('RECORD','SUPERSEDE')),
 reason_code TEXT NOT NULL CHECK(reason_code IN ('operator_confirmed','explicit_correction')),
 evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json) AND length(evidence_refs_json)<=8192),
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mnemora_task_outcome_events_scope_created ON mnemora_task_outcome_events(scope,created_at DESC,id DESC);
`;
/** v4.1 separates procedural reasoning from Personal Memory and graph facts. */
export const cognitionReasoningSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_reasoning_memories (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('strategy','procedure','failure_guard','anti_pattern')),
 strategy TEXT NOT NULL CHECK(length(strategy)<=4096),
 applicability_json TEXT NOT NULL CHECK(json_valid(applicability_json) AND length(applicability_json)<=4096),
 contraindications_json TEXT NOT NULL CHECK(json_valid(contraindications_json) AND length(contraindications_json)<=4096),
 source_task_refs_json TEXT NOT NULL CHECK(json_valid(source_task_refs_json) AND length(source_task_refs_json)<=8192),
 outcome_refs_json TEXT NOT NULL CHECK(json_valid(outcome_refs_json) AND length(outcome_refs_json)<=8192),
 evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json) AND length(evidence_refs_json)<=8192),
 confidence REAL NOT NULL CHECK(confidence>=0 AND confidence<=1),
 utility_score REAL NOT NULL CHECK(utility_score>=-1 AND utility_score<=1),
 success_count INTEGER NOT NULL DEFAULT 0 CHECK(success_count>=0),
 failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count>=0),
 degraded_count INTEGER NOT NULL DEFAULT 0 CHECK(degraded_count>=0),
 state TEXT NOT NULL CHECK(state IN ('proposed','provisional','admitted','needs_review','quarantined','disabled','retired')),
 supersedes_id TEXT REFERENCES mnemora_reasoning_memories(id),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(scope,content_hash)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_reasoning_memories_scope_state ON mnemora_reasoning_memories(scope,state,updated_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS mnemora_reasoning_memory_events (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL,
 memory_id TEXT NOT NULL REFERENCES mnemora_reasoning_memories(id) ON DELETE CASCADE,
 from_state TEXT,
 to_state TEXT NOT NULL CHECK(to_state IN ('proposed','provisional','admitted','needs_review','quarantined','disabled','retired')),
 action TEXT NOT NULL CHECK(action IN ('PROPOSE','ADMIT','SUPERSEDE')),
 reason_code TEXT NOT NULL CHECK(reason_code IN ('operator_confirmed','evidence_complete','explicit_supersession')),
 evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json) AND length(evidence_refs_json)<=8192),
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mnemora_reasoning_memory_events_scope_created ON mnemora_reasoning_memory_events(scope,created_at DESC,id DESC);
`;
/** v4.2 is an additive governance audit; v4.1 records remain unchanged. */
export const cognitionReasoningGovernanceSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_reasoning_memory_outcomes (
 memory_id TEXT NOT NULL REFERENCES mnemora_reasoning_memories(id) ON DELETE CASCADE,
 scope TEXT NOT NULL,
 outcome_ref TEXT NOT NULL CHECK(length(outcome_ref)<=1024),
 linked_at INTEGER NOT NULL,
 PRIMARY KEY(memory_id,outcome_ref)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_reasoning_memory_outcomes_scope ON mnemora_reasoning_memory_outcomes(scope,memory_id,linked_at DESC);
CREATE TABLE IF NOT EXISTS mnemora_reasoning_memory_governance_events (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL,
 memory_id TEXT NOT NULL REFERENCES mnemora_reasoning_memories(id) ON DELETE CASCADE,
 related_memory_id TEXT REFERENCES mnemora_reasoning_memories(id),
 from_state TEXT,
 to_state TEXT,
 action TEXT NOT NULL CHECK(action IN ('TRANSITION','OUTCOME_LINK','UTILITY_REFRESH','ROLLBACK')),
 reason_code TEXT NOT NULL CHECK(length(reason_code)<=80),
 evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json) AND length(evidence_refs_json)<=8192),
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mnemora_reasoning_memory_governance_events_scope_created ON mnemora_reasoning_memory_governance_events(scope,created_at DESC,id DESC);
`;
/** v4.4 stores reflection proposals only; it never transitions a strategy. */
export const cognitionReasoningReflectionSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_reasoning_reflection_proposals (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL,
 memory_id TEXT NOT NULL REFERENCES mnemora_reasoning_memories(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('outcome_contrast','harmful_outcomes')),
 proposal_hash TEXT NOT NULL CHECK(length(proposal_hash)=64),
 source_refs_json TEXT NOT NULL CHECK(json_valid(source_refs_json) AND length(source_refs_json)<=8192),
 reason_code TEXT NOT NULL CHECK(reason_code IN ('contrasting_recorded_outcomes','harmful_recorded_outcomes')),
 score REAL NOT NULL CHECK(score>=0 AND score<=1),
 status TEXT NOT NULL CHECK(status IN ('proposed')),
 created_at INTEGER NOT NULL,
 UNIQUE(scope,proposal_hash)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_reasoning_reflection_proposals_scope_created ON mnemora_reasoning_reflection_proposals(scope,created_at DESC,id DESC);
`;
/** v4.8 stores aggregate-only shadow observations; no query, content, ids, or refs. */
export const cognitionReasoningRuntimeTelemetrySchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_reasoning_runtime_shadow_runs (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL,
 policy_version TEXT NOT NULL CHECK(length(policy_version)<=80),
 status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),
 triggered INTEGER NOT NULL CHECK(triggered IN (0,1)),
 high_risk INTEGER NOT NULL CHECK(high_risk IN (0,1)),
 candidate_count INTEGER NOT NULL CHECK(candidate_count>=0 AND candidate_count<=200),
 selected_count INTEGER NOT NULL CHECK(selected_count>=0 AND selected_count<=20),
 quality_excluded INTEGER NOT NULL CHECK(quality_excluded>=0 AND quality_excluded<=200),
 semantic_candidates INTEGER NOT NULL DEFAULT 0 CHECK(semantic_candidates>=0 AND semantic_candidates<=200),
 unmatched INTEGER NOT NULL DEFAULT 0 CHECK(unmatched>=0 AND unmatched<=200),
 task_type_excluded INTEGER NOT NULL DEFAULT 0 CHECK(task_type_excluded>=0 AND task_type_excluded<=200),
 empty_result INTEGER NOT NULL CHECK(empty_result IN (0,1)),
 estimated_tokens INTEGER NOT NULL CHECK(estimated_tokens>=0 AND estimated_tokens<=1600),
 duration_ms INTEGER NOT NULL CHECK(duration_ms>=0 AND duration_ms<=30000),
 error_category TEXT CHECK(error_category IS NULL OR error_category IN ('aborted','operation_failed')),
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mnemora_reasoning_runtime_shadow_scope_created ON mnemora_reasoning_runtime_shadow_runs(scope,created_at DESC,id DESC);
`;
/** v5.0 governance rows are aggregate/control records and never persist request or memory content. */
export const cognitionReasoningRuntimeGovernanceSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_reasoning_runtime_calibrations (
 id TEXT PRIMARY KEY,scope TEXT NOT NULL,policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64),policy_version TEXT NOT NULL CHECK(policy_version='reasoning-runtime-v1'),
 status TEXT NOT NULL CHECK(status IN ('ready','rejected')),total_runs INTEGER NOT NULL CHECK(total_runs>=0 AND total_runs<=5000),triggered_runs INTEGER NOT NULL CHECK(triggered_runs>=0 AND triggered_runs<=5000),selected_count INTEGER NOT NULL CHECK(selected_count>=0),
 empty_rate REAL NOT NULL CHECK(empty_rate>=0 AND empty_rate<=1),error_rate REAL NOT NULL CHECK(error_rate>=0 AND error_rate<=1),p95_ms INTEGER NOT NULL CHECK(p95_ms>=0 AND p95_ms<=30000),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL CHECK(expires_at>created_at)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_reasoning_runtime_calibrations_scope_created ON mnemora_reasoning_runtime_calibrations(scope,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS mnemora_reasoning_runtime_canaries (
 scope TEXT PRIMARY KEY,calibration_id TEXT NOT NULL REFERENCES mnemora_reasoning_runtime_calibrations(id) ON DELETE RESTRICT,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),circuit_open INTEGER NOT NULL CHECK(circuit_open IN (0,1)),
 reason_code TEXT NOT NULL CHECK(reason_code IN ('activated','operator_rollback','calibration_missing','calibration_expired','policy_changed','readiness_regression','harmful_feedback')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mnemora_reasoning_runtime_canary_events (
 id TEXT PRIMARY KEY,scope TEXT NOT NULL,calibration_id TEXT REFERENCES mnemora_reasoning_runtime_calibrations(id) ON DELETE RESTRICT,action TEXT NOT NULL CHECK(action IN ('ACTIVATE','ROLLBACK','CIRCUIT_OPEN')),
 reason_code TEXT NOT NULL CHECK(reason_code IN ('operator_confirmed','operator_rollback','calibration_missing','calibration_expired','policy_changed','readiness_regression','harmful_feedback')),created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mnemora_reasoning_runtime_canary_events_scope_created ON mnemora_reasoning_runtime_canary_events(scope,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS mnemora_reasoning_runtime_delivery_runs (
 id TEXT PRIMARY KEY,scope TEXT NOT NULL,calibration_id TEXT NOT NULL REFERENCES mnemora_reasoning_runtime_calibrations(id) ON DELETE RESTRICT,status TEXT NOT NULL CHECK(status IN ('delivered','withheld','failed')),
 selected_count INTEGER NOT NULL CHECK(selected_count>=0 AND selected_count<=20),estimated_tokens INTEGER NOT NULL CHECK(estimated_tokens>=0 AND estimated_tokens<=1600),duration_ms INTEGER NOT NULL CHECK(duration_ms>=0 AND duration_ms<=30000),
 reason_code TEXT NOT NULL CHECK(reason_code IN ('delivered','no_trigger','empty','budget','cadence','operation_failed')),feedback TEXT NOT NULL CHECK(feedback IN ('unknown','helpful','neutral','harmful')),created_at INTEGER NOT NULL,feedback_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mnemora_reasoning_runtime_delivery_scope_created ON mnemora_reasoning_runtime_delivery_runs(scope,created_at DESC,id DESC);
`;

/** Schema v62 records short-lived delivery-to-strategy links separately from
 * aggregate canary telemetry. It stores no query, host session, or strategy
 * text, and an open memory circuit only suppresses future delivery. */
export const cognitionReasoningDeliveryFeedbackSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_reasoning_runtime_delivery_items (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL,
 delivery_run_id TEXT NOT NULL REFERENCES mnemora_reasoning_runtime_delivery_runs(id) ON DELETE CASCADE,
 memory_id TEXT NOT NULL REFERENCES mnemora_reasoning_memories(id) ON DELETE RESTRICT,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<20),
 status TEXT NOT NULL CHECK(status IN ('delivered','helpful','neutral','harmful')) DEFAULT 'delivered',
 adopted INTEGER NOT NULL CHECK(adopted IN (0,1)) DEFAULT 0,
 expires_at INTEGER NOT NULL,
 feedback_at INTEGER,
 created_at INTEGER NOT NULL,
 UNIQUE(delivery_run_id,memory_id)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_reasoning_delivery_items_scope_memory ON mnemora_reasoning_runtime_delivery_items(scope,memory_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_mnemora_reasoning_delivery_items_scope_expiry ON mnemora_reasoning_runtime_delivery_items(scope,expires_at ASC);
CREATE TABLE IF NOT EXISTS mnemora_reasoning_memory_delivery_circuits (
 scope TEXT NOT NULL,
 memory_id TEXT NOT NULL REFERENCES mnemora_reasoning_memories(id) ON DELETE CASCADE,
 circuit_open INTEGER NOT NULL CHECK(circuit_open IN (0,1)),
 reason_code TEXT NOT NULL CHECK(reason_code IN ('harmful_delivery_feedback','harmful_task_outcome','operator_reset')),
 opened_at INTEGER,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(scope,memory_id)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_reasoning_memory_circuits_scope_open ON mnemora_reasoning_memory_delivery_circuits(scope,circuit_open,updated_at DESC);
CREATE TABLE IF NOT EXISTS mnemora_reasoning_runtime_delivery_feedback_events (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL,
 delivery_item_id TEXT NOT NULL REFERENCES mnemora_reasoning_runtime_delivery_items(id) ON DELETE CASCADE,
 memory_id TEXT NOT NULL REFERENCES mnemora_reasoning_memories(id) ON DELETE RESTRICT,
 signal_kind TEXT NOT NULL CHECK(signal_kind IN ('operator_feedback','task_outcome')),
 effect TEXT NOT NULL CHECK(effect IN ('helpful','neutral','harmful','adopted')),
 source_ref TEXT NOT NULL DEFAULT '' CHECK(length(source_ref)<=1024),
 created_at INTEGER NOT NULL,
 UNIQUE(delivery_item_id,signal_kind,source_ref,effect)
);
CREATE INDEX IF NOT EXISTS idx_mnemora_reasoning_delivery_feedback_scope_memory ON mnemora_reasoning_runtime_delivery_feedback_events(scope,memory_id,created_at DESC,id DESC);
`;
/** Schema v63 keeps a scope-bound, local index for admitted procedural memories.
 * It contains only embedding bytes and deterministic identity metadata; source
 * evidence and strategy text remain in their original governed tables. */
export const cognitionReasoningSemanticSchemaSql = `
CREATE TABLE IF NOT EXISTS mnemora_reasoning_memory_embeddings (
 memory_id TEXT PRIMARY KEY REFERENCES mnemora_reasoning_memories(id) ON DELETE CASCADE,
 scope TEXT NOT NULL,
 embedding BLOB NOT NULL,
 provider TEXT NOT NULL CHECK(length(provider)<=64),
 model TEXT NOT NULL CHECK(length(model)<=120),
 dimensions INTEGER NOT NULL CHECK(dimensions>0 AND dimensions<=32768),
 input_version TEXT NOT NULL CHECK(length(input_version)<=80),
 input_hash TEXT NOT NULL CHECK(length(input_hash)=64),
 embedded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mnemora_reasoning_embeddings_scope_identity ON mnemora_reasoning_memory_embeddings(scope,provider,model,input_version,dimensions,memory_id);
`;
export const cognitionOptionalRestoreTables=["mnemora_cognition_candidates","mnemora_cognition_evidence_links","mnemora_cognition_admissions","mnemora_cognition_audits","mnemora_cognition_enforcements","mnemora_cognition_pre_admissions","mnemora_cognition_change_sets","mnemora_beliefs","mnemora_belief_evidence","mnemora_belief_transitions","mnemora_decisions","mnemora_decision_evidence","mnemora_decision_episodes","mnemora_decision_transitions","mnemora_decision_evidence_reviews","mnemora_task_outcomes","mnemora_task_outcome_events","mnemora_reasoning_memories","mnemora_reasoning_memory_events","mnemora_reasoning_memory_outcomes","mnemora_reasoning_memory_governance_events","mnemora_reasoning_reflection_proposals","mnemora_reasoning_runtime_shadow_runs","mnemora_reasoning_runtime_calibrations","mnemora_reasoning_runtime_canaries","mnemora_reasoning_runtime_canary_events","mnemora_reasoning_runtime_delivery_runs","mnemora_reasoning_runtime_delivery_items","mnemora_reasoning_memory_delivery_circuits","mnemora_reasoning_runtime_delivery_feedback_events","mnemora_reasoning_memory_embeddings","mnemora_reflection_jobs","mnemora_reflection_candidates","mnemora_recall_feedback"] as const;
