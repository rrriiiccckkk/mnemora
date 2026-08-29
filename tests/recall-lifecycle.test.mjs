import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Mnemora, GraphologyStore, RecallDecayReviewService, RecallUsageRepository, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";
import { createMnemoraContextRef } from "../dist/context/context-ref.js";

test("recall usage is scope-bound, aggregate-only, and accepts only canonical durable refs", () => {
  let now = 1_000_000;
  const store = new GraphologyStore(":memory:");
  try {
    assert.equal(SUPPORTED_SCHEMA_VERSION, 71);
    const usage = new RecallUsageRepository(store.db, () => now);
    const memory = createMnemoraContextRef({ scope: "project:a", kind: "memory-document", id: "note-1" });
    const journal = createMnemoraContextRef({ scope: "project:a", kind: "conversation-event", id: "event-1" });
    assert.deepEqual(usage.recordInjected({ scope: "project:a", targetRefs: [memory, memory, journal] }), { recorded: 1 });
    now += 10;
    assert.deepEqual(usage.recordInjected({ scope: "project:a", targetRefs: [memory] }), { recorded: 1 });
    assert.deepEqual(usage.usage("project:a", memory), { scope: "project:a", targetRef: memory, targetKind: "memory-document", firstRecalledAt: 1_000_000, lastRecalledAt: 1_000_010, recallCount: 2 });
    assert.deepEqual(usage.summary("project:a"), { trackedTargets: 1, trackedRecalls: 2 });
    assert.deepEqual(usage.summary("project:b"), { trackedTargets: 0, trackedRecalls: 0 });
    assert.equal(JSON.stringify(store.db.prepare("SELECT * FROM mnemora_recall_usage").all()).includes("event-1"), false);
  } finally { store.close(); }
});

test("recall-driven decay review is read-only, requires no recall since latest write, and never exposes content", () => {
  let now = 10_000 * 86_400_000;
  const graph = new Mnemora({ config: { dbPath: ":memory:" }, now: () => now });
  try {
    const stale = graph.kg_memory({ operation: "store", scope: "project:a", title: "Sensitive title", content: "Private memory content must not appear in review output." });
    const recent = graph.kg_memory({ operation: "store", scope: "project:a", title: "Recent", content: "Recent private content." });
    graph.store.db.prepare("UPDATE kg_memory_documents SET updated_at=? WHERE id=?").run(now - 91 * 86_400_000, stale.id);
    const first = graph.kg_memory({ operation: "recall_decay_review", scope: "project:a", min_age_days: 90 });
    assert.equal(first.mutation, "none");
    assert.deepEqual(first.candidates.map(candidate => candidate.documentId), [stale.id]);
    assert.equal(JSON.stringify(first).includes("Private memory content"), false);
    assert.equal(JSON.stringify(first).includes("Sensitive title"), false);
    assert.equal(graph.store.db.prepare("SELECT lifecycle_state FROM kg_memory_documents WHERE id=?").get(stale.id).lifecycle_state, "active");

    const ref = createMnemoraContextRef({ scope: "project:a", kind: "memory-document", id: stale.id });
    graph.recallUsage.recordInjected({ scope: "project:a", targetRefs: [ref] });
    const recalled = graph.kg_memory({ operation: "recall_decay_review", scope: "project:a", min_age_days: 90 });
    assert.deepEqual(recalled.candidates, []);

    now += 92 * 86_400_000;
    graph.store.db.prepare("UPDATE kg_memory_documents SET updated_at=? WHERE id=?").run(now - 91 * 86_400_000, stale.id);
    const revised = new RecallDecayReviewService(graph.store.db, graph.recallUsage, () => now).preview({ scope: "project:a", minAgeDays: 90 });
    assert.equal(revised.candidates[0].reasonCode, "not_recalled_since_latest_write");
    assert.equal(revised.candidates[0].recallCount, 1);
    assert.equal(revised.candidates[0].lastRecalledAt < revised.candidates[0].documentUpdatedAt, true);
    assert.equal(revised.candidates.some(candidate => candidate.documentId === recent.id), false);
  } finally { graph.close(); }
});

test("v6.21 migration is additive and preserves an existing memory document", () => {
  const path = join(tmpdir(), `mnemora-recall-lifecycle-${process.pid}-${Date.now()}.db`); let legacy;
  try {
    legacy = new GraphologyStore(path);
    legacy.db.prepare("INSERT INTO kg_memory_documents(id,scope,title,content,source,metadata,content_hash,created_at,updated_at,lifecycle_state) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run("memory:legacy", "work", "Legacy", "Existing evidence must survive.", "fixture:legacy", "{}", "a".repeat(64), 1, 1, "active");
    legacy.db.exec("DROP TABLE mnemora_recall_usage; PRAGMA user_version=56");
    legacy.close(); legacy = undefined;
    const migrated = new GraphologyStore(path);
    try {
      assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 70);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS value FROM kg_memory_documents WHERE id='memory:legacy'").get().value, 1);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='mnemora_recall_usage'").get().value, 1);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS value FROM mnemora_recall_usage").get().value, 0);
    } finally { migrated.close(); }
  } finally { try { legacy?.close(); } catch {} try { rmSync(path, { force: true }); } catch {} }
});
