import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMnemoraContextRef } from "../dist/context/context-ref.js";
import { ReasoningMemoryService } from "../dist/cognition/reasoning.js";
import { ReasoningRetrievalService } from "../dist/cognition/reasoning-retrieval.js";
import { ReasoningReflectionService } from "../dist/cognition/reasoning-reflection.js";
import { REASONING_AGENT_ADAPTER_CONTRACT_V1, ReasoningAgentAdapterRegistry, ReasoningContextCompiler } from "../dist/cognition/reasoning-adapters.js";
import { ReasoningRuntimeService } from "../dist/cognition/reasoning-runtime.js";
import { ReasoningRuntimeEvaluationService } from "../dist/cognition/reasoning-runtime-evaluation.js";
import { REASONING_SEMANTIC_PROVIDER_CONTRACT_V1 } from "../dist/cognition/reasoning-semantic.js";
import { ReasoningRuntimeShadowService, ReasoningRuntimeTelemetryRepository } from "../dist/cognition/reasoning-runtime-telemetry.js";
import { ReasoningGovernedDeliveryService, ReasoningRuntimeGovernanceRepository } from "../dist/cognition/reasoning-runtime-governance.js";
import { TaskOutcomeService } from "../dist/cognition/outcomes.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";
import { EpisodeRepository } from "../dist/episodes/repository.js";
import { GraphologyStore } from "../dist/store.js";
import { SUPPORTED_SCHEMA_VERSION } from "../dist/schema.js";

const policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" };
function fixture(store, scope = "project:ops") {
  const event = new ConversationEventRepository(store.db, policy).append({ scope, sessionId: "s", kind: "user_message", role: "user", parts: [{ type: "text", text: "A migration failed before validation." }] });
  const task = new EpisodeRepository(store.db).create({ scope, kind: "task", summary: "Migrate the production schema", sourceEventIds: [event.id], importance: .9, confidence: .9 });
  const eventRef = createMnemoraContextRef({ scope, kind: "conversation-event", id: event.id });
  const taskRef = createMnemoraContextRef({ scope, kind: "episode", id: task.id });
  const outcomes = new TaskOutcomeService(store.db, () => 100);
  const outcomeInput = { scope, taskRef, verdict: "failure", impact: "harmful", confidence: .9, summary: "Skipped rollback validation.", evidenceRefs: [eventRef] };
  const outcome = outcomes.confirm(outcomeInput, outcomes.preview(outcomeInput).preview_hash);
  return { eventRef, taskRef, outcomeRef: createMnemoraContextRef({ scope, kind: "task-outcome", id: outcome.id }) };
}

test("reasoning memory requires local lineage, remains proposed until admission, and never writes beliefs", () => {
  const store = new GraphologyStore(":memory:");
  try {
    assert.equal(SUPPORTED_SCHEMA_VERSION, 63);
    const { eventRef, taskRef, outcomeRef } = fixture(store), service = new ReasoningMemoryService(store.db, () => 200);
    const input = { scope: "project:ops", kind: "failure_guard", strategy: "Validate rollback and a recovery plan before any production schema mutation.", applicability: { taskTypes: ["database_migration"], riskLevels: ["high"] }, contraindications: ["Do not delay an emergency rollback."], sourceTaskRefs: [taskRef], outcomeRefs: [outcomeRef], evidenceRefs: [eventRef], confidence: .8 };
    const preview = service.preview(input);
    assert.throws(() => service.propose(input, "wrong"), /invalid_reasoning_preview/);
    const proposed = service.propose(input, preview.preview_hash);
    assert.equal(proposed.state, "proposed");
    assert.deepEqual(service.find("project:ops", "rollback"), []);
    assert.throws(() => service.admit(proposed.id, "project:ops", "wrong"), /invalid_reasoning_admission_preview/);
    const admitted = service.admit(proposed.id, "project:ops", service.admissionPreview(proposed.id, "project:ops").preview_hash);
    assert.equal(admitted.state, "admitted");
    assert.equal(admitted.failureCount, 1);
    assert.equal(admitted.utilityScore, -1);
    assert.equal(service.find("project:ops", "rollback")[0].id, admitted.id);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_beliefs").get().value, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_reasoning_memory_events").get().value, 2);
  } finally { store.close(); }
});

