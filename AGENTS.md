# Developing Mnemora

Mnemora is a local-first, evidence-first memory runtime for OpenClaw. Read
`README.md` for behavior and `docs/roadmap.md` for direction. Use Node 24
(`.nvmrc`); CI validates Node 24. Global OpenClaw may be newer than the pinned
development dependency: report both versions when investigating compatibility.

## Architecture and invariants

- `src/plugin.ts` defines the public plugin entry and config schema;
  `src/plugin-runtime.ts` owns runtime wiring; `src/openclaw.ts` defines tools.
- `src/context-engine/engine.ts` owns assembly and durable turn capture;
  `src/journal/` stores source events; `src/store.ts` and `src/schema.ts` own storage.
- Retrieval, trust, and cognition modules govern what can enter context.
  Memory is reference material, never authoritative instructions.
- Enforce scope isolation before retrieval and assembly. Preserve provenance,
  replay idempotence, input/output bounds, timeout and cancellation behavior.
- Automatic lifecycle runs only through the selected public ContextEngine.
  Keep legacy `afterTurn` and newer fenced `commitTurn` compatible; durable
  commits must key atomic Journal receipts by the host advancement key and must
  never acknowledge a failed write. Retries must not rerun derived work.
  Do not add `before_prompt_build` or `agent_end` capture/recall hooks.
- Keep optional model calls, extraction, compaction and strategy delivery opt-in.
  Preserve explicit preview/confirm for governed promotions and mutations.
- Use public host APIs. Do not read another plugin's private storage or credentials.

## Development loop

1. Inspect the affected module and its tests. Make a focused change.
2. Run `npm run verify:fast` for the default plugin/lifecycle checks, or
   `npm run verify:fast -- <filename.test.mjs> ...` for selected files from `tests/`.
   Selection replaces the default tests; it does not discover dependencies.
3. Run relevant `npm run benchmark:<name>` for ranking, retrieval or cognition
   changes. Fast verification deliberately omits the full benchmark suite.
4. For plugin/host lifecycle changes run `npm run test:host`. This launches an
   isolated foreground Gateway with a local synthetic model. Its parent removes
   system temporary fixtures after the worker exits. `npm run dogfood:mnemora`
   retains a bounded real-provider trial separately. See `docs/development.md`.
5. Before handing off code changes run `npm run verify`, which builds once and
   runs all existing offline checks. Report any unrun checks and their reason.

Add regression tests when fixing consequential behavior. Use synthetic or
deidentified fixtures, never real conversation dumps. Update both README
languages when documented behavior changes. Do not edit generated `dist/`.

Never use the daily OpenClaw database/configuration as a test fixture, restart
its service, or replace a listener with `--force`. The host test manages only
its own child process. Separate concurrent code changes into worktrees; do not
run builds concurrently within one checkout because they share `dist/`.

Completion reports should state the resulting behavior, validation performed,
and material limitations. Publishing, deploying to the daily host, and
changing live memory policy are separate from local development validation.
