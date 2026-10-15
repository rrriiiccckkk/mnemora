import { createHash } from "node:crypto";

/** Offline independent labels and measured paired outcomes; never changes runtime policy. */
export interface RelevanceEvaluationPlan {
  version: 1;
  evidence: "synthetic" | "independent_review";
  policy: "recall-relevance-shadow-v1";
  tuningCaseIds: string[];
  testCaseIds: string[];
  limits: { minTestCases: number; maxHarmfulDeletionRate: number; maxRecallLoss: number; maxTaskCompletionLoss: number; minNetSaving: number };
}
export interface RelevanceEvaluationCase {
  id: string;
  /** Includes relevant references missed by the original retrieval. */
  relevant: string[];
  original: string[];
  suggested: string[];
  task: { originalCompleted: boolean; suggestedCompleted: boolean } | null;
  /** Same monetary unit, paired task totals excluding separately accounted overhead. */
  cost: { original: number; suggested: number; adjudication: number; retry: number; remediation: number } | null;
}
const fail = (): never => { throw new Error("Invalid recall relevance evaluation input"); };
const uniqueIds = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 10000 && v.every(x => typeof x === "string" && /^[a-zA-Z0-9:_/-]{1,160}$/.test(x)) && new Set(v).size === v.length;
const rate = (n: number, d: number) => d ? n / d : null;

export function evaluateRecallRelevance(plan: RelevanceEvaluationPlan, cases: RelevanceEvaluationCase[]) {
  if (!plan || plan.version !== 1 || !["synthetic", "independent_review"].includes(plan.evidence) || plan.policy !== "recall-relevance-shadow-v1" || !uniqueIds(plan.tuningCaseIds) || !uniqueIds(plan.testCaseIds) || !plan.testCaseIds.length || plan.tuningCaseIds.some(id => plan.testCaseIds.includes(id))) fail();
  const limits = plan.limits;
  if (!limits || !Number.isSafeInteger(limits.minTestCases) || limits.minTestCases < 2 || limits.minTestCases > 10000 || ![limits.maxHarmfulDeletionRate, limits.maxRecallLoss, limits.maxTaskCompletionLoss].every(n => Number.isFinite(n) && n >= 0 && n <= 1) || !Number.isFinite(limits.minNetSaving) || limits.minNetSaving < 0) fail();
  if (!Array.isArray(cases) || !uniqueIds(cases.map(c => c?.id))) fail();
  const expected = new Set([...plan.tuningCaseIds, ...plan.testCaseIds]);
  if (cases.length !== expected.size || cases.some(c => !expected.has(c.id))) fail();
  for (const c of cases) {
    if (![c.relevant, c.original, c.suggested].every(uniqueIds) || c.suggested.some(ref => !c.original.includes(ref))) fail();
    if (c.task !== null && (!c.task || typeof c.task.originalCompleted !== "boolean" || typeof c.task.suggestedCompleted !== "boolean")) fail();
    if (c.cost !== null && (!c.cost || ![c.cost.original, c.cost.suggested, c.cost.adjudication, c.cost.retry, c.cost.remediation].every(n => Number.isFinite(n) && n >= 0 && n <= 1e12))) fail();
  }
  // Freeze the preregistration digest; do not choose or tune a threshold from test labels.
  const planHash = createHash("sha256").update(JSON.stringify({ version: plan.version, evidence: plan.evidence, policy: plan.policy, tuningCaseIds: [...plan.tuningCaseIds].sort(), testCaseIds: [...plan.testCaseIds].sort(), limits: { minTestCases: limits.minTestCases, maxHarmfulDeletionRate: limits.maxHarmfulDeletionRate, maxRecallLoss: limits.maxRecallLoss, maxTaskCompletionLoss: limits.maxTaskCompletionLoss, minNetSaving: limits.minNetSaving } })).digest("hex");
  const selected = cases.filter(c => plan.testCaseIds.includes(c.id));
  let relevant = 0, baselineRelevant = 0, suggestedRelevant = 0, harmful = 0, removed = 0, originalNoise = 0, suggestedNoise = 0, originalCompleted = 0, suggestedCompleted = 0, taskKnown = 0, costKnown = 0, netSaving = 0;
  for (const c of selected) {
    const gold = new Set(c.relevant), suggestion = new Set(c.suggested);
    relevant += gold.size;
    baselineRelevant += c.original.filter(r => gold.has(r)).length;
    suggestedRelevant += c.suggested.filter(r => gold.has(r)).length;
    const deleted = c.original.filter(r => !suggestion.has(r));
    removed += deleted.length; harmful += deleted.filter(r => gold.has(r)).length;
    originalNoise += c.original.filter(r => !gold.has(r)).length;
    suggestedNoise += c.suggested.filter(r => !gold.has(r)).length;
    if (c.task) { taskKnown++; originalCompleted += Number(c.task.originalCompleted); suggestedCompleted += Number(c.task.suggestedCompleted); }
    if (c.cost) { costKnown++; netSaving += c.cost.original - c.cost.suggested - c.cost.adjudication - c.cost.retry - c.cost.remediation; }
  }
  const completeTasks = taskKnown === selected.length, completeCosts = costKnown === selected.length;
  const reasons: string[] = [];
  if (plan.evidence !== "independent_review") reasons.push("independent_labels_missing");
  if (selected.length < limits.minTestCases) reasons.push("insufficient_test_cases");
  if (!relevant || !baselineRelevant || !originalNoise) reasons.push("insufficient_positive_or_negative_coverage");
  if (!completeTasks) reasons.push("task_outcomes_missing");
  if (!completeCosts) reasons.push("complete_costs_missing");
  if (baselineRelevant && harmful / baselineRelevant > limits.maxHarmfulDeletionRate) reasons.push("harmful_deletion_limit");
  if (relevant && (baselineRelevant - suggestedRelevant) / relevant > limits.maxRecallLoss) reasons.push("recall_loss_limit");
  if (completeTasks && (originalCompleted - suggestedCompleted) / selected.length > limits.maxTaskCompletionLoss) reasons.push("task_completion_loss_limit");
  if (completeCosts && netSaving < limits.minNetSaving) reasons.push("net_saving_limit");
  return {
    version: 1, task: "recall_relevance", policy: plan.policy, planHash, evidence: plan.evidence,
    testCases: selected.length, tuningCasesExcluded: plan.tuningCaseIds.length,
    metrics: { harmfulDeletionRate: rate(harmful, baselineRelevant), removalErrorRate: rate(harmful, removed), originalMisses: relevant - baselineRelevant, suggestedMisses: relevant - suggestedRelevant, originalRecall: rate(baselineRelevant, relevant), suggestedRecall: rate(suggestedRelevant, relevant), originalNoise, suggestedNoise, harmfulDeletions: harmful, removed, taskCompletion: completeTasks ? { original: originalCompleted / selected.length, suggested: suggestedCompleted / selected.length } : null, netSaving: completeCosts ? netSaving : null, taskMeasuredCases: taskKnown, costMeasuredCases: costKnown },
    gate: { status: reasons.length ? "withheld" : "eligible_for_review", reasons, deploymentApproval: "not_granted" },
  };
}