test("reasoning memory rejects cross-scope or incomplete lineage and retires an admitted predecessor only on confirmed admission", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const refs = fixture(store), service = new ReasoningMemoryService(store.db, () => 300);
    const base = { scope: "project:ops", kind: "strategy", strategy: "Use a staged migration with a verified rollback.", sourceTaskRefs: [refs.taskRef], outcomeRefs: [refs.outcomeRef], evidenceRefs: [refs.eventRef] };
    assert.throws(() => service.preview({ ...base, scope: "project:other" }), /scope_mismatch/);
    assert.throws(() => service.preview({ ...base, outcomeRefs: [] }), /invalid_reasoning_lineage/);
    const first = service.propose(base, service.preview(base).preview_hash);
    service.admit(first.id, base.scope, service.admissionPreview(first.id, base.scope).preview_hash);
    const replacement = { ...base, strategy: "Stage migrations, verify rollback, then monitor the first production batch.", supersedesId: first.id };
    const second = service.propose(replacement, service.preview(replacement).preview_hash);
    assert.equal(service.get(first.id, base.scope).state, "admitted");
    service.admit(second.id, base.scope, service.admissionPreview(second.id, base.scope).preview_hash);
    assert.equal(service.get(first.id, base.scope).state, "retired");
    assert.equal(service.get(second.id, base.scope).state, "admitted");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_reasoning_memory_events WHERE action='SUPERSEDE'").get().value, 1);
  } finally { store.close(); }
});

test("reasoning governance adds operator-confirmed utility, lifecycle, conflict, and rollback controls", () => {
  let now = 400; const store = new GraphologyStore(":memory:");
  try {
    const refs = fixture(store), service = new ReasoningMemoryService(store.db, () => ++now);
    const base = { scope: "project:ops", kind: "strategy", strategy: "Validate rollback before production migration.", applicability: { taskTypes: ["database_migration"], riskLevels: ["high"] }, sourceTaskRefs: [refs.taskRef], outcomeRefs: [refs.outcomeRef], evidenceRefs: [refs.eventRef] };
    const first = service.propose(base, service.preview(base).preview_hash); service.admit(first.id, base.scope, service.admissionPreview(first.id, base.scope).preview_hash);
    const outcomes = new TaskOutcomeService(store.db, () => ++now);
    const successful = { scope: base.scope, taskRef: refs.taskRef, verdict: "success", impact: "helpful", evidenceRefs: [refs.eventRef] };
    const outcome = outcomes.confirm(successful, outcomes.preview(successful).preview_hash), outcomeRef = createMnemoraContextRef({ scope: base.scope, kind: "task-outcome", id: outcome.id });
    const linked = service.linkOutcome(first.id, base.scope, outcomeRef, service.outcomeLinkPreview(first.id, base.scope, outcomeRef).preview_hash);
    assert.deepEqual({ success: linked.successCount, failure: linked.failureCount, utility: linked.utilityScore }, { success: 1, failure: 1, utility: 0 });
    const review = { id: first.id, scope: base.scope, toState: "needs_review", reasonCode: "negative_outcome" };
    service.transition(review, service.transitionPreview(review).preview_hash);
    assert.deepEqual(service.find(base.scope, "rollback"), []);
    const provisional = { ...review, toState: "provisional", reasonCode: "operator_reassessment" };
    service.transition(provisional, service.transitionPreview(provisional).preview_hash);
    const competing = { ...base, strategy: "Skip rollback validation when migration is small." };
    const second = service.propose(competing, service.preview(competing).preview_hash);
    const secondProvisional = { id: second.id, scope: base.scope, toState: "provisional", reasonCode: "operator_review" };
    service.transition(secondProvisional, service.transitionPreview(secondProvisional).preview_hash);
    assert.equal(service.conflicts(base.scope).some(item => item.leftId === first.id || item.rightId === first.id), true);
    const restore = { ...provisional, toState: "admitted", reasonCode: "evidence_reconfirmed" };
    service.transition(restore, service.transitionPreview(restore).preview_hash);
    const successorInput = { ...base, strategy: "Validate rollback, stage the migration, then monitor the first batch.", supersedesId: first.id };
    const successor = service.propose(successorInput, service.preview(successorInput).preview_hash); service.admit(successor.id, base.scope, service.admissionPreview(successor.id, base.scope).preview_hash);
    assert.equal(service.rollback(successor.id, base.scope, service.rollbackPreview(successor.id, base.scope).preview_hash).id, first.id);
    assert.equal(service.get(successor.id, base.scope).state, "retired");
    assert.equal(service.history(first.id, base.scope).some(event => event.action === "ROLLBACK"), true);
  } finally { store.close(); }
});

