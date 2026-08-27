# Governed Reasoning Curation

Reasoning curation lets a persistent agent accumulate reusable procedural
advice without treating an LLM as a memory authority. It is intentionally a
separate module from `ReasoningMemoryService`:

```text
explicit Decision / confirmed TaskOutcome
  -> bounded LLM curation proposal
  -> human promotion or review resolution
  -> existing ReasoningMemory proposal / admission lifecycle
```

The curation module never creates a belief, graph fact, profile attribute, or
admitted strategy. It never changes a strategy's confidence, utility, or
delivery state. It uses only the public `RuntimeCompletion` capability exposed
by the ContextEngine lifecycle; it does not accept an API key or call a
provider directly.

## Activation

Both jobs are disabled by default and do not enable ReasoningMemory delivery.
They run only after an inserted, writable completed turn and only when that
turn has a host runtime model. They are opportunistic rather than a wall-clock
daemon: a weekly review becomes due after `intervalHours`, then runs on the
next qualifying completed turn.

```json5
cognition: {
  reasoningCuration: {
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

Schema 68 adds only three curation tables: a leased run ledger, formation
proposals, and review proposals. The migration does not call a model, backfill
proposals, or alter any existing strategy, outcome, belief, fact, graph edge,
profile, or delivery circuit. Existing installations retain their v1.6
behavior until either new `enabled` flag is set.
