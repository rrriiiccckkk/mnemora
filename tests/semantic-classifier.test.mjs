import assert from "node:assert/strict";
import test from "node:test";
import { SemanticMemoryClassifier, normalizeSemanticClassifierConfig } from "../dist/cognition/semantic-classifier.js";
import { Mnemora } from "../dist/tools.js";
import { normalizeConfig } from "../dist/config.js";
import plugin from "../dist/plugin.js";
import { Check } from "typebox/value";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { createTempDir } from "./helpers/temp.mjs";

const config = { mode: "shadow", endpoint: "http://127.0.0.1:8765/v1/systemone", model: "decision-model" };
const request = { scope: "a", candidate: "I usually prefer an aisle seat.", evidence: [{ role: "user", text: "I usually prefer an aisle seat." }], context: { task: "Current flight booking" } };
function response(scope = "account", extra = {}) {
  return { model: "resolved-model", answers: {
    explicit_user: { type: "noul", noul: .99 }, beyond_task: { type: "noul", noul: .99 }, reuse_risk: { type: "noul", noul: .01 },
    retention_scope: { type: "choice", choice: scope, probabilities: Object.fromEntries(["account", "task", "session", "reject", "unknown"].map(key => [key, key === scope ? .96 : .01])), confidence: .95 }
  }, usage: { input_tokens: 80, output_tokens: 0 }, ...extra };
}
const mock = value => async () => new Response(JSON.stringify(value));

test("one configured API switches services without a provider branch and returns only shadow labels", async () => {
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, ...options, parsed: JSON.parse(options.body) }); return new Response(JSON.stringify(response())); };
  for (const settings of [config, { ...config, endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest" }]) {
    const report = await new SemanticMemoryClassifier(settings, fetcher).classify(request);
    assert.equal(report.status, "succeeded");
    assert.equal(report.recommendation, "persistent_candidate");
    assert.equal(report.applied, false);
    assert.deepEqual(report.usage, { inputTokens: 80, outputTokens: 0 });
  }
  assert.equal(calls[0].url, config.endpoint);
  assert.equal(calls[1].parsed.model, "jev-latest");
  assert.deepEqual(calls[0].parsed.questions, calls[1].parsed.questions);
  assert.equal(calls[0].parsed.state.scope, undefined);
  assert.equal(calls[0].redirect, "error");
});

test("task, session, ambiguity and risk remain separate; no assistant assertion becomes user authority", async () => {
  for (const [scope, expected] of [["task", "task_only"], ["session", "session_only"], ["unknown", "defer"], ["reject", "reject"]]) {
    const report = await new SemanticMemoryClassifier(config, mock(response(scope))).classify(request);
    assert.equal(report.recommendation, expected);
  }
  const weak = response(); weak.answers.explicit_user.noul = .3;
  assert.equal((await new SemanticMemoryClassifier(config, mock(weak)).classify(request)).recommendation, "defer");
  const risky = response(); risky.answers.reuse_risk.noul = .8;
  assert.equal((await new SemanticMemoryClassifier(config, mock(risky)).classify(request)).recommendation, "defer");
  const assistant = { ...request, evidence: [{ role: "assistant", text: request.candidate }] };
  assert.equal((await new SemanticMemoryClassifier(config, mock(response())).classify(assistant)).recommendation, "defer");
});

test("disabled, sensitive, invalid and cancelled inputs never call a service", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return new Response(JSON.stringify(response())); };
  assert.equal((await new SemanticMemoryClassifier({}, fetcher).classify(request)).status, "disabled");
  for (const candidate of ["password=synthetic-secret", "护照号：E12345678", "payment: synthetic-card", "4111 1111 1111 1111"]) {
    const report = await new SemanticMemoryClassifier(config, fetcher).classify({ ...request, candidate });
    assert.equal(report.status, "sensitive_blocked");
    assert.doesNotMatch(JSON.stringify(report), /synthetic-secret|E12345678|4111/);
  }
  assert.equal((await new SemanticMemoryClassifier(config, fetcher).classify({ ...request, context: { session: "secret=synthetic-secret" } })).status, "sensitive_blocked");
  assert.equal((await new SemanticMemoryClassifier(config, fetcher).classify({ ...request, candidate: "x".repeat(9000) })).status, "invalid_input");
  assert.equal((await new SemanticMemoryClassifier(config, fetcher).classify({ ...request, evidence: [] })).status, "invalid_input");
  assert.equal((await new SemanticMemoryClassifier(config, fetcher).classify({ ...request, signal: AbortSignal.abort() })).status, "aborted");
  assert.equal(calls, 0);
});

