# Task-resume evaluation

For Mac-side data collection and model runs, use the [Chinese OpenClaw execution handoff](task-resume-mac-openclaw-handoff.zh-CN.md). For the subsequent annotator-facing handoff, use the [Chinese labeling guide](task-resume-labeling-handoff.zh-CN.md).

`npm run benchmark:task-resume` runs the 26 independent, synthetic
multi-session sequences in `fixtures/task-resume-evaluation-v2.json`. Each
case declares only bounded identifiers for its history and restart point, its
current projection, allowed source-reference prefixes, forbidden text, and
whether uncertainty is expected. The runner checks the projection status,
progress, source-reference provenance, and content constraints; it never
enables recall, writes memory, or invokes a model.

For a real-effect comparison, begin with
`fixtures/task-resume-comparison-plan-v1.json` and run:

```powershell
mnemora evaluate task-resume-comparison fixtures/task-resume-comparison-plan-v1.json
```

The plan fixes the model identifier, history set, held-out task set, token and
latency budgets, three arms (`no_long_term_memory`, `simple_retrieval`, and
`mnemora`), and disjoint tuning/test identifiers. A `planned` input returns
`real_effect_experiment_not_run`; it does not call a model or claim any
effect. A measured input may report held-out continuation correctness, stale
fact misuse, repeated steps, tokens, latency, and manual-review time only when
that time was actually provided. Synthetic data and this contract are not
efficacy evidence.

Each measured case in every arm must stay within the plan's total model-token
and end-to-end latency budgets. Out-of-budget records invalidate the comparison
instead of being silently included in the aggregate.

To measure irrelevant memory injection, a reviewer sets
`irrelevantMemoryInjected` to `true` when the arm attached at least one memory
item unrelated to the current task or next action, and to `false` otherwise.
Provide this boolean for every tuning and test result across all three arms;
the `no_long_term_memory` arm must be `false`. The report computes
`irrelevant_injection` only from held-out test cases. Older measured inputs
without these labels remain valid, but the report omits that metric and says
it was not measured. Partial labelling is invalid. The label is supplied by a
reviewer; this command does not inspect prompts or verify the label.
