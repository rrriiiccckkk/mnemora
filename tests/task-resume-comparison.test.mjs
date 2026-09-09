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
