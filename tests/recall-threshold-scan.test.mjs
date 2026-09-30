import assert from "node:assert/strict";
import test from "node:test";
import * as evaluation from "../dist/evaluation/index.js";
import { createMnemoraContextRef } from "../dist/context/context-ref.js";
import { createTempDir } from "./helpers/temp.mjs";
import { GraphologyStore } from "../dist/store.js";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const ref = id => createMnemoraContextRef({ scope: "fixture:scan", kind: "memory-document", id });
function plan() {
  const cases = prefix => [1, 2, 3].map(index => ({ id: `${prefix}:${index}`, scope: "fixture:scan", query: `PRIVATE_QUERY_${prefix}_${index}`, kind: index === 3 ? "empty_recall" : "simple_find", expectedRefs: index === 3 ? [] : [ref(`${prefix}-${index}`)] }));
  return { version: 1, evidenceKind: "synthetic", parameter: "unified.hardMinScore", thresholds: [.2, .7], tokenBudget: 800, candidateLimit: 10, operationTimeoutMs: 1000, deadlineMs: 10000, selection: { minPrecision: .8, minRecall: .8, maxP95LatencyMs: 1000 }, tuning: { version: 1, id: "scan.tuning", cases: cases("tune") }, test: { version: 1, id: "scan.test", cases: cases("test") } };
}

test("threshold scan selects on tuning before evaluating one frozen held-out setting", async () => {
  assert.equal(typeof evaluation.RecallThresholdScanRunner, "function", "the operator evaluation API must expose threshold scanning");
  const input = plan(), runs = [];
  const report = await new evaluation.RecallThresholdScanRunner(threshold => ({ async find({ query }) {
    runs.push({ threshold, query });
    const item = [...input.tuning.cases, ...input.test.cases].find(value => value.query === query);
    const candidates = item.expectedRefs.map(contextRef => ({ contextRef, score: query.includes("test") ? .4 : .8, estimatedTokens: 10, bytes: 40 }));
    candidates.push({ contextRef: ref("distractor"), score: .4, estimatedTokens: 5, bytes: 20 });
    return { candidates: candidates.filter(value => value.score >= threshold) };
  } })).run(input);
  assert.equal(report.selection.threshold, .7);
  assert.equal(report.tuningCurve.length, 2);
  assert.equal(report.test.metrics.recallAtK, 0);
  assert.deepEqual([...new Set(runs.filter(run => run.query.includes("test")).map(run => run.threshold))], [.7]);
  assert.equal(report.automatedPolicyChange, "not_performed");
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_QUERY|fixture:scan|mnemora:\/\/|distractor/);
});

test("retrieval adapters receive fixed configuration without held-out labels", async () => {
  const configs = [];
  await new evaluation.RecallThresholdScanRunner((_threshold, config) => {
    configs.push(config);
    return { async find() { return { candidates: [] }; } };
  }).run(plan());
  assert.deepEqual(Object.keys(configs[0]).sort(), ["candidateLimit", "parameter", "tokenBudget"]);
});

test("negative controls must pass even when positive recall and precision are perfect", async () => {
  const input = plan();
  const report = await new evaluation.RecallThresholdScanRunner(() => ({ async find({ query }) {
    const item = [...input.tuning.cases, ...input.test.cases].find(value => value.query === query);
    return { candidates: (item.expectedRefs.length ? item.expectedRefs : [ref("unwanted")]).map(contextRef => ({ contextRef })) };
  } })).run(input);
  assert.equal(report.selection.status, "withheld");
  assert.equal(report.test, undefined);
});

test("overlapping IDs, duplicated normalized queries and silently truncated queries are rejected before retrieval", async () => {
  for (const mutation of [
    input => { input.test.cases[0].id = input.tuning.cases[0].id; },
    input => { input.test.cases[0].query = input.tuning.cases[0].query.toLowerCase(); },
    input => { input.tuning.cases[1].query = input.tuning.cases[0].query; },
    input => { input.tuning.cases[0].query = "x".repeat(513); }
  ]) {
    const input = plan(); mutation(input);
    let calls = 0;
    await assert.rejects(new evaluation.RecallThresholdScanRunner(() => { calls++; throw new Error("must not retrieve"); }).run(input), /invalid_recall_threshold_scan_plan/);
    assert.equal(calls, 0);
  }
});

