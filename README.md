# Mnemora

[简体中文](README.zh-CN.md)

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
  diagnostics, retrieval explanations, trust operations, and quality evaluation.

## Quick start

Mnemora requires OpenClaw `2026.6.11+` and Node.js `24`.

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
        unifiedRetrieval: { enabled: true, tokenBudget: 800, maxItems: 8 }
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

### Optional services

- `embeddings.enabled`: local Ollama semantic retrieval (disabled by default).
- `extraction.enabled`: bounded OpenAI-compatible relationship extraction
  (disabled by default).
- `contextEngine.compaction.enabled`: source-linked model compaction
  (disabled by default).
- `cognition.admission.mode: "enforce"`: deterministic candidate policy;
  beliefs and enforcement remain separately opt-in.
- `cognition.reasoningRuntime.shadowMode`: aggregates safe strategy-retrieval
  telemetry only. Reasoning delivery remains disabled unless an operator also
  calibrates and enables an exact-scope canary.
- `cognition.reasoningRuntime.semantic.enabled`: enables a separate, local
  semantic index for admitted ReasoningMemory strategies only when
  `embeddings.enabled` is also true. It is disabled by default and always
  falls back to deterministic lexical retrieval on provider failure.
- `cognition.reasoningRuntime.verification.enabled`: runs a bounded, local
  deterministic verifier after durable completed turns. It is disabled by
  default and never enables delivery or makes strategy output authoritative.
- `cognition.reasoningCuration`: optionally uses the public host runtime model
  after durable turns to create source-linked decision/outcome candidates,
  form reviewable strategy candidates, and periodically review existing
  strategies. All paths are disabled by default; none can create a user fact,
  admit a strategy, or change delivery automatically.

Every model or network call has input/output bounds, timeout, and cancellation
handling. Default installation never enables an extra automatic write path,
strict verification, model compaction, or external provider.

### Governed reasoning intake and curation

A hand-authored instruction file is appropriate for static instructions. Mnemora's
optional curation path is for source-linked, evolving procedural advice: it
keeps the confirmed outcome, the bounded model proposal, review status, and
every later human decision together in the local database.

Enable either path only after ContextEngine is configured. Curation runs
opportunistically after a *durable completed turn* for which OpenClaw exposed
its public runtime LLM; it never reads host-private model state or credentials.

```json5
cognition: {
  reasoningCuration: {
    intake: { enabled: true }, // up to two decision/outcome candidates per turn
    formation: { enabled: true }, // one outcome-backed candidate at most per turn
    review: { enabled: true, intervalHours: 168 } // weekly advisory review
  }
}
```

Intake first creates a source-linked `pending_review` candidate. It never
creates a decision, outcome, belief, fact, profile, or strategy by itself.
Review a candidate, then confirm or discard it. A confirmed decision remains
`operator_confirmed`, never an automatically asserted user fact. A confirmed
outcome can then feed formation on a later durable turn.

Formation starts only from confirmed TaskOutcomes with adequate confidence.
Its model output is also stored as `pending_review`, not as a ReasoningMemory.
Promote a candidate, then perform the existing separate admission step before
it is eligible for retrieval. Periodic review can only recommend `retain`,
`retire`, or `needs_review`; an operator must resolve it. `retire` is a
reversible lifecycle state, not a destructive deletion.

```bash
mnemora cognition reasoning intake candidates --scope project:alpha
mnemora cognition reasoning intake confirm <candidate-id> --scope project:alpha
# Repeat the returned command with --preview-hash <hash> --confirm.
mnemora cognition reasoning intake discard <candidate-id> --scope project:alpha

mnemora cognition reasoning curation formations --scope project:alpha
mnemora cognition reasoning curation promote <formation-proposal-id> --scope project:alpha
# Repeat the returned command with --preview-hash <hash> --confirm.
mnemora cognition reasoning admit <reasoning-memory-id> --scope project:alpha

mnemora cognition reasoning curation reviews --scope project:alpha
mnemora cognition reasoning curation resolve-review <review-proposal-id> retire --scope project:alpha
# Repeat the returned command with --preview-hash <hash> --confirm.
```

See [governed reasoning curation](docs/reasoning-curation.md) for failure,
retry, scope, and review semantics.

### Experimental ReasoningMemory delivery

ReasoningMemory records reusable procedures separately from personal facts.
Even after a strategy is admitted, its runtime delivery is disabled by default.
Enable shadow collection first, review readiness, then explicitly calibrate and
enable a canary for one exact scope:

