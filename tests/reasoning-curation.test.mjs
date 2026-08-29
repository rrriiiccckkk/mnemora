import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createMnemoraContextRef } from "../dist/context/context-ref.js";
import { ReasoningCurationService } from "../dist/cognition/reasoning-curation.js";
import { ReasoningMemoryService } from "../dist/cognition/reasoning.js";
import { TaskOutcomeService } from "../dist/cognition/outcomes.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";
import { EpisodeRepository } from "../dist/episodes/repository.js";
import { GraphologyStore } from "../dist/store.js";
import { SUPPORTED_SCHEMA_VERSION } from "../dist/schema.js";
import { PluginRuntime } from "../dist/plugin-runtime.js";

const policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" };
const formationConfig = { enabled: true, maxJobsPerTurn: 1, minOutcomeConfidence: .75, timeoutMs: 1000, maxInputChars: 8000, maxOutputChars: 2000 };
const reviewConfig = { enabled: true, intervalHours: 24, maxItems: 12, timeoutMs: 1000, maxInputChars: 12000, maxOutputChars: 4000 };

function fixture(store, scope = "project:ops", now = () => 100) {
  const event = new ConversationEventRepository(store.db, policy).append({ scope, sessionId: "s", kind: "user_message", role: "user", parts: [{ type: "text", text: "The deployment failed because rollback validation was skipped." }] });
  const task = new EpisodeRepository(store.db).create({ scope, kind: "task", title: "Deploy migration", summary: "Deploy a production migration safely", sourceEventIds: [event.id], importance: .9, confidence: .9 });
  const eventRef = createMnemoraContextRef({ scope, kind: "conversation-event", id: event.id });
  const taskRef = createMnemoraContextRef({ scope, kind: "episode", id: task.id });
  const outcomes = new TaskOutcomeService(store.db, now);
  const input = { scope, taskRef, verdict: "failure", impact: "harmful", confidence: .9, summary: "Rollback validation was skipped.", evidenceRefs: [eventRef] };
  const outcome = outcomes.confirm(input, outcomes.preview(input).preview_hash);
  return { scope, eventRef, taskRef, outcomeRef: createMnemoraContextRef({ scope, kind: "task-outcome", id: outcome.id }) };
}

function runtime(...responses) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async complete() {
      calls++;
      const value = responses.shift();
      if (value instanceof Error) throw value;
      return { text: typeof value === "string" ? value : JSON.stringify(value) };
    }
  };
}

test("automatic reasoning curation creates only source-linked proposals and promotion still requires explicit admission", async () => {
  let now = 1000; const store = new GraphologyStore(":memory:");
  try {
    const refs = fixture(store, "project:ops", () => ++now);
    const model = runtime({ candidate: { kind: "failure_guard", strategy: "Validate rollback and a recovery plan before a production migration.", applicability: { taskTypes: ["database_migration"], riskLevels: ["high"] }, rationale: "The confirmed failure identifies a reusable missing guard." } });
    const curation = new ReasoningCurationService(store.db, () => ++now);
    assert.deepEqual(await curation.runFormation({ scope: refs.scope, runtime: model, config: formationConfig }), { attempted: 1, proposed: 1, skipped: 0, failed: 0 });
    assert.equal(model.calls, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_reasoning_memories").get().value, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_beliefs").get().value, 0);
    const proposal = curation.formationProposals(refs.scope)[0];
    assert.deepEqual({ status: proposal.status, source: proposal.evidenceRefs, outcome: proposal.outcomeRef === refs.outcomeRef }, { status: "pending_review", source: [refs.eventRef], outcome: true });
    assert.deepEqual(await curation.runFormation({ scope: refs.scope, runtime: model, config: formationConfig }), { attempted: 0, proposed: 0, skipped: 0, failed: 0 });
    const promotion = curation.promotionPreview(proposal.id, refs.scope);
    assert.equal(promotion.status, "preview");
    const promoted = curation.promote(proposal.id, refs.scope, promotion.preview_hash);
    assert.deepEqual({ status: promoted.status, proposal: promoted.proposal.status, memory: promoted.memory.state }, { status: "confirmed", proposal: "promoted", memory: "proposed" });
    assert.equal(new ReasoningMemoryService(store.db).find(refs.scope, "rollback").length, 0);
  } finally { store.close(); }
});

