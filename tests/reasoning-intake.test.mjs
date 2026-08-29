import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ReasoningIntakeService } from "../dist/cognition/reasoning-intake.js";
import { ReasoningCurationService } from "../dist/cognition/reasoning-curation.js";
import { DecisionMemoryService } from "../dist/cognition/decisions.js";
import { TaskOutcomeService } from "../dist/cognition/outcomes.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";
import { GraphologyStore } from "../dist/store.js";
import { SUPPORTED_SCHEMA_VERSION } from "../dist/schema.js";
import { PluginRuntime } from "../dist/plugin-runtime.js";

const policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" };
const config = { enabled: true, maxCandidatesPerTurn: 2, timeoutMs: 1000, maxInputChars: 8000, maxOutputChars: 2000 };
const formation = { enabled: true, maxJobsPerTurn: 1, minOutcomeConfidence: .75, timeoutMs: 1000, maxInputChars: 8000, maxOutputChars: 2000 };

function receipt(store, userText, assistantText, suffix = "one") {
  return new ConversationEventRepository(store.db, policy).captureTurn({
    scope: "project:alpha",
    sessionId: "session:alpha",
    hostCorrelation: `reasoning-intake:${suffix}`,
    events: [
      { scope: "project:alpha", sessionId: "session:alpha", kind: "user_message", role: "user", parts: [{ type: "text", text: userText }] },
      { scope: "project:alpha", sessionId: "session:alpha", kind: "assistant_message", role: "assistant", parentEventOrdinal: 0, parts: [{ type: "text", text: assistantText }] }
    ]
  });
}

function runtime(...values) {
  const requests = [];
  return {
    requests,
    async complete(input) {
      requests.push(input);
      const value = values.shift();
      if (value instanceof Error) throw value;
      return { text: typeof value === "string" ? value : JSON.stringify(value) };
    }
  };
}

test("turn intake creates only source-linked candidates until an operator confirms them", async () => {
  let now = 100; const store = new GraphologyStore(":memory:");
  try {
    const turn = { sessionId: "session:alpha", userText: "We decided to use SQLite for this migration.", assistantText: "I will use SQLite and record the migration plan." };
    const source = receipt(store, turn.userText, turn.assistantText);
    const model = runtime({ candidates: [{ kind: "decision", objective: "Choose a migration store", chosenAction: "Use SQLite", rationale: "The user explicitly selected SQLite.", constraints: ["Keep the migration local"], confidence: .8 }] });
    const service = new ReasoningIntakeService(store.db, () => ++now);
    assert.deepEqual(await service.capture({ scope: "project:alpha", receipt: source, turn, runtime: model, config }), { status: "succeeded", proposed: 1, skipped: 0 });
    assert.equal(model.requests.length, 1);
    assert.match(model.requests[0].messages[0].content, /<MNEMORA_UNTRUSTED_INTAKE_SOURCE>/);
    assert.equal(new DecisionMemoryService(store.db).list("project:alpha").length, 0);
    assert.equal(new TaskOutcomeService(store.db).list("project:alpha").length, 0);
    const candidate = service.list("project:alpha")[0], preview = service.confirmationPreview(candidate.id, candidate.scope);
    assert.equal(candidate.status, "pending_review");
    assert.equal(preview.status, "preview");
    assert.equal(service.confirm(candidate.id, candidate.scope, "wrong").status, "stale_preview");
    const confirmed = service.confirm(candidate.id, candidate.scope, preview.preview_hash);
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.decision.decisionMaker, "assistant");
    assert.equal(confirmed.decision.evidence.length, 2);
    assert.equal(service.list("project:alpha")[0].status, "confirmed");
  } finally { store.close(); }
});

test("confirmed outcome candidates use the original user event as a task anchor and feed existing curation", async () => {
  let now = 1000; const store = new GraphologyStore(":memory:");
  try {
    const turn = { sessionId: "session:alpha", userText: "The migration succeeded after we validated rollback.", assistantText: "Great, the migration is complete." };
    const source = receipt(store, turn.userText, turn.assistantText, "two");
    const intake = new ReasoningIntakeService(store.db, () => ++now);
    await intake.capture({ scope: "project:alpha", receipt: source, turn, runtime: runtime({ candidates: [{ kind: "task_outcome", taskSummary: "Run the migration", verdict: "success", impact: "helpful", summary: "Rollback validation preceded a successful migration.", confidence: .9 }] }), config });
    const candidate = intake.list("project:alpha")[0], preview = intake.confirmationPreview(candidate.id, candidate.scope);
    assert.equal(preview.status, "preview");
    const confirmed = intake.confirm(candidate.id, candidate.scope, preview.preview_hash);
    assert.equal(confirmed.status, "confirmed");
    assert.match(confirmed.outcome.taskRef, /conversation-event/);
    const curation = new ReasoningCurationService(store.db, () => ++now);
    const formationRuntime = runtime({ candidate: { kind: "procedure", strategy: "Validate rollback before a production migration.", applicability: { taskTypes: ["database_migration"] }, rationale: "The confirmed result supports the reusable guard." } });
    assert.deepEqual(await curation.runFormation({ scope: "project:alpha", runtime: formationRuntime, config: formation }), { attempted: 1, proposed: 1, skipped: 0, failed: 0 });
    assert.equal(curation.formationProposals("project:alpha")[0].status, "pending_review");
  } finally { store.close(); }
});

