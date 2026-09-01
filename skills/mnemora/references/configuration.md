# Mnemora configuration guide

The packaged schema in `openclaw.plugin.json` is the configuration authority.
Use it to validate keys and bounds. `README.md` and `README.zh-CN.md` explain
the supported operating profiles. Preserve the host configuration around
`plugins.entries.mnemora.config`; do not replace the whole host config.

## Inspect before changing

1. Read the active `plugins.entries.mnemora` configuration when the user has
   made it available. Treat credentials and local paths as sensitive.
2. Use `mnemora standalone status` and `mnemora standalone guide` for
   read-only deployment readiness. Use `mnemora journal status`,
   `mnemora recall metrics --scope <scope>`, `mnemora cognition status`, or
   `kg_stats` only for the subsystem the user is diagnosing.
3. Distinguish configured, selected, and observed: a plugin can be installed
   but disabled; a ContextEngine can be enabled but not selected in the host
   slot; a selected feature can have no usable data yet.

Do not claim that a model provider, an embedding server, or a corpus directory
is healthy merely because it is configured. Use the relevant observed status.

## Core operating profiles

### Manual graph and memory tools

Enable the plugin only. Leave `contextEngine`, `conversationJournal`, and
`unifiedRetrieval` off. This exposes manual tools without capturing turns or
adding prompt context.

### Primary ContextEngine, bounded automatic memory

This is the smallest profile that lets Mnemora own the public ContextEngine
lifecycle. The host must explicitly select the one ContextEngine slot.

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
          shadowMode: true,
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

Selecting the slot changes the host's context lifecycle. Do not select it or
disable another ContextEngine without explicit user authorization. This profile
does not enable LLM extraction, graph writes, model compaction, strict trust
gating, or ReasoningMemory delivery.

`unifiedRetrieval.shadowMode` records bounded, redacted attachment telemetry.
It does **not** turn automatic recall into a dry run: when
`unifiedRetrieval.enabled` is true, eligible context can still be attached.
For a true no-attachment setup, keep `unifiedRetrieval.enabled` false.

### Local semantic retrieval

Enable only after a local Ollama endpoint and model are available:

```json5
embeddings: {
  enabled: true,
  provider: "ollama",
  baseURL: "http://127.0.0.1:11434",
  model: "qwen3-embedding:4b"
}
```

Embedding dimensions are inferred from the provider; changing model requires
embedding backfill, not a graph rebuild. Hybrid search falls back to lexical
results if the local provider fails. Explicit semantic search reports bounded
unavailability instead. ReasoningMemory semantic retrieval additionally needs
`cognition.reasoningRuntime.semantic.enabled: true`; the graph embedding flag
alone does not enable it.

### Bounded conversation capture and extraction

`conversationJournal.enabled` preserves bounded ContextEngine events.
`episodicMemory.enabled` permits episode capture; set
`episodicMemory.autoExtract: true` only when automatic episode formation is
wanted. It is independent of graph relationship extraction.

`extraction.enabled` and `extraction.autoExtract` enable bounded,
OpenAI-compatible graph extraction and require usable configured credentials
or their documented environment fallback. Model-backed work has input/output
bounds, timeouts, and cancellation, but still has cost and data-flow impact.
Do not enable it just to diagnose recall quality.

### Canonical corpus and artifacts

The canonical corpus is a separate, local read model; it is not graph evidence
and is never automatic prompt context.

```json5
corpus: {
  enabled: true,
  workspaceRoot: "/explicit/local/workspace"
},
workspaceBoundary: { userMdExclusive: { enabled: true } }
```

`workspaceRoot` is configuration only and is not persisted or returned in
corpus results. The default limits are 1 MiB per file, 500 files, 4,000
characters and 80 lines per chunk. Session and dreaming directories remain off
until individually enabled. `USER.md` stays externally managed when the
boundary is enabled.

Artifact preservation is another opt-in:

```json5
artifacts: {
  enabled: true,
  inlineThresholdChars: 12000,
  maxArtifactBytes: 262144,
  toolPayloads: { enabled: true }
}
```

Only bounded public string tool output is retained. It can be replaced by an
opaque, same-scope reference; `kg_memory artifact_read` remains exact-ID and
bounded.

### Governed cognition and reasoning

All cognition toggles are conservative. `formationShadow` defaults to true but
is audit-only. `admission.mode: "enforce"` records deterministic outcomes; it
does not create beliefs, facts, profiles, or prompt additions.

`cognition.reasoningCuration` can create source-linked decision/outcome and
strategy *candidates* after durable turns using the public host runtime model.
Enable its `intake`, `formation`, or periodic `review` subfeatures separately.
Every durable decision, outcome, strategy admission, retain, or retirement
remains human-controlled. It is not a replacement for a static instruction
file, and it must never be presented as a source of user facts.

`cognition.reasoningRuntime.shadowMode` collects aggregate retrieval telemetry
only. Delivery requires separately configured exact scopes, a fresh calibration
and explicit canary activation. Do not enable delivery to bypass readiness.

### Other opt-in services

- `contextEngine.compaction.enabled` enables bounded source-linked model
  compaction; leave it off unless the user explicitly wants model compaction.
- `trustLayer.enabled` enables local source anchoring. Strict automatic
  verification is a separate `trustLayer.verification.enabled` opt-in.
- `quality.hygiene.enabled` schedules bounded review-only graph hygiene;
  scans never merge or delete data automatically.
- `toolSurface` is `full` for compatibility. Use `core` for everyday work or
  `research` for analysis when reducing tool-schema context matters. Changing
  it hides tools from the agent; it does not delete data or disable runtime
  services.

## Compatibility and change rules

- `mode: "companion"` is only a deprecated accepted alias. The runtime is
  standalone and never revives legacy `before_prompt_build` or `agent_end`
  hooks.
- `recall.autoRecall` and `recall.injection` are deprecated compatibility
  keys. Do not recommend them for new configurations. Automatic attachment
  goes through the selected public ContextEngine and `unifiedRetrieval`.
- Scopes isolate data and policy. Do not change `scope.default` merely to make
  a search return more results; diagnose the missing scope first.
- Keep `excludedAgentIds` populated when background or sub-agents must not
  generate automatic memory work for a main conversation.
- Never put API keys in a committed config example, a Skill response, or an
  issue. Preserve an existing secret reference without echoing it.

## Validate a proposed configuration

After an authorized config edit, validate the plugin and inspect the narrow
runtime signal relevant to the change. Typical checks are:

```bash
openclaw plugins validate --entry ./dist/plugin.js --root .
mnemora standalone status
mnemora journal status
mnemora recall metrics --scope default
```

Use the installed plugin's normal validation command when working outside the
repository. A successful schema validation proves accepted shape, not that the
host selected Mnemora, that data exists, or that a provider is reachable.
