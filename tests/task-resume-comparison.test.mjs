import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TaskResumeComparisonRunner, validateTaskResumeComparisonPlan } from "../dist/index.js";

const plan = JSON.parse(readFileSync("fixtures/task-resume-comparison-plan-v1.json", "utf8"));

test("task-resume comparison contract is repeatable but does not claim an unrun real experiment", () => {
  const report = new TaskResumeComparisonRunner().run(plan);
  assert.deepEqual(report, {
    version: 1,
    id: "task-resume.comparison.contract.v1",
    status: "real_effect_experiment_not_run",
    protocol: plan.protocol,
    arms: ["no_long_term_memory", "simple_retrieval", "mnemora"],
    splits: { tuningCases: 2, testCases: 2, testMetricsOnly: true },
    limitations: [
      "No authorized de-identified task results were supplied, so no effectiveness claim or task metric was computed.",
      "The comparison contract fixes model, history set, task set, budget, arms, and held-out test cases without making a model call."
    ]
  });
});

test("task-resume comparison reports only held-out measurements and rejects split leakage", () => {
  const arms = ["no_long_term_memory", "simple_retrieval", "mnemora"];
  const results = ["tune:01", "tune:02", "test:01", "test:02"].flatMap((caseId, index) => arms.map((arm, armIndex) => ({ caseId, split: caseId.startsWith("tune") ? "tuning" : "test", arm, continuationCorrect: arm !== "no_long_term_memory", staleFactUsed: arm === "simple_retrieval", repeatedStep: armIndex === 0, tokens: 100 + index + armIndex, latencyMs: 20 + index + armIndex, ...(arm === "mnemora" ? { manualReviewMs: 8 + index } : {}) })));
  const report = new TaskResumeComparisonRunner().run({ ...plan, status: "measured", results });
  assert.equal(report.status, "measured");
  assert.deepEqual(report.metrics.mnemora.continuation_correctness, { successes: 2, rate: 1 });
  assert.deepEqual(report.metrics.simple_retrieval.stale_fact_misuse, { count: 2, rate: 1 });
  assert.deepEqual(report.metrics.no_long_term_memory.repeated_steps, { count: 2, rate: 1 });
  assert.deepEqual(report.metrics.mnemora.manual_review_ms, { cases: 2, total: 21, mean: 10.5 });
  assert.throws(() => validateTaskResumeComparisonPlan({ ...plan, splits: { tuningCaseIds: ["tune:01"], testCaseIds: ["tune:01"] } }), /invalid_task_resume_comparison_plan/);
});

test("task-resume comparison rejects measurements outside the fixed per-case budgets", () => {
  const arms = ["no_long_term_memory", "simple_retrieval", "mnemora"];
  const results = ["tune:01", "tune:02", "test:01", "test:02"].flatMap(caseId => arms.map(arm => ({
    caseId,
    split: caseId.startsWith("tune") ? "tuning" : "test",
    arm,
    continuationCorrect: true,
    staleFactUsed: false,
    repeatedStep: false,
    tokens: plan.protocol.tokenBudget,
    latencyMs: plan.protocol.latencyBudgetMs
  })));
  const measured = { ...plan, status: "measured", results };
  assert.equal(new TaskResumeComparisonRunner().run(measured).status, "measured");
  assert.throws(() => new TaskResumeComparisonRunner().run({ ...measured, results: results.map((value, index) => index === 0 ? { ...value, tokens: value.tokens + 1 } : value) }), /invalid_task_resume_comparison_plan/);
  assert.throws(() => new TaskResumeComparisonRunner().run({ ...measured, results: results.map((value, index) => index === 6 ? { ...value, latencyMs: value.latencyMs + 1 } : value) }), /invalid_task_resume_comparison_plan/);
});

test("task-resume comparison reports irrelevant injection only with complete held-out labels", () => {
  const results = ["tune:01", "tune:02", "test:01", "test:02"].flatMap(caseId => plan.arms.map(arm => ({
    caseId,
    split: caseId.startsWith("tune") ? "tuning" : "test",
    arm,
    continuationCorrect: true,
    staleFactUsed: false,
    repeatedStep: false,
    tokens: 100,
    latencyMs: 20,
    irrelevantMemoryInjected: arm === "mnemora" && caseId !== "test:02"
  })));
  const measured = { ...plan, status: "measured", results };
  const report = new TaskResumeComparisonRunner().run(measured);
  assert.deepEqual(report.metrics.mnemora.irrelevant_injection, { count: 1, rate: .5 });
  assert.deepEqual(report.metrics.simple_retrieval.irrelevant_injection, { count: 0, rate: 0 });
  const withoutLabels = results.map(({ irrelevantMemoryInjected, ...value }) => value);
  const unmeasured = new TaskResumeComparisonRunner().run({ ...measured, results: withoutLabels });
  assert.equal(unmeasured.metrics.mnemora.irrelevant_injection, undefined);
  assert.match(unmeasured.limitations.join(" "), /Irrelevant memory injection was not measured/);
  assert.throws(() => new TaskResumeComparisonRunner().run({ ...measured, results: results.map((value, index) => index === 0 ? withoutLabels[0] : value) }), /invalid_task_resume_comparison_plan/);
  assert.throws(() => new TaskResumeComparisonRunner().run({ ...measured, results: results.map((value, index) => index === 0 ? { ...value, irrelevantMemoryInjected: "false" } : value) }), /invalid_task_resume_comparison_plan/);
  assert.throws(() => new TaskResumeComparisonRunner().run({ ...measured, results: results.map((value, index) => index === 0 ? { ...value, irrelevantMemoryInjected: true } : value) }), /invalid_task_resume_comparison_plan/);
});
