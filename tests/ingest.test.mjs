import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Mnemora } from "../dist/tools.js";
import { GraphologyStore } from "../dist/store.js";

function createGraph(options = {}) {
  const tmpRoot = join(process.cwd(), ".tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, "ingest-test-"));
  const graph = new Mnemora({
    ...options,
    config: { dbPath: join(dir, "kg.db"), ...options.config },
    extractor: options.extractor ?? {
      async extract() {
        return {
          entities: [
            { name: "Murata", type: "company", description: "MLCC supplier", aliases: ["Murata Manufacturing"], confidence: 0.95, evidence_span: "Murata supplies MLCC to Huawei" },
            { name: "MLCC", type: "product", description: "multilayer ceramic capacitor", aliases: [], confidence: 0.95, evidence_span: "Murata supplies MLCC to Huawei" },
            { name: "Huawei", type: "company", description: "customer", aliases: ["Huawei Technologies"], confidence: 0.95, evidence_span: "Murata supplies MLCC to Huawei" }
          ],
          relations: [
            { source: "Murata", target: "MLCC", type: "supplies_product", confidence: 0.9, evidence_span: "Murata supplies MLCC", edge_props: { product_category: "component" } },
            { source: "MLCC", target: "Huawei", type: "supplied_to", confidence: 0.88, evidence_span: "MLCC to Huawei", edge_props: {} }
          ]
        };
      }
    }
  });
  return graph;
}

test("kg_ingest persists searchable and traversable graph data", async () => {
  const graph = createGraph();
  try {
    const ingest = await graph.kg_ingest("Murata supplies MLCC to Huawei", "fixture:mlcc");
    assert.equal(ingest.entities.length, 3);
    assert.equal(ingest.relations.length, 2);

    const search = await graph.kg_search("Murata Manufacturing");
    assert.equal(search[0].node.name, "Murata");
    assert.equal(search[0].evidence[0].source, "fixture:mlcc");

    const related = graph.kg_related("MLCC", 1, ["supplies_product"], "in");
    assert.equal(related.root.name, "MLCC");
    assert.equal(related.edges.length, 0);
    assert.equal(related.semantic_labels.length, 1);
    assert.equal(related.semantic_labels[0].source.name, "Murata");
    assert.equal(related.semantic_labels[0].evidence[0].quote, "Murata supplies MLCC");

    const stats = graph.kg_stats();
    assert.equal(stats.nodes.total, 3);
    assert.equal(stats.edges.total, 2);
    assert.equal(stats.observations.total, 5);
  } finally {
    graph.close();
  }
});

test("ingested leading-hyphen slugs remain ambiguous candidates and support canonical retry", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const ingested = graph.store.ingest([
      { name: "-Acme Alpha", type: "company", confidence: .9, evidence_span: "alpha" },
      { name: "--Acme Beta", type: "company", confidence: .9, evidence_span: "beta" },
      { name: "TSMC", type: "company", confidence: .9, evidence_span: "right" }
    ], [], "fixture:leading-hyphen");
    assert.deepEqual(ingested.entities.map(item => item.node.id), ["company:-acme-alpha", "company:--acme-beta", "company:tsmc"]);
    graph.kg_search = async () => [];

    let candidates;
    await assert.rejects(graph.kg_compare({ left: "-", right: "company:tsmc" }), error => {
      candidates = error.public?.details?.candidates;
      assert.deepEqual(candidates?.map(candidate => candidate.id), ["company:--acme-beta", "company:-acme-alpha"]);
      return true;
    });
    const retried = await graph.kg_compare({ left: candidates[0].id, right: "company:tsmc" });
    assert.deepEqual(retried.subjects.map(subject => subject.id), ["company:--acme-beta", "company:tsmc"]);
  } finally { graph.close(); }
});

test("ingest embeds changed nodes after graph persistence and survives provider failure", async () => {
  const graph = createGraph({ embedder: { embed: async () => { throw new Error("offline"); } } });
  try {
    const result = await graph.kg_ingest("Murata supplies MLCC to Huawei", "fixture");
    assert.equal(result.entities.length, 3);
    assert.equal(graph.store.getEmbedding(result.entities[0].node.id), undefined);
  } finally { graph.close(); }
});

test("backfill resumes from a stable node id cursor and skips fresh vectors", async () => {
  const graph = createGraph({ config: { embeddings: { enabled: true, model: "tiny" } }, embedder: { embed: async (inputs) => ({ identity: { provider: "ollama", model: "tiny", dimensions: 2 }, vectors: inputs.map(() => [1, 0]) }) } });
  try {
    await graph.kg_ingest("Murata supplies MLCC to Huawei", "fixture");
    graph.store.db.prepare("UPDATE kg_nodes SET embedding=NULL").run();
    const first = await graph.kg_embed_backfill(2);
    assert.deepEqual({ processed: first.processed, embedded: first.embedded, failed: first.failed }, { processed: 2, embedded: 2, failed: 0 });
    const second = await graph.kg_embed_backfill(2, first.next_after_id);
    assert.equal(second.processed, 1);
    assert.equal((await graph.kg_embed_backfill()).processed, 0);
  } finally { graph.close(); }
});

test("embedding batches receive an aborting timeout signal", async () => {
  let seen;
  const graph = createGraph({ config: { embeddings: { enabled: true, timeoutMs: 5 } }, embedder: { embed(_inputs, signal) { seen = signal; return new Promise(() => {}); } } });
  try { await graph.kg_ingest("x", "fixture"); assert.equal(seen.aborted, true); }
  finally { graph.close(); }
});