test("assistant-only completion claims cannot enqueue an outcome candidate", async () => {
  const store = new GraphologyStore(":memory:");
  try {
    const turn = { sessionId: "session:alpha", userText: "Please run the migration.", assistantText: "The migration succeeded." };
    const source = receipt(store, turn.userText, turn.assistantText, "three"), service = new ReasoningIntakeService(store.db);
    const result = await service.capture({ scope: "project:alpha", receipt: source, turn, runtime: runtime({ candidates: [{ kind: "task_outcome", taskSummary: "Run migration", verdict: "success", impact: "helpful", summary: "The assistant says it succeeded.", confidence: .9 }] }), config });
    assert.deepEqual(result, { status: "succeeded", proposed: 0, skipped: 0 });
    assert.equal(service.list("project:alpha").length, 0);
  } finally { store.close(); }
});

test("invalid intake output cannot create candidates and schema v69 is additive", async () => {
  const store = new GraphologyStore(":memory:");
  try {
    assert.equal(SUPPORTED_SCHEMA_VERSION, 69);
    const turn = { sessionId: "session:alpha", userText: "We decided to use SQLite.", assistantText: "Noted." }, source = receipt(store, turn.userText, turn.assistantText, "four"), service = new ReasoningIntakeService(store.db);
    const result = await service.capture({ scope: "project:alpha", receipt: source, turn, runtime: runtime("not json"), config });
    assert.deepEqual(result, { status: "failed", category: "invalid_model_response" });
    assert.equal(service.list("project:alpha").length, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='mnemora_reasoning_intake_candidates'").get().value, 1);
  } finally { store.close(); }
});

test("the completed-turn lifecycle keeps intake off by default and only runs it after explicit opt-in", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-reasoning-intake-runtime-")), path = join(directory, "memory.db");
  const turn = { sessionId: "session:alpha", userText: "We decided to use SQLite.", assistantText: "Noted." };
  const disabled = new PluginRuntime({ dbPath: path }, { debug() {}, info() {}, warn() {} });
  try {
    const graph = disabled.openGraph(); let source;
    try { source = receipt(graph.store, turn.userText, turn.assistantText, "five"); } finally { graph.close(); }
    const model = runtime({ candidates: [{ kind: "decision", objective: "Choose a store", chosenAction: "Use SQLite", constraints: [], confidence: .8 }] });
    await disabled.processCompletedTurn({ ...turn, runtimeLlm: model }, source);
    assert.equal(model.requests.length, 0);
  } finally { disabled.stop(); }
  const enabled = new PluginRuntime({ dbPath: path, cognition: { reasoningCuration: { intake: { enabled: true } } } }, { debug() {}, info() {}, warn() {} });
  try {
    const graph = enabled.openGraph(); let source;
    try { source = receipt(graph.store, turn.userText, turn.assistantText, "six"); } finally { graph.close(); }
    const model = runtime({ candidates: [{ kind: "decision", objective: "Choose a store", chosenAction: "Use SQLite", constraints: [], confidence: .8 }] });
    await enabled.processCompletedTurn({ ...turn, runtimeLlm: model }, source);
    const verify = enabled.openGraph();
    try {
      assert.equal(model.requests.length, 1);
      assert.equal(new ReasoningIntakeService(verify.store.db).list("project:alpha").length, 1);
    } finally { verify.close(); }
  } finally { enabled.stop(); try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("v69 intake migration restores only the new candidate table and preserves prior records", () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-v69-")), path = join(directory, "memory.db"); let store;
  try {
    store = new GraphologyStore(path);
    const source = new ConversationEventRepository(store.db, policy).append({ scope: "project:alpha", sessionId: "s", kind: "user_message", role: "user", parts: [{ type: "text", text: "Use SQLite." }] });
    const sourceRef = `mnemora://v1/scope/project%3Aalpha/conversation-event/${source.id}`;
    const decisions = new DecisionMemoryService(store.db);
    const input = { scope: "project:alpha", objective: "Choose a store", chosenAction: "Use SQLite", decisionMaker: "assistant", evidence: [{ sourceRef }] };
    const decision = decisions.confirm(input, decisions.preview(input).preview_hash);
    store.db.exec("DROP TABLE mnemora_reasoning_intake_candidates; PRAGMA user_version=68");
    store.close(); store = new GraphologyStore(path);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 69);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='mnemora_reasoning_intake_candidates'").get().value, 1);
    assert.equal(new DecisionMemoryService(store.db).get(decision.id, "project:alpha").id, decision.id);
  } finally { try { store?.close(); } catch {} try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});