```json5
cognition: {
  reasoningRuntime: {
    shadowMode: true,
    scopes: ["project:alpha"],
    delivery: {
      enabled: true,
      scopes: ["project:alpha"],
      itemRetentionDays: 30
    }
  }
}
```

Each delivered strategy is wrapped as `non_authoritative_reference` and receives
a short-lived receipt. An operator may mark a receipt helpful/neutral/harmful;
or an operator-confirmed task outcome can cite it for deterministic feedback.
A harmful signal suppresses only that strategy in that scope. `effectiveStatus`
reports the latest receipt signal; it is not delivery permission. The strategy
remains withheld until an operator explicitly resets its memory circuit, and
delivery items expose `requiresOperatorReset` while that is true. Reset records
an append-only delivery-item correction, preserving the historic harmful
signal. This never changes a strategy into a belief, fact, or graph edge, and
does not automatically disable the whole canary.

```bash
mnemora cognition reasoning runtime-delivery-items --scope project:alpha
mnemora cognition reasoning runtime-feedback-summary --scope project:alpha
mnemora cognition reasoning runtime-memory-circuit <reasoning-memory-id> --scope project:alpha
```

`mnemora cognition reasoning find` is an operator catalog/audit command and
may show a withheld strategy. Use `retrieve`, `compile`, or runtime delivery
for circuit-gated selection.

To measure whether delivery improves real tasks, run a de-identified A/B
dataset through `mnemora cognition reasoning runtime-effectiveness <file>`.
Only an operator-declared randomized comparison with at least 20 resolved
outcomes in each arm receives a non-causal point estimate and conservative 95%
interval. Shadow telemetry, adoption, synthetic benchmarks, and legacy v1
datasets are not efficacy claims.

An operator may attach a [bounded deterministic verification
specification](docs/reasoning-verification.md) to a proposed strategy. It can
compare explicit receipt citations and normalized tool outcomes in a local
append-only ledger; a mismatch only opens that strategy's delivery circuit
until an operator resets it. It performs no model, network, or tool call and
is never promoted into a belief or fact. Automatic processing remains disabled:

```json5
cognition: { reasoningRuntime: { verification: { enabled: true, maxJobsPerRun: 5 } } }
```

### Optional multilingual ReasoningMemory retrieval

Reasoning strategies may be written in a different language than a runtime
task. To make a Chinese strategy available to an English `debug` task (and the
reverse), explicitly enable the existing local Ollama embedding provider and
the separate ReasoningMemory semantic path:

```json5
embeddings: { enabled: true, provider: "ollama", model: "qwen3-embedding:4b" },
cognition: {
  reasoningRuntime: {
    shadowMode: true,
    scopes: ["project:alpha"],
    semantic: { enabled: true, timeoutMs: 1500, minScore: 0.35, maxCandidates: 50 }
  }
}
```

Indexing is an explicit local operation; it never runs during admission or
normal prompt assembly. `semantic-backfill` requires confirmation and stores
only vector bytes, model identity, input hash, and scope—not strategy text or
evidence. The standalone CLI deliberately needs an explicit local embedding
opt-in as well:

```bash
MNEMORA_REASONING_SEMANTIC_EMBEDDINGS=1 mnemora cognition reasoning semantic-status --scope project:alpha
MNEMORA_REASONING_SEMANTIC_EMBEDDINGS=1 mnemora cognition reasoning semantic-backfill --scope project:alpha --confirm
```

After changing the configured embedding model, rerun the confirmed backfill;
it detects the model identity change and refreshes the local strategy index.

The shadow report exposes aggregate `semanticCandidates`, `unmatched`, and
`taskTypeExcluded` counters. It persists no prompt, strategy, memory ID, or
source content.

## Safety model

- Memory is reference material, not an instruction or source of authority.
- Scope is enforced before retrieval and before context assembly.
- Summaries navigate durable evidence; they do not replace it.
- Automatic extraction produces candidates under policy; it does not create
  trusted user facts by itself.
- Provider migration is public, paginated, preview-first, and recoverable.
- The loopback Inspector is read-only by default and redacts raw prompts,
  credentials, provider bodies, and private paths.

## Daily operations

```bash
mnemora inspect
mnemora surface core
mnemora retrieve "What decision applies to this project?"
mnemora evaluate recall-quality ./deidentified-golden.json
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

```bash
npm run verify
```

The verification suite runs typechecking, unit tests, build, smoke tests,
plugin validation, compatibility checks, and offline quality benchmarks on
Node.js 24.

## License

[MIT](LICENSE)