test("document inputs are truncated before embedding and backfill resumes at the failed batch", async () => {
  const calls = []; let fail = true;
  const embedder = { async embed(inputs) { calls.push(inputs); if (fail && calls.length === 2) throw new Error("offline"); return { identity: { provider: "ollama", model: "tiny", dimensions: 2 }, vectors: inputs.map(() => [1, 0]) }; } };
  const graph = createGraph({ config: { embeddings: { enabled: true, model: "tiny", batchSize: 1, maxInputChars: 256 } }, embedder });
  try {
    await graph.kg_ingest("x", "fixture"); graph.store.db.prepare("UPDATE kg_nodes SET embedding=NULL").run(); calls.length = 0;
    const first = await graph.kg_embed_backfill(3); assert.equal(first.next_after_id, "company:huawei");
    fail = false; const second = await graph.kg_embed_backfill(3, first.next_after_id);
    assert.equal(second.embedded, 2); assert.equal(graph.store.listStaleEmbeddingNodes({ provider: "ollama", model: "tiny" }, "node-v1").length, 0);
    assert.equal(calls.flat().every(input => input.length <= 256), true);
  } finally { graph.close(); }
});

for (const batchSize of [0, -2]) test(`invalid embedding batch size ${batchSize} is made finite`, async () => {
  const calls = [];
  const graph = createGraph({
    config: { embeddings: { enabled: true, batchSize } },
    embedder: { embed: async (inputs) => { calls.push(inputs.length); return { identity: { provider: "ollama", model: "qwen3-embedding:4b", dimensions: 2 }, vectors: inputs.map(() => [1, 0]) }; } }
  });
  try {
    assert.equal(graph.config.embeddings.batchSize >= 1, true);
    await graph.kg_ingest("Murata supplies MLCC to Huawei", "fixture");
    assert.equal(calls.length > 0 && calls.length <= 3, true);
  } finally { graph.close(); }
});

for (const extra of [-1, 1]) test(`embedding vector count mismatch ${extra < 0 ? "short" : "oversized"} writes no partial batch`, async () => {
  const graph = createGraph({ embedder: { embed: async (inputs) => ({ identity: { provider: "ollama", model: "qwen3-embedding:4b", dimensions: 2 }, vectors: Array.from({ length: inputs.length + extra }, () => [1, 0]) }) } });
  try {
    const result = await graph.kg_ingest("Murata supplies MLCC to Huawei", "fixture");
    assert.equal(result.entities.every(({ node }) => graph.store.getEmbedding(node.id) === undefined), true);
  } finally { graph.close(); }
});

test("kg_context returns compact evidence-backed context and source summaries", async () => {
  const graph = createGraph();
  try {
    await graph.kg_ingest("Murata supplies MLCC to Huawei", "fixture:mlcc");
    const context = await graph.kg_context("Who supplies MLCC to Huawei?", 5, 1, 0.8, 500);

    assert.match(context.context, /Knowledge graph context/);
    assert.match(context.context, /Murata/);
    assert.match(context.context, /supplies_product/);
    assert.equal(context.nodes.length >= 1, true);
    assert.equal(context.edges.length, 0);
    assert.equal(context.semantic_labels.length >= 1, true);
    assert.deepEqual(context.sources.map((source) => source.source), ["fixture:mlcc"]);
    assert.equal(context.sources[0].observations, 5);

    const sources = graph.kg_sources();
    assert.equal(sources.length, 1);
    assert.equal(sources[0].source, "fixture:mlcc");
    assert.equal(sources[0].observations, 5);
  } finally {
    graph.close();
  }
});

test("manual ingestion applies extraction input and timeout bounds", async () => {
  let received = "", aborted = false;
  const graph = createGraph({
    config: { extraction: { maxInputChars: 1000, timeoutMs: 1000 } },
    extractor: { extract(text, _source, options) {
      received = text;
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => {
        aborted = true; reject(new Error("aborted"));
      }, { once:true }));
    } }
  });
  try {
    graph.config.extraction.timeoutMs = 20;
    const result = await graph.ingestItem({ text:"x".repeat(2000), source:"manual:test" });
    assert.equal(received.length,1000);
    assert.equal(aborted,true);
    assert.equal(result.status,"failed");
    assert.equal(result.error.category,"extraction_failed");
  } finally { graph.close(); }
});

test("extraction.enabled stops model-backed ingestion with an explicit result", async () => {
  let calls = 0;
  const graph = createGraph({
    config: { extraction: { enabled: false } },
    extractor: { async extract() { calls++; return { entities: [], relations: [] }; } }
  });
  try {
    const result = await graph.ingestItem({ text: "do not extract", source: "fixture:disabled" });
    assert.deepEqual(result.error, { category: "extraction_disabled", summary: "extraction disabled" });
    assert.equal(calls, 0);
    await assert.rejects(graph.kg_ingest("do not extract", "fixture:disabled"), /extraction_disabled/);
  } finally { graph.close(); }
});

test("ingestOnce preserves observation counts for a duplicate source", () => {
  const tmpRoot = join(process.cwd(), ".tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, "ingest-once-test-"));
  const store = new GraphologyStore(join(dir, "kg.db"));
  const entities = [
    { name: "Murata", type: "company", confidence: 0.95, evidence_span: "Murata supplies MLCC" }
  ];
  try {
    assert.equal(store.ingestOnce(entities, [], "session:s1:turn:r1").skipped, false);
    const before = store.stats().observations.total;
    assert.equal(store.ingestOnce(entities, [], "session:s1:turn:r1").skipped, true);
    assert.equal(store.stats().observations.total, before);
  } finally {
    store.close();
  }
});
