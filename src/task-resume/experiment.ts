import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { mnemoraVersion } from "../version.js";
import { TASK_RESUME_COMPARISON_ARMS, validateTaskResumeComparisonPlan, type TaskResumeComparisonPlan, type TaskResumeComparisonResult } from "./comparison.js";
import { TaskResumeValueGate } from "./preregistration.js";

type Arm = typeof TASK_RESUME_COMPARISON_ARMS[number];
// Freeze annotation semantics before dispatch, not after observing outputs.
const ANNOTATION_RUBRIC = {
  version: "task-resume-labels.v1",
  definitions: {
    continuationCorrect: "Accurately describes task state and a valid next step. Clarification is correct only when cutoff evidence is genuinely insufficient or ambiguous, not merely because memory is unverified. Invented certainty, ignored blockers or incorrect next steps fail.",
    staleFactUsed: "True when output relies on corrected, superseded, expired, rejected or forgotten information to infer state or recommend action. Identifying invalid information and avoiding reliance is not misuse.",
    repeatedStep: "True when output recommends or performs the same action already completed in cutoff history. Evidence requiring revalidation or repetition overrides superficial wording similarity.",
    irrelevantMemoryInjected: "Inspect actual longTermMemory input, not output. True if any item has no substantive relation to current task state or next action. Empty no-memory input must be false."
  },
  adjudication: "Audit complete authorized cutoff history, truth, actual input and output. Evidence gaps or disagreements remain pending; never guess booleans. Resolve all labels before measured export. No post-registration definition changes or held-out-driven tuning.",
  measurement: "Use actual provider total tokens and monotonic dispatch-to-validated-response milliseconds. Over-budget or invalid cells are excluded, not repaired. Omit untimed manualReviewMs; zero is not unknown."
} as const;
interface HistoryItem { id: string; at: number; text: string }
interface TruthItem { statement: string; sourceIds: string[] }
interface ExperimentCase {
  caseId: string; cutoffAt: number; cutoffSourceId: string; currentContext: string; question: string;
  history: HistoryItem[]; truth: TruthItem[];
  mnemora: { text: string; sourceIds: string[]; producer: string; historySha256: string };
}
export interface TaskResumeExperimentBundle {
  version: 1; id: string; kind: "authorized_real" | "synthetic"; mode: "controlled_memory";
  implementationRef: string;
  protocol: TaskResumeComparisonPlan["protocol"];
  splits: TaskResumeComparisonPlan["splits"];
  settings: { endpoint: string; temperature: number; maxTokens: number; simpleTopK: number };
  system: string; cases: ExperimentCase[];
}
export interface ExperimentModelRequest {
  model: string; temperature: number; max_tokens: number;
  messages: { role: "system" | "user"; content: string }[];
}
export interface ExperimentCell {
  index: number; caseId: string; split: "tuning" | "test"; arm: Arm;
  request: ExperimentModelRequest; requestSha256: string;
}
export interface PreparedTaskResumeExperiment {
  bundle: TaskResumeExperimentBundle;
  plan: TaskResumeComparisonPlan & { evidence: {
    kind: TaskResumeExperimentBundle["kind"]; caseManifestSha256: string; rubricSha256: string;
    commonPromptSha256: string; armConfigSha256: Record<Arm, string>;
  } };
  artifacts: Record<string, string>; cells: ExperimentCell[]; fingerprint: string;
}

