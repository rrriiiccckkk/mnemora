import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Check } from "typebox/value";
import plugin from "../dist/plugin.js";
import { Mnemora } from "../dist/tools.js";
import { GraphologyStore } from "../dist/store.js";
import { normalizeConfig } from "../dist/config.js";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { RecallRelevanceShadow } from "../dist/retrieval/relevance-shadow.js";
import { UnifiedRetrievalService } from "../dist/retrieval/service.js";
import { UnifiedRecallShadowRepository } from "../dist/retrieval/unified-recall-shadow.js";
import { createTempDir } from "./helpers/temp.mjs";

const config = { enabled: true, endpoint: "http://127.0.0.1:8080/v1/systemone", model: "decision", timeoutMs: 100 };
const candidate = (id, scope = "default") => ({ contextRef: `mnemora://v1/scope/${scope}/memory-document/${id}`, kind: "memory-document", scope, title: "Mnemora design", excerpt: `Mnemora retrieval bounded ${id}`, score: .7, confidence: .9, authority: "user_explicit", estimatedTokens: 15, bytes: 40, sourceIds: [], sourceRefs: [], freshness: Date.now(), selectionReason: "lexical_match" });
const reply = (...values) => ({ answers: Object.fromEntries(values.map((noul, i) => [`c${i}`, { type: "noul", noul }])), usage: { input_tokens: 23, output_tokens: 0 } });
const mock = body => async () => new Response(JSON.stringify(body));

test("recall relevance batches typed questions once and returns subtraction-only content-free advice", async () => {
  const candidates = [candidate("a"), candidate("b"), candidate("c")], before = JSON.stringify(candidates);
  let calls = 0;
  const service = new RecallRelevanceShadow({ ...config, maxCandidates: 2, apiKey: "secret-test-key" }, async (_url, options) => {
    calls++;
    assert.equal(options.headers.authorization, "Bearer secret-test-key");
    assert.equal(options.redirect, "error");
    const body = JSON.parse(options.body);
    assert.equal(body.state.task, "recall_relevance");
    assert.deepEqual(Object.keys(body.questions), ["c0", "c1"]);
    assert.ok(Object.values(body.questions).every(q => q.type === "noul"));
    assert.doesNotMatch(options.body, /mnemora:\/\/|sourceIds|scope/);
    return new Response(JSON.stringify(reply(.05, .6)));
  });
  const advice = await service.evaluate("default", "Mnemora design", candidates);
  assert.equal(calls, 1);
  assert.deepEqual(advice.removeRefs, [candidates[0].contextRef]);
  assert.deepEqual(advice.observation.diff.map(d => d.reason), ["irrelevant", "uncertain", "outside_limit"]);
  assert.equal(advice.observation.original.length, 3);
  assert.equal(advice.observation.suggested.length, 2);
  assert.deepEqual(advice.observation.usage, { input_tokens: 23, output_tokens: 0 });
  assert.equal(advice.observation.applied, false);
  assert.doesNotMatch(JSON.stringify(advice.observation), /Mnemora|retrieval bounded|secret-test|mnemora:\/\//);
  assert.equal(JSON.stringify(candidates), before);
});

test("off, cross-scope, sensitive, oversize query and cancellation never invoke a service", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error("must not call"); };
  assert.equal(await new RecallRelevanceShadow({}, fetcher).evaluate("default", "q", []), undefined);
  const service = new RecallRelevanceShadow(config, fetcher);
  assert.equal((await service.evaluate("default", "q", [candidate("a", "foreign")])).observation.status, "invalid_input");
  assert.equal((await service.evaluate("default", "x".repeat(513), [candidate("a")])).observation.status, "invalid_input");
  assert.equal((await service.evaluate("default", "passport: ABC123", [candidate("a")])).observation.status, "sensitive_blocked");
  assert.equal((await service.evaluate("default", "q", [{ ...candidate("a"), excerpt: "password=private-password" }])).observation.status, "sensitive_blocked");
  assert.equal((await service.evaluate("default", "q", [candidate("a")], AbortSignal.abort())).observation.status, "aborted");
  assert.equal(calls, 0);
});

test("failures preserve baseline with no retry and retain known usage from invalid typed answers", async () => {
  for (const [fetcher, status, expectedUsage = null] of [
    [async () => { throw new Error("sensitive remote error"); }, "transport_error"],
    [async () => new Response("private", { status: 429 }), "http_error"],
    [async () => new Response("private"), "invalid_response"],
    [mock({ answers: { c0: { type: "noul", noul: 2 } }, usage: { input_tokens: 5, output_tokens: 0 } }), "invalid_response", { input_tokens: 5, output_tokens: 0 }],
    [mock(reply(.01)), "invalid_response", { input_tokens: 23, output_tokens: 0 }],
    [async () => new Response("x".repeat(32769)), "invalid_response"],
    [async () => new Promise(() => {}), "timeout"]
  ]) {
    let calls = 0;
    const advice = await new RecallRelevanceShadow(config, (...args) => { calls++; return fetcher(...args); }).evaluate("default", "Mnemora", [candidate("a"), candidate("b")]);
    assert.equal(calls, 1);
    assert.equal(advice.observation.status, status);
    assert.deepEqual(advice.removeRefs, []);
    assert.deepEqual(advice.observation.original, advice.observation.suggested);
    assert.doesNotMatch(JSON.stringify(advice.observation), /sensitive remote|private/);
    assert.deepEqual(advice.observation.usage, expectedUsage);
  }
});