test("reasoning retrieval is scope-bound, applicability-aware, explainable, and read-only", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const refs = fixture(store), memories = new ReasoningMemoryService(store.db, () => 600);
    const admittedInput = { scope: "project:ops", kind: "failure_guard", strategy: "Validate rollback before every production database migration.", applicability: { taskTypes: ["database_migration"], riskLevels: ["high"], environments: ["production"], requiredTools: ["sqlite"] }, contraindications: ["emergency rollback"], sourceTaskRefs: [refs.taskRef], outcomeRefs: [refs.outcomeRef], evidenceRefs: [refs.eventRef], confidence: .9 };
    const admitted = memories.propose(admittedInput, memories.preview(admittedInput).preview_hash); memories.admit(admitted.id, admitted.scope, memories.admissionPreview(admitted.id, admitted.scope).preview_hash);
    const provisionalInput = { ...admittedInput, strategy: "Validate rollback after the production database migration." };
    const provisional = memories.propose(provisionalInput, memories.preview(provisionalInput).preview_hash); const move = { id: provisional.id, scope: provisional.scope, toState: "provisional", reasonCode: "operator_review" }; memories.transition(move, memories.transitionPreview(move).preview_hash);
    const retrieval = new ReasoningRetrievalService(store.db);
    const found = retrieval.find({ scope: "project:ops", query: "rollback database migration", taskType: "database_migration", riskLevel: "high", environment: "production", availableTools: ["sqlite"] });
    assert.equal(found.candidates.length, 1);
    assert.deepEqual({ id: found.candidates[0].id, score: found.candidates[0].score > 0, task: found.candidates[0].reasons.includes("task_type_match"), tools: found.candidates[0].reasons.includes("required_tools_match") }, { id: admitted.id, score: true, task: true, tools: true });
    const missingTool = retrieval.find({ scope: "project:ops", query: "rollback database migration", availableTools: ["read_only"] });
    assert.equal(missingTool.candidates.length, 0); assert.equal(missingTool.excluded.required_tool, 1);
    const contraindicated = retrieval.find({ scope: "project:ops", query: "emergency rollback", availableTools: ["sqlite"] });
    assert.equal(contraindicated.candidates.length, 0); assert.equal(contraindicated.excluded.contraindication, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_reasoning_memory_governance_events").get().value, 1);
    assert.deepEqual(retrieval.find({ scope: "project:other", query: "rollback" }).candidates, []);
  } finally { store.close(); }
});

test("contrastive reasoning reflection creates review proposals only after explicit confirmation", () => {
  let now = 700; const store = new GraphologyStore(":memory:");
  try {
    const refs = fixture(store), reasoning = new ReasoningMemoryService(store.db, () => ++now);
    const input = { scope: "project:ops", kind: "failure_guard", strategy: "Validate rollback before production schema changes.", sourceTaskRefs: [refs.taskRef], outcomeRefs: [refs.outcomeRef], evidenceRefs: [refs.eventRef] };
    const memory = reasoning.propose(input, reasoning.preview(input).preview_hash); reasoning.admit(memory.id, input.scope, reasoning.admissionPreview(memory.id, input.scope).preview_hash);
    const outcomes = new TaskOutcomeService(store.db, () => ++now), successInput = { scope: input.scope, taskRef: refs.taskRef, verdict: "success", impact: "helpful", evidenceRefs: [refs.eventRef] };
    const success = outcomes.confirm(successInput, outcomes.preview(successInput).preview_hash), successRef = createMnemoraContextRef({ scope: input.scope, kind: "task-outcome", id: success.id });
    reasoning.linkOutcome(memory.id, input.scope, successRef, reasoning.outcomeLinkPreview(memory.id, input.scope, successRef).preview_hash);
    const reflection = new ReasoningReflectionService(store.db, () => ++now), preview = reflection.preview(input.scope);
    assert.equal(preview.proposals.length, 1); assert.deepEqual({ kind: preview.proposals[0].kind, reason: preview.proposals[0].reasonCode }, { kind: "outcome_contrast", reason: "contrasting_recorded_outcomes" });
    assert.throws(() => reflection.run(input.scope, "wrong"), /invalid_reasoning_reflection_preview/);
    assert.deepEqual(reflection.run(input.scope, preview.preview_hash), { proposed: 1, existing: 0 });
    assert.deepEqual(reflection.run(input.scope, reflection.preview(input.scope).preview_hash), { proposed: 0, existing: 1 });
    assert.equal(reflection.proposals(input.scope)[0].sourceRefs.includes(successRef), true);
    assert.equal(reasoning.get(memory.id, input.scope).state, "admitted");
    assert.deepEqual(reflection.metrics(input.scope), { scope: input.scope, proposals: { outcome_contrast: 1 }, unsafe_promotions: 0 });
  } finally { store.close(); }
});

test("reasoning context compilation is bounded and adapters only present compiled, source-linked data", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const refs = fixture(store), memories = new ReasoningMemoryService(store.db, () => 800);
    const input = { scope: "project:ops", kind: "procedure", strategy: "Inspect the schema version before editing a migration.", applicability: { taskTypes: ["database_migration"] }, sourceTaskRefs: [refs.taskRef], outcomeRefs: [refs.outcomeRef], evidenceRefs: [refs.eventRef], confidence: .9 };
    const memory = memories.propose(input, memories.preview(input).preview_hash); memories.admit(memory.id, input.scope, memories.admissionPreview(memory.id, input.scope).preview_hash);
    const compiler = new ReasoningContextCompiler(store.db), compiled = compiler.compile({ scope: input.scope, query: "schema migration", taskType: "database_migration", tokenBudget: 128 });
    assert.deepEqual({ version: compiled.version, items: compiled.items.length, authority: compiled.items[0].authority, source: compiled.items[0].sourceRefs.includes(refs.eventRef) }, { version: "reasoning-context-v1", items: 1, authority: "operator_confirmed", source: true });
    const adapters = new ReasoningAgentAdapterRegistry(); const codex = adapters.render("codex", compiled), openclaw = adapters.render("openclaw", compiled);
    assert.deepEqual({ contract: codex.contractVersion, channel: codex.channel, same: codex.content === openclaw.content, hasStrategy: codex.content.includes("Inspect the schema version") }, { contract: REASONING_AGENT_ADAPTER_CONTRACT_V1, channel: "sidecar", same: true, hasStrategy: true });
    assert.throws(() => adapters.register({ id: "bad", contractVersion: "wrong", render: () => codex }), /invalid_reasoning_agent_adapter/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_reasoning_memory_governance_events").get().value, 0);
    assert.deepEqual(compiler.compile({ scope: "project:other", query: "schema" }).items, []);
  } finally { store.close(); }
});

