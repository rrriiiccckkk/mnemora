import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Mnemora } from "../dist/tools.js";

const entities = [
  { name: "硅晶圆", type: "product", description: "semiconductor wafer upstream material", aliases: [], confidence: .9, evidence_span: "wafer" },
  { name: "先进封装", type: "technology", description: "advanced semiconductor packaging upstream", aliases: [], confidence: .8, evidence_span: "packaging" },
  { name: "HBM", type: "product", description: "high bandwidth memory semiconductor upstream", aliases: [], confidence: .7, evidence_span: "memory" },
  { name: "Murata", type: "company", description: "components", aliases: [], confidence: .95, evidence_span: "Murata" }
];
const vectors = new Map([["硅晶圆", [1, 0]], ["先进封装", [.9, .1]], ["HBM", [.8, .2]], ["Murata", [0, 1]], ["半导体上游", [1, 0]]]);

function graphWith(embedder) {
  mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), ".tmp", "hybrid-"));
  return new Mnemora({
    config: { dbPath: join(dir, "kg.db"), embeddings: { enabled: true, model: "fake" } },
    embedder,
    extractor: { async extract() { return { entities, relations: [] }; } }
  });
}

const fake = { async embed(inputs) { return { identity: { provider: "ollama", model: "fake", dimensions: 2 }, vectors: inputs.map(input => input === "semantic-only-query" ? [.8, .2] : vectors.get(input.match(/^name: (.+)$/m)?.[1]) ?? vectors.get(input) ?? [0, 1]) }; } };

test("hybrid search finds cross-term Chinese concepts lexical search misses", async () => {
  const graph = graphWith(fake);
  try {
    await graph.kg_ingest("fixture", "fixture");
    assert.deepEqual((await graph.kg_search("半导体上游", undefined, 5, "lexical")).map(x => x.node.name), []);
    const hybrid = await graph.kg_search("半导体上游", undefined, 5, "hybrid");
    assert.deepEqual(hybrid.slice(0, 3).map(x => x.node.name), ["硅晶圆", "先进封装", "HBM"]);
    assert.deepEqual(Object.keys(hybrid[0].score_components), ["semantic", "lexical", "confidence", "freshness"]);
    assert.deepEqual(Object.keys(hybrid[0].rank_components), ["semantic", "lexical", "confidence", "recency", "source_diversity", "ppr"]);
    assert.deepEqual(Object.keys(hybrid[0].penalties), ["conflict", "hub"]);
  } finally { graph.close(); }
});

test("hybrid mode falls back to exact lexical results when query embedding fails", async () => {
  const graph = graphWith({ async embed(inputs) { if (inputs.length === 1 && inputs[0] === "Murata") throw new Error("offline"); return fake.embed(inputs); } });
  try {
    await graph.kg_ingest("fixture", "fixture");
    const results = await graph.kg_search("Murata", undefined, 5, "hybrid");
    assert.equal(results[0].node.name, "Murata");
    assert.equal(results[0].score_components.lexical, 1);
  } finally { graph.close(); }
});

test("kg_context uses hybrid seeds but preserves evidence threshold and budget", async () => {
  const graph = graphWith(fake);
  try {
    graph.store.ingest(entities, [
      { source: "HBM", target: "Murata", type: "supplied_to", confidence: .9, evidence_span: "HBM supplied to Murata" },
      { source: "HBM", target: entities[0].name, type: "depends_on", confidence: .7, evidence_span: "weak evidence" }
    ], "fixture");
    for (const node of graph.store.search("HBM", undefined, 5).map(result => result.node)) {
      graph.store.putEmbedding(node.id, { provider: "ollama", model: "fake", dimensions: 2 }, "node-v1", vectors.get(node.name));
    }
    const result = await graph.kg_context("semantic-only-query", 5, 1, .8, 300, "hybrid");
    assert.match(result.context, /HBM/);
    assert.equal(result.edges.every(edge => edge.evidence.every(evidence => evidence.confidence >= .8)), true);
    assert.equal(result.context.length <= 1200, true);
  } finally { graph.close(); }
});

