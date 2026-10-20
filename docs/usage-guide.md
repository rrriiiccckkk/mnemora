# Mnemora usage guide

For installation and everyday use, start with the [short README](../README.md).
This guide retains detailed configuration, operating procedures and experimental controls.

[简体中文](usage-guide.zh-CN.md)

> Local-first, evidence-first memory runtime for persistent OpenClaw agents.

Mnemora helps an agent retain useful context without treating every retrieved
sentence as truth. It keeps durable memory local, preserves provenance, and
applies scope, freshness, confidence, and safety policy before memory reaches
an agent.

```text
Conversation / notes / public providers
                │
                ▼
Journal + source-linked memory + knowledge graph
                │
                ▼
Scoped retrieval, compaction, and trust policy
                │
                ▼
OpenClaw ContextEngine
```

## What Mnemora combines

Mnemora is an independent implementation informed by the public ideas behind
`lossless-claw` and `memory-lancedb-pro`:

- from lossless-style systems: durable conversation capture, bounded
  compaction, restart-safe summaries, and protected recent context;
- from vector-memory systems: local semantic and lexical retrieval, relevance
  ranking, reranking, and memory lifecycle controls;
- beyond either individual approach: source-linked graph evidence, exact scope
  isolation, unified retrieval across Journal/Episodes/Artifacts/memory,
  provenance-aware context, explicit correction and forgetting, and
  preview/confirm governance for consequential changes.

It does not copy, vendor, read, or modify either project's private code,
database, or host state. External systems are reached only through documented
public capabilities and explicit provider adapters.

## Core capabilities

- **One automatic lifecycle.** When selected as OpenClaw's ContextEngine,
  Mnemora's ContextEngine lifecycle uses the public `afterTurn` and assembly
  callbacks. It registers no `before_prompt_build` or `agent_end` hook.
- **Local-first memory.** SQLite stores Journal events, source-linked summaries,
  episodes, artifacts, memory documents, graph evidence, beliefs, decisions,
  and audit metadata on the local machine.
- **Relevant, bounded recall.** Unified lexical, semantic, and hybrid retrieval
  uses scope filtering, score floors, diversity, freshness, token budgets, and
  provenance deduplication.
- **Evidence and trust.** Graph observations carry source, time, confidence,
  and verification state. An LLM may propose a candidate; it never becomes the
  memory authority.
- **Memory can change safely.** Corrections, conflicts, retention, and forgetting
  preserve auditability. High-impact changes use preview/confirm flows.
- **Operator visibility.** The local Inspector and `mnemora` CLI expose
  diagnostics, scope-bound memory workbenches, retrieval explanations, trust
  operations, and quality evaluation.

## Quick start

Mnemora requires OpenClaw `2026.9.2+` and supports Node 24.x from `24.15.0`, or Node `25.9.0+`, including Node 26. The local default is 26.5.0; CI covers 24.19.0 and 26.5.0 on Linux and Windows. The lower patch boundaries preserve the host SQLite safety requirements; they do not require a downgrade from Node 26.

```bash
git clone https://github.com/rrriiiccckkk/mnemora.git
cd mnemora
npm ci
npm run build
```

Install the built plugin through your normal OpenClaw plugin workflow. Then
enable Mnemora and select its ContextEngine slot in host configuration:

```json5
plugins: {
  entries: {
    mnemora: {
      enabled: true,
      config: {
        conversationJournal: { enabled: true },
        contextEngine: { enabled: true },
        episodicMemory: { enabled: true },
        unifiedRetrieval: {
          enabled: true,
          shadowMode: true, // bounded, redacted automatic-recall telemetry
          tokenBudget: 800,
          maxItems: 8,
          diversityLambda: 0.75
        }
      }
    }
  },
  slots: { contextEngine: "mnemora" }
}
```

This is deliberately explicit. Until the host selects the exact slot, Mnemora
stays manual-only. Check the local deployment state with:

```bash
mnemora standalone status
mnemora standalone guide
```

### Verify first use

Once Mnemora is selected, use the in-chat `/mnemora verify` flow to confirm
the installation with linked evidence from the running plugin rather than from
a configuration file alone:

1. Run `/mnemora verify start`, then include its exact one-hour marker in a
   short fact in one conversation.
2. Start a different conversation and ask a specific question containing that
   same marker.
3. Run `/mnemora verify` after Mnemora has actually attached the memory.

