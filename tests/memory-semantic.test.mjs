import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "@photostructure/sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Mnemora } from "../dist/index.js";
import { createMnemoraContextRef } from "../dist/context/context-ref.js";
import { RecallFeedbackRepository } from "../dist/cognition/reflection.js";

const fixtureEmbedder = {
  async embed(inputs) {
    return {
      identity: { provider: "ollama", model: "fixture-memory", dimensions: 2 },
      vectors: inputs.map(input => /hbm|semiconductor/i.test(input) ? [1, 0] : [0, 1])
    };
  }
};

test("memory chunks are persistent, scope-local, and backfilled resumably", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:", embeddings: { enabled: true, model: "fixture-memory" } }, embedder: fixtureEmbedder });
  try {
    const research = graph.kg_memory({ operation: "store", scope: "research:chips", title: "Packaging constraint", content: "HBM packaging capacity is the present bottleneck." });
    graph.kg_memory({ operation: "store", scope: "personal", title: "Private note", content: "HBM is only mentioned in a private note." });
    graph.kg_memory({ operation: "store", scope: "research:chips", title: "Long note", content: "x".repeat(1900) });

    assert.ok(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_memory_chunks WHERE document_id=?").get(research.id).n >= 1);
    assert.ok(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_memory_chunks WHERE scope='research:chips'").get().n >= 3);

    const first = await graph.kg_memory({ operation: "embed_backfill", scope: "research:chips", limit: 1 });
    assert.equal(first.processed, 1);
    assert.equal(first.embedded, 1);
    assert.match(first.next_after_id, /^memorychunk:/);
    const second = await graph.kg_memory({ operation: "embed_backfill", scope: "research:chips", limit: 100, after_id: first.next_after_id });
    assert.ok(second.embedded >= 1);
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_memory_chunks WHERE scope='personal' AND embedding IS NOT NULL").get().n, 0);
  } finally { graph.close(); }
});

test("semantic memory search and context bridge terminology without leaking scopes", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:", embeddings: { enabled: true, model: "fixture-memory" }, recall: { mode: "semantic" } }, embedder: fixtureEmbedder });
  try {
    graph.kg_memory({ operation: "store", scope: "research:chips", title: "Packaging constraint", content: "HBM packaging capacity is the present bottleneck." });
    graph.kg_memory({ operation: "store", scope: "personal", title: "Private HBM", content: "HBM is only mentioned in a private note." });
    await graph.kg_memory({ operation: "embed_backfill", scope: "research:chips", limit: 100 });
    await graph.kg_memory({ operation: "embed_backfill", scope: "personal", limit: 100 });

    const lexical = graph.kg_memory({ operation: "search", scope: "research:chips", query: "semiconductor supply chain" });
    assert.deepEqual(lexical, []);
    const semantic = await graph.kg_memory({ operation: "search", scope: "research:chips", query: "semiconductor supply chain", mode: "semantic" });
    assert.equal(semantic.length, 1);
    assert.equal(semantic[0].title, "Packaging constraint");
    assert.equal(semantic[0].score_components?.semantic, 1);

    const hidden = await graph.kg_memory({ operation: "search", scope: "personal", query: "semiconductor supply chain", mode: "semantic" });
    assert.equal(hidden.length, 1);
    assert.equal(hidden[0].title, "Private HBM");
    const context = await graph.kg_context("semiconductor supply chain", 5, 1, 0, 600, "semantic", undefined, "research:chips");
    assert.equal(context.nodes.length, 0);
    assert.equal(context.memories?.length, 1);
    assert.equal(context.memories?.[0].title, "Packaging constraint");
  } finally { graph.close(); }
});

test("memory semantic backfill remains inert when embeddings are disabled", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    graph.kg_memory({ operation: "store", content: "A local note about HBM" });
    assert.deepEqual(await graph.kg_memory({ operation: "embed_backfill" }), { processed: 0, embedded: 0, failed: 0, next_after_id: null });
    const hybrid = await graph.kg_memory({ operation: "search", query: "HBM", mode: "hybrid" });
    assert.equal(hybrid.length, 1);
    assert.equal(hybrid[0].score_components?.semantic, 0);
  } finally { graph.close(); }
});

