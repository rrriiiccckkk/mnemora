import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReasoningIntakeService } from "../dist/cognition/reasoning-intake.js";
import { ReasoningCurationService } from "../dist/cognition/reasoning-curation.js";
import { DecisionMemoryService } from "../dist/cognition/decisions.js";
import { TaskOutcomeService } from "../dist/cognition/outcomes.js";
import { EpisodeRepository } from "../dist/episodes/repository.js";
import { TaskResumeService } from "../dist/task-resume/service.js";
import { createMnemoraContextRef } from "../dist/context/context-ref.js";
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

test("an explicitly selected task episode makes a reviewed outcome visible in task resume", async () => {
  const store = new GraphologyStore(":memory:");
  try {
    const turn = { sessionId: "session:alpha", userText: "The migration completed after rollback validation.", assistantText: "Recorded the completed migration." };
    const source = receipt(store, turn.userText, turn.assistantText, "linked-outcome");
    const episode = new EpisodeRepository(store.db).create({ scope: "project:alpha", kind: "task", title: "Migration", summary: "Complete the migration.", sourceEventIds: source.events.map(event => event.id), importance: .8, confidence: .9 });
    const taskRef = createMnemoraContextRef({ scope: "project:alpha", kind: "episode", id: episode.id });
    const intake = new ReasoningIntakeService(store.db);
    await intake.capture({ scope: "project:alpha", receipt: source, turn, runtime: runtime({ candidates: [{ kind: "task_outcome", taskSummary: "Migration", verdict: "success", impact: "helpful", summary: "Migration completed after rollback validation.", confidence: .9 }] }), config });
    const candidate = intake.list("project:alpha")[0];
    assert.equal(intake.confirmationPreview(candidate.id, candidate.scope).effect.preview.outcome.taskRef, candidate.taskRef);
    const preview = intake.confirmationPreview(candidate.id, candidate.scope, taskRef);
    assert.equal(preview.status, "preview");
    assert.equal(preview.selected_task_ref, taskRef);
    assert.equal(preview.effect.preview.outcome.taskRef, taskRef);
    assert.equal(new TaskResumeService(store.db).resume({ scope: "project:alpha", taskRef }).status, "needs_reconfirmation");
    assert.equal(intake.confirm(candidate.id, candidate.scope, preview.preview_hash).status, "stale_preview");
    intake.confirm(candidate.id, candidate.scope, preview.preview_hash, taskRef);
    const resumed = new TaskResumeService(store.db).resume({ scope: "project:alpha", taskRef });
    assert.equal(resumed.status, "ready");
    assert.deepEqual(resumed.completed.map(item => item.text), ["Migration completed after rollback validation."]);
  } finally { store.close(); }
});

test("an explicitly selected task episode links a reviewed decision without promoting the pending candidate", async () => {
  const store = new GraphologyStore(":memory:");
  try {
    const turn = { sessionId: "session:alpha", userText: "We decided to validate rollback before migration.", assistantText: "I recorded that plan." };
    const source = receipt(store, turn.userText, turn.assistantText, "linked-decision");
    const episode = new EpisodeRepository(store.db).create({ scope: "project:alpha", kind: "task", title: "Migration", summary: "Prepare the migration.", sourceEventIds: source.events.map(event => event.id), importance: .8, confidence: .9 });
    const taskRef = createMnemoraContextRef({ scope: "project:alpha", kind: "episode", id: episode.id });
    const intake = new ReasoningIntakeService(store.db);
    await intake.capture({ scope: "project:alpha", receipt: source, turn, runtime: runtime({ candidates: [{ kind: "decision", objective: "Prepare migration", chosenAction: "Validate rollback", constraints: [], confidence: .9 }] }), config });
    const candidate = intake.list("project:alpha")[0];
    assert.equal(intake.confirmationPreview(candidate.id, candidate.scope).effect.preview.decision.episode_count, 0);
    const preview = intake.confirmationPreview(candidate.id, candidate.scope, taskRef);
    assert.equal(preview.status, "preview");
    assert.equal(preview.selected_task_ref, taskRef);
    assert.equal(preview.effect.preview.decision.episode_count, 1);
    assert.equal(new TaskResumeService(store.db).resume({ scope: "project:alpha", taskRef }).status, "needs_reconfirmation");
    const confirmed = intake.confirm(candidate.id, candidate.scope, preview.preview_hash, taskRef);
    assert.deepEqual(confirmed.decision.episodeIds, [episode.id]);
    const resumed = new TaskResumeService(store.db).resume({ scope: "project:alpha", taskRef });
    assert.equal(resumed.status, "ready");
    assert.deepEqual(resumed.next_steps.map(item => item.text), ["Validate rollback"]);
  } finally { store.close(); }
});

