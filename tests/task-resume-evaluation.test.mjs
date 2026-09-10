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
const fixture = JSON.parse(readFileSync("fixtures/task-resume-evaluation-v2.json", "utf8"));
const scope = "project:eval", now = 1_700_000_000_000;

function seedTask(store, id, title = `Evaluation ${id}`) {
  const journal = new ConversationEventRepository(store.db, policy);
  const source = journal.append({ scope, sessionId: `${id}:session-a`, kind: "user_message", role: "user", parts: [{ type: "text", text: title }], createdAt: now });
  const proof = journal.append({ scope, sessionId: `${id}:session-b`, kind: "tool_result", role: "tool", parts: [{ type: "text", text: `${id} deterministic proof` }], createdAt: now + 1 });
  const episode = new EpisodeRepository(store.db).create({ id, scope, kind: "task", title, summary: title, sourceEventIds: [source.id], importance: .8, confidence: .9, recordedAt: now });
  return { episode, taskRef: createMnemoraContextRef({ scope, kind: "episode", id }), sourceRef: createMnemoraContextRef({ scope, kind: "conversation-event", id: source.id }), proof, proofRef: createMnemoraContextRef({ scope, kind: "conversation-event", id: proof.id }) };
}
function decision(store, task, action, extra = {}) { const service = new DecisionMemoryService(store.db, () => now); const input = { scope, objective: action, chosenAction: action, decisionMaker: "user", evidence: [{ sourceRef: task.sourceRef }], episodeIds: [task.episode.id], ...extra }; return service.confirm(input, service.preview(input).preview_hash); }
function outcome(store, task, input) { const service = new TaskOutcomeService(store.db, () => now); const value = { scope, taskRef: task.taskRef, impact: "neutral", evidenceRefs: [task.proofRef], ...input }; return service.confirm(value, service.preview(value).preview_hash); }
function actionRef(decision) { return createMnemoraContextRef({ scope, kind: "decision", id: decision.id }); }