test("hybrid memory retrieval preserves a strong lexical match against a semantic distractor", async () => {
  const graph = new Mnemora({
    config: { dbPath: ":memory:", embeddings: { enabled: true, model: "lexical-floor-fixture" } },
    embedder: {
      async embed(inputs) {
        return {
          identity: { provider: "ollama", model: "lexical-floor-fixture", dimensions: 2 },
          vectors: inputs.map(input => /Lexical evidence/i.test(input) ? [-1, 0] : [1, 0])
        };
      }
    }
  });
  try {
    graph.kg_memory({ operation: "store", title: "Lexical evidence", content: "quarterly cash-flow guidance was explicitly approved" });
    graph.kg_memory({ operation: "store", title: "Semantic distractor", content: "unrelated archive note" });
    await graph.kg_memory({ operation: "embed_backfill", limit: 10 });
    const result = await graph.kg_memory({ operation: "search", query: "quarterly cash-flow guidance", mode: "hybrid", limit: 1 });
    assert.equal(result[0].title, "Lexical evidence");
    assert.equal(result[0].score_components?.lexical, 1);
    assert.equal(result[0].score_components?.semantic, 0);
    assert.equal(result[0].lexical_preservation_score, .92);
  } finally { graph.close(); }
});

test("the default hybrid candidate pool is three times the requested result limit", async () => {
  let request;
  const graph = new Mnemora({
    config: { dbPath: ":memory:", embeddings: { enabled: true, model: "candidate-depth-fixture" }, memory: { retrieval: { reranker: { enabled: true, endpoint: "https://rerank.example.test/rerank" } } } },
    embedder: { async embed(inputs) { return { identity: { provider: "ollama", model: "candidate-depth-fixture", dimensions: 2 }, vectors: inputs.map(() => [1, 0]) }; } },
    fetcher: async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: .1 }, { index: 1, relevance_score: .2 }, { index: 2, relevance_score: .95 }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  try {
    for (const [index, title] of ["First capacity note", "Second capacity note", "Third capacity note"].entries()) graph.kg_memory({ operation: "store", title, content: `capacity outlook source ${index + 1}` });
    const result = await graph.kg_memory({ operation: "search", query: "capacity outlook", mode: "hybrid", limit: 1 });
    assert.equal(JSON.parse(request.body).documents.length, 3);
    assert.equal(result[0].rerank_score, .95);
  } finally { graph.close(); }
});

test("a tag-only semantic request remains a local metadata filter and never embeds the tag", async () => {
  let calls = 0;
  const graph = new Mnemora({
    config: { dbPath: ":memory:", embeddings: { enabled: true, model: "fixture-memory" }, recall: { queryRouting: { enabled: true } } },
    embedder: { async embed(inputs) { calls += inputs.length; return fixtureEmbedder.embed(inputs); } }
  });
  try {
    graph.kg_memory({ operation: "store", title: "Research note", content: "Private packaging note", metadata: { tags: "research" } });
    const result = await graph.kg_memory({ operation: "search", query: "tag:research", mode: "semantic" });
    assert.deepEqual(result.map(item => item.title), ["Research note"]);
    assert.equal(calls, 0);
  } finally { graph.close(); }
});

test("optional memory MMR diversifies only an expanded candidate set while the default remains relevance-only", async () => {
  const seeded = [
    { title: "HBM capacity report", content: "HBM capacity risk packaging capacity constraint" },
    { title: "HBM capacity update", content: "HBM capacity risk packaging capacity constraint update" },
    { title: "HBM supplier note", content: "HBM supplier qualification risk differs by vendor" }
  ];
  const legacy = new Mnemora({ config: { dbPath: ":memory:" } });
  const diversified = new Mnemora({ config: { dbPath: ":memory:", memory: { retrieval: { candidateMultiplier: 3, mmrLambda: .35 } } } });
  try {
    for (const item of seeded) { legacy.kg_memory({ operation: "store", ...item }); diversified.kg_memory({ operation: "store", ...item }); }
    const legacyResult = legacy.kg_memory({ operation: "search", query: "HBM capacity risk", limit: 2, mode: "lexical" });
    const diverseResult = diversified.kg_memory({ operation: "search", query: "HBM capacity risk", limit: 2, mode: "lexical" });
    assert.deepEqual(legacyResult.map(item => item.title), ["HBM capacity report", "HBM capacity update"]);
    assert.equal(diverseResult[0].title, "HBM capacity report");
    assert.equal(diverseResult[1].title, "HBM supplier note");
  } finally { legacy.close(); diversified.close(); }
});

test("an explicitly enabled bounded reranker can reorder hybrid memory candidates and fails open locally", async () => {
  let request;
  const graph = new Mnemora({
    config: { dbPath: ":memory:", memory: { retrieval: { candidateMultiplier: 2, reranker: { enabled: true, endpoint: "https://rerank.example.test/rerank", apiKey: "test-key", model: "fixture", maxQueryChars: 32, maxDocumentChars: 128 } } } },
    fetcher: async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: .1 }, { index: 1, relevance_score: .95 }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  try {
    graph.kg_memory({ operation: "store", title: "First lexical match", content: "HBM capacity outlook first match ".repeat(10) });
    graph.kg_memory({ operation: "store", title: "Second lexical match", content: "HBM capacity outlook second match ".repeat(10) });
    const result = await graph.kg_memory({ operation: "search", query: "HBM capacity outlook".repeat(4), mode: "hybrid", limit: 1 });
    assert.equal(result[0].title, "Second lexical match");
    assert.equal(result[0].rerank_score, .95);
    const body = JSON.parse(request.body);
    assert.equal(body.query.length, 32);
    assert.equal(body.documents.length, 2);
    assert.ok(body.documents.every(document => document.text.length <= 128));
    assert.equal(request.headers.authorization, "Bearer test-key");
  } finally { graph.close(); }
});

test("partial or unchanged reranker responses preserve local ranking and do not expose a synthetic score", async () => {
  let invocation = 0;
  const graph = new Mnemora({
    config: { dbPath: ":memory:", embeddings: { enabled: true, model: "fixture-memory" }, memory: { retrieval: { candidateMultiplier: 2, reranker: { enabled: true, endpoint: "https://rerank.example.test/rerank" } } } },
    embedder: fixtureEmbedder,
    fetcher: async () => new Response(JSON.stringify({ results: invocation++ === 0 ? [{ index: 0, relevance_score: .99 }] : [{ index: 0, relevance_score: .99 }, { index: 1, relevance_score: .01 }] }), { status: 200 })
  });
  try {
    graph.kg_memory({ operation: "store", title: "First local result", content: "HBM capacity outlook first" });
    graph.kg_memory({ operation: "store", title: "Second local result", content: "HBM capacity outlook second" });
    await graph.kg_memory({ operation: "embed_backfill", limit: 10 });
    const partial = await graph.kg_memory({ operation: "search", query: "HBM capacity outlook", mode: "hybrid", limit: 2 });
    assert.deepEqual(partial.map(item => item.title), ["First local result", "Second local result"]); assert.equal(partial.some(item => item.rerank_score !== undefined), false);
    const unchanged = await graph.kg_memory({ operation: "search", query: "HBM capacity outlook", mode: "hybrid", limit: 2 });
    assert.deepEqual(unchanged.map(item => item.title), ["First local result", "Second local result"]); assert.equal(unchanged.some(item => item.rerank_score !== undefined), false);
  } finally { graph.close(); }
});

test("reranker aborts an undeclared oversized stream before buffering its full body", async () => {
  let cancelled = false;
  const graph = new Mnemora({
    config: { dbPath: ":memory:", memory: { retrieval: { candidateMultiplier: 2, reranker: { enabled: true, endpoint: "https://rerank.example.test/rerank" } } } },
    fetcher: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(65_537))); },
      cancel() { cancelled = true; }
    }), { status: 200 })
  });
  try {
    graph.kg_memory({ operation: "store", title: "First local result", content: "HBM capacity outlook first" });
    graph.kg_memory({ operation: "store", title: "Second local result", content: "HBM capacity outlook second" });
    const result = await graph.kg_memory({ operation: "search", query: "HBM capacity outlook", mode: "hybrid", limit: 2 });
    assert.deepEqual(result.map(item => item.title), ["First local result", "Second local result"]);
    assert.equal(result.some(item => item.rerank_score !== undefined), false);
    assert.equal(cancelled, true);
  } finally { graph.close(); }
});

