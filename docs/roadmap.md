# Mnemora Roadmap

## Current release plan (2026-10-01)

2026-10-02 update: v1.32.1 shipped at `8ceb6e2` after exact-commit CI
`36872183713` and Release `36874535555`. Active v1.32.2 work adds a separate
[one-command regression flow](task-resume-regression.zh-CN.md), not a formal
efficacy or v1.33 pilot release. Regression reports cannot satisfy the value
gate; the existing formal protocol remains unchanged.

Current released baseline: **v1.32.0** (`c41f791`), with exact-commit
Windows/Linux CI `36856873736` and formal Release `36858385777` verified.
Active development: a controlled-memory three-arm experiment runner, automatic
bundle validation and a short Mac execution handoff. This is research tooling,
not the v1.33 ReasoningMemory pilot. The operator authorized its complete
technical release as **v1.32.1**, after exact-commit Windows/Linux CI succeeds.
Operator decision (2026-10-01): deliver the complete v1.32 milestone rather
than more incremental v1.31 patch releases. Necessary fixes belong to this
milestone; version bumps alone do not satisfy its measured-evidence gate.
The operator subsequently authorized publishing the verified v1.32 technical
changes with concise bilingual READMEs. This does not mark the measured-value
milestone complete: corrected audits, regression reruns and the preregistered
unseen-case comparison remain pending, and the v1.33 pilot gate stays closed.
The historical sections below record earlier completed directions; this
section is the active planning baseline.

