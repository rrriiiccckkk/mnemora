import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMnemoraContextRef } from "../dist/context/context-ref.js";
import { ReasoningDeliveryFeedbackRepository } from "../dist/cognition/reasoning-delivery-feedback.js";
import { ReasoningMemoryService } from "../dist/cognition/reasoning.js";
import { ReasoningVerificationService } from "../dist/cognition/reasoning-verification.js";
import { ReasoningGovernedDeliveryService, ReasoningRuntimeGovernanceRepository } from "../dist/cognition/reasoning-runtime-governance.js";
import { ReasoningRuntimeShadowService } from "../dist/cognition/reasoning-runtime-telemetry.js";
import { TaskOutcomeService } from "../dist/cognition/outcomes.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";
import { EpisodeRepository } from "../dist/episodes/repository.js";
import { GraphologyStore } from "../dist/store.js";
import { SUPPORTED_SCHEMA_VERSION } from "../dist/schema.js";

const policy = { maxInlineChars: 16_000, maxEventBytes: 262_144, sensitiveContentPolicy: "redact" };

function setup(store, now, scope = "project:verification") {
  const event = new ConversationEventRepository(store.db, policy).append({ scope, sessionId: "verification", kind: "user_message", role: "user", parts: [{ type: "text", text: "The production migration needs a rollback procedure." }] });
  const task = new EpisodeRepository(store.db).create({ scope, kind: "task", summary: "Ship a production migration", sourceEventIds: [event.id], importance: .9, confidence: .9 });
  const eventRef = createMnemoraContextRef({ scope, kind: "conversation-event", id: event.id }), taskRef = createMnemoraContextRef({ scope, kind: "episode", id: task.id });
  const outcomes = new TaskOutcomeService(store.db, now), baseline = { scope, taskRef, verdict: "partial", impact: "neutral", confidence: .8, summary: "Rollback validation is required.", evidenceRefs: [eventRef] }, outcome = outcomes.confirm(baseline, outcomes.preview(baseline).preview_hash), outcomeRef = createMnemoraContextRef({ scope, kind: "task-outcome", id: outcome.id });
  const memories = new ReasoningMemoryService(store.db, now), input = {
    scope, kind: "failure_guard", strategy: "Verify rollback steps before every production database migration.",
    applicability: { taskTypes: ["database_migration"], riskLevels: ["high"] }, sourceTaskRefs: [taskRef], outcomeRefs: [outcomeRef], evidenceRefs: [eventRef], confidence: .9,
    verification: { version: "reasoning-verification-v1", assertions: [{ kind: "tool_result", tool: "migration-runner", expected: "success" }, { kind: "task_outcome", expected: "success" }, { kind: "strategy_adoption", expected: true }] }
  };
  const proposal = memories.propose(input, memories.preview(input).preview_hash), memory = memories.admit(proposal.id, scope, memories.admissionPreview(proposal.id, scope).preview_hash);
  const config = { tokenBudget: 800, maxItems: 6, minConfidence: .6, highRiskMinConfidence: .8, minEvidenceQuality: .5, highRiskMinEvidenceQuality: .75, maxStalenessDays: 365, excludeConflicted: true, retentionDays: 30, readiness: { minimumRuns: 1, maxErrorRate: 0, maxEmptyRate: 1, maxP95Ms: 1000 }, delivery: { enabled: true, scopes: [scope], adapter: "openclaw", calibrationMaxAgeHours: 1, maxConsecutiveDeliveries: 2, itemRetentionDays: 30 } };
  const shadow = new ReasoningRuntimeShadowService(store.db, config, now), governance = new ReasoningRuntimeGovernanceRepository(store.db, now);
  shadow.capture({ scope, query: "Deploy a production database migration with rollback.", taskType: "database_migration", riskLevel: "high" });
  const calibration = governance.confirmCalibration(scope, config, governance.previewCalibration(scope, config).preview_hash).calibration, enable = governance.enablePreview(scope, calibration.id, config); assert.equal(enable.status, "preview"); assert.equal(governance.enable(scope, calibration.id, config, enable.preview_hash).status, "confirmed");
  const delivery = new ReasoningGovernedDeliveryService(store.db, config, now).handle({ scope, query: "Deploy a production database migration with rollback.", taskType: "database_migration", riskLevel: "high" }); assert.ok(delivery); assert.equal(delivery.deliveryItemRefs.length, 1);
  return { scope, eventRef, taskRef, memory, outcomes, itemRef: delivery.deliveryItemRefs[0] };
}

