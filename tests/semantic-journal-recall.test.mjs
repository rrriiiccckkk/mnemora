import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createTempDir } from "./helpers/temp.mjs";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { normalizeConfig } from "../dist/config.js";
import { Mnemora } from "../dist/tools.js";
import { journalEmbeddingCoverage, searchJournalSemantic } from "../dist/journal/search-index.js";

// Deterministic concept embedder: words map onto a few concept axes, so
// "hiking trails" and "weekend outdoors" are close without sharing a word.
const CONCEPTS = [
  ["hike", "hiking", "trail", "trails", "mountain", "outdoors", "outdoor", "weekend", "nature"],
  ["salary", "pay", "money", "budget", "price", "cost"],
  ["code", "function", "python", "bug", "test", "compile"],
  ["food", "allergy", "allergic", "peanut", "peanuts", "restaurant", "dinner"]
];
function vectorFor(text) {
  const vector = CONCEPTS.map(() => 0).concat([0.05]);
  for (const word of String(text).toLowerCase().match(/[a-z]+/g) ?? []) CONCEPTS.forEach((words, axis) => { if (words.includes(word)) vector[axis] += 1; });
  return vector;
}
function fakeEmbedder(calls = { count: 0 }, fail = false) {
  return { calls, async embed(inputs) { calls.count += inputs.length; if (fail) throw new Error("provider down"); return { identity: { provider: "ollama", model: "concepts", dimensions: CONCEPTS.length + 1 }, vectors: inputs.map(vectorFor).map(vector => { const norm = Math.hypot(...vector); return vector.map(value => value / norm); }) }; } };
}
function setup({ embeddings = true, embedder = fakeEmbedder(), semantic = {} } = {}) {
  const directory = createTempDir("semantic-journal-");
  const config = normalizeConfig({ dbPath: join(directory, "m.db"), mode: "standalone", conversationJournal: { enabled: true }, contextEngine: { enabled: true }, embeddings: { enabled: embeddings, provider: "ollama", model: "concepts" }, unifiedRetrieval: { enabled: true, shadowMode: false, tokenBudget: 800, maxItems: 8, semantic: { minSimilarity: .8, ...semantic } } });
  const graph = new Mnemora({ config, embedder });
  const shared = new Proxy(graph, { get: (target, property) => property === "close" ? () => undefined : Reflect.get(target, property, target) });
  return { graph, config, engine: new MnemoraContextEngine(config, () => shared), close: () => graph.close() };
}
const ask = async (engine, prompt) => (await engine.assemble({ sessionId: "query-session", prompt, messages: [{ role: "user", content: prompt }], tokenBudget: 16000 })).systemPromptAddition ?? "";
const identity = { provider: "ollama", model: "concepts", dimensions: CONCEPTS.length + 1 };

test("semantic recall defaults: on with embeddings, bounded scan and per-turn work", () => {
  const { semantic } = normalizeConfig({}).unifiedRetrieval;
  assert.deepEqual(semantic, { enabled: true, minSimilarity: .45, gateSimilarity: .2, maxScanChunks: 50000, embedPerTurn: 128 });
  assert.equal(normalizeConfig({ unifiedRetrieval: { semantic: { maxScanChunks: 1, embedPerTurn: 99999 } } }).unifiedRetrieval.semantic.maxScanChunks, 100);
  assert.equal(normalizeConfig({ unifiedRetrieval: { semantic: { embedPerTurn: 99999 } } }).unifiedRetrieval.semantic.embedPerTurn, 1000);
});

test("captured turns are embedded and a paraphrased question recalls them without shared words", async () => {
  const { graph, engine, close } = setup();
  try {
    await engine.ingestBatch({ sessionId: "pref", messages: [{ role: "user", content: "I really love hiking on mountain trails." }] });
    await engine.ingestBatch({ sessionId: "other", messages: [{ role: "user", content: "The python function fails its unit test." }] });
    const coverage = journalEmbeddingCoverage(graph.store.db, identity);
    assert.equal(coverage.embedded, coverage.chunks);
    const rendered = await ask(engine, "Any suggestions for this weekend outdoors?");
    assert.match(rendered, /hiking on mountain trails/u);
    assert.doesNotMatch(rendered, /python function/u);
  } finally { close(); }
});

test("without embeddings the same paraphrase attaches nothing and no provider is called", async () => {
  const calls = { count: 0 };
  const { engine, close } = setup({ embeddings: false, embedder: undefined });
  try {
    await engine.ingestBatch({ sessionId: "pref", messages: [{ role: "user", content: "I really love hiking on mountain trails." }] });
    assert.equal(await ask(engine, "Any suggestions for this weekend outdoors?"), "");
    assert.equal(calls.count, 0);
  } finally { close(); }
});

