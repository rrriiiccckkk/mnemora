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

## Runtime observation (1.32.15)

Enabled shadow calls through runtime graph handles emit an info event named `semantic classification observed`. Its closed fields are status, recommendation, elapsedMs, usageKnown, inputTokens, outputTokens and applied=false. Missing usage is null, never an invented zero; a reported zero output count remains known when input usage is positive. No candidate/evidence text, source/scope/session identifiers, endpoint, model, API key, raw response, or probabilities are logged. Observer failures cannot affect ingestion. Off mode emits no observation. The standalone classification CLI still returns its report without runtime logging. Events are operational observations, not stored evaluation labels or proof of classifier quality. Calls skipped before classification and turns blocked by the host emit no classifier event.

### SDK log transport

Runtime observation is emitted as one message string:
`semantic classification observed {"status":"...","elapsedMs":0,...}`.
The suffix is JSON containing only the closed scalar observation fields. This
matches the public OpenClaw logger; the SDK does not preserve a second fields
argument. Input/evidence text, scope, model response bodies and credentials are
absent. Unknown usage remains `usageKnown:false`, never an inferred token count.
Event titles from older versions may lack metadata and cannot prove success.

HTTP errors now include a numeric `httpStatus` (400–599) in the operator report
and content-free runtime observation. Provider response bodies are never logged;
there are no automatic retries. An HTTP code describes the request path and
cannot by itself identify a model failure. Real-service trials that require a
proxy must launch Node with explicit environment proxy support; see the
[isolated trial guide](recall-relevance-evaluation.md#network-proxy-for-isolated-trials).
