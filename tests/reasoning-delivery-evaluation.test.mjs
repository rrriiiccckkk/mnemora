import assert from "node:assert/strict";
import test from "node:test";
import { ReasoningDeliveryEffectivenessEvaluationService, validateReasoningDeliveryEffectivenessDataset } from "../dist/cognition/reasoning-delivery-evaluation.js";

const service = new ReasoningDeliveryEffectivenessEvaluationService();
const cases = (arm, successes, failures, unknown = 0) => [
  ...Array.from({ length: successes }, (_value, index) => ({ caseId: `${arm}:success:${index}`, arm, outcome: "success", adopted: arm === "delivered" })),
  ...Array.from({ length: failures }, (_value, index) => ({ caseId: `${arm}:failure:${index}`, arm, outcome: "failure" })),
  ...Array.from({ length: unknown }, (_value, index) => ({ caseId: `${arm}:unknown:${index}`, arm, outcome: "unknown" }))
];

test("delivery effectiveness reports an explicitly non-causal point estimate with a conservative interval", () => {
  const report = service.evaluate({ version: "reasoning-delivery-effectiveness-v2", id: "fixture:randomized", comparison: "randomized", evidenceKind: "operator_deidentified", cases: [...cases("withheld", 12, 8), ...cases("delivered", 16, 4)] });
  assert.deepEqual({ status: report.status, eligible: report.pointEstimateEligible, causal: report.causalEstimateEligible, lift: report.successRateDifference, adopted: report.delivered.adopted }, { status: "point_estimate", eligible: true, causal: false, lift: .2, adopted: 16 });
  assert.equal(report.successRateDifferenceInterval95.lower < .2 && report.successRateDifferenceInterval95.upper > .2, true);
});

test("delivery effectiveness refuses estimates for synthetic, legacy, sparse, or observational evidence", () => {
  const observational = service.evaluate({ version: "reasoning-delivery-effectiveness-v2", id: "fixture:observational", comparison: "observational", evidenceKind: "operator_deidentified", cases: [...cases("withheld", 20, 0), ...cases("delivered", 20, 0)] });
  assert.deepEqual({ status: observational.status, lift: observational.successRateDifference, reasons: observational.reasons }, { status: "insufficient_evidence", lift: null, reasons: ["observational_comparison"] });
  const sparse = service.evaluate({ version: "reasoning-delivery-effectiveness-v2", id: "fixture:sparse", comparison: "randomized", evidenceKind: "operator_deidentified", cases: [...cases("withheld", 1, 0), ...cases("delivered", 1, 0)] });
  assert.equal(sparse.reasons.includes("insufficient_resolved_outcomes"), true);
  const synthetic = service.evaluate({ version: "reasoning-delivery-effectiveness-v2", id: "fixture:synthetic", comparison: "randomized", evidenceKind: "synthetic_contract", cases: [...cases("withheld", 20, 0), ...cases("delivered", 20, 0)] });
  assert.deepEqual({ status: synthetic.status, lift: synthetic.successRateDifference, reasons: synthetic.reasons }, { status: "insufficient_evidence", lift: null, reasons: ["synthetic_dataset"] });
  const legacy = service.evaluate({ version: "reasoning-delivery-effectiveness-v1", id: "fixture:legacy", comparison: "randomized", cases: [...cases("withheld", 20, 0), ...cases("delivered", 20, 0)] });
  assert.equal(legacy.reasons.includes("unattested_evidence_kind"), true);
  assert.equal(validateReasoningDeliveryEffectivenessDataset({ version: "reasoning-delivery-effectiveness-v1", id: "fixture:legacy-normalized", comparison: "randomized", cases: [...cases("withheld", 1, 0), ...cases("delivered", 1, 0)] }).evidenceKind, "unattested");
});

test("delivery effectiveness input is bounded and contains no raw task or strategy field", () => {
  assert.throws(() => validateReasoningDeliveryEffectivenessDataset({ version: "reasoning-delivery-effectiveness-v2", id: "fixture:bad", comparison: "randomized", evidenceKind: "operator_deidentified", cases: [{ caseId: "a", arm: "delivered", outcome: "success", query: "private task" }] }), /invalid_reasoning_delivery_effectiveness_dataset/);
  assert.throws(() => validateReasoningDeliveryEffectivenessDataset({ version: "reasoning-delivery-effectiveness-v2", id: "fixture:bad", comparison: "randomized", cases: [{ caseId: "a", arm: "delivered", outcome: "success" }, { caseId: "a", arm: "withheld", outcome: "failure" }] }), /invalid_reasoning_delivery_effectiveness_dataset/);
  assert.throws(() => validateReasoningDeliveryEffectivenessDataset({ version: "reasoning-delivery-effectiveness-v2", id: "fixture:bad", comparison: "randomized", cases: [{ caseId: "a", arm: "delivered", outcome: "success" }] }), /invalid_reasoning_delivery_effectiveness_dataset/);
});