test("task outcomes enqueue deterministic verification, and only a bounded processor can open a mismatch circuit", () => {
  let clock = 10_000; const now = () => clock, store = new GraphologyStore(":memory:");
  try {
    const state = setup(store, now), verification = new ReasoningVerificationService(store.db, now), feedback = new ReasoningDeliveryFeedbackRepository(store.db, now);
    const input = { scope: state.scope, taskRef: state.taskRef, verdict: "failure", impact: "neutral", confidence: .9, summary: "The cited delivery did not produce the expected result.", evidenceRefs: [state.eventRef, state.itemRef] };
    const outcome = state.outcomes.confirm(input, state.outcomes.preview(input).preview_hash);
    assert.deepEqual({ pending: verification.summary(state.scope).pending, open: feedback.circuit(state.scope, state.memory.id) }, { pending: 2, open: undefined });
    clock += 100;
    assert.deepEqual(verification.run({ scope: state.scope, limit: 10 }), { processed: 2, expired: 0, matched: 1, mismatched: 1, circuitsOpened: 1 });
    const events = verification.events(state.scope);
    assert.deepEqual(events.map(event => ({ kind: event.assertionKind, expected: event.expected, observed: event.observed, verdict: event.verdict, source: event.sourceRef })), [
      { kind: "task_outcome", expected: "success", observed: "failure", verdict: "mismatched", source: createMnemoraContextRef({ scope: state.scope, kind: "task-outcome", id: outcome.id }) },
      { kind: "strategy_adoption", expected: "true", observed: "true", verdict: "matched", source: createMnemoraContextRef({ scope: state.scope, kind: "task-outcome", id: outcome.id }) }
    ]);
    assert.deepEqual({ reason: feedback.circuit(state.scope, state.memory.id)?.reason, open: feedback.circuit(state.scope, state.memory.id)?.open, rerun: verification.run({ scope: state.scope, limit: 10 }) }, { reason: "verification_mismatch", open: true, rerun: { processed: 0, expired: 0, matched: 0, mismatched: 0, circuitsOpened: 0 } });
  } finally { store.close(); }
});

test("tool verification accepts only the contracted identifier, has no raw output channel, and is idempotent", () => {
  let clock = 20_000; const now = () => clock, store = new GraphologyStore(":memory:");
  try {
    const state = setup(store, now), verification = new ReasoningVerificationService(store.db, now), feedback = new ReasoningDeliveryFeedbackRepository(store.db, now);
    assert.deepEqual(verification.recordToolResult({ scope: state.scope, itemRef: state.itemRef, tool: "other-tool", result: "failure", sourceRef: "tool-run:other" }), { queued: 0 });
    const signal = { scope: state.scope, itemRef: state.itemRef, tool: "migration-runner", result: "failure", sourceRef: "tool-run:42" };
    assert.deepEqual(verification.recordToolResult(signal), { queued: 1 });
    assert.deepEqual(verification.recordToolResult(signal), { queued: 0 });
    assert.deepEqual(verification.run({ scope: state.scope, limit: 1 }), { processed: 1, expired: 0, matched: 0, mismatched: 1, circuitsOpened: 1 });
    assert.deepEqual({ open: feedback.circuit(state.scope, state.memory.id)?.open, source: verification.events(state.scope)[0].sourceRef, rawOutputColumns: store.db.prepare("PRAGMA table_info(mnemora_reasoning_runtime_verification_events)").all().map(row => row.name).filter(name => /output|prompt|content/i.test(name)) }, { open: true, source: "tool-run:42", rawOutputColumns: [] });
  } finally { store.close(); }
});