test("semantic mode reports provider and bounded-scale errors", async () => {
  const offline = graphWith({ async embed() { throw new Error("offline"); } });
  try { await assert.rejects(offline.kg_search("anything", undefined, 5, "semantic"), /semantic search unavailable: provider/); } finally { offline.close(); }

  const bounded = graphWith(fake);
  try {
    await bounded.kg_ingest("fixture", "fixture");
    bounded.config.embeddings.maxVectorScanNodes = 3;
    await assert.rejects(bounded.kg_search("半导体上游", undefined, 5, "semantic"), /scale|limit/i);
    const fallback = await bounded.kg_search("Murata", undefined, 5, "hybrid");
    assert.equal(fallback[0].node.name, "Murata");
    assert.equal(fallback[0].score_components.lexical, 1);
  } finally { bounded.close(); }
});

test("semantic candidates require exact identity and input version", () => {
  const graph = graphWith(fake);
  try {
    graph.store.ingest(entities, [], "fixture");
    const nodes = graph.store.db.prepare("SELECT id, name FROM kg_nodes ORDER BY name").all();
    const murata = nodes.find(node => node.name === "Murata").id;
    const hbm = nodes.find(node => node.name === "HBM").id;
    const packaging = nodes.find(node => node.name === entities[1].name).id;
    graph.store.putEmbedding(murata, { provider: "ollama", model: "fake", dimensions: 2 }, "node-v1", [1, 0]);
    graph.store.putEmbedding(hbm, { provider: "ollama", model: "other", dimensions: 2 }, "node-v1", [1, 0]);
    graph.store.putEmbedding(packaging, { provider: "other", model: "fake", dimensions: 2 }, "node-v1", [1, 0]);
    assert.deepEqual(graph.store.semanticCandidates([1, 0], { provider: "ollama", model: "fake", dimensions: 2 }, "node-v1", undefined, 10).map(x => x.node.name), ["Murata"]);
    assert.deepEqual(graph.store.semanticCandidates([1, 0], { provider: "ollama", model: "fake", dimensions: 3 }, "node-v1", undefined, 10), []);
    assert.deepEqual(graph.store.semanticCandidates([1, 0], { provider: "ollama", model: "fake", dimensions: 2 }, "node-v2", undefined, 10), []);
  } finally { graph.close(); }
});

test("quality weights use observable numeric rank components exactly", async () => {
  const graph = graphWith(fake);
  try {
    await graph.kg_ingest("fixture", "fixture");
    graph.config.quality.rankingWeights = { semantic: .1, lexical: .2, confidence: .3, recency: .4, sourceDiversity: 0, ppr: 0 };
    const result = (await graph.kg_search("Murata", undefined, 5, "hybrid"))[0];
    const c = result.rank_components;
    const positive = .1 * c.semantic + .2 * c.lexical + .3 * c.confidence + .4 * c.recency;
    assert.ok(Math.abs(result.score - positive * result.penalties.conflict * result.penalties.hub) < 1e-12);
  } finally { graph.close(); }
});

test("semantic minimum filters weak similarity", async () => {
  const graph = graphWith(fake);
  try {
    await graph.kg_ingest("fixture", "fixture");
    graph.config.recall.semanticMinScore = .99;
    assert.deepEqual((await graph.kg_search("Murata", undefined, 5, "semantic")).map(x => x.node.name), ["Murata"]);
  } finally { graph.close(); }
});

