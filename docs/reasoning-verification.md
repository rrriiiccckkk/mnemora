# ReasoningMemory verification metadata

Mnemora v1.4 permits an operator to attach an optional, bounded verification
contract to a ReasoningMemory proposal. It is a future deterministic verifier
mount point, not a verification result and not a truth claim.

## Contract

```ts
{
  version: "reasoning-verification-v1",
  assertions: [
    { kind: "tool_result", tool: "migration-runner", expected: "success" },
    { kind: "task_outcome", expected: "failure" },
    { kind: "strategy_adoption", expected: true }
  ]
}
```

`assertions` contains between one and sixteen entries. The only permitted
fields are the ones shown above. Tool names are normalized identifiers of at
most 80 characters. Arbitrary tool arguments or output, prompts, model output,
session identifiers, and free-text evidence are rejected.

## Runtime behavior

- The contract is stored with the strategy and participates in its proposal
  fingerprint, so an operator confirmation cannot be reused for changed
  verification metadata.
- It does not call a model, provider, or tool; it does not perform a
  verification result calculation; and it does not affect admission,
  retrieval, delivery, circuit state, confidence, beliefs, facts, or graph
  edges.
- A future verifier must consume these assertions asynchronously and produce
  append-only evidence. It must not turn model output into a user fact.

## Compatibility

Schema 65 adds nullable `verification_json` to
`mnemora_reasoning_memories`. Existing strategy, evidence, outcome, scope, and
lifecycle data remain unchanged and read without a verification contract. There
is no new configuration key and no default behavior change.