test("schema v67 preserves every v65 circuit field while widening its reason contract and adding the local ledger", () => {
  const path = join(tmpdir(), `mnemora-reasoning-verification-${process.pid}-${Date.now()}.db`); let legacy;
  try {
    legacy = new GraphologyStore(path); const state = setup(legacy, () => 30_000), feedback = new ReasoningDeliveryFeedbackRepository(legacy.db, () => 30_000);
    feedback.openVerificationCircuit(state.scope, state.memory.id);
    legacy.db.exec(`DROP INDEX IF EXISTS idx_mnemora_reasoning_memory_circuits_scope_open;
      ALTER TABLE mnemora_reasoning_memory_delivery_circuits RENAME TO mnemora_reasoning_memory_delivery_circuits_current;
      CREATE TABLE mnemora_reasoning_memory_delivery_circuits (
        scope TEXT NOT NULL,memory_id TEXT NOT NULL REFERENCES mnemora_reasoning_memories(id) ON DELETE CASCADE,
        circuit_open INTEGER NOT NULL CHECK(circuit_open IN (0,1)),
        reason_code TEXT NOT NULL CHECK(reason_code IN ('harmful_delivery_feedback','harmful_task_outcome','operator_reset')),
        opened_at INTEGER,updated_at INTEGER NOT NULL,PRIMARY KEY(scope,memory_id)
      );
      INSERT INTO mnemora_reasoning_memory_delivery_circuits(scope,memory_id,circuit_open,reason_code,opened_at,updated_at)
      SELECT scope,memory_id,circuit_open,'harmful_task_outcome',opened_at,updated_at FROM mnemora_reasoning_memory_delivery_circuits_current;
      DROP TABLE mnemora_reasoning_memory_delivery_circuits_current;
      CREATE INDEX idx_mnemora_reasoning_memory_circuits_scope_open ON mnemora_reasoning_memory_delivery_circuits(scope,circuit_open,updated_at DESC);
      PRAGMA user_version=65`);
    legacy.close(); legacy = undefined;
    const migrated = new GraphologyStore(path);
    try {
      const circuit = new ReasoningDeliveryFeedbackRepository(migrated.db, () => 30_001).circuit(state.scope, state.memory.id), table = migrated.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mnemora_reasoning_memory_delivery_circuits'").get(), index = migrated.db.prepare("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name='idx_mnemora_reasoning_memory_circuits_scope_open'").get();
      assert.equal(SUPPORTED_SCHEMA_VERSION, 74);
      assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
      assert.deepEqual(circuit, { scope: state.scope, memoryId: state.memory.id, open: true, reason: "harmful_task_outcome", openedAt: 30_000, updatedAt: 30_000 });
      assert.match(String(table.sql), /verification_mismatch/);
      assert.equal(index.tbl_name, "mnemora_reasoning_memory_delivery_circuits");
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='mnemora_reasoning_runtime_verification_events'").get().value, 1);
    } finally { migrated.close(); }
  } finally { try { legacy?.close(); } catch {} try { rmSync(path, { force: true }); } catch {} }
});

test("expired delivery receipts cannot enqueue or process verification mismatches", () => {
  let clock = 40_000; const now = () => clock, store = new GraphologyStore(":memory:");
  try {
    const state = setup(store, now), verification = new ReasoningVerificationService(store.db, now), feedback = new ReasoningDeliveryFeedbackRepository(store.db, now);
    assert.deepEqual(verification.recordToolResult({ scope: state.scope, itemRef: state.itemRef, tool: "migration-runner", result: "failure", sourceRef: "tool-run:before-expiry" }), { queued: 1 });
    clock += 31 * 86_400_000;
    assert.deepEqual(verification.recordToolResult({ scope: state.scope, itemRef: state.itemRef, tool: "migration-runner", result: "failure", sourceRef: "tool-run:after-expiry" }), { queued: 0 });
    assert.deepEqual(verification.run({ scope: state.scope, limit: 10 }), { processed: 0, expired: 1, matched: 0, mismatched: 0, circuitsOpened: 0 });
    assert.deepEqual(verification.summary(state.scope), { version: "reasoning-verification-summary-v2", scope: state.scope, pending: 0, processed: 0, expired: 1, matched: 0, mismatched: 0 });
    assert.deepEqual({ status: verification.events(state.scope)[0]?.status, circuit: feedback.circuit(state.scope, state.memory.id) }, { status: "expired", circuit: undefined });
  } finally { store.close(); }
});

