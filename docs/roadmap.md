# Mnemora Roadmap

Updated 2026-10-19. Latest release: **v1.36.0** (`52c4381`). Earlier plans and
per-version records are in [the roadmap history](roadmap-history.md); what
each release changed is in [the release notes](releases/).

## Direction

Mnemora is a local, source-linked memory for a persistent OpenClaw agent. The
long-term goal is governed ReasoningMemory: the agent accumulates
source-linked procedural advice, proves whether it helps, and a human stays
responsible for every durable promotion or retirement. The goal is not to make
model output authoritative or to inject more context by default.

The way there is in three steps, each gated on measured evidence:

1. **Recall that measurably beats simple retrieval** on public benchmarks.
   Largely met (below).
2. **Task resume that beats simple retrieval on real history**, under a
   preregistered comparison. Not met.
3. **A scoped ReasoningMemory canary**, only after step 2. Not started; the
   earlier experimental pipeline was removed in 1.33.

## Where things stand

| Area | State | Evidence |
|---|---|---|
| Automatic recall, lexical (default) | Released | LongMemEval_S, 500 questions, MiMo V2.6 Pro reader: 72.6% vs same-budget bm25 67.8% and no memory 7.6%, with 13% fewer tokens than bm25, at or above bm25 on every type (1.35) |
| Semantic recall (opt-in embeddings) | Released | Adds to lexical recall; multi-session 48.8% → 56.2% with `all-minilm` (1.36). Per-model thresholds for English, multilingual and Chinese models (1.36) |
| Failure visibility | Released | Optional work that fails is counted per day and reported by `mnemora health` (1.35) |
| Agent isolation, injection safety | Released | Per-agent scopes by default; newlines preserved so injected role lines are quoted (1.33); threat model and poisoning tests (1.31.9) |
| Explicit task resume (`resume`, Inspector) | Released | Accepted task state, coverage gaps and readable source excerpts (1.30–1.32) |
| Task-resume value on real history | **Unproven** | Operator-reported, 4 cases: simple retrieval 4/4, Mnemora 2/4, no memory 0/4; only 2 held out (2026-09-24) |
| ReasoningMemory | **Not in the product** | The experimental pipeline was removed in 1.33 (about 4.5k lines; its config keys are still accepted). A canary is gated on task-resume evidence |

Weakest benchmark types (1.35 answer accuracy, Mnemora / bm25):
single-session preference 43.3% / 40.0% (30 questions; retrieval session hit
56.7% vs bm25 70%), multi-session 48.8% / 41.3% (56.2% with embeddings),
temporal reasoning 68.5% / 63.0%. The other three types are above 90%.

## Next: v1.37 (proposed)

1. **Preference recall.** Stated preferences ("I don't eat spicy food") and
   later requests ("recommend a restaurant") share few words, so lexical recall
   misses them. Analyse the failing questions first, then choose the fix.
   Target: preference session hit at least bm25's 70%, answer accuracy clearly
   above 43.3%.
2. **Retrieval regression gate in CI.** A fixed small question set, lexical
   recall only, no model calls; CI fails when evidence recall or wrong
   attachment moves beyond a tolerance. First check the dataset's size and
   licence for the repository or a CI download.
3. **Temporal reasoning triage (optional).** Read about 30 failures and decide
   whether they are retrieval misses or reader arithmetic. Change retrieval
   only for the former.

## Toward v2.0

v2.0 is not scheduled by date. It needs both:

- **Task-resume evidence.** Real task-resume results that reliably beat
  simple retrieval: a preregistered held-out comparison on authorized real
  history, following the
  [preregistration guide](task-resume-preregistration.zh-CN.md), with an
  independently timestamped pre-run record, collection and annotation audits,
  and a decision report. A fail or inconclusive result is still reportable.
  The earlier 12-case exploratory package was recomputed as fail and is not a
  registered test. This needs the operator's history and Mac environment; it
  cannot be run from the development workspace. LongMemEval results are a
  proxy and do not substitute for it.
- **No automatic path for invalid evidence.** Corrections, forgotten sources
  and invalid evidence no longer influence the agent through any automatic
  path. Structural safeguards exist (threat model, poisoning tests,
  forgetting and correction handling); an end-to-end audit across every
  automatic path (recall, compaction, projections, resume) has not been done.

When the first holds, a **ReasoningMemory canary** may start: a small set of
verifiable procedures (deployment, incident response, data migration), scoped
canaries, explicit calibration, outcome evidence, rollback and per-memory
circuit controls. It will get its own version number when the gate opens; the "v1.33 pilot" in the
earlier plan was not started and that number is used.

## Open proposals (not scheduled)

- **Threshold consolidation.** Several thresholds share values but have
  different roles (for example `.72` for injection relevance and for the
  graph-supplement semantic floor). Consolidate only after scanning a
  labelled tuning set; see [threshold evaluation](recall-threshold-evaluation.md).
- **Attachment usefulness.** Implicit signals (citation, later corroboration,
  user correction) on the existing `target_ref` feedback path. The read-only
  [evidence worklist](recall-usefulness-review.zh-CN.md) is groundwork only.
- **Associative recall.** The Trigger design stays `off` or scope-limited
  `shadow`; cues, bridges and predictions must never become prompt facts.
- **Graph policy (PPR, related-edge expansion).** Only with new scope-local
  evidence of a quality gain; the last review (2026-09-06) produced no action.

## Decided against

- A "may not contain the answer" note in the memory packet: no net gain with
  either reading model (1.36).
- A per-record lexical floor: costs more recall than it saves (1.34, 1.36).
- Further low-yield evaluations for now: Chinese end-to-end QA, validation of
  the provisional mpnet thresholds, `bge-m3` calibration (2026-10-19).
- More relationship types, generic personality modelling, or broad provider
  integration before the task-resume gate.

## Scope discipline

- Patch releases only for targeted regressions and release hardening.
- Minor releases for a complete, user-visible capability with its acceptance
  criteria and measured results.
- Every release tag points to the exact `main` commit with successful Windows
  and Linux CI.

## Non-negotiable boundaries

- Never automate personality formation.
- Never promote LLM output into a belief, fact, graph edge, or user assertion.
- Never enable recall delivery merely because a candidate exists.
- Prefer a small, evidence-backed strategy set over an unlimited memory store.