test("optional Weibull aging does not expose a component when it cannot change ordering", () => {
  const legacy = new Mnemora({ config: { dbPath: ":memory:" } });
  const aged = new Mnemora({ config: { dbPath: ":memory:", memory: { retrieval: { aging: { enabled: true, shape: 1, scaleDays: 1, minimumFreshness: .1 } } } } });
  try {
    const first = legacy.kg_memory({ operation: "store", title: "HBM capacity", content: "HBM capacity outlook" });
    const second = aged.kg_memory({ operation: "store", title: "HBM capacity", content: "HBM capacity outlook" });
    aged.store.db.prepare("UPDATE kg_memory_documents SET updated_at=? WHERE id=?").run(Date.now() - 100 * 86_400_000, second.id);
    const baseline = legacy.kg_memory({ operation: "search", query: "HBM capacity" })[0];
    const result = aged.kg_memory({ operation: "search", query: "HBM capacity" })[0];
    assert.equal(baseline.id, first.id);
    assert.equal(baseline.freshness_score, undefined);
    assert.equal(result.freshness_score, undefined);
    assert.ok(result.score < baseline.score * .11);
  } finally { legacy.close(); aged.close(); }
});

test("confirmed feedback closes the memory retrieval loop without mutating memory content", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const baseline = graph.kg_memory({ operation: "store", scope: "research:chips", title: "HBM capacity", content: "HBM capacity outlook" });
    const preferred = graph.kg_memory({ operation: "store", scope: "research:chips", title: "HBM capacity", content: "HBM capacity outlook" });
    graph.store.db.prepare("UPDATE kg_memory_documents SET updated_at=? WHERE id=?").run(Date.now() + 60_000, baseline.id);
    const feedback = new RecallFeedbackRepository(graph.store.db);
    const reference = createMnemoraContextRef({ scope: "research:chips", kind: "memory-document", id: preferred.id });
    assert.equal(feedback.record({ scope: "research:chips", targetRef: reference, kind: "helpful" }).created, true);
    const result = graph.kg_memory({ operation: "search", scope: "research:chips", query: "HBM capacity", limit: 1 });
    assert.equal(result[0].id, preferred.id);
    assert.equal(result[0].feedback_score, undefined);
    assert.equal(graph.store.db.prepare("SELECT content FROM kg_memory_documents WHERE id=?").get(preferred.id).content, "HBM capacity outlook");
  } finally { graph.close(); }
});

