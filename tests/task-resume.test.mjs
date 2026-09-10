import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphologyStore } from "../dist/store.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";
import { EpisodeRepository } from "../dist/episodes/repository.js";
import { DecisionMemoryService } from "../dist/cognition/decisions.js";
import { TaskOutcomeService } from "../dist/cognition/outcomes.js";
import { TaskResumeService } from "../dist/task-resume/service.js";
import { createMnemoraContextRef } from "../dist/context/context-ref.js";
import { MemoryImpactService } from "../dist/correction/impact-service.js";
import { Mnemora, createInspectorApplication } from "../dist/index.js";

const policy = { maxInlineChars: 16_000, maxEventBytes: 262_144, sensitiveContentPolicy: "redact" };

function task(store, scope, title, summary, now) {
  const event = new ConversationEventRepository(store.db, policy).append({ scope, sessionId: `session:${title}`, kind: "user_message", role: "user", parts: [{ type: "text", text: `${title}: ${summary}` }], createdAt: now });
  const episode = new EpisodeRepository(store.db).create({ scope, kind: "task", title, summary, sourceEventIds: [event.id], importance: .8, confidence: .9, recordedAt: now });
  return { event, episode, taskRef: createMnemoraContextRef({ scope, kind: "episode", id: episode.id }), eventRef: createMnemoraContextRef({ scope, kind: "conversation-event", id: event.id }) };
}

function decision(store, now, input) {
  const service = new DecisionMemoryService(store.db, () => now);
  return service.confirm(input, service.preview(input).preview_hash);
}

function outcome(store, now, input) {
  const service = new TaskOutcomeService(store.db, () => now);
  return service.confirm(input, service.preview(input).preview_hash);
}

