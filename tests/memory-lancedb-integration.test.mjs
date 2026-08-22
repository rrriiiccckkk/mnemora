import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Mnemora, BoundedCommandError, MemoryLanceDbProAdapter, PROVIDER_ADAPTER_CONTRACT_V1 } from "../dist/index.js";

const sourceText = "Memory candidate records that Acme supplies advanced packaging.";
const sourceHash = createHash("sha256").update(sourceText).digest("hex");
const extracted = { entities: [{ name: "Acme", type: "company", confidence: .9, evidence_span: "Acme supplies advanced packaging." }], relations: [] };

class FakeRunner {
  calls = [];
  constructor(respond) { this.respond = respond; }
  async run(command, args, options) { this.calls.push({ command, args: [...args], options }); return this.respond(command, args, options); }
}

test("memory-lancedb-pro adapter uses only public stats/search JSON commands and returns opaque candidates", async () => {
  const runner = new FakeRunner(async (_command, args) => args[1] === "stats"
    ? { stdout: JSON.stringify({ version: "1.1.0", dbPath: "C:\\private\\memories.lance" }), stderr: "", exitCode: 0 }
    : { stdout: JSON.stringify({ results: [{ id: "memory:acme", content: sourceText, path: "C:\\private\\MEMORY.md" }] }), stderr: "", exitCode: 0 });
  const adapter = new MemoryLanceDbProAdapter(runner), deadlineAt = Date.now() + 5000;
  const capabilities = await adapter.probe({ maxBytes: 4096, deadlineAt });
  const candidates = await adapter.searchCandidates("advanced packaging", "global", 3, { maxBytes: 4096, deadlineAt });
  assert.equal(capabilities.detectedVersion, "1.1.0");
  assert.equal(capabilities.searchSources, true);
  assert.deepEqual(runner.calls.map(call => [call.command, call.args]), [["openclaw", ["memory-pro", "stats", "--json"]], ["openclaw", ["memory-pro", "search", "advanced packaging", "--scope", "global", "--limit", "3", "--json"]]]);
  assert.deepEqual(candidates.map(item => ({ id: item.ref.externalId, hash: item.contentHash })), [{ id: "memory:acme", hash: sourceHash }]);
  assert.equal(JSON.stringify(candidates.map(item => ({ id: item.ref.externalId, hash: item.contentHash }))).includes("private"), false);
});

test("memory-lancedb-pro public inventory is offset-paginated and preserves bounded public lifecycle metadata", async () => {
  const runner = new FakeRunner(async (_command, args) => ({ stdout: JSON.stringify([
    { id: "memory:1", text: "A durable public memory", category: "fact", scope: "global", importance: .8, timestamp: 1234, metadata: JSON.stringify({ tag: "work", ignored: { nested: true } }) },
    { id: "memory:2", text: "A second public memory", category: "decision", scope: "global", importance: .6, timestamp: 5678 }
  ]), stderr: "", exitCode: 0 }));
  const adapter = new MemoryLanceDbProAdapter(runner), page = await adapter.listSources("global", 2, 4, { maxBytes: 4096, deadlineAt: Date.now() + 5000 });
  assert.deepEqual(runner.calls[0].args, ["memory-pro", "list", "--scope", "global", "--limit", "2", "--offset", "4", "--json"]);
  assert.deepEqual(page, { complete: false, nextOffset: 6, sources: [
    { ref: { provider: "memory-lancedb-pro", externalId: "memory:1" }, content: "A durable public memory", contentHash: createHash("sha256").update("A durable public memory").digest("hex"), createdAt: 1234, metadata: { category: "fact", importance: .8, tag: "work" } },
    { ref: { provider: "memory-lancedb-pro", externalId: "memory:2" }, content: "A second public memory", contentHash: createHash("sha256").update("A second public memory").digest("hex"), createdAt: 5678, metadata: { category: "decision", importance: .6 } }
  ] });
});

test("memory-lancedb-pro adapter bounds malformed, oversized, and invalid-scope CLI requests", async () => {
  const malformed = new MemoryLanceDbProAdapter(new FakeRunner(async () => ({ stdout: "not-json", stderr: "", exitCode: 0 })));
  await assert.rejects(() => malformed.searchCandidates("query", "global", 1, { maxBytes: 4096, deadlineAt: Date.now() + 5000 }), error => error instanceof BoundedCommandError && error.category === "invalid_response");
  const oversized = new MemoryLanceDbProAdapter(new FakeRunner(async () => ({ stdout: JSON.stringify({ results: [{ id: "memory:a", content: "x".repeat(17) }] }), stderr: "", exitCode: 0 })));
  await assert.rejects(() => oversized.searchCandidates("query", "global", 1, { maxBytes: 16, deadlineAt: Date.now() + 5000 }), error => error instanceof BoundedCommandError && error.category === "output_too_large");
  const safe = new MemoryLanceDbProAdapter(new FakeRunner(async () => ({ stdout: "[]", stderr: "", exitCode: 0 })));
  await assert.rejects(() => safe.searchCandidates("query", "../private", 1, { maxBytes: 4096, deadlineAt: Date.now() + 5000 }), error => error instanceof BoundedCommandError && error.category === "invalid_response");
});

