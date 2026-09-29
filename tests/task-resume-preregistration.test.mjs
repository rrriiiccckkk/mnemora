import { createTempDir } from "./helpers/temp.mjs";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { join } from "node:path";
import test from "node:test";
import { TASK_RESUME_VALUE_POLICY, TaskResumeValueGate } from "../dist/index.js";

const arms = ["no_long_term_memory", "simple_retrieval", "mnemora"];
function plan() {
  return { version: 1, id: "new-real-experiment", status: "planned", protocol: { modelId: "fixed-model", historySetId: "history-v3", taskSetId: "tasks-v3", tokenBudget: 1200, latencyBudgetMs: 30000 }, splits: { tuningCaseIds: Array.from({ length: 20 }, (_, i) => `tune:${i}`), testCaseIds: Array.from({ length: 100 }, (_, i) => `test:${i}`) }, arms,
    evidence: { kind: "authorized_real", caseManifestSha256: "a".repeat(64), rubricSha256: "b".repeat(64), commonPromptSha256: "c".repeat(64), armConfigSha256: Object.fromEntries(arms.map((arm, i) => [arm, String(i + 1).repeat(64)])) } };
}
function measured(input) {
  return { ...input, status: "measured", runStartedAt: 2000, results: [...input.splits.tuningCaseIds, ...input.splits.testCaseIds].flatMap(caseId => arms.map(arm => {
    const index = Number(caseId.split(":")[1]);
    return { caseId, split: caseId.startsWith("tune:") ? "tuning" : "test", arm, continuationCorrect: arm === "simple_retrieval" ? index < 60 : arm === "mnemora" && index < 70, staleFactUsed: arm === "simple_retrieval" ? index < 20 : arm === "mnemora" && index < 10, repeatedStep: false, irrelevantMemoryInjected: false, tokens: arm === "mnemora" ? 120 : 100, latencyMs: 20 };
  })) };
}
const register = input => new TaskResumeValueGate(() => 1000).register(input);
const evaluate = (input, registration) => new TaskResumeValueGate(() => 3000).evaluate(input, registration);