| Version | Product outcome | Release gate |
| --- | --- | --- |
| **v1.31.12 — Exact attachment evidence safeguards (released)** | Opt-in bounded assembly receipts freeze target/projection versions and allow preview-confirmed source links; partial coverage is not causal turn attribution or an efficacy denominator. | Full verify with 983 unit tests, schema83→84 preservation/restart/restore and exact-commit Windows/Linux CI passed for `76f5825`; formal release published. |
| **v1.31.11 — Recall usefulness evidence boundaries (released)** | Read-only target-level worklist separates attachment aggregates, bounded mentions and explicit unlinked feedback; missing attribution cannot become an efficacy score. | 964 local unit tests plus full verify; exact-commit Windows/Linux CI and formal release passed for `c414abb`. Optional Windows cache saving disabled after an earlier post-verification timeout, with no checks removed. |
| **v1.31.10 — Threshold evaluation safeguards (released)** | Read-only manual-unified score scan freezes tuning/test selection and rejects failed/unsafe/budget-invalid evidence; aggregate curves cannot authorize default changes. | Complete verify including 954 tests and exact-commit Windows/Linux CI passed for `ee60045`; formal release published. Real threshold calibration remains pending. |
| **v1.31.9 — Reference projection trust boundaries (released)** | Shared projection protection covers summary assembly, transcript rewrite and built-in reasoning adapters; records remain auditable. Threat model distinguishes structural safeguards from model resistance. | Complete verify including 943 unit tests and exact-commit Windows/Linux CI passed for `c38fd67`; formal release published. Structural safeguards do not prove model resistance. |
| **v1.31.8 — Owned test fixture cleanup (released)** | All file-backed fixtures use an owned system-temp root; managed parent runners clean after native worker exit on success or failure, without deleting historical or unrelated directories. | Complete verify including 920 unit tests and exact-commit Windows/Linux CI passed for `c9c2cce`; formal release published. Serial test concurrency, schema and product defaults remain unchanged. |
| **v1.31.7 — Preregistered value decision (released)** | A detached registration freezes the next experiment's plan, material hashes and fixed v1.32 decision policy before runs; the read-only decision cannot open a pilot on missing or inadequate evidence. | Inclusive threshold, drift, timeline, small-sample, zero-baseline, synthetic and no-database CLI regressions passed with cross-platform CI for `b36569a`. A pass still requires an independent pre-run record and operator audit. |
| **v1.31.6 — Inspector evidence coverage and confirmations** | Candidate and selected-task views distinguish readable sources, accepted-state coverage, and recorded progress; operation-generated IDs satisfy the existing result schema even when random entropy begins with punctuation. | Browser tests cover all four coverage combinations, scope isolation, read-only selection, and refresh after forgetting. Fixed-entropy regressions cover four operation confirmations; exact-commit Windows and Linux CI must pass before release. |
| **v1.31.5 — Resume evidence coverage (released)** | The read-only resume projection distinguishes readable source evidence from accepted current task state and names a coverage gap without claiming that real-world task state is unknown. | Source-only, accepted-state, forgotten, and hash-only projections pass; both platforms passed CI for `ba999c7`. |
| **v1.31.4 — Reviewed intake task linkage (released)** | An operator can explicitly link reviewed intake to a selected task rather than silently leaving accepted state disconnected from its resume target. | Preview/confirm and task scope rules remain intact. This historical release used an explicit operator bypass after a Windows browser-test failure; it is not evidence of successful cross-platform CI. Subsequent releases require both platforms. |
| **v1.31.3 — Release wait hardening (released)** | The tag workflow waits long enough for the allowed 20-minute cross-platform CI before deciding that the exact-commit gate failed. | This release's tag uses the longer wait and publishes only after successful Windows and Linux CI for its commit. |
| **v1.31.2 — Comparison coverage guard (released)** | A measured task-resume comparison can report irrelevant memory injection when every case has a reviewed label, while clearly marking the metric unmeasured otherwise. | Held-out-only aggregation, incomplete-label rejection, and no-memory arm isolation pass. |
| **v1.31.1 — Comparison budget guard (released)** | The task-resume comparison rejects measured records exceeding the plan's per-case token or latency budget. | Focused regressions cover exact-limit acceptance and over-budget rejection for both tuning and test records. |
| **v1.31.0 — Continuity reliability (released)** | Task continuation resolves accepted task state before display limits and identifies exactly which long-history sections were truncated, without reviving completed work or hiding uncertainty behind pagination. | End-to-end tests cover long history, corrections, forgetting, restart, and section-specific display limits independently from state resolution. |
| **v1.30.1 — Canonical CLI storage (released)** | The standalone CLI uses Mnemora's one canonical database by default, reports the path when it creates a database, and remains directly executable when a plugin is unpacked without an npm bin shim. | Default, explicit, and in-memory CLI paths are covered; direct CLI invocation stays executable on POSIX builds. |
| **v1.30.0 — Reliable task continuation (released)** | A new session can clearly show which task to resume, what is complete, blocked, pending, superseded, or awaiting reconfirmation, with source links. Chinese discovery keeps multiple active matches ambiguous and does not let completed history hide a current task. | Cross-session, restart, correction, forgetting, Chinese-query, and ambiguity regressions pass from durable records through the CLI and Inspector projections. |
| **v1.32.0 — Readable task-resume evidence** | Deliver bounded unverified source excerpts, read-only recall safeguards and concise bilingual entrypoint documentation. Continue the authorized three-arm comparison as a separate measured-value milestone. | Technical publication requires exact-commit Windows/Linux CI. The measured-value gate still requires audited, preregistered held-out results; synthetic contracts and this release do not satisfy it. |
| **v1.33.0 — Governed ReasoningMemory pilot** | Apply reusable strategy memory only to a small set of verifiable procedures, such as deployment, incident response, and data migration. | Begin only if v1.32 evidence shows a benefit over simple retrieval; retain scoped canaries, explicit calibration, outcome evidence, rollback, and per-memory circuit controls. |

### v2.0 threshold

Do not schedule v2.0 by calendar. It requires real task-resume evidence that
reliably outperforms simple retrieval, while corrections, forgotten sources,
and invalid evidence no longer influence the Agent through any automatic path.

### Scope discipline

- Use patch releases only for targeted regressions and release-hardening.
- Use minor releases for a complete, user-visible capability plus its
  acceptance criteria.
- Do not prioritize more relationship types, generic personality modeling, or
  broad provider integration before the task-continuation and measurement
  gates above.
- Every release tag must point to the exact `main` commit with successful
  Windows and Linux CI; do not bypass that release gate.

### Active sequencing

1. Freeze **v1.32** value criteria before new model runs using the
   [preregistration guide](task-resume-preregistration.zh-CN.md). The existing
   four-case report is exploratory, not a retrospectively registered test.