test("task resume survives a restart with source-linked current decisions and accepted progress", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-task-resume-")), dbPath = join(directory, "memory.db");
  let store;
  try {
    let now = 1_700_000_000_000;
    store = new GraphologyStore(dbPath);
    const migration = task(store, "project:alpha", "Production deployment migration", "Move the deployment once the upstream merge lands.", now++);
    const planA = decision(store, now++, { scope: "project:alpha", objective: "Choose deployment migration plan", chosenAction: "Use plan A", decisionMaker: "user", evidence: [{ sourceRef: migration.eventRef }], episodeIds: [migration.episode.id] });
    const planB = decision(store, now++, { scope: "project:alpha", objective: "Choose deployment migration plan", chosenAction: "Use plan B", constraints: ["Wait for the upstream merge before executing migration."], decisionMaker: "user", evidence: [{ sourceRef: migration.eventRef, relation: "constraint" }], episodeIds: [migration.episode.id], previousDecisionId: planA.id });
    outcome(store, now++, { scope: "project:alpha", taskRef: migration.taskRef, verdict: "success", impact: "helpful", summary: "Configuration validation completed.", evidenceRefs: [migration.eventRef] });
    outcome(store, now++, { scope: "project:alpha", taskRef: migration.taskRef, verdict: "partial", impact: "neutral", summary: "Migration has not executed; await the upstream merge.", evidenceRefs: [migration.eventRef] });
    const before = Number(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_task_outcomes").get().value);
    const first = new TaskResumeService(store.db, () => now).resume({ scope: "project:alpha", query: "deployment migration" });
    assert.equal(first.status, "ready");
    assert.equal(first.task.task_ref, migration.taskRef);
    assert.deepEqual(first.decisions.map(item => item.text), ["Use plan B"]);
    assert.deepEqual(first.completed.map(item => item.text), ["Configuration validation completed."]);
    assert.deepEqual(first.pending.map(item => item.text), ["Migration has not executed; await the upstream merge."]);
    assert.deepEqual(first.blockers, []);
    assert.deepEqual(first.constraints.map(item => item.text), ["Wait for the upstream merge before executing migration."]);
    assert.equal(first.completed.concat(first.pending, first.blockers, first.constraints, first.decisions).every(item => item.source_refs.every(ref => ref.startsWith("mnemora://v1/scope/project%3Aalpha/"))), true);
    assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_task_outcomes").get().value), before);
    store.close();
    store = new GraphologyStore(dbPath);
    const restarted = new TaskResumeService(store.db, () => now).resume({ scope: "project:alpha", taskRef: migration.taskRef });
    assert.equal(restarted.status, "ready");
    assert.deepEqual(restarted.decisions.map(item => item.text), ["Use plan B"]);
    assert.deepEqual(restarted.completed.map(item => item.text), ["Configuration validation completed."]);
  } finally { try { store?.close(); } catch {} try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("task resume keeps task selection and references within the caller scope", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const alphaOne = task(store, "project:alpha", "Deployment migration", "Move the primary deployment.", 10);
    task(store, "project:alpha", "Deployment rollback", "Prepare an independent rollback procedure.", 11);
    const beta = task(store, "project:beta", "Deployment migration secret", "Do not expose this other-scope work.", 12);
    const result = new TaskResumeService(store.db).resume({ scope: "project:alpha", query: "deployment" });
    assert.equal(result.status, "ambiguous");
    assert.equal(result.candidates.some(candidate => candidate.title.includes("secret") || candidate.source_refs.some(ref => ref.includes("project%3Abeta"))), false);
    assert.throws(() => new TaskResumeService(store.db).resume({ scope: "project:alpha", taskRef: beta.taskRef }), /invalid_task_resume/);
    assert.equal(new TaskResumeService(store.db).resume({ scope: "project:alpha", taskRef: alphaOne.taskRef }).task.id, alphaOne.episode.id);
  } finally { store.close(); }
});

test("task resume treats forgotten evidence as reconfirmation and never upgrades a failed attempt", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const failedTask = task(store, "project:alpha", "Schema migration", "Migrate the project schema.", 20);
    decision(store, 21, { scope: "project:alpha", objective: "Choose schema migration", chosenAction: "Use the checked migration", decisionMaker: "user", evidence: [{ sourceRef: failedTask.eventRef }], episodeIds: [failedTask.episode.id] });
    outcome(store, 22, { scope: "project:alpha", taskRef: failedTask.taskRef, verdict: "failure", impact: "harmful", summary: "Migration attempt failed before execution.", evidenceRefs: [failedTask.eventRef] });
    let result = new TaskResumeService(store.db).resume({ scope: "project:alpha", taskRef: failedTask.taskRef });
    assert.deepEqual(result.completed, []);
    assert.deepEqual(result.blockers.map(item => item.text), ["Migration attempt failed before execution."]);
    store.db.prepare("UPDATE mnemora_conversation_events SET deleted_at=? WHERE id=?").run(23, failedTask.event.id);
    result = new TaskResumeService(store.db).resume({ scope: "project:alpha", taskRef: failedTask.taskRef });
    assert.equal(result.status, "needs_reconfirmation");
    assert.deepEqual(result.decisions, []);
    assert.deepEqual(result.completed, []);
    assert.equal(result.needs_reconfirmation.some(item => item.text.includes("unavailable")), true);
  } finally { store.close(); }
});

