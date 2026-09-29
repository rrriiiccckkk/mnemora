import { createHash } from "node:crypto";
import { TaskResumeComparisonRunner, validateTaskResumeComparisonPlan, type TaskResumeComparisonPlan, type TaskResumeComparisonReport } from "./comparison.js";

/** Fixed before the next experiment, never fitted to its measured results. */
export const TASK_RESUME_VALUE_POLICY = Object.freeze({
  id: "task-resume-value.v1.32.v1",
  minimumTuningCases: 20,
  minimumTestCases: 100,
  minimumBaselineStaleCases: 10,
  minimumCorrectnessGainPp: 10,
  maximumStaleMisuseRatio: 0.5,
  maximumTokenRatio: 1.2,
  safetyRegressionAllowed: false
});

interface EvidenceDeclaration {
  kind: "authorized_real" | "synthetic";
  caseManifestSha256: string;
  rubricSha256: string;
  commonPromptSha256: string;
  armConfigSha256: { no_long_term_memory: string; simple_retrieval: string; mnemora: string };
}
type FrozenPlan = Omit<TaskResumeComparisonPlan, "status" | "results"> & { evidence: EvidenceDeclaration };
export interface TaskResumePreregistration {
  version: 1;
  kind: "task_resume_preregistration";
  registeredAt: number;
  policy: typeof TASK_RESUME_VALUE_POLICY;
  snapshot: FrozenPlan;
  commitmentSha256: string;
}
interface Check { id: string; status: "pass" | "fail" | "insufficient"; observed?: number; required?: number; }
export interface TaskResumeValueDecision {
  policyId: string;
  status: "not_run" | "pass" | "fail" | "inconclusive";
  eligibleForPilotReview: boolean;
  checks: Check[];
  automaticActivation: "not_performed";
  limitations: string[];
}

/** A detached, read-only gate. It cannot enable recall or a ReasoningMemory canary. */
export class TaskResumeValueGate {
  constructor(private readonly now: () => number = Date.now) {}

  register(input: unknown): TaskResumePreregistration {
    const { plan, evidence } = experiment(input);
    if (plan.status !== "planned" || record(input) && input.runStartedAt !== undefined) invalid();
    const registeredAt = timestamp(this.now());
    const registration = { version: 1 as const, kind: "task_resume_preregistration" as const, registeredAt, policy: TASK_RESUME_VALUE_POLICY, snapshot: snapshot(plan, evidence) };
    return { ...registration, commitmentSha256: digest(registration) };
  }

  evaluate(input: unknown, registrationInput: unknown): { report: TaskResumeComparisonReport; decision: TaskResumeValueDecision } {
    const { plan, evidence } = experiment(input), registration = this.registration(registrationInput);
    if (canonical(snapshot(plan, evidence)) !== canonical(registration.snapshot)) throw new Error("task_resume_preregistration_mismatch");
    const report = new TaskResumeComparisonRunner().run(plan);
    const limitations = [
      "The registration commitment must be independently timestamped before any model run. A self-contained hash and operator-supplied runStartedAt do not prove chronology or prevent a rewritten registration.",
      "Dataset provenance, labels, prompts, arm isolation and usage counters are operator assertions; this gate does not inspect private histories or call a model.",
      "Sample floors and point-estimate thresholds are engineering decision guards, not a power calculation, significance test, or population-level efficacy claim.",
      "A passing decision permits operator review only; it neither activates v1.33 delivery nor satisfies the separate v2.0 security and replication requirements."
    ];
    const base = { policyId: TASK_RESUME_VALUE_POLICY.id, automaticActivation: "not_performed" as const, limitations };
    if (plan.status === "planned") return { report, decision: { ...base, status: "not_run", eligibleForPilotReview: false, checks: [] } };
    const startedAt = record(input) ? timestamp(input.runStartedAt) : invalid();
    if (startedAt <= registration.registeredAt || startedAt > timestamp(this.now())) throw new Error("invalid_task_resume_registration_timeline");
    const results = plan.results!, test = results.filter(item => item.split === "test"), simple = test.filter(item => item.arm === "simple_retrieval"), memory = test.filter(item => item.arm === "mnemora");
    const count = (rows: typeof test, key: "continuationCorrect" | "staleFactUsed" | "repeatedStep" | "irrelevantMemoryInjected") => rows.filter(row => row[key] === true).length;
    const tokens = (rows: typeof test) => rows.reduce((sum, row) => sum + row.tokens, 0);
    const cases = plan.splits.testCaseIds.length, gain = count(memory, "continuationCorrect") - count(simple, "continuationCorrect"), baselineStale = count(simple, "staleFactUsed"), memoryStale = count(memory, "staleFactUsed"), baselineTokens = tokens(simple), memoryTokens = tokens(memory);
    const injectionMeasured = results.every(row => row.irrelevantMemoryInjected !== undefined);
    const checks: Check[] = [
      { id: "authorized_real_cases", status: evidence.kind === "authorized_real" ? "pass" : "insufficient" },
      { id: "tuning_sample_floor", status: plan.splits.tuningCaseIds.length >= TASK_RESUME_VALUE_POLICY.minimumTuningCases ? "pass" : "insufficient", observed: plan.splits.tuningCaseIds.length, required: TASK_RESUME_VALUE_POLICY.minimumTuningCases },
      { id: "test_sample_floor", status: cases >= TASK_RESUME_VALUE_POLICY.minimumTestCases ? "pass" : "insufficient", observed: cases, required: TASK_RESUME_VALUE_POLICY.minimumTestCases },
      { id: "baseline_stale_support", status: baselineStale >= TASK_RESUME_VALUE_POLICY.minimumBaselineStaleCases ? "pass" : "insufficient", observed: baselineStale, required: TASK_RESUME_VALUE_POLICY.minimumBaselineStaleCases },
      { id: "complete_injection_labels", status: injectionMeasured ? "pass" : "insufficient" },
      { id: "positive_measured_tokens", status: results.every(row => row.tokens > 0) ? "pass" : "insufficient" },
      // Integer comparisons preserve inclusive boundaries without floating-point drift.
      { id: "correctness_gain", status: gain * 10 >= cases ? "pass" : "fail", observed: gain * 100 / cases, required: TASK_RESUME_VALUE_POLICY.minimumCorrectnessGainPp },
      { id: "stale_misuse_halved", status: baselineStale === 0 ? "insufficient" : memoryStale * 2 <= baselineStale ? "pass" : "fail", ...(baselineStale ? { observed: memoryStale / baselineStale } : {}), required: TASK_RESUME_VALUE_POLICY.maximumStaleMisuseRatio },
      { id: "token_overhead", status: baselineTokens === 0 ? "insufficient" : memoryTokens * 5 <= baselineTokens * 6 ? "pass" : "fail", ...(baselineTokens ? { observed: memoryTokens / baselineTokens } : {}), required: TASK_RESUME_VALUE_POLICY.maximumTokenRatio },
      { id: "no_repeated_step_regression", status: count(memory, "repeatedStep") <= count(simple, "repeatedStep") ? "pass" : "fail" },
      { id: "no_irrelevant_injection_regression", status: !injectionMeasured ? "insufficient" : count(memory, "irrelevantMemoryInjected") <= count(simple, "irrelevantMemoryInjected") ? "pass" : "fail" }
    ];
    const status = checks.some(check => check.status === "fail") ? "fail" : checks.some(check => check.status === "insufficient") ? "inconclusive" : "pass";
    return { report, decision: { ...base, status, eligibleForPilotReview: status === "pass", checks } };
  }

