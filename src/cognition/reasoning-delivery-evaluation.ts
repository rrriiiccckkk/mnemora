export const REASONING_DELIVERY_EFFECTIVENESS_DATASET_VERSION = "reasoning-delivery-effectiveness-v1" as const;
export type ReasoningDeliveryExperimentArm = "withheld" | "delivered";
export type ReasoningDeliveryExperimentOutcome = "success" | "failure" | "unknown";

export interface ReasoningDeliveryEffectivenessCase {
  caseId: string;
  arm: ReasoningDeliveryExperimentArm;
  outcome: ReasoningDeliveryExperimentOutcome;
  adopted?: boolean;
}

/**
 * De-identified operator evaluation input. It intentionally contains no task
 * text, strategy, source, session, memory identifier, or agent transcript.
 * `randomized` is required before a reported difference is called an estimate.
 */
export interface ReasoningDeliveryEffectivenessDataset {
  version: typeof REASONING_DELIVERY_EFFECTIVENESS_DATASET_VERSION;
  id: string;
  comparison: "randomized" | "observational";
  cases: ReasoningDeliveryEffectivenessCase[];
}

export interface ReasoningDeliveryArmMetrics {
  total: number;
  resolved: number;
  successes: number;
  failures: number;
  adopted: number;
  outcomeCoverage: number;
  successRate: number | null;
  adoptionRate: number;
}

export interface ReasoningDeliveryEffectivenessReport {
  version: "reasoning-delivery-effectiveness-report-v1";
  datasetId: string;
  comparison: "randomized" | "observational";
  minimumResolvedPerArm: number;
  delivered: ReasoningDeliveryArmMetrics;
  withheld: ReasoningDeliveryArmMetrics;
  successRateDifference: number | null;
  status: "measured" | "insufficient_evidence";
  reasons: string[];
  causalEstimateEligible: boolean;
}

const MINIMUM_RESOLVED_PER_ARM = 20;

/** Offline-only calculation for an operator-created A/B harness. It does not
 * persist data, select strategies, or alter delivery/governance behavior. */
export class ReasoningDeliveryEffectivenessEvaluationService {
  evaluate(input: ReasoningDeliveryEffectivenessDataset): ReasoningDeliveryEffectivenessReport {
    const dataset = validateReasoningDeliveryEffectivenessDataset(input);
    const delivered = metrics(dataset.cases.filter(value => value.arm === "delivered"));
    const withheld = metrics(dataset.cases.filter(value => value.arm === "withheld"));
    const reasons: string[] = [];
    if (dataset.comparison !== "randomized") reasons.push("observational_comparison");
    if (!delivered.total || !withheld.total) reasons.push("missing_comparison_arm");
    if (delivered.resolved < MINIMUM_RESOLVED_PER_ARM || withheld.resolved < MINIMUM_RESOLVED_PER_ARM) reasons.push("insufficient_resolved_outcomes");
    const causalEstimateEligible = reasons.length === 0;
    return {
      version: "reasoning-delivery-effectiveness-report-v1",
      datasetId: dataset.id,
      comparison: dataset.comparison,
      minimumResolvedPerArm: MINIMUM_RESOLVED_PER_ARM,
      delivered,
      withheld,
      successRateDifference: causalEstimateEligible && delivered.successRate != null && withheld.successRate != null ? round(delivered.successRate - withheld.successRate) : null,
      status: causalEstimateEligible ? "measured" : "insufficient_evidence",
      reasons,
      causalEstimateEligible
    };
  }
}

export function validateReasoningDeliveryEffectivenessDataset(value: unknown): ReasoningDeliveryEffectivenessDataset {
  const input = value as Partial<ReasoningDeliveryEffectivenessDataset> | undefined;
  if (!input || input.version !== REASONING_DELIVERY_EFFECTIVENESS_DATASET_VERSION || !identifier(input.id) || !["randomized", "observational"].includes(input.comparison ?? "") || !Array.isArray(input.cases) || input.cases.length < 1 || input.cases.length > 2_000) throw new Error("invalid_reasoning_delivery_effectiveness_dataset");
  const comparison: ReasoningDeliveryEffectivenessDataset["comparison"] = input.comparison === "randomized" ? "randomized" : "observational";
  const seen = new Set<string>(), cases: ReasoningDeliveryEffectivenessCase[] = [];
  for (const item of input.cases) {
    if (!item || Object.keys(item).some(key => !["caseId", "arm", "outcome", "adopted"].includes(key)) || !identifier(item.caseId) || seen.has(item.caseId) || !["withheld", "delivered"].includes(item.arm) || !["success", "failure", "unknown"].includes(item.outcome) || item.adopted !== undefined && typeof item.adopted !== "boolean") throw new Error("invalid_reasoning_delivery_effectiveness_dataset");
    seen.add(item.caseId); cases.push({ caseId: item.caseId, arm: item.arm, outcome: item.outcome, ...(item.adopted === true ? { adopted: true } : {}) });
  }
  return { version: REASONING_DELIVERY_EFFECTIVENESS_DATASET_VERSION, id: input.id, comparison, cases };
}

function metrics(cases: readonly ReasoningDeliveryEffectivenessCase[]): ReasoningDeliveryArmMetrics {
  const resolved = cases.filter(value => value.outcome !== "unknown"), successes = resolved.filter(value => value.outcome === "success").length, failures = resolved.length - successes, adopted = cases.filter(value => value.adopted === true).length;
  return { total: cases.length, resolved: resolved.length, successes, failures, adopted, outcomeCoverage: ratio(resolved.length, cases.length), successRate: resolved.length ? ratio(successes, resolved.length) : null, adoptionRate: ratio(adopted, cases.length) };
}
function identifier(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9][a-z0-9:_-]{0,79}$/i.test(value); }
function ratio(value: number, total: number): number { return total ? round(value / total) : 0; }
function round(value: number): number { return Number(value.toFixed(4)); }