test("task resume keeps a future decision planned until its inclusive validity window begins", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const now = 1_700_000_000_000, start = now + 86_400_000, end = start + 60_000;
    const rollout = task(store, "project:alpha", "Production cutover", "Switch the production environment at the scheduled time.", now);
    decision(store, now, { scope: "project:alpha", objective: "Schedule the production cutover", chosenAction: "Switch the production environment", decisionMaker: "user", validFrom: start, validUntil: end, evidence: [{ sourceRef: rollout.eventRef }], episodeIds: [rollout.episode.id] });

    const before = new TaskResumeService(store.db, () => start - 1).resume({ scope: "project:alpha", taskRef: rollout.taskRef });
    assert.equal(before.status, "needs_reconfirmation");
    assert.deepEqual(before.decisions, []);
    assert.deepEqual(before.next_steps, []);
    assert.deepEqual(before.planned.map(item => item.text), ["Switch the production environment"]);
    assert.equal(before.needs_reconfirmation.some(item => item.text.includes("scheduled")), true);

    const atStart = new TaskResumeService(store.db, () => start).resume({ scope: "project:alpha", taskRef: rollout.taskRef });
    assert.equal(atStart.status, "ready");
    assert.deepEqual(atStart.decisions.map(item => item.text), ["Switch the production environment"]);
    assert.deepEqual(atStart.next_steps.map(item => item.text), ["Switch the production environment"]);

    const atEnd = new TaskResumeService(store.db, () => end).resume({ scope: "project:alpha", taskRef: rollout.taskRef });
    assert.equal(atEnd.status, "ready");
    const expired = new TaskResumeService(store.db, () => end + 1).resume({ scope: "project:alpha", taskRef: rollout.taskRef });
    assert.equal(expired.status, "needs_reconfirmation");
    assert.deepEqual(expired.next_steps, []);
    assert.equal(expired.needs_reconfirmation.some(item => item.text.includes("validity window")), true);

    const epoch = task(store, "project:alpha", "Epoch decision", "Exercise the inclusive zero timestamp boundary.", 0);
    decision(store, 0, { scope: "project:alpha", objective: "Record an epoch-bounded action", chosenAction: "Run the epoch action", decisionMaker: "user", validFrom: 0, validUntil: 0, evidence: [{ sourceRef: epoch.eventRef }], episodeIds: [epoch.episode.id] });
    const atEpoch = new TaskResumeService(store.db, () => 0).resume({ scope: "project:alpha", taskRef: epoch.taskRef });
    assert.equal(atEpoch.status, "ready");
    assert.deepEqual(atEpoch.next_steps.map(item => item.text), ["Run the epoch action"]);
  } finally { store.close(); }
});

test("task resume projects explicitly linked action state without mistaking child completion for task completion", () => {
  const store = new GraphologyStore(":memory:");
  try {
    let now = 1_700_000_000_000;
    const migration = task(store, "project:alpha", "Staged migration", "Validate configuration, then run the migration.", now++);
    const check = decision(store, now++, { scope: "project:alpha", objective: "Validate migration configuration", chosenAction: "Validate configuration", decisionMaker: "user", evidence: [{ sourceRef: migration.eventRef }], episodeIds: [migration.episode.id] });
    const execute = decision(store, now++, { scope: "project:alpha", objective: "Run the staged migration", chosenAction: "Run the migration", decisionMaker: "user", evidence: [{ sourceRef: migration.eventRef }], episodeIds: [migration.episode.id] });
    const checkRef = createMnemoraContextRef({ scope: "project:alpha", kind: "decision", id: check.id });
    const executeRef = createMnemoraContextRef({ scope: "project:alpha", kind: "decision", id: execute.id });

    assert.throws(() => new TaskOutcomeService(store.db, () => now).preview({ scope: "project:alpha", taskRef: migration.taskRef, actionRef: checkRef, verdict: "success", impact: "helpful", evidenceRefs: [migration.eventRef] }), /invalid_task_action_state/);
    assert.throws(() => new TaskOutcomeService(store.db, () => now).preview({ scope: "project:alpha", taskRef: migration.taskRef, actionRef: checkRef, actionState: "completed", verdict: "failure", impact: "harmful", evidenceRefs: [migration.eventRef] }), /invalid_task_action_state/);
    outcome(store, now++, { scope: "project:alpha", taskRef: migration.taskRef, actionRef: checkRef, actionState: "completed", verdict: "success", impact: "helpful", summary: "Configuration validation completed.", evidenceRefs: [migration.eventRef] });
    let result = new TaskResumeService(store.db, () => now).resume({ scope: "project:alpha", taskRef: migration.taskRef });
    assert.equal(result.status, "ready");
    assert.equal(result.task.progress, "in_progress");
    assert.deepEqual(result.next_steps.map(item => item.text), ["Run the migration"]);
    assert.deepEqual(result.completed.map(item => item.text), ["Configuration validation completed."]);

    const failed = outcome(store, now++, { scope: "project:alpha", taskRef: migration.taskRef, actionRef: executeRef, actionState: "failed", verdict: "failure", impact: "harmful", summary: "Migration failed before changes were applied.", evidenceRefs: [migration.eventRef] });
    result = new TaskResumeService(store.db, () => now).resume({ scope: "project:alpha", taskRef: migration.taskRef });
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.next_steps, []);
    assert.deepEqual(result.blockers.map(item => item.text), ["Migration failed before changes were applied."]);

    outcome(store, now++, { scope: "project:alpha", taskRef: migration.taskRef, actionRef: executeRef, actionState: "completed", verdict: "success", impact: "helpful", summary: "Migration completed after recovery.", evidenceRefs: [migration.eventRef], supersedesId: failed.id });
    result = new TaskResumeService(store.db, () => now).resume({ scope: "project:alpha", taskRef: migration.taskRef });
    assert.equal(result.status, "ready");
    assert.deepEqual(result.blockers, []);
    assert.equal(result.history.some(item => item.text === "Migration failed before changes were applied."), true);
    assert.deepEqual(result.completed.map(item => item.text), ["Migration completed after recovery.", "Configuration validation completed."]);
  } finally { store.close(); }
});

