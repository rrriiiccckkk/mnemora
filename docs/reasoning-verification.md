# ReasoningMemory deterministic verification

Mnemora lets an operator attach a small verification contract to a proposed
ReasoningMemory strategy. The contract is not evidence, a truth claim, or a
path to creating a belief. It is an explicit description of the limited
outcome signals that may suppress a delivered strategy.

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

`assertions` contains one to sixteen items. Only the fields above are valid.
Tool names are normalized identifiers of at most 80 characters. Tool payloads,
arguments, output, prompts, model text, session identifiers, and free-text
evidence are rejected.

## What v1.5 verifies

The verifier is a bounded, local, asynchronous worker. It uses an append-only
ledger containing only a receipt reference, assertion values, and a bounded
source reference:

- An operator-confirmed `TaskOutcome` that cites a reasoning delivery receipt
  queues matching `task_outcome` assertions. The same explicit receipt citation
  is the sole automatic `strategy_adoption` signal.
- An operator or supported Provider Adapter may record only a contracted tool
  identifier and `success` or `failure`, through the CLI or
  `ReasoningVerificationService.recordToolResult`. Raw tool output is not an
  accepted input.
- Processing a matching event records a result. A mismatch opens that memory's
  existing delivery circuit. The strategy remains withheld until an operator
  explicitly resets the circuit.

The worker never calls an LLM, network provider, host tool, or external
database. It does not change strategy admission, confidence, beliefs, facts,
graph edges, or task outcomes. Verification signals remain non-authoritative
operational safety signals.

## Activation and operator commands

Automatic processing is disabled by default. Enabling it does not enable
ReasoningMemory delivery; delivery retains its calibration and exact-scope
canary requirements.

```json5
cognition: {
  reasoningRuntime: {
    verification: { enabled: true, maxJobsPerRun: 5 }
  }
}
```

When enabled, Mnemora processes at most `maxJobsPerRun` events (1–20) after a
durable ContextEngine completed turn. Pending events can also be inspected or
processed explicitly:

```bash
mnemora cognition reasoning runtime-verification-summary --scope project:alpha
mnemora cognition reasoning runtime-verification-events --scope project:alpha
mnemora cognition reasoning runtime-verification-run --scope project:alpha --confirm
mnemora cognition reasoning runtime-verification-tool-result \
  '<delivery-item-ref>' migration-runner failure tool-run:42 \
  --scope project:alpha --confirm
```

`--confirm` is required for commands that enqueue a tool signal or process
events. A circuit reset remains a separate explicit operator action through
`runtime-memory-circuit-reset`.

## Compatibility

Schema 65 introduced nullable `verification_json` on
`mnemora_reasoning_memories`. Schema 66 adds the append-only local event ledger
and widens the delivery-circuit reason enum. Schema 67 adds terminal `expired`
events: once a delivery receipt reaches its existing retention deadline, new
signals are ignored and pending checks are retained as `expired` rather than
being allowed to open a circuit. The migration preserves every existing circuit
row, verifier event, strategy, evidence, outcome, scope, and lifecycle record.
Existing installations retain the default-disabled behavior.
