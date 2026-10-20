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

Chosen after comparing open-source agent memory (2026-10-19, see
[Comparison with other memory systems](#comparison-with-other-memory-systems)).
Each item targets a measured weakness.

1. **Preference recall (done on main).** Retrieval was not the bottleneck:
   lexical recall already matched bm25's session hit (21/30) and semantic
   recall found 23 of 30 evidence turns, but readers ignored memory in the
   system prompt. The recall packet now sits at the start of the active user
   message by default (`contextEngine.recallPlacement`); preference answers
   with semantic recall rose from 8 to 16 of 30 (`mimo-v2.6-pro`) and 5 to 18
   (`mimo-v2.6-flash`), with abstention and other types unchanged. Capture
   strips the packet so it is never re-recorded as user speech. See
   [Recall quality](recall-quality.md).
2. **Event-time normalization (done on main).** `unifiedRetrieval.timeAnchors`,
   on by default: a time phrase in the prompt ("10 days ago", "上周六") becomes
   a window of dates; records recorded in it or mentioning an event in it win
   near ties; relative dates in recalled records are resolved in the packet
   header. Reading the 41 temporal failures showed most misses locate evidence
   by time alone. Temporal reasoning: Pro 93 → 97, Flash 77 → 84 of 133;
   retrieval over 500 questions unchanged (see recall-quality). Not done:
   marking superseded facts beyond the 1.34 `newer_related` links.
3. **Hybrid recall without extra setup (done on main, opt-in).**
   `embeddings: { enabled: true, provider: "host" }` reuses the embedding
   provider of OpenClaw memory search through its SDK; OpenClaw holds the
   credentials, vectors are keyed `host:<provider>` plus model, and recall
   falls back to lexical when the provider is missing or failing. Through
   OpenClaw's Ollama adapter the vectors equal the direct path (90 texts,
   minimum cosine 1.0). Decided: stays opt-in, because it sends
   conversation text to a hosted provider. Open: thresholds for hosted models
   such as `text-embedding-3-small`, which need a key to calibrate with
   `npm run eval:calibrate-semantic`.
4. **Retrieval regression gate in CI (done on main).** Job `retrieval gate`:
   every fifth LongMemEval_S question (100), lexical, no model calls, seeded
   ids and clock so runs repeat exactly; fails when evidence recall drops or
   attached records rise beyond the tolerance in
   `eval/retrieval-gate/baseline.json`. The dataset is MIT; the 277 MB file is
   downloaded at a pinned revision and sha256 and cached, not committed.
   Verified against 1.32.19 (fails: all evidence 72 → 3) and 1.36.0 (passes).
5. **Comparable published number (optional).** One LongMemEval_S run at a
   4k–7k token budget, the range other systems report at, so results can be
   read side by side (about 1,000 model calls).

## Next: slimming (after v1.37, not started)

Candidates for removal: code that never runs on the automatic recall path and
has no measured benefit. Nothing is deleted until each reference is checked
and the full suite passes; as in 1.33, schema tables and configuration keys
stay accepted so existing installs keep loading.

| Candidate | Size (source) | Reason |
|---|---|---|
| Graph governance: `related-edge-refinement`, `related-edge-semantics`, `semantic-vocabulary`, `schema-drift`, `graph-review`, `hygiene` | about 117 KB | Reachable only through tools; the 2026-09-06 decision gate produced no action; all benchmark gains came from the journal path |
| `insights` (community detection) and research tools `kg_compare`, `kg_digest`, `kg_insights`, `kg_watch`, `kg_timeline`, `kg_query` | about 59 KB plus tool code | Not in the default `core` tool surface; no usage evidence |
| Graph-recall canary: `trust/adaptive-canary`, `trust/adaptive-recall`, `kg_recall_canary`, `kg_recall_metrics` | to be measured | A rollout mechanism for graph recall that was never enabled |
| ReasoningMemory leftovers in `cognition`: beliefs, decisions, graduation, semantic classifier, outcomes | to be measured | The pipeline itself was removed in 1.33. `recall-attachment` and `reflection` stay: automatic recall uses them |

Together about 7–8% of the 2.3 MB source for the first two rows, and around
15% if the last two hold up after review.

## Comparison with other memory systems

Checked 2026-10-19 against public documentation; scores are self-reported
and use different readers, judges and budgets, so they are not a ranking.

- **OpenClaw memory-core** (the host default): provenance tiers, observed
  timestamps with a supersession key, `USER.md` profile, dreaming
  consolidation into `MEMORY.md`, standing intents, and hybrid vector plus
  keyword search when an embedding provider is set
  ([architecture](https://docs.openclaw.ai/concepts/memory-architecture),
  [memory](https://docs.openclaw.ai/concepts/memory)). Mnemora's value is
  measured against this, not against no memory.
- **mem0 OSS v3**: single-pass ADD-only extraction; semantic, BM25 and entity
  signals fused; graph memory removed from open source (about 4,000 lines)
  ([migration guide](https://docs.mem0.ai/migration/oss-v2-to-v3)).
- **Graphiti / Zep**: bi-temporal facts with edge invalidation; vector, BM25
  and graph traversal combined
  ([overview](https://help.getzep.com/v2/graphiti/getting-started/overview)).
- **Letta**: in-context memory blocks edited by the agent, with a background
  sleep-time agent that consolidates them
  ([guide](https://forum.letta.com/t/sleeptime-agents-for-memory-consolidation-best-practices-guide/154)).
- **Memobase**: structured user-profile slots
  ([profiles](https://docs.memobase.io/features/profile/profile)).
- **Reported LongMemEval numbers**: mem0 94.4% at about 6.8k tokens per
  retrieval, Zep 71.2%
  ([mem0 summary](https://mem0.ai/library/agent-memory/ai-memory-benchmarks-in-2026));
  Zep reports 90.2% at about 4.4k tokens
  ([Zep](https://www.getzep.com/ai-agents/how-to-test-agent-memory/));
  agentmemory retrieval-only R@5 86.2% with BM25 and 95.2% with BM25 plus
  vectors ([comparison](https://github.com/aiagentmemory/agentmemory/blob/main/benchmark/COMPARISON.md)).
  Mnemora: 72.6% answer accuracy at an 800-token budget with MiMo V2.6 Pro.

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
  Its governance code is now a slimming candidate (above).

## Decided against

- A "may not contain the answer" note in the memory packet: no net gain with
  either reading model (1.36).
- A per-record lexical floor: costs more recall than it saves (1.34, 1.36).
- Further low-yield evaluations for now: Chinese end-to-end QA, validation of
  the provisional mpnet thresholds, `bge-m3` calibration (2026-10-19).
- More relationship types, generic personality modelling, or broad provider
  integration before the task-resume gate.
- Background model-driven consolidation (Letta sleep-time agents, dreaming)
  and model-extracted facts (mem0): they promote model output into durable
  memory, and memory-core's dreaming already covers consolidation (2026-10-19).
- MCP or cross-framework servers and Ebbinghaus-style decay: no evidence of
  benefit, and outside scope discipline (2026-10-19).

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