/** Builds explicit two-message requests. No tools, host bootstrap or memory DB are involved. */
export function prepareTaskResumeExperiment(input: unknown): PreparedTaskResumeExperiment {
  const value = object(input, ["version", "id", "kind", "mode", "implementationRef", "protocol", "splits", "settings", "system", "cases"]);
  if (value.version !== 1 || !["authorized_real", "synthetic"].includes(String(value.kind)) || value.mode !== "controlled_memory") invalid("bundle");
  const protocol = object(value.protocol, ["modelId", "historySetId", "taskSetId", "tokenBudget", "latencyBudgetMs"]);
  const splits = object(value.splits, ["tuningCaseIds", "testCaseIds"]);
  const plan = validateTaskResumeComparisonPlan({ version: 1, id: value.id, status: "planned", protocol, splits, arms: [...TASK_RESUME_COMPARISON_ARMS] });
  const settings = object(value.settings, ["endpoint", "temperature", "maxTokens", "simpleTopK"]);
  const endpoint = text(settings.endpoint, 2048), url = new URL(endpoint);
  if (!/^https:\/\//iu.test(endpoint) || /[\s?#]/u.test(endpoint) || url.protocol !== "https:" || !url.hostname || url.username || url.password || /^https:\/\/[^/]*@/iu.test(endpoint)) invalid("endpoint");
  if (typeof settings.temperature !== "number" || !Number.isFinite(settings.temperature) || settings.temperature < 0 || settings.temperature > 2) invalid("temperature");
  const maxTokens = integer(settings.maxTokens, 1, plan.protocol.tokenBudget), simpleTopK = integer(settings.simpleTopK, 1, 20);
  const implementationRef = text(value.implementationRef, 80);
  if (!/^[a-f0-9]{40}$/.test(implementationRef)) invalid("implementation_ref");
  const ids = [...plan.splits.tuningCaseIds, ...plan.splits.testCaseIds];
  if (!Array.isArray(value.cases) || value.cases.length !== ids.length || ids.length > 2000) invalid("cases");
  const cases = value.cases.map((raw, index): ExperimentCase => {
    const item = object(raw, ["caseId", "cutoffAt", "cutoffSourceId", "currentContext", "question", "history", "truth", "mnemora"]);
    if (item.caseId !== ids[index]) invalid("case_order");
    const cutoffAt = integer(item.cutoffAt, 1, Date.now()), cutoffSourceId = identifier(item.cutoffSourceId), seen = new Set<string>();
    if (!Array.isArray(item.history) || !item.history.length || item.history.length > 2000) invalid("history");
    const history = item.history.map((source): HistoryItem => {
      const entry = object(source, ["id", "at", "text"]), id = identifier(entry.id), at = integer(entry.at, 1, Number.MAX_SAFE_INTEGER);
      if (at > cutoffAt) invalid("history_cutoff");
      if (seen.has(id)) invalid("duplicate_source");
      seen.add(id);
      return { id, at, text: text(entry.text, 16000) };
    });
    if (history.at(-1)!.id !== cutoffSourceId) invalid("cutoff_event_boundary");
    const sourceIds = (rawIds: unknown, allowEmpty = false): string[] => {
      if (!Array.isArray(rawIds) || !allowEmpty && !rawIds.length || rawIds.length > history.length) invalid("source_refs");
      const refs = rawIds.map(identifier);
      if (new Set(refs).size !== refs.length || refs.some(id => !seen.has(id))) invalid("source_refs");
      return refs;
    };
    if (!Array.isArray(item.truth) || !item.truth.length || item.truth.length > 100) invalid("truth");
    const truth = item.truth.map((raw): TruthItem => {
      const entry = object(raw, ["statement", "sourceIds"]);
      return { statement: text(entry.statement, 16000), sourceIds: sourceIds(entry.sourceIds) };
    });
    const memory = object(item.mnemora, ["text", "sourceIds", "producer", "historySha256"]), memoryText = text(memory.text, 128000, true);
    if (memory.historySha256 !== hash(serialize(history))) invalid("memory_history_binding");
    const memoryRefs = sourceIds(memory.sourceIds, !memoryText.length);
    if (!memoryText.length && memoryRefs.length) invalid("empty_memory_sources");
    return { caseId: ids[index], cutoffAt, cutoffSourceId, history, truth, currentContext: text(item.currentContext, 64000, true), question: text(item.question, 16000), mnemora: { text: memoryText, sourceIds: memoryRefs, producer: text(memory.producer, 4000), historySha256: memory.historySha256 as string } };
  });
  const bundle: TaskResumeExperimentBundle = { version: 1, id: plan.id, kind: value.kind as TaskResumeExperimentBundle["kind"], mode: "controlled_memory", implementationRef, protocol: plan.protocol, splits: plan.splits, settings: { endpoint, temperature: settings.temperature, maxTokens, simpleTopK }, system: text(value.system, 64000), cases };
  const artifacts: Record<string, string> = {
    "bundle.json": serialize(bundle),
    "case-materials.json": serialize(cases.map(({ truth: _truth, ...item }) => item)),
    "rubric.json": serialize({ annotation: ANNOTATION_RUBRIC, cases: cases.map(({ caseId, cutoffAt, cutoffSourceId, truth }) => ({ caseId, cutoffAt, cutoffSourceId, truth })) }),
    "common-prompt.json": serialize({ version: 1, system: bundle.system, userFormat: ["currentContext", "question", "longTermMemory"] }),
    "runtime-files.json": serialize(Object.fromEntries(["experiment.js", "experiment-transport.js", "comparison.js", "preregistration.js", "../version.js", "../../scripts/task-resume-experiment.mjs"].map(name => [name, hash(readFileSync(new URL(name, import.meta.url), "utf8"))])))
  };
  const armConfigSha256 = {} as Record<Arm, string>;
  for (const arm of TASK_RESUME_COMPARISON_ARMS) {
    const name = `arm-${arm}.json`;
    artifacts[name] = serialize({ arm, mode: bundle.mode, implementationRef, runtimeVersion: mnemoraVersion, runtimeFilesSha256: hash(artifacts["runtime-files.json"]), endpoint, modelId: plan.protocol.modelId, temperature: bundle.settings.temperature, maxTokens, order: "tuning_then_test_balanced_rotation.v1", retry: "never_automatic", latencyBoundary: "model_dispatch_to_validated_response", excludedCosts: ["historical_memory_formation", "precomputed_mnemora_projection", "evidence_disk_writes"], ...(arm === "simple_retrieval" ? { algorithm: "cjk-bigram-overlap.v1", topK: simpleTopK } : {}) });
    armConfigSha256[arm] = hash(artifacts[name]);
  }
  const frozenPlan = { ...plan, evidence: { kind: bundle.kind, caseManifestSha256: hash(artifacts["case-materials.json"]), rubricSha256: hash(artifacts["rubric.json"]), commonPromptSha256: hash(artifacts["common-prompt.json"]), armConfigSha256 } };
  artifacts["planned-plan.json"] = serialize(frozenPlan);
  const cells = cases.flatMap((item, caseIndex) => {
    // Fixed balanced rotation reduces always-last effects without post-result randomization.
    const arms = [...TASK_RESUME_COMPARISON_ARMS.slice(caseIndex % 3), ...TASK_RESUME_COMPARISON_ARMS.slice(0, caseIndex % 3)];
    return arms.map((arm, armIndex): ExperimentCell => {
    const longTermMemory = arm === "no_long_term_memory" ? "" : arm === "mnemora" ? item.mnemora.text : simpleMemory(item, simpleTopK);
    const request: ExperimentModelRequest = { model: plan.protocol.modelId, temperature: bundle.settings.temperature, max_tokens: maxTokens, messages: [{ role: "system", content: bundle.system }, { role: "user", content: JSON.stringify({ currentContext: item.currentContext, question: item.question, longTermMemory }) }] };
    return { index: caseIndex * 3 + armIndex, caseId: item.caseId, split: plan.splits.tuningCaseIds.includes(item.caseId) ? "tuning" : "test", arm, request, requestSha256: hash(serialize(request)) };
    });
  });
  return { bundle, plan: frozenPlan, artifacts, cells, fingerprint: hash(serialize(artifacts)) };
}

function simpleMemory(item: ExperimentCase, topK: number): string {
  const query = terms(`${item.currentContext}\n${item.question}`);
  return item.history.map((source, index) => ({ source, index, score: [...terms(source.text)].filter(term => query.has(term)).length }))
    .filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, topK)
    .map(({ source }) => `[${source.id}] ${source.text}`).join("\n\n");
}
function terms(value: string): Set<string> {
  const result = new Set<string>(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  for (const run of value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? []) {
    const chars = [...run];
    if (chars.length === 1) result.add(chars[0]);
    for (let i = 0; i + 1 < chars.length; i++) result.add(chars[i] + chars[i + 1]);
  }
  return result;
}

export interface ExperimentRunOptions {
  execute: boolean;
  externalRecord: { reference: string; recordedAt: number };
  transport: (request: ExperimentModelRequest, options: { endpoint: string; timeoutMs: number }) => Promise<unknown>;
}
export interface ExperimentCheck {
  status: "not_started" | "incomplete" | "blocked" | "ready_for_annotation";
  expected: number; completed: number; issues: { index: number; reason: string }[];
  mode: "controlled_memory"; efficacy: "not_established";
}
interface RunRecord {
  fingerprint: string; registration: unknown; externalRecord: ExperimentRunOptions["externalRecord"]; runStartedAt: number;
}
interface StartRecord { fingerprint: string; index: number; caseId: string; arm: Arm; startedAt: number; request: ExperimentModelRequest; requestSha256: string }
interface ResultRecord {
  status: "valid" | "invalid" | "failed"; reason?: string;
  fingerprint: string; index: number; caseId: string; arm: Arm;
  request: ExperimentModelRequest; requestSha256: string; startSha256: string;
  startedAt: number; endedAt: number; latencyMs: number;
  response?: unknown; responseSha256?: string; tokens?: number;
}
const LABEL_FIELDS = ["continuationCorrect", "staleFactUsed", "repeatedStep", "irrelevantMemoryInjected"] as const;
export interface ExperimentReviewPacket {
  version: 1; mode: "controlled_memory"; packetSha256: string;
  rubric: typeof ANNOTATION_RUBRIC;
  limitations: string[];
  items: { blindId: string; caseId: string; cutoffAt: number; cutoffSourceId: string; history: HistoryItem[]; input: ExperimentModelRequest["messages"]; truth: TruthItem[]; output: string; sourceIds: string[] }[];
}

/** Private file workspace, sequential calls and conservative at-most-once dispatch per cell.
 * A start without a verifiable result is ambiguous, never an invitation to retry. */
export class TaskResumeExperimentWorkspace {
  readonly directory: string;
  constructor(directory: string) {
    const path = resolve(directory), stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid("workspace");
    this.directory = realpathSync(path);
    this.readPrepared();
  }
  static create(directory: string, input: unknown): TaskResumeExperimentWorkspace {
    const prepared = prepareTaskResumeExperiment(input);
    if (Buffer.byteLength(prepared.artifacts["bundle.json"]) > MAX_FILE_BYTES) invalid("bundle_size");
    mkdirSync(resolve(directory), { mode: 0o700 });
    for (const [name, contents] of Object.entries(prepared.artifacts)) writeExclusive(join(resolve(directory), name), contents);
    return new TaskResumeExperimentWorkspace(directory);
  }
  get prepared(): PreparedTaskResumeExperiment { return this.readPrepared(); }

  async run(registration: unknown, options: ExperimentRunOptions): Promise<ExperimentCheck> {
    if (options.execute !== true) invalid("execute_required");
    const prepared = this.readPrepared();
    new TaskResumeValueGate().evaluate(prepared.plan, registration);
    const registeredAt = object(registration).registeredAt as number;
    const external = object(options.externalRecord, ["reference", "recordedAt"]);
    text(external.reference, 2048);
    const recordedAt = integer(external.recordedAt, registeredAt, Date.now());
    const externalRecord = { reference: external.reference as string, recordedAt };
    const token = randomUUID(), lockPath = this.path(".run.lock");
    writeExclusive(lockPath, token);
    try {
      const recordPath = this.path("run.json");
      if (!existsSync(recordPath)) {
        const runStartedAt = Date.now();
        if (runStartedAt <= registeredAt || recordedAt > runStartedAt) invalid("registration_timeline");
        writeExclusive(recordPath, serialize({ fingerprint: prepared.fingerprint, registration, externalRecord, runStartedAt }));
      }
      const run = this.readRun(prepared);
      if (serialize(run.registration) !== serialize(registration) || serialize(run.externalRecord) !== serialize(externalRecord)) invalid("run_binding");
      const initial = this.check();
      if (initial.status === "blocked") return initial;
      for (const cell of prepared.cells) {
        const resultPath = this.path(cellName(cell.index, "result"));
        if (existsSync(resultPath)) continue;
        // Regenerate after each await; material edits cannot drift into a later request.
        if (this.readPrepared().fingerprint !== prepared.fingerprint) invalid("material_drift");
        const startedAt = Date.now();
        const start: StartRecord = { fingerprint: prepared.fingerprint, index: cell.index, caseId: cell.caseId, arm: cell.arm, startedAt, request: cell.request, requestSha256: cell.requestSha256 };
        const startText = serialize(start);
        writeExclusive(this.path(cellName(cell.index, "start")), startText);
        const timer = performance.now();
        let raw: unknown, status: ResultRecord["status"] = "valid", reason: string | undefined, tokens: number | undefined;
        try {
          raw = await options.transport(structuredClone(cell.request), { endpoint: prepared.bundle.settings.endpoint, timeoutMs: prepared.plan.protocol.latencyBudgetMs });
          tokens = responseTokens(raw, cell.request);
        } catch (error) {
          status = raw === undefined ? "failed" : "invalid";
          reason = error instanceof Error && /^invalid_task_resume_experiment_[a-z_]+$/.test(error.message) ? error.message : "transport_failed_ambiguous";
        }
        const latencyMs = Math.ceil(performance.now() - timer), endedAt = Date.now();
        if (latencyMs < 0 || endedAt < startedAt || tokens !== undefined && tokens > prepared.plan.protocol.tokenBudget || latencyMs > prepared.plan.protocol.latencyBudgetMs) { status = "invalid"; reason = "budget_or_clock_violation"; }
        const result: ResultRecord = { status, ...(reason ? { reason } : {}), fingerprint: prepared.fingerprint, index: cell.index, caseId: cell.caseId, arm: cell.arm, request: cell.request, requestSha256: cell.requestSha256, startSha256: hash(startText), startedAt, endedAt, latencyMs, ...(raw === undefined ? {} : { response: raw, responseSha256: hash(serialize(raw)) }), ...(tokens === undefined ? {} : { tokens }) };
        writeExclusive(resultPath, serialize(result));
        if (status !== "valid") break; // unknown cost or invalid evidence stops further paid calls
      }
      return this.check();
    } finally {
      if (readBounded(lockPath) !== token) invalid("lock_changed");
      unlinkSync(lockPath);
    }
  }

  check(): ExperimentCheck {
    const prepared = this.readPrepared(), issues: ExperimentCheck["issues"] = [];
    let completed = 0, blocked = false;
    for (const name of readdirSync(this.directory)) {
      const match = /^cell-(\d+)\.(start|result)\.json$/.exec(name);
      if (match && (!prepared.cells[Number(match[1])] || name !== cellName(Number(match[1]), match[2] as "start" | "result"))) invalid("unexpected_cell");
    }
    const hasRun = existsSync(this.path("run.json"));
    const run = hasRun ? this.readRun(prepared) : undefined;
    for (const cell of prepared.cells) {
      const startExists = existsSync(this.path(cellName(cell.index, "start"))), resultExists = existsSync(this.path(cellName(cell.index, "result")));
      if (!startExists && !resultExists) { issues.push({ index: cell.index, reason: "not_run" }); continue; }
      if (!run || !startExists || !resultExists) { blocked = true; issues.push({ index: cell.index, reason: "unresolved_attempt" }); continue; }
      try { this.validResult(prepared, cell, run); completed++; }
      catch (error) { blocked = true; issues.push({ index: cell.index, reason: error instanceof Error && /^invalid_task_resume_experiment_[a-z_]+$/.test(error.message) ? error.message : "corrupt_evidence" }); }
    }
    return { status: blocked ? "blocked" : completed === prepared.cells.length ? "ready_for_annotation" : hasRun ? "incomplete" : "not_started", expected: prepared.cells.length, completed, issues, mode: "controlled_memory", efficacy: "not_established" };
  }

  /** Omits arm names, not a guarantee of blindness: payload style may reveal the condition. */
  reviewPacket(): ExperimentReviewPacket {
    if (this.check().status !== "ready_for_annotation") invalid("incomplete_evidence");
    const prepared = this.readPrepared(), run = this.readRun(prepared);
    const items = prepared.cells.map(cell => {
      const result = this.validResult(prepared, cell, run), item = prepared.bundle.cases.find(item => item.caseId === cell.caseId)!;
      const blindId = hash(`${prepared.fingerprint}:${cell.requestSha256}:${result.responseSha256}:${cell.index}`).slice(0, 32);
      return { blindId, caseId: cell.caseId, cutoffAt: item.cutoffAt, cutoffSourceId: item.cutoffSourceId, history: item.history, input: cell.request.messages, truth: item.truth, output: (result.response as { choices: { message: { content: string } }[] }).choices[0].message.content, sourceIds: item.history.map(source => source.id) };
    }).sort((a, b) => a.blindId.localeCompare(b.blindId));
    const base = { version: 1 as const, mode: "controlled_memory" as const, rubric: ANNOTATION_RUBRIC, limitations: ["Arm names are hidden and order is deterministic, but memory wording can reveal the condition.", "Source time and references are checked structurally. An authorized reviewer must audit task-state semantics, future-information leakage, and the external registration record.", "Latency covers model dispatch through the validated response. Historical formation, precomputed projection and evidence disk writes are excluded; this is not production end-to-end latency."], items };
    return { ...base, packetSha256: hash(serialize(base)) };
  }

  /** Explicit human labels only. Raw text and label reasons never enter the measured plan. */
  exportMeasured(input: unknown): {
    measuredPlan: TaskResumeComparisonPlan & PreparedTaskResumeExperiment["plan"] & { runStartedAt: number };
    report: ReturnType<TaskResumeValueGate["evaluate"]>["report"];
    decision: ReturnType<TaskResumeValueGate["evaluate"]>["decision"];
    annotationAudit: { packetSha256: string; labels: unknown[]; limitations: string[] };
    collectionAudit: { review: Record<string, unknown>; externalRecord: ExperimentRunOptions["externalRecord"]; registrationCommitmentSha256: string };
  } {
    const packet = this.reviewPacket(), value = object(input, ["packetSha256", "labels", "collectionAudit"]);
    if (value.packetSha256 !== packet.packetSha256) invalid("annotation_packet");
    if (!Array.isArray(value.labels) || value.labels.length !== packet.items.length) invalid("labels");
    const prepared = this.readPrepared(), run = this.readRun(prepared), seen = new Set<string>();
    const audit = object(value.collectionAudit, ["reviewerId", "cutoffEvidenceChecked", "memoryFormationChecked", "authorizationAndDeidentificationChecked", "externalRecordChecked", "notes"]);
    identifier(audit.reviewerId); text(audit.notes, 4000);
    for (const field of ["cutoffEvidenceChecked", "memoryFormationChecked", "authorizationAndDeidentificationChecked", "externalRecordChecked"]) if (audit[field] !== true) invalid("collection_audit");
    const bindings = new Map(prepared.cells.map(cell => {
      const result = this.validResult(prepared, cell, run);
      return [hash(`${prepared.fingerprint}:${cell.requestSha256}:${result.responseSha256}:${cell.index}`).slice(0, 32), { cell, result }] as const;
    }));
    const results: TaskResumeComparisonResult[] = value.labels.map(raw => {
      const label = object(raw, ["blindId", "adjudication", ...LABEL_FIELDS, "basis", "manualReviewMs"]);
      const id = text(label.blindId, 32), item = packet.items.find(item => item.blindId === id);
      if (!item || seen.has(id)) invalid("labels"); seen.add(id);
      if (label.adjudication !== "resolved") invalid("adjudication");
      const basis = object(label.basis, [...LABEL_FIELDS]);
      for (const field of LABEL_FIELDS) {
        if (typeof label[field] !== "boolean") invalid("label_boolean");
        const evidence = object(basis[field], ["refs", "reason"]);
        text(evidence.reason, 4000);
        if (!Array.isArray(evidence.refs) || !evidence.refs.length || evidence.refs.length > 100 || evidence.refs.some(ref => typeof ref !== "string" || !["input", "memory", "output", ...item.sourceIds].includes(ref))) invalid("label_basis");
      }
      const { cell, result } = bindings.get(id)!;
      return { caseId: cell.caseId, split: cell.split, arm: cell.arm, continuationCorrect: label.continuationCorrect as boolean, staleFactUsed: label.staleFactUsed as boolean, repeatedStep: label.repeatedStep as boolean, irrelevantMemoryInjected: label.irrelevantMemoryInjected as boolean, tokens: result.tokens!, latencyMs: result.latencyMs, ...(label.manualReviewMs === undefined ? {} : { manualReviewMs: integer(label.manualReviewMs, 0, 3_600_000) }) };
    });
    // Reuse the comparison's complete coverage, no-memory injection and budget rules.
    const order = new Map(prepared.cells.map(cell => [`${cell.caseId}/${cell.arm}`, cell.index]));
    const measuredPlan = { ...prepared.plan, status: "measured" as const, results: results.sort((a, b) => order.get(`${a.caseId}/${a.arm}`)! - order.get(`${b.caseId}/${b.arm}`)!), runStartedAt: run.runStartedAt };
    const { report, decision } = new TaskResumeValueGate().evaluate(measuredPlan, run.registration);
    return { measuredPlan, report, decision, annotationAudit: { packetSha256: packet.packetSha256, labels: value.labels, limitations: packet.limitations }, collectionAudit: { review: audit, externalRecord: run.externalRecord, registrationCommitmentSha256: object(run.registration).commitmentSha256 as string } };
  }

  private validResult(prepared: PreparedTaskResumeExperiment, cell: ExperimentCell, run: RunRecord): ResultRecord {
    const startText = readBounded(this.path(cellName(cell.index, "start"))), start = JSON.parse(startText) as StartRecord;
    const result = readJson(this.path(cellName(cell.index, "result"))) as ResultRecord;
    for (const record of [start, result]) {
      if (record.fingerprint !== prepared.fingerprint || record.index !== cell.index || record.caseId !== cell.caseId || record.arm !== cell.arm || record.requestSha256 !== cell.requestSha256 || serialize(record.request) !== serialize(cell.request)) invalid("cell_binding");
    }
    if (result.status !== "valid") invalid("attempt_not_valid");
    if (result.startSha256 !== hash(startText) || result.responseSha256 !== hash(serialize(result.response))) invalid("evidence_hash");
    if (start.startedAt !== result.startedAt || integer(result.startedAt, run.runStartedAt, Date.now()) > integer(result.endedAt, result.startedAt, Date.now())) invalid("cell_timeline");
    integer(result.latencyMs, 0, prepared.plan.protocol.latencyBudgetMs);
    const tokens = responseTokens(result.response, cell.request);
    if (result.tokens !== tokens || tokens > prepared.plan.protocol.tokenBudget) invalid("usage_or_budget");
    return result;
  }
  private readRun(prepared: PreparedTaskResumeExperiment): RunRecord {
    const run = object(readJson(this.path("run.json")), ["fingerprint", "registration", "externalRecord", "runStartedAt"]) as unknown as RunRecord;
    if (run.fingerprint !== prepared.fingerprint) invalid("run_binding");
    new TaskResumeValueGate().evaluate(prepared.plan, run.registration);
    const registeredAt = object(run.registration).registeredAt as number;
    integer(run.runStartedAt, registeredAt + 1, Date.now());
    const external = object(run.externalRecord, ["reference", "recordedAt"]);
    text(external.reference, 2048); integer(external.recordedAt, registeredAt, run.runStartedAt);
    return run;
  }
  private readPrepared(): PreparedTaskResumeExperiment {
    const prepared = prepareTaskResumeExperiment(readJson(this.path("bundle.json")));
    for (const [name, expected] of Object.entries(prepared.artifacts)) if (readBounded(this.path(name)) !== expected) invalid("material_drift");
    return prepared;
  }
  private path(name: string): string { return join(this.directory, name); }
}

function responseTokens(input: unknown, request: ExperimentModelRequest): number {
  const value = object(input);
  if (value.model !== request.model) invalid("response_model");
  if (!Array.isArray(value.choices) || value.choices.length !== 1) invalid("response_choices");
  const choice = object(value.choices[0]);
  if (choice.finish_reason !== "stop") invalid("response_stop");
  const message = object(choice.message);
  text(message.content, 2 * 1024 * 1024);
  if (message.tool_calls != null || message.refusal) invalid("response_mode");
  const usage = object(value.usage), total = integer(usage.total_tokens, 1, 10_000_000);
  const prompt = integer(usage.prompt_tokens, 0, total), completion = integer(usage.completion_tokens, 0, total);
  if (prompt + completion !== total) invalid("response_usage");
  if (completion > request.max_tokens) invalid("response_output_budget");
  return total;
}
const MAX_FILE_BYTES = 16 * 1024 * 1024;
function cellName(index: number, kind: "start" | "result"): string { return `cell-${String(index).padStart(6, "0")}.${kind}.json`; }
function readBounded(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) invalid("file");
  return readFileSync(path, "utf8");
}
function readJson(path: string): unknown { return JSON.parse(readBounded(path)); }
function writeExclusive(path: string, contents: string): void {
  if (Buffer.byteLength(contents) > MAX_FILE_BYTES) invalid("file_size");
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, contents, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
}
export function serialize(value: unknown): string { return JSON.stringify(value, null, 2) + "\n"; }
export function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function object(input: unknown, keys?: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || keys && Object.keys(input).some(key => !keys.includes(key))) invalid("object");
  return input as Record<string, unknown>;
}
function text(input: unknown, max: number, allowEmpty = false): string {
  if (typeof input !== "string" || input.length > max || !allowEmpty && !input.trim().length) invalid("text");
  return input;
}
function integer(input: unknown, min: number, max: number): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < min || input > max) invalid("integer");
  return input;
}
function identifier(input: unknown): string {
  const result = text(input, 80); if (!/^[a-z0-9][a-z0-9._:-]*$/.test(result)) invalid("identifier"); return result;
}
function invalid(reason: string): never { throw new Error(`invalid_task_resume_experiment_${reason}`); }