test("preregistration freezes the full comparison and inclusive decision thresholds before results", () => {
  const input = plan(), registration = register(input);
  assert.equal(registration.policy, TASK_RESUME_VALUE_POLICY);
  assert.match(registration.commitmentSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(register(structuredClone(input)), registration);
  assert.equal(evaluate(input, registration).decision.status, "not_run");
  const result = evaluate(measured(input), registration);
  assert.equal(result.decision.status, "pass");
  assert.equal(result.decision.eligibleForPilotReview, true);
  assert.equal(result.decision.automaticActivation, "not_performed");
  assert.equal(result.decision.checks.every(check => check.status === "pass"), true);
  assert.equal(result.report.metrics.mnemora.continuation_correctness.rate, .7);
  assert.match(result.decision.limitations.join(" "), /independently timestamped|not a power calculation/);
  assert.throws(() => register(measured(input)), /invalid_task_resume_preregistration/);
  assert.throws(() => register({ ...input, runStartedAt: 500 }), /invalid_task_resume_preregistration/);
  input.splits.testCaseIds[0] = "changed-after-register";
  assert.equal(registration.snapshot.splits.testCaseIds[0], "test:0");
});

for (const [name, change] of [
  ["correctness", row => ({ ...row, continuationCorrect: row.arm === "mnemora" ? Number(row.caseId.split(":")[1]) < 69 : row.continuationCorrect })],
  ["stale misuse", row => ({ ...row, staleFactUsed: row.arm === "mnemora" ? Number(row.caseId.split(":")[1]) < 11 : row.staleFactUsed })],
  ["tokens", row => ({ ...row, tokens: row.arm === "mnemora" ? 121 : row.tokens })],
  ["repeated steps", row => ({ ...row, repeatedStep: row.arm === "mnemora" && row.caseId === "test:0" })],
  ["irrelevant injection", row => ({ ...row, irrelevantMemoryInjected: row.arm === "mnemora" && row.caseId === "test:0" })]
]) test(`the v1.33 review gate stays closed when ${name} misses its preregistered boundary`, () => {
  const input = plan(), result = measured(input);
  result.results = result.results.map(row => row.split === "test" ? change(row) : row);
  const decision = evaluate(result, register(input)).decision;
  assert.equal(decision.status, "fail");
  assert.equal(decision.eligibleForPilotReview, false);
});

test("tuning success cannot repair a held-out decision failure", () => {
  const input = plan(), result = measured(input);
  result.results = result.results.map(row => ({ ...row, continuationCorrect: row.arm === "mnemora" ? row.split === "tuning" : row.continuationCorrect }));
  assert.equal(evaluate(result, register(input)).decision.status, "fail");
});

test("small samples, absent injection labels, synthetic cases and a zero stale baseline never pass", () => {
  for (const reason of ["small", "labels", "synthetic", "zero-stale", "sparse-stale", "zero-tokens"]) {
    const input = plan();
    if (reason === "small") input.splits.testCaseIds = input.splits.testCaseIds.slice(0, 90);
    if (reason === "synthetic") input.evidence.kind = "synthetic";
    const result = measured(input);
    if (reason === "labels") result.results = result.results.map(({ irrelevantMemoryInjected, ...row }) => row);
    if (reason === "zero-stale") result.results = result.results.map(row => ({ ...row, staleFactUsed: false }));
    if (reason === "sparse-stale") result.results = result.results.map(row => ({ ...row, staleFactUsed: row.arm === "simple_retrieval" && row.caseId === "test:0" }));
    if (reason === "zero-tokens") result.results = result.results.map(row => ({ ...row, tokens: 0 }));
    const decision = evaluate(result, register(input)).decision;
    assert.equal(decision.eligibleForPilotReview, false, reason);
    assert.equal(decision.checks.some(check => check.status === "insufficient"), true, reason);
  }
});

test("changing model, budgets, split identity, labels, prompts or arm configuration invalidates registration", () => {
  const input = plan(), registration = register(input);
  for (const change of [
    value => { value.protocol.modelId = "other-model"; },
    value => { value.protocol.tokenBudget++; },
    value => { value.splits.testCaseIds[0] = "new-test:0"; },
    value => { value.evidence.caseManifestSha256 = "d".repeat(64); },
    value => { value.evidence.rubricSha256 = "d".repeat(64); },
    value => { value.evidence.commonPromptSha256 = "d".repeat(64); },
    value => { value.evidence.armConfigSha256.simple_retrieval = "d".repeat(64); }
  ]) {
    const changed = structuredClone(input); change(changed);
    assert.throws(() => evaluate(measured(changed), registration), /task_resume_preregistration_mismatch/);
  }
  assert.throws(() => evaluate(measured(input), { ...registration, commitmentSha256: "0".repeat(64) }), /invalid_task_resume_preregistration/);
  assert.throws(() => evaluate(measured(input), { ...registration, policy: { ...registration.policy, maximumTokenRatio: 9 } }), /invalid_task_resume_preregistration/);
  assert.throws(() => register({ ...input, privateHistory: "must not flow into the registration" }), /invalid_task_resume_preregistration/);
  assert.throws(() => register({ ...input, protocol: { ...input.protocol, temperature: 1 } }), /invalid_task_resume_preregistration/);
});

test("chronology and budget violations are rejected rather than receiving an efficacy decision", () => {
  const input = plan(), result = measured(input), registration = register(input);
  for (const runStartedAt of [undefined, 0, 1000, 999, 3001]) assert.throws(() => evaluate({ ...result, runStartedAt }, registration), /invalid_task_resume_preregistration|invalid_task_resume_registration_timeline/);
  assert.throws(() => evaluate({ ...result, results: result.results.map((row, i) => i === 0 ? { ...row, tokens: 1201 } : row) }, registration), /invalid_task_resume_comparison_plan/);
});

test("CLI registration and decisions remain structured and do not initialize the selected database", () => {
  const directory = createTempDir("mnemora-preregistration-"), input = plan();
  try {
    const planPath = join(directory, "plan.json"), registrationPath = join(directory, "registration.json"), measuredPath = join(directory, "measured.json"), dbPath = join(directory, "must-not-exist.db");
    writeFileSync(planPath, JSON.stringify(input));
    const run = args => spawnSync(process.execPath, ["dist/cli.js", "evaluate", ...args], { encoding: "utf8", env: { ...process.env, MNEMORA_DB: dbPath } });
    const sealed = run(["task-resume-register", planPath]);
    assert.equal(sealed.status, 0, sealed.stderr);
    const registration = JSON.parse(sealed.stdout).result;
    writeFileSync(registrationPath, JSON.stringify(registration));
    const result = { ...measured(input), runStartedAt: registration.registeredAt + 1 };
    writeFileSync(measuredPath, JSON.stringify(result));
    const decided = run(["task-resume-decision", measuredPath, registrationPath]);
    assert.equal(decided.status, 0, decided.stderr);
    assert.equal(JSON.parse(decided.stdout).result.decision.status, "pass");
    assert.equal(existsSync(dbPath), false);
    const legacy = run(["task-resume-comparison", "fixtures/task-resume-comparison-plan-v1.json"]);
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.equal(existsSync(dbPath), false);
    assert.equal(readFileSync(planPath, "utf8"), JSON.stringify(input));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
