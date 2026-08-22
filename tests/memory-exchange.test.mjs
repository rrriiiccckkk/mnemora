import assert from "node:assert/strict";
import test from "node:test";
import { Mnemora } from "../dist/index.js";

test("memory JSONL exchange is scope-explicit, bounded, preview-first, and preserves archived state", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    graph.kg_memory({ operation: "store", scope: "project:a", title: "Active thesis", source: "memory:export", content: "Active memory about HBM packaging." });
    const retired = graph.kg_memory({ operation: "store", scope: "project:a", title: "Retired thesis", source: "memory:export", content: "Archived memory about an old process." });
    const archive = graph.kg_memory({ operation: "lifecycle", action: "archive", document_id: retired.id, scope: "project:a" });
    graph.kg_memory({ operation: "lifecycle", action: "archive", document_id: retired.id, scope: "project:a", preview_hash: archive.preview_hash, confirm: true });

    const exported = graph.kg_memory({ operation: "export", scope: "project:a" });
    assert.equal(exported.format, "memory-jsonl");
    assert.equal(exported.scope, "project:a");
    assert.equal(exported.record_count, 2);
    assert.match(exported.data, /memory_document/);
    assert.throws(() => graph.kg_memory({ operation: "export", scope: "project:a", max_records: 1 }), /memory export record bound exceeded/);

    const preview = graph.kg_memory({ operation: "import", scope: "project:b", data: exported.data });
    assert.equal(preview.scope, "project:b");
    assert.deepEqual(preview.counts, { total: 2, valid: 2, archived: 1 });
    assert.match(preview.preview_hash, /^[a-f0-9]{64}$/);
    const imported = graph.kg_memory({ operation: "import", scope: "project:b", data: exported.data, preview_hash: preview.preview_hash, confirm: true });
    assert.equal(imported.imported, 2);
    assert.equal(imported.archived, 1);
    assert.equal(graph.kg_memory({ operation: "search", scope: "project:b", query: "HBM packaging" }).length, 1);
    assert.deepEqual(graph.kg_memory({ operation: "search", scope: "project:b", query: "old process" }), []);
    assert.deepEqual(graph.store.db.prepare("SELECT scope,payload_hash,imported_count,archived_count FROM kg_memory_import_audits").get().scope, "project:b");
    assert.throws(() => graph.kg_memory({ operation: "import", scope: "project:b", data: exported.data, preview_hash: preview.preview_hash, confirm: true }), /stale_memory_import_preview/);
  } finally { graph.close(); }
});

test("memory import rejects stale target scopes and malformed records without storing bodies in previews", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const data = '{"format_version":1,"kind":"memory_document","document":{"title":"Imported","content":"Bounded import content","source":"memory:import","metadata":{},"lifecycle_state":"active"}}\n';
    const preview = graph.kg_memory({ operation: "import", scope: "project:stale", data });
    graph.kg_memory({ operation: "store", scope: "project:stale", content: "Another memory changes the scope revision." });
    assert.throws(() => graph.kg_memory({ operation: "import", scope: "project:stale", data, preview_hash: preview.preview_hash, confirm: true }), /stale_memory_import_preview/);

    const invalid = graph.kg_memory({ operation: "import", scope: "project:invalid", data: "{not json}\n" });
    assert.deepEqual(invalid.errors, [{ line: 1, category: "invalid_json" }]);
    assert.throws(() => graph.kg_memory({ operation: "import", scope: "project:invalid", data: "{not json}\n", preview_hash: invalid.preview_hash, confirm: true }), /invalid_memory_import_preview/);
    const stored = graph.store.db.prepare("SELECT summary FROM kg_memory_import_previews WHERE preview_hash=?").get(invalid.preview_hash);
    assert.doesNotMatch(stored.summary, /not json/);
  } finally { graph.close(); }
});

test("memory export redacts local paths and sensitive URL source components", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    graph.kg_memory({ operation: "store", scope: "project:redaction", source: "https://user:pass@example.test/report?token=secret&safe=1#private", content: "Remote source note" });
    const exported = graph.kg_memory({ operation: "export", scope: "project:redaction" });
    assert.doesNotMatch(exported.data, /user:pass|token=secret|#private/);
    assert.match(exported.data, /safe=1/);
    assert.deepEqual(exported.omissions, ["source_url_credentials,source_url_fragment,source_url_sensitive_query"]);
  } finally { graph.close(); }
});