test("task resume resolves every linked action state before limiting the displayed outcome history", () => {
  const store = new GraphologyStore(":memory:");
  try {
    let now = 1_700_000_000_000;
    const rollout = task(store, "project:alpha", "Long-lived rollout", "Do not revive a completed action after later outcomes.", now++);
    const execute = decision(store, now++, { scope: "project:alpha", objective: "Complete the long-lived rollout", chosenAction: "Complete rollout", decisionMaker: "user", evidence: [{ sourceRef: rollout.eventRef }], episodeIds: [rollout.episode.id] });
    const actionRef = createMnemoraContextRef({ scope: "project:alpha", kind: "decision", id: execute.id });
    outcome(store, now++, { scope: "project:alpha", taskRef: rollout.taskRef, actionRef, actionState: "completed", verdict: "success", impact: "helpful", summary: "The rollout action completed.", evidenceRefs: [rollout.eventRef] });
    for (let index = 0; index < 21; index++) outcome(store, now++, { scope: "project:alpha", taskRef: rollout.taskRef, verdict: "partial", impact: "neutral", summary: `Later task record ${index + 1}.`, evidenceRefs: [rollout.eventRef] });

    const result = new TaskResumeService(store.db, () => now).resume({ scope: "project:alpha", taskRef: rollout.taskRef });
    assert.deepEqual(result.next_steps, []);
    assert.equal(result.completed.some(item => item.text === "The rollout action completed."), true);
    assert.equal(result.pending.length, 20);
    assert.equal(result.truncated, true);
  } finally { store.close(); }
});

test("forgetting action-only evidence removes its state from the current projection", () => {
  const store = new GraphologyStore(":memory:");
  try {
    let now = 1_700_000_000_000;
    const rollout = task(store, "project:alpha", "Evidence-bound rollout", "Finish the rollout only with retained action evidence.", now++);
    const execute = decision(store, now++, { scope: "project:alpha", objective: "Complete the retained rollout", chosenAction: "Complete rollout", decisionMaker: "user", evidence: [{ sourceRef: rollout.eventRef }], episodeIds: [rollout.episode.id] });
    const proof = new ConversationEventRepository(store.db, policy).append({ scope: "project:alpha", sessionId: "session:proof", kind: "tool_result", role: "tool", parts: [{ type: "text", text: "The rollout verifier completed." }], createdAt: now++ });
    const proofRef = createMnemoraContextRef({ scope: "project:alpha", kind: "conversation-event", id: proof.id });
    outcome(store, now++, { scope: "project:alpha", taskRef: rollout.taskRef, actionRef: createMnemoraContextRef({ scope: "project:alpha", kind: "decision", id: execute.id }), actionState: "completed", verdict: "success", impact: "helpful", summary: "Rollout verifier completed.", evidenceRefs: [proofRef] });
    assert.deepEqual(new TaskResumeService(store.db, () => now).resume({ scope: "project:alpha", taskRef: rollout.taskRef }).next_steps, []);

    const impact = new MemoryImpactService(store.db), preview = impact.preview({ scope: "project:alpha", kind: "event", id: proof.id });
    assert.equal(impact.forget({ scope: "project:alpha", kind: "event", id: proof.id, previewHash: preview.previewHash, confirm: true }).status, "forgotten");
    const result = new TaskResumeService(store.db, () => now).resume({ scope: "project:alpha", taskRef: rollout.taskRef });
    assert.equal(result.status, "needs_reconfirmation");
    assert.deepEqual(result.completed, []);
    assert.deepEqual(result.next_steps, []);
    assert.equal(result.needs_reconfirmation.some(item => item.text.includes("linked action state")), true);
  } finally { store.close(); }
});

