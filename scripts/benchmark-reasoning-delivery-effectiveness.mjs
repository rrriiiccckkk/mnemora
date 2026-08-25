import assert from "node:assert/strict";
import { ReasoningDeliveryEffectivenessEvaluationService } from "../dist/index.js";

const cases = [
  ...Array.from({ length: 24 }, (_value, index) => ({ caseId: `control:${index}`, arm: "withheld", outcome: index < 12 ? "success" : "failure" })),
  ...Array.from({ length: 24 }, (_value, index) => ({ caseId: `delivery:${index}`, arm: "delivered", outcome: index < 18 ? "success" : "failure", adopted: index < 20 }))
];
const report = new ReasoningDeliveryEffectivenessEvaluationService().evaluate({ version: "reasoning-delivery-effectiveness-v2", id: "synthetic:reasoning-delivery-contract", comparison: "randomized", evidenceKind: "synthetic_contract", cases });
assert.deepEqual({ status: report.status, eligible: report.pointEstimateEligible, causal: report.causalEstimateEligible, lift: report.successRateDifference, deliveredCoverage: report.delivered.outcomeCoverage, withheldCoverage: report.withheld.outcomeCoverage }, { status: "insufficient_evidence", eligible: false, causal: false, lift: null, deliveredCoverage: 1, withheldCoverage: 1 });
console.log(JSON.stringify({ benchmark: "reasoning-delivery-effectiveness-v2", evidence_kind: "synthetic_contract_only", release_claim: "none", report }, null, 2));
