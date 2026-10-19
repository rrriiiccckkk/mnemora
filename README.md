# Mnemora

[简体中文](README.zh-CN.md)

> Local-first, evidence-first memory for persistent OpenClaw agents.

Mnemora records an agent's conversations in a local SQLite journal and, on each
new prompt, attaches the few past records most relevant to it, with sources.
An agent can pick up work across conversations, show where a remembered fact
came from, and stop using it after a correction or a request to forget.
Recalled text is reference material, never an instruction or an automatically
verified fact.

Mnemora is an independent implementation informed by the public ideas behind
`lossless-claw` and `memory-lancedb-pro`. It does not read other plugins' private storage.

## What you can do

- **Recall across conversations:** relevant earlier turns are attached
  automatically within a token budget, each with a source reference and
  capture time.
- **Keep agents apart:** memory is isolated per agent by default; one agent
  never sees another agent's records.
- **Continue a task:** inspect completed work, failed attempts, blockers and
  next steps, with source links and explicit uncertainty.
- **Check what the agent remembers:** the local Inspector shows evidence,
  pending candidates, stale records and conflicts.
- **Correct and forget deliberately:** scoped correction and forgetting, with
  preview/confirm for consequential changes; forgotten text leaves the search
  index and vectors too.

## How recall works

1. **Capture.** Completed turns are written to the journal through the
   ContextEngine and split into overlapping chunks in a bm25 full-text index
   (Chinese is word-segmented).
2. **Optional semantic index.** With local embeddings enabled, new chunks are
   embedded after each turn by your Ollama model.
3. **Retrieve.** The prompt is matched lexically and, when available,
   semantically. Results are ranked by relevance, source authority and
   freshness.
4. **Filter.** Records that only share common words with the prompt are
   dropped. With embeddings, a lexical hit must also be semantically close, and
   a semantically close record may be attached without shared words.
5. **Attach.** At most `maxItems` records within `tokenBudget` are attached in a
   non-authoritative envelope. Earlier records on the same topic point to later
   ones (`newer_related`), so the model can tell which statement is current.

## Quick start

Requires OpenClaw `2026.9.2+` and Node.js `24.15.0+` on 24.x, or `25.9.0+` (including Node 26).
Node 26.5.0 is the local default; no downgrade to Node 24 is required.
CI validates Node 24.19.0 and 26.5.0 on Linux and Windows. See the
[usage guide](docs/usage-guide.md) for compatibility details.

### Install