test("semantic scan reads at most max(limit times eight, 64) vectors", () => {
  const graph = graphWith(fake);
  try {
    const many = Array.from({ length: 70 }, (_, i) => ({ name: `Node ${String(i).padStart(2, "0")}`, type: "concept", description: "", aliases: [], confidence: 1, evidence_span: "x" }));
    const ingested = graph.store.ingest(many, [], "fixture");
    for (const { node } of ingested.entities) graph.store.putEmbedding(node.id, { provider: "ollama", model: "fake", dimensions: 2 }, "node-v1", node.name === "Node 69" ? [1, 0] : [0, 1]);
    const results = graph.store.semanticCandidates([1, 0], { provider: "ollama", model: "fake", dimensions: 2 }, "node-v1", undefined, 1, .9);
    assert.deepEqual(results, []);
  } finally { graph.close(); }
});

test("hybrid retains an exact lexical match amid semantic competition", async () => {
  const graph = graphWith(fake);
  try {
    await graph.kg_ingest("fixture", "fixture");
    const results = await graph.kg_search("Murata", undefined, 4, "hybrid");
    assert.equal(results.some(x => x.node.name === "Murata" && x.score_components.lexical === 1), true);
  } finally { graph.close(); }
});

test("query vector dimension mismatch is bounded in semantic and fail-open in hybrid", async () => {
  const graph = graphWith({ async embed(inputs) { if (inputs.length === 1 && inputs[0] === "Murata") return { identity: { provider: "ollama", model: "fake", dimensions: 3 }, vectors: [[1, 0]] }; return fake.embed(inputs); } });
  try {
    await graph.kg_ingest("fixture", "fixture");
    await assert.rejects(graph.kg_search("Murata", undefined, 5, "semantic"), /semantic search unavailable: invalid_response/);
    assert.equal((await graph.kg_search("Murata", undefined, 5, "hybrid"))[0].node.name, "Murata");
  } finally { graph.close(); }
});

test("node type filtering happens before the bounded semantic candidate limit", async () => {
  const graph = graphWith({ async embed() { return { identity: { provider: "ollama", model: "fake", dimensions: 2 }, vectors: [[1, 0]] }; } });
  try {
    const earlier = Array.from({ length: 70 }, (_, i) => ({ name: `Alpha ${String(i).padStart(2, "0")}`, type: "company", description: "", aliases: [], confidence: 1, evidence_span: "x" }));
    const target = { name: "Requested Target", type: "technology", description: "semantic-only", aliases: [], confidence: 1, evidence_span: "target" };
    const ingested = graph.store.ingest([...earlier, target], [], "fixture");
    for (const { node } of ingested.entities) graph.store.putEmbedding(node.id, { provider: "ollama", model: "fake", dimensions: 2 }, "node-v1", node.type === "technology" ? [1, 0] : [0, 1]);
    assert.deepEqual((await graph.kg_search("needle", "technology", 1, "semantic")).map(x => x.node.name), ["Requested Target"]);
    assert.deepEqual((await graph.kg_search("needle", "technology", 1, "hybrid")).map(x => x.node.name), ["Requested Target"]);
  } finally { graph.close(); }
});

test("identical queries reuse one embedding and LRU eviction is bounded", async () => {
  const calls = [];
  const graph = graphWith({ async embed(inputs) { calls.push(inputs[0]); return fake.embed(inputs); } });
  try {
    graph.config.embeddings.queryCacheSize = 1;
    await graph.kg_search("Murata", undefined, 5, "hybrid");
    await graph.kg_search("Murata", undefined, 5, "hybrid");
    await graph.kg_search("HBM", undefined, 5, "hybrid");
    await graph.kg_search("Murata", undefined, 5, "hybrid");
    assert.deepEqual(calls, ["Murata", "HBM", "Murata"]);
  } finally { graph.close(); }
});

test("query truncation is exact, Unicode-safe by JS code units, and keys the sent text", async () => {
  const calls = []; const graph = graphWith({ async embed(inputs) { calls.push(inputs[0]); return fake.embed(["Murata"]); } });
  try { graph.config.embeddings.maxInputChars = 256; const prefix = "😀".repeat(128); await graph.kg_search(prefix + "A"); await graph.kg_search(prefix + "B"); assert.deepEqual(calls, [prefix]); }
  finally { graph.close(); }
});

