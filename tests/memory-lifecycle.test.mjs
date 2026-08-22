import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Mnemora } from "../dist/index.js";

test("memory lifecycle is preview-first, scope-isolated, recoverable, and audited without content", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const stored = graph.kg_memory({ operation: "store", scope: "research:chips", title: "HBM capacity", source: "memory:lifecycle", content: "HBM packaging capacity remains constrained." });
    assert.equal(stored.lifecycle_state, "active");
    assert.equal(stored.archived_at, null);
    assert.throws(() => graph.kg_memory({ operation: "lifecycle", action: "archive", document_id: stored.id, scope: "personal" }), /memory_document_not_found/);

    const archive = graph.kg_memory({ operation: "lifecycle", action: "archive", document_id: stored.id, scope: "research:chips" });
    assert.equal(archive.confirmed, false);
    assert.match(archive.preview_hash, /^[a-f0-9]{64}$/);
    assert.equal(graph.kg_memory({ operation: "search", scope: "research:chips", query: "packaging" }).length, 1);
    const archived = graph.kg_memory({ operation: "lifecycle", action: "archive", document_id: stored.id, scope: "research:chips", preview_hash: archive.preview_hash, confirm: true });
    assert.equal(archived.confirmed, true);
    assert.deepEqual(graph.kg_memory({ operation: "search", scope: "research:chips", query: "packaging" }), []);
    assert.deepEqual(await graph.kg_memory({ operation: "embed_backfill", scope: "research:chips", limit: 10 }), { processed: 0, embedded: 0, failed: 0, next_after_id: null });

    const recover = graph.kg_memory({ operation: "lifecycle", action: "recover", document_id: stored.id, scope: "research:chips" });
    const recovered = graph.kg_memory({ operation: "lifecycle", action: "recover", document_id: stored.id, scope: "research:chips", preview_hash: recover.preview_hash, confirm: true });
    assert.equal(recovered.confirmed, true);
    assert.equal(graph.kg_memory({ operation: "search", scope: "research:chips", query: "packaging" }).length, 1);

    const deletion = graph.kg_memory({ operation: "lifecycle", action: "delete", document_id: stored.id, scope: "research:chips" });
    const deleted = graph.kg_memory({ operation: "lifecycle", action: "delete", document_id: stored.id, scope: "research:chips", preview_hash: deletion.preview_hash, confirm: true });
    assert.equal(deleted.confirmed, true);
    assert.deepEqual(graph.kg_memory({ operation: "search", scope: "research:chips", query: "packaging" }), []);
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_memory_chunks WHERE document_id=?").get(stored.id).n, 0);
    const audit = graph.kg_memory({ operation: "lifecycle_audit", scope: "research:chips" });
    assert.deepEqual(audit.map(item => item.action), ["delete", "recover", "archive"]);
    assert.equal(audit.some(item => "content" in item || "source" in item), false);
  } finally { graph.close(); }
});

test("memory lifecycle confirmations bind the document state and expiry review never mutates", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const stored = graph.kg_memory({ operation: "store", scope: "project:a", title: "Old thesis", content: "A dated memory." });
    const preview = graph.kg_memory({ operation: "lifecycle", action: "archive", document_id: stored.id, scope: "project:a" });
    await delay(3);
    graph.kg_memory({ operation: "store", scope: "project:a", title: "Old thesis revised", content: "A dated memory." });
    assert.throws(() => graph.kg_memory({ operation: "lifecycle", action: "archive", document_id: stored.id, scope: "project:a", preview_hash: preview.preview_hash, confirm: true }), /stale_memory_lifecycle_preview/);

    graph.store.db.prepare("UPDATE kg_memory_documents SET updated_at=? WHERE id=?").run(Date.now() - 91 * 86_400_000, stored.id);
    const review = graph.kg_memory({ operation: "expiry_review", scope: "project:a", older_than_days: 90 });
    assert.deepEqual(review.items.map(item => item.id), [stored.id]);
    assert.equal(graph.kg_memory({ operation: "search", scope: "project:a", query: "dated" }).length, 1);
    assert.equal(graph.kg_memory({ operation: "lifecycle_audit", scope: "project:a" }).length, 0);
  } finally { graph.close(); }
});
