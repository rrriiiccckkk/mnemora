import assert from "node:assert/strict";
import { ReasoningDeliveryEffectivenessEvaluationService } from "../dist/index.js";

const cases = [
  ...Array.from({ length: 24 }, (_value, index) => ({ caseId: `control:${index}`, arm: "withheld", outcome: index < 12 ? "success" : "failure" })),
  ...Array.from({ length: 24 }, (_value, index) => ({ caseId: `delivery:${index}`, arm: "delivered", outcome: index < 18 ? "success" : "failure", adopted: index < 20 }))
];
const report = new ReasoningDeliveryEffectivenessEvaluationService().evaluate({ version: "reasoning-delivery-effectiveness-v1", id: "synthetic:reasoning-delivery-contract", comparison: "randomized", cases });
assert.deepEqual({ status: report.status, eligible: report.causalEstimateEligible, lift: report.successRateDifference, deliveredCoverage: report.delivered.outcomeCoverage, withheldCoverage: report.withheld.outcomeCoverage }, { status: "measured", eligible: true, lift: .25, deliveredCoverage: 1, withheldCoverage: 1 });
console.log(JSON.stringify({ benchmark: "reasoning-delivery-effectiveness-v1", evidence_kind: "synthetic_contract_only", release_claim: "none", report }, null, 2));