test("memory-lancedb-pro rejects option-shaped positional query input before invoking its CLI", async () => {
  const runner = new FakeRunner(async () => { throw new Error("must not run"); });
  const adapter = new MemoryLanceDbProAdapter(runner);
  await assert.rejects(() => adapter.searchCandidates("--scope", "global", 1, { maxBytes: 4096, deadlineAt: Date.now() + 5000 }), error => error instanceof BoundedCommandError && error.category === "invalid_response");
  assert.equal(runner.calls.length, 0);
});

test("Mnemora searches opaque candidates then imports the selected public memory only with trust anchoring enabled", async () => {
  const runner = new FakeRunner(async (_command, args) => args[1] === "stats"
    ? { stdout: JSON.stringify({ version: "1.1.0", dbPath: "/private/memories.lance" }), stderr: "", exitCode: 0 }
    : { stdout: JSON.stringify({ results: [{ id: "memory:acme", content: sourceText, score: .99, metadata: { token: "secret" } }] }), stderr: "", exitCode: 0 });
  const graph = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { enabled: true }, integrations: { memoryLanceDbPro: { enabled: true, timeoutMs: 5000, maxOutputBytes: 4096 } } }, extractor: { extract: async () => extracted }, memoryLanceDbProRunner: runner });
  try {
    const search = await graph.kg_integrations({ operation: "search", provider: "memory-lancedb-pro", query: "advanced packaging", provider_scope: "global", limit: 3 });
    assert.deepEqual(search.candidates, [{ external_id: "memory:acme", content_hash: sourceHash }]);
    assert.equal(JSON.stringify(search).match(/secret|private|Memory candidate/), null);
    const result = await graph.kg_integrations({ operation: "ingest", provider: "memory-lancedb-pro", query: "advanced packaging", external_id: "memory:acme", provider_scope: "global", scope: "project:memory" });
    assert.equal(result.status, "healthy");
    assert.equal(result.ingestion?.status, "succeeded");
    assert.equal(JSON.stringify(result).match(/secret|private|Memory candidate/), null);
    assert.deepEqual({ ...graph.store.db.prepare("SELECT provider,external_id,scope,status FROM kg_source_anchors").get() }, { provider: "memory-lancedb-pro", external_id: "memory:acme", scope: "project:memory", status: "available" });
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_external_refs WHERE provider='memory-lancedb-pro'").get().n, 1);
  } finally { graph.close(); }
});

test("memory-lancedb-pro remains opt-in and provider failure does not write a graph claim", async () => {
  const disabled = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    assert.deepEqual(await disabled.kg_integrations({ operation: "search", provider: "memory-lancedb-pro", query: "query" }), { provider: "memory-lancedb-pro", operation: "search", status: "disabled", warning_code: "disabled" });
  } finally { disabled.close(); }
  const failed = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { enabled: true }, integrations: { memoryLanceDbPro: { enabled: true } } }, memoryLanceDbProRunner: new FakeRunner(async () => { throw new BoundedCommandError("timeout"); }) });
  try {
    const result = await failed.kg_integrations({ operation: "ingest", provider: "memory-lancedb-pro", query: "query", external_id: "memory:a" });
    assert.deepEqual(result, { provider: "memory-lancedb-pro", operation: "ingest", status: "degraded", warning_code: "timeout", external_id: "memory:a" });
    assert.equal(failed.store.db.prepare("SELECT COUNT(*) AS n FROM kg_observations").get().n, 0);
  } finally { failed.close(); }
});

test("selected public memory ids use exact resolution rather than a changing search window", async () => {
  let searches = 0, resolves = 0;
  const capabilities = { searchSources: true, resolveRawSource: true, resolveSummaryLineage: false, stableExternalIds: true, returnsContentHash: true, returnsScores: false, supportsAbortSignal: true };
  const adapter = {
    id: "memory-lancedb-pro", contractVersion: PROVIDER_ADAPTER_CONTRACT_V1, capabilities,
    async probe() { return { providerId: "memory-lancedb-pro", ...capabilities }; },
    async searchCandidates() { searches++; return []; },
    async resolveSource(ref) { resolves++; return { ref, content: sourceText, contentHash: "ignored" }; }
  };
  const graph = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { enabled: true } }, extractor: { async extract() { return extracted; } }, providerAdapters: [{ adapter }] });
  try {
    const result = await graph.kg_integrations({ operation: "ingest", provider: "memory-lancedb-pro", query: "irrelevant", external_id: "memory:exact", scope: "work" });
    assert.equal(result.status, "healthy");
    assert.deepEqual({ searches, resolves }, { searches: 0, resolves: 1 });
  } finally { graph.close(); }
});

test("search-only providers distinguish a narrowed search window from confirmed deletion", async () => {
  const runner = new FakeRunner(async (_command, args) => args[1] === "stats"
    ? { stdout: JSON.stringify({ version: "1.1.0" }), stderr: "", exitCode: 0 }
    : { stdout: JSON.stringify({ results: [{ id: "memory:other", content: sourceText }] }), stderr: "", exitCode: 0 });
  const graph = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { enabled: true }, integrations: { memoryLanceDbPro: { enabled: true } } }, extractor: { async extract() { return extracted; } }, memoryLanceDbProRunner: runner });
  try {
    const result = await graph.kg_integrations({ operation: "ingest", provider: "memory-lancedb-pro", query: "query", external_id: "memory:missing" });
    assert.deepEqual(result, { provider: "memory-lancedb-pro", operation: "ingest", status: "degraded", warning_code: "not_in_search_window", external_id: "memory:missing" });
  } finally { graph.close(); }
});
