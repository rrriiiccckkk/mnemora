import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 16 * 1024 * 1024;
const repoRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const labelFields = ["continuationCorrect", "staleFactUsed", "repeatedStep", "irrelevantMemoryInjected"];

const commands = [
  "prepare <bundle.json> <new-private-dir>", "register <dir>",
  "run <dir> <registration.json> <external-record.json> --execute", "check <dir>",
  "review <dir>", "export <dir> <labels.json>",
  "regression <bundle.json> <private-dir> --max-calls N --max-total-tokens N --execute"
];

function help() {
  return { status: "help", commands, latencyBoundary: "controlled_experiment_not_production_end_to_end",
    authorization: "Only run --execute or regression --execute may call a model. The formal run requires independent registration; regression is non-formal and never establishes efficacy." };
}

class CliError extends Error {
  constructor(code) { super(`experiment_cli_${code}`); }
}
const fail = code => { throw new CliError(code); };

function safeErrorCode(error) {
  if (error instanceof CliError) return error.message;
  if (error instanceof Error) {
    const code = error.message;
    const match = /^invalid_task_resume_experiment_[a-z_]+$/u.exec(code);
    if (match?.[0] === code || ["task_resume_preregistration_mismatch", "invalid_task_resume_preregistration",
      "invalid_task_resume_registration_timeline"].includes(code)) return code;
  }
  return "experiment_cli_operation_failed";
}

function within(parent, path) {
  const normalize = value => process.platform === "win32" ? value.toLowerCase() : value;
  const remainder = relative(normalize(parent), normalize(path));
  return !remainder || !isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith("..\\") && !remainder.startsWith("../");
}

/** Check every existing component, not just the leaf: a junction must not
 * disguise a repository destination or replace the parent of a private file. */
function guardedPath(value, workspace = false) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail(workspace ? "unsafe_workspace" : "invalid_file");
  const path = resolve(value);
  if (workspace && within(repoRoot, path)) fail("unsafe_workspace");
  let current = path, ancestor;
  for (;;) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) fail(workspace ? "unsafe_workspace" : "invalid_file");
      if (!ancestor) ancestor = current;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const canonical = resolve(realpathSync(ancestor), relative(ancestor, path));
  if (workspace && within(repoRoot, canonical)) fail("unsafe_workspace");
  return canonical;
}

function guardedDirectory(value, mustExist = true) {
  const directory = guardedPath(value, true);
  if (!existsSync(directory)) {
    if (mustExist || !lstatSync(dirname(directory)).isDirectory()) fail("unsafe_workspace");
    return directory;
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe_workspace");
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) fail("unsafe_workspace");
  for (const name of readdirSync(directory)) {
    const file = lstatSync(join(directory, name));
    if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_BYTES) fail("invalid_file");
  }
  return directory;
}

function readBounded(value) {
  const path = guardedPath(value), before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES) fail("invalid_file");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_BYTES || opened.dev !== before.dev || opened.ino !== before.ino) fail("invalid_file");
    const data = Buffer.alloc(Math.min(opened.size + 1, MAX_BYTES + 1));
    let size = 0;
    while (size < data.length) {
      const count = readSync(fd, data, size, data.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size !== opened.size || size > MAX_BYTES || fstatSync(fd).size !== opened.size) fail("invalid_file");
    return new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, size));
  } finally { closeSync(fd); }
}

function readJson(path) {
  try { return JSON.parse(readBounded(path)); }
  catch (error) { if (error instanceof CliError) throw error; fail("invalid_file"); }
}

function checkOutput(path, contents) {
  guardedPath(path);
  if (Buffer.byteLength(contents) > MAX_BYTES) fail("invalid_file");
  if (existsSync(path)) {
    if (readBounded(path) !== contents) fail("output_conflict");
    if (process.platform !== "win32" && (lstatSync(path).mode & 0o777) !== 0o600) fail("invalid_file");
  }
}

/** Preflight the whole output group so a known conflict never creates an
 * apparently complete subset. Retries verify identical bytes, never overwrite. */