test("v1.1 memory documents receive a local chunk index during migration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-memory-migration-"));
  const dbPath = join(directory, "legacy.sqlite");
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE kg_memory_documents (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      source TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', content_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); PRAGMA user_version=11;`);
    legacy.prepare("INSERT INTO kg_memory_documents VALUES(?,?,?,?,?,?,?,?,?)")
      .run("memory:legacy", "research:chips", "Legacy", "HBM capacity note", "memory:legacy", "{}", "a".repeat(64), 1, 1);
    legacy.close();

    const store = new Mnemora({ config: { dbPath } });
    try {
      assert.equal(store.store.db.prepare("SELECT COUNT(*) AS n FROM kg_memory_chunks WHERE document_id='memory:legacy'").get().n, 1);
      assert.equal(store.kg_memory({ operation: "search", scope: "research:chips", query: "HBM" }).length, 1);
      const lifecycle = store.store.db.prepare("SELECT lifecycle_state,archived_at FROM kg_memory_documents WHERE id='memory:legacy'").get();
      assert.equal(lifecycle.lifecycle_state, "active");
      assert.equal(lifecycle.archived_at, null);
    } finally { store.close(); }
  } finally {
    await delay(100);
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
    catch (error) { if (process.platform !== "win32" || error?.code !== "EPERM") throw error; }
  }
});
