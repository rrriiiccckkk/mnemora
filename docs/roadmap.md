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

## v1.17 — Graph Review Decision Gate

Make the post-v1.16 evidence collection practical without adding another
agent-facing tool or making a policy decision automatic.

- Add a read-only CLI report that combines one scope-local hygiene/topology
  assessment with aggregate pending, accepted, rejected, and durably
  invalidated outcomes for structural refinement, semantic labels, and
  vocabulary review.
- The command never scans, confirms, rewrites graph data, changes PPR, or
  enables ReasoningMemory delivery. It is evidence for an operator decision,
  not a policy engine.

## v1.18 — Schema-Drift Review Closure

The production decision gate confirmed that `related_to` remains the current
connectivity bridge: full exclusion fragments the graph, while uniform
downweighting has no measurable top-k benefit. Keep the live PPR multiplier
unchanged and complete the human data-quality loop instead.

- Add a durable preview/confirm rejection outcome for schema-drift candidates
  and include those candidates in the existing read-only worklist and decision
  gate. A rejection is review metadata, never a graph mutation.
- Recognize direct `person → product|technology uses` facts. This corrects an
  endpoint-coverage gap without automatically retyping people, accounts, or
  companies; a schema mismatch is not identity evidence.
- Surface existing suspicious self-links through the same worklist, but leave
  their removal an explicit, separately confirmed production-data action.
- Preserve the live `related_to` PPR multiplier and keep ReasoningMemory in
  shadow mode. Neither becomes a side effect of reviewing candidates.

## v1.19 — Schema-Drift Vocabulary Reconciliation

The production review showed that six historic `person → product uses`
candidates were already covered by v1.18 vocabulary, while one directly
evidenced `company → concept develops` candidate exposed a narrow endpoint
gap. Address only those observed cases.

- Permit `company → product|concept develops` as a semantic relation. This is
  endpoint coverage only: it never retypes an entity, rewrites an edge, or
  adds an arc to PPR or traversal.
- On upgrade, deterministically invalidate every unresolved historic
  schema-drift candidate newly allowed by the current vocabulary. The v77
  migration writes only review metadata, so a decision gate never relies on a
  worklist read side effect.
- Keep the live `related_to` PPR multiplier and ReasoningMemory shadow-only.

## v1.20 — Reliability Hardening

Fix the operational correctness failures found by exercising real non-empty
Inspector and long-lived backup-registry paths before extending the review
surface.

- Build Inspector graphs in a valid order: add every node and edge before
  deriving degree-based display attributes. Keep business entity type separate
  from Sigma's renderer `type` attribute, and lock this down with a real
  non-empty browser test.
- Make artifact-registry capacity an admission boundary instead of a restart
  data-loss boundary. Preserve readable legacy manifests above the cap; reject
  a new registration at capacity without touching existing records or files.
  No backup or recovery artifact is automatically pruned.
- Surface a bounded `manifest_invalid` or `manifest_too_large` health status
  when the registry cannot be safely read. Restore/list operations fail with a
  stable category instead of silently treating the registry as empty.
- Type-check the browser Inspector with a separate bundler-oriented TypeScript
  project as part of the normal check command. This complements, but never
  replaces, the non-empty browser integration test.

## v1.21 — Graph Review Operator Closure

Production review of v1.19 completed the current candidate loop: the seven
historic schema-drift records left `pending` as six vocabulary-driven
invalidations and one deliberate rejection; nine semantic-pattern proposals
were accepted. The next release closes the remaining operator-interface gap,
without treating review metadata as an automatic graph change.

- Expose the existing read-only review worklist through the operator CLI so
  rejected and invalidated dispositions can be inspected without direct
  database access. A rejection remains distinct from an invalidation and is
  never overwritten merely to make aggregate counts uniform.
- Expose the existing audited relationship-anomaly cleanup through a dedicated
  operator `preview → confirm` path. It may retire only the exact active
  self-link named in the preview; a matching scope, fresh preview hash, audit
  receipt, and one graph-revision update are required. An edge with evidence
  in another scope is ineligible, so a scope-local cleanup cannot remove
  shared graph state. Do not repurpose schema-drift repair for anomaly deletion.
- Document the separate semantic-vocabulary scan. It only collects bounded
  evidence and may create pending vocabulary proposals; accepting a
  semantic-pattern proposal never promotes a vocabulary entry automatically.
- Keep PPR and traversal policy unchanged, and keep ReasoningMemory delivery
  in shadow mode. The current production metrics contain no real reasoning
  retrieval runs, so a canary would have no evidence base.