test("reasoning runtime policy is deterministic, shadow-only, and does not retrieve for ordinary chat", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const refs = fixture(store), memories = new ReasoningMemoryService(store.db, () => 900);
    const input = { scope: "project:ops", kind: "failure_guard", strategy: "Validate rollback before every production database migration.", applicability: { taskTypes: ["database_migration"], riskLevels: ["high"] }, sourceTaskRefs: [refs.taskRef], outcomeRefs: [refs.outcomeRef], evidenceRefs: [refs.eventRef], confidence: .9 };
    const memory = memories.propose(input, memories.preview(input).preview_hash); memories.admit(memory.id, input.scope, memories.admissionPreview(memory.id, input.scope).preview_hash);
    const runtime = new ReasoningRuntimeService(store.db), before = store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_reasoning_memory_governance_events").get().value;
    const prepared = runtime.prepare({ scope: input.scope, query: "Deploy a production database migration with a rollback plan.", tokenBudget: 128 });
    assert.deepEqual({ version: prepared.version, mode: prepared.decision.mode, retrieve: prepared.decision.shouldRetrieve, task: prepared.decision.taskType, risk: prepared.decision.riskLevel, highRisk: prepared.decision.triggers.includes("high_risk_operation"), items: prepared.context?.items.length }, { version: "reasoning-runtime-v1", mode: "shadow", retrieve: true, task: "database_migration", risk: "high", highRisk: true, items: 1 });
    const ordinary = runtime.prepare({ scope: input.scope, query: "Please make this paragraph shorter." });
    assert.deepEqual({ retrieve: ordinary.decision.shouldRetrieve, context: ordinary.context, reason: ordinary.decision.reasons }, { retrieve: false, context: undefined, reason: ["no_runtime_retrieval_trigger"] });
    assert.equal(runtime.plan({ scope: input.scope, query: "retry", failureSignal: true }).triggers.includes("failure_recovery"), true);
    assert.deepEqual(runtime.prepare({ scope: "project:other", query: "deploy database migration" }).context?.items, []);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_reasoning_memory_governance_events").get().value, before);
  } finally { store.close(); }
});

test("reasoning runtime evaluation reports bounded aggregate safety metrics without query content", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const refs = fixture(store), memories = new ReasoningMemoryService(store.db, () => 950), input = { scope: "project:ops", kind: "failure_guard", strategy: "Validate rollback before every production database migration.", applicability: { taskTypes: ["database_migration"], riskLevels: ["high"] }, sourceTaskRefs: [refs.taskRef], outcomeRefs: [refs.outcomeRef], evidenceRefs: [refs.eventRef], confidence: .9 };
    const proposed = memories.propose(input, memories.preview(input).preview_hash), memory = memories.admit(proposed.id, input.scope, memories.admissionPreview(proposed.id, input.scope).preview_hash), evaluation = new ReasoningRuntimeEvaluationService(store.db);
    const report = evaluation.run([
      { caseId: "migration", scope: input.scope, query: "Deploy a production database migration with rollback validation.", expectedRetrieve: true, expectedMemoryIds: [memory.id] },
      { caseId: "ordinary", scope: input.scope, query: "Make this paragraph shorter.", expectedRetrieve: false, expectedMemoryIds: [] },
      { caseId: "isolated", scope: "project:other", query: "Deploy a production database migration.", expectedRetrieve: true, expectedMemoryIds: [], forbiddenMemoryIds: [memory.id] }
    ]);
    assert.deepEqual({ version: report.version, cases: report.cases, passed: report.passed, failures: report.failures, precision: report.metrics.triggerPrecision, recall: report.metrics.retrievalRecall, empty: report.metrics.emptyRecallPrecision, leakage: report.metrics.crossScopeLeakage }, { version: "reasoning-runtime-evaluation-v1", cases: 3, passed: true, failures: [], precision: 1, recall: 1, empty: 1, leakage: 0 });
    const failed = evaluation.run([{ caseId: "expected_task", scope: input.scope, query: "PRIVATE QUERY CONTENT", expectedRetrieve: true, expectedMemoryIds: [] }]);
    assert.equal(failed.passed, false); assert.deepEqual(failed.failures, [{ caseId: "expected_task", reasons: ["trigger_false_negative"] }]); assert.equal(JSON.stringify(failed).includes("PRIVATE QUERY CONTENT"), false);
    assert.throws(() => evaluation.run([]), /invalid_reasoning_runtime_evaluation/);
  } finally { store.close(); }
});

