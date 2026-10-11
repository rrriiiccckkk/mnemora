# Semantic memory classification API

The same `POST /v1/systemone`-compatible contract works with any configured service. There is no local/cloud provider branch. Change only `endpoint`, `model`, and `apiKeyEnv`. An arbitrary chat-completions endpoint needs a systemone-compatible bridge; this API does not silently convert protocols.

Plugin configuration under `plugins.entries.mnemora.config`:

```json
{
  "cognition": {
    "admission": {
      "semanticClassifier": {
        "mode": "shadow",
        "endpoint": "http://127.0.0.1:8765/v1/systemone",
        "model": "your-decision-model",
        "apiKeyEnv": "",
        "timeoutMs": 1500,
        "minProbability": 0.9,
        "minConfidence": 0.8
      }
    }
  }
}
```

For another service, use its complete evaluation endpoint, its model name and the name of an environment variable holding its Bearer key. For example, the TypeSafe documented endpoint is `https://api.typesafe.ai/v1/systemone`; set `model` to `jev-latest` and `apiKeyEnv` to your chosen variable name. Never put the key itself in `apiKeyEnv`. Non-loopback HTTP, URL credentials, query strings and redirects are refused. HTTPS is supported for remote services; HTTP is supported on localhost, 127.0.0.1 and ::1.

## Public application API

```ts
const report = await graph.classifyMemoryCandidate({
  scope: "project:travel",
  candidate: "The user usually prefers an aisle seat.",
  evidence: [{ role: "user", text: "I usually prefer an aisle seat." }],
  context: { task: "Book one flight", session: "Current booking session" },
  sensitive: false,
  signal: abortController.signal
});
```

Alternatively instantiate `SemanticMemoryClassifier(config, optionalFetch)` directly. Both return the same allowlisted report: status, scope, recommendation, labels/probability distribution, service-reported model, elapsed milliseconds, service-reported input/output tokens or null, and `applied: false`. No raw response, candidate/evidence, endpoint or key is returned. Noul probabilities answer explicit user statement, applicability beyond the task and reuse risk. A Choice selects account/task/session/reject/unknown. Multiple questions share one state in one request.

Recommendations are `persistent_candidate`, `task_only`, `session_only`, `reject`, or `defer`. They never grant source authority or permission to store a belief. A high model score is not proof of explicit user confirmation. The configured thresholds are starting settings, not calibrated accuracy guarantees. Mixed or ambiguous claims should defer; split candidates explicitly when evaluating several distinct facts.

## Operator command

`mnemora cognition classify candidate.json --config classifier.json` evaluates one input with the standalone classifier config shown inside `semanticClassifier` above. It does not open or create a memory database. Input files are bounded at 64 KiB, and the serialized allowlisted state is bounded separately (default 8,000 characters). The command emits the same structured report and makes at most one evaluation request, with no automatic retry.

## Shadow integration and boundaries

When explicitly enabled, canonical ingestion evaluates one source text as a candidate and adds `semanticShadow` to its successful ingestion result. Automatic user-source text is labelled user evidence; operator or external input is not upgraded to user evidence. This is source-level shadow observation, not per-fact extraction or a historical session lookup. Richer candidate and task/user/session context can be supplied through the public application API. The original extraction, confidence, formation policy, graph persistence and beliefs are unchanged. A duplicate already completed ingestion makes no extra classifier request. Reports are returned to the caller; this version does not persist a new classifier audit table or claim a collected quality dataset.

`mode` defaults to `off`; only `off` and `shadow` are accepted. There is no enforcement mode in this release. Turning on shadow opts into model calls to the configured endpoint. The user remains responsible for the service configuration; no service was enabled on the daily host during development.

A `sensitive: true` candidate is blocked locally. Recognized credential forms, labelled passport/payment fields and card-like numeric sequences are also blocked before any classifier request, including evidence and allowlisted context. These deterministic patterns are not universal sensitive-data detection. For known sensitive inputs the application must set the flag. This filter governs this optional classifier request, not the separate existing extraction or canonical Journal retention policy.

Timeout, cancellation, HTTP errors, transport failures, malformed answers, missing options and inconsistent probabilities produce a bounded defer report. A failure cannot change the original ingestion decision. Known positive usage survives an invalid typed answer; missing or all-zero usage stays unknown. Input/output counters are service reports, not verified dollar billing. Response bodies have a default 32 KiB streaming ceiling. No paid service call is required by offline tests.

## Validation and rollout

Regression tests cover protocol switching, actual loopback HTTP and the CLI, authority restrictions, temporary scope, ambiguous/risky results, sensitive filtering, distribution validation, cancellation, timeout, usage and unchanged ingestion. These are contract fixtures, not model-quality measurements. Chinese mixed-context accuracy, thresholds, live service latency/cost and development-efficiency benefits remain unmeasured. Keep 1.33 enforcement gated on the planned independent evaluation.

Protocol reference: https://docs.typesafe.ai/api
