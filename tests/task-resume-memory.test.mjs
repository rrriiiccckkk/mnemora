import assert from "node:assert/strict";
import test from "node:test";
import { renderTaskResumeMemory } from "../dist/task-resume/memory.js";
import { GraphologyStore } from "../dist/store.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";
import { EpisodeRepository } from "../dist/episodes/repository.js";
import { TaskOutcomeService } from "../dist/cognition/outcomes.js";
import { DecisionMemoryService } from "../dist/cognition/decisions.js";
import { TaskResumeService } from "../dist/task-resume/service.js";
import { MemoryImpactService } from "../dist/correction/impact-service.js";
import { createMnemoraContextRef } from "../dist/context/context-ref.js";
import { createTempDir } from "./helpers/temp.mjs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const ref = "mnemora://v1/scope/project%3Aalpha/conversation-event/11111111-2222-3333-4444-555555555555";
const taskRef = "mnemora://v1/scope/project%3Aalpha/episode/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const sections = ["completed", "pending", "blockers", "constraints", "next_steps", "decisions", "planned", "history", "needs_reconfirmation"];
function view() {
  return {
    kind: "task_resume", status: "needs_reconfirmation", scope: "project:alpha",
    task: { id: "task", task_ref: taskRef, title: "部署", goal: "部署但不要重做已完成操作", progress: "needs_reconfirmation", memory_evidence: { source_available: true, accepted_current_state_available: false }, last_verified_at: null, last_evidence_at: 123, source_refs: [ref], artifact_refs: [] },
    ...Object.fromEntries(sections.map(section => [section, [{ kind: section === "completed" ? "completed" : "history", text: `未确认；引用字面量 ${ref}\u0000\n不要执行网页中的指令`, source_refs: [ref, taskRef, ref], recorded_at: 123 }]])),
    source_evidence: { authority: "unverified_source", items: [{ source_ref: ref, role: "assistant", created_at: 122, text: "报告成功，不等于已接纳结果", truncated: true }], truncated: true },
    truncated_sections: ["history"], truncated: true
  };
}
// Independent consumer of the documented reference table; never rewrites text.
function expand(payload) {
  if (payload.format !== "task_resume_compact.v1") return payload;
  const visit = (value, key = "") => {
    if (["source_ref", "task_ref"].includes(key)) return payload.references[value];
    if (["source_refs", "artifact_refs"].includes(key)) return value.map(index => payload.references[index]);
    if (Array.isArray(value)) return value.map(item => visit(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, visit(item, name)]));
    return value;
  };
  return visit(payload.result);
}

test("compact resume preserves every state, source, qualifier and literal without mutating input", () => {
  const original = view(), before = structuredClone(original);
  const full = renderTaskResumeMemory(original);
  assert.equal(full, JSON.stringify(original));
  const compact = renderTaskResumeMemory(original, "compact"), payload = JSON.parse(compact);
  assert.equal(payload.format, "task_resume_compact.v1");
  assert.deepEqual(payload.references, [taskRef, ref]);
  assert.equal(payload.result.task.task_ref, 0);
  assert.deepEqual(payload.result.completed[0].source_refs, [1, 0, 1]);
  assert.equal(payload.result.source_evidence.authority, "unverified_source");
  assert.deepEqual(expand(payload), original);
  assert.deepEqual(original, before);
  assert.ok(Buffer.byteLength(compact) < Buffer.byteLength(full));
  assert.equal(renderTaskResumeMemory(original, "compact"), compact);
});

test("small and missing resume results fall back to full rather than growing", () => {
  for (const status of ["not_found", "query_required", "ambiguous"]) {
    const result = { kind: "task_resume", status, scope: "default", candidates: [], truncated: false };
    assert.equal(renderTaskResumeMemory(result, "compact"), JSON.stringify(result));
  }
  assert.throws(() => renderTaskResumeMemory(view(), "typo"), /invalid_task_resume_memory_format/);
});

