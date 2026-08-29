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
    const reset = feedback.resetPreview(state.memory.id, state.scope); assert.equal(reset.status, "preview"); assert.equal(reset.correctableItems, 1); assert.equal(feedback.reset(state.memory.id, state.scope, reset.preview_hash).status, "confirmed");
    assert.deepEqual({ historic: feedback.get(item.id, state.scope)?.status, effective: feedback.get(item.id, state.scope)?.effectiveStatus, corrections: store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_reasoning_runtime_delivery_item_corrections").get().value }, { historic: "harmful", effective: "delivered", corrections: 1 });
    const helpful = feedback.feedbackPreview(item.ref, state.scope, "helpful"); assert.equal(helpful.status, "preview"); assert.equal(feedback.feedback(item.ref, state.scope, "helpful", helpful.preview_hash).status, "confirmed");
    assert.deepEqual({ historic: feedback.get(item.id, state.scope)?.status, effective: feedback.get(item.id, state.scope)?.effectiveStatus, corrections: store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_reasoning_runtime_delivery_item_corrections").get().value }, { historic: "harmful", effective: "helpful", corrections: 1 });
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

test("a later non-harmful signal never silently re-enables a circuit-broken strategy", () => {
  let clock = 25_000; const now = () => clock, store = new GraphologyStore(":memory:");
  try {
    const state = setup(store, now), { result } = deliver(store, state, now), feedback = new ReasoningDeliveryFeedbackRepository(store.db, now), item = feedback.getByRef(result.deliveryItemRefs[0], state.scope);
    assert.ok(item);
    const harmful = feedback.feedbackPreview(item.ref, state.scope, "harmful"); assert.equal(harmful.status, "preview"); assert.equal(feedback.feedback(item.ref, state.scope, "harmful", harmful.preview_hash).status, "confirmed");
    const openedAt = feedback.circuit(state.scope, state.memory.id)?.openedAt;
    clock += 100;
    const outcome = { scope: state.scope, taskRef: state.taskRef, verdict: "failure", impact: "harmful", confidence: .9, summary: "A second, independently cited harmful outcome confirms the delivery problem.", evidenceRefs: [state.eventRef, item.ref] };
    state.outcomes.confirm(outcome, state.outcomes.preview(outcome).preview_hash);
    const afterRepeat = feedback.circuit(state.scope, state.memory.id); assert.equal(afterRepeat?.openedAt, openedAt); assert.equal(afterRepeat?.updatedAt, clock);
    clock += 100;
    const helpful = feedback.feedbackPreview(item.ref, state.scope, "helpful"); assert.equal(helpful.status, "preview"); assert.equal(feedback.feedback(item.ref, state.scope, "helpful", helpful.preview_hash).status, "confirmed");
    const latest = feedback.get(item.id, state.scope), summary = feedback.summary(state.scope), retrieved = new ReasoningRetrievalService(store.db).find({ scope: state.scope, query: "production database migration rollback", taskType: "database_migration", riskLevel: "high" });
    assert.deepEqual({ effective: latest?.effectiveStatus, requiresReset: latest?.requiresOperatorReset, harmful: summary.harmfulItems, open: summary.openMemoryCircuits, candidates: retrieved.candidates.length, circuitExcluded: retrieved.excluded.delivery_circuit }, { effective: "helpful", requiresReset: true, harmful: 0, open: 1, candidates: 0, circuitExcluded: 1 });
  } finally { store.close(); }
});

test("expired delivery receipts remain audit-visible but cannot distort current feedback metrics or accept outcomes", () => {
  let clock = 40_000; const now = () => clock, store = new GraphologyStore(":memory:");
  try {
    const state = setup(store, now), { result } = deliver(store, state, now), feedback = new ReasoningDeliveryFeedbackRepository(store.db, now), item = feedback.getByRef(result.deliveryItemRefs[0], state.scope);
    assert.ok(item); clock += 31 * 86_400_000;
    assert.deepEqual(feedback.summary(state.scope), { version: "reasoning-delivery-feedback-v1", scope: state.scope, deliveredItems: 1, feedbackEligibleItems: 0, expiredItems: 1, adoptedItems: 0, helpfulItems: 0, neutralItems: 0, harmfulItems: 0, openMemoryCircuits: 0, feedbackCoverage: 0, adoptionRate: 0, helpfulRate: 0, harmfulRate: 0 });
    const input = { scope: state.scope, taskRef: state.taskRef, verdict: "failure", impact: "harmful", confidence: .9, summary: "This expired receipt must not reopen a strategy circuit.", evidenceRefs: [state.eventRef, item.ref] };
    state.outcomes.confirm(input, state.outcomes.preview(input).preview_hash);
    assert.deepEqual({ status: feedback.get(item.id, state.scope)?.status, circuit: feedback.circuit(state.scope, state.memory.id) }, { status: "delivered", circuit: undefined });
  } finally { store.close(); }
});

test("schema v64 migration is additive and preserves prior reasoning memories", () => {
  const path = join(tmpdir(), `mnemora-reasoning-delivery-${process.pid}-${Date.now()}.db`); let legacy;
  try {
    legacy = new GraphologyStore(path); const state = setup(legacy, () => 30_000), memoryId = state.memory.id;
    legacy.db.exec("DROP TABLE mnemora_reasoning_runtime_delivery_item_corrections; DROP TABLE mnemora_reasoning_runtime_delivery_feedback_events; DROP TABLE mnemora_reasoning_memory_delivery_circuits; DROP TABLE mnemora_reasoning_runtime_delivery_items; PRAGMA user_version=61"); legacy.close(); legacy = undefined;
    const migrated = new GraphologyStore(path);
    try {
      assert.equal(SUPPORTED_SCHEMA_VERSION, 69);
      assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 69);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS value FROM mnemora_reasoning_memories WHERE id=?").get(memoryId).value, 1);
      for (const table of ["mnemora_reasoning_runtime_delivery_items", "mnemora_reasoning_memory_delivery_circuits", "mnemora_reasoning_runtime_delivery_feedback_events", "mnemora_reasoning_runtime_delivery_item_corrections"]) assert.equal(migrated.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name=?").get(table).value, 1);
    } finally { migrated.close(); }
  } finally { try { legacy?.close(); } catch {} try { rmSync(path, { force: true }); } catch {} }
});
