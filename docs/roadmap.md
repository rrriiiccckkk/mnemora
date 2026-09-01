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

## v1.10 — Recall Precision and Observability

Keep automatic ContextEngine memory attachment conservative while making its
real decision path measurable.

- Require a non-generic query anchor for automatic lexical local/graph
  attachment; graph semantic candidates must instead clear a conservative
  fixed floor.
- Limit automatic graph expansion to one seed and one direct evidenced hop;
  apply deterministic MMR only to the bounded local attachment set.
- Record an opt-in, scope-local, redacted shadow row for each real automatic
  attachment decision. Rows contain a query hash and bounded counts only—no
  prompt, candidate text, identifiers, sources, or evidence.
- Keep manual search broad and unchanged. An empty automatic attachment is a
  correct safe outcome, not a fallback that should inject generic matches.

## v1.11 — Graph Hygiene and Local Resilience

Improve the quality and availability diagnostics around the graph without
making automatic graph mutation a default behavior.

- Add a bounded scheduled hygiene review for duplicate entities, suspicious
  self-links, and overuse of `related_to`; keep merging preview/confirm unless
  a future explicit policy introduces a narrowly-scoped automatic action.
- Add measurable graph-recall quality diagnostics so an operator can compare
  precision before changing routing or confidence policy.
- Surface local embedding/provider health and deterministic lexical fallback
  state. Do not add a remote dependency or make gateway availability a hidden
  prerequisite for core local memory access.

## v1.12 — Related-Edge Admission and Topology Assessment

Stop low-information `related_to` edges from accumulating, then measure the
cost of changing their topology role before changing production ranking.

- Require retained evidence for every new `related_to` relation. Automatic
  extraction must provide a contiguous quote from its input; vague association
  and co-occurrence produce no edge.
- Raise the default fallback-edge confidence floor to `0.85`. Explicit
  operator configuration remains authoritative and existing evidence is never
  rewritten.
- Add a bounded, scope-local hygiene comparison for the current PPR weight,
  a 0.3× downweighted policy, and full exclusion. Report weak components,
  isolated nodes, and representative seed top-k Jaccard change without
  changing live PPR or traversal.

## v1.13 — Related-Edge Legacy Refinement

The v1.12 production assessment showed that complete exclusion fragments the
current structural projection, while uniform downweighting does not change its
top-k order. Preserve `related_to` as a compatibility bridge for now, and
improve its information content through bounded, explicit review.

- Add an operator-invoked, scope-local scan for high-confidence legacy
  `related_to` edges whose retained quote contains an ordered, direct
  `depends_on`, `part_of`, or `instance_of` cue. Co-occurrence and vague
  association make no candidate.
- Require preview and matching confirmation before creating a structural
  replacement. Confirmation copies source-linked evidence, retires only the
  reviewed legacy edge, and records an audit receipt. Scanning and previewing
  never mutate graph data; no model call or automatic relabelling is added.
- Keep PPR and traversal policy unchanged. Domain-vocabulary evolution remains
  a separate, reviewed proposal path rather than an automatic schema or
  topology mutation.

## v1.14 — Related-Edge Semantic Enrichment

Make a reviewed legacy fallback edge explainable to an explicit semantic query
without treating a label as a topology fact.

- Add an operator-invoked, scope-local scan for high-confidence `related_to`
  evidence that directly states one of the existing semantic predicates, such
  as `uses`, `develops`, `works_at`, or `supplies`.
- An accepted preview/confirm decision creates a source-linked semantic label
  projection for that exact legacy edge. It does not create a replacement
  edge, retire the fallback edge, alter an observation, or change PPR or
  traversal. Rejection remains inert.
- Preserve the distinction between a direct relationship cue and a broad
  association: labels are unavailable until an operator confirms the exact
  same-scope evidence. Broader ontology expansion remains a separate proposal
  rather than an inferred graph mutation.

## v1.15 — Graph Review Lifecycle Integrity

Finish the operational lifecycle around review records before adding more
graph semantics.

- Provide one bounded review worklist for pending, rejected, and invalidated
  graph-remediation candidates, including the existing suspicious self-link
  finding.
- Mark a candidate invalid when its exact legacy edge or evidence is retired
  or removed, instead of leaving it indefinitely previewable-but-ineligible.
- Keep every graph-changing action preview/confirm only. Scanning, lifecycle
  maintenance, and status reporting must never delete an edge automatically.

## v1.16 — Review-Driven Vocabulary Evolution

Use real accepted and rejected review outcomes to evolve the soft semantic
vocabulary, rather than expanding an ontology speculatively.

- Propose domain-neutral labels only from observed, frequent, evidence-backed
  patterns; likely candidates include `located_in`, `member_of`,
  `created_by`, `authored_by`, and `based_on`.
- A human-approved vocabulary entry may improve explicit semantic inspection
  and future proposal classification. It does not create a graph edge, rewrite
  a historic relation, become a PPR arc, or authorize automatic extraction.
- Preserve a small structural topology. New labels remain semantic projections
  unless a later, separately measured decision promotes a relationship type.

## Post-v1.16 decision gate

Before any further topology or reasoning-delivery feature work, collect real
scope-local evidence:

1. Run `hygiene`, `related_edge_refinements`, and `related_edge_semantics` on
   the production scope and review a meaningful sample of candidates.
2. Compare accepted/rejected/invalidated rates, residual `related_to`
   concentration, and the v1.12 topology diagnostics.
3. Expand PPR policy or ReasoningMemory delivery only if those measurements
   show a concrete quality gain. Otherwise keep the conservative defaults and
   prioritize operator experience over more automatic memory behavior.

## Non-negotiable boundaries

- Never automate personality formation.
- Never promote LLM output into a belief, fact, graph edge, or user assertion.
- Never enable recall delivery merely because a candidate exists.
- Prefer a small, evidence-backed strategy set over an unlimited memory store.
