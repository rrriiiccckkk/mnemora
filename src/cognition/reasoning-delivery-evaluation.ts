export const REASONING_DELIVERY_EFFECTIVENESS_DATASET_VERSION = "reasoning-delivery-effectiveness-v2" as const;
export const LEGACY_REASONING_DELIVERY_EFFECTIVENESS_DATASET_VERSION = "reasoning-delivery-effectiveness-v1" as const;
export type ReasoningDeliveryExperimentArm = "withheld" | "delivered";
export type ReasoningDeliveryExperimentOutcome = "success" | "failure" | "unknown";
export type ReasoningDeliveryDeclaredEvidenceKind = "operator_deidentified" | "synthetic_contract";
export type ReasoningDeliveryEvidenceKind = ReasoningDeliveryDeclaredEvidenceKind | "unattested";

export interface ReasoningDeliveryEffectivenessCase {
  caseId: string;
  arm: ReasoningDeliveryExperimentArm;
  outcome: ReasoningDeliveryExperimentOutcome;
  adopted?: boolean;
}

/** The v2 evidence declaration is an operator attestation, not proof of
 * randomization or a causal effect. v1 input remains readable but is
 * deliberately unattributed and cannot produce a point estimate. */
interface ReasoningDeliveryEffectivenessDatasetBase {
  id: string;
  comparison: "randomized" | "observational";
  cases: ReasoningDeliveryEffectivenessCase[];
}
export interface ReasoningDeliveryEffectivenessDatasetV2 extends ReasoningDeliveryEffectivenessDatasetBase {
  version: typeof REASONING_DELIVERY_EFFECTIVENESS_DATASET_VERSION;
  evidenceKind: ReasoningDeliveryDeclaredEvidenceKind;
}
export interface LegacyReasoningDeliveryEffectivenessDataset extends ReasoningDeliveryEffectivenessDatasetBase {
  version: typeof LEGACY_REASONING_DELIVERY_EFFECTIVENESS_DATASET_VERSION;
  /** Legacy files have no evidence declaration; they normalize to unattested. */
  evidenceKind?: never;
}
export type ReasoningDeliveryEffectivenessDataset = ReasoningDeliveryEffectivenessDatasetV2 | LegacyReasoningDeliveryEffectivenessDataset;
export interface NormalizedLegacyReasoningDeliveryEffectivenessDataset extends ReasoningDeliveryEffectivenessDatasetBase {
  version: typeof LEGACY_REASONING_DELIVERY_EFFECTIVENESS_DATASET_VERSION;
  evidenceKind: "unattested";
}
export type NormalizedReasoningDeliveryEffectivenessDataset = ReasoningDeliveryEffectivenessDatasetV2 | NormalizedLegacyReasoningDeliveryEffectivenessDataset;

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

export interface ReasoningDeliveryDifferenceInterval {
  confidenceLevel: .95;
  lower: number;
  upper: number;
}

export interface ReasoningDeliveryEffectivenessReport {
  version: "reasoning-delivery-effectiveness-report-v2";
  datasetId: string;
  comparison: "randomized" | "observational";
  evidenceKind: ReasoningDeliveryEvidenceKind;
  minimumResolvedPerArm: number;
  delivered: ReasoningDeliveryArmMetrics;
  withheld: ReasoningDeliveryArmMetrics;
  successRateDifference: number | null;
  successRateDifferenceInterval95: ReasoningDeliveryDifferenceInterval | null;
  status: "point_estimate" | "insufficient_evidence";
  reasons: string[];
  pointEstimateEligible: boolean;
  /** Retained as an explicit safety signal for v1 callers: this local,
   * self-declared dataset evaluator never establishes causality. */
  causalEstimateEligible: false;
}

const MINIMUM_RESOLVED_PER_ARM = 20;

/** Offline-only calculation for an operator-created A/B harness. It does not
 * persist data, select strategies, or alter delivery/governance behavior. */
export class ReasoningDeliveryEffectivenessEvaluationService {
  evaluate(input: ReasoningDeliveryEffectivenessDataset | NormalizedReasoningDeliveryEffectivenessDataset): ReasoningDeliveryEffectivenessReport {
    const dataset = validateReasoningDeliveryEffectivenessDataset(input);
    const delivered = metrics(dataset.cases.filter(value => value.arm === "delivered"));
    const withheld = metrics(dataset.cases.filter(value => value.arm === "withheld"));
    const reasons: string[] = [];
    if (dataset.evidenceKind === "synthetic_contract") reasons.push("synthetic_dataset");
    if (dataset.evidenceKind === "unattested") reasons.push("unattested_evidence_kind");
    if (dataset.comparison !== "randomized") reasons.push("observational_comparison");
    if (!delivered.total || !withheld.total) reasons.push("missing_comparison_arm");
    if (delivered.resolved < MINIMUM_RESOLVED_PER_ARM || withheld.resolved < MINIMUM_RESOLVED_PER_ARM) reasons.push("insufficient_resolved_outcomes");
    const pointEstimateEligible = reasons.length === 0, difference = pointEstimateEligible && delivered.successRate != null && withheld.successRate != null ? round(delivered.successRate - withheld.successRate) : null;
    return {
      version: "reasoning-delivery-effectiveness-report-v2",
      datasetId: dataset.id,
      comparison: dataset.comparison,
      evidenceKind: dataset.evidenceKind,
      minimumResolvedPerArm: MINIMUM_RESOLVED_PER_ARM,
      delivered,
      withheld,
      successRateDifference: difference,
      successRateDifferenceInterval95: difference == null ? null : differenceInterval(delivered.successes, delivered.resolved, withheld.successes, withheld.resolved),
      status: pointEstimateEligible ? "point_estimate" : "insufficient_evidence",
      reasons,
      pointEstimateEligible,
      causalEstimateEligible: false
    };
  }
}

