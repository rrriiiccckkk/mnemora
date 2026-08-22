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

Every model or network call has input/output bounds, timeout, and cancellation
handling. Default installation never enables an extra automatic write path,
strict verification, model compaction, or external provider.

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