test("corrupt prefix larger than one window does not starve valid semantic candidates", () => {
  const graph = graphWith(fake);
  try { const ingested = graph.store.ingest(Array.from({length: 70}, (_, i) => ({ name: `A${String(i).padStart(2,"0")}`, type:"concept", description:"", aliases:[], confidence:1, evidence_span:"x" })).concat({name:"Z valid",type:"concept",description:"",aliases:[],confidence:1,evidence_span:"x"}), [], "fixture"); for (const {node} of ingested.entities) graph.store.putEmbedding(node.id,{provider:"ollama",model:"fake",dimensions:2},"node-v1",[1,0]); graph.store.db.prepare("UPDATE kg_nodes SET embedding=? WHERE id < 'concept:z-valid'").run(new Uint8Array([1])); assert.deepEqual(graph.store.semanticCandidates([1,0],{provider:"ollama",model:"fake",dimensions:2},"node-v1",undefined,1,.9,100).map(x=>x.node.name), ["Z valid"]); }
  finally { graph.close(); }
});

test("timeout aborts the exact provider request and hybrid falls back", async () => {
  let signal;
  const graph = graphWith({ embed(_inputs, requestSignal) { signal = requestSignal; return new Promise(() => {}); } });
  try {
    graph.config.embeddings.timeoutMs = 5;
    graph.store.ingest([entities[3]], [], "fixture");
    const results = await graph.kg_search("Murata", undefined, 5, "hybrid");
    assert.equal(signal.aborted, true);
    assert.equal(results[0].node.name, "Murata");
  } finally { graph.close(); }
});

test("corrupted vectors are isolated and semantic errors are categorized", async () => {
  const graph = graphWith(fake);
  try {
    await graph.kg_ingest("fixture", "fixture");
    graph.store.db.prepare("UPDATE kg_nodes SET embedding=? WHERE name=?").run(new Uint8Array([1]), "Murata");
    assert.ok((await graph.kg_search("HBM", undefined, 5, "semantic")).length > 0);
  } finally { graph.close(); }
  const offline = graphWith({ async embed() { throw new Error("secret node content"); } });
  try { await assert.rejects(offline.kg_search("private query", undefined, 5, "semantic"), /semantic search unavailable: provider$/); }
  finally { offline.close(); }
});

test("query vectors are normalized before caching and invalid vectors are never cached", async () => {
  let calls = 0;
  const graph = graphWith({ async embed() { calls++; return { identity: { provider: "ollama", model: "fake", dimensions: 2 }, vectors: [calls === 1 ? [3, 4] : [0, 0]] }; } });
  try {
    graph.store.ingest([entities[3]], [], "fixture");
    graph.store.putEmbedding(graph.store.search("Murata")[0].node.id, { provider: "ollama", model: "fake", dimensions: 2 }, "node-v1", [.6, .8]);
    assert.ok(Math.abs((await graph.kg_search("scaled", undefined, 1, "semantic"))[0].score_components.semantic - 1) < 1e-12);
    await graph.kg_search("scaled", undefined, 1, "semantic");
    assert.equal(calls, 1);
    await assert.rejects(graph.kg_search("bad", undefined, 1, "semantic"), /invalid_response/);
    await assert.rejects(graph.kg_search("bad", undefined, 1, "semantic"), /invalid_response/);
    assert.equal(calls, 3);
  } finally { graph.close(); }
});

test("zero-sized cache disables reuse", async () => {
  let calls = 0;
  const graph = graphWith({ async embed(inputs) { calls++; return fake.embed(inputs); } });
  try { graph.config.embeddings.queryCacheSize = 0; await graph.kg_search("Murata"); await graph.kg_search("Murata"); assert.equal(calls, 2); }
  finally { graph.close(); }
});

