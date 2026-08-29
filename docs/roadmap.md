# Mnemora Roadmap

## Direction

Mnemora is narrowing its next work to governed ReasoningMemory.  The goal is
not to make model output authoritative or to inject more context by default.
The goal is to let a persistent agent accumulate source-linked procedural
advice, prove whether it helps, and keep a human responsible for every durable
promotion or retirement decision.

## v1.8 — Automatic Learning Intake

Turn completed ContextEngine work into bounded, source-linked **candidate**
records.  The host runtime model may suggest a decision or task-outcome
candidate only from the captured turn; it cannot directly create a decision,
outcome, belief, graph fact, profile attribute, or strategy.

- The capability is disabled by default and uses only the public host runtime
  completion interface.
- Every model request has a bounded input/output, timeout, and AbortSignal.
- Candidates retain canonical event references, scope isolation, preview-first
  confirmation, and a discard path.
- Confirming a candidate creates an `operator_confirmed` decision or outcome.
  A model suggestion never becomes a `user_explicit` fact.
- Existing governed curation can form a strategy candidate only from a
  confirmed outcome; strategy admission remains a separate human action.

## v1.9 — Governed Delivery Readiness

Use real shadow telemetry to determine whether a scope should receive any
ReasoningMemory delivery.  This phase does not turn delivery on globally.

- Persist only the normalized, non-sensitive policy observed by a live
  ContextEngine scope. The local operator can therefore calibrate the exact
  runtime policy without reading OpenClaw configuration or reconstructing it
  from environment variables.
- Measure candidate retrieval, language/task-type matching, latency, adoption,
  and outcome-linked quality with one scope-local diagnostics report.
- Require explicit calibration and a per-scope canary before delivery.
- Retain deterministic verification, per-memory circuits, rollback, and the
  no-efficacy-claim boundary until randomized operator evidence exists.

## Non-negotiable boundaries

- Never automate personality formation.
- Never promote LLM output into a belief, fact, graph edge, or user assertion.
- Never enable recall delivery merely because a candidate exists.
- Prefer a small, evidence-backed strategy set over an unlimited memory store.