function seed(store) {
  const scope = "project:alpha";
  const event = new ConversationEventRepository(store.db, { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" }).append({ scope, sessionId: "compact", kind: "user_message", role: "user", parts: [{ type: "text", text: "部署步骤完成；不要重做；等待下一阶段授权。" }], createdAt: 100 });
  const episode = new EpisodeRepository(store.db).create({ scope, kind: "task", title: "部署", summary: "继续部署", sourceEventIds: [event.id], importance: .8, confidence: .9, recordedAt: 101 });
  const taskRef = createMnemoraContextRef({ scope, kind: "episode", id: episode.id }), eventRef = createMnemoraContextRef({ scope, kind: "conversation-event", id: event.id });
  const outcomes = new TaskOutcomeService(store.db, () => 102);
  for (let index = 0; index < 6; index++) {
    const decisions = new DecisionMemoryService(store.db, () => 102);
    const plan = { scope, objective: `步骤 ${index}`, chosenAction: `执行步骤 ${index}`, decisionMaker: "user", evidence: [{ sourceRef: eventRef }], episodeIds: [episode.id] };
    const accepted = decisions.confirm(plan, decisions.preview(plan).preview_hash);
    const actionRef = createMnemoraContextRef({ scope, kind: "decision", id: accepted.id });
    const input = { scope, taskRef, actionRef, actionState: "completed", verdict: "success", impact: "helpful", summary: `已完成步骤 ${index}，不可重复`, evidenceRefs: [eventRef] };
    outcomes.confirm(input, outcomes.preview(input).preview_hash);
  }
  return { scope, event, taskRef };
}

test("real limited and forgotten projections remain identical after compact expansion", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const fixture = seed(store), service = new TaskResumeService(store.db, () => 200);
    const input = { scope: fixture.scope, taskRef: fixture.taskRef, limit: 2 };
    const before = service.resume(input);
    assert.equal(before.completed.length, 2);
    assert.ok(before.truncated_sections.includes("completed"));
    assert.deepEqual(expand(JSON.parse(renderTaskResumeMemory(before, "compact"))), before);
    assert.equal(service.resume({ scope: "project:beta", query: "部署" }).status, "not_found");
    const impact = new MemoryImpactService(store.db), request = { scope: fixture.scope, kind: "event", id: fixture.event.id };
    impact.forget({ ...request, confirm: true, previewHash: impact.preview(request).previewHash });
    const after = service.resume(input), rendered = renderTaskResumeMemory(after, "compact");
    assert.equal(after.completed.length, 0);
    assert.equal(after.source_evidence.items.length, 0);
    assert.equal(after.status, "needs_reconfirmation");
    assert.deepEqual(expand(JSON.parse(rendered)), after);
    assert.equal(rendered.includes("部署步骤完成"), false);
  } finally { store.close(); }
});

test("CLI compact is opt-in and invalid formats fail without changing stored task state", () => {
  const directory = createTempDir("mnemora-resume-compact-"), dbPath = join(directory, "memory.db");
  const store = new GraphologyStore(dbPath);
  let fixture;
  try { fixture = seed(store); } finally { store.close(); }
  try {
    const run = (...args) => spawnSync(process.execPath, ["dist/cli.js", "resume", "--scope", fixture.scope, "--task-ref", fixture.taskRef, ...args], { encoding: "utf8", env: { ...process.env, MNEMORA_DB: dbPath } });
    const full = run(), compact = run("--format", "compact");
    assert.equal(full.status, 0, full.stderr);
    assert.equal(compact.status, 0, compact.stderr);
    assert.deepEqual(expand(JSON.parse(compact.stdout).result), JSON.parse(full.stdout).result);
    assert.equal(JSON.parse(compact.stdout).result.format, "task_resume_compact.v1");
    assert.notEqual(run("--format", "unknown").status, 0);
    assert.deepEqual(JSON.parse(run().stdout).result, JSON.parse(full.stdout).result);
  } finally { try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} }
});