test("periodic LLM review remains advisory until an operator resolves it, then retires rather than deletes", async () => {
  let now = 2000; const store = new GraphologyStore(":memory:");
  try {
    const refs = fixture(store, "project:ops", () => ++now), reasoning = new ReasoningMemoryService(store.db, () => ++now);
    const input = { scope: refs.scope, kind: "strategy", strategy: "Validate rollback before production migration.", sourceTaskRefs: [refs.taskRef], outcomeRefs: [refs.outcomeRef], evidenceRefs: [refs.eventRef] };
    const memory = reasoning.propose(input, reasoning.preview(input).preview_hash);
    reasoning.admit(memory.id, refs.scope, reasoning.admissionPreview(memory.id, refs.scope).preview_hash);
    const model = runtime({ reviews: [{ memoryId: memory.id, recommendation: "retire", rationale: "The operator should reassess this strategy after the harmful outcome." }] });
    const curation = new ReasoningCurationService(store.db, () => ++now);
    const first = await curation.runReview({ scope: refs.scope, runtime: model, config: reviewConfig });
    assert.deepEqual({ attempted: first.attempted, proposed: first.proposed, state: reasoning.get(memory.id, refs.scope).state }, { attempted: true, proposed: 1, state: "admitted" });
    assert.equal((await curation.runReview({ scope: refs.scope, runtime: model, config: reviewConfig })).attempted, false);
    const review = curation.reviewProposals(refs.scope)[0], preview = curation.reviewResolutionPreview(review.id, refs.scope, "retire");
    assert.equal(preview.status, "preview");
    const resolved = curation.resolveReview(review.id, refs.scope, "retire", preview.preview_hash);
    assert.deepEqual({ status: resolved.status, review: resolved.proposal.status, memory: resolved.memory.state }, { status: "confirmed", review: "retired", memory: "retired" });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_reasoning_memories WHERE id=?").get(memory.id).value, 1);
  } finally { store.close(); }
});

test("invalid model output is bounded, retryable, and cannot create a proposal", async () => {
  const store = new GraphologyStore(":memory:");
  try {
    const refs = fixture(store), curation = new ReasoningCurationService(store.db, () => 3000);
    const result = await curation.runFormation({ scope: refs.scope, runtime: runtime("not json"), config: formationConfig });
    assert.deepEqual(result, { attempted: 1, proposed: 0, skipped: 0, failed: 1 });
    assert.equal(curation.formationProposals(refs.scope).length, 0);
    assert.deepEqual(curation.runs(refs.scope)[0].errorCategory, "invalid_model_response");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_reasoning_memories").get().value, 0);
  } finally { store.close(); }
});

test("the completed-turn lifecycle runs opt-in curation only after durable capture with a public host runtime", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-curation-runtime-")), path = join(directory, "memory.db");
  const runtimePlugin = new PluginRuntime({ dbPath: path, cognition: { reasoningCuration: { formation: { enabled: true } } } }, { debug() {}, info() {}, warn() {} });
  try {
    const graph = runtimePlugin.openGraph();
    try { fixture(graph.store, "default"); } finally { graph.close(); }
    const model = runtime({ candidate: { kind: "failure_guard", strategy: "Validate rollback before a production migration.", applicability: {}, rationale: "A confirmed harmful result identified a missing guard." } });
    await runtimePlugin.processCompletedTurn({ sessionId: "s", userText: "deploy", assistantText: "done", runtimeLlm: model }, { inserted: true, commitId: "commit:curation" });
    const verify = runtimePlugin.openGraph();
    try {
      assert.equal(model.calls, 1);
      assert.equal(new ReasoningCurationService(verify.store.db).formationProposals("default").length, 1);
      assert.equal(verify.store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_reasoning_memories").get().value, 0);
    } finally { verify.close(); }
  } finally { runtimePlugin.stop(); try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("schema v68 adds isolated curation tables without changing existing reasoning records", () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-v68-")), path = join(directory, "memory.db"); let store;
  try {
    store = new GraphologyStore(path);
    const refs = fixture(store), reasoning = new ReasoningMemoryService(store.db);
    const input = { scope: refs.scope, kind: "strategy", strategy: "Validate rollback before production migration.", sourceTaskRefs: [refs.taskRef], outcomeRefs: [refs.outcomeRef], evidenceRefs: [refs.eventRef] };
    const memory = reasoning.propose(input, reasoning.preview(input).preview_hash);
    store.db.exec("DROP TABLE mnemora_reasoning_review_proposals; DROP TABLE mnemora_reasoning_formation_proposals; DROP TABLE mnemora_reasoning_curation_runs; PRAGMA user_version=67");
    store.close(); store = new GraphologyStore(path);
    assert.equal(SUPPORTED_SCHEMA_VERSION, 70);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 70);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_reasoning_memories WHERE id=?").get(memory.id).value, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='mnemora_reasoning_curation_runs'").get().value, 1);
  } finally { try { store?.close(); } catch {} try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});
