# Governed Reasoning Curation

Reasoning intake and curation let a persistent agent accumulate reusable
procedural advice without treating an LLM as a memory authority. They are
intentionally separate from `ReasoningMemoryService`:

```text
completed turn -> candidate review -> confirmed Decision / TaskOutcome
  -> bounded LLM curation proposal
  -> human promotion or review resolution
  -> existing ReasoningMemory proposal / admission lifecycle
```

The module never creates a belief, graph fact, profile attribute, admitted
strategy, or user assertion from a model response. It never changes a
strategy's confidence, utility, or delivery state. It uses only the public
`RuntimeCompletion` capability exposed by the ContextEngine lifecycle; it does
not accept an API key or call a provider directly.

## Activation

Both jobs are disabled by default and do not enable ReasoningMemory delivery.
They run only after an inserted, writable completed turn and only when that
turn has a host runtime model. They are opportunistic rather than a wall-clock
daemon: a weekly review becomes due after `intervalHours`, then runs on the
next qualifying completed turn.

```json5
cognition: {
  reasoningCuration: {
    intake: {
      enabled: true,
      maxCandidatesPerTurn: 2,
      timeoutMs: 15000,
      maxInputChars: 8000,
      maxOutputChars: 2000
    },
    formation: {
      enabled: true,
      maxJobsPerTurn: 1,
      minOutcomeConfidence: 0.75,
      timeoutMs: 15000,
      maxInputChars: 8000,
      maxOutputChars: 2000
    },
    review: {
      enabled: true,
      intervalHours: 168,
      maxItems: 12,
      timeoutMs: 15000,
      maxInputChars: 12000,
      maxOutputChars: 4000
    }
  }
}
```

Every model request has an input bound, output bound, local timeout, and the
host `AbortSignal`. Source records are XML-delimited as untrusted data. Invalid
or unavailable model output cannot become a strategy; it creates a bounded
failed run record and retries no earlier than one hour later. Leases prevent a
crashed worker or replay from issuing duplicate requests.

## Formation

### Intake

Intake sees only the final user/assistant pair of a durable captured turn. It
creates at most `maxCandidatesPerTurn` decision or task-outcome candidates and
links them to those exact local events. A deterministic user-message signal
gate prevents an assistant-only completion claim from becoming an outcome
candidate. The model output is advisory; it is never treated as a user fact.

```bash
mnemora cognition reasoning intake candidates --scope project:alpha
mnemora cognition reasoning intake confirm <candidate-id> --scope project:alpha
# Repeat with --preview-hash <hash> --confirm.
mnemora cognition reasoning intake discard <candidate-id> --scope project:alpha
```

Confirmation is preview-first. A decision created this way is deliberately
recorded as `assistant` / `operator_confirmed`, not `user_explicit`. An outcome
uses the source user event as its task anchor, avoiding automatic episode or
fact creation. A discarded candidate leaves no durable decision or outcome.

### Formation

Formation scans only confirmed, non-superseded TaskOutcomes in the current
scope whose confidence meets `minOutcomeConfidence`. It creates at most
`maxJobsPerTurn` advisory candidates. A candidate needs source-compatible
evidence from its outcome; otherwise it is skipped.

```bash
mnemora cognition reasoning curation formations --scope project:alpha
mnemora cognition reasoning curation runs --scope project:alpha
mnemora cognition reasoning curation promote <formation-proposal-id> --scope project:alpha
```

`promote` first returns a preview. Re-run it with the exact preview hash and
`--confirm` to create a **proposed** ReasoningMemory. Promotion is not
admission. Use the existing `cognition reasoning admit` preview/confirmation
workflow to make it retrievable, or discard the candidate instead:

```bash
mnemora cognition reasoning curation discard <formation-proposal-id> --scope project:alpha
```

## Periodic review

The review job sees only a bounded local summary of eligible strategies and
their linked outcome counts. It can recommend `retain`, `retire`, or
`needs_review`; it cannot carry out any recommendation.

```bash
mnemora cognition reasoning curation reviews --scope project:alpha
mnemora cognition reasoning curation resolve-review <review-proposal-id> retain --scope project:alpha
mnemora cognition reasoning curation resolve-review <review-proposal-id> retire --scope project:alpha
mnemora cognition reasoning curation resolve-review <review-proposal-id> dismiss --scope project:alpha
```

Each resolution is preview-first. `retain` records the human decision without
changing the strategy. `dismiss` rejects the advisory proposal. `retire`
passes through the existing ReasoningMemory transition, preserving all evidence
and audit history instead of deleting data.

## Storage and compatibility

Schema 69 adds one isolated candidate table. The migration does not call a
model, backfill candidates, or alter any existing strategy, outcome, belief,
fact, graph edge, profile, or delivery circuit. Existing installations retain
their v1.7 behavior until the new intake `enabled` flag is set.
