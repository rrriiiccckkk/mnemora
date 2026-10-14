# Recall relevance shadow (P0)

The task is `recall_relevance` (召回相关性), separate from long-term memory admission. Its only objective is reducing irrelevant recall. P0 never applies advice, adds a candidate, changes source authority, rewrites text, changes actual prompts, or gates active-memory escalation.

## Configuration

Inside the Mnemora plugin configuration:

```json
{
  "unifiedRetrieval": {
    "enabled": true,
    "relevanceShadow": {
      "enabled": true,
      "endpoint": "http://127.0.0.1:8080/v1/systemone",
      "model": "your-decision-model",
      "apiKey": "",
      "timeoutMs": 1500,
      "maxCandidates": 8,
      "maxQueryChars": 512,
      "maxDocumentChars": 2000
    }
  }
}
```

The endpoint/model/apiKey/timeoutMs keys mirror `memory.retrieval.reranker`, but this is an independent disabled-by-default configuration and task protocol. It does not enable or alter that reranker, the ingestion semantic classifier, or a live host. Use any service implementing the documented systemone-compatible protocol. Arbitrary reranker or chat-completions endpoints need a compatible bridge; shared configuration keys do not imply identical wire bodies. HTTPS is required except loopback HTTP; URL credentials, queries, fragments and redirects are rejected. An API key is only sent as a Bearer header.

## Selection boundary and request

The ContextEngine uses its normal scope/validity/trust checks, `filterAutomaticCandidates`, and deterministic local injection selection first. The advisory call runs on those structured local candidates before final prompt packing. It is skipped entirely for stateless/read-only or excluded sessions and disabled retrieval. It does not inspect another scope or resurrect already rejected candidates. The graph supplement is unchanged and outside the evaluated local-candidate set.

One request batches up to maxCandidates questions. Body fields are `model`, `state: {task: "recall_relevance", query, candidates: [{id: "c0", kind, truncated, text}]}` and `questions: {c0: {type: "noul", instructions: "..."}}`. Response `answers.c0` must be `{type: "noul", noul: <probability of relevance from 0 to 1>}` for every requested ID. The full ID set must match; partial, extra or malformed answers restore baseline for the entire request. Reported `usage: {input_tokens, output_tokens}` is optional and validated independently.

P0 policy `recall-relevance-shadow-v1` treats relevance <=0.1 as a removal suggestion; >=0.9 is relevant and the middle is uncertain/kept. These are fixed experimental policy values, not calibrated thresholds or permission for enforcement. Truncated candidate text cannot produce removal advice. Candidates beyond the limit stay unchanged. Query overflow skips the request rather than silently cutting the question. Known sensitive credential/passport/payment patterns block the optional request before transmission; this is not a universal detector. Text is untrusted data and never instruction authority.

One deadline bounds fetching and response streaming; maximum response is 32768 bytes, candidate text at most 4000 characters each, query at most 4096, candidate count at most 20. There are no automatic retries. Failure, timeout, uncertainty, malformed responses, or missing configuration preserve baseline selection. Runtime shutdown and an assembly signal when supplied propagate cancellation. The pinned OpenClaw 2026.9.2 assembly SDK does not promise a per-run signal, so per-run cancellation on hosts that do not expose one cannot be claimed; the deadline and runtime shutdown remain enforced.

## Observation

The existing `kg_recall_metrics` unified section exposes an optional `relevance` field. Enabling this feature records its observation even when the older aggregate `shadowMode` is off. Schema v85 adds a nullable `relevance_json` column to the existing bounded table; old rows remain valid and scope-local reads and the existing 10000-run cap remain in place.

After original packing, the observation is restricted to the actually packed local baseline. The suggested pack uses the same packer and budget, only the original packed candidates minus removal advice, and only a graph supplement already attached by baseline. It cannot backfill lower-ranked candidates or newly attach graph context. Actual prompt and messages remain exactly baseline. The diff stores only SHA-256 candidate-reference hashes, keep/remove and closed reasons (including `packing` if final packing removes an otherwise-kept candidate); it contains no excerpt, title, query text, raw reference, model response or credentials. A query hash and existing scope key remain as before. A shadow pack failure records `comparison_error`, preserves baseline and retains any known verdict usage. Optional telemetry failure does not alter context.

Observation fields: task, policy, status, elapsed_ms, usage, original hashes, suggested hashes, diff, applied=false. Missing/invalid/all-zero usage is null (unknown), not a fabricated zero; a positive input count with zero output stays known, including a malformed answer with valid usage. The standalone API `graph.adviseRecallRelevance(scope, query, admittedCandidates, signal)` returns advisory removal refs but never writes them as memory or applies them. Callers must supply already-admitted candidates.

## Independent evaluation gate

P0 contract tests use synthetic responses and establish behavior/privacy/fallback, not model quality or cost savings. No live classification provider is called during release verification.

Before any filtering release, freeze the independent gold dataset, split, labels, denominators, service/model/prompt/policy, candidate budgets and numerical pass thresholds before running held-out cases. Gold labels must distinguish necessary, unnecessary and uncertain evidence, and whether necessary evidence was absent from original retrieval. Report separately: deletion of necessary baseline evidence / all necessary baseline evidence; retrieval misses / all required evidence; and task completion per arm under identical task budgets. Include Chinese queries, negation, corrections, cross-task ambiguity, expired evidence, and sensitivity cases. Agreement across repeat calls is sanity only, not accuracy. Dataset identity, label review and numerical quality thresholds are not yet frozen here, so the enforcement gate is closed.

Compare baseline and advisory-subset prompt payloads by hashes and candidate identities; never use real transcript excerpts as test fixtures or persist production payload diffs. Include all verdict calls, evaluation repeats/retries, latency, known/unknown usage and downstream recovery calls in costs. A net-saving claim requires measured downstream savings minus verdict/retry/recovery costs with stated prices and uncertainty; missing usage prevents a complete cost conclusion. No 20%-hit-rate saving rule is used. Escalation cancellation requires a separate independent evaluation. Future filtering must be explicit and reversible; P0 exposes no enforcement switch.
