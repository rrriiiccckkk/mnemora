import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { GraphologyStore } from "../dist/store.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";
import { EpisodeRepository } from "../dist/episodes/repository.js";
import { DecisionMemoryService } from "../dist/cognition/decisions.js";
import { TaskOutcomeService } from "../dist/cognition/outcomes.js";
import { TaskResumeEvaluationRunner, TaskResumeService, createMnemoraContextRef, validateTaskResumeEvaluationDataset } from "../dist/index.js";

const policy = { maxInlineChars: 16_000, maxEventBytes: 262_144, sensitiveContentPolicy: "redact" };
const fixture = JSON.parse(readFileSync("fixtures/task-resume-evaluation-v1.json", "utf8"));

function seedTask(store, scope, id, title, summary, now) {
  const event = new ConversationEventRepository(store.db, policy).append({ scope, sessionId: id, kind: "user_message", role: "user", parts: [{ type: "text", text: summary }], createdAt: now });
  const episode = new EpisodeRepository(store.db).create({ id, scope, kind: "task", title, summary, sourceEventIds: [event.id], importance: .8, confidence: .9, recordedAt: now });
  return { event, episode, taskRef: createMnemoraContextRef({ scope, kind: "episode", id: episode.id }), eventRef: createMnemoraContextRef({ scope, kind: "conversation-event", id: event.id }) };
}

function confirmedDecision(store, now, input) { const service = new DecisionMemoryService(store.db, () => now); return service.confirm(input, service.preview(input).preview_hash); }
function confirmedOutcome(store, now, input) { const service = new TaskOutcomeService(store.db, () => now); return service.confirm(input, service.preview(input).preview_hash); }

test("fixed task-resume evaluation covers 24 offline continuation cases without enabling recall or actions", () => {
  const store = new GraphologyStore(":memory:");
  try {
    let now = 1_700_000_000_000, scope = "project:eval";
    const normal = seedTask(store, scope, "task-resume-eval-normal", "Normal deployment migration", "Normal deployment migration waits for upstream merge.", now++);
    const planA = confirmedDecision(store, now++, { scope, objective: "Normal migration decision", chosenAction: "Use plan A", decisionMaker: "user", evidence: [{ sourceRef: normal.eventRef }], episodeIds: [normal.episode.id] });
    confirmedDecision(store, now++, { scope, objective: "Normal migration decision", chosenAction: "Use plan B", constraints: ["Wait for upstream merge."], decisionMaker: "user", evidence: [{ sourceRef: normal.eventRef, relation: "constraint" }], episodeIds: [normal.episode.id], previousDecisionId: planA.id });
    confirmedOutcome(store, now++, { scope, taskRef: normal.taskRef, verdict: "success", impact: "helpful", summary: "Configuration validation completed.", evidenceRefs: [normal.eventRef] });
    seedTask(store, scope, "task-resume-eval-blue", "Deployment blue migration", "Independent deployment migration blue.", now++);
    seedTask(store, scope, "task-resume-eval-green", "Deployment green migration", "Independent deployment migration green.", now++);
    const forgotten = seedTask(store, scope, "task-resume-eval-forgotten", "Forgotten migration", "Forgotten migration needs fresh evidence.", now++);
    confirmedDecision(store, now++, { scope, objective: "Forgotten decision", chosenAction: "Use retained plan", decisionMaker: "user", evidence: [{ sourceRef: forgotten.eventRef }], episodeIds: [forgotten.episode.id] });
    store.db.prepare("UPDATE mnemora_conversation_events SET deleted_at=? WHERE id=?").run(now++, forgotten.event.id);
    const failure = seedTask(store, scope, "task-resume-eval-failure", "Failed migration", "Failed migration has an accepted attempt record.", now++);
    confirmedOutcome(store, now++, { scope, taskRef: failure.taskRef, verdict: "failure", impact: "harmful", summary: "Migration attempt failed.", evidenceRefs: [failure.eventRef] });
    seedTask(store, scope, "task-resume-eval-empty", "Empty migration", "Empty migration has no accepted current state.", now++);
    seedTask(store, "project:other", "task-resume-eval-beta", "Beta silo deployment", "Beta silo secret stays outside this scope.", now++);
    const before = Number(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_conversation_events").get().value);
    const report = new TaskResumeEvaluationRunner(new TaskResumeService(store.db, () => now)).run(fixture, { caseLimit: 24 });
    assert.deepEqual({ version: report.version, dataset: report.dataset, baseline: report.baseline, metrics: { cases: report.metrics.cases, passed: report.metrics.passed, failed: report.metrics.failed } }, { version: 1, dataset: { id: "task-resume.offline.v1", version: 1 }, baseline: { automaticRecallChanged: false, externalActions: false, maximumItemsPerCase: 8 }, metrics: { cases: 24, passed: 24, failed: 0 } });
    assert.deepEqual(Object.keys(report.metrics.byCategory).sort(), ["ambiguity", "decision_update", "failed_attempt", "forgotten_evidence", "insufficient_memory", "normal_resume", "scope_isolation"]);
    assert.equal(report.results.every(item => item.mismatchCodes.length === 0), true);
    assert.equal(JSON.stringify(report).includes("Beta silo secret"), false);
    assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_conversation_events").get().value), before);
  } finally { store.close(); }
});

test("task-resume evaluation rejects malformed cases before a subject runs", () => {
  assert.throws(() => validateTaskResumeEvaluationDataset({ ...fixture, cases: [{ ...fixture.cases[0], expected: { status: "ready", errorCode: "invalid_task_resume" } }] }), /invalid_task_resume_evaluation_dataset/);
});
