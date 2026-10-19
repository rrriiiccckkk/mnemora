import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createTempDir } from "./helpers/temp.mjs";
import { recallText } from "./helpers/recall.mjs";
import { normalizeConfig } from "../dist/config.js";
import { HostEmbedder, selectHostEmbedding } from "../dist/host-embeddings.js";
import { PluginRuntime } from "../dist/plugin-runtime.js";
import { journalEmbeddingCoverage } from "../dist/journal/search-index.js";

const CONCEPTS = [
  ["hike", "hiking", "trail", "trails", "mountain", "outdoors", "outdoor", "weekend", "nature"],
  ["code", "function", "python", "bug", "test", "compile"]
];
const vectorFor = (text) => {
  const vector = CONCEPTS.map(() => 0).concat([0.05]);
  for (const word of String(text).toLowerCase().match(/[a-z]+/g) ?? []) CONCEPTS.forEach((words, axis) => { if (words.includes(word)) vector[axis] += 3; });
  return vector;
};
const quietLogger = (sink = { info: [], warn: [] }) => ({ debug() {}, info(message, fields) { sink.info.push([String(message), fields]); }, warn(message, fields) { sink.warn.push([String(message), fields]); } });

/** Minimal Ollama /api/embed endpoint, so the test exercises OpenClaw's real ollama adapter. */
async function fakeOllama() {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      requests.push({ url: request.url, model: parsed.model, count: [].concat(parsed.input ?? parsed.prompt ?? []).length });
      if (request.url !== "/api/embed") { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: parsed.model, embeddings: [].concat(parsed.input).map(vectorFor) }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

const selection = (create, model = "fake-model") => ({ ok: true, provider: "host:fake", model, create });

test("host selection: missing config, disabled search and provider none select nothing", () => {
  assert.deepEqual(selectHostEmbedding(undefined, "main"), { ok: false, reason: "host_unavailable" });
  assert.deepEqual(selectHostEmbedding({ memory: { search: { enabled: false } } }, "main"), { ok: false, reason: "memory_search_disabled" });
  assert.deepEqual(selectHostEmbedding({ memory: { search: { provider: "none" } } }, "main"), { ok: false, reason: "provider_none" });
});

test("host selection: OpenClaw's default provider and an explicit ollama provider resolve without network", () => {
  const openai = selectHostEmbedding({}, "main");
  assert.equal(openai.ok, true);
  assert.equal(openai.provider, "host:openai");
  assert.equal(openai.model, "text-embedding-3-small");
  const ollama = selectHostEmbedding({ memory: { search: { provider: "ollama", model: "all-minilm", remote: { baseUrl: "http://127.0.0.1:9" } } } }, "main");
  assert.equal(ollama.ok, true);
  assert.equal(ollama.provider, "host:ollama");
  assert.equal(ollama.model, "all-minilm");
  assert.equal(typeof ollama.create, "function");
});

test("HostEmbedder normalizes vectors and reports the host identity", async () => {
  const embedder = new HostEmbedder(selection(async () => ({ id: "fake", model: "fake-model", embedBatch: async (inputs) => inputs.map(() => [3, 4]) })));
  const result = await embedder.embed(["a", "b"]);
  assert.deepEqual(result.identity, { provider: "host:fake", model: "fake-model", dimensions: 2 });
  assert.deepEqual(result.vectors, [[0.6, 0.8], [0.6, 0.8]]);
});

test("HostEmbedder rejects count mismatches and truncates inputs to the provider token limit", async () => {
  const seen = [];
  const embedder = new HostEmbedder(selection(async () => ({ id: "fake", model: "fake-model", maxInputTokens: 5, embedBatch: async (inputs) => { seen.push(...inputs); return [[1, 0]]; } })));
  await assert.rejects(embedder.embed(["abcdefghij", "xy"]), /count mismatch/u);
  assert.deepEqual(seen, ["abcde", "xy"]);
});

test("HostEmbedder retries a failed provider creation at most once a minute", async () => {
  let now = 1_000_000;
  let attempts = 0;
  const embedder = new HostEmbedder(selection(async () => { attempts += 1; if (attempts === 1) throw new Error("No API key found"); return { id: "fake", model: "fake-model", embedBatch: async (inputs) => inputs.map(() => [1, 0]) }; }), () => now);
  await assert.rejects(embedder.embed(["a"]), /No API key/u);
  await assert.rejects(embedder.embed(["a"]), /unavailable/u);
  assert.equal(attempts, 1);
  now += 61_000;
  assert.equal((await embedder.embed(["a"])).vectors.length, 1);
  assert.equal(attempts, 2);
});

test("config accepts host as an embeddings provider and keeps ollama as the default", () => {
  assert.equal(normalizeConfig({}).embeddings.provider, "ollama");
  assert.equal(normalizeConfig({}).embeddings.enabled, false);
  assert.equal(normalizeConfig({ embeddings: { enabled: true, provider: "host" } }).embeddings.provider, "host");
  assert.equal(normalizeConfig({ embeddings: { provider: "other" } }).embeddings.provider, "ollama");
  assert.equal(normalizeConfig({ embeddings: { provider: "host:openai" } }).embeddings.provider, "host:openai");
  assert.equal(normalizeConfig({ embeddings: { provider: "host:bad value" } }).embeddings.provider, "ollama");
});

test("PluginRuntime with provider host embeds through OpenClaw's adapter and recalls a paraphrase", async () => {
  const ollama = await fakeOllama();
  const directory = createTempDir("host-embeddings-");
  const sink = { info: [], warn: [] };
  const hostConfig = { memory: { search: { provider: "ollama", model: "concept-test", remote: { baseUrl: ollama.baseUrl } } } };
  const runtime = new PluginRuntime({ dbPath: join(directory, "m.db"), mode: "standalone", conversationJournal: { enabled: true }, contextEngine: { enabled: true }, embeddings: { enabled: true, provider: "host" }, unifiedRetrieval: { enabled: true, shadowMode: false } }, quietLogger(sink), hostConfig);
  try {
    assert.equal(runtime.config.embeddings.enabled, true);
    assert.equal(runtime.config.embeddings.provider, "host:ollama");
    assert.equal(runtime.config.embeddings.model, "concept-test");
    assert.ok(sink.info.some(([message]) => /memory-search provider/u.test(message)));
    const engine = runtime.contextEngine;
    await engine.ingestBatch({ sessionId: "pref", messages: [{ role: "user", content: "I really love hiking on mountain trails." }] });
    await engine.ingestBatch({ sessionId: "other", messages: [{ role: "user", content: "The python function fails its unit test." }] });
    const graph = runtime.openGraph();
    try {
      const coverage = journalEmbeddingCoverage(graph.store.db, { provider: "host:ollama", model: "concept-test", dimensions: CONCEPTS.length + 1 });
      assert.ok(coverage.chunks > 0);
      assert.equal(coverage.embedded, coverage.chunks);
    } finally { graph.close(); }
    const prompt = "Any suggestions for this weekend outdoors?";
    const rendered = recallText(await engine.assemble({ sessionId: "query-session", prompt, messages: [{ role: "user", content: prompt }], tokenBudget: 16000 })) ?? "";
    assert.match(rendered, /hiking on mountain trails/u);
    assert.doesNotMatch(rendered, /python function/u);
    assert.ok(ollama.requests.length > 0);
    assert.ok(ollama.requests.every(request => request.url === "/api/embed" && request.model === "concept-test"));
  } finally {
    await runtime.stop?.();
    await ollama.close();
  }
});

test("PluginRuntime with provider host stays lexical when OpenClaw memory search has no provider", () => {
  const sink = { info: [], warn: [] };
  const runtime = new PluginRuntime({ dbPath: ":memory:", embeddings: { enabled: true, provider: "host" } }, quietLogger(sink), { memory: { search: { provider: "none" } } });
  try {
    assert.equal(runtime.config.embeddings.enabled, false);
    assert.ok(sink.warn.some(([message]) => /host embeddings unavailable/u.test(message) && /provider_none/u.test(message)));
  } finally { runtime.stop?.(); }
});

test("importing Mnemora does not load the memory-core SDK or replace the global fetch dispatcher", () => {
  // The SDK swaps the undici global dispatcher on load, so HTTPS_PROXY stops
  // applying to every later fetch in the process. It may load only when
  // `provider: "host"` is configured.
  // A file:// URL, not a path: Windows paths ("D:\\...") are not import specifiers.
  const entry = new URL("../dist/index.js", import.meta.url).href;
  const script = `const key = Symbol.for("undici.globalDispatcher.1"); const before = globalThis[key]; await import(${JSON.stringify(entry)}); process.stdout.write(String(globalThis[key] === before));`;
  assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://127.0.0.1:9" } }), "true");
});
