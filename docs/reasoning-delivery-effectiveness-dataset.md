# Reasoning delivery effectiveness dataset

`mnemora cognition reasoning runtime-effectiveness <dataset.json>` evaluates an
operator-created, de-identified comparison. It is offline-only: Mnemora does
not save the dataset or use it to change admission, retrieval, or delivery.

```json
{
  "version": "reasoning-delivery-effectiveness-v1",
  "id": "release:pilot-01",
  "comparison": "randomized",
  "cases": [
    { "caseId": "control:001", "arm": "withheld", "outcome": "success" },
    { "caseId": "delivery:001", "arm": "delivered", "outcome": "success", "adopted": true }
  ]
}
```

Allowed case fields are exactly `caseId`, `arm`, `outcome`, and optional
`adopted`. Do not include prompts, task descriptions, strategies, sources,
memory identifiers, session identifiers, or agent transcripts.

The evaluator returns `measured` only when the comparison is explicitly
`randomized` and each arm has at least 20 resolved (`success` or `failure`)
outcomes. Otherwise it returns `insufficient_evidence` and no success-rate
difference. This gate prevents adoption logs, shadow traffic, and synthetic
fixtures from becoming a claim that strategy delivery improves real tasks.