2. Incorporate necessary reliability fixes into v1.32, not separate v1.31
   patch releases. v1.31.12 attachment safeguards are released; audit authorized real
   receipt/source-link cases and missing coverage. These assembly IDs are not
   host turn IDs, user confirmation is not independent corroboration, and
   partial receipt windows cannot measure usefulness rates. Automatic label
   capture, canary integration and real threshold labels remain pending;
   neither evidence view authorizes calibration/default changes.
   The current development increment adds bounded readable source excerpts to
   resume/Inspector and makes unified recall telemetry respect session write
   policy. The supplied 12-case exploratory package was recomputed as fail;
   its truth timing and missing audits must be resolved before efficacy claims.
   See [source evidence and reruns](task-resume-source-evidence.zh-CN.md).
3. Run the new authorized held-out comparison under the fixed decision policy.
   Keep a matched rerun of the old four cases as a separate regression study.
   Deliver the registration, independently timestamped pre-run record,
   measured plan, collection/annotation audits and decision report as one
   milestone. A measured fail/inconclusive result is reportable; it does not
   authorize v1.33. This workspace currently lacks those formal experiment
   artifacts and cannot access the Mac; synthetic contracts are not substitutes.
4. Start **v1.33** only when that evidence supports a governed, scoped
   ReasoningMemory canary for a small set of verifiable procedures.

### Recorded follow-up proposals (2026-09-29)

- **Memory-poisoning threat model:** document attacker-controlled URL and
  extraction input, trust boundaries, wrapper/role spoofing, persistence and
  correction/forgetting attacks in `docs/threat-model.md`; add a dedicated ADR
  and end-to-end adversarial fixtures. Implemented for v1.31.9 in
  [the threat model](threat-model.md), ADR 0002 and dedicated poisoning tests;
  model-based attack resistance remains unmeasured.
- **Evidence-backed thresholds:** inventory each parameter's actual role
  before consolidating defaults. `.72` is currently both an injection relevance
  default and a separate graph-supplement semantic floor, not the universal
  semantic-search floor. Related-to admission, MMR diversity and PPR ranking
  have distinct meanings and existing configuration paths. Freeze a multi-case
  labelled tuning/test set, scan only tuning, and report precision/recall and
  token/latency curves without selecting from held-out results. Consolidation
  remains pending. The first manual-unified score scan is implemented for
  v1.31.10; see [its evidence boundaries](recall-threshold-evaluation.md).
  Real calibration and other score surfaces remain pending; no default changed.
- **Attachment usefulness:** extend the existing scope-bound `target_ref`
  feedback path rather than equating `recall_count` with utility. Citation,
  later corroboration and user correction are separate signals; quotation is
  not endorsement, and assistant self-claims are not independent evidence.
  Keep raw text out of telemetry, trace only authorized canonical references,
  retain deletion/retention and replay rules, and keep calibration changes
  review-gated. The implicit-signal capture and canary calibration integration
  are pending; existing explicit feedback is not evidence that they exist.
  The v1.31.11 [read-only evidence worklist](recall-usefulness-review.zh-CN.md)
  is groundwork only: corroboration and turn attribution remain unmeasured.

### Reported Mac comparison and remaining evidence

The operator supplied a 2026-09-24 report for four authorized real-history
cases: simple retrieval was correct on 4/4, Mnemora on 2/4, and no long-term
memory on 0/4. Held-out test coverage was only two cases. All twelve rows were
reported clean for stale-fact use, repeated steps, and irrelevant injection.
This repository workspace has not independently re-read the Mac artifacts.

The reported Mnemora failures involved `needs_reconfirmation` being read as
real-world uncertainty despite sufficient source material. v1.31.4–v1.31.5
address task linkage and uncertainty presentation; v1.31.6 only makes the
existing coverage visible in Inspector. None establishes an improvement in
measured model performance. Preserve the original split and metrics on rerun,
retain failures, and keep automatic-recall claims separate from explicit
`resume`/retrieval measurements. Do not start the v1.33 pilot on this evidence.

### Deferred experimental track: associative recall

The T-Mem-inspired Trigger design is a later experiment, not the next product
milestone. It remains `off` or scope-limited `shadow` until task continuation
and measured evaluation establish a trustworthy baseline. Any future canary
must return only a currently eligible canonical Decision or Episode with its
original sources; Trigger cues, bridges, predictions, and model confidence
must never become prompt facts. Corrections, forgetting, lifecycle changes,
and scope boundaries must invalidate the derived index before it can affect
automatic context.

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