  private registration(input: unknown): TaskResumePreregistration {
    if (!record(input) || !only(input, ["version", "kind", "registeredAt", "policy", "snapshot", "commitmentSha256"]) || input.version !== 1 || input.kind !== "task_resume_preregistration" || canonical(input.policy) !== canonical(TASK_RESUME_VALUE_POLICY) || !sha256(input.commitmentSha256) || !record(input.snapshot) || !only(input.snapshot, ["version", "id", "protocol", "splits", "arms", "evidence"])) invalid();
    const { plan, evidence } = experiment({ ...input.snapshot, status: "planned" });
    const registration = { version: 1 as const, kind: "task_resume_preregistration" as const, registeredAt: timestamp(input.registeredAt), policy: TASK_RESUME_VALUE_POLICY, snapshot: snapshot(plan, evidence) };
    if (registration.registeredAt > timestamp(this.now()) || digest(registration) !== input.commitmentSha256) invalid();
    return { ...registration, commitmentSha256: input.commitmentSha256 };
  }
}

function experiment(input: unknown): { plan: TaskResumeComparisonPlan; evidence: EvidenceDeclaration } {
  if (!record(input) || !only(input, ["version", "id", "status", "protocol", "splits", "arms", "results", "evidence", "runStartedAt"])) invalid();
  const plan = validateTaskResumeComparisonPlan(input), value = input.evidence;
  if (!only(input.protocol as Record<string, unknown>, ["modelId", "historySetId", "taskSetId", "tokenBudget", "latencyBudgetMs"]) || !only(input.splits as Record<string, unknown>, ["tuningCaseIds", "testCaseIds"])) invalid();
  if (!record(value) || !only(value, ["kind", "caseManifestSha256", "rubricSha256", "commonPromptSha256", "armConfigSha256"]) || value.kind !== "authorized_real" && value.kind !== "synthetic" || !sha256(value.caseManifestSha256) || !sha256(value.rubricSha256) || !sha256(value.commonPromptSha256) || !record(value.armConfigSha256) || !only(value.armConfigSha256, ["no_long_term_memory", "simple_retrieval", "mnemora"]) || !plan.arms.every(arm => sha256((value.armConfigSha256 as Record<string, unknown>)[arm]))) invalid();
  return { plan, evidence: { kind: value.kind, caseManifestSha256: value.caseManifestSha256, rubricSha256: value.rubricSha256, commonPromptSha256: value.commonPromptSha256, armConfigSha256: { no_long_term_memory: value.armConfigSha256.no_long_term_memory as string, simple_retrieval: value.armConfigSha256.simple_retrieval as string, mnemora: value.armConfigSha256.mnemora as string } } };
}
function snapshot(plan: TaskResumeComparisonPlan, evidence: EvidenceDeclaration): FrozenPlan { return { version: plan.version, id: plan.id, protocol: { ...plan.protocol }, splits: { tuningCaseIds: [...plan.splits.tuningCaseIds], testCaseIds: [...plan.splits.testCaseIds] }, arms: [...plan.arms], evidence: { ...evidence, armConfigSha256: { ...evidence.armConfigSha256 } } }; }
function only(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function sha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function timestamp(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : invalid(); }
function canonical(value: unknown): string { return JSON.stringify(value, (_key, item) => record(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item); }
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function invalid(): never { throw new Error("invalid_task_resume_preregistration"); }