test("deadline cancels stalled streaming; in-flight caller cancellation stays baseline", async () => {
  let cancelled = false;
  const streaming = await new RecallRelevanceShadow(config, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }))).evaluate("default", "Mnemora", [candidate("a")]);
  assert.equal(streaming.observation.status, "timeout");
  assert.equal(cancelled, true);
  const controller = new AbortController();
  const pending = new RecallRelevanceShadow(config, async () => { controller.abort(); return new Promise(() => {}); }).evaluate("default", "q", [candidate("a")], controller.signal);
  assert.equal((await pending).observation.status, "aborted");
});

test("truncated qualifiers cannot produce removal advice; ambiguous results keep candidates", async () => {
  const advice = await new RecallRelevanceShadow({ ...config, maxDocumentChars: 128 }, mock(reply(0))).evaluate("default", "q", [{ ...candidate("a"), excerpt: "x".repeat(200) + " not irrelevant" }]);
  assert.deepEqual(advice.removeRefs, []);
  assert.equal(advice.observation.diff[0].reason, "uncertain");
});

test("both schemas expose a separate disabled-by-default endpoint/model/apiKey/timeout config", () => {
  assert.equal(normalizeConfig({}).unifiedRetrieval.relevanceShadow.enabled, false);
  assert.equal(Check(plugin.configSchema.jsonSchema, { unifiedRetrieval: { relevanceShadow: config } }), true);
  const manifest = JSON.parse(readFileSync("openclaw.plugin.json", "utf8"));
  assert.deepEqual(Object.keys(manifest.configSchema.properties.unifiedRetrieval.properties.relevanceShadow.properties).sort(), ["apiKey", "enabled", "endpoint", "maxCandidates", "maxDocumentChars", "maxQueryChars", "model", "timeoutMs"]);
  assert.equal(Check(plugin.configSchema.jsonSchema, { unifiedRetrieval: { relevanceShadow: { ...config, enforce: true } } }), false);
});

test("v85 migration preserves old rows and stores only closed hashed diffs in the existing repository", async () => {
  const dbPath = join(createTempDir("relevance-migration-"), "memory.db");
  const original = new GraphologyStore(dbPath);
  new UnifiedRecallShadowRepository(original.db).record({ scope: "default", query: "old query", localCandidates: 0, localSelected: 0, localSuppressed: 0, graphCandidates: 0, graphAttached: false, attached: false });
  original.db.exec("ALTER TABLE mnemora_unified_recall_shadow_runs DROP COLUMN relevance_json; PRAGMA user_version=84");
  original.close();
  const graph = new GraphologyStore(dbPath);
  try {
    const repository = new UnifiedRecallShadowRepository(graph.db);
    const observation = (await new RecallRelevanceShadow(config, mock(reply(.01))).evaluate("default", "Mnemora", [candidate("a")])).observation;
    repository.record({ scope: "default", query: "PRIVATE QUERY", localCandidates: 1, localSelected: 1, localSuppressed: 0, graphCandidates: 0, graphAttached: false, attached: true, relevance: { ...observation, excerpt: "PRIVATE EXCERPT", apiKey: "PRIVATE KEY" } });
    const raw = graph.db.prepare("SELECT relevance_json FROM mnemora_unified_recall_shadow_runs WHERE relevance_json IS NOT NULL").get().relevance_json;
    assert.doesNotMatch(raw, /PRIVATE|excerpt|apiKey|Mnemora/);
    assert.equal(repository.list("default").items.find(item => item.relevance).relevance.diff[0].action, "remove");
    assert.equal(repository.list("default").items.length, 2);
    assert.equal(repository.list("default").items.filter(item => !item.relevance).length, 1);
    assert.equal(repository.list("foreign").items.length, 0);
  } finally { graph.close(); }
});

