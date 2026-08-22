import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "@photostructure/sqlite";
import { Mnemora, SUPPORTED_SCHEMA_VERSION, createInspectorApplication, truncateUtf8 } from "../dist/index.js";

const NOW = 1_700_000_000_000;
const evidence = "Acme confirms the source anchoring contract.";
const extraction = { entities: [{ name: "Acme", type: "company", confidence: .91, evidence_span: evidence }], relations: [] };

test("snapshot truncation preserves UTF-8 character boundaries", () => {
  assert.equal(truncateUtf8("你好", 5), "你");
  assert.equal(Buffer.byteLength(truncateUtf8("你好", 5), "utf8"), 3);
});

test("source anchoring is opt-in and leaves v1.2 ingestion behavior unchanged by default", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    assert.equal(graph.config.trustLayer?.enabled, false);
    await graph.kg_ingest(evidence, "manual:default", extraction);
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_source_anchors").get().n, 0);
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_claim_verifications").get().n, 0);
  } finally { graph.close(); }
});

test("enabled anchoring persists bounded local snapshots, utf16 spans, and pending verification without a provider", async () => {
  const text = `${"prefix ".repeat(40)}${evidence} ${"suffix ".repeat(80)}`;
  const graph = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { enabled: true, snapshotMaxBytes: 256 } }, now: () => NOW });
  try {
    const result = await graph.kg_ingest(text, "manual:turn", extraction, "project:anchor");
    assert.equal(result.observations.length, 1);
    const anchor = graph.store.db.prepare("SELECT scope,provider,source_label,content_hash,snapshot_text,snapshot_truncated,span_start,span_end,span_encoding,status,captured_at FROM kg_source_anchors").get();
    assert.equal(anchor.scope, "project:anchor");
    assert.equal(anchor.provider, "mnemora-local");
    assert.equal(anchor.source_label, "manual:turn");
    assert.equal(anchor.content_hash, createHash("sha256").update(text.trim()).digest("hex"));
    assert.equal(anchor.snapshot_truncated, 1);
    assert.ok(Buffer.byteLength(anchor.snapshot_text, "utf8") <= 256);
    assert.match(anchor.snapshot_text, /Acme confirms/);
    assert.equal(anchor.span_start, text.indexOf(evidence));
    assert.equal(anchor.span_end, text.indexOf(evidence) + evidence.length);
    assert.equal(anchor.span_encoding, "utf16-code-unit");
    assert.equal(anchor.status, "available");
    assert.equal(anchor.captured_at, NOW);
    const verification = graph.store.db.prepare("SELECT claim_id,status,extraction_confidence,verification_confidence,verifier_kind,verified_at FROM kg_claim_verifications").get();
    assert.equal(verification.claim_id, result.observations[0].id);
    assert.equal(verification.status, "pending");
    assert.equal(verification.extraction_confidence, .91);
    assert.equal(verification.verification_confidence, null);
    assert.equal(verification.verifier_kind, "rule");
    assert.equal(verification.verified_at, null);
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_external_refs").get().n, 0);
  } finally { graph.close(); }
});

test("public URL locators create an external reference and Inspector redacts its source identity", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { enabled: true } }, now: () => NOW });
  try {
    await graph.kg_ingest(evidence, "url:https://user:password@example.test/report?token=SECRET#part", extraction, "project:url");
    const external = graph.store.db.prepare("SELECT provider,external_id,object_type,status FROM kg_external_refs").get();
    assert.deepEqual({ ...external }, { provider: "url", external_id: "https://example.test/report", object_type: "source", status: "active" });
    const app = createInspectorApplication({ graph, allowOperations: false, artifactDirectory: join(tmpdir(), "mnemora-source-anchor-test") });
    const result = app.sources({ kind: "sources", scope: "project:url" });
    assert.equal(result.kind, "sources");
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].source, "https://example.test/report");
    assert.deepEqual({ source_status: result.items[0].source_status, verification_status: result.items[0].verification_status, snapshot_truncated: result.items[0].snapshot_truncated, claim_count: result.items[0].claim_count }, { source_status: "available", verification_status: "pending", snapshot_truncated: false, claim_count: 1 });
    assert.doesNotMatch(JSON.stringify(result), /password|SECRET|token/i);
  } finally { graph.close(); }
});

test("pre-trust databases upgrade additively without fabricating historical verification", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-trust-migration-"));
  const path = join(directory, "legacy.sqlite");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE kg_graph_state(key TEXT PRIMARY KEY,value INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE kg_nodes(id TEXT PRIMARY KEY,type TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',aliases TEXT NOT NULL DEFAULT '[]',importance REAL NOT NULL DEFAULT 0,deleted_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE kg_observations(id TEXT PRIMARY KEY,edge_id TEXT,source_entity_id TEXT,payload TEXT NOT NULL DEFAULT '{}',source TEXT NOT NULL,scope TEXT NOT NULL DEFAULT 'default',quote TEXT NOT NULL,confidence REAL NOT NULL,created_at INTEGER NOT NULL);
      INSERT INTO kg_graph_state VALUES('content_revision',0,0);
      INSERT INTO kg_nodes VALUES('company:legacy','company','Legacy','','[]',0,NULL,1,1);
      INSERT INTO kg_observations VALUES('obs:legacy',NULL,'company:legacy','{}','manual:legacy','default','legacy fact',.9,1);
      PRAGMA user_version=14`);
    legacy.close();
    const graph = new Mnemora({ config: { dbPath: path } });
    try {
      assert.equal(graph.store.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
      assert.ok(SUPPORTED_SCHEMA_VERSION >= 15);
      assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_source_anchors").get().n, 0);
      assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_claim_verifications").get().n, 0);
      assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_recall_shadow_runs").get().n, 0);
      assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_observations WHERE id='obs:legacy'").get().n, 1);
    } finally { graph.close(); }
  } finally { try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (error) { if (process.platform !== "win32" || error?.code !== "EPERM") throw error; } }
});
