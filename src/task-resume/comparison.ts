/** A local, no-call comparison contract for task-continuation experiments. */
export const TASK_RESUME_COMPARISON_VERSION = 1 as const;
export const TASK_RESUME_COMPARISON_ARMS = ["no_long_term_memory", "simple_retrieval", "mnemora"] as const;
type ComparisonArm = typeof TASK_RESUME_COMPARISON_ARMS[number];
type Split = "tuning" | "test";

export interface TaskResumeComparisonPlan {
  version: typeof TASK_RESUME_COMPARISON_VERSION;
  id: string;
  status: "planned" | "measured";
  protocol: { modelId: string; historySetId: string; taskSetId: string; tokenBudget: number; latencyBudgetMs: number };
  splits: { tuningCaseIds: string[]; testCaseIds: string[] };
  arms: ComparisonArm[];
  results?: TaskResumeComparisonResult[];
}

export interface TaskResumeComparisonResult {
  caseId: string;
  split: Split;
  arm: ComparisonArm;
  continuationCorrect: boolean;
  staleFactUsed: boolean;
  repeatedStep: boolean;
  tokens: number;
  latencyMs: number;
  /** Optional because it must be reported only when a reviewer actually measured it. */
  manualReviewMs?: number;
}

export interface TaskResumeComparisonReport {
  version: typeof TASK_RESUME_COMPARISON_VERSION;
  id: string;
  status: "real_effect_experiment_not_run" | "measured";
  protocol: TaskResumeComparisonPlan["protocol"];
  arms: ComparisonArm[];
  splits: { tuningCases: number; testCases: number; testMetricsOnly: true };
  metrics?: Record<ComparisonArm, { cases: number; continuation_correctness: { successes: number; rate: number }; stale_fact_misuse: { count: number; rate: number }; repeated_steps: { count: number; rate: number }; tokens: { total: number; mean: number }; latency_ms: { total: number; mean: number }; manual_review_ms?: { cases: number; total: number; mean: number } }>;
  limitations: string[];
}

/**
 * Validates a deliberately de-identified experiment manifest. It never calls a
 * model, reads a production database, or turns a synthetic plan into evidence
 * that Mnemora improves a task.
 */
export class TaskResumeComparisonRunner {
  run(input: unknown): TaskResumeComparisonReport {
    const plan = validateTaskResumeComparisonPlan(input);
    const base = { version: TASK_RESUME_COMPARISON_VERSION, id: plan.id, protocol: plan.protocol, arms: [...plan.arms], splits: { tuningCases: plan.splits.tuningCaseIds.length, testCases: plan.splits.testCaseIds.length, testMetricsOnly: true as const } };
    if (plan.status === "planned") return { ...base, status: "real_effect_experiment_not_run", limitations: ["No authorized de-identified task results were supplied, so no effectiveness claim or task metric was computed.", "The comparison contract fixes model, history set, task set, budget, arms, and held-out test cases without making a model call."] };
    const testResults = plan.results!.filter(result => result.split === "test");
    return { ...base, status: "measured", metrics: Object.fromEntries(plan.arms.map(arm => [arm, metrics(testResults.filter(result => result.arm === arm))])) as TaskResumeComparisonReport["metrics"], limitations: ["Metrics describe the supplied held-out records only; they do not establish causal efficacy.", "Tuning records are validated for split isolation but excluded from reported test metrics."] };
  }
}

export function validateTaskResumeComparisonPlan(input: unknown): TaskResumeComparisonPlan {
  if (!record(input) || input.version !== TASK_RESUME_COMPARISON_VERSION || !identifier(input.id) || (input.status !== "planned" && input.status !== "measured") || !record(input.protocol) || !record(input.splits) || !Array.isArray(input.arms)) invalid();
  const protocol = input.protocol, modelId = boundedText(protocol.modelId, 256), historySetId = boundedText(protocol.historySetId, 128), taskSetId = boundedText(protocol.taskSetId, 128), tokenBudget = positive(protocol.tokenBudget, 1_000_000), latencyBudgetMs = positive(protocol.latencyBudgetMs, 3_600_000);
  if (!modelId || !historySetId || !taskSetId || tokenBudget === undefined || latencyBudgetMs === undefined) invalid();
  const tuningCaseIds = identifiers(input.splits.tuningCaseIds), testCaseIds = identifiers(input.splits.testCaseIds);
  if (!tuningCaseIds.length || !testCaseIds.length || tuningCaseIds.some(id => testCaseIds.includes(id))) invalid();
  const arms = [...new Set(input.arms)];
  if (arms.length !== TASK_RESUME_COMPARISON_ARMS.length || !arms.every(arm => typeof arm === "string" && (TASK_RESUME_COMPARISON_ARMS as readonly string[]).includes(arm))) invalid();
  const plan = { version: TASK_RESUME_COMPARISON_VERSION, id: input.id, status: input.status, protocol: { modelId, historySetId, taskSetId, tokenBudget, latencyBudgetMs }, splits: { tuningCaseIds, testCaseIds }, arms: TASK_RESUME_COMPARISON_ARMS.filter(arm => arms.includes(arm)) } as TaskResumeComparisonPlan;
  if (plan.status === "planned") {
    if (input.results !== undefined && (!Array.isArray(input.results) || input.results.length)) invalid();
    return plan;
  }
  if (!Array.isArray(input.results)) invalid();
  const validCases = new Set([...tuningCaseIds, ...testCaseIds]), expected = validCases.size * plan.arms.length, seen = new Set<string>();
  const results = input.results.map(value => result(value, validCases, new Set(tuningCaseIds), seen));
  if (results.length !== expected || seen.size !== expected) invalid();
  return { ...plan, results };
}