test("one failed tuning setting cannot be hidden by selecting another successful setting", async () => {
  const input = plan();
  const report = await new evaluation.RecallThresholdScanRunner(threshold => ({ async find({ query }) {
    if (threshold === .2) throw new Error("PRIVATE_PROVIDER_ERROR");
    return { candidates: input.tuning.cases.find(item => item.query === query).expectedRefs.map(contextRef => ({ contextRef })) };
  } })).run(input);
  assert.equal(report.selection.status, "withheld");
  assert.ok(report.review.reasons.includes("incomplete_or_unsafe_tuning"));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_PROVIDER_ERROR/);
});

test("a pre-aborted scan does not acquire a retrieval adapter", async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const report = await new evaluation.RecallThresholdScanRunner(() => { calls++; throw new Error("must not retrieve"); }).run(plan(), { signal: controller.signal });
  assert.equal(calls, 0);
  assert.equal(report.selection.status, "withheld");
});

test("adapter initialization failures are withheld without leaking diagnostics", async () => {
  const report = await new evaluation.RecallThresholdScanRunner(() => { throw new Error("PRIVATE_ADAPTER_ERROR"); }).run(plan());
  assert.equal(report.selection.status, "withheld");
  assert.ok(report.review.reasons.includes("incomplete_or_unsafe_tuning"));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_ADAPTER_ERROR/);
});

test("reviewed multi-case evidence remains an operator review, never deployment approval", async () => {
  const input = plan(); input.evidenceKind = "operator_reviewed";
  for (const dataset of [input.tuning, input.test]) {
    const prefix = dataset === input.tuning ? "tune" : "test";
    for (const index of [4, 5]) dataset.cases.push({ id: `${prefix}:${index}`, scope: "fixture:scan", query: `PRIVATE_QUERY_${prefix}_${index}`, kind: "empty_recall", expectedRefs: [] });
  }
  const report = await new evaluation.RecallThresholdScanRunner(() => ({ async find({ query }) {
    const item = [...input.tuning.cases, ...input.test.cases].find(value => value.query === query);
    return { candidates: item.expectedRefs.map(contextRef => ({ contextRef, estimatedTokens: 10 })) };
  } })).run(input);
  assert.equal(report.selection.threshold, .7, "a deterministic tie prefers the higher floor");
  assert.equal(report.review.status, "reviewable");
  assert.deepEqual(report.review.reasons, []);
  assert.equal(report.review.deploymentApproval, "not_granted");
  assert.equal(report.automatedPolicyChange, "not_performed");
});

test("over-budget results cannot qualify and invalid plans never acquire an adapter", async () => {
  const input = plan();
  const report = await new evaluation.RecallThresholdScanRunner(() => ({ async find({ query }) {
    const item = input.tuning.cases.find(value => value.query === query);
    return { candidates: item.expectedRefs.map(contextRef => ({ contextRef, estimatedTokens: 801 })) };
  } })).run(input);
  assert.equal(report.selection.status, "withheld");
  for (const mutation of [
    value => { value.thresholds = [.2, .2]; },
    value => { value.thresholds = [.2, NaN]; },
    value => { value.parameter = "recall.semanticMinScore"; },
    value => { value.candidateLimit = 21; },
    value => { value.tuning.cases = value.tuning.cases.slice(0, 2); },
    value => { value.selection.unregistered = true; }
  ]) {
    const invalid = plan(); mutation(invalid); let calls = 0;
    await assert.rejects(new evaluation.RecallThresholdScanRunner(() => { calls++; }).run(invalid), /invalid_recall_threshold_scan_plan/);
    assert.equal(calls, 0);
  }
});

