import assert from "node:assert/strict";
import test from "node:test";
import { createMnemoraContextRef } from "../dist/context/context-ref.js";
import { ReasoningMemoryService } from "../dist/cognition/reasoning.js";
import { LocalReasoningSemanticProvider, ReasoningMemoryEmbeddingRepository } from "../dist/cognition/reasoning-semantic-embeddings.js";
import { ReasoningRetrievalService } from "../dist/cognition/reasoning-retrieval.js";
import { ReasoningRuntimeService } from "../dist/cognition/reasoning-runtime.js";
import { ReasoningRuntimeShadowService, ReasoningRuntimeTelemetryRepository } from "../dist/cognition/reasoning-runtime-telemetry.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";
import { EpisodeRepository } from "../dist/episodes/repository.js";
import { TaskOutcomeService } from "../dist/cognition/outcomes.js";
import { GraphologyStore } from "../dist/store.js";
import { SUPPORTED_SCHEMA_VERSION } from "../dist/schema.js";
import { classifyReasoningTask } from "../dist/cognition/reasoning-task-types.js";

const scope = "project:semantic", policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" };
const runtimeConfig = { tokenBudget: 800, maxItems: 6, minConfidence: .6, highRiskMinConfidence: .8, minEvidenceQuality: .5, highRiskMinEvidenceQuality: .75, maxStalenessDays: 365, excludeConflicted: true, retentionDays: 30, readiness: { minimumRuns: 1, maxErrorRate: 0, maxEmptyRate: 0, maxP95Ms: 1000 } };

function fixture(store) {
  const event = new ConversationEventRepository(store.db, policy).append({ scope, sessionId: "semantic", kind: "user_message", role: "user", parts: [{ type: "text", text: "接口调试经历" }] });
  const episode = new EpisodeRepository(store.db).create({ scope, kind: "task", summary: "调试第三方接口", sourceEventIds: [event.id], importance: .9, confidence: .9 });
  const eventRef = createMnemoraContextRef({ scope, kind: "conversation-event", id: event.id }), taskRef = createMnemoraContextRef({ scope, kind: "episode", id: episode.id });
  const outcomes = new TaskOutcomeService(store.db, () => 100), input = { scope, taskRef, verdict: "success", impact: "helpful", confidence: .9, summary: "接口故障已定位", evidenceRefs: [eventRef] }, outcome = outcomes.confirm(input, outcomes.preview(input).preview_hash);
  return { eventRef, taskRef, outcomeRef: createMnemoraContextRef({ scope, kind: "task-outcome", id: outcome.id }) };
}

const embedder = { async embed(inputs) { return { identity: { provider: "ollama", model: "fixture", dimensions: 2 }, vectors: inputs.map(() => [1, 0]) }; } };

test("reasoning semantic index bridges English runtime queries to Chinese strategies without cross-scope leakage", async () => {
  const store = new GraphologyStore(":memory:");
  try {
    assert.equal(SUPPORTED_SCHEMA_VERSION, 65);
    const telemetryColumns = store.db.prepare("PRAGMA table_info(mnemora_reasoning_runtime_shadow_runs)").all().map(row => row.name);
    assert.equal(telemetryColumns.includes("semantic_candidates") && telemetryColumns.includes("unmatched") && telemetryColumns.includes("task_type_excluded"), true);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='mnemora_reasoning_memory_embeddings'").get().n, 1);
    const refs = fixture(store), memories = new ReasoningMemoryService(store.db, () => 200);
    const input = { scope, kind: "procedure", strategy: "集成第三方 API 时，先记录请求与响应，再定位接口报错。", applicability: { taskTypes: ["debugging"] }, sourceTaskRefs: [refs.taskRef], outcomeRefs: [refs.outcomeRef], evidenceRefs: [refs.eventRef], confidence: .9 };
    const proposed = memories.propose(input, memories.preview(input).preview_hash), memory = memories.admit(proposed.id, scope, memories.admissionPreview(proposed.id, scope).preview_hash);
    assert.deepEqual(memory.applicability.taskTypes, ["software_debugging"]);
    const index = new ReasoningMemoryEmbeddingRepository(store.db, () => 300), backfill = await index.backfill({ scope, embedder, maxInputChars: 512, limit: 10, identity: { provider: "ollama", model: "fixture" } });
    assert.deepEqual(backfill, { version: "reasoning-memory-embedding-backfill-v1", scope, processed: 1, indexed: 1, skipped: 0 });
    assert.equal((await index.backfill({ scope, embedder, maxInputChars: 512, limit: 10, identity: { provider: "ollama", model: "fixture" } })).indexed, 0);
    assert.deepEqual(index.status(scope), { version: "reasoning-memory-embedding-status-v1", scope, admitted: 1, indexed: 1 });
    assert.equal(store.db.prepare("SELECT typeof(embedding) AS type FROM mnemora_reasoning_memory_embeddings WHERE memory_id=?").get(memory.id).type, "blob");
    const provider = new LocalReasoningSemanticProvider(store.db, embedder, { minScore: .35, maxVectorScan: 100 });
    const shadow = new ReasoningRuntimeShadowService(store.db, runtimeConfig, () => 400);
    const result = await shadow.evaluateWithSemantic({ scope, query: "Please debug the API error before deploying." }, provider, 100);
    assert.deepEqual(result?.context?.items.map(item => item.id), [memory.id]);
    const metrics = new ReasoningRuntimeTelemetryRepository(store.db, () => 400).metrics(scope);
    assert.deepEqual({ scope: metrics.scope, runs: metrics.runs, triggered: metrics.triggered, selected: metrics.selected, semanticCandidates: metrics.semanticCandidates, unmatched: metrics.unmatched, taskTypeExcluded: metrics.taskTypeExcluded, empty: metrics.empty, failures: metrics.failures }, { scope, runs: 1, triggered: 1, selected: 1, semanticCandidates: 1, unmatched: 0, taskTypeExcluded: 0, empty: 0, failures: 0 });
    assert.deepEqual(await provider.search({ scope: "project:other", query: "debug", limit: 5, signal: new AbortController().signal }), []);
    store.db.prepare("INSERT INTO mnemora_reasoning_memory_delivery_circuits(scope,memory_id,circuit_open,reason_code,opened_at,updated_at) VALUES(?,?,1,'harmful_delivery_feedback',?,?)").run(scope, memory.id, 401, 401);
    assert.deepEqual(await provider.search({ scope, query: "debug", limit: 5, signal: new AbortController().signal }), []);
    const nextEmbedder = { async embed(inputs) { return { identity: { provider: "ollama", model: "fixture-next", dimensions: 2 }, vectors: inputs.map(() => [1, 0]) }; } };
    assert.equal((await index.backfill({ scope, embedder: nextEmbedder, maxInputChars: 512, limit: 10, identity: { provider: "ollama", model: "fixture-next" } })).indexed, 1);
    assert.rejects(() => index.backfill({ scope, embedder, maxInputChars: 512, limit: 10, identity: { provider: "ollama", model: "fixture-mismatch" } }), /unexpected_reasoning_embedding_identity/);
  } finally { store.close(); }
});

