import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMnemoraContextRef } from "../dist/context/context-ref.js";
import { ReasoningDeliveryFeedbackRepository } from "../dist/cognition/reasoning-delivery-feedback.js";
import { ReasoningMemoryService } from "../dist/cognition/reasoning.js";
import { ReasoningRetrievalService } from "../dist/cognition/reasoning-retrieval.js";
import { ReasoningGovernedDeliveryService, ReasoningRuntimeGovernanceRepository } from "../dist/cognition/reasoning-runtime-governance.js";
import { ReasoningRuntimeShadowService } from "../dist/cognition/reasoning-runtime-telemetry.js";
import { TaskOutcomeService } from "../dist/cognition/outcomes.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";
import { EpisodeRepository } from "../dist/episodes/repository.js";
import { GraphologyStore } from "../dist/store.js";
import { SUPPORTED_SCHEMA_VERSION } from "../dist/schema.js";

const policy = { maxInlineChars: 16_000, maxEventBytes: 262_144, sensitiveContentPolicy: "redact" };

function setup(store, now, scope = "project:ops") {
  const event = new ConversationEventRepository(store.db, policy).append({ scope, sessionId: "s", kind: "user_message", role: "user", parts: [{ type: "text", text: "The production migration needs a verified rollback." }] });
  const task = new EpisodeRepository(store.db).create({ scope, kind: "task", summary: "Ship a production migration", sourceEventIds: [event.id], importance: .9, confidence: .9 });
  const eventRef = createMnemoraContextRef({ scope, kind: "conversation-event", id: event.id });
  const taskRef = createMnemoraContextRef({ scope, kind: "episode", id: task.id });
  const outcomes = new TaskOutcomeService(store.db, now), baseline = { scope, taskRef, verdict: "partial", impact: "neutral", confidence: .8, summary: "Rollback validation was required.", evidenceRefs: [eventRef] };
  const baselineOutcome = outcomes.confirm(baseline, outcomes.preview(baseline).preview_hash);
  const outcomeRef = createMnemoraContextRef({ scope, kind: "task-outcome", id: baselineOutcome.id });
  const memories = new ReasoningMemoryService(store.db, now), input = { scope, kind: "failure_guard", strategy: "Verify rollback steps before every production database migration.", applicability: { taskTypes: ["database_migration"], riskLevels: ["high"] }, sourceTaskRefs: [taskRef], outcomeRefs: [outcomeRef], evidenceRefs: [eventRef], confidence: .9 };
  const proposed = memories.propose(input, memories.preview(input).preview_hash);
  const memory = memories.admit(proposed.id, scope, memories.admissionPreview(proposed.id, scope).preview_hash);
  return { scope, eventRef, taskRef, memories, memory, outcomes };
}

function config(scope) {
  return { tokenBudget: 800, maxItems: 6, minConfidence: .6, highRiskMinConfidence: .8, minEvidenceQuality: .5, highRiskMinEvidenceQuality: .75, maxStalenessDays: 365, excludeConflicted: true, retentionDays: 30, readiness: { minimumRuns: 1, maxErrorRate: 0, maxEmptyRate: 1, maxP95Ms: 1000 }, delivery: { enabled: true, scopes: [scope], adapter: "openclaw", calibrationMaxAgeHours: 1, maxConsecutiveDeliveries: 2, itemRetentionDays: 30 } };
}

