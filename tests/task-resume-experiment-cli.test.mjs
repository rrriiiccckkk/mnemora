import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, openSync, closeSync, ftruncateSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTempDir, tempEnvironment } from "./helpers/temp.mjs";
import { TaskResumeExperimentWorkspace, hash, serialize } from "../dist/task-resume/experiment.js";
import { TaskResumeValueGate } from "../dist/task-resume/preregistration.js";

const script = fileURLToPath(new URL("../scripts/task-resume-experiment.mjs", import.meta.url));
const repo = fileURLToPath(new URL("../", import.meta.url));
function cli(args, directory = createTempDir("experiment-cli-"), extraEnv = {}, importError, mockFetch = false) {
  const database = join(directory, "must-not-create.db");
  const witness = join(directory, "network-calls");
  const offline = `import fs from 'node:fs';import {registerHooks} from 'node:module';
    registerHooks({resolve(specifier,context,next){const result=next(specifier,context);if(/\\/dist\\/(?:index|cli|tools)\\.js$/.test(result.url)||specifier.startsWith('openclaw'))throw new Error('detached_import_forbidden');
      if(${JSON.stringify(importError ?? null)}!==null && result.url.endsWith('/dist/task-resume/experiment.js'))throw new Error(${JSON.stringify(importError ?? "")});return result;}});
    globalThis.fetch=async(url,options)=>{fs.appendFileSync(${JSON.stringify(witness)},'called\\n');
      if(!${JSON.stringify(mockFetch)})throw new Error('offline_test_network_forbidden');
      if(url!=='https://example.invalid/chat/completions'||options.headers.authorization!=='Bearer PRIVATE_TEST_KEY')throw new Error('unexpected_request');
      const request=JSON.parse(options.body);
      if(${JSON.stringify(mockFetch)}==='partial'&&fs.readFileSync(${JSON.stringify(witness)},'utf8').trim().split('\\n').length===6){
        fs.unlinkSync(${JSON.stringify(join(args[2] ?? directory, "cell-000000.result.json"))});
        fs.unlinkSync(${JSON.stringify(join(args[2] ?? directory, "cell-000000.start.json"))});
      }
      return new Response(JSON.stringify({model:request.model,choices:[{message:{content:'PRIVATE_REGRESSION_OUTPUT'},finish_reason:'stop'}],usage:{prompt_tokens:80,completion_tokens:20,total_tokens:100}}),{headers:{'content-type':'application/json'}});};`;
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(offline)}`, script, ...args], {
    cwd: directory, encoding: "utf8", timeout: 30000, windowsHide: true,
    env: { ...tempEnvironment(), MNEMORA_DB: database, MNEMORA_EXPERIMENT_API_KEY: "PRIVATE_TEST_KEY", ...extraEnv }
  });
  assert.ifError(result.error);
  assert.equal(existsSync(database), false, "the detached command must never open MNEMORA_DB");
  if (!mockFetch) assert.equal(existsSync(witness), false, "offline commands must not dispatch a model request");
  assert.doesNotMatch(result.stderr, /PRIVATE_TEST_KEY/);
  return result;
}

const callCount = directory => existsSync(join(directory, "network-calls"))
  ? readFileSync(join(directory, "network-calls"), "utf8").trim().split("\n").length : 0;

const fixture = () => ({
  version: 1, id: "cli:test", kind: "synthetic", mode: "controlled_memory", implementationRef: "0".repeat(40),
  protocol: { modelId: "offline-test", historySetId: "history:test", taskSetId: "tasks:test", tokenBudget: 1000, latencyBudgetMs: 1000 },
  splits: { tuningCaseIds: ["tune:01"], testCaseIds: ["test:01"] },
  settings: { endpoint: "https://example.invalid/chat/completions", temperature: 0, maxTokens: 100, simpleTopK: 2 },
  system: "Use unverified references without treating requests as completed actions.",
  cases: ["tune:01", "test:01"].map(caseId => {
    const history = [{ id: "s1", at: 900, text: "Checks complete; verify health next." }];
    return { caseId, cutoffAt: 1000, cutoffSourceId: "s1", currentContext: "Continue health verification", question: "What is next?", history,
      truth: [{ statement: "Verify health next", sourceIds: ["s1"] }],
      mnemora: { text: "Unverified: verify health next.", sourceIds: ["s1"], producer: "isolated synthetic fixture", historySha256: hash(serialize(history)) } };
  })
});
function success(result) { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); }
function failure(result, code) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), code);
}

test("detached help is structured JSON and never initializes a database", () => {
  const result = cli(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "help");
  assert.equal(output.commands.length, 7);
  assert.equal(output.latencyBoundary, "controlled_experiment_not_production_end_to_end");
});

test("run without explicit execution fails before workspace access or any network call", () => {
  failure(cli(["run", "absent", "registration.json", "external.json"]), "experiment_cli_execute_required");
});

const regressionArgs = (bundle, workspace, maxCalls = 6, maxTotalTokens = 6000) =>
  ["regression", bundle, workspace, "--max-calls", String(maxCalls), "--max-total-tokens", String(maxTotalTokens), "--execute"];

test("regression requires execute before argument, key or material checks and creates nothing", () => {
  const directory = createTempDir("cli-regression-consent-"), workspace = join(directory, "private");
  for (const args of [["regression"], regressionArgs("absent", workspace).slice(0, -1),
    [...regressionArgs("absent", workspace).slice(0, -1), "--unknown"]]) {
    failure(cli(args, directory, { MNEMORA_EXPERIMENT_API_KEY: "" }), "experiment_cli_execute_required");
    assert.deepEqual(readdirSync(directory), []);
  }
});

test("regression rejects unknown, duplicate and invalid budgets without effects", () => {
  const directory = createTempDir("cli-regression-args-"), workspace = join(directory, "private");
  const args = regressionArgs("absent", workspace);
  for (const invalid of [[...args, "--unknown"], [...args, "--execute"], [...args, "--max-calls", "6"],
    [...args, "extra"], regressionArgs("absent", workspace, 0), regressionArgs("absent", workspace, 1.5),
    regressionArgs("absent", workspace, 6, -1), regressionArgs("absent", workspace, 6, "1e3"),
    regressionArgs("absent", workspace, 6, "9007199254740992")]) {
    failure(cli(invalid, directory), "experiment_cli_invalid_arguments");
    assert.deepEqual(readdirSync(directory), []);
  }
});

test("regression missing key fails before files or workspace access", () => {
  const directory = createTempDir("cli-regression-key-"), workspace = join(directory, "private");
  for (const key of ["", " PRIVATE_TEST_KEY", "PRIVATE_TEST_KEY "]) {
    failure(cli(regressionArgs("absent", workspace), directory, { MNEMORA_EXPERIMENT_API_KEY: key }), "experiment_cli_api_key_required");
    assert.deepEqual(readdirSync(directory), []);
  }
});

test("regression executes six offline calls, resumes without calls and refuses material or budget drift and formal export", () => {
  const directory = createTempDir("cli-regression-run-"), bundle = join(directory, "bundle.json"), path = join(directory, "private");
  const input = fixture(); writeFileSync(bundle, serialize(input));
  const args = regressionArgs(bundle, path);
  const first = success(cli(args, directory, {}, undefined, true));
  assert.equal(first.status, "complete"); assert.equal(callCount(directory), 6);
  assert.equal(first.completed, 6); assert.equal(first.totalTokens, 600);
  assert.equal(first.efficacy, "not_established"); assert.equal(first.eligibleForPilotReview, false);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_REGRESSION_OUTPUT|Verify health|messages|cells/);
  const json = first.files.find(name => /^regression-report-[a-f0-9]{64}\.json$/u.test(name));
  const report = JSON.parse(readFileSync(join(path, json)));
  assert.equal(report.kind, "task_resume_regression_report"); assert.equal(report.status, "complete");
  assert.match(readFileSync(join(path, "annotation-packet.json"), "utf8"), /PRIVATE_REGRESSION_OUTPUT/);
  const before = new Map(readdirSync(path).map(name => [name, readFileSync(join(path, name))]));
  assert.deepEqual(success(cli(args, directory, {}, undefined, true)), first);
  assert.equal(callCount(directory), 6, "resume dispatches zero additional calls");
  input.system = "Changed material"; writeFileSync(bundle, serialize(input));
  failure(cli(args, directory, {}, undefined, true), "experiment_cli_output_conflict");
  writeFileSync(bundle, serialize(fixture()));
  failure(cli(regressionArgs(bundle, path, 7), directory, {}, undefined, true), "invalid_task_resume_experiment_regression_allowance_binding");
  const labels = join(directory, "labels.json"); writeFileSync(labels, "{}");
  failure(cli(["export", path, labels], directory, {}, undefined, true), "invalid_task_resume_experiment_regression_not_measured");
  assert.equal(callCount(directory), 6);
  assert.deepEqual(readdirSync(path), [...before.keys()]);
  for (const [name, contents] of before) assert.deepEqual(readFileSync(join(path, name)), contents);
  for (const name of ["registration.json", "external-record.json", "labels-template.json", "measured-plan.json"]) assert.equal(existsSync(join(path, name)), false);
});

test("regression snapshots evolve from incomplete to complete without overwriting reports and blocked exits one", () => {
  const directory = createTempDir("cli-regression-snapshot-"), bundle = join(directory, "bundle.json"), path = join(directory, "private");
  writeFileSync(bundle, serialize(fixture()));
  const args = regressionArgs(bundle, path);
  // Inject loss of an earlier cell's private files at the fetch boundary, before the final check.
  const partial = cli(args, directory, {}, undefined, "partial");
  assert.equal(partial.status, 2, partial.stderr); assert.equal(JSON.parse(partial.stdout).status, "incomplete");
  assert.equal(existsSync(join(path, "annotation-packet.json")), false);
  const partialFiles = new Map(JSON.parse(partial.stdout).files.map(name => [name, readFileSync(join(path, name))]));
  const complete = success(cli(args, directory, {}, undefined, true));
  assert.equal(complete.status, "complete");
  for (const [name, bytes] of partialFiles) assert.deepEqual(readFileSync(join(path, name)), bytes);
  assert.equal(callCount(directory), 7);
  assert.notDeepEqual(complete.files, [...partialFiles.keys()]);
  unlinkSync(join(path, "cell-000000.result.json"));
  const blocked = cli(args, directory, {}, undefined, true);
  assert.equal(blocked.status, 1); assert.equal(JSON.parse(blocked.stdout).status, "blocked");
  assert.equal(callCount(directory), 7);
});

test("every command rejects extra arguments before any effects", () => {
  for (const args of [["--help", "extra"], ["prepare", "bundle", "dir", "extra"], ["register", "dir", "extra"],
    ["check", "dir", "extra"], ["review", "dir", "extra"], ["export", "dir", "labels", "extra"],
    ["run", "dir", "registration", "external", "--execute", "extra"]]) {
    failure(cli(args), "experiment_cli_invalid_arguments");
  }
});

test("every workspace command refuses the repository irrespective of current directory", () => {
  const directory = createTempDir("cli-repo-"), bundle = join(directory, "bundle.json");
  writeFileSync(bundle, serialize(fixture()));
  for (const args of [["prepare", bundle, repo], ["register", repo], ["check", repo], ["review", repo],
    ["export", repo, "labels.json"], ["run", repo, "registration.json", "external.json", "--execute"]]) {
    failure(cli(args, directory), "experiment_cli_unsafe_workspace");
  }
});

test("prepare and read-only check work outside the repository, without generating measured evidence", () => {
  const directory = createTempDir("cli-prepare-"), bundle = join(directory, "bundle.json"), workspace = join(directory, "private");
  writeFileSync(bundle, serialize(fixture()));
  assert.equal(success(cli(["prepare", bundle, workspace], directory)).status, "prepared");
  const before = readFileSync(join(workspace, "bundle.json"), "utf8");
  assert.equal(success(cli(["check", workspace], directory)).check.status, "not_started");
  assert.equal(readFileSync(join(workspace, "bundle.json"), "utf8"), before);
  assert.equal(existsSync(join(workspace, "registration.json")), false);
  assert.equal(existsSync(join(workspace, "measured-plan.json")), false);
});

test("prepare is idempotent for identical materials and refuses changed materials", () => {
  const directory = createTempDir("cli-idempotent-"), bundle = join(directory, "bundle.json"), workspace = join(directory, "private");
  const input = fixture(); writeFileSync(bundle, serialize(input));
  const first = success(cli(["prepare", bundle, workspace], directory));
  assert.deepEqual(success(cli(["prepare", bundle, workspace], directory)), first);
  const before = readFileSync(join(workspace, "bundle.json"), "utf8");
  input.system = "Different system"; writeFileSync(bundle, serialize(input));
  failure(cli(["prepare", bundle, workspace], directory), "experiment_cli_output_conflict");
  assert.equal(readFileSync(join(workspace, "bundle.json"), "utf8"), before);
  if (process.platform !== "win32") {
    assert.equal(statSync(workspace).mode & 0o777, 0o700);
    for (const name of readdirSync(workspace)) assert.equal(statSync(join(workspace, name)).mode & 0o777, 0o600);
  }
});

test("register creates only a detached commitment and revalidates rather than replacing it", () => {
  const directory = createTempDir("cli-register-"), workspace = join(directory, "private");
  TaskResumeExperimentWorkspace.create(workspace, fixture());
  const first = success(cli(["register", workspace], directory)), path = join(workspace, "registration.json");
  assert.equal(first.externalRecordRequired, true);
  const text = readFileSync(path, "utf8"), stat = statSync(path);
  assert.deepEqual(success(cli(["register", workspace], directory)), first);
  assert.equal(readFileSync(path, "utf8"), text);
  assert.equal(statSync(path).mtimeMs, stat.mtimeMs);
  assert.equal(existsSync(join(workspace, "external-record.json")), false);
  const bad = JSON.parse(text); bad.commitmentSha256 = "0".repeat(64); writeFileSync(path, serialize(bad));
  failure(cli(["register", workspace], directory), "invalid_task_resume_preregistration");
  assert.equal(readFileSync(path, "utf8"), serialize(bad));
});

test("workspace guards reject symlink ancestors and symlink files without touching targets", () => {
  const directory = createTempDir("cli-symlinks-"), target = createTempDir("cli-target-"), alias = join(directory, "alias");
  symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  const bundle = join(directory, "bundle.json"); writeFileSync(bundle, serialize(fixture()));
  for (const args of [["prepare", bundle, join(alias, "private")], ["register", alias], ["check", alias], ["review", alias],
    ["export", alias, "labels"], ["run", alias, "registration", "external", "--execute"]]) {
    failure(cli(args, directory), "experiment_cli_unsafe_workspace");
  }
  assert.deepEqual(readdirSync(target), []);
  const link = join(directory, "repo-alias"); symlinkSync(repo, link, process.platform === "win32" ? "junction" : "dir");
  failure(cli(["prepare", bundle, join(link, "forbidden-private")], directory), "experiment_cli_unsafe_workspace");
  const workspace = join(directory, "private"); TaskResumeExperimentWorkspace.create(workspace, fixture());
  symlinkSync(target, join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
  failure(cli(["check", workspace], directory), "experiment_cli_invalid_file");
  assert.equal(lstatSync(alias).isSymbolicLink(), true);
});

test("bundle inputs are bounded regular files, not directories or symlinked ancestors", () => {
  const directory = createTempDir("cli-files-"), workspace = join(directory, "private"), large = join(directory, "large.json");
  const fd = openSync(large, "wx"); try { ftruncateSync(fd, 16 * 1024 * 1024 + 1); } finally { closeSync(fd); }
  failure(cli(["prepare", large, workspace], directory), "experiment_cli_invalid_file");
  failure(cli(["prepare", directory, workspace], directory), "experiment_cli_invalid_file");
  assert.equal(existsSync(workspace), false);
  const inputDirectory = createTempDir("cli-input-"), bundle = join(inputDirectory, "bundle.json");
  writeFileSync(bundle, serialize(fixture()));
  const alias = join(directory, "input-alias"); symlinkSync(inputDirectory, alias, process.platform === "win32" ? "junction" : "dir");
  failure(cli(["prepare", join(alias, "bundle.json"), workspace], directory), "experiment_cli_invalid_file");
});

test("run with no API key does not create an attempt or an external registration record", () => {
  const directory = createTempDir("cli-no-key-"), workspace = join(directory, "private");
  TaskResumeExperimentWorkspace.create(workspace, fixture());
  success(cli(["register", workspace], directory));
  const registration = join(workspace, "registration.json"), external = join(directory, "external.json");
  writeFileSync(external, serialize({ reference: "synthetic:independent-record", recordedAt: JSON.parse(readFileSync(registration)).registeredAt }));
  for (const key of ["", " PRIVATE_TEST_KEY", "PRIVATE_TEST_KEY ", "PRIVATE_TEST_KEY\t"]) {
    failure(cli(["run", workspace, registration, external, "--execute"], directory, { MNEMORA_EXPERIMENT_API_KEY: key }), "experiment_cli_api_key_required");
  }
  assert.equal(existsSync(join(workspace, "run.json")), false);
  assert.equal(existsSync(join(workspace, ".run.lock")), false);
});

async function completedWorkspace() {
  const directory = createTempDir("cli-annotations-"), path = join(directory, "private");
  const workspace = TaskResumeExperimentWorkspace.create(path, fixture());
  const registration = new TaskResumeValueGate(() => Date.now() - 100).register(workspace.prepared.plan);
  await workspace.run(registration, { execute: true, externalRecord: { reference: "synthetic:independent-record", recordedAt: registration.registeredAt },
    transport: async request => ({ model: request.model, choices: [{ message: { content: "Verify health next." }, finish_reason: "stop" }], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } }) });
  return { directory, path, workspace, registration };
}

test("review produces only pending null labels and unchecked human-audit placeholders", async () => {
  const { directory, path } = await completedWorkspace();
  const output = success(cli(["review", path], directory));
  assert.equal(output.status, "review_required");
  const packet = JSON.parse(readFileSync(join(path, "annotation-packet.json"))), template = JSON.parse(readFileSync(join(path, "labels-template.json")));
  assert.equal(packet.items.length, 6);
  assert.equal(template.packetSha256, packet.packetSha256);
  assert.deepEqual(template.collectionAudit, { reviewerId: null, cutoffEvidenceChecked: false, memoryFormationChecked: false, authorizationAndDeidentificationChecked: false, externalRecordChecked: false, notes: null });
  for (const label of template.labels) {
    assert.equal(label.adjudication, "pending");
    for (const field of ["continuationCorrect", "staleFactUsed", "repeatedStep", "irrelevantMemoryInjected"]) {
      assert.equal(label[field], null); assert.deepEqual(label.basis[field], { refs: [], reason: null });
    }
  }
  const before = readdirSync(path).sort();
  assert.deepEqual(success(cli(["review", path], directory)), output);
  assert.deepEqual(readdirSync(path).sort(), before);
  failure(cli(["export", path, join(path, "labels-template.json")], directory), "invalid_task_resume_experiment_text");
  assert.equal(existsSync(join(path, "measured-plan.json")), false);
});

test("export writes validated synthetic measurements and audits without asserting efficacy", async () => {
  const { directory, path, workspace } = await completedWorkspace();
  const packet = workspace.reviewPacket(), labels = {
    packetSha256: packet.packetSha256,
    collectionAudit: { reviewerId: "reviewer:test", cutoffEvidenceChecked: true, memoryFormationChecked: true, authorizationAndDeidentificationChecked: true, externalRecordChecked: true, notes: "Synthetic fixture audited, not real efficacy evidence." },
    labels: packet.items.map(item => ({ blindId: item.blindId, adjudication: "resolved", continuationCorrect: true, staleFactUsed: false, repeatedStep: false, irrelevantMemoryInjected: false,
      basis: Object.fromEntries(["continuationCorrect", "staleFactUsed", "repeatedStep", "irrelevantMemoryInjected"].map(field => [field, { refs: ["output", "s1"], reason: "Checked the synthetic cutoff evidence." }])) }))
  };
  const labelPath = join(directory, "labels.json"); writeFileSync(labelPath, serialize(labels));
  const output = success(cli(["export", path, labelPath], directory));
  assert.equal(output.decision.eligibleForPilotReview, false);
  assert.equal(output.latencyBoundary, "controlled_experiment_not_production_end_to_end");
  assert.equal(JSON.parse(readFileSync(join(path, "measured-plan.json"))).status, "measured");
  const collectionAudit = JSON.parse(readFileSync(join(path, "collection-audit.json")));
  assert.deepEqual(collectionAudit.review, labels.collectionAudit);
  assert.equal(collectionAudit.externalRecord.reference, "synthetic:independent-record");
  assert.match(collectionAudit.registrationCommitmentSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(readFileSync(join(path, "annotation-audit.json"))).labels.length, 6);
  assert.deepEqual(success(cli(["export", path, labelPath], directory)), output);
});

test("review preflights conflicting outputs and never overwrites an operator's file", async () => {
  const { directory, path } = await completedWorkspace();
  const target = join(path, "labels-template.json"); writeFileSync(target, "operator-owned\n");
  failure(cli(["review", path], directory), "experiment_cli_output_conflict");
  assert.equal(readFileSync(target, "utf8"), "operator-owned\n");
  assert.equal(existsSync(join(path, "annotation-packet.json")), false);
});

test("unfinished annotation and unchecked collection audit cannot create measured files", async () => {
  const { directory, path, workspace } = await completedWorkspace(), packet = workspace.reviewPacket();
  const labels = { packetSha256: packet.packetSha256,
    collectionAudit: { reviewerId: "reviewer:test", cutoffEvidenceChecked: true, memoryFormationChecked: true, authorizationAndDeidentificationChecked: true, externalRecordChecked: false, notes: "The independent registration has not yet been audited." },
    labels: packet.items.map(item => ({ blindId: item.blindId, adjudication: "resolved", continuationCorrect: true, staleFactUsed: false, repeatedStep: false, irrelevantMemoryInjected: false,
      basis: Object.fromEntries(["continuationCorrect", "staleFactUsed", "repeatedStep", "irrelevantMemoryInjected"].map(field => [field, { refs: ["s1", "output"], reason: "Checked the synthetic evidence." }])) })) };
  const input = join(directory, "labels.json"); writeFileSync(input, serialize(labels));
  failure(cli(["export", path, input], directory), "invalid_task_resume_experiment_collection_audit");
  labels.collectionAudit.externalRecordChecked = true;
  labels.labels[0].continuationCorrect = null; writeFileSync(input, serialize(labels));
  failure(cli(["export", path, input], directory), "invalid_task_resume_experiment_label_boolean");
  for (const name of ["measured-plan.json", "decision-output.json", "annotation-audit.json", "collection-audit.json"]) assert.equal(existsSync(join(path, name)), false);
});

test("check is byte-for-byte read-only and rejects oversized workspace files", () => {
  const directory = createTempDir("cli-read-only-"), path = join(directory, "private");
  TaskResumeExperimentWorkspace.create(path, fixture());
  const before = new Map(readdirSync(path).map(name => [name, { bytes: readFileSync(join(path, name)), mtime: statSync(join(path, name)).mtimeMs }]));
  success(cli(["check", path], directory));
  assert.deepEqual(readdirSync(path), [...before.keys()]);
  for (const [name, expected] of before) {
    assert.deepEqual(readFileSync(join(path, name)), expected.bytes);
    assert.equal(statSync(join(path, name)).mtimeMs, expected.mtime);
  }
  const fd = openSync(join(path, "oversized.json"), "wx");
  try { ftruncateSync(fd, 16 * 1024 * 1024 + 1); } finally { closeSync(fd); }
  failure(cli(["check", path], directory), "experiment_cli_invalid_file");
});

test("POSIX workspaces and idempotently reused outputs must remain private", { skip: process.platform === "win32" }, () => {
  const directory = createTempDir("cli-permissions-"), path = join(directory, "private");
  TaskResumeExperimentWorkspace.create(path, fixture());
  chmodSync(path, 0o755);
  failure(cli(["check", path], directory), "experiment_cli_unsafe_workspace");
  assert.equal(statSync(path).mode & 0o777, 0o755, "read-only commands do not repair permissions");
  chmodSync(path, 0o700);
  success(cli(["register", path], directory));
  const registration = join(path, "registration.json"); chmodSync(registration, 0o644);
  failure(cli(["register", path], directory), "experiment_cli_invalid_file");
  assert.equal(statSync(registration).mode & 0o777, 0o644);
});

test("check and cached run report blocked with exit 1 and preserve issues", async () => {
  const { directory, path, registration } = await completedWorkspace();
  const registrationPath = join(directory, "registration.json"), externalPath = join(directory, "external.json");
  writeFileSync(registrationPath, serialize(registration));
  writeFileSync(externalPath, serialize({ reference: "synthetic:independent-record", recordedAt: registration.registeredAt }));
  const ready = success(cli(["run", path, registrationPath, externalPath, "--execute"], directory));
  assert.equal(ready.status, "ready_for_annotation");
  assert.equal(ready.check.status, "ready_for_annotation");
  assert.equal(success(cli(["check", path], directory)).status, "ready_for_annotation");
  unlinkSync(join(path, "cell-000000.result.json"));
  for (const args of [["check", path], ["run", path, registrationPath, externalPath, "--execute"]]) {
    const result = cli(args, directory);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "blocked");
    assert.equal(output.check.status, "blocked");
    assert.deepEqual(output.check.issues, [{ index: 0, reason: "unresolved_attempt" }]);
  }
  unlinkSync(join(path, "cell-000000.start.json"));
  const incomplete = cli(["check", path], directory);
  assert.equal(incomplete.status, 2, incomplete.stderr);
  assert.equal(incomplete.stderr, "");
  const output = JSON.parse(incomplete.stdout);
  assert.equal(output.status, "incomplete");
  assert.equal(output.check.status, "incomplete");
  assert.deepEqual(output.check.issues, [{ index: 0, reason: "not_run" }]);
});

test("only exact allowlisted domain errors survive stderr sanitization", () => {
  const directory = createTempDir("cli-safe-errors-"), path = join(directory, "private");
  TaskResumeExperimentWorkspace.create(path, fixture());
  for (const code of ["invalid_task_resume_experiment_history_cutoff", "task_resume_preregistration_mismatch",
    "invalid_task_resume_preregistration", "invalid_task_resume_registration_timeline"]) {
    failure(cli(["check", path], directory, {}, code), code);
  }
  for (const message of ["invalid_task_resume_experiment_text PRIVATE_TEST_KEY /private/input provider body",
    "invalid_task_resume_experiment_text\n", "task_resume_preregistration_mismatch: /private/input",
    "invalid_task_resume_experiment_TEXT", "provider body PRIVATE_TEST_KEY /private/input"]) {
    failure(cli(["check", path], directory, {}, message), "experiment_cli_operation_failed");
  }
});
