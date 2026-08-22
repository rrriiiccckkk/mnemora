import assert from "node:assert/strict";
import test from "node:test";
import { buildExplanationPayload, InsightExplainer } from "../dist/insights/explainer.js";

const candidate = (id = "insight:1") => ({
  id, kind: "knowledge_gap", signals: { density: .2 },
  entity_names: ["Private Co"], entity_types: ["company"], relationship_types: ["supplies"],
  community_metrics: { density: .2, average_confidence: .7 },
  observation: "secret observation", source: "https://private.example", quote: "secret observation"
});

const input = (count = 1) => ({ candidates: Array.from({ length: count }, (_, index) => candidate(`insight:${index + 1}`)) });
const providerResponse = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });

test("explanation payload contains no evidence or source bodies", () => {
  const fixture = input();
  fixture.candidates[0].signals["secret observation"] = 1;
  fixture.candidates[0].community_metrics["https://private.example"] = 1;
  const payload = buildExplanationPayload(fixture, 5);
  const json = JSON.stringify(payload);
  assert.equal(json.includes("secret observation"), false);
  assert.equal(json.includes("https://private.example"), false);
  assert.deepEqual(Object.keys(payload.candidates[0]).sort(), ["community_metrics", "entity_names", "entity_types", "id", "kind", "relationship_types", "signals"]);
});

test("explanation payload validates and bounds type arrays at runtime", () => {
  const fixture = input();
  fixture.candidates[0].entity_types = ["company", "company", "secret observation", "https://private.example", { type: "person" }, "person"];
  fixture.candidates[0].relationship_types = ["supplies", "supplies", "secret observation", "https://private.example", { type: "uses" }, "uses"];
  const payload = buildExplanationPayload(fixture, 5);
  assert.deepEqual(payload.candidates[0].entity_types, ["company", "person"]);
  assert.deepEqual(payload.candidates[0].relationship_types, ["supplies", "uses"]);
  assert.equal(JSON.stringify(payload).includes("secret observation"), false);
  assert.equal(JSON.stringify(payload).includes("https://private.example"), false);

  fixture.candidates[0].entity_types = Array.from({ length: 100 }, (_, index) => index % 2 ? "company" : "person");
  fixture.candidates[0].relationship_types = Array.from({ length: 100 }, (_, index) => index % 2 ? "uses" : "supplies");
  assert.deepEqual(buildExplanationPayload(fixture).candidates[0].entity_types, ["person", "company"]);
  assert.deepEqual(buildExplanationPayload(fixture).candidates[0].relationship_types, ["supplies", "uses"]);
});

test("explanation payload caps candidates at the configured maximum of five", () => {
  assert.equal(buildExplanationPayload(input(7), 99).candidates.length, 5);
  assert.equal(buildExplanationPayload(input(7), 2).candidates.length, 2);
});

test("explanation payload has deterministic hard privacy and byte ceilings", () => {
  const fixture = { candidates: Array.from({ length: 10 }, (_, index) => ({
    ...candidate(`insight:${index}:${"i".repeat(10000)}`),
    entity_names: Array.from({ length: 1000 }, (_, name) => `${name}:${"🧪".repeat(1000)}`),
    entity_types: Array.from({ length: 1000 }, (_, n) => n % 2 ? "company" : "person"),
    relationship_types: Array.from({ length: 1000 }, (_, n) => n % 2 ? "uses" : "supplies"),
    observation: "SECRET_OBSERVATION", source: "SECRET_SOURCE", quote: "SECRET_QUOTE",
    url: "SECRET_URL", description: "SECRET_DESCRIPTION"
  })) };
  const payload = buildExplanationPayload(fixture, 1000);
  const serialized = JSON.stringify(payload);
  assert.equal(payload.candidates.length, 5);
  assert.ok(payload.candidates.every(item => item.id.length <= 160));
  assert.ok(payload.candidates.every(item => item.entity_names.length <= 32));
  assert.ok(payload.candidates.every(item => item.entity_names.every(name => name.length <= 160)));
  assert.ok(payload.candidates.every(item => item.signals.omitted_entity_count >= 968));
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 32 * 1024);
  assert.doesNotMatch(serialized, /SECRET_(?:OBSERVATION|SOURCE|QUOTE|URL|DESCRIPTION)/);
});

test("omitted entity count includes duplicate valid names", () => {
  const fixture = input();
  fixture.candidates[0].entity_names = Array.from({ length: 1000 }, () => "Repeated Company");
  const payload = buildExplanationPayload(fixture);
  assert.deepEqual(payload.candidates[0].entity_names, ["Repeated Company"]);
  assert.equal(payload.candidates[0].signals.omitted_entity_count, 999);
});

