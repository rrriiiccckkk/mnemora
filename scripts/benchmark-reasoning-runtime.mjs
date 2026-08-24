import assert from "node:assert/strict";
import { ConversationEventRepository, createMnemoraContextRef, EpisodeRepository, GraphologyStore, REASONING_SEMANTIC_PROVIDER_CONTRACT_V1, ReasoningDeliveryFeedbackRepository, ReasoningGovernedDeliveryService, ReasoningMemoryService, ReasoningRuntimeEvaluationService, ReasoningRuntimeGovernanceRepository, ReasoningRuntimeService, ReasoningRuntimeShadowService, ReasoningRuntimeTelemetryRepository, TaskOutcomeService } from "../dist/index.js";

const scope = "benchmark:reasoning", otherScope = "benchmark:other", store = new GraphologyStore(":memory:"), policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" };
try {
  const event = new ConversationEventRepository(store.db, policy).append({ scope, sessionId: "benchmark", kind: "user_message", role: "user", parts: [{ type: "text", text: "The production migration failed before rollback validation." }] });
  const task = new EpisodeRepository(store.db).create({ scope, kind: "task", summary: "Migrate the production database", sourceEventIds: [event.id], importance: .9, confidence: .9 });
  const evidenceRef = createMnemoraContextRef({ scope, kind: "conversation-event", id: event.id }), taskRef = createMnemoraContextRef({ scope, kind: "episode", id: task.id }), outcomes = new TaskOutcomeService(store.db, () => 100);
  const outcomeInput = { scope, taskRef, verdict: "failure", impact: "harmful", confidence: .9, summary: "Rollback validation was skipped.", evidenceRefs: [evidenceRef] }, outcome = outcomes.confirm(outcomeInput, outcomes.preview(outcomeInput).preview_hash);
  const memories = new ReasoningMemoryService(store.db, () => 200), input = { scope, kind: "failure_guard", strategy: "Validate rollback before every production database migration.", applicability: { taskTypes: ["database_migration"], riskLevels: ["high"] }, sourceTaskRefs: [taskRef], outcomeRefs: [createMnemoraContextRef({ scope, kind: "task-outcome", id: outcome.id })], evidenceRefs: [evidenceRef], confidence: .9 };
  const proposed = memories.propose(input, memories.preview(input).preview_hash), memory = memories.admit(proposed.id, scope, memories.admissionPreview(proposed.id, scope).preview_hash);
  const report = new ReasoningRuntimeEvaluationService(store.db).run([
    { caseId: "high_risk_migration", scope, query: "Deploy a production database migration with rollback validation.", expectedRetrieve: true, expectedMemoryIds: [memory.id] },
    { caseId: "ordinary_edit", scope, query: "Make this paragraph shorter.", expectedRetrieve: false, expectedMemoryIds: [] },
    { caseId: "failure_recovery", scope, query: "Retry rollback validation.", failureSignal: true, taskType: "database_migration", riskLevel: "high", expectedRetrieve: true, expectedMemoryIds: [memory.id] },
    { caseId: "scope_isolation", scope: otherScope, query: "Deploy a production database migration.", expectedRetrieve: true, expectedMemoryIds: [], forbiddenMemoryIds: [memory.id] }
  ]);
  assert.equal(report.passed, true); assert.deepEqual(report.failures, []); assert.equal(report.metrics.crossScopeLeakage, 0); assert.equal(report.metrics.irrelevantInjectionRate, 0); assert.equal(report.metrics.emptyRecallPrecision, 1);
  const semantic = await new ReasoningRuntimeService(store.db).prepareWithSemantic({ scope, query: "上线前检查数据库结构", taskType: "database_migration", riskLevel: "high" }, { id: "benchmark", contractVersion: REASONING_SEMANTIC_PROVIDER_CONTRACT_V1, async search() { return [{ memoryId: memory.id, score: .95 }, { memoryId: "not-local", score: 1 }]; } });
  assert.deepEqual(semantic.context?.items.map(item => item.id), [memory.id]);
  const shadowConfig = { tokenBudget: 800, maxItems: 6, minConfidence: .6, highRiskMinConfidence: .8, minEvidenceQuality: .5, highRiskMinEvidenceQuality: .75, maxStalenessDays: 365, excludeConflicted: true, retentionDays: 30, readiness: { minimumRuns: 1, maxErrorRate: 0, maxEmptyRate: 0, maxP95Ms: 1000 } }, runtimeConfig = { ...shadowConfig, delivery: { enabled: true, scopes: [scope], adapter: "openclaw", calibrationMaxAgeHours: 168, maxConsecutiveDeliveries: 2, itemRetentionDays: 30 } };
  new ReasoningRuntimeShadowService(store.db, shadowConfig, () => 201).capture({ scope, query: "Deploy a production database migration with rollback validation." });
  const readiness = new ReasoningRuntimeTelemetryRepository(store.db, () => 201).readiness(scope, shadowConfig.readiness);
  assert.equal(readiness.ready, true); assert.equal(readiness.deliveryEnabled, false);
  const governance = new ReasoningRuntimeGovernanceRepository(store.db, () => 201), calibrationPreview = governance.previewCalibration(scope, runtimeConfig), calibration = governance.confirmCalibration(scope, runtimeConfig, calibrationPreview.preview_hash).calibration, enable = governance.enablePreview(scope, calibration.id, runtimeConfig);
  assert.equal(governance.enable(scope, calibration.id, runtimeConfig, enable.preview_hash).status, "confirmed");
  const before = memories.get(memory.id, scope), delivery = new ReasoningGovernedDeliveryService(store.db, runtimeConfig, () => 201).handle({ scope, query: "Deploy a production database migration with rollback validation." });
  assert.ok(delivery?.appendSystemContext.includes("Validate rollback")); assert.deepEqual(memories.get(memory.id, scope), before);
  const feedback = new ReasoningDeliveryFeedbackRepository(store.db, () => 202), deliveryItem = feedback.getByRef(delivery.deliveryItemRefs[0], scope); assert.ok(deliveryItem);
  const deliveredOutcomeInput = { scope, taskRef, verdict: "success", impact: "helpful", confidence: .9, summary: "The delivery procedure was applied and the migration completed safely.", evidenceRefs: [evidenceRef, deliveryItem.ref] };
  outcomes.confirm(deliveredOutcomeInput, outcomes.preview(deliveredOutcomeInput).preview_hash);
  const feedbackSummary = feedback.summary(scope); assert.deepEqual({ adopted: feedbackSummary.adoptedItems, helpful: feedbackSummary.helpfulItems, open: feedbackSummary.openMemoryCircuits }, { adopted: 1, helpful: 1, open: 0 });
  const rolledBack = governance.rollback(scope); assert.equal(rolledBack.circuitOpen, true);
  console.log(JSON.stringify({ benchmark: "reasoning-runtime-governance-v1", evaluation: report, semantic: { multilingual_selected: 1, cross_scope_or_unknown_selected: 0 }, readiness, governance: { calibration: calibration.status, delivered: 1, feedback: feedbackSummary, rollback: rolledBack.circuitOpen, memory_mutations: 0 }, outcome_evidence: "fixture_contract_only", scope: "offline_release_gate" }, null, 2));
} finally { store.close(); }