test("confirmed action state survives restart and requires an explicit corrected outcome", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-task-action-restart-")), path = join(directory, "memory.db");
  let store;
  try {
    let now = 1_700_000_000_000;
    store = new GraphologyStore(path);
    const rollout = task(store, "project:alpha", "Restarted rollout", "Record and correct an action after restart.", now++);
    const execute = decision(store, now++, { scope: "project:alpha", objective: "Execute the restarted rollout", chosenAction: "Execute rollout", decisionMaker: "user", evidence: [{ sourceRef: rollout.eventRef }], episodeIds: [rollout.episode.id] });
    const actionRef = createMnemoraContextRef({ scope: "project:alpha", kind: "decision", id: execute.id });
    const attempted = outcome(store, now++, { scope: "project:alpha", taskRef: rollout.taskRef, actionRef, actionState: "attempted", verdict: "unknown", impact: "neutral", summary: "Rollout execution was started.", evidenceRefs: [rollout.eventRef] });
    store.close();
    store = new GraphologyStore(path);
    let result = new TaskResumeService(store.db, () => now).resume({ scope: "project:alpha", taskRef: rollout.taskRef });
    assert.equal(result.status, "needs_reconfirmation");
    assert.deepEqual(result.next_steps, []);

    outcome(store, now++, { scope: "project:alpha", taskRef: rollout.taskRef, actionRef, actionState: "completed", verdict: "success", impact: "helpful", summary: "Rollout execution completed.", evidenceRefs: [rollout.eventRef], supersedesId: attempted.id });
    result = new TaskResumeService(store.db, () => now).resume({ scope: "project:alpha", taskRef: rollout.taskRef });
    assert.equal(result.status, "ready");
    assert.deepEqual(result.completed.map(item => item.text), ["Rollout execution completed."]);
    assert.equal(result.history.some(item => item.text === "Rollout execution was started."), true);
  } finally { try { store?.close(); } catch {} try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("task resume abstains when only a task record exists, and Inspector and CLI expose the same read-only projection", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-task-resume-entrypoints-")), dbPath = join(directory, "memory.db");
  const graph = new Mnemora({ config: { dbPath } });
  try {
    const bare = task(graph.store, "project:alpha", "Unverified rollout", "A task with no accepted current state.", 30);
    const app = createInspectorApplication({ graph, allowOperations: false, artifactDirectory: directory });
    const before = Number(graph.store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_conversation_events").get().value);
    const inspector = app.taskResume({ scope: "project:alpha", task_ref: bare.taskRef });
    assert.equal(inspector.status, "needs_reconfirmation");
    assert.equal(inspector.needs_reconfirmation.some(item => item.text.includes("No accepted decision or outcome")), true);
    assert.equal(Number(graph.store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_conversation_events").get().value), before);
    graph.close();
    const cli = spawnSync(process.execPath, [join(process.cwd(), "dist", "cli.js"), "resume", "--task-ref", bare.taskRef, "--scope", "project:alpha"], { encoding: "utf8", env: { ...process.env, MNEMORA_DB: dbPath } });
    assert.equal(cli.status, 0, cli.stderr);
    const output = JSON.parse(cli.stdout);
    assert.equal(output.command, "resume.read");
    assert.equal(output.result.task.task_ref, bare.taskRef);
    assert.equal(output.result.status, "needs_reconfirmation");
  } finally { try { graph.close(); } catch {} try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});