test("task classification uses normalized English terms rather than raw substrings", () => {
  assert.equal(classifyReasoningTask("Enable rapid mode."), undefined);
  assert.equal(classifyReasoningTask("Debugging an API-integration failure."), "software_debugging");
  assert.equal(classifyReasoningTask("Design an API_integration."), "third_party_integration");
});

test("CJK lexical fallback and inferred runtime applicability do not make untrusted host guesses hard gates", async () => {
  const store = new GraphologyStore(":memory:");
  try {
    const refs = fixture(store), memories = new ReasoningMemoryService(store.db, () => 600);
    const admit = (strategy, applicability) => {
      const input = { scope, kind: "procedure", strategy, applicability, sourceTaskRefs: [refs.taskRef], outcomeRefs: [refs.outcomeRef], evidenceRefs: [refs.eventRef], confidence: .9 };
      const proposed = memories.propose(input, memories.preview(input).preview_hash);
      return memories.admit(proposed.id, scope, memories.admissionPreview(proposed.id, scope).preview_hash);
    };
    const lexical = admit("投资分析前先检查假设、风险与证据。", {});
    const lowRisk = admit("投资任务低风险时先核对数据来源。", { taskTypes: ["investment_analysis"], riskLevels: ["low"] });
    const highRisk = admit("投资任务高风险时先核对数据来源。", { taskTypes: ["investment_analysis"], riskLevels: ["high"] });
    assert.equal(new ReasoningRetrievalService(store.db).find({ scope, query: "请做投资分析" }).candidates.some(item => item.id === lexical.id), true);
    const provider = { id: "fixture", contractVersion: "mnemora-reasoning-semantic-provider/v1", async search() { return [{ memoryId: lowRisk.id, score: .9 }, { memoryId: highRisk.id, score: .8 }]; } };
    const runtime = new ReasoningRuntimeService(store.db), inferred = await runtime.prepareWithSemantic({ scope, query: "请完成投资分析" }, provider);
    assert.deepEqual(inferred.context?.items.slice(0, 2).map(item => item.id), [lowRisk.id, highRisk.id]);
    assert.equal(inferred.context?.items.some(item => item.id === lexical.id), true);
    const explicit = await runtime.prepareWithSemantic({ scope, query: "请完成投资分析", taskType: "investment_analysis", riskLevel: "medium" }, provider);
    assert.equal(explicit.context?.items.some(item => item.id === lowRisk.id || item.id === highRisk.id), false);
    assert.equal(runtime.plan({ scope, query: "删除生产数据库", riskLevel: "low" }).riskLevel, "high");
  } finally { store.close(); }
});

test("legacy task-type aliases are read compatibly and semantic failure falls back to lexical retrieval", async () => {
  const store = new GraphologyStore(":memory:");
  try {
    const refs = fixture(store), memories = new ReasoningMemoryService(store.db, () => 500);
    const input = { scope, kind: "procedure", strategy: "Debug the service logs before changing the integration.", applicability: { taskTypes: ["software_debugging"] }, sourceTaskRefs: [refs.taskRef], outcomeRefs: [refs.outcomeRef], evidenceRefs: [refs.eventRef], confidence: .9 };
    const proposed = memories.propose(input, memories.preview(input).preview_hash), memory = memories.admit(proposed.id, scope, memories.admissionPreview(proposed.id, scope).preview_hash);
    store.db.prepare("UPDATE mnemora_reasoning_memories SET applicability_json=? WHERE id=?").run(JSON.stringify({ taskTypes: ["debugging"], riskLevels: [], environments: [], requiredTools: [] }), memory.id);
    const retrieved = new ReasoningRetrievalService(store.db).find({ scope, query: "debug service", taskType: "software_debugging", semanticScores: { [memory.id]: .9 } });
    assert.equal(retrieved.candidates.length, 1);
    const result = await new ReasoningRuntimeService(store.db).prepareWithSemanticFallback({ scope, query: "debug service", taskType: "debugging" }, { id: "fixture", contractVersion: "mnemora-reasoning-semantic-provider/v1", async search() { throw new Error("offline"); } }, 100, 1);
    assert.deepEqual(result.context?.items.map(item => item.id), [memory.id]);
  } finally { store.close(); }
});