test("an embedder failure leaves capture and lexical recall intact", async () => {
  const { engine, close } = setup({ embedder: fakeEmbedder({ count: 0 }, true) });
  try {
    const result = await engine.ingestBatch({ sessionId: "s", messages: [{ role: "user", content: "My locker code is 4417 at the gym." }] });
    assert.equal(result.ingestedCount, 1);
    assert.match(await ask(engine, "What is my gym locker code?"), /4417/u);
  } finally { close(); }
});

test("semantic hits respect the similarity floor", async () => {
  const { engine, close } = setup({ semantic: { minSimilarity: .999 } });
  try {
    await engine.ingestBatch({ sessionId: "pref", messages: [{ role: "user", content: "I really love hiking on mountain trails, also budget matters." }] });
    assert.equal(await ask(engine, "Any suggestions for this weekend outdoors?"), "");
  } finally { close(); }
});

test("vectors never cross scopes and are purged with forgotten or redacted events", async () => {
  const { graph, engine, close } = setup();
  try {
    await engine.ingestBatch({ sessionId: "agent:alice:main", messages: [{ role: "user", content: "My salary and pay budget are private." }] });
    await engine.ingestBatch({ sessionId: "agent:bob:main", messages: [{ role: "user", content: "I enjoy hiking trails." }] });
    const db = graph.store.db;
    const query = vectorFor("money cost"); const norm = Math.hypot(...query);
    const vector = query.map(value => value / norm);
    assert.equal(searchJournalSemantic(db, { scope: "agent:bob", identity, vector, limit: 5, maxScan: 1000, minSimilarity: .5 }).length, 0);
    assert.equal(searchJournalSemantic(db, { scope: "agent:alice", identity, vector, limit: 5, maxScan: 1000, minSimilarity: .5 }).length, 1);
    const before = db.prepare("SELECT count(*) n FROM mnemora_conversation_event_chunks_embeddings").get().n;
    db.prepare("UPDATE mnemora_conversation_events SET deleted_at=? WHERE scope='agent:alice'").run(Date.now());
    const after = db.prepare("SELECT count(*) n FROM mnemora_conversation_event_chunks_embeddings").get().n;
    assert.ok(after < before);
    assert.equal(searchJournalSemantic(db, { scope: "agent:alice", identity, vector, limit: 5, maxScan: 1000, minSimilarity: .5 }).length, 0);
  } finally { close(); }
});

test("a lexical hit outside the semantic neighbourhood is not attached; an unembedded one is", async () => {
  const { graph, engine, close } = setup({ semantic: { gateSimilarity: .8 } });
  try {
    await engine.ingestBatch({ sessionId: "code", messages: [{ role: "user", content: "The weekend python function compile bug again." }] });
    // Shares "weekend" with the prompt but is about code, not the outdoors.
    assert.equal(await ask(engine, "Any suggestions for this weekend outdoors?"), "");
    graph.store.db.exec("DELETE FROM mnemora_conversation_event_chunks_embeddings");
    assert.match(await ask(engine, "Any suggestions for this weekend outdoors?"), /python function/u);
  } finally { close(); }
});

test("embedding backlog is bounded per turn and resumable", async () => {
  const calls = { count: 0 };
  const { graph, engine, close } = setup({ embedder: fakeEmbedder(calls), semantic: { embedPerTurn: 2 } });
  try {
    await engine.ingestBatch({ sessionId: "s", messages: Array.from({ length: 6 }, (_, index) => ({ role: "user", content: `Trail note ${index}: mountain hiking.` })) });
    assert.equal(calls.count, 2);
    let coverage = journalEmbeddingCoverage(graph.store.db, identity);
    assert.equal(coverage.embedded, 2);
    const result = await graph.embedJournalChunks({ limit: 100 });
    assert.equal(result.embedded, coverage.chunks - 2);
    coverage = journalEmbeddingCoverage(graph.store.db, identity);
    assert.equal(coverage.embedded, coverage.chunks);
  } finally { close(); }
});

test("journal embed CLI requires a model and rejects unknown options", async () => {
  const { spawnSync } = await import("node:child_process");
  const database = join(createTempDir("semantic-cli-"), "m.db");
  const run = (...args) => spawnSync(process.execPath, ["dist/cli.js", "journal", "embed", ...args], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, MNEMORA_DB: database, MNEMORA_EMBED_MODEL: "" } });
  for (const args of [[], ["--model"], ["--model", "m", "--bogus", "x"], ["--model", "m", "extra"]]) {
    const result = run(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /invalid_arguments/u);
  }
});