test("reasoning runtime quality policy rejects low-confidence, stale, and conflicted memories", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const refs = fixture(store), memories = new ReasoningMemoryService(store.db, () => 1_000), input = { scope: "project:ops", kind: "failure_guard", strategy: "Validate rollback before every production database migration.", applicability: { taskTypes: ["database_migration"], riskLevels: ["high"] }, sourceTaskRefs: [refs.taskRef], outcomeRefs: [refs.outcomeRef], evidenceRefs: [refs.eventRef], confidence: .9 };
    const proposed = memories.propose(input, memories.preview(input).preview_hash), memory = memories.admit(proposed.id, input.scope, memories.admissionPreview(proposed.id, input.scope).preview_hash);
    const policy = { minConfidence: .6, highRiskMinConfidence: .8, minEvidenceQuality: .5, highRiskMinEvidenceQuality: .75, maxStalenessDays: 1, excludeConflicted: true };
    const retrieve = () => new ReasoningRetrievalService(store.db).find({ scope: input.scope, query: "rollback database migration", riskLevel: "high", qualityPolicy: policy, now: () => 2_000 });
    assert.equal(retrieve().candidates[0].id, memory.id);
    store.db.prepare("UPDATE mnemora_reasoning_memories SET confidence=.7 WHERE id=?").run(memory.id); assert.equal(retrieve().excluded.confidence, 1);
    store.db.prepare("UPDATE mnemora_reasoning_memories SET confidence=.9,updated_at=0 WHERE id=?").run(memory.id); const stale = new ReasoningRetrievalService(store.db).find({ scope: input.scope, query: "rollback", riskLevel: "high", qualityPolicy: policy, now: () => 2 * 86_400_000 }); assert.equal(stale.excluded.staleness, 1);
    store.db.prepare("UPDATE mnemora_reasoning_memories SET updated_at=1000,success_count=1,failure_count=1 WHERE id=?").run(memory.id); assert.equal(retrieve().excluded.conflict, 1);
  } finally { store.close(); }
});

test("optional semantic provider is bounded and cannot bypass scope or admission", async () => {
  const store = new GraphologyStore(":memory:");
  try {
    const refs = fixture(store), memories = new ReasoningMemoryService(store.db, () => 1_100), input = { scope: "project:ops", kind: "procedure", strategy: "Inspect schema state and validate rollback before migration.", sourceTaskRefs: [refs.taskRef], outcomeRefs: [refs.outcomeRef], evidenceRefs: [refs.eventRef], confidence: .9 };
    const proposed = memories.propose(input, memories.preview(input).preview_hash), memory = memories.admit(proposed.id, input.scope, memories.admissionPreview(proposed.id, input.scope).preview_hash);
    let received; const provider = { id: "fixture", contractVersion: REASONING_SEMANTIC_PROVIDER_CONTRACT_V1, async search(value) { received = value; return [{ memoryId: memory.id, score: .95 }, { memoryId: "cross-scope-or-unknown", score: 1 }]; } };
    const result = await new ReasoningRuntimeService(store.db).prepareWithSemantic({ scope: input.scope, query: "上线前先检查数据库结构", taskType: "database_migration" }, provider, 1_000);
    assert.deepEqual({ items: result.context.items.map(item => item.id), bounded: received.query, aborted: received.signal.aborted }, { items: [memory.id], bounded: "上线前先检查数据库结构", aborted: false });
    assert.equal(result.context.items[0].reasons.some(reason => reason.startsWith("semantic_match:")), true);
  } finally { store.close(); }
});

test("semantic provider deadline and caller cancellation terminate providers that ignore AbortSignal", async () => {
  const store = new GraphologyStore(":memory:");
  try {
    const hanging = { id: "hanging", contractVersion: REASONING_SEMANTIC_PROVIDER_CONTRACT_V1, search() { return new Promise(() => {}); } }, runtime = new ReasoningRuntimeService(store.db);
    await assert.rejects(runtime.prepareWithSemantic({ scope: "project:ops", query: "migration", taskType: "database_migration" }, hanging, 100), /reasoning_semantic_timeout/);
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await assert.rejects(runtime.prepareWithSemantic({ scope: "project:ops", query: "migration", taskType: "database_migration", signal: controller.signal }, hanging, 1_000), /cancelled/);
  } finally { store.close(); }
});