## v1.22 — Semantic Vocabulary Operator Lifecycle

Complete the already-governed vocabulary workflow through the same local
operator interface before collecting production evidence.

- Expose bounded, cursor-based vocabulary collection and scope-local lists for
  pending, accepted, and rejected proposals through the CLI.
- Keep each vocabulary decision preview-first: confirmation requires the exact
  fresh candidate hash and records the existing audit receipt.
- Do not add an agent tool, automatic promotion, schema migration, graph
  mutation, PPR/traversal change, or recall-delivery change.

## v1.23 — Storage Read Seams and Windows CI

Make the first targeted split of the oversized Store without changing its
public surface or data behavior.

- Move node lexical/semantic candidate discovery, evidence hydration, and
  hybrid ranking behind an internal read-only repository. `GraphologyStore`
  remains the compatibility facade for every caller.
- Move portable database replacement into a dedicated recovery service. It
  retains schema compatibility checks, one transaction, derived-index rebuild,
  and the existing bounded `restore_failed` error contract.
- Validate the complete release gate on Node 24 for both Ubuntu and Windows.
  Browser installation remains platform-specific; no runtime dependency or
  configuration default changes.
- This is deliberately the first slice, not a claim that Store decomposition
  is complete. Traversal, review, and mutation responsibilities stay put until
  their interfaces can be separated without widening public API complexity.

## v1.24 — Graph Projection Seam and CI Stability

Continue the Store decomposition only where a deep, read-only module reduces
caller knowledge without changing public behavior.

- Move graph traversal, semantic-label projection, source attribution, and
  context compilation behind one internal graph-projection module. Preserve
  the Store methods and all scope, bounded-result, evidence, and error
  contracts exactly.
- Centralize SQLite graph-row decoding for the read-model modules so query
  behavior cannot diverge between lexical, semantic, traversal, and context
  paths.
- Replace a scheduler-sensitive URL deadline assertion with a bounded test
  timeout. The test still proves that a resolver which ignores cancellation
  yields a `timeout`, without treating a loaded Windows runner's scheduling
  delay as an application failure.
- No schema migration, configuration default, agent tool, PPR policy, or
  recall-delivery behavior changes.

## v1.25 — Query Persistence Seam

Continue Store decomposition at the bounded query-state boundary without
changing query, watch, digest, or agent-facing behavior.

- Move watch CRUD, digest idempotency/reclaim receipts, and redacted query
  audit retention into one internal query-persistence repository.
  `GraphologyStore` remains the compatibility facade for all callers.
- Keep the existing normalized-plan, scope-touching, transaction, bounded
  listing, digest cursor, audit hashing, redaction, and daily retention
  contracts exactly as they are today.
- No schema migration, configuration default, new tool, graph mutation,
  PPR/traversal policy, or recall-delivery change is included.

## Decision-gate status (2026-09-06)

The latest real scope-local review correctly produced no graph-policy action:

- The semantic-vocabulary scans for `default`, `inbox`, and
  `ai-agent-search` examined 20 edges and created no candidates; `inbox`
  itself also has no candidates.
- `default` and `inbox` have no self-link anomalies, and duplicate review is
  empty. The nine existing `semantic_patterns` in `default` are already
  accepted rather than pending decisions.
- A topology diagnostic was obtained, but its terminal output was truncated.
  It does not provide retained independent evidence for a PPR or recall-policy
  change. If such a change is later considered, re-run a bounded report first.

Accordingly, do not manufacture review work, adjust PPR, or enable a recall
canary. Wait for new scope-local evidence or pursue behavior-preserving
reliability work.

## Post-v1.22 decision gate

Before any further topology or reasoning-delivery feature work, collect real
scope-local evidence:

1. Run the bounded semantic-vocabulary CLI scan, inspect every resulting
   pending proposal, and use its own preview/confirm decision flow. Do not
   accept vocabulary candidates as a side effect of scanning.
2. If the self-link preview remains current, explicitly confirm its cleanup
   through the v1.21 operator path; otherwise re-preview it. Preserve its
   audit record and do not apply schema-drift repair.
3. Compare accepted/rejected/invalidated rates, residual `related_to`
   concentration, and the v1.12 topology diagnostics. Expand PPR policy or
   ReasoningMemory delivery only if independent measurements show a concrete
   quality gain.

## Non-negotiable boundaries

- Never automate personality formation.
- Never promote LLM output into a belief, fact, graph edge, or user assertion.
- Never enable recall delivery merely because a candidate exists.
- Prefer a small, evidence-backed strategy set over an unlimited memory store.