test("provider request uses bounded JSON settings and returns only explanations", async () => {
  let request;
  const explainer = new InsightExplainer({ llm: { apiKey: "configured", baseURL: "https://example.test/v1/", model: "model" }, insights: { maxExplanationCandidates: 5, explanationTimeoutMs: 1000 } }, async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return providerResponse('{"explanations":[{"id":"insight:1","text":" Short explanation. "}]}');
  });
  assert.deepEqual(await explainer.explain(input()), { "insight:1": "Short explanation." });
  assert.equal(request.url, "https://example.test/v1/chat/completions");
  assert.equal(request.init.headers.authorization, "Bearer configured");
  assert.equal(request.body.model, "model");
  assert.equal(request.body.temperature, 0);
  assert.deepEqual(request.body.response_format, { type: "json_object" });
  assert.deepEqual(Object.keys(request.body).sort(), ["messages", "model", "response_format", "temperature"]);
  assert.equal(JSON.stringify(request.body).includes("secret observation"), false);
});

test("availability detects config key and DEEPSEEK_API_KEY", () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  try {
    delete process.env.DEEPSEEK_API_KEY;
    assert.equal(new InsightExplainer({ llm: { apiKey: "configured" } }).available, true);
    assert.equal(new InsightExplainer({}).available, false);
    process.env.DEEPSEEK_API_KEY = "environment";
    assert.equal(new InsightExplainer({}).available, true);
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
});

test("blank config credentials fall back to the trimmed environment key", async () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DEEPSEEK_API_KEY = "  environment  ";
    for (const apiKey of ["", "   "]) {
      let authorization;
      const explainer = new InsightExplainer({ llm: { apiKey } }, async (_url, init) => {
        authorization = init.headers.authorization;
        return providerResponse('{"explanations":[]}');
      });
      assert.equal(explainer.available, true);
      await explainer.explain(input());
      assert.equal(authorization, "Bearer environment");
    }
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
});

test("invalid provider output is rejected", async () => {
  const invalid = [
    '{"explanations":[{"id":"unknown","text":"text"}]}',
    '{"explanations":[{"id":"insight:1","text":""}]}',
    JSON.stringify({ explanations: [{ id: "insight:1", text: "x".repeat(601) }] }),
    '{"explanations":[{"id":"insight:1","text":"one"},{"id":"insight:1","text":"two"}]}',
    '{"explanations":[{"id":"insight:1","text":"ok","extra":"leak"}]}'
  ];
  for (const content of invalid) {
    const fixture = input();
    const before = structuredClone(fixture);
    const explainer = new InsightExplainer({ llm: { apiKey: "key" } }, async () => providerResponse(content));
    await assert.rejects(explainer.explain(fixture), /invalid explanation response/);
    assert.deepEqual(fixture, before);
  }
});

test("missing credentials fails with a bounded error before fetch", async () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const explainer = new InsightExplainer({}, async () => { throw new Error("fetch must not run"); });
    await assert.rejects(explainer.explain(input()), /^Error: insight explanations unavailable$/);
  } finally {
    if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous;
  }
});

test("HTTP failures omit provider response bodies", async () => {
  const explainer = new InsightExplainer({ llm: { apiKey: "key" } }, async () => ({ ok: false, status: 429, text: async () => "provider secret" }));
  await assert.rejects(explainer.explain(input()), (error) => {
    assert.equal(error.message, "insight explanation failed: 429");
    assert.doesNotMatch(String(error), /provider secret/);
    return true;
  });
});

test("timeout aborts fetch and caller/runtime abort signals are composed", async () => {
  const caller = new AbortController();
  const runtime = new AbortController();
  let captured;
  const fetcher = async (_url, init) => {
    captured = init.signal;
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  };
  const explainer = new InsightExplainer({ llm: { apiKey: "key" }, insights: { explanationTimeoutMs: 20 } }, fetcher, runtime.signal);
  await assert.rejects(explainer.explain(input()), /timed out/);
  assert.equal(captured.aborted, true);

  const pending = new InsightExplainer({ llm: { apiKey: "key" }, insights: { explanationTimeoutMs: 1000 } }, fetcher, runtime.signal).explain(input(), { signal: caller.signal });
  caller.abort(new Error("caller stopped"));
  await assert.rejects(pending, /caller stopped/);
});

test("runtime abort reaches the fetch signal and clears the timeout", async () => {
  const runtime = new AbortController();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let timerHandle;
  let clearedHandle;
  let captured;
  globalThis.setTimeout = (callback, delay, ...args) => {
    timerHandle = originalSetTimeout(callback, delay, ...args);
    return timerHandle;
  };
  globalThis.clearTimeout = (handle) => {
    clearedHandle = handle;
    return originalClearTimeout(handle);
  };
  try {
    const explainer = new InsightExplainer({ llm: { apiKey: "key" }, insights: { explanationTimeoutMs: 1000 } }, async (_url, init) => {
      captured = init.signal;
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    }, runtime.signal);
    const pending = explainer.explain(input());
    runtime.abort(new Error("runtime stopped"));
    await assert.rejects(pending, /runtime stopped/);
    assert.equal(captured.aborted, true);
    assert.equal(clearedHandle, timerHandle);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