test("API errors and bounded timeouts defer without retrying or exposing remote bodies", async () => {
  let calls = 0;
  const service = new SemanticMemoryClassifier({ ...config, timeoutMs: 100 }, async () => { calls++; return new Promise(() => {}); });
  assert.equal((await service.classify(request)).status, "timeout");
  assert.equal(calls, 1);
  const failed = await new SemanticMemoryClassifier(config, async () => new Response("raw synthetic secret", { status: 429 })).classify(request);
  assert.equal(failed.status, "http_error");
  assert.doesNotMatch(JSON.stringify(failed), /raw synthetic secret/);
  assert.equal((await new SemanticMemoryClassifier(config, async () => new Response("invalid-json")).classify(request)).status, "invalid_response");
  assert.equal((await new SemanticMemoryClassifier({ ...config, maxResponseBytes: 1024 }, async () => new Response("x".repeat(1025))).classify(request)).status, "invalid_response");
});

test("deadline covers stalled response streaming and caller cancellation stops an in-flight request", async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); }, cancel() { cancelled = true; } });
  const stalled = new SemanticMemoryClassifier({ ...config, timeoutMs: 100 }, async () => new Response(body));
  assert.equal((await stalled.classify(request)).status, "timeout");
  assert.equal(cancelled, true);
  const controller = new AbortController();
  const service = new SemanticMemoryClassifier(config, async () => new Promise(() => {}));
  const pending = service.classify({ ...request, signal: controller.signal });
  controller.abort();
  assert.equal((await pending).status, "aborted");
});

test("malformed distributions, missing answers and low confidence cannot recommend durable retention", async () => {
  const cases = [];
  const missing = response(); delete missing.answers.beyond_task; cases.push(missing);
  const bad = response(); bad.answers.retention_scope.probabilities.account = 2; cases.push(bad);
  const inconsistent = response(); inconsistent.answers.retention_scope.choice = "task"; cases.push(inconsistent);
  for (const value of cases) {
    const report = await new SemanticMemoryClassifier(config, mock(value)).classify(request);
    assert.equal(report.status, "invalid_response");
    assert.equal(report.recommendation, "defer");
    assert.deepEqual(report.usage, { inputTokens: 80, outputTokens: 0 });
  }
  const low = response(); low.answers.retention_scope.confidence = .2;
  assert.equal((await new SemanticMemoryClassifier(config, mock(low)).classify(request)).recommendation, "defer");
});

test("credentials use a named environment variable and unsafe endpoints fail before network access", async () => {
  process.env.MNEMORA_TEST_CLASSIFIER_KEY = "synthetic-key";
  try {
    let calls = 0;
    const fetcher = async (_, options) => { calls++; assert.equal(options.headers.Authorization, "Bearer synthetic-key"); return new Response(JSON.stringify(response())); };
    const authenticated = new SemanticMemoryClassifier({ ...config, apiKeyEnv: "MNEMORA_TEST_CLASSIFIER_KEY" }, fetcher);
    assert.equal((await authenticated.classify(request)).status, "succeeded");
    for (const endpoint of ["http://example.com/v1/systemone", "https://user:pass@example.com/v1/systemone", "https://example.com/?api_key=secret"]) assert.equal((await new SemanticMemoryClassifier({ ...config, endpoint }, fetcher).classify(request)).status, "configuration_error");
    assert.equal((await new SemanticMemoryClassifier({ ...config, apiKeyEnv: "UNDEFINED_CLASSIFIER_KEY" }, fetcher).classify(request)).status, "configuration_error");
    assert.equal(calls, 1);
  } finally { delete process.env.MNEMORA_TEST_CLASSIFIER_KEY; }
});

test("both plugin schemas and normalized configuration keep classification explicitly off or shadow", () => {
  const value = { cognition: { admission: { semanticClassifier: config } } };
  assert.equal(Check(plugin.configSchema.jsonSchema, value), true);
  assert.equal(Check(plugin.configSchema.jsonSchema, { cognition: { admission: { semanticClassifier: { mode: "enforce" } } } }), false);
  const schema = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url))).configSchema.properties.cognition.properties.admission.properties.semanticClassifier;
  assert.deepEqual(schema.properties.mode.anyOf.map(item => item.const), ["off", "shadow"]);
  assert.equal(normalizeConfig({}).cognition.admission.semanticClassifier.mode, "off");
  assert.equal(normalizeSemanticClassifierConfig({ mode: "enforce" }).mode, "off");
  assert.equal(normalizeConfig(value).cognition.admission.semanticClassifier.endpoint, config.endpoint);
});

test("automatic ingestion exposes shadow results without changing graph confidence or creating beliefs", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:", cognition: { admission: { semanticClassifier: config } } }, fetcher: mock(response()) });
  try {
    const extraction = { entities: [{ name: "Acme", type: "company", confidence: .8, evidence_span: "Acme" }], relations: [] };
    const result = await graph.ingestAutomaticExtraction({ text: "I usually prefer Acme.", source: "session:test:turn:one", extraction });
    assert.equal(result.status, "succeeded");
    assert.equal(result.semanticShadow.recommendation, "persistent_candidate");
    assert.equal(result.semanticShadow.applied, false);
    assert.equal(graph.store.db.prepare("SELECT confidence FROM kg_observations").get().confidence, .8);
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_beliefs").get().n, 0);
    const failure = new SemanticMemoryClassifier(config, async () => { throw new Error("private remote error"); });
    assert.equal((await failure.classify(request)).status, "transport_error");
  } finally { graph.close(); }
});