function seedScenario(store, item) {
  if (item.id === "scope-hidden") {
    const journal = new ConversationEventRepository(store.db, policy), event = journal.append({ scope: "project:other", sessionId: "scope:hidden", kind: "user_message", role: "user", parts: [{ type: "text", text: "scopehidden20" }], createdAt: now });
    new EpisodeRepository(store.db).create({ scope: "project:other", kind: "task", title: "scopehidden20", summary: "scopehidden20", sourceEventIds: [event.id], importance: .8, confidence: .9, recordedAt: now });
    return;
  }
  if (item.id === "ambiguous-pair") { seedTask(store, "ambiguous21-a", "ambiguous21 first"); seedTask(store, "ambiguous21-b", "ambiguous21 second"); return; }
  if (item.id === "query-required") return;
  const task = seedTask(store, item.id);
  if (item.id === "normal-plan") decision(store, task, "Normal planned action");
  else if (item.id === "action-complete-next") { const first = decision(store, task, "Action one completed"); decision(store, task, "Action two pending"); outcome(store, task, { actionRef: actionRef(first), actionState: "completed", verdict: "success", summary: "Action one completed" }); }
  else if (item.id === "task-complete") outcome(store, task, { verdict: "success", impact: "helpful", summary: "Whole task completed" });
  else if (item.id === "task-partial") outcome(store, task, { verdict: "partial", summary: "Whole task partially complete" });
  else if (item.id === "action-attempted") { const current = decision(store, task, "Attempted action"); outcome(store, task, { actionRef: actionRef(current), actionState: "attempted", verdict: "unknown", summary: "Action attempt started" }); }
  else if (item.id === "action-failed") { const current = decision(store, task, "Failing action"); outcome(store, task, { actionRef: actionRef(current), actionState: "failed", verdict: "failure", impact: "harmful", summary: "Action failed" }); }
  else if (item.id === "action-corrected") { const current = decision(store, task, "Recoverable action"), failed = outcome(store, task, { actionRef: actionRef(current), actionState: "failed", verdict: "failure", impact: "harmful", summary: "Original failure" }); outcome(store, task, { actionRef: actionRef(current), actionState: "completed", verdict: "success", impact: "helpful", summary: "Action recovered", supersedesId: failed.id }); }
  else if (item.id === "action-cancelled") { const current = decision(store, task, "Cancelled action"); outcome(store, task, { actionRef: actionRef(current), actionState: "cancelled", verdict: "unknown", summary: "Action cancelled" }); }
  else if (item.id === "action-conflict") { const current = decision(store, task, "Conflicted action"); outcome(store, task, { actionRef: actionRef(current), actionState: "partial", verdict: "partial", summary: "Partial record" }); outcome(store, task, { actionRef: actionRef(current), actionState: "failed", verdict: "failure", impact: "harmful", summary: "Failed record" }); }
  else if (item.id === "future-decision") decision(store, task, "Future action", { validFrom: now + 1 });
  else if (item.id === "expired-decision") decision(store, task, "Expired action", { validUntil: now - 1 });
  else if (item.id === "forgotten-action") { const current = decision(store, task, "Forgotten action"); outcome(store, task, { actionRef: actionRef(current), actionState: "completed", verdict: "success", summary: "Forgotten proof" }); store.db.prepare("UPDATE mnemora_conversation_events SET deleted_at=? WHERE id=?").run(now + 2, task.proof.id); }
  else if (item.id === "constraint-only") decision(store, task, "Constraint action", { constraints: ["Observe the release window"] });
  else if (item.id === "epoch-boundary") decision(store, task, "Epoch action", { validFrom: 0, validUntil: now + 1 });
  else if (item.id === "decision-replaced") { const first = decision(store, task, "Obsolete action"); decision(store, task, "Replacement action", { previousDecisionId: first.id }); }
  else if (item.id === "task-failed") outcome(store, task, { verdict: "failure", impact: "harmful", summary: "Whole task failed" });
  else if (item.id === "action-partial") { const current = decision(store, task, "Partial action"); outcome(store, task, { actionRef: actionRef(current), actionState: "partial", verdict: "partial", summary: "Action partly complete" }); }
  else if (item.id === "task-unknown") outcome(store, task, { verdict: "unknown", summary: "Task result pending" });
  else if (item.id === "decision-without-action") { const service = new DecisionMemoryService(store.db, () => now), value = { scope, objective: "Decision without action", decisionMaker: "user", evidence: [{ sourceRef: task.sourceRef }], episodeIds: [task.episode.id] }; service.confirm(value, service.preview(value).preview_hash); }
  else if (item.id === "action-superseded") { const current = decision(store, task, "Superseded action"); outcome(store, task, { actionRef: actionRef(current), actionState: "superseded", verdict: "unknown", summary: "Action superseded" }); }
  else if (item.id === "normal-plan-restart") decision(store, task, "Restart-safe action");
  else if (item.id === "long-state-restart-forget") {
    const obsolete = decision(store, task, "Obsolete long-sequence action");
    const corrected = decision(store, task, "Corrected long-sequence action", { previousDecisionId: obsolete.id });
    const partial = outcome(store, task, { actionRef: actionRef(corrected), actionState: "partial", verdict: "partial", summary: "Long-sequence action partially complete" });
    const failed = outcome(store, task, { actionRef: actionRef(corrected), actionState: "failed", verdict: "failure", impact: "harmful", summary: "Long-sequence action failed safely", supersedesId: partial.id });
    outcome(store, task, { actionRef: actionRef(corrected), actionState: "completed", verdict: "success", impact: "helpful", summary: "Long-sequence action recovered", supersedesId: failed.id });
    const retired = decision(store, task, "Retired long-sequence action");
    outcome(store, task, { actionRef: actionRef(retired), actionState: "cancelled", verdict: "unknown", summary: "Long-sequence action cancelled" });
    for (let index = 0; index < 24; index++) outcome(store, task, { verdict: "partial", summary: `Long-sequence retained record ${index + 1}.`, evidenceRefs: [task.sourceRef] });
    store.db.prepare("UPDATE mnemora_conversation_events SET deleted_at=? WHERE id=?").run(now + 2, task.proof.id);
  }
}

test("fixed task-resume evaluation covers 26 independent offline multi-session continuation sequences", () => {
  const store = new GraphologyStore(":memory:");
  try {
    for (const item of fixture.cases) seedScenario(store, item);
    const before = Number(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_conversation_events").get().value);
    const report = new TaskResumeEvaluationRunner(new TaskResumeService(store.db, () => now)).run(fixture, { caseLimit: 26 });
    assert.deepEqual({ version: report.version, dataset: report.dataset, baseline: report.baseline, metrics: { cases: report.metrics.cases, passed: report.metrics.passed, failed: report.metrics.failed } }, { version: 2, dataset: { id: "task-resume.offline.v2", version: 2 }, baseline: { automaticRecallChanged: false, externalActions: false, maximumItemsPerCase: 8 }, metrics: { cases: 26, passed: 26, failed: 0 } });
    assert.deepEqual(Object.keys(report.metrics.byCategory).sort(), ["action_cancellation", "action_conflict", "action_correction", "action_progress", "ambiguity", "constraints", "expired_decision", "failed_attempt", "forgotten_evidence", "future_decision", "insufficient_memory", "lifecycle_boundary", "long_sequence", "normal_resume", "scope_isolation"]);
    assert.equal(report.results.every(item => item.mismatchCodes.length === 0), true);
    assert.equal(JSON.stringify(report).includes("other scope"), false);
    assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_conversation_events").get().value), before);
  } finally { store.close(); }
});

test("task-resume evaluation rejects malformed independent sequence contracts before a subject runs", () => {
  assert.throws(() => validateTaskResumeEvaluationDataset({ ...fixture, cases: [{ ...fixture.cases[0], sequence: { ...fixture.cases[0].sequence, history: ["only_one"] } }] }), /invalid_task_resume_evaluation_dataset/);
});
