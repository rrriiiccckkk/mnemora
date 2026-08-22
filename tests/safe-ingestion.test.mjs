import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Mnemora, GraphologyStore, canonicalizeIngestionSource, fingerprintExtractedTemporal, fingerprintIngestion, normalizeConfig, normalizeIngestionText } from "../dist/index.js";

test("normalization and versioned fingerprints are deterministic and source-aware", () => {
  assert.equal(normalizeIngestionText("\ufeff A\r\nB \r\n"), "A\nB");
  assert.equal(canonicalizeIngestionSource(" report-1 ", "manual"), "manual:report-1");
  assert.equal(fingerprintIngestion("A\r\nB", "report-1"), fingerprintIngestion("\ufeffA\nB\n", "manual:report-1"));
  assert.notEqual(fingerprintIngestion("A\nB", "manual:report-1"), fingerprintIngestion("A\nB", "manual:report-2"));
});

test("final fingerprints include normalized extracted temporal facts", () => {
  const input = fingerprintIngestion("Acme", "fixture:a");
  const base = { entities: [{ name: "Acme", type: "company", confidence: 1, evidence_span: "Acme" }], relations: [] };
  assert.equal(fingerprintExtractedTemporal(input, base), fingerprintExtractedTemporal(input, structuredClone(base)));
  assert.notEqual(fingerprintExtractedTemporal(input, base), fingerprintExtractedTemporal(input, {
    ...base, entities: [{ ...base.entities[0], valid_from: Date.parse("2026-01-01T00:00:00Z") }]
  }));
});

test("batch is bounded and resumes by cursor", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" }, extractor: { async extract(text) { return { entities: [{ name: text, type: "concept", confidence: 1, evidence_span: text }], relations: [] }; } } });
  try {
    const items = Array.from({ length: 55 }, (_, i) => ({ text: `item ${i}`, source: `fixture:${i}` }));
    const first = await graph.kg_ingest_batch(items);
    assert.deepEqual([first.processed, first.succeeded, first.next_cursor], [50, 50, 50]);
    const second = await graph.kg_ingest_batch(items, 50);
    assert.deepEqual([second.processed, second.succeeded, second.next_cursor], [5, 5, null]);
  } finally { graph.close(); }
});

test("batch isolates malformed items and never returns extracted evidence", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" }, extractor: { async extract(text) { return { entities: [{ name: "Acme", type: "company", confidence: 1, evidence_span: text }], relations: [] }; } } });
  try {
    const result = await graph.kg_ingest_batch([{ text: "SECRET FULL TEXT", source: "fixture:ok" }, null, { text: "also ok", source: "fixture:two" }, { text: "non-string source is isolated", source: 42 }]);
    assert.deepEqual([result.succeeded, result.failed], [3, 1]);
    assert.doesNotMatch(JSON.stringify(result), /SECRET FULL TEXT/);
    assert.equal("ingest_result" in result.items[0], false);
  } finally { graph.close(); }
});

test("batch converts an unexpected item failure into a per-item result", async () => {
  const graph = new Mnemora({
    config: { dbPath: ":memory:" },
    extractor: { async extract(text) { return { entities: [{ name: text, type: "concept", confidence: .8, evidence_span: text }], relations: [] }; } }
  });
  try {
    const original = graph.ingestItem.bind(graph); let calls = 0;
    graph.ingestItem = async (item) => { if (++calls === 2) throw new Error("unexpected fixture failure"); return original(item); };
    const result = await graph.kg_ingest_batch([{ text: "first", source: "fixture:first" }, { text: "second", source: 42 }]);
    assert.deepEqual(result.items.map(item => [item.index, item.status, item.error?.category]), [[0, "succeeded", undefined], [1, "failed", "invalid_input"]]);
  } finally { graph.close(); }
});

test("file ingestion accepts markdown and rejects unsupported files without leaking paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mnemora-safe-file-"));
  const graph = new Mnemora({ config: { dbPath: ":memory:" }, extractor: { async extract() { return extraction; } } });
  try {
    const md = join(dir, "notes.md"), json = join(dir, "secret.json");
    writeFileSync(md, "Acme", "utf8"); writeFileSync(json, "secret file contents", "utf8");
    assert.equal((await graph.kg_ingest_file(md)).status, "succeeded");
    const rejected = await graph.kg_ingest_file(json);
    assert.equal(rejected.error.category, "unsupported_file");
    assert.doesNotMatch(JSON.stringify(rejected), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  } finally { graph.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("logical sources cannot persist absolute paths", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" }, extractor: { async extract() { return extraction; } } });
  try {
    const result = await graph.ingestItem({ text: "Acme", source: "C:\\Users\\alice\\secret.md" });
    assert.doesNotMatch(JSON.stringify(result), /Users|alice|secret\.md/i);
  } finally { graph.close(); }
});

const extraction = { entities: [{ name: "Acme", type: "company", confidence: 1, evidence_span: "Acme" }], relations: [] };

test("ingestItem skips a completed fingerprint before extraction", async () => {
  let calls = 0;
  const graph = new Mnemora({ config: { dbPath: ":memory:" }, extractor: { async extract() { calls++; return extraction; } } });
  try {
    assert.equal((await graph.ingestItem({ text: "Acme", source: "fixture:a" })).status, "succeeded");
    assert.equal((await graph.ingestItem({ text: "Acme\n", source: "fixture:a" })).status, "skipped_duplicate");
    assert.equal(calls, 1);
  } finally { graph.close(); }
});

test("ingestion configuration is bounded", () => {
  assert.deepEqual(normalizeConfig({}).ingestion, { maxPayloadBytes: 2097152, maxBatchItems: 50, allowedFileExtensions: [".txt", ".md"], urlMaxPayloadBytes: 2097152, urlTimeoutMs: 15000, urlMaxRedirects: 5 });
  assert.equal(normalizeConfig({ ingestion: { maxPayloadBytes: 99999999 } }).ingestion.maxPayloadBytes, 10485760);
});

test("ingestion audit schema stores input and final identities without source text or path", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const columns = store.db.prepare("PRAGMA table_info(kg_ingestion_records)").all().map(row => row.name);
    assert.deepEqual(columns, ["fingerprint", "input_fingerprint", "fingerprint_version", "source", "scope", "status", "error_category", "error_summary", "created_at", "completed_at"]);
  } finally { store.close(); }
});