test("real HTTP and operator CLI use the same protocol without opening a memory database", async () => {
  const calls = [];
  const server = createServer(async (incoming, outgoing) => {
    let body = "";
    for await (const chunk of incoming) body += chunk;
    calls.push({ path: incoming.url, body: JSON.parse(body) });
    outgoing.writeHead(200, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify(response("task")));
  });
  const directory = createTempDir("mnemora-classifier-api-");
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}/v1/systemone`;
    const settings = { ...config, endpoint, timeoutMs: 3000 };
    const first = await new SemanticMemoryClassifier(settings).classify(request);
    assert.equal(first.recommendation, "task_only");
    const inputPath = join(directory, "input.json"), configPath = join(directory, "config.json"), databasePath = join(directory, "unused.db");
    writeFileSync(inputPath, JSON.stringify(request));
    writeFileSync(configPath, JSON.stringify({ ...settings, endpoint: endpoint.replace("/v1/", "/alternate/v1/"), model: "other-model" }));
    const cli = await promisify(execFile)(process.execPath, ["dist/cli.js", "cognition", "classify", inputPath, "--config", configPath], { env: { ...process.env, MNEMORA_DB: databasePath } });
    const output = JSON.parse(cli.stdout);
    assert.equal(output.command, "cognition.classify");
    assert.equal(output.result.recommendation, "task_only");
    assert.equal(output.result.applied, false);
    assert.equal(calls[1].path, "/alternate/v1/systemone");
    assert.equal(calls[1].body.model, "other-model");
    assert.throws(() => readFileSync(databasePath), /ENOENT/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});


test("classifier observers receive content-free success/failure usage and cannot change results", async () => {
  const dir = createTempDir("classifier-telemetry-");
  const events = [];
  const graph = new Mnemora({ config: { dbPath: join(dir, "memory.db"), cognition: { admission: { semanticClassifier: config } } }, fetcher: mock(response()), onSemanticClassification: event => events.push(event) });
  try {
    const report = await graph.classifyMemoryCandidate({ ...request, scope: "private-scope" });
    assert.deepEqual(events, [{ status: "succeeded", recommendation: "persistent_candidate", elapsedMs: report.elapsedMs, usageKnown: true, inputTokens: 80, outputTokens: 0, applied: false }]);
    graph.onSemanticClassification = () => { throw new Error("observer failure with private data"); };
    assert.equal((await graph.classifyMemoryCandidate(request)).status, "succeeded");
    graph.onSemanticClassification = event => events.push(event);
    graph.semanticClassifier.fetcher = mock({});
    assert.equal((await graph.classifyMemoryCandidate(request)).status, "invalid_response");
    assert.equal(events.at(-1).usageKnown, false);
    assert.equal(events.at(-1).inputTokens, null);
    assert.equal(events.at(-1).recommendation, "defer");
    assert.doesNotMatch(JSON.stringify(events), /private-scope|aisle|resolved-model|systemone|evidence/);
    graph.semanticClassifier.config.mode = "off";
    const count = events.length;
    assert.equal((await graph.classifyMemoryCandidate(request)).status, "disabled");
    assert.equal(events.length, count);
  } finally { graph.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("runtime ordinary and admitted graphs expose classifier observation at info level", async () => {
  const { PluginRuntime } = await import("../dist/plugin-runtime.js");
  const dir = createTempDir("classifier-runtime-");
  const logs = [];
  const runtime = new PluginRuntime({ dbPath: join(dir, "memory.db"), cognition: { admission: { semanticClassifier: { ...config, endpoint: "" } } } }, { info: (message, fields) => logs.push({ message, fields }) });
  try {
    for (const open of [() => runtime.openGraph(), () => runtime.openGraphForAdmitted()]) {
      const graph = open();
      try { assert.equal((await graph.classifyMemoryCandidate(request)).status, "configuration_error"); }
      finally { graph.close(); }
    }
    const observed = logs.filter(log => log.message === "semantic classification observed");
    assert.equal(observed.length, 2);
    for (const log of observed) {
      assert.equal(log.message, "semantic classification observed");
      assert.equal(log.fields.status, "configuration_error");
      assert.equal(log.fields.usageKnown, false);
      assert.deepEqual(Object.keys(log.fields).sort(), ["applied", "elapsedMs", "inputTokens", "outputTokens", "recommendation", "status", "usageKnown"]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