function writeOutputs(directory, outputs) {
  guardedDirectory(directory);
  for (const [name, contents] of Object.entries(outputs)) checkOutput(join(directory, name), contents);
  for (const [name, contents] of Object.entries(outputs)) {
    guardedDirectory(directory);
    const path = join(directory, name);
    if (existsSync(path)) { checkOutput(path, contents); continue; }
    let fd;
    try { fd = openSync(path, "wx", 0o600); }
    catch (error) { if (error.code === "EEXIST") { checkOutput(path, contents); continue; } throw error; }
    try { writeFileSync(fd, contents, "utf8"); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
}

function labelTemplate(packet) {
  return { packetSha256: packet.packetSha256,
    collectionAudit: { reviewerId: null, cutoffEvidenceChecked: false, memoryFormationChecked: false,
      authorizationAndDeidentificationChecked: false, externalRecordChecked: false, notes: null },
    labels: packet.items.map(item => ({ blindId: item.blindId, adjudication: "pending",
      ...Object.fromEntries(labelFields.map(field => [field, null])),
      basis: Object.fromEntries(labelFields.map(field => [field, { refs: [], reason: null }])) })) };
}

function regressionOptions(args) {
  // Explicit consent takes precedence, including over malformed arguments.
  if (!args.slice(1).includes("--execute")) fail("execute_required");
  if (args.length !== 8 || args.slice(1, 3).some(arg => !arg || arg.startsWith("--"))) fail("invalid_arguments");
  const values = {}, seen = new Set();
  for (let index = 3; index < args.length; index++) {
    const flag = args[index];
    if (!["--execute", "--max-calls", "--max-total-tokens"].includes(flag) || seen.has(flag)) fail("invalid_arguments");
    seen.add(flag);
    if (flag === "--execute") continue;
    const value = args[++index];
    if (!/^[1-9][0-9]*$/u.test(value ?? "") || !Number.isSafeInteger(Number(value))) fail("invalid_arguments");
    values[flag === "--max-calls" ? "maxCalls" : "maxTotalTokens"] = Number(value);
  }
  if (seen.size !== 3) fail("invalid_arguments");
  return values;
}

async function regression(args) {
  const budgets = regressionOptions(args), apiKey = process.env.MNEMORA_EXPERIMENT_API_KEY;
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey !== apiKey.trim() || /[\r\n]/u.test(apiKey)) fail("api_key_required");
  const directory = guardedDirectory(args[2], false);
  const { TaskResumeExperimentWorkspace, prepareTaskResumeExperiment, serialize, hash } = await import("../dist/task-resume/experiment.js");
  const input = { ...readJson(args[1]), purpose: "regression" }, prepared = prepareTaskResumeExperiment(input);
  if (Object.values(prepared.artifacts).some(contents => Buffer.byteLength(contents) > MAX_BYTES)) fail("invalid_file");
  const workspace = existsSync(directory) ? new TaskResumeExperimentWorkspace(directory) : TaskResumeExperimentWorkspace.create(directory, input);
  if (workspace.prepared.fingerprint !== prepared.fingerprint) fail("output_conflict");
  const { callExperimentModel } = await import("../dist/task-resume/experiment-transport.js");
  await workspace.runRegression({ execute: true, ...budgets, transport: (request, options) => {
    guardedDirectory(directory);
    return callExperimentModel(request, { ...options, apiKey });
  } });
  const report = workspace.regressionReport(), contents = serialize(report), reportHash = hash(contents);
  const jsonName = `regression-report-${reportHash}.json`, markdownName = `regression-report-${reportHash}.md`;
  // Explicitly allowlist numerical counts; never expose cells, prompts or provider bodies.
  const counts = Object.fromEntries(Object.entries(report.summary).filter(([key, value]) =>
    /^(expected|completed|attempted|totalTokens|promptTokens|completionTokens)$/u.test(key)
    && Number.isSafeInteger(value) && value >= 0));
  const markdown = `# Task resume regression\n\nStatus: ${report.status}\n\n${Object.entries(counts).map(([key, value]) => `${key}: ${value}\n`).join("\n")}\nEfficacy: not_established\n\nEligible for pilot review: false\n`;
  const outputs = { [jsonName]: contents, [markdownName]: markdown };
  if (report.status === "complete") outputs["annotation-packet.json"] = serialize(workspace.reviewPacket());
  writeOutputs(directory, outputs);
  return { command: "regression", status: report.status, ...counts, efficacy: "not_established", eligibleForPilotReview: false, files: Object.keys(outputs) };
}

async function main(args) {
  if (!args.length || args.length === 1 && ["help", "--help", "-h"].includes(args[0])) return help();
  if (args[0] === "regression") return regression(args);
  const [command] = args, counts = { prepare: 3, register: 2, run: 5, check: 2, review: 2, export: 3 };
  if (command === "run" && args.length === 4) fail("execute_required");
  if (args.length !== counts[command] || args.slice(1).some((arg, index) => arg.startsWith("--") && !(command === "run" && index === 3 && arg === "--execute"))) fail("invalid_arguments");
  if (command === "run" && args[4] !== "--execute") fail("execute_required");
  const directory = guardedDirectory(command === "prepare" ? args[2] : args[1], command !== "prepare");
  const { TaskResumeExperimentWorkspace, prepareTaskResumeExperiment, serialize } = await import("../dist/task-resume/experiment.js");
  if (command === "prepare") {
    const input = readJson(args[1]), prepared = prepareTaskResumeExperiment(input);
    if (Object.values(prepared.artifacts).some(contents => Buffer.byteLength(contents) > MAX_BYTES)) fail("invalid_file");
    const workspace = existsSync(directory) ? new TaskResumeExperimentWorkspace(directory) : TaskResumeExperimentWorkspace.create(directory, input);
    if (workspace.prepared.fingerprint !== prepared.fingerprint) fail("output_conflict");
    return { command, status: "prepared", fingerprint: prepared.fingerprint };
  }
  const workspace = new TaskResumeExperimentWorkspace(directory);
  if (command === "check") {
    const check = workspace.check();
    return { command, status: check.status, check };
  }
  if (command === "register") {
    const { TaskResumeValueGate } = await import("../dist/task-resume/preregistration.js");
    const gate = new TaskResumeValueGate(), path = join(directory, "registration.json");
    const registration = existsSync(path) ? readJson(path) : gate.register(workspace.prepared.plan);
    gate.evaluate(workspace.prepared.plan, registration);
    writeOutputs(directory, { "registration.json": serialize(registration) });
    return { command, status: "registered", commitmentSha256: registration.commitmentSha256,
      externalRecordRequired: true, instruction: "Submit registration.json to an authorized independent timestamp record before running. Supply its reference and recordedAt yourself." };
  }
  if (command === "run") {
    const registration = readJson(args[2]), externalRecord = readJson(args[3]);
    const apiKey = process.env.MNEMORA_EXPERIMENT_API_KEY;
    if (typeof apiKey !== "string" || !apiKey.trim() || apiKey !== apiKey.trim() || /[\r\n]/u.test(apiKey)) fail("api_key_required");
    const { callExperimentModel } = await import("../dist/task-resume/experiment-transport.js");
    const check = await workspace.run(registration, { execute: true, externalRecord,
      transport: (request, options) => {
        guardedDirectory(directory);
        return callExperimentModel(request, { ...options, apiKey });
      } });
    return { command, status: check.status, check, latencyBoundary: "controlled_experiment_not_production_end_to_end" };
  }
  if (command === "review") {
    const packet = workspace.reviewPacket();
    writeOutputs(directory, { "annotation-packet.json": serialize(packet), "labels-template.json": serialize(labelTemplate(packet)) });
    return { command, status: "review_required", items: packet.items.length, packetSha256: packet.packetSha256,
      files: ["annotation-packet.json", "labels-template.json"], efficacy: "not_established" };
  }
  const exported = workspace.exportMeasured(readJson(args[2]));
  writeOutputs(directory, { "measured-plan.json": serialize(exported.measuredPlan),
    "decision-output.json": serialize({ report: exported.report, decision: exported.decision }),
    "annotation-audit.json": serialize(exported.annotationAudit), "collection-audit.json": serialize(exported.collectionAudit) });
  return { command, status: "exported", decision: exported.decision,
    files: ["measured-plan.json", "decision-output.json", "annotation-audit.json", "collection-audit.json"],
    latencyBoundary: "controlled_experiment_not_production_end_to_end" };
}
try {
  const result = await main(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + "\n");
  if (result.command === "regression") process.exitCode = result.status === "blocked" ? 1 : result.status === "incomplete" ? 2 : 0;
  if (result.command === "check" || result.command === "run") {
    process.exitCode = result.check.status === "blocked" ? 1 : result.check.status === "incomplete" ? 2 : 0;
  }
}
catch (error) {
  // Never print provider errors, response bodies, material text or credentials.
  process.stderr.write(safeErrorCode(error) + "\n");
  process.exitCode = 1;
}
