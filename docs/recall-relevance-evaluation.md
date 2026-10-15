# Independent recall relevance evaluation

The `recall-relevance-shadow-v1` policy only recommends removing already selected
candidates. Runtime prompts and live configuration remain unchanged. The fixed
probability cutoff is 0.1; uncertain and truncated candidates stay selected.

Before collecting held-out results, save a version-1 plan with `evidence`,
`policy`, disjoint `tuningCaseIds` / `testCaseIds`, and `limits` containing
`minTestCases` (at least 2), `maxHarmfulDeletionRate`, `maxRecallLoss`,
`maxTaskCompletionLoss`, and `minNetSaving`. Freeze this file in version control
before evaluation. The report includes a canonical plan digest for comparison;
it does not prove when a plan was frozen or authenticate an independent reviewer.
The minimum of two is structural validation, not a statistically justified sample
size: preregister an appropriate sample size for the intended deployment.

Independent reviewers label relevant references without seeing the adjudicator's
recommendations. Include relevant references missed by baseline retrieval.
Deduplicate tasks before assigning tuning and test IDs, including paraphrases and
shared conversations: ID disjointness alone cannot establish independence.
Never tune thresholds or relabel gold from held-out model outputs.

Each `cases` entry has `id`, `relevant`, `original`, `suggested` reference arrays;
`task: {originalCompleted, suggestedCompleted}` or null; and
`cost: {original, suggested, adjudication, retry, remediation}` or null.
Costs use one declared monetary unit across all cases. Original/suggested are
paired total task costs excluding the separately listed adjudication, retry and
remediation costs. Measure task completion independently on paired executions;
relevance labels cannot substitute for task outcomes. Missing measurements must
be null, never assumed zero. Suggested references must be a subset of original.

Run `npm run evaluate:recall-relevance -- <input.json>` after building, where the
input contains `{plan, cases}`. This offline command opens no memory database and
makes no API requests. Reports contain aggregate counts and the plan digest;
reference IDs and source text are omitted. Harmful deletion is deleted relevant
candidates / baseline relevant candidates; removal error is deleted relevant /
all deleted candidates. Report baseline and suggested misses separately.
Net saving subtracts adjudication, retries and remediation. Agreement is not an
acceptance metric. Synthetic labels, missing outcomes/costs, insufficient coverage
or breached limits withhold review. Eligibility never authorizes deployment.

For a bounded transport trial use `npm run trial:recall-relevance -- <trial.json>`
with `{evidence:"synthetic", query, candidates:[{title,excerpt}]}` and environment
variables `MNEMORA_RELEVANCE_ENDPOINT`, `MNEMORA_RELEVANCE_MODEL`, optionally
`MNEMORA_RELEVANCE_API_KEY`. Endpoint/model configuration uses the same single API
contract for local and remote services. One batch, up to eight short candidates,
three-second default deadline (configurable with `MNEMORA_RELEVANCE_TIMEOUT_MS`,
100–10000 ms), no retries. It opens no database, reads no host config,
and emits only content-free shadow observations. A failed trial exits 2 and
preserves baseline advice. This tests protocol compatibility only; it provides
no independent quality, savings or deployment evidence. Never put production
conversation dumps in trial or evaluation files.

Packaged examples are `fixtures/recall-relevance/trial-synthetic.json` and
`fixtures/recall-relevance/evaluation-synthetic.json`. Their labels and suggested
selections are illustrative fixtures, not independently reviewed service outputs.
The evaluation example intentionally withholds review with unknown task and cost
measurements. Replace these only with separately collected, reviewed evidence;
do not relabel a synthetic fixture as independent.