It reports four plain-language checks: the ContextEngine slot was activated,
the current marker was durably captured, the linked attachment came from a
different conversation, and that actual attachment contained the marker.
Historic event counts and recall telemetry are only baseline diagnostics; they
cannot complete this acceptance. The bounded `unifiedRetrieval.shadowMode`
telemetry remains required to observe the attachment. The acceptance ledger
stores only hashes of the random marker and session identities—not prompts,
candidate text, event IDs, or retrieved content. If a check is incomplete, the
command names the next safe action.

### Inspect and correct memory

`mnemora inspect` opens a scope-bound workbench: accepted facts, pending
reviews, stale material, and conflicts are shown as cards before the detailed
memory browser. A known-claim card opens its scope-bound evidence trace. The
Recall explanation panel separates a policy trace (what
would be retrieved) from a real ContextEngine attachment. The latter is shown
only when matching, redacted shadow telemetry exists; a routed query is marked
as not comparable rather than treated as proof of attachment.

### Resume a task

Use `mnemora resume <task query> --scope <scope>` or
`mnemora resume --task-ref <mnemora-task-episode-ref> --scope <scope>` to read
a source-linked task projection. The Inspector's **Task resume** view exposes
the same read-only result. It uses active task Episodes plus confirmed
Decisions and TaskOutcomes; it returns bounded candidates when the task is
ambiguous, marks unavailable evidence for reconfirmation, and never starts
work, changes memory, or changes automatic recall. A confirmed TaskOutcome can
optionally cite one exact Decision action and record its state (attempted,
partial, completed, failed, cancelled, or superseded). Only an explicit link
can suppress that action from **Next steps**; constraints are separate from
blockers and superseded action history remains source-linked. A detailed
projection identifies (`truncated_sections`) only the state sections whose
displayed records reached the caller's limit; presentation limits never change
the fully resolved task state.

`memory_evidence` on the task and each candidate separates readable source
availability (`source_available`) from an accepted current state with active
evidence (`accepted_current_state_available`). If only the source is available,
`needs_reconfirmation` is a memory-coverage warning, not proof that the real
task state is unknown; inspect the source before asking the user to repeat it.
Forgotten and hash-only sources are not reported as readable. These fields do
not promote raw messages into confirmed outcomes.

Inspector shows both coverage checks on each task candidate and selected task.
Its **Recorded progress** label describes the stored projection, not a new
real-world verification. A source-only coverage gap asks the reader to inspect
evidence first; unavailable sources are never presented as readable merely
because a reference exists. Reading or selecting a task remains read-only.

The v1.32 projection adds bounded `source_evidence`
excerpts, separate from accepted task state; this is not an efficacy claim.
See [source evidence and matched reruns](task-resume-source-evidence.zh-CN.md).
Run `npm run benchmark:task-resume` for the 26-sequence synthetic functional
evaluation. `mnemora evaluate task-resume-comparison <plan.json>` validates and
reports the three-arm experiment contract without calling a model. Its bundled
plan is intentionally reported as `real_effect_experiment_not_run` until an
authorized, de-identified measurement is supplied. The comparison reports
irrelevant memory injection only when every case has a reviewed label; missing
labels are reported as unmeasured, never as zero.

Before the next real experiment, use `mnemora evaluate task-resume-register
<planned-plan.json>` to freeze its plan and fixed v1.32 policy, then
`mnemora evaluate task-resume-decision <measured-plan.json> <registration.json>`
to check the held-out value gate. These file-only commands do not open a memory
database. A pass permits review, not pilot activation or an efficacy claim;
an independently timestamped pre-run record is still required. See the
[preregistration execution guide](task-resume-preregistration.zh-CN.md)
for material hashes, sample floors and the zero-baseline rule.

When the Inspector is explicitly started with operations enabled, a journal
event, artifact, episode, or summary can be removed through its item card. The
Inspector first shows bounded downstream impact counts, then accepts one
short-lived confirmation. It never overwrites the original evidence or exposes
dependent IDs; affected decisions become review-only.

### Where recall is attached

Automatic recall is one `<MNEMORA_MEMORY authority="non_authoritative">` block.
Since 1.37 it is placed at the start of the active (newest) user message,
followed by a blank line and the user's own text. Reading models used it there
and largely ignored it as a system prompt addition: on LongMemEval preference
questions, answer accuracy rose from 8/30 to 16/30 (`mimo-v2.6-pro`) and from
5/30 to 18/30 (`mimo-v2.6-flash`) with semantic recall, with abstention and the
other question types unchanged ([Recall quality](recall-quality.md)). The text
and its token cost are the same in both places.