test("schema v67 preserves v66 verification events while adding the terminal expired state", () => {
  const path = join(tmpdir(), `mnemora-reasoning-verification-expiry-${process.pid}-${Date.now()}.db`); let legacy;
  try {
    legacy = new GraphologyStore(path); const state = setup(legacy, () => 50_000), verification = new ReasoningVerificationService(legacy.db, () => 50_000);
    assert.deepEqual(verification.recordToolResult({ scope: state.scope, itemRef: state.itemRef, tool: "migration-runner", result: "success", sourceRef: "tool-run:legacy" }), { queued: 1 });
    legacy.db.exec(`DROP INDEX IF EXISTS idx_mnemora_reasoning_verification_scope_status;
      DROP INDEX IF EXISTS idx_mnemora_reasoning_verification_scope_memory;
      ALTER TABLE mnemora_reasoning_runtime_verification_events RENAME TO mnemora_reasoning_runtime_verification_events_current;
      CREATE TABLE mnemora_reasoning_runtime_verification_events (
        id TEXT PRIMARY KEY,scope TEXT NOT NULL,
        delivery_item_id TEXT NOT NULL REFERENCES mnemora_reasoning_runtime_delivery_items(id) ON DELETE CASCADE,
        memory_id TEXT NOT NULL REFERENCES mnemora_reasoning_memories(id) ON DELETE RESTRICT,
        assertion_kind TEXT NOT NULL CHECK(assertion_kind IN ('tool_result','task_outcome','strategy_adoption')),
        assertion_ordinal INTEGER NOT NULL CHECK(assertion_ordinal>=0 AND assertion_ordinal<16),
        assertion_key TEXT NOT NULL CHECK(length(assertion_key)<=160),
        expected_value TEXT NOT NULL CHECK(expected_value IN ('success','failure','partial','true')),
        observed_value TEXT NOT NULL CHECK(observed_value IN ('success','failure','partial','true')),
        verdict TEXT NOT NULL CHECK(verdict IN ('matched','mismatched')),
        source_kind TEXT NOT NULL CHECK(source_kind IN ('tool_result','task_outcome','strategy_adoption')),
        source_ref TEXT NOT NULL CHECK(length(source_ref)>0 AND length(source_ref)<=1024),
        status TEXT NOT NULL CHECK(status IN ('pending','processed')),
        created_at INTEGER NOT NULL,processed_at INTEGER,
        UNIQUE(delivery_item_id,assertion_key,source_kind,source_ref)
      );
      INSERT INTO mnemora_reasoning_runtime_verification_events(id,scope,delivery_item_id,memory_id,assertion_kind,assertion_ordinal,assertion_key,expected_value,observed_value,verdict,source_kind,source_ref,status,created_at,processed_at)
      SELECT id,scope,delivery_item_id,memory_id,assertion_kind,assertion_ordinal,assertion_key,expected_value,observed_value,verdict,source_kind,source_ref,status,created_at,processed_at FROM mnemora_reasoning_runtime_verification_events_current;
      DROP TABLE mnemora_reasoning_runtime_verification_events_current;
      CREATE INDEX idx_mnemora_reasoning_verification_scope_status ON mnemora_reasoning_runtime_verification_events(scope,status,created_at ASC,id ASC);
      CREATE INDEX idx_mnemora_reasoning_verification_scope_memory ON mnemora_reasoning_runtime_verification_events(scope,memory_id,created_at DESC,id DESC);
      PRAGMA user_version=66`);
    legacy.close(); legacy = undefined;
    const migrated = new GraphologyStore(path);
    try {
      const event = new ReasoningVerificationService(migrated.db, () => 50_001).events(state.scope)[0], table = migrated.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mnemora_reasoning_runtime_verification_events'").get();
      assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
      assert.equal(event.status, "pending");
      assert.match(String(table.sql), /'expired'/);
      assert.equal(migrated.db.prepare("PRAGMA foreign_key_check").all().length, 0);
    } finally { migrated.close(); }
  } finally { try { legacy?.close(); } catch {} try { rmSync(path, { force: true }); } catch {} }
});
