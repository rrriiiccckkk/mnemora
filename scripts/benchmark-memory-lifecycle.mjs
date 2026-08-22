import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { GraphologyStore } from "../dist/store.js";

const SCALES = [10_000, 50_000, 100_000];
const DAY = 86_400_000;
const NOW = Date.parse("2026-07-28T00:00:00.000Z");

const elapsed = (operation) => {
  const started = performance.now();
  const value = operation();
  return { value, ms: Number((performance.now() - started).toFixed(3)) };
};

for (const scale of SCALES) {
  const store = new GraphologyStore(":memory:");
  const scope = `benchmark:lifecycle:${scale}`;
  try {
    const inserted = elapsed(() => {
      store.db.exec("BEGIN IMMEDIATE");
      try {
        store.db.prepare("INSERT INTO kg_scopes(id,created_at,updated_at) VALUES(?,?,?)").run(scope, NOW, NOW);
        store.db.exec(`WITH RECURSIVE seq(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM seq WHERE i<${scale - 1})
          INSERT INTO kg_memory_documents(id,scope,title,content,source,metadata,content_hash,lifecycle_state,archived_at,created_at,updated_at)
          SELECT 'memory:' || printf('%024x',i),${sql(scope)},'Benchmark memory ' || i,'Lifecycle benchmark content ' || i,'benchmark:memory','{}',printf('%064x',i),'active',NULL,${NOW - 120 * DAY - scale},${NOW - 120 * DAY} - i
          FROM seq`);
        store.db.exec("COMMIT");
      } catch (error) {
        store.db.exec("ROLLBACK");
        throw error;
      }
    });
    const count = Number(store.db.prepare("SELECT COUNT(*) AS count FROM kg_memory_documents WHERE scope=?").get(scope).count);
    assert.equal(count, scale);

    const review = elapsed(() => store.reviewMemoryExpiry({ scope, older_than_days: 90, limit: 100 }));
    assert.equal(review.value.items.length, 100);
    assert.equal(review.value.truncated, true);

    const documentId = "memory:000000000000000000000000";
    const archivePreview = elapsed(() => store.previewMemoryLifecycle({ action: "archive", document_id: documentId, scope }));
    const archived = elapsed(() => store.confirmMemoryLifecycle({ action: "archive", document_id: documentId, scope, preview_hash: archivePreview.value.preview_hash }));
    assert.equal(archived.value.confirmed, true);

    const recoverPreview = elapsed(() => store.previewMemoryLifecycle({ action: "recover", document_id: documentId, scope }));
    const recovered = elapsed(() => store.confirmMemoryLifecycle({ action: "recover", document_id: documentId, scope, preview_hash: recoverPreview.value.preview_hash }));
    assert.equal(recovered.value.confirmed, true);
    assert.equal(store.db.prepare("PRAGMA quick_check").get().quick_check, "ok");

    console.log(JSON.stringify({
      benchmark: "memory_lifecycle_scale",
      scale,
      operations: {
        fixture_insert_ms: inserted.ms,
        expiry_review_ms: review.ms,
        archive_preview_ms: archivePreview.ms,
        archive_confirm_ms: archived.ms,
        recover_preview_ms: recoverPreview.ms,
        recover_confirm_ms: recovered.ms
      },
      observability: {
        expiry_candidates: review.value.items.length,
        expiry_truncated: review.value.truncated,
        lifecycle_audits: store.listMemoryLifecycleAudits({ scope, limit: 10 }).length,
        integrity: "ok"
      }
    }));
  } finally {
    store.close();
  }
}

function sql(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