Prefer the `mnemora-<version>.tgz` asset from
[GitHub Releases](https://github.com/rrriiiccckkk/mnemora/releases), not the
source-code archive. Each asset is cleanly rebuilt, unpacked and verified before
upload, and `SHA256SUMS` is provided. To build from source:

```bash
git clone https://github.com/rrriiiccckkk/mnemora.git
cd mnemora
npm ci
npm run build
```

Rebuild after every source update; `npm run release:pack` creates a verified
installable archive. A version string alone does not verify `dist/`.

### Configure

Install the built plugin through your OpenClaw plugin workflow, then merge this
into the host configuration:

```json5
plugins: {
  entries: {
    mnemora: {
      enabled: true,
      config: {
        conversationJournal: { enabled: true },
        contextEngine: { enabled: true },
        episodicMemory: { enabled: true },
        unifiedRetrieval: { enabled: true, tokenBudget: 800, maxItems: 8 },
        // Optional: local semantic recall through Ollama.
        // embeddings: { enabled: true, provider: "ollama", model: "all-minilm" }
      }
    }
  },
  slots: { contextEngine: "mnemora" }
}
```

Restart the OpenClaw process that loads the plugin. Automatic capture and
context assembly require the host to select Mnemora's ContextEngine slot;
enabling the plugin alone is not enough.
Mnemora uses a single ContextEngine lifecycle and
registers no `before_prompt_build` or `agent_end` hook.

To turn on semantic recall, run `ollama pull all-minilm` (or a multilingual
model such as `bge-m3` for Chinese), enable `embeddings`, and embed existing
history once:

```bash
MNEMORA_DB=~/.openclaw/mnemora.db node dist/cli.js journal embed --model all-minilm
```

### Verify the running installation

From the built plugin directory:

```bash
node dist/cli.js standalone status
node dist/cli.js standalone guide
```

In chat, run `/mnemora verify start`. Put its exact marker in a short fact,
ask about that marker in a different conversation, then run
`/mnemora verify` after memory has actually been attached.
This checks runtime activation, durable capture and cross-conversation
attachment; event counts alone do not prove it works.
See [first-use verification](docs/usage-guide.md#verify-first-use).

## Everyday use

Run these from the built plugin directory:

```bash
MNEMORA_DB=~/.openclaw/mnemora.db node dist/cli.js stats
node dist/cli.js health
node dist/cli.js inspect
node dist/cli.js resume "deployment task" --scope project-a
```

`health` lists optional operations that failed in the last 7 days (recall,
embedding, compaction and others fail open, so the host keeps working). The
CLI defaults to `~/.openclaw/mnemora.db`. Set `MNEMORA_DB` explicitly
when your deployment uses another path. OpenClaw's extension installation
does not necessarily create a global `mnemora` command; direct invocation
above does not need one.

Task resume is read-only: it does not execute a plan or confirm a candidate.
Ambiguous tasks remain separate until selected; selected tasks can include
bounded readable `source_evidence` excerpts without promoting them to accepted
task state. See [source evidence and reruns](docs/task-resume-source-evidence.zh-CN.md).

For a source-history cutoff, use
`INTENT=exact_history RECORDED_BEFORE=<Unix milliseconds> node dist/cli.js retrieve "query"`.
It returns source records only and never revives forgotten data.

## Key settings

| Setting | Default | Meaning |
|---|---|---|
| `scope.isolation` | `"agent"` | Each agent gets its own scope `agent:<id>`; the default agent (`scope.defaultAgentId`, `main`) keeps `scope.default`. `"shared"` puts every agent in one scope. |
| `toolSurface` | `"core"` | Ten everyday memory tools. `"research"` adds analysis and saved queries; `"full"` exposes all 32. |
| `unifiedRetrieval.tokenBudget` / `maxItems` | 800 / 8 | Upper bound on attached memory per prompt. |
| `unifiedRetrieval.minQueryMatch` | 0.15 with embeddings, 0 without | Minimum rarity-weighted share of prompt terms a record must match. |
| `embeddings.enabled` | `false` | Local Ollama embeddings for semantic recall. |
| `unifiedRetrieval.semantic.minSimilarity` / `gateSimilarity` | 0.45 / 0.2 | Cosine thresholds, calibrated on `all-minilm`; recalibrate for other models. |

Everything else, including compaction, extraction, cognition and trust-layer
options, is described in the [usage guide](docs/usage-guide.md).

## Recall quality

Measured on [LongMemEval_S](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)
with the real automatic path, an 800-token budget and at most 8 items.
"Session hit" means an attached record comes from a session that contains the
answer; "turn hit" means an attached record is an answer turn. Unrelated
questions are questions borrowed from other test cases, whose evidence is
absent from the history being searched.

| Build | Session hit | Turn hit | Preference questions | Unrelated questions with memory attached |
|---|---|---|---|---|
| 1.32.18 | 9.8% | 5.5% | — | — |
| 1.33.0 | 93.8% | 83.2% | 56.7% | 90.6% |
| 1.34.0, lexical | 93.6% | 82.6% | 53.3% | 90.6% |
| 1.34.0, with `all-minilm` embeddings ¹ | 82.8% | 70.7% | 73.3% | 66.7% |
| bm25 baseline, same budget | 94.9% | 81.5% | 70.0% | — |

¹ 60-question subset (all 30 preference questions and 30 random others), so
not directly comparable with the 500-question rows. Lexical recall on the same
subset: 72.4% / 65.5% / 53.3% / 85.0%. Non-preference questions are unchanged
(92.9% session hit either way). Details in [recall quality](docs/recall-quality.md).

These are retrieval measurements. Reproduce with `npm run eval:longmemeval`.

End-to-end answer accuracy (1.35.0): the same 500 questions answered by a
reading model from the attached memory and graded by a judge (MiMo V2.6 Pro),
with the same 800-token budget.

| Question type | No memory | bm25 baseline | Mnemora 1.35.0 |
|---|---|---|---|
| **All** | 7.6% | 67.8% | **72.6%** |
| single-session-user | 0% | 90.6% | 92.2% |
| single-session-assistant | 12.5% | 91.1% | 91.1% |
| single-session-preference | 0% | 40.0% | 43.3% |
| multi-session | 0% | 41.3% | 48.8% |
| temporal-reasoning | 0.8% | 63.0% | 68.5% |
| knowledge-update | 0% | 83.3% | 90.3% |
| abstention | 100% | 93.3% | 96.7% |
| Mean context tokens | 0 | 774 | 672 |

Reproduce with `npm run eval:longmemeval-qa` (needs an OpenAI-compatible
endpoint).

## Safety and limits

- **Sources are not confirmations.** A user request is not proof of completion;
  an assistant's report is not independent verification.
- **Scope and lifecycle matter.** Invalid or forgotten sources must not revive
  accepted work; uncertain evidence stays visibly uncertain.
- **Recalled text cannot give orders.** It is quoted inside a
  non-authoritative envelope; role lines and override phrases are neutralised.
- **Local-first is not offline-only.** Configured model, embedding or provider
  integrations may make external calls.
- **Unanswerable questions still get context.** When the answer is not in
  history, the closest records are usually attached anyway; the reading model
  must decide that they do not answer the question.

For attack surfaces and safeguards, read the [threat model](docs/threat-model.md).

## Documentation

Start with the [usage guide](docs/usage-guide.md) for complete configuration,
first-use checks, correction workflows and operating commands.

- **Recall:** [recall quality](docs/recall-quality.md),
  [threshold evaluation](docs/recall-threshold-evaluation.md),
  [attachment receipts](docs/recall-attachment-evidence.zh-CN.md),
  [usefulness boundaries](docs/recall-usefulness-review.zh-CN.md),
  [relevance shadow](docs/recall-relevance-shadow.md) and
  [relevance evaluation](docs/recall-relevance-evaluation.md).
- **Task continuation:** [evaluation](docs/task-resume-evaluation.md),
  [source evidence](docs/task-resume-source-evidence.zh-CN.md),
  [one-command regression](docs/task-resume-regression.zh-CN.md) and
  [formal three-arm runner](docs/task-resume-experiment-runner.zh-CN.md).
- **Optional classifiers:** [semantic admission classifier](docs/semantic-classifier.md).
- **Planning:** [roadmap](docs/roadmap.md) and
  [release notes](docs/releases/v1.36.0.md).

Some detailed guides are currently available in Chinese only.

## Development

Read the [maintenance lessons](docs/maintenance-lessons.zh-CN.md) before
adding fixtures, changing storage/configuration or upgrading a deployment.

```bash
npm run check
npm run verify:fast
npm run test:host
npm run verify
```

The full suite includes serial unit tests, build, browser checks, benchmarks
(including fixed recall probes), plugin validation, smoke tests and the SDK
compatibility gate. Release tags require successful Windows and Linux CI for
the exact commit. See [local development](docs/development.md) for the isolated
host, the project trial and the persistent project memory adviser.

## License

[MIT](LICENSE)
