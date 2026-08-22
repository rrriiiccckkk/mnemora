import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { ReasoningRuntimeService, type ReasoningRuntimeTaskContext } from "./reasoning-runtime.js";

export interface ReasoningRuntimeEvaluationCase extends ReasoningRuntimeTaskContext {
  caseId: string;
  expectedRetrieve: boolean;
  expectedMemoryIds?: string[];
  forbiddenMemoryIds?: string[];
}
export interface ReasoningRuntimeEvaluationMetrics {
  triggerPrecision: number;
  triggerRecall: number;
  retrievalPrecision: number;
  retrievalRecall: number;
  irrelevantInjectionRate: number;
  emptyRecallPrecision: number;
  usefulTokenRatio: number;
  crossScopeLeakage: number;
}
export interface ReasoningRuntimeEvaluationReport {
  version: "reasoning-runtime-evaluation-v1";
  cases: number;
  metrics: ReasoningRuntimeEvaluationMetrics;
  passed: boolean;
  failures: Array<{ caseId: string; reasons: string[] }>;
}

/** Offline/read-only release evaluation. Queries and memory content are never returned or persisted. */
export class ReasoningRuntimeEvaluationService {
  private readonly runtime: ReasoningRuntimeService;
  constructor(db: DatabaseSyncInstance) { this.runtime = new ReasoningRuntimeService(db); }

  run(cases: readonly ReasoningRuntimeEvaluationCase[]): ReasoningRuntimeEvaluationReport {
    if (!Array.isArray(cases) || cases.length < 1 || cases.length > 100) throw new Error("invalid_reasoning_runtime_evaluation");
    let truePositive = 0, falsePositive = 0, falseNegative = 0, selected = 0, relevantSelected = 0, expectedRelevant = 0, irrelevant = 0, emptyCases = 0, correctEmpty = 0, usefulTokens = 0, selectedTokens = 0, crossScopeLeakage = 0;
    const failures: ReasoningRuntimeEvaluationReport["failures"] = [];
    for (const scenario of cases) {
      validate(scenario);
      const expected = new Set(scenario.expectedMemoryIds ?? []), forbidden = new Set(scenario.forbiddenMemoryIds ?? []), result = this.runtime.prepare(scenario), triggered = result.decision.shouldRetrieve, items = result.context?.items ?? [], reasons: string[] = [];
      if (scenario.expectedRetrieve && triggered) truePositive++;
      else if (!scenario.expectedRetrieve && triggered) { falsePositive++; reasons.push("trigger_false_positive"); }
      else if (scenario.expectedRetrieve && !triggered) { falseNegative++; reasons.push("trigger_false_negative"); }
      expectedRelevant += expected.size;
      if (expected.size === 0) { emptyCases++; if (items.length === 0) correctEmpty++; else reasons.push("unexpected_non_empty_recall"); }
      for (const item of items) {
        selected++; selectedTokens += item.estimatedTokens;
        if (expected.has(item.id)) { relevantSelected++; usefulTokens += item.estimatedTokens; }
        else { irrelevant++; reasons.push("irrelevant_memory_selected"); }
        if (forbidden.has(item.id)) { crossScopeLeakage++; reasons.push("cross_scope_memory_selected"); }
      }
      if (expected.size && [...expected].some(id => !items.some(item => item.id === id))) reasons.push("relevant_memory_missed");
      if (reasons.length && failures.length < 50) failures.push({ caseId: scenario.caseId, reasons: [...new Set(reasons)] });
    }
    const metrics = {
      triggerPrecision: ratio(truePositive, truePositive + falsePositive, 1), triggerRecall: ratio(truePositive, truePositive + falseNegative, 1),
      retrievalPrecision: ratio(relevantSelected, selected, 1), retrievalRecall: ratio(relevantSelected, expectedRelevant, 1), irrelevantInjectionRate: ratio(irrelevant, selected, 0),
      emptyRecallPrecision: ratio(correctEmpty, emptyCases, 1), usefulTokenRatio: ratio(usefulTokens, selectedTokens, 1), crossScopeLeakage
    };
    const passed = falsePositive === 0 && falseNegative === 0 && metrics.retrievalPrecision === 1 && metrics.retrievalRecall === 1 && metrics.irrelevantInjectionRate === 0 && metrics.emptyRecallPrecision === 1 && metrics.usefulTokenRatio === 1 && metrics.crossScopeLeakage === 0;
    return { version: "reasoning-runtime-evaluation-v1", cases: cases.length, metrics, passed, failures };
  }
}

function validate(value: ReasoningRuntimeEvaluationCase): void {
  if (!value || !/^[a-z0-9][a-z0-9:_-]{0,79}$/i.test(value.caseId) || typeof value.expectedRetrieve !== "boolean") throw new Error("invalid_reasoning_runtime_evaluation");
  for (const list of [value.expectedMemoryIds, value.forbiddenMemoryIds]) if (list !== undefined && (!Array.isArray(list) || list.length > 50 || list.some(id => typeof id !== "string" || id.length < 1 || id.length > 200))) throw new Error("invalid_reasoning_runtime_evaluation");
}
function ratio(value: number, total: number, fallback: number): number { return total ? Number((value / total).toFixed(4)) : fallback; }
