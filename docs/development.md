# Local development

Use Node 24, matching CI. `.nvmrc` supports `nvm install && nvm use`.
Then run `npm ci`. Each worktree needs its own dependencies and build output.

## Verification

```bash
# Default plugin, ContextEngine and compatibility-gate tests, plus smoke/schema checks
npm run verify:fast

# Replace the default selection with exact filenames from tests/
npm run verify:fast -- context-engine.test.mjs plugin.test.mjs

# Complete offline suite: all unit tests, benchmarks, plugin and release checks
npm run verify

# Installed OpenClaw host integration, separately from pinned offline checks
npm run test:host

# Real provider, two sessions and one actual development decision in project:mnemora
npm run dogfood:mnemora
```

Both verification modes build TypeScript and the Inspector once. The complete
mode retains all checks from the original `verify` command. Individual existing
benchmark commands remain available and build their own prerequisites.
Fast mode is feedback during development, not a substitute for full verification.

## Isolated host integration

`test:host` uses the `openclaw` executable on PATH. To select an executable
explicitly, set `MNEMORA_OPENCLAW_BIN` to its path. The reported host version is
independent of the repository's pinned OpenClaw development dependency.

Each synthetic test creates a system temporary fixture with a private state directory, config,
workspace, synthetic home, immutable plugin build snapshot and Mnemora database.
The snapshot keeps changing test artifacts out of host source-consistency checks.
It starts a foreground Gateway
on an available loopback port, with token authentication and a loopback mock
OpenAI-compatible model. Provider and channel credentials are not inherited;
shell-environment loading is disabled. No real model account is required.
It never installs, stops or restarts the daily Gateway service.

The test checks actual plugin loading and the selected ContextEngine through:

1. A synthetic agent turn reaching the local mock model.
2. Durable capture of user and assistant journal events through `afterTurn`
   on older hosts or atomic `commitTurn` on hosts with admitted-turn finalization.
3. Shutdown and restart preserving event IDs without replay duplication.
4. A fresh session receiving the stored canary evidence in its model request.

The test kills only its own Gateway process on exit. Its parent removes the
fixture after the worker exits, including native database handles. Port selection is
best effort: if another process claims the port, the test fails rather than
replacing it. Loopback listeners must be allowed by the execution sandbox.

This deterministic integration test covers host wiring and persisted recall,
not model quality, real provider authentication, channels, or statistical
effectiveness of ReasoningMemory. Use the existing benchmarks and governed
deidentified datasets for those separate evaluations. The older
`plugin:official:compat` check intentionally asserts the pinned 2026.9.2 CLI's
known metadata rejection; passing it does not establish newer-host compatibility.
Both host checks isolate configuration from the daily OpenClaw installation.
The ContextEngine declares fenced, atomic advancement for newer hosts. Journal
transactions key receipts by the host advancement key; retries after restart
return `duplicate`, and failed transactions are not acknowledged.

## Project dogfood

`dogfood:mnemora` launches the same isolated host with scope `project:mnemora`
and a separate database. It records the actual `OFG_CONFIG_ISOLATION` development
decision, restarts its Gateway, and asks about that decision in a fresh session.
The loopback model bridge calls public `openclaw gateway call agent` with
`modelRun: true`, `promptMode: "none"` and a fresh explicit session. This uses the already
configured model account and can incur its normal inference cost. No provider
credentials, daily conversations or daily memory database are copied.

Unified retrieval stays enabled, with redacted shadow telemetry. Shadow is
observability after normal recall, not a no-attachment mode. ReasoningMemory
shadow is restricted to the project scope; delivery, extraction, automatic
episode formation and model compaction stay disabled in this canary.

The script retains bounded `dogfood-result.json`, `dogfood-debug.json` and Gateway
logs under the printed `.dogfood/<run-id>` directory. Its parent removes the
separate database and configuration after the worker exits. Debug artifacts
contain only this development task's requests and answers and remain private,
ignored local files. It stops its own Gateway after both turns. Run the command
again for another bounded trial; it does not install a persistent service.