test("real ContextEngine shadow keeps actual prompt byte-identical and does not backfill removed selections", async () => {
  const dbPath = join(createTempDir("relevance-engine-"), "memory.db");
  const base = { dbPath, mode: "standalone", embeddings: { enabled: false }, memory: { enabled: true }, contextEngine: { enabled: true, maxContextTokens: 1000 }, unifiedRetrieval: { enabled: true, tokenBudget: 500, maxItems: 1, minConfidence: .5 } };
  const seed = new Mnemora({ config: base });
  try {
    for (const content of ["Mnemora release design evidence", "Mnemora fallback design notes"]) seed.store.upsertMemoryDocument({ content, title: content, source: `fixture:${content}`, scope: "default" });
  } finally { seed.close(); }
  let calls = 0;
  const bodyCounts = [];
  let probability = .01;
  const fetcher = async (_url, options) => { calls++; const body = JSON.parse(options.body); bodyCounts.push(body.state.candidates.length); return new Response(JSON.stringify(reply(...body.state.candidates.map(() => probability)))); };
  const assemble = async enabled => {
    const config = normalizeConfig({ ...base, unifiedRetrieval: { ...base.unifiedRetrieval, relevanceShadow: { ...configForFixture(), enabled } } });
    const engine = new MnemoraContextEngine(config, () => new Mnemora({ config, fetcher }));
    return engine.assemble({ sessionId: "current", prompt: "Mnemora design", messages: [{ role: "user", content: "Mnemora design" }], tokenBudget: 1000 });
  };
  const baseline = await assemble(false), shadow = await assemble(true);
  assert.match(baseline.systemPromptAddition ?? "", /MNEMORA_MEMORY/);
  assert.deepEqual(shadow, baseline);
  assert.equal(calls, 1);
  assert.deepEqual(bodyCounts, [1]);
  const originalPack = UnifiedRetrievalService.prototype.packPrompt;
  let packingCalls = 0;
  UnifiedRetrievalService.prototype.packPrompt = function (...args) {
    if (++packingCalls === 2) throw new Error("shadow comparison failed");
    return originalPack.apply(this, args);
  };
  try { assert.deepEqual(await assemble(true), baseline); }
  finally { UnifiedRetrievalService.prototype.packPrompt = originalPack; }
  packingCalls = 0;
  probability = .95;
  UnifiedRetrievalService.prototype.packPrompt = function (...args) {
    const packed = originalPack.apply(this, args);
    if (++packingCalls === 2) return { candidates: [], graphAttached: false, estimatedTokens: 0 };
    return packed;
  };
  try { assert.deepEqual(await assemble(true), baseline); }
  finally { UnifiedRetrievalService.prototype.packPrompt = originalPack; }


  const inspect = new Mnemora({ config: base });
  try {
    const observation = inspect.unifiedRecallShadow.list("default").items[0].relevance;
    assert.equal(observation.status, "succeeded");
    assert.equal(observation.original.length, 1);
    assert.deepEqual(observation.suggested, []);
    assert.equal(observation.applied, false);
    assert.equal(observation.diff[0].reason, "packing");
    const failedComparison = inspect.unifiedRecallShadow.list("default").items.find(item => item.relevance?.status === "comparison_error").relevance;
    assert.deepEqual(failedComparison.original, failedComparison.suggested);
    assert.deepEqual(failedComparison.usage, { input_tokens: 23, output_tokens: 0 });
  } finally { inspect.close(); }
});
function configForFixture() { return { ...config, timeoutMs: 1000 }; }


test("runtime cancellation propagates and stateless/excluded assembly never sends relevance requests", async () => {
  const dir = createTempDir("relevance-cancellation-");
  const controller = new AbortController();
  let calls = 0;
  const graph = new Mnemora({ config: { dbPath: join(dir, "memory.db"), unifiedRetrieval: { relevanceShadow: config } }, signal: controller.signal, fetcher: async () => { calls++; controller.abort(); return new Promise(() => {}); } });
  try {
    assert.equal((await graph.adviseRecallRelevance("default", "q", [candidate("a")])).observation.status, "aborted");
    assert.equal(calls, 1);
  } finally { graph.close(); }
  let assemblyCalls = 0;
  const settings = normalizeConfig({ dbPath: join(dir, "assembly.db"), mode: "standalone", contextEngine: { enabled: true }, conversationJournal: { statelessSessionPatterns: ["private-*"] }, recall: { excludedAgentIds: ["worker"] }, unifiedRetrieval: { enabled: true, relevanceShadow: config } });
  const seed = new Mnemora({ config: settings });
  try { seed.store.upsertMemoryDocument({ title: "Mnemora", content: "Mnemora testing", source: "fixture:memory", scope: "default" }); } finally { seed.close(); }
  const engine = new MnemoraContextEngine(settings, () => new Mnemora({ config: settings, fetcher: async () => { assemblyCalls++; return new Response(JSON.stringify(reply(.01))); } }));
  await engine.assemble({ sessionId: "private-one", prompt: "Mnemora", messages: [{ role: "user", content: "Mnemora" }], tokenBudget: 1000 });
  await engine.assemble({ sessionId: "ordinary", prompt: "Mnemora", messages: [{ role: "user", agentId: "worker", content: "Mnemora" }], tokenBudget: 1000 });
  assert.equal(assemblyCalls, 0);
});