test("real-request shadow telemetry is aggregate-only and readiness never enables delivery", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const refs = fixture(store), memories = new ReasoningMemoryService(store.db, () => 1_200), input = { scope: "project:ops", kind: "failure_guard", strategy: "Validate rollback before every production database migration.", sourceTaskRefs: [refs.taskRef], outcomeRefs: [refs.outcomeRef], evidenceRefs: [refs.eventRef], confidence: .9 };
    const proposed = memories.propose(input, memories.preview(input).preview_hash); memories.admit(proposed.id, input.scope, memories.admissionPreview(proposed.id, input.scope).preview_hash);
    const config = { tokenBudget: 800, maxItems: 6, minConfidence: .6, highRiskMinConfidence: .8, minEvidenceQuality: .5, highRiskMinEvidenceQuality: .75, maxStalenessDays: 365, excludeConflicted: true, retentionDays: 30, readiness: { minimumRuns: 1, maxErrorRate: .1, maxEmptyRate: 1, maxP95Ms: 1000 } };
    new ReasoningRuntimeShadowService(store.db, config, () => 1_300).capture({ scope: input.scope, query: "Deploy a production database migration with rollback." });
    const telemetry = new ReasoningRuntimeTelemetryRepository(store.db, () => 1_300), metrics = telemetry.metrics(input.scope), readiness = telemetry.readiness(input.scope, config.readiness);
    assert.deepEqual({ runs: metrics.runs, triggered: metrics.triggered, selected: metrics.selected, failures: metrics.failures, ready: readiness.ready, delivery: readiness.deliveryEnabled }, { runs: 1, triggered: 1, selected: 1, failures: 0, ready: true, delivery: false });
    const columns = store.db.prepare("PRAGMA table_info(mnemora_reasoning_runtime_shadow_runs)").all().map(row => row.name);
    assert.equal(columns.some(name => /query|text|memory_id|source|ref/i.test(name)), false);
    assert.equal(JSON.stringify({ metrics, readiness }).includes("Deploy a production"), false);
    assert.equal(telemetry.readiness(input.scope, { ...config.readiness, minimumRuns: 2 }).reasons.includes("insufficient_shadow_runs"), true);
    assert.equal(telemetry.readiness("project:other", config.readiness).reasons.includes("no_triggered_shadow_runs"), true);
  } finally { store.close(); }
});

test("governed reasoning delivery requires fresh calibration, exact-scope canary, and explicit rollback", () => {
  let now = 3_000; const store = new GraphologyStore(":memory:");
  try {
    const refs = fixture(store), memories = new ReasoningMemoryService(store.db, () => 2_000), input = { scope: "project:ops", kind: "failure_guard", strategy: "Validate rollback before every production database migration.", applicability: { taskTypes: ["database_migration"], riskLevels: ["high"] }, sourceTaskRefs: [refs.taskRef], outcomeRefs: [refs.outcomeRef], evidenceRefs: [refs.eventRef], confidence: .9 };
    const proposed = memories.propose(input, memories.preview(input).preview_hash), memory = memories.admit(proposed.id, input.scope, memories.admissionPreview(proposed.id, input.scope).preview_hash), config = governedConfig(input.scope), telemetry = new ReasoningRuntimeShadowService(store.db, config, () => now);
    telemetry.capture({ scope: input.scope, query: "Deploy a production database migration with rollback." });
    const governance = new ReasoningRuntimeGovernanceRepository(store.db, () => now), preview = governance.previewCalibration(input.scope, config); assert.equal(preview.status, "ready");
    const calibration = governance.confirmCalibration(input.scope, config, preview.preview_hash).calibration, enable = governance.enablePreview(input.scope, calibration.id, config); assert.equal(enable.status, "preview");
    assert.equal(governance.enable(input.scope, calibration.id, config, enable.preview_hash).status, "confirmed");
    const before = memories.get(memory.id, input.scope), output = new ReasoningGovernedDeliveryService(store.db, config, () => now).handle({ scope: input.scope, query: "Deploy a production database migration with rollback." });
    assert.match(output.appendSystemContext, /^<MNEMORA_REASONING_CONTEXT/); assert.match(output.appendSystemContext, /Validate rollback/); assert.doesNotMatch(output.appendSystemContext, /Deploy a production/);
    assert.deepEqual({ active: governance.status(input.scope, config).active, deliveries: governance.deliveries(input.scope).length, state: memories.get(memory.id, input.scope).state, confidence: memories.get(memory.id, input.scope).confidence }, { active: true, deliveries: 1, state: before.state, confidence: before.confidence });
    now += 1; assert.equal(new ReasoningGovernedDeliveryService(store.db, config, () => now).handle({ scope: input.scope, query: "Deploy a production database migration with rollback." }, { deliveryAllowed: false }), undefined);
    assert.equal(governance.deliveries(input.scope)[0].reason_code, "cadence");
    assert.equal(new ReasoningGovernedDeliveryService(store.db, config, () => now).handle({ scope: "project:other", query: "Deploy a production migration." }), undefined);
    assert.equal(governance.rollback(input.scope).circuitOpen, true); assert.equal(new ReasoningGovernedDeliveryService(store.db, config, () => now).handle({ scope: input.scope, query: "Deploy a production migration." }), undefined);
  } finally { store.close(); }
});