function deliver(store, state, now) {
  const value = config(state.scope), shadow = new ReasoningRuntimeShadowService(store.db, value, now), governance = new ReasoningRuntimeGovernanceRepository(store.db, now);
  shadow.capture({ scope: state.scope, query: "Deploy a production database migration with rollback.", taskType: "database_migration", riskLevel: "high" });
  const calibrationPreview = governance.previewCalibration(state.scope, value), calibration = governance.confirmCalibration(state.scope, value, calibrationPreview.preview_hash).calibration;
  const enable = governance.enablePreview(state.scope, calibration.id, value); assert.equal(enable.status, "preview");
  assert.equal(governance.enable(state.scope, calibration.id, value, enable.preview_hash).status, "confirmed");
  const result = new ReasoningGovernedDeliveryService(store.db, value, now).handle({ scope: state.scope, query: "Deploy a production database migration with rollback.", taskType: "database_migration", riskLevel: "high" });
  assert.ok(result); assert.equal(result.deliveryItemRefs.length, 1); assert.match(result.appendSystemContext, /delivery_item=mnemora:\/\/v1\/scope\//);
  return { value, governance, result };
}

test("an explicitly cited task outcome automatically contains a delivered strategy and opens only its memory circuit", () => {
  let clock = 10_000; const now = () => clock, store = new GraphologyStore(":memory:");
  try {
    const state = setup(store, now), { value, governance, result } = deliver(store, state, now), feedback = new ReasoningDeliveryFeedbackRepository(store.db, now), item = feedback.getByRef(result.deliveryItemRefs[0], state.scope);
    assert.ok(item); assert.equal(item.status, "delivered"); assert.equal(item.adopted, false);
    const input = { scope: state.scope, taskRef: state.taskRef, verdict: "failure", impact: "harmful", confidence: .9, summary: "The delivered rollback procedure made the migration outcome worse.", evidenceRefs: [state.eventRef, item.ref] };
    state.outcomes.confirm(input, state.outcomes.preview(input).preview_hash);
    const observed = feedback.get(item.id, state.scope), summary = feedback.summary(state.scope);
    assert.deepEqual({ status: observed.status, adopted: observed.adopted, open: feedback.circuit(state.scope, state.memory.id)?.open, canary: governance.status(state.scope, value).active }, { status: "harmful", adopted: true, open: true, canary: true });
    assert.deepEqual({ delivered: summary.deliveredItems, adopted: summary.adoptedItems, harmful: summary.harmfulItems, open: summary.openMemoryCircuits }, { delivered: 1, adopted: 1, harmful: 1, open: 1 });
    const retrieved = new ReasoningRetrievalService(store.db).find({ scope: state.scope, query: "production database migration rollback", taskType: "database_migration", riskLevel: "high" });
    assert.deepEqual({ candidates: retrieved.candidates.length, circuitExcluded: retrieved.excluded.delivery_circuit, state: state.memories.get(state.memory.id, state.scope).state }, { candidates: 0, circuitExcluded: 1, state: "admitted" });
    const reset = feedback.resetPreview(state.memory.id, state.scope); assert.equal(reset.status, "preview"); assert.equal(feedback.reset(state.memory.id, state.scope, reset.preview_hash).status, "confirmed");
    assert.equal(new ReasoningRetrievalService(store.db).find({ scope: state.scope, query: "production database migration rollback", taskType: "database_migration", riskLevel: "high" }).candidates[0].id, state.memory.id);
  } finally { store.close(); }
});

test("operator item feedback can halt one strategy without tripping the scope canary", () => {
  const now = () => 20_000, store = new GraphologyStore(":memory:");
  try {
    const state = setup(store, now), { value, governance, result } = deliver(store, state, now), feedback = new ReasoningDeliveryFeedbackRepository(store.db, now), preview = feedback.feedbackPreview(result.deliveryItemRefs[0], state.scope, "harmful");
    assert.equal(preview.status, "preview"); assert.equal(feedback.feedback(result.deliveryItemRefs[0], state.scope, "harmful", preview.preview_hash).status, "confirmed");
    assert.deepEqual({ canary: governance.status(state.scope, value).active, runFeedback: governance.deliveries(state.scope)[0].feedback, circuit: feedback.circuit(state.scope, state.memory.id)?.open }, { canary: true, runFeedback: "unknown", circuit: true });
  } finally { store.close(); }
});

test("schema v62 migration is additive and preserves prior reasoning memories", () => {
  const path = join(tmpdir(), `mnemora-reasoning-delivery-${process.pid}-${Date.now()}.db`); let legacy;
  try {
    legacy = new GraphologyStore(path); const state = setup(legacy, () => 30_000), memoryId = state.memory.id;
    legacy.db.exec("DROP TABLE mnemora_reasoning_runtime_delivery_feedback_events; DROP TABLE mnemora_reasoning_memory_delivery_circuits; DROP TABLE mnemora_reasoning_runtime_delivery_items; PRAGMA user_version=61"); legacy.close(); legacy = undefined;
    const migrated = new GraphologyStore(path);
    try {
      assert.equal(SUPPORTED_SCHEMA_VERSION, 62);
      assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 62);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS value FROM mnemora_reasoning_memories WHERE id=?").get(memoryId).value, 1);
      for (const table of ["mnemora_reasoning_runtime_delivery_items", "mnemora_reasoning_memory_delivery_circuits", "mnemora_reasoning_runtime_delivery_feedback_events"]) assert.equal(migrated.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name=?").get(table).value, 1);
    } finally { migrated.close(); }
  } finally { try { legacy?.close(); } catch {} try { rmSync(path, { force: true }); } catch {} }
});