- `contextEngine.recallPlacement`: `"user"` (default) or `"system"` for the
  earlier system prompt addition.
- Host message objects are copied, never changed. When there is no user
  message, or its content has an unknown shape, the block falls back to the
  system prompt addition.
- A turn that carries the block is captured, fingerprinted and used for
  queries without it, so recall never returns as the user's own words.
- The block is still non-authoritative reference: records are sanitized, and
  reserved tags and role lines inside them are neutralized as before
  ([threat model](threat-model.md)).

### Time phrases and relative dates

Records carry when they were recorded. Two local, deterministic aids connect
that to the times people talk about (`unifiedRetrieval.timeAnchors`, on by
default; set `false` to turn both off):

- A time phrase in the prompt ("10 days ago", "last Saturday", "last
  weekend", "last month", "上周六", "三天前") becomes a window of dates. Its
  words are left out of matching, records from the window are also searched
  on their own, and a record recorded in the window, or mentioning an event in
  it ("I cleaned them last month", recorded today), wins near ties with
  records from other days. A much closer match from another day still ranks
  first: the window breaks ties, it does not filter. "How many days ago did
  I…" asks for a count and is not a window.
- Relative dates inside a recalled record are resolved against its recording
  time and shown in its header, never by rewriting the quote:
  `recorded_at=2023-05-25T…; dates=three weeks ago≈2023-05-04, yesterday≈2023-05-24`.
  Only unambiguous forms are resolved: "next Saturday" and "a few weeks ago"
  are left as written.

Days are the local calendar days of the process running Mnemora.

### Automatic-recall precision

Manual search may return broad candidates for exploration. Automatic context is
stricter: before Mnemora attaches a local record or graph supplement, it
requires a non-generic query anchor in the candidate, or a graph semantic score
of at least `0.72`. It uses one graph seed (with one evidenced hop) and a
deterministic MMR pass to avoid near-duplicate local context. Consequently, a
generic question such as “How does the memory system work?” will not attach a
company merely because its description contains “memory.” An empty attachment
is the safe result when no candidate proves relevance.

`unifiedRetrieval.shadowMode` is opt-in and stores only a query hash plus
bounded counts of local/graph candidates, suppressions, and attachments. It
never stores prompt text, candidate text, IDs, sources, or evidence. Inspect
it alongside existing adaptive-recall metrics:

```bash
mnemora recall metrics --scope default
```

The `unified` section reports the real ContextEngine attachment path; it does
not alter retrieval or injection. Set `diversityLambda: 1` to retain score-only
ordering, or keep the default `0.75` for modest deterministic diversification.

### Graph review and local embedding health

`kg_review` (full tool surface) serves four kinds: `duplicates` (pair with
`kg_merge`), `anomalies` (relationship conflicts and self-links), `identity`,
and `semantic_patterns`. Decisions are preview then explicit confirm. New
`related_to` edges require retained direct evidence and default to a `0.85`
confidence floor; an endpoint that does not match the relation's expected
types is kept as a soft `endpoint_match: false` flag on the edge, never as a
retyped entity.

Graph governance was removed in 1.38.0: the `hygiene`, `worklist`,
`schema_drift`, `semantic_vocabulary`, `related_edge_refinements`, and
`related_edge_semantics` review kinds (they now fail with
`review_kind_removed`), the `review gate`, `review worklist`, and
`review vocabulary` CLI commands, and scheduled hygiene. Their tables stay so
existing databases load, hard forget still clears them, and previously
accepted related-edge labels remain readable through
`kg_related(..., semantic_predicates: [...])`. `quality.hygiene` is still
accepted in configuration but has no effect.

The built-in `uses` relation accepts `person` or `company` as its source and a
`product` or `technology` as its target, so a person using a product is not
relabeled as a company. The built-in `develops` relation accepts a `company`
developing a `product` or `concept`.

Scope-exclusive anomalies such as a self-link can be cleaned up through the
audited operator CLI flow:

```bash
MNEMORA_DB=/path/to/mnemora.db node dist/cli.js review anomalies preview edge:example --scope default
MNEMORA_DB=/path/to/mnemora.db node dist/cli.js review anomalies confirm edge:example --scope default --preview-hash <hash> --confirm
```

Cleanup never runs automatically: confirmation must match a fresh preview
hash, writes an audit receipt, and refuses an edge with evidence in any other
scope.

`kg_stats` includes `embedding_health`, an observed local status rather than a
live provider probe. `healthy` and `degraded` are based only on bounded local
embedding successes or categorical failures; `hybrid` search deterministically
falls back to lexical results, while explicit `semantic` search returns a
bounded unavailable error.

### Optional services

- `embeddings.enabled`: local Ollama semantic retrieval (disabled by default).
- `extraction.enabled`: bounded OpenAI-compatible relationship extraction
  (disabled by default).
- `contextEngine.compaction.enabled`: source-linked model compaction
  (disabled by default).
- `cognition.admission.mode: "enforce"`: deterministic candidate policy;
  beliefs and enforcement remain separately opt-in.

Every model or network call has input/output bounds, timeout, and cancellation
handling. Default installation never enables an extra automatic write path,
strict verification, model compaction, or external provider.

### Agent isolation

Automatic memory is isolated per agent by default (`scope.isolation: "agent"`).
Each agent reads and writes its own scope `agent:<id>`, derived from the host
session key `agent:<id>:...`. The default agent (`scope.defaultAgentId`, `main`
unless configured) keeps `scope.default`, so single-agent installations see
their existing memory unchanged. Manual tools follow the same rule: for a
non-default agent every `scope` argument is pinned to that agent's scope, and
cross-scope administration tools (`kg_stats`, `kg_scopes`, `kg_forget`,
`kg_merge`, `kg_merge_undo`, `kg_export`, `kg_import`, `kg_embed_backfill`)
are not offered to it. Set `scope.isolation: "shared"` to restore the
pre-1.33 behaviour where every agent shares `scope.default`.

### Tool surface

`toolSurface` defaults to `core` (ten everyday memory tools). Use `research`
for analysis and saved-query tools, or `full` for every operational tool.

### Semantic journal recall

With `embeddings.enabled: true`, captured conversation turns are embedded by the
local Ollama model after each turn (`unifiedRetrieval.semantic.embedPerTurn`
chunks, default 128) and automatic recall fuses bm25 with cosine similarity:

- a record that shares no word with the prompt is attached when its similarity
  reaches `semantic.minSimilarity`;
- memory is attached only if at least one record is semantically close
  (`minSimilarity`), carries an exact identifier, or is a lexical hit that is
  among the prompt's nearest embedded records above `semantic.gateSimilarity`
  and matches at least 0.15 of the prompt's terms. This gate
  decides whether the prompt is answered from memory at all; once it opens,
  every lexical hit is judged on its own words, as without embeddings.
  Records without a vector yet are never judged by the gate. An explicit
  `minQueryMatch` still applies to each record.

Both thresholds depend on the embedding model. When they are unset, Mnemora
uses the values calibrated for the configured model (matched by name, with
any Ollama `:tag` or `vendor/` prefix ignored):

| Model | `minSimilarity` | `gateSimilarity` | Calibrated on |
|---|---:|---:|---|
| `all-minilm` (all-MiniLM-L6-v2), English only | 0.45 | 0.2 | LongMemEval_S, English |
| `paraphrase-multilingual-MiniLM-L12-v2` | 0.65 | 0.3 | LongMemEval_S, Chinese |
| `bge-small-zh-v1.5` | 0.6 | 0.45 | LongMemEval_S, Chinese |
| `paraphrase-multilingual` (Ollama; mpnet-base-v2) | 0.65 | 0.35 | LongMemEval_S, Chinese, 24 questions (provisional) |
| any other model | 0.45 | 0.2 | not calibrated |

`all-minilm` is English only: on Chinese history it ranks the evidence 42nd at
the median and attached memory to every off-topic prompt, which is worse
than lexical recall alone. Prompts with Chinese, Japanese, Korean or other
non-Latin text therefore skip semantic recall with it and behave as without
embeddings. For Chinese or mixed-language history use a multilingual model;
of those measured, `bge-small-zh-v1.5` recalled most. For a model that is not
in the table, calibrate on your own data:

```bash
MNEMORA_CAL_EMBED_MODEL=<model> npm run eval:calibrate-semantic -- run <longmemeval.json[.gz]> 0:50 cal.jsonl
npm run eval:calibrate-semantic -- report cal.jsonl
```

then pick a `minSimilarity` at which foreign and off-topic prompts rarely
pass and check the pair with `npm run eval:longmemeval`
(`MNEMORA_EVAL_EMBED_MODEL`, `MNEMORA_EVAL_MIN_SIMILARITY`,
`MNEMORA_EVAL_GATE_SIMILARITY`). Explicit settings always win. An unavailable
provider never blocks capture or recall; recall falls back to lexical.

After enabling embeddings on an existing database, embed the backlog once:

```bash
MNEMORA_DB=~/.openclaw/mnemora.db node dist/cli.js journal embed --model all-minilm --limit 50000
```

`--scope`, `--base-url` (default `http://127.0.0.1:11434`) and `--limit` are
optional; the command is resumable and changes nothing but the vector table.
Vectors are removed with their records on forget, tombstone, redaction and
restore.

### Reusing OpenClaw's embedding provider

Instead of a separate Ollama model, semantic recall can use the embedding
provider that OpenClaw already configures for its own memory search
(`memory.search.provider`, `model` and `remote`; OpenAI
`text-embedding-3-small` by default, or Gemini, Ollama, Voyage, Mistral and
the other adapters OpenClaw ships):

```json
{ "embeddings": { "enabled": true, "provider": "host" } }
```

- OpenClaw resolves the provider and holds the credentials; Mnemora never
  reads an API key. `baseURL` and `model` in Mnemora's own `embeddings`
  block are ignored with `provider: "host"`.
- Vectors are stored as `host:<provider>` plus the model, so they are never
  compared with vectors from Ollama or from another host model. Changing
  `memory.search.provider` or `model` starts a fresh index; the old vectors are kept, unused, and are removed
  with their records.
- The selection uses `scope.defaultAgentId` (default `main`); per-agent
  `memorySearch` overrides for other agents are not applied.
- If memory search is disabled, its provider is `none`, or the provider is
  unknown, Mnemora logs `host embeddings unavailable` with the reason and
  recall stays lexical. A provider that fails at run time (for example a
  missing API key) counts as an embedding failure: recall falls back to
  lexical for that turn and creation is retried at most once a minute.
- History captured before embeddings were enabled is embedded gradually, up
  to `semantic.embedPerTurn` chunks per turn. `journal embed` on the command
  line talks to Ollama directly and cannot use the host provider.
- Every captured turn is sent to that provider. With a hosted provider this
  is a new flow of conversation text to a third party and is billed by it,
  which is why `provider: "host"` is opt-in.
- Hosted models such as `text-embedding-3-small` are not in the threshold
  table above and use the uncalibrated defaults; set `semantic.minSimilarity`
  and `gateSimilarity` after calibrating on your own data.

With OpenClaw's Ollama adapter pointed at the same `all-minilm` model, the
host path returned the same vectors as the direct Ollama path (90 texts from
the 30 LongMemEval_S preference questions, minimum cosine 1.0), so recall is
the same.

### Relevance floor and knowledge updates

`unifiedRetrieval.minQueryMatch` is the minimum rarity-weighted share of prompt
terms a record must match to be attached automatically. It defaults to 0.15
while semantic recall is active and 0 otherwise: on lexical evidence alone the
floor costs more recall than it saves (see [recall quality](recall-quality.md)).
Manual search is never floored, and an exact identifier such as `TASK_4821`
always passes.

When an earlier and a later record on the same topic are both attached, the
earlier one carries `newer_related=<n>` and the envelope states that the most
recent statement is current. Both stay visible as evidence; Mnemora does not
guess at contradictions.

### Operational health

Optional memory work is fail-open: when recall, embedding, compaction or a
lifecycle step fails, the host turn still succeeds. Since 1.35 such failures
are no longer silent. Each one is counted per day in
`mnemora_operation_failures` (kept 30 days) with a coarse category
(`timeout`, `aborted`, `busy`, `corrupt`, `network`, `invalid_response`,
`unavailable`, `error`), and the gateway log gets at most one line per
operation and category every 10 minutes, with the number suppressed.
Error messages, prompts, record text and scope names are never stored or
logged.

```bash
MNEMORA_DB=~/.openclaw/mnemora.db node dist/cli.js health            # last 7 days
MNEMORA_DB=~/.openclaw/mnemora.db node dist/cli.js health --days 30
```

`status` is `attention` when anything failed or evidence needs review.
Operations: `capture`, `recall_assemble`, `journal_search`, `semantic_query`, `journal_embed`, `graph_embed`, `turn_lifecycle`, `compaction`, `compaction_projection`, `tool_projection`, `recall_relevance_advice`, `session_scope_lookup`, `first_use_observation`, `graph_signal`, `audit_schedule`, `formation_observe`, `vector_mirror`, `auto_extract`, `corrupt_record`.
A steady `recall_assemble` or `journal_search` count means automatic recall
is not working; `journal_embed` with `timeout` or `unavailable` usually means
the Ollama endpoint is down.

### ReasoningMemory (removed)

The experimental ReasoningMemory runtime, curation, intake, delivery and
verification pipeline was removed in 1.33. `cognition.reasoningRuntime` and
`cognition.reasoningCuration` are still accepted so existing configuration
loads, but they are ignored. Existing ReasoningMemory tables are left in
place untouched for backup compatibility.

## Safety model

- Memory is reference material, not an instruction or source of authority.
- Scope is enforced before retrieval and before context assembly.
- Summaries navigate durable evidence; they do not replace it.
- Automatic extraction produces candidates under policy; it does not create
  trusted user facts by itself.
- Provider migration is public, paginated, preview-first, and recoverable.
- The loopback Inspector is read-only by default and redacts raw prompts,
  credentials, provider bodies, and private paths.
- Its memory-removal path exists only with operations enabled, is CSRF
  protected, and always requires a fresh impact preview followed by explicit
  confirmation.
- Inspector backup registration is bounded to 1,000 new artifacts. At capacity
  a new backup or recovery registration fails explicitly; Mnemora never
  silently prunes existing artifacts. A valid legacy inventory remains
  readable, while a damaged or oversized inventory is reported as degraded
  rather than as an empty healthy registry.

## Daily operations

```bash
mnemora inspect
mnemora surface core
mnemora retrieve "What decision applies to this project?"
mnemora resume "deployment migration" --scope project:alpha
mnemora evaluate recall-quality ./deidentified-golden.json
```

For a tuning-only threshold scan, use an explicitly selected authorized corpus
snapshot and `evaluate recall-threshold-scan <plan.json>`; see
[threshold evaluation](recall-threshold-evaluation.md). This command requires
an existing schema-compatible database, opens it read-only without migration,
and never changes defaults or treats synthetic scores as deployment evidence.

`cognition feedback evidence <target-ref> --scope <scope>` uses the same explicit
read-only snapshot boundary for a bounded usefulness-evidence worklist.
Citations are not confirmations, missing attachment telemetry is unknown,
and no labels or calibration are changed. See [evidence limits](recall-usefulness-review.zh-CN.md).
Optional per-assembly version receipts and preview-confirmed source links are
described in [attachment evidence](recall-attachment-evidence.zh-CN.md).
These are not causal turn attribution or automatic usefulness labels.

The CLI uses `~/.openclaw/mnemora.db` by default. When it creates a persistent
database for the first time, it reports the exact path on stderr; set
`MNEMORA_DB` to select a different database explicitly.

OpenClaw installs an extension without creating npm's global `mnemora` bin
shim. From an unpacked plugin directory, invoke the bundled CLI directly:

```bash
MNEMORA_DB=~/.openclaw/mnemora.db node dist/cli.js stats
```

The bundled `/mnemora` command provides read-only status, diagnostics, and
explicit canonical-corpus operations. Use the `core`, `research`, or `full`
tool surface to control how much tool schema an agent receives; the compatible
default is `full`.

## Boundaries

Mnemora is a local memory runtime, not an omniscient profile generator. It
does not infer personality as fact, access private host/plugin storage, or
silently cross project scopes. Providers without a documented public inventory
remain explicit-reference-only.

## Development

Before adding fixtures, diagnosing storage/configuration, or upgrading an
existing installation, read the [maintenance lessons and operational boundaries](maintenance-lessons.zh-CN.md).

```bash
npm run verify
```

The verification suite runs typechecking, unit tests, build, smoke tests,
plugin validation, compatibility checks, and offline quality benchmarks on
Node.js 24.19.0 and 26.5.0 (the supported patch boundaries are 24.15.0 on 24.x, or 25.9.0+).

## License

[MIT](../LICENSE)