test("synchronous operation overruns cannot become valid threshold evidence", async () => {
  const input = plan(); input.operationTimeoutMs = 10;
  const report = await new evaluation.RecallThresholdScanRunner(() => ({ async find({ query }) {
    const until = performance.now() + 30;
    while (performance.now() < until) { /* Reproduce a blocking local retrieval. */ }
    const item = [...input.tuning.cases, ...input.test.cases].find(value => value.query === query);
    return { candidates: item.expectedRefs.map(contextRef => ({ contextRef })) };
  } })).run(input);
  assert.equal(report.selection.status, "withheld");
  assert.ok(report.tuningCurve.every(point => point.metrics.failed > 0));
});

test("operator scan uses the real score floor and never creates or migrates a database", () => {
  const directory = createTempDir("mnemora-threshold-cli-"), dbPath = join(directory, "snapshot.db"), planPath = join(directory, "plan.json");
  const store = new GraphologyStore(dbPath), input = plan();
  input.thresholds = [0, .35, .95];
  try {
    for (const [name, dataset] of [["tune", input.tuning], ["test", input.test]]) {
      dataset.cases = Array.from({ length: 5 }, (_, index) => {
        const query = `beacon${name}${index}unique`;
        const document = index < 3 ? store.upsertMemoryDocument({ scope: "fixture:scan", content: `${query} is a fictional note.`, source: `fixture:${name}:${index}` }) : undefined;
        return { id: `${name}:${index}`, scope: "fixture:scan", query, kind: document ? "simple_find" : "empty_recall", expectedRefs: document ? [ref(document.id)] : [] };
      });
    }
  } finally { store.close(); }
  writeFileSync(planPath, JSON.stringify(input));
  const hash = () => createHash("sha256").update(readFileSync(dbPath)).digest("hex"), before = hash();
  const output = JSON.parse(execFileSync(process.execPath, ["dist/cli.js", "evaluate", "recall-threshold-scan", planPath], { encoding: "utf8", env: { ...process.env, MNEMORA_DB: dbPath } }));
  assert.equal(output.ok, true);
  assert.equal(output.result.report.selection.threshold, .35);
  assert.equal(output.result.report.test.metrics.recallAtK, 1);
  assert.equal(output.result.database.readOnly, true);
  assert.equal(output.result.report.review.status, "withheld");
  assert.equal(hash(), before);
  assert.doesNotMatch(JSON.stringify(output), /beacontune|beacontest|snapshot\.db|fixture:scan/);
  const homeRelative = JSON.parse(execFileSync(process.execPath, ["dist/cli.js", "evaluate", "recall-threshold-scan", planPath], { encoding: "utf8", env: { ...process.env, USERPROFILE: directory, HOME: directory, MNEMORA_DB: "~/snapshot.db" } }));
  assert.equal(homeRelative.ok, true);
  assert.equal(hash(), before);

  const missing = join(directory, "must-not-create.db");
  const failed = spawnSync(process.execPath, ["dist/cli.js", "evaluate", "recall-threshold-scan", planPath], { encoding: "utf8", env: { ...process.env, MNEMORA_DB: missing } });
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stderr).error.code, "explicit_existing_database_required");
  assert.equal(existsSync(missing), false);

  const noDatabase = { ...process.env }; delete noDatabase.MNEMORA_DB;
  const unspecified = spawnSync(process.execPath, ["dist/cli.js", "evaluate", "recall-threshold-scan", planPath], { encoding: "utf8", env: noDatabase });
  assert.equal(unspecified.status, 1);
  assert.equal(JSON.parse(unspecified.stderr).error.code, "explicit_existing_database_required");

  const older = new GraphologyStore(dbPath);
  older.db.exec("PRAGMA user_version=82"); older.close();
  const oldHash = hash();
  const incompatible = spawnSync(process.execPath, ["dist/cli.js", "evaluate", "recall-threshold-scan", planPath], { encoding: "utf8", env: { ...process.env, MNEMORA_DB: dbPath } });
  assert.equal(incompatible.status, 1);
  assert.equal(JSON.parse(incompatible.stderr).error.code, "unsupported_snapshot_schema");
  assert.equal(hash(), oldHash, "evaluation cannot silently migrate an older snapshot");
});