test("readiness regression and harmful operator feedback open the reasoning delivery circuit without changing memory", () => {
  let now = 4_000; const store = new GraphologyStore(":memory:");
  try {
    const refs = fixture(store), memories = new ReasoningMemoryService(store.db, () => 3_500), input = { scope: "project:ops", kind: "procedure", strategy: "Inspect schema state before migration.", sourceTaskRefs: [refs.taskRef], outcomeRefs: [refs.outcomeRef], evidenceRefs: [refs.eventRef], confidence: .9 }, proposed = memories.propose(input, memories.preview(input).preview_hash), memory = memories.admit(proposed.id, input.scope, memories.admissionPreview(proposed.id, input.scope).preview_hash), config = governedConfig(input.scope), shadow = new ReasoningRuntimeShadowService(store.db, config, () => now), governance = new ReasoningRuntimeGovernanceRepository(store.db, () => now);
    shadow.capture({ scope: input.scope, query: "Deploy a production database migration." }); const calibrationPreview = governance.previewCalibration(input.scope, config), calibration = governance.confirmCalibration(input.scope, config, calibrationPreview.preview_hash).calibration, enable = governance.enablePreview(input.scope, calibration.id, config); governance.enable(input.scope, calibration.id, config, enable.preview_hash);
    const delivery = new ReasoningGovernedDeliveryService(store.db, config, () => now).handle({ scope: input.scope, query: "Deploy a production database migration." }); assert.ok(delivery);
    const row = governance.deliveries(input.scope)[0], feedbackPreview = governance.feedbackPreview(row.id, input.scope, "harmful"); assert.equal(feedbackPreview.status, "preview"); assert.deepEqual(governance.feedback(row.id, input.scope, "harmful", feedbackPreview.preview_hash), { status: "confirmed", circuitOpened: true });
    assert.deepEqual({ circuit: governance.status(input.scope, config).circuitOpen, state: memories.get(memory.id, input.scope).state, confidence: memories.get(memory.id, input.scope).confidence }, { circuit: true, state: "admitted", confidence: .9 });
    now += 1; shadow.capture({ scope: input.scope, query: "Deploy a production database migration." }); const nextPreview = governance.previewCalibration(input.scope, config), next = governance.confirmCalibration(input.scope, config, nextPreview.preview_hash).calibration, nextEnable = governance.enablePreview(input.scope, next.id, config); assert.equal(nextEnable.status, "preview"); governance.enable(input.scope, next.id, config, nextEnable.preview_hash);
    new ReasoningRuntimeTelemetryRepository(store.db, () => now).record({ scope: input.scope, status: "failed", triggered: false, highRisk: false, candidateCount: 0, selectedCount: 0, qualityExcluded: 0, empty: false, estimatedTokens: 0, durationMs: 1, errorCategory: "operation_failed" });
    assert.deepEqual({ active: governance.status(input.scope, config).active, reason: governance.status(input.scope, config).reason }, { active: false, reason: "readiness_regression" });
    assert.deepEqual(governance.authorize(input.scope, config), { allowed: false, reason: "readiness_regression" }); assert.equal(governance.status(input.scope, config).circuitOpen, true);
  } finally { store.close(); }
});

test("reasoning canaries expire and bind activation to the calibrated runtime policy", () => {
  let now = 5_000; const scope = "project:ops", store = new GraphologyStore(":memory:");
  try {
    const config = governedConfig(scope), shadow = new ReasoningRuntimeShadowService(store.db, config, () => now), governance = new ReasoningRuntimeGovernanceRepository(store.db, () => now);
    shadow.capture({ scope, query: "Deploy a production database migration." });
    const preview = governance.previewCalibration(scope, config), calibration = governance.confirmCalibration(scope, config, preview.preview_hash).calibration, enable = governance.enablePreview(scope, calibration.id, config); governance.enable(scope, calibration.id, config, enable.preview_hash);
    now += 3_600_001; assert.deepEqual({ active: governance.status(scope, config).active, reason: governance.status(scope, config).reason }, { active: false, reason: "calibration_expired" }); assert.deepEqual(governance.authorize(scope, config), { allowed: false, reason: "calibration_expired" });
    now += 1; shadow.capture({ scope, query: "Deploy a production database migration." }); const nextPreview = governance.previewCalibration(scope, config), next = governance.confirmCalibration(scope, config, nextPreview.preview_hash).calibration, nextEnable = governance.enablePreview(scope, next.id, config); governance.enable(scope, next.id, config, nextEnable.preview_hash);
    const changed = { ...config, delivery: { ...config.delivery, maxConsecutiveDeliveries: 3 } };
    assert.deepEqual({ active: governance.status(scope, changed).active, reason: governance.status(scope, changed).reason }, { active: false, reason: "policy_changed" }); assert.deepEqual(governance.authorize(scope, changed), { allowed: false, reason: "policy_changed" });
  } finally { store.close(); }
});