export function validateReasoningDeliveryEffectivenessDataset(value: unknown): NormalizedReasoningDeliveryEffectivenessDataset {
  const input = value as { version?: unknown; id?: unknown; comparison?: unknown; evidenceKind?: unknown; cases?: unknown } | undefined, legacy = input?.version === LEGACY_REASONING_DELIVERY_EFFECTIVENESS_DATASET_VERSION;
  const allowed = legacy ? ["version", "id", "comparison", "cases"] : ["version", "id", "comparison", "evidenceKind", "cases"];
  if (!input || ![REASONING_DELIVERY_EFFECTIVENESS_DATASET_VERSION, LEGACY_REASONING_DELIVERY_EFFECTIVENESS_DATASET_VERSION].includes(input.version as typeof REASONING_DELIVERY_EFFECTIVENESS_DATASET_VERSION) || Object.keys(input).some(key => !allowed.includes(key)) || !identifier(input.id) || !["randomized", "observational"].includes(String(input.comparison ?? "")) || !Array.isArray(input.cases) || input.cases.length < 1 || input.cases.length > 2_000 || !legacy && !["operator_deidentified", "synthetic_contract"].includes(String(input.evidenceKind ?? ""))) throw new Error("invalid_reasoning_delivery_effectiveness_dataset");
  const comparison: ReasoningDeliveryEffectivenessDatasetBase["comparison"] = input.comparison === "randomized" ? "randomized" : "observational";
  const seen = new Set<string>(), cases: ReasoningDeliveryEffectivenessCase[] = [];
  for (const item of input.cases) {
    if (!item || Object.keys(item).some(key => !["caseId", "arm", "outcome", "adopted"].includes(key)) || !identifier(item.caseId) || seen.has(item.caseId) || !["withheld", "delivered"].includes(item.arm) || !["success", "failure", "unknown"].includes(item.outcome) || item.adopted !== undefined && typeof item.adopted !== "boolean") throw new Error("invalid_reasoning_delivery_effectiveness_dataset");
    seen.add(item.caseId); cases.push({ caseId: item.caseId, arm: item.arm, outcome: item.outcome, ...(item.adopted === true ? { adopted: true } : {}) });
  }
  if (legacy) return { version: LEGACY_REASONING_DELIVERY_EFFECTIVENESS_DATASET_VERSION, id: input.id, comparison, evidenceKind: "unattested", cases };
  return { version: REASONING_DELIVERY_EFFECTIVENESS_DATASET_VERSION, id: input.id, comparison, evidenceKind: input.evidenceKind === "operator_deidentified" ? "operator_deidentified" : "synthetic_contract", cases };
}

function metrics(cases: readonly ReasoningDeliveryEffectivenessCase[]): ReasoningDeliveryArmMetrics {
  const resolved = cases.filter(value => value.outcome !== "unknown"), successes = resolved.filter(value => value.outcome === "success").length, failures = resolved.length - successes, adopted = cases.filter(value => value.adopted === true).length;
  return { total: cases.length, resolved: resolved.length, successes, failures, adopted, outcomeCoverage: ratio(resolved.length, cases.length), successRate: resolved.length ? ratio(successes, resolved.length) : null, adoptionRate: ratio(adopted, cases.length) };
}
function differenceInterval(deliveredSuccesses: number, deliveredTotal: number, withheldSuccesses: number, withheldTotal: number): ReasoningDeliveryDifferenceInterval {
  const delivered = wilson(deliveredSuccesses, deliveredTotal), withheld = wilson(withheldSuccesses, withheldTotal);
  return { confidenceLevel: .95, lower: round(delivered.lower - withheld.upper), upper: round(delivered.upper - withheld.lower) };
}
function wilson(successes: number, total: number): { lower: number; upper: number } {
  const z = 1.959963984540054, p = successes / total, denominator = 1 + z * z / total, centre = (p + z * z / (2 * total)) / denominator, spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return { lower: Math.max(0, centre - spread), upper: Math.min(1, centre + spread) };
}
function identifier(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9][a-z0-9:_-]{0,79}$/i.test(value); }
function ratio(value: number, total: number): number { return total ? round(value / total) : 0; }
function round(value: number): number { return Number(value.toFixed(4)); }