Two turns establish wiring, persistence and a recalled decision. They do not
establish improved development speed or ReasoningMemory efficacy. Proxy usage
counts are fixture values and are never used for provider token measurements.
The bridge separately collects public Gateway provider usage when valid; call
timing and token counts do not measure development task efficiency.

OpenClaw documents the configuration and state overrides in its
[environment reference](https://docs.openclaw.ai/help/environment).

## Reproducible bug reports

Record the commit, Node and host versions, relevant option values, synthetic
input, expected result and actual result. Convert recurring recall or capture
failures into bounded fixtures under `tests/`, with explicit scope and source
evidence. Keep confirmed architecture decisions in repository documentation.

## Persistent project memory adviser

```bash
npm run dev:memory -- status
npm run dev:memory -- ask --message "继续 PROJECT_ENTRY，请回忆已验证的决定和未完成项"
npm run dev:memory -- ask --file path/to/verified-task-note.md
```

This local development command keeps its database, workspace and agent state
under the ignored `.dogfood/project-mnemora` directory. It starts its own loopback
Gateway for each request and stops it afterward. Every invocation uses a fresh
session, so prior decisions must be retrieved from durable project memory.
Unlike `dogfood:mnemora`, the database survives later invocations. The installed
Mnemora package is snapshotted by version; `MNEMORA_PROJECT_PLUGIN` overrides its
path. The command needs built repository output and the installed host on PATH.

It uses `project:mnemora`, normal bounded unified recall with shadow telemetry,
and reasoning shadow with delivery disabled. Extraction, automatic episode
formation and compaction remain disabled. The daily host's configuration and
database are not changed. An exclusive lock prevents concurrent runs; after an
unclean termination, inspect its PID before manually removing the stale lock.

The daily host's public stateless model interface accepts text only. This is a
memory adviser, not a second agent that can edit code or execute tools. Codex
performs the work; consult the adviser at task start and submit a concise note
of actual decisions, validation and open items at task completion. Recalled
answers are reference material and must be checked against current code. Each
ask incurs the normal model charge. Usage values in the compatible proxy are
synthetic. Provider usage is collected separately from the public Gateway;
missing values remain unknown and cannot establish token savings. Keep secrets and
unrelated personal conversations out of project notes. `status` uses no model.

Evaluate 3–5 genuine development tasks before changing memory policy. Record
whether decisions were recalled correctly, how many facts needed restating,
incorrect or irrelevant recall, and the operations actually avoided. Do not
claim measured speed improvement from a successful two-turn recall check.

### Task identifier recall regression

`node scripts/test-openclaw-host.mjs --task-recall` exercises a bounded synthetic
case where short generic history competes with a detailed task completion. Add
`--dogfood` to use the daily Gateway's real stateless model. The fixture keeps a
1500-token budget, tests uppercase/lowercase task identifiers in fresh sessions,
and rejects foreign-scope evidence. It uses parent-owned temporary state rather
than the persistent operational project database.

## Project call measurements

Successful project answers include a `measurement` object. The private
`.dogfood/project-mnemora/measurements.jsonl` records each request that reaches
the host execution block, including failures, after normal cleanup. A unique
run ID links the answer and final measurement. `elapsedMs` uses a monotonic
clock and includes setup, inference, durable capture and Gateway shutdown; each
`inference` entry measures a public CLI call separately, including failed calls.
`inputChars` is the forwarded prompt's character count, not a token estimate.
No prompt, answer or credentials are retained in this measurement log.

The v2 measurement collects provider `agentMeta.usage` from the public Gateway
stateless response, including input, output, cache-read and cache-write tokens.
Each total must equal the sum of those components; cache tokens are counted
once. Only those five integer fields are retained, excluding pricing and raw
responses. The normalized `infer` CLI used by earlier measurements omitted
usage; earlier null values cannot be backfilled. The proxy's fixture counts
must never be substituted, and a host's configured zero cost does not prove
free inference. Dollar cost is not calculated.

An overall `tokenUsage` is present only when every measured call has valid
provider usage and aggregation does not overflow. Failed calls with reported
usage remain included, including positive input/cache usage with zero output
tokens. The bridge reads complete bounded JSON counters before checking the
CLI exit code, but a nonzero exit or an empty answer still fails the call.
Truncated/overflowing output and all-zero placeholder counters remain unknown.
When any call's usage is missing, its value and the
aggregate are null while other known per-call values remain visible. No call
or an unknown result is never charged as zero. Missing/invalid usage does not
invalidate an otherwise valid answer, but prevents a complete usage claim.
Invalid input, early setup failure, signals and forced termination may happen
before final logging; absence of a row does not mean a successful zero-cost call.
`status` does not call a model or add measurement rows.

These are adviser-call measurements, not total Codex task time. For genuine
development tasks, separately record the task, a source-verified recall verdict,
actual edits/checks, failures and operations demonstrably avoided. Historical
measurements cannot be backfilled and repeated recall questions do not count as
independent development tasks. This exploratory local trial is separate from
the formally preregistered task-resume efficacy experiment.

## Adviser request reliability and prompt overhead

The bridge pins the command's original question for the whole agent turn,
including host empty-response retries. It forwards only `MNEMORA_MEMORY` packets
from the isolated host's system attachment, preserving evidence text and deduplicating, together
with that question. Tool catalogues, workspace bootstrap templates, runtime
directives, host retry prompts and prior assistant replies are excluded. User
messages cannot manufacture an attachment. Unknown attachment formats are not
interpreted as evidence. Missing evidence remains missing.

Each public inference request requires a JSON reply with the matching random
request ID and a bounded answer, without extra fields. Unstructured replies and
wrong IDs fail the request rather than being accepted as successful answers.
`responseValidation=request_bound` records this contract check separately from
transport status; it is not a correctness or hallucination score. A correctly
formatted answer can still be wrong and requires source verification.

The forwarded prompt is bounded to 30000 characters and the original question
to 12000. Existing host retrieval scope and 1500-token attachment budget stay
unchanged. This repository bridge does not alter the daily Gateway prompt.
The first actual compact call forwarded 4614 characters versus the earlier
48794-character observation (different questions, not a matched experiment).
Total time was 27032 ms and public CLI inference 15137 ms: reduced input size
does not establish latency, token or cost savings.

The observed unrelated reply quoted wording matching the installed host's
empty-response continuation instruction. Source inspection and a synthetic
retry fixture reproduce how answering the last user message loses the command
question. The original per-attempt project requests were not retained, so this
is evidence of the mechanism rather than a complete causal trace of that call.

### Chronology and compact evidence

Journal packets include `recorded_at`, the source event capture time, within
the existing retrieval and packing budget. It is not verification time or a
completion signal. The project adviser compacts fully recognized Journal
records into JSON, retaining source text, authority, confidence, capture time
and every distinct provenance reference, while eliminating repeated canonical
references. Unknown layouts, graph supplements and derived evidence windows
remain verbatim; records and contradictory claims are never silently dropped.
Private measurements include original and forwarded memory character sizes.

The adviser distinguishes older pending reports from later explicit results
for the same task and same check. A newer timestamp, unrelated test, question
or assistant assertion alone cannot establish completion. Missing/equal times
and unresolved conflicts remain unknown; tests cannot imply release or daily
host deployment. This instruction helps interpretation but does not guarantee
model factual correctness or establish efficacy. The bridge checks that the
public Gateway used exactly the forwarded prompt, no system prompt, no tools,
no fallback and a normal stop before accepting the request-bound JSON answer.
An incompatible host fails visibly instead of silently using daily context.

`node scripts/test-project-adviser-state.mjs --dogfood` makes four charged
public Gateway calls using synthetic Journal records. It checks a later explicit
result, a newer unrelated check, an unverified assistant assertion, and equal-time
conflicts. An assistant conflict may conservatively remain pending or unknown;
it must not establish that the check passed.
Every conflicting record must be packed; failures stop the run without retries.
It retains bounded private results under the printed `.dogfood/adviser-state-*`
directory. This regression does not measure general efficacy or use real notes.