test("reasoning runtime governance tables persist no query, strategy, memory id, evidence, source, or session fields", () => {
  const store = new GraphologyStore(":memory:");
  try {
    for (const table of ["mnemora_reasoning_runtime_calibrations", "mnemora_reasoning_runtime_canaries", "mnemora_reasoning_runtime_canary_events", "mnemora_reasoning_runtime_delivery_runs"]) {
      const columns = store.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name).join(" "); assert.doesNotMatch(columns, /query|strategy|memory_id|evidence|source|session|run_id/i);
    }
  } finally { store.close(); }
});

test("schema v44 adds reasoning reflection proposals without rebuilding governance data", () => {
  const path = join(tmpdir(), `mnemora-reasoning-${process.pid}-${Date.now()}.db`); let legacy;
  try {
    legacy = new GraphologyStore(path); legacy.db.exec("DROP TABLE mnemora_reasoning_reflection_proposals; PRAGMA user_version=43"); legacy.close(); legacy = undefined;
    const migrated = new GraphologyStore(path);
    try {
      assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 63);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='mnemora_reasoning_memories'").get().value, 1);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='mnemora_task_outcomes'").get().value, 1);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='mnemora_reasoning_memory_governance_events'").get().value, 1);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='mnemora_reasoning_reflection_proposals'").get().value, 1);
    } finally { migrated.close(); }
  } finally { try { legacy?.close(); } catch {} try { rmSync(path, { force: true }); } catch {} }
});

test("schema v45 adds aggregate reasoning shadow telemetry without rebuilding v44 memories", () => {
  const path = join(tmpdir(), `mnemora-reasoning-v45-${process.pid}-${Date.now()}.db`); let legacy;
  try {
    legacy = new GraphologyStore(path); const refs = fixture(legacy), service = new ReasoningMemoryService(legacy.db, () => 2_000), input = { scope: "project:ops", kind: "strategy", strategy: "Validate rollback before migration.", sourceTaskRefs: [refs.taskRef], outcomeRefs: [refs.outcomeRef], evidenceRefs: [refs.eventRef] }, proposed = service.propose(input, service.preview(input).preview_hash), memory = service.admit(proposed.id, input.scope, service.admissionPreview(proposed.id, input.scope).preview_hash);
    legacy.db.exec("DROP TABLE mnemora_reasoning_runtime_shadow_runs; PRAGMA user_version=44"); legacy.close(); legacy = undefined;
    const migrated = new GraphologyStore(path);
    try {
      assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 63);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS value FROM mnemora_reasoning_memories WHERE id=?").get(memory.id).value, 1);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='mnemora_reasoning_runtime_shadow_runs'").get().value, 1);
    } finally { migrated.close(); }
  } finally { try { legacy?.close(); } catch {} try { rmSync(path, { force: true }); } catch {} }
});

test("schema v46 adds governed delivery controls without rebuilding v45 reasoning data", () => {
  const path = join(tmpdir(), `mnemora-reasoning-v46-${process.pid}-${Date.now()}.db`); let legacy;
  try {
    legacy = new GraphologyStore(path); const refs = fixture(legacy), service = new ReasoningMemoryService(legacy.db, () => 5_000), input = { scope: "project:ops", kind: "strategy", strategy: "Validate rollback before migration.", sourceTaskRefs: [refs.taskRef], outcomeRefs: [refs.outcomeRef], evidenceRefs: [refs.eventRef] }, proposed = service.propose(input, service.preview(input).preview_hash), memory = service.admit(proposed.id, input.scope, service.admissionPreview(proposed.id, input.scope).preview_hash);
    legacy.db.exec("DROP TABLE mnemora_reasoning_runtime_delivery_runs; DROP TABLE mnemora_reasoning_runtime_canary_events; DROP TABLE mnemora_reasoning_runtime_canaries; DROP TABLE mnemora_reasoning_runtime_calibrations; PRAGMA user_version=45"); legacy.close(); legacy = undefined;
    const migrated = new GraphologyStore(path); try { assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 63); assert.equal(migrated.db.prepare("SELECT COUNT(*) AS value FROM mnemora_reasoning_memories WHERE id=?").get(memory.id).value, 1); assert.equal(migrated.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='mnemora_reasoning_runtime_delivery_runs'").get().value, 1); } finally { migrated.close(); }
  } finally { try { legacy?.close(); } catch {} try { rmSync(path, { force: true }); } catch {} }
});

function governedConfig(scope) { return { tokenBudget: 800, maxItems: 6, minConfidence: .6, highRiskMinConfidence: .8, minEvidenceQuality: .5, highRiskMinEvidenceQuality: .75, maxStalenessDays: 365, excludeConflicted: true, retentionDays: 30, readiness: { minimumRuns: 1, maxErrorRate: 0, maxEmptyRate: 1, maxP95Ms: 1000 }, delivery: { enabled: true, scopes: [scope], adapter: "openclaw", calibrationMaxAgeHours: 1, maxConsecutiveDeliveries: 2, itemRetentionDays: 30 } }; }