function result(value: unknown, validCases: Set<string>, tuningCases: Set<string>, seen: Set<string>): TaskResumeComparisonResult {
  if (!record(value) || !identifier(value.caseId) || !validCases.has(value.caseId) || (value.split !== "tuning" && value.split !== "test") || typeof value.arm !== "string" || !(TASK_RESUME_COMPARISON_ARMS as readonly string[]).includes(value.arm) || typeof value.continuationCorrect !== "boolean" || typeof value.staleFactUsed !== "boolean" || typeof value.repeatedStep !== "boolean") invalid();
  if ((value.split === "tuning") !== tuningCases.has(value.caseId)) invalid();
  const tokens = nonNegative(value.tokens, 10_000_000), latencyMs = nonNegative(value.latencyMs, 3_600_000), manualReviewMs = value.manualReviewMs === undefined ? undefined : nonNegative(value.manualReviewMs, 3_600_000);
  if (tokens === undefined || latencyMs === undefined || manualReviewMs === undefined && value.manualReviewMs !== undefined) invalid();
  const key = `${value.caseId}\0${value.arm}`;
  if (seen.has(key)) invalid();
  seen.add(key);
  return { caseId: value.caseId, split: value.split, arm: value.arm as ComparisonArm, continuationCorrect: value.continuationCorrect, staleFactUsed: value.staleFactUsed, repeatedStep: value.repeatedStep, tokens, latencyMs, ...(manualReviewMs === undefined ? {} : { manualReviewMs }) };
}

function metrics(results: TaskResumeComparisonResult[]) {
  const cases = results.length, count = (key: "continuationCorrect" | "staleFactUsed" | "repeatedStep") => results.filter(result => result[key]).length, total = (key: "tokens" | "latencyMs" | "manualReviewMs") => results.reduce((sum, result) => sum + (result[key] ?? 0), 0), review = results.filter(result => result.manualReviewMs !== undefined);
  return { cases, continuation_correctness: { successes: count("continuationCorrect"), rate: rate(count("continuationCorrect"), cases) }, stale_fact_misuse: { count: count("staleFactUsed"), rate: rate(count("staleFactUsed"), cases) }, repeated_steps: { count: count("repeatedStep"), rate: rate(count("repeatedStep"), cases) }, tokens: { total: total("tokens"), mean: mean(total("tokens"), cases) }, latency_ms: { total: total("latencyMs"), mean: mean(total("latencyMs"), cases) }, ...(review.length ? { manual_review_ms: { cases: review.length, total: total("manualReviewMs"), mean: mean(total("manualReviewMs"), review.length) } } : {}) };
}
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,79}$/.test(value); }
function identifiers(value: unknown): string[] { return Array.isArray(value) && value.length <= 1_000 && value.every(identifier) && new Set(value).size === value.length ? value : invalid(); }
function boundedText(value: unknown, maximum: number): string | undefined { return typeof value === "string" && value.trim() && Buffer.byteLength(value, "utf8") <= maximum ? value.trim() : undefined; }
function positive(value: unknown, maximum: number): number | undefined { return Number.isInteger(value) && Number(value) > 0 && Number(value) <= maximum ? Number(value) : undefined; }
function nonNegative(value: unknown, maximum: number): number | undefined { return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : undefined; }
function rate(value: number, total: number): number { return total ? value / total : 0; }
function mean(value: number, total: number): number { return total ? value / total : 0; }
function invalid(): never { throw new Error("invalid_task_resume_comparison_plan"); }
