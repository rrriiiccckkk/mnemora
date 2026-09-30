import { createHash } from "node:crypto";
import { validateEvaluationDataset } from "./dataset-repository.js";
import { EvaluationRunner } from "./evaluation-runner.js";
import type { EvaluationDataset, EvaluationMetrics, EvaluationReport, EvaluationSubject } from "./types.js";

export interface RecallThresholdScanPlan {
  version: 1;
  evidenceKind: "synthetic" | "operator_reviewed";
  parameter: "unified.hardMinScore";
  thresholds: number[];
  tokenBudget: number;
  candidateLimit: number;
  operationTimeoutMs: number;
  deadlineMs: number;
  selection: { minPrecision: number; minRecall: number; maxP95LatencyMs: number };
  tuning: EvaluationDataset;
  test: EvaluationDataset;
}
interface ScanPoint { threshold: number; f1: number; healthy: boolean; negativeControlsPassed: boolean; metrics: EvaluationMetrics; }
export type RecallThresholdSubjectConfig = Readonly<Pick<RecallThresholdScanPlan, "parameter" | "tokenBudget" | "candidateLimit">>;
export interface RecallThresholdScanReport {
  version: "recall-threshold-scan-v1";
  planHash: string;
  parameter: "unified.hardMinScore";
  evidenceKind: RecallThresholdScanPlan["evidenceKind"];
  tuningCurve: ScanPoint[];
  selection: { status: "selected_for_test" | "withheld"; threshold?: number; rule: "f1_then_estimated_tokens_then_higher_threshold" };
  test?: ScanPoint;
  review: { status: "reviewable" | "withheld"; reasons: string[]; deploymentApproval: "not_granted" };
  automatedPolicyChange: "not_performed";
}

/** Selection sees tuning only. A held-out failure cannot trigger reselection.
 * Subjects must apply the threshold before their existing candidate/budget
 * packing; filtering an already truncated retrieval result is not equivalent. */
export class RecallThresholdScanRunner {
  constructor(private readonly subject: (threshold: number, config: RecallThresholdSubjectConfig) => EvaluationSubject) {}
  async run(input: unknown, options: { signal?: AbortSignal } = {}): Promise<RecallThresholdScanReport> {
    const plan = validateRecallThresholdScanPlan(input), planHash = digest(plan), deadline = performance.now() + plan.deadlineMs;
    const tuningCurve: ScanPoint[] = [];
    const evaluate = async (threshold: number, dataset: EvaluationDataset): Promise<ScanPoint | undefined> => {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining < 10 || options.signal?.aborted) return undefined;
      const config = Object.freeze({ parameter: plan.parameter, tokenBudget: plan.tokenBudget, candidateLimit: plan.candidateLimit });
      let subject: EvaluationSubject;
      try { subject = this.subject(threshold, config); }
      catch { subject = { async find() { throw new Error("adapter_initialization_failed"); } }; }
      const result = await new EvaluationRunner(subject).run(dataset, {
        caseLimit: dataset.cases.length, candidateLimit: plan.candidateLimit,
        operationTimeoutMs: plan.operationTimeoutMs, deadlineMs: remaining, signal: options.signal
      });
      return point(threshold, result);
    };
    for (const threshold of plan.thresholds) {
      const result = await evaluate(threshold, plan.tuning);
      if (!result) break;
      tuningCurve.push(result);
    }
    const complete = tuningCurve.length === plan.thresholds.length && tuningCurve.every(item => item.healthy);
    const eligible = complete ? tuningCurve.filter(item => meetsPolicy(item, plan)).sort((a, b) => b.f1 - a.f1 || a.metrics.selectedTokens.average - b.metrics.selectedTokens.average || b.threshold - a.threshold) : [];
    const chosen = eligible[0];
    const selection: RecallThresholdScanReport["selection"] = { status: chosen ? "selected_for_test" : "withheld", ...(chosen ? { threshold: chosen.threshold } : {}), rule: "f1_then_estimated_tokens_then_higher_threshold" };
    const test = chosen ? await evaluate(chosen.threshold, plan.test) : undefined;
    const reasons: string[] = [];
    if (!complete) reasons.push("incomplete_or_unsafe_tuning");
    if (!chosen) reasons.push("no_eligible_threshold");
    if (chosen && (!test || !test.healthy)) reasons.push("incomplete_or_unsafe_test");
    else if (test && !meetsPolicy(test, plan)) reasons.push("held_out_policy_failed");
    if (plan.evidenceKind === "synthetic") reasons.push("synthetic_evidence");
    // A minimum is a coverage guard, not a statistical power claim.
    if ([plan.tuning, plan.test].some(dataset => dataset.cases.length < 5 || dataset.cases.filter(item => item.expectedRefs.length > 0).length < 2)) reasons.push("insufficient_cases");
    return {
      version: "recall-threshold-scan-v1", planHash, parameter: plan.parameter, evidenceKind: plan.evidenceKind,
      tuningCurve, selection, ...(test ? { test } : {}),
      review: { status: reasons.length ? "withheld" : "reviewable", reasons, deploymentApproval: "not_granted" },
      automatedPolicyChange: "not_performed"
    };
  }
}