test("multiple matching task episodes keep a reviewed outcome on its event anchor", async () => {
  const store = new GraphologyStore(":memory:");
  try {
    const turn = { sessionId: "session:alpha", userText: "The migration completed.", assistantText: "Recorded." };
    const source = receipt(store, turn.userText, turn.assistantText, "ambiguous-task");
    const episodes = new EpisodeRepository(store.db);
    const first = episodes.create({ scope: "project:alpha", kind: "task", title: "Migration A", summary: "Complete migration A.", sourceEventIds: [source.events[0].id], importance: .8, confidence: .9 });
    const second = episodes.create({ scope: "project:alpha", kind: "task", title: "Migration B", summary: "Complete migration B.", sourceEventIds: [source.events[0].id], importance: .8, confidence: .9 });
    const intake = new ReasoningIntakeService(store.db);
    await intake.capture({ scope: "project:alpha", receipt: source, turn, runtime: runtime({ candidates: [{ kind: "task_outcome", taskSummary: "Migration", verdict: "success", impact: "helpful", summary: "Migration completed.", confidence: .9 }] }), config });
    const candidate = intake.list("project:alpha")[0], preview = intake.confirmationPreview(candidate.id, candidate.scope);
    assert.equal(preview.status, "preview");
    assert.equal(preview.effect.preview.outcome.taskRef, candidate.taskRef);
    assert.match(intake.confirm(candidate.id, candidate.scope, preview.preview_hash).outcome.taskRef, /conversation-event/);
    for (const episode of [first, second]) {
      const taskRef = createMnemoraContextRef({ scope: "project:alpha", kind: "episode", id: episode.id });
      assert.equal(new TaskResumeService(store.db).resume({ scope: "project:alpha", taskRef }).status, "needs_reconfirmation");
    }
  } finally { store.close(); }
});

test("intake cannot bind a reviewed candidate to a cross-scope or non-task episode", async () => {
  const store = new GraphologyStore(":memory:");
  try {
    const turn = { sessionId: "session:alpha", userText: "The migration completed.", assistantText: "Recorded." };
    const source = receipt(store, turn.userText, turn.assistantText, "wrong-task");
    const episodes = new EpisodeRepository(store.db);
    const interaction = episodes.create({ scope: "project:alpha", kind: "interaction", summary: "Migration discussion.", sourceEventIds: [source.events[0].id], importance: .8, confidence: .9 });
    const inactive = episodes.create({ scope: "project:alpha", kind: "task", summary: "Archived migration task.", sourceEventIds: [source.events[0].id], importance: .8, confidence: .9 });
    episodes.transition(inactive.id, "project:alpha", "archived");
    const intake = new ReasoningIntakeService(store.db);
    await intake.capture({ scope: "project:alpha", receipt: source, turn, runtime: runtime({ candidates: [{ kind: "task_outcome", taskSummary: "Migration", verdict: "success", impact: "helpful", summary: "Migration completed.", confidence: .9 }] }), config });
    const candidate = intake.list("project:alpha")[0];
    const wrongKindRef = createMnemoraContextRef({ scope: "project:alpha", kind: "episode", id: interaction.id });
    const wrongScopeRef = createMnemoraContextRef({ scope: "project:beta", kind: "episode", id: interaction.id });
    const inactiveRef = createMnemoraContextRef({ scope: "project:alpha", kind: "episode", id: inactive.id });
    const missingRef = createMnemoraContextRef({ scope: "project:alpha", kind: "episode", id: "missing-task" });
    assert.throws(() => intake.confirmationPreview(candidate.id, candidate.scope, wrongKindRef), /invalid_reasoning_intake_task/);
    assert.throws(() => intake.confirmationPreview(candidate.id, candidate.scope, wrongScopeRef));
    assert.throws(() => intake.confirmationPreview(candidate.id, candidate.scope, inactiveRef), /invalid_reasoning_intake_task/);
    assert.throws(() => intake.confirmationPreview(candidate.id, candidate.scope, missingRef), /invalid_reasoning_intake_task/);
    assert.equal(intake.get(candidate.id, candidate.scope).status, "pending_review");
  } finally { store.close(); }
});

test("CLI intake confirmation binds the previewed task reference", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-intake-task-cli-")), path = join(directory, "memory.db");
  let store;
  try {
    store = new GraphologyStore(path);
    const turn = { sessionId: "session:alpha", userText: "The migration completed.", assistantText: "Recorded." };
    const source = receipt(store, turn.userText, turn.assistantText, "cli-task");
    const episode = new EpisodeRepository(store.db).create({ scope: "project:alpha", kind: "task", title: "Migration", summary: "Complete migration.", sourceEventIds: source.events.map(event => event.id), importance: .8, confidence: .9 });
    const taskRef = createMnemoraContextRef({ scope: "project:alpha", kind: "episode", id: episode.id });
    const intake = new ReasoningIntakeService(store.db);
    await intake.capture({ scope: "project:alpha", receipt: source, turn, runtime: runtime({ candidates: [{ kind: "task_outcome", taskSummary: "Migration", verdict: "success", impact: "helpful", summary: "Migration completed.", confidence: .9 }] }), config });
    const candidate = intake.list("project:alpha")[0];
    store.close(); store = undefined;
    const invoke = (...args) => {
      const result = spawnSync(process.execPath, ["dist/cli.js", "cognition", "reasoning", "intake", "confirm", candidate.id, "--scope", "project:alpha", "--task-ref", taskRef, ...args], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, MNEMORA_DB: path } });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout).result;
    };
    const preview = invoke();
    assert.equal(preview.selected_task_ref, taskRef);
    assert.equal(preview.effect.preview.outcome.taskRef, taskRef);
    assert.equal(invoke("--preview-hash", preview.preview_hash, "--confirm").status, "confirmed");
    store = new GraphologyStore(path);
    assert.equal(new TaskResumeService(store.db).resume({ scope: "project:alpha", taskRef }).status, "ready");
  } finally { try { store?.close(); } catch {} try { rmSync(directory, { recursive: true, force: true }); } catch {} }
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
    assert.equal(SUPPORTED_SCHEMA_VERSION, 83);
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
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='mnemora_reasoning_intake_candidates'").get().value, 1);
    assert.equal(new DecisionMemoryService(store.db).get(decision.id, "project:alpha").id, decision.id);
  } finally { try { store?.close(); } catch {} try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});