test("zero and NaN query vectors are rejected and provider rejection is retried", async () => {
  const calls = new Map();
  const graph = graphWith({ async embed([query]) {
    calls.set(query, (calls.get(query) ?? 0) + 1);
    if (query === "zero") return { identity: { provider: "ollama", model: "fake", dimensions: 2 }, vectors: [[0, 0]] };
    if (query === "nan") return { identity: { provider: "ollama", model: "fake", dimensions: 2 }, vectors: [[NaN, 1]] };
    if (calls.get(query) === 1) throw new Error("offline secret");
    return { identity: { provider: "ollama", model: "fake", dimensions: 2 }, vectors: [[1, 0]] };
  } });
  try {
    await assert.rejects(graph.kg_search("zero", undefined, 1, "semantic"), /invalid_response/);
    await assert.rejects(graph.kg_search("nan", undefined, 1, "semantic"), /invalid_response/);
    await assert.rejects(graph.kg_search("retry", undefined, 1, "semantic"), /provider/);
    await graph.kg_search("retry", undefined, 1, "semantic");
    assert.equal(calls.get("retry"), 2);
  } finally { graph.close(); }
});

test("caller cancellation aborts exact request, including already-aborted signals", async () => {
  const seen = [];
  const graph = graphWith({ embed(_inputs, signal) { seen.push(signal); return new Promise(() => {}); } });
  try {
    const pre = new AbortController(); pre.abort(new Error("shutdown"));
    await assert.rejects(graph.kg_search("pre", undefined, 1, "semantic", pre.signal), /aborted/);
    assert.equal(seen[0].aborted, true);
    const later = new AbortController();
    const pending = graph.kg_search("later", undefined, 1, "semantic", later.signal);
    later.abort(new Error("shutdown"));
    await assert.rejects(pending, /aborted/);
    assert.equal(seen[1].aborted, true);
  } finally { graph.close(); }
});

test("provider and model identity mismatch is categorized and hybrid falls back", async () => {
  const graph = graphWith({ async embed() { return { identity: { provider: "other", model: "secret-model", dimensions: 2 }, vectors: [[1, 0]] }; } });
  try {
    graph.store.ingest([entities[3]], [], "fixture");
    await assert.rejects(graph.kg_search("private", undefined, 1, "semantic"), /invalid_response/);
    assert.equal((await graph.kg_search("Murata", undefined, 1, "hybrid"))[0].node.name, "Murata");
  } finally { graph.close(); }
});

test("hybrid PPR is numeric, bypassable, and graph failures fail open", async () => {
  const graph = graphWith(fake);
  try {
    await graph.kg_ingest("fixture", "fixture");
    const ranked = await graph.kg_search("Murata", undefined, 5, "hybrid");
    assert.equal(ranked.every(item => Number.isFinite(item.rank_components.ppr)), true);
    graph.config.quality.rankingWeights.ppr = 0;
    graph.store.qualityGraphSnapshot = () => { throw new Error("must be bypassed"); };
    assert.ok((await graph.kg_search("Murata", undefined, 5, "hybrid")).length > 0);
    graph.config.quality.rankingWeights.ppr = .15;
    const fallback = await graph.kg_search("Murata", undefined, 5, "hybrid");
    assert.ok(fallback.length > 0);
    assert.equal(fallback.every(item => item.rank_components.ppr === 0), true);
  } finally { graph.close(); }
});

test("quality summary failures preserve successful semantic hybrid candidates", async () => {
  const graph = graphWith(fake);
  try {
    await graph.kg_ingest("fixture", "fixture");
    graph.store.qualityEvidenceSummaries = () => { throw new Error("quality offline"); };
    const results = await graph.kg_search("半导体上游", undefined, 5, "hybrid");
    assert.equal(results.some(item => item.node.name === "硅晶圆"), true);
  } finally { graph.close(); }
});
