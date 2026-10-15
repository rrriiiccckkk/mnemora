import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRecallRelevance } from "../dist/evaluation/recall-relevance-evaluation.js";
const fixture = () => ({
  plan: { version: 1, evidence: "independent_review", policy: "recall-relevance-shadow-v1", tuningCaseIds: ["tune"], testCaseIds: ["a", "b"], limits: { minTestCases: 2, maxHarmfulDeletionRate: 0, maxRecallLoss: 0, maxTaskCompletionLoss: 0, minNetSaving: 0 } },
  cases: ["tune", "a", "b"].map(id => ({ id, relevant: ["needed", "missed"], original: ["needed", "noise"], suggested: ["needed"], task: { originalCompleted: true, suggestedCompleted: true }, cost: { original: 10, suggested: 5, adjudication: 1, retry: 1, remediation: 1 } })),
});
test("independent paired evaluation accounts for baseline misses and all overhead without admitting policy", () => {
  const { plan, cases } = fixture();
  cases[0].suggested = []; // Tuning results cannot contaminate the held-out test.
  const report = evaluateRecallRelevance(plan, cases);
  assert.equal(report.gate.status, "eligible_for_review");
  assert.equal(report.gate.deploymentApproval, "not_granted");
  assert.equal(report.metrics.netSaving, 4);
  assert.equal(report.metrics.originalMisses, 2);
  assert.equal(report.metrics.suggestedMisses, 2);
  assert.equal(report.metrics.harmfulDeletionRate, 0);
  assert.equal(report.metrics.originalRecall, .5);
  assert.equal(report.metrics.suggestedNoise, 0);
  assert.doesNotMatch(JSON.stringify(report), /needed|missed|noise|tune/);
});
test("missing evidence stays unknown, synthetic labels cannot pass", () => {
  const { plan, cases } = fixture(); plan.evidence = "synthetic";
  cases[1].cost = null; cases[1].task = null;
  const r = evaluateRecallRelevance(plan, cases);
  assert.equal(r.metrics.netSaving, null); assert.equal(r.metrics.taskCompletion, null);
  assert.deepEqual(r.gate.reasons, ["independent_labels_missing", "task_outcomes_missing", "complete_costs_missing"]);
});
test("harmful removal, completion loss and remediation cost fail their independent gates", () => {
  const { plan, cases } = fixture(); cases[1].suggested = []; cases[1].task.suggestedCompleted = false; cases[1].cost.remediation = 20;
  const r = evaluateRecallRelevance(plan, cases);
  assert.equal(r.metrics.harmfulDeletionRate, .5);
  assert.equal(r.metrics.removalErrorRate, 1/3);
  for (const reason of ["harmful_deletion_limit", "recall_loss_limit", "task_completion_loss_limit", "net_saving_limit"]) assert.ok(r.gate.reasons.includes(reason));
});
test("reject overlap, addition, missing cases, duplicate refs and invalid measurements", () => {
  for (const mutate of [x => x.plan.tuningCaseIds.push("a"), x => x.cases[1].suggested.push("new"), x => x.cases.pop(), x => x.cases[1].original.push("needed"), x => x.cases[1].cost.retry = -1, x => x.plan.limits.maxRecallLoss = NaN]) {
    const input = fixture(); mutate(input); assert.throws(() => evaluateRecallRelevance(input.plan, input.cases), /Invalid recall relevance/);
  }
});

test("isolated CLI exercises real HTTP without forwarding labels or persisting source text", async () => {
  const { createServer } = await import("node:http");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { createTempDir } = await import("./helpers/temp.mjs");
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++; let body = ""; for await (const part of req) body += part;
    const parsed = JSON.parse(body);
    assert.equal(parsed.state.task, "recall_relevance");
    assert.equal(parsed.state.candidates[0].text, "Synthetic preference\nPrefers an aisle seat.");
    assert.equal(parsed.state.relevant, undefined);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ answers: { c0: { type: "noul", noul: .99 } }, usage: { input_tokens: 12, output_tokens: 0 } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const dir = createTempDir("relevance-trial-"); const path = join(dir, "trial.json");
    writeFileSync(path, JSON.stringify({ evidence: "synthetic", query: "Seat preference?", candidates: [{ title: "Synthetic preference", excerpt: "Prefers an aisle seat." }] }));
    const { stdout } = await promisify(execFile)(process.execPath, ["scripts/trial-recall-relevance.mjs", path], { env: { ...process.env, MNEMORA_RELEVANCE_ENDPOINT: `http://127.0.0.1:${server.address().port}/systemone`, MNEMORA_RELEVANCE_MODEL: "synthetic-model", MNEMORA_RELEVANCE_API_KEY: "synthetic-key" }, timeout: 10000 });
    const result = JSON.parse(stdout);
    assert.equal(calls, 1); assert.equal(result.qualityEvidence, false);
    assert.equal(result.observation.status, "succeeded"); assert.equal(result.observation.applied, false);
    assert.deepEqual(result.observation.usage, { input_tokens: 12, output_tokens: 0 });
    assert.doesNotMatch(stdout, /aisle|Seat|synthetic-key|Synthetic preference/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("non-finite aggregate costs cannot bypass the saving gate", () => {
  const { plan, cases } = fixture(); cases[1].cost.original = Number.MAX_VALUE;
  assert.throws(() => evaluateRecallRelevance(plan, cases), /Invalid recall relevance/);
});
