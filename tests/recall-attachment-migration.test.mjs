import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { GraphologyStore, RecallUsageRepository, ConversationEventRepository, createMnemoraContextRef, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";
import { recallAttachmentSchemaSql, recallLifecycleOptionalRestoreTables } from "../dist/recall-lifecycle/schema.js";
import { consistentBackup } from "../dist/operations/backup.js";
import { createTempDir } from "./helpers/temp.mjs";

const receipts = "mnemora_recall_attachment_receipts", reviews = "mnemora_recall_attachment_reviews";
const preservedTables = ["kg_memory_documents", "kg_memory_chunks", "mnemora_recall_usage", "mnemora_conversation_events", "mnemora_conversation_parts"];
function snapshot(store, tables = preservedTables) {
  return Object.fromEntries(tables.map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function seed(store) {
  const scope = "fixture:attachment", document = store.upsertMemoryDocument({ scope, title: "Existing", content: "Existing document evidence." });
  const targetRef = createMnemoraContextRef({ scope, kind: "memory-document", id: document.id });
  new RecallUsageRepository(store.db, () => 1000).recordInjected({ scope, targetRefs: [targetRef] });
  new ConversationEventRepository(store.db, { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" }).append({ id: "existing-journal", scope, sessionId: "fixture-session", kind: "assistant_message", role: "assistant", contextDomain: "user_chat", parts: [{ type: "text", text: `Existing citation (${targetRef})` }], createdAt: 1001 });
  return scope;
}
function insertAttachment(store, scope = "fixture:attachment") {
  store.db.prepare(`INSERT INTO ${receipts} VALUES(?,?,?,?,?)`).run(scope, "receipt-1", '{"fixture":true}', 1002, 2002);
  store.db.prepare(`INSERT INTO ${reviews} VALUES(?,?,?,?,?,?,?,?)`).run(scope, "receipt-1", "target", "source", "a".repeat(64), "assistant_citation", "b".repeat(64), 1003);
}
function assertEmptyAttachments(store) {
  for (const table of [receipts, reviews]) assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, "migration/legacy restore must not invent attachment evidence");
}

test("schema84 upgrades a schema83 database without fabricating evidence and is restart-idempotent", () => {
  const path = join(createTempDir("recall-attachment-migration-"), "legacy.db");
  let store = new GraphologyStore(path);
  try {
    seed(store);
    const before = snapshot(store);
    store.db.exec(`DROP TABLE ${reviews}; DROP TABLE ${receipts}; PRAGMA user_version=83`);
    store.close(); store = undefined;
    store = new GraphologyStore(path);
    assert.equal(SUPPORTED_SCHEMA_VERSION, 84);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 84);
    assert.deepEqual(snapshot(store), before);
    assertEmptyAttachments(store);
    const indexes = store.db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL ORDER BY name`).all(receipts);
    assert.deepEqual(indexes.map(row => row.name), ["idx_mnemora_recall_attachment_receipts_expires", "idx_mnemora_recall_attachment_receipts_scope_created"]);
    insertAttachment(store);
    const attachments = snapshot(store, [receipts, reviews]);
    store.close(); store = undefined;
    store = new GraphologyStore(path);
    assert.deepEqual(snapshot(store), before);
    assert.deepEqual(snapshot(store, [receipts, reviews]), attachments);
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { store?.close(); }
});

test("attachment schema enforces bounds, scoped identity, review signals and cascading deletion", () => {
  const store = new GraphologyStore(":memory:");
  try {
    store.db.exec(recallAttachmentSchemaSql);
    store.db.exec(recallAttachmentSchemaSql);
    for (const table of [receipts, reviews]) assert.ok(recallLifecycleOptionalRestoreTables.includes(table));
    const receipt = store.db.prepare(`INSERT INTO ${receipts} VALUES(?,?,?,?,?)`);
    receipt.run("a", "x".repeat(80), "x".repeat(131072), 1, 2);
    assert.throws(() => receipt.run("a", "x".repeat(81), "{}", 1, 2), /CHECK/);
    assert.throws(() => receipt.run("a", "oversize", "x".repeat(131073), 1, 2), /CHECK/);
    insertAttachment(store, "a"); insertAttachment(store, "b");
    const review = store.db.prepare(`INSERT INTO ${reviews} VALUES(?,?,?,?,?,?,?,?)`);
    const args = ["a", "receipt-1", "target", "source", "a".repeat(64), "user_confirmation", "b".repeat(64), 3];
    review.run(...args);
    review.run(...args.map((value, index) => index === 5 ? "user_correction" : value));
    assert.throws(() => review.run(...args), /UNIQUE/);
    for (const [index, value] of [[4, "a".repeat(63)], [4, "a".repeat(65)], [5, "user_mention"], [6, "b".repeat(63)], [6, "b".repeat(65)]]) {
      const invalid = [...args]; invalid[index] = value;
      assert.throws(() => review.run(...invalid), /CHECK/);
    }
    assert.throws(() => review.run("missing", ...args.slice(1)), /FOREIGN KEY/);
    store.db.prepare(`DELETE FROM ${receipts} WHERE scope=? AND id=?`).run("a", "receipt-1");
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${reviews} WHERE scope='a'`).get().n, 0);
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${reviews} WHERE scope='b'`).get().n, 1);
  } finally { store.close(); }
});

test("backup/restore preserves schema84 attachments and accepts schema83 backups with both optional tables absent", () => {
  const directory = createTempDir("recall-attachment-restore-");
  const source = new GraphologyStore(join(directory, "source.db")), target = new GraphologyStore(join(directory, "target.db"));
  try {
    seed(source); insertAttachment(source);
    const before = snapshot(source), attachments = snapshot(source, [receipts, reviews]);
    const currentBackup = join(directory, "current-backup.db");
    consistentBackup(source.db, currentBackup);
    target.replaceDatabaseFrom(currentBackup);
    assert.deepEqual(snapshot(target), before);
    assert.deepEqual(snapshot(target, [receipts, reviews]), attachments);
    source.db.exec(`DROP TABLE ${reviews}; DROP TABLE ${receipts}; PRAGMA user_version=83`);
    const legacyBackup = join(directory, "legacy-backup.db");
    consistentBackup(source.db, legacyBackup);
    target.replaceDatabaseFrom(legacyBackup);
    assert.deepEqual(snapshot(target), before);
    assertEmptyAttachments(target);
    assert.equal(target.db.prepare("PRAGMA user_version").get().user_version, 84);
    assert.deepEqual(target.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { target.close(); source.close(); }
});
