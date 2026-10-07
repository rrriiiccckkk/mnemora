# Mnemora

[简体中文](README.zh-CN.md)

> Local-first, evidence-first memory for persistent OpenClaw agents.

Mnemora helps an agent pick up work across conversations, find the sources
behind remembered information, and respond to corrections or forgetting.
Memory lives in local SQLite; retrieved text remains reference material,
not an instruction or automatically verified fact.

## What you can do

- **Continue a task:** inspect completed work, failed attempts, blockers and
  next steps, with source links and explicit uncertainty.
- **Check what the agent remembers:** use the local Inspector to review
  evidence, pending candidates, stale records and conflicts.
- **Change memory deliberately:** use scoped correction and forgetting
  workflows, with preview/confirm for consequential changes.
- **Keep recall bounded:** combine lexical and semantic retrieval with scope,
  freshness, safety checks and token budgets.

Mnemora is an independent implementation informed by the public ideas behind
`lossless-claw` and `memory-lancedb-pro`. It does not read other plugins' private storage.

## Quick start

Requires OpenClaw `2026.9.2+` and Node.js `24.15.0+` on Node 24 (`>=24.15.0 <25`).
Node 24.14 is unsupported; upgrade and restart the host rather than bypassing its check.
Development and CI use Node 24.19.0. See the
[usage guide](docs/usage-guide.md) for compatibility details.

### Build

```bash
git clone https://github.com/rrriiiccckkk/mnemora.git
cd mnemora
npm ci
npm run build
```

Install the built plugin through your OpenClaw plugin workflow, then merge
this into the host configuration:

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

Restart the OpenClaw process that loads the plugin. Automatic capture and
context assembly require the host to select Mnemora's ContextEngine slot;
enabling the plugin alone is not enough.
Mnemora uses a single ContextEngine lifecycle and
registers no `before_prompt_build` or `agent_end` hook.

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
node dist/cli.js inspect
node dist/cli.js resume "deployment task" --scope project-a
```

The CLI defaults to `~/.openclaw/mnemora.db`. Set `MNEMORA_DB` explicitly
when your deployment uses another path. OpenClaw's extension installation
does not necessarily create a global `mnemora` command; direct invocation
above does not need one.

Task resume is read-only: it does not execute a plan or confirm a candidate.
Ambiguous tasks remain separate until selected. In v1.32, selected tasks
can include bounded readable `source_evidence` excerpts, without promoting
them to accepted task state.
See [source evidence and reruns](docs/task-resume-source-evidence.zh-CN.md).

## Safety and limits

- **Sources are not confirmations.** A user request is not proof of completion;
  an assistant's report is not independent verification.
- **Scope and lifecycle matter.** Invalid or forgotten sources must not
  revive accepted work; uncertain evidence stays visibly uncertain.
- **Local-first is not offline-only.** Configured model, embedding or provider
  integrations may make external calls.
- **ReasoningMemory delivery is experimental and off by default.** It requires
  explicit governance; reference content must not become prompt instructions.
- **Tests are not efficacy evidence.** v1.32 does not establish improved
  continuation accuracy over simple retrieval. The real comparison and
  v1.33 pilot gate remain pending.

For attack surfaces and safeguards, read the [threat model](docs/threat-model.md).

## Documentation

Start with the [usage guide](docs/usage-guide.md) for complete configuration,
first-use checks, correction workflows and operating commands.

- **Task continuation:** [evaluation](docs/task-resume-evaluation.md),
  [source evidence](docs/task-resume-source-evidence.zh-CN.md),
  [Mac experiment handoff](docs/task-resume-mac-openclaw-handoff.zh-CN.md),
  [one-command regression](docs/task-resume-regression.zh-CN.md) and
  [formal three-arm runner](docs/task-resume-experiment-runner.zh-CN.md).
- **Recall and evidence:** [threshold evaluation](docs/recall-threshold-evaluation.md),
  [attachment receipts](docs/recall-attachment-evidence.zh-CN.md),
  [usefulness boundaries](docs/recall-usefulness-review.zh-CN.md).
- **ReasoningMemory:** [curation](docs/reasoning-curation.md),
  [verification](docs/reasoning-verification.md).
- **Planning:** [roadmap](docs/roadmap.md),
  [preregistration](docs/task-resume-preregistration.zh-CN.md),
  [v1.32 release notes](docs/releases/v1.32.0.md).

Some detailed guides are currently available in Chinese only.

## Development

Read the [maintenance lessons](docs/maintenance-lessons.zh-CN.md) before
adding fixtures, changing storage/configuration or upgrading a deployment.

```bash
npm run check
npm run verify:fast
npm run test:host
npm run dogfood:mnemora
npm run verify
```

The full suite includes serial unit tests, build, browser checks, benchmarks,
plugin validation, smoke tests and the SDK compatibility expectation gate.
Persistent project memory adviser: `npm run dev:memory -- status` or
`npm run dev:memory -- ask --message "Continue my task"`. See the
[development guide](docs/development.md#persistent-project-memory-adviser).

Release tags require successful Windows and Linux CI for the exact commit.

See [local development](docs/development.md) for the isolated host and project
trial. Full verification builds once; fast verification accepts selected test
filenames. The project trial uses a separate `project:mnemora` database and
the daily Gateway's public stateless model interface.

## License

[MIT](LICENSE)

Journal recall matches ASCII technical identifiers across case differences.
An exact task identifier prevents a detailed conversation record from being
penalized solely for length; confidence, provenance, scope and token limits still apply.
