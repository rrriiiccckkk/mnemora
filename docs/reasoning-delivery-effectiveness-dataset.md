# Reasoning delivery effectiveness dataset

`mnemora cognition reasoning runtime-effectiveness <dataset.json>` evaluates an
operator-created, de-identified comparison. It is offline-only: Mnemora does
not save the dataset or use it to change admission, retrieval, or delivery.

```json
{
  "version": "reasoning-delivery-effectiveness-v2",
  "id": "release:pilot-01",
  "comparison": "randomized",
  "evidenceKind": "operator_deidentified",
  "cases": [
    { "caseId": "control:001", "arm": "withheld", "outcome": "success" },
    { "caseId": "delivery:001", "arm": "delivered", "outcome": "success", "adopted": true }
  ]
}
```

Allowed case fields are exactly `caseId`, `arm`, `outcome`, and optional
`adopted`. `evidenceKind` is exactly `operator_deidentified` or
`synthetic_contract`. Do not include prompts, task descriptions, strategies,
sources, memory identifiers, session identifiers, or agent transcripts.

The evaluator returns a non-causal `point_estimate` only for an
operator-declared, de-identified randomized comparison with at least 20
resolved (`success` or `failure`) outcomes in each arm. The result includes a
conservative 95% interval for the success-rate difference; it is not a proof
of randomization, statistical significance, or causal effect. Otherwise it
returns `insufficient_evidence` and no difference. Synthetic-contract data,
observational data, and legacy v1 input can validate the harness but can never
produce an effectiveness estimate.

Version `reasoning-delivery-effectiveness-v1` remains readable for backwards
compatibility. It is treated as `unattested` and therefore always produces
`insufficient_evidence`; migrate it to v2 only when an operator can accurately
declare the dataset's evidence kind.