export function validateRecallThresholdScanPlan(input: unknown): RecallThresholdScanPlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const value = input as Record<string, unknown>;
  const keys = ["version", "evidenceKind", "parameter", "thresholds", "tokenBudget", "candidateLimit", "operationTimeoutMs", "deadlineMs", "selection", "tuning", "test"];
  if (Object.keys(value).some(key => !keys.includes(key)) || value.version !== 1 || !["synthetic", "operator_reviewed"].includes(String(value.evidenceKind)) || value.parameter !== "unified.hardMinScore") invalid();
  if (!Array.isArray(value.thresholds) || value.thresholds.length < 2 || value.thresholds.length > 21 || value.thresholds.some(item => !unit(item)) || new Set(value.thresholds).size !== value.thresholds.length) invalid();
  if (!integer(value.tokenBudget, 64, 8000) || !integer(value.candidateLimit, 1, 20) || !integer(value.operationTimeoutMs, 10, 60000) || !integer(value.deadlineMs, 10, 300000)) invalid();
  const selection = value.selection as RecallThresholdScanPlan["selection"];
  if (!selection || typeof selection !== "object" || Array.isArray(selection) || Object.keys(selection).some(key => !["minPrecision", "minRecall", "maxP95LatencyMs"].includes(key)) || !unit(selection.minPrecision) || !unit(selection.minRecall) || !integer(selection.maxP95LatencyMs, 1, 300000)) invalid();
  let tuning: EvaluationDataset, test: EvaluationDataset;
  try { tuning = validateEvaluationDataset(value.tuning as EvaluationDataset); test = validateEvaluationDataset(value.test as EvaluationDataset); }
  catch { return invalid(); }
  if (tuning.id === test.id || [tuning, test].some(dataset => dataset.cases.length < 2 || dataset.cases.length > 100 || !dataset.cases.some(item => item.expectedRefs.length > 0) || !dataset.cases.some(item => item.expectedRefs.length === 0 && (item.kind === "empty_recall" || item.kind === "scope_isolation")) || dataset.cases.some(item => item.query.trim().length > 512) || new Set(dataset.cases.map(caseIdentity)).size !== dataset.cases.length)) invalid();
  const ids = new Set(tuning.cases.map(item => item.id)), queries = new Set(tuning.cases.map(caseIdentity));
  if (test.cases.some(item => ids.has(item.id) || queries.has(caseIdentity(item)))) invalid();
  return {
    version: 1, evidenceKind: value.evidenceKind as RecallThresholdScanPlan["evidenceKind"], parameter: "unified.hardMinScore",
    thresholds: [...value.thresholds as number[]].sort((a, b) => a - b), tokenBudget: value.tokenBudget as number,
    candidateLimit: value.candidateLimit as number, operationTimeoutMs: value.operationTimeoutMs as number, deadlineMs: value.deadlineMs as number,
    selection: { minPrecision: selection.minPrecision, minRecall: selection.minRecall, maxP95LatencyMs: selection.maxP95LatencyMs }, tuning, test
  };
}
function point(threshold: number, report: EvaluationReport): ScanPoint {
  const { precisionAtK: precision, recallAtK: recall } = report.metrics;
  return { threshold, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
    healthy: report.metrics.failed === 0 && report.results.every(item => item.invalidReferences === 0 && item.crossScopeReturned === 0 && item.forbiddenReturned === 0),
    negativeControlsPassed: report.results.filter(item => item.expected === 0).every(item => item.status === "succeeded" && item.returned === 0), metrics: report.metrics };
}
function meetsPolicy(point: ScanPoint, plan: RecallThresholdScanPlan): boolean {
  return point.healthy && point.negativeControlsPassed && point.metrics.precisionAtK >= plan.selection.minPrecision && point.metrics.recallAtK >= plan.selection.minRecall
    && point.metrics.selectedTokens.maximum <= plan.tokenBudget && point.metrics.latencyMs.p95 <= plan.selection.maxP95LatencyMs;
}
const integer = (value: unknown, min: number, max: number): boolean => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const unit = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const caseIdentity = (value: EvaluationDataset["cases"][number]) => digest([value.scope, value.query.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase()]);
function invalid(): never { throw new Error("invalid_recall_threshold_scan_plan"); }
