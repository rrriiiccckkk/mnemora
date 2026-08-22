import assert from "node:assert/strict";
import test from "node:test";
import { ConversationEventRepository, GraphologyStore, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";

const policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" };

test("v28 adds an additive Journal boundary to an existing v27 database", () => {
  const migrated = new GraphologyStore(":memory:");
  try {
    migrated.db.exec("DROP TABLE mnemora_provider_migration_items; DROP TABLE mnemora_provider_migration_runs; DROP TABLE mnemora_turn_receipt_events; DROP TABLE mnemora_host_message_links; DROP TABLE mnemora_change_set_entries; DROP TABLE mnemora_change_sets; DROP TABLE mnemora_derived_tasks; DROP TABLE mnemora_commits; DROP TABLE mnemora_capture_receipts; DROP TABLE mnemora_conversation_parts; DROP TABLE mnemora_conversation_events; PRAGMA user_version=27");
    migrated.migrate();
    assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
    assert.equal(migrated.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='mnemora_conversation_events'").get().n, 1);
    assert.equal(migrated.db.prepare("SELECT COUNT(*) AS n FROM kg_memory_documents").get().n, 0);
  } finally { migrated.close(); }
});

test("Journal is ordered, idempotent, scope-isolated, and commits before derived work", () => {
  const store = new GraphologyStore(":memory:"), journal = new ConversationEventRepository(store.db, policy);
  try {
    const user = journal.append({ scope: "project:alpha", sessionId: "session-1", kind: "user_message", role: "user", hostCorrelation: "delivery-1:user", identityOrigin: "host", parts: [{ type: "text", text: "please remember this" }] });
    const replay = journal.append({ scope: "project:alpha", sessionId: "session-1", kind: "user_message", role: "user", hostCorrelation: "delivery-1:user", identityOrigin: "host", parts: [{ type: "text", text: "different retry body" }] });
    const assistant = journal.append({ scope: "project:alpha", sessionId: "session-1", parentId: user.id, kind: "assistant_message", role: "assistant", hostCorrelation: "delivery-1:assistant", identityOrigin: "host", parts: [{ type: "text", text: "stored" }] });
    assert.equal(replay.id, user.id);
    assert.deepEqual([user.sequence, assistant.sequence], [0, 1]);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_conversation_events").get().n, 2);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_commits WHERE status='committed'").get().n, 2);
    assert.equal(journal.search("project:other", "remember").length, 0);
    assert.equal(journal.search("project:alpha", "remember").map(event => event.id)[0], user.id);
  } finally { store.close(); }
});

test("Journal redacts secrets and preserves tool call/result pairing without leaking raw content", () => {
  const store = new GraphologyStore(":memory:"), journal = new ConversationEventRepository(store.db, policy);
  try {
    const call = journal.append({ scope: "default", sessionId: "session-1", kind: "tool_call", role: "assistant", parts: [{ type: "tool_call", callId: "call-1", name: "shell" }] });
    const result = journal.append({ scope: "default", sessionId: "session-1", parentId: call.id, kind: "tool_result", role: "tool", parts: [{ type: "tool_result", callId: "call-1", inlinePreview: "authorization: Bearer super-secret-token", success: true }] });
    const row = store.db.prepare("SELECT payload FROM mnemora_conversation_parts WHERE event_id=?").get(result.id);
    assert.match(row.payload, /REDACTED_SECRET/);
    assert.doesNotMatch(row.payload, /super-secret-token/);
    assert.equal(journal.get(result.id, "default").parts[0].callId, "call-1");
  } finally { store.close(); }
});

test("Journal enforces the configured byte cap and retention without rolling back a turn", () => {
  const store = new GraphologyStore(":memory:"), journal = new ConversationEventRepository(store.db, { maxInlineChars: 16000, maxEventBytes: 1024, sensitiveContentPolicy: "redact" });
  try {
    const old = journal.append({ scope: "default", sessionId: "s", kind: "user_message", role: "user", createdAt: 1, parts: [{ type: "text", text: "中".repeat(5000) }, { type: "tool_call", callId: "c", name: "x".repeat(5000) }] });
    const payload = store.db.prepare("SELECT payload FROM mnemora_conversation_parts WHERE event_id=?").get(old.id);
    assert.ok(Buffer.byteLength(payload.payload, "utf8") <= 1024);
    assert.equal(journal.enforceRetention(1, 86_400_002), 1);
    assert.equal(journal.get(old.id, "default"), undefined);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_conversation_parts WHERE event_id=?").get(old.id).n, 0);
  } finally { store.close(); }
});

test("v6.11 retention uses the scope-created index and bounded batches", () => {
  const store = new GraphologyStore(":memory:"), journal = new ConversationEventRepository(store.db, policy), now = 10 * 86_400_000, old = now - 2 * 86_400_000;
  try {
    store.db.exec("BEGIN IMMEDIATE");
    try {
      store.db.prepare("INSERT INTO kg_scopes(id,created_at,updated_at) VALUES(?,?,?)").run("project:a", old, old);
      store.db.prepare("INSERT INTO kg_scopes(id,created_at,updated_at) VALUES(?,?,?)").run("project:b", old, old);
      const insert = store.db.prepare("INSERT INTO mnemora_conversation_events(id,scope,session_id,branch_id,parent_id,sequence,kind,role,context_domain,identity_origin,host_correlation,content_hash,normalized_text,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
      for (let index = 0; index < 260; index++) insert.run(`a:${index}`, "project:a", "s", "main", null, index, "user_message", "user", "user_chat", "host", null, `a${index}`, "old", old);
      insert.run("b:0", "project:b", "s", "main", null, 0, "user_message", "user", "user_chat", "host", null, "b", "old", old);
      store.db.exec("COMMIT");
    } catch (error) { store.db.exec("ROLLBACK"); throw error; }
    const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM mnemora_conversation_events WHERE scope=? AND deleted_at IS NULL AND created_at<? ORDER BY created_at ASC,id ASC LIMIT ?").all("project:a", now - 86_400_000, 256).map(row => String(row.detail)).join(" ");
    assert.match(plan, /idx_mnemora_events_scope_created/);
    assert.equal(journal.enforceRetention(1, now, "project:a"), 256);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_conversation_events WHERE scope='project:a' AND deleted_at IS NULL").get().n, 4);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_conversation_events WHERE scope='project:b' AND deleted_at IS NULL").get().n, 1);
  } finally { store.close(); }
});

test("v5.1 turn receipts are atomic, idempotent, and recover stale derived-task leases", () => {
  const store = new GraphologyStore(":memory:"), journal = new ConversationEventRepository(store.db, policy);
  try {
    const input = { scope: "project:turn", sessionId: "s", hostCorrelation: "run-1", derivedTaskKinds: ["auto_extract", "episode"], events: [
      { scope: "project:turn", sessionId: "s", kind: "user_message", role: "user", hostCorrelation: "run-1:user", parts: [{ type: "text", text: "remember launch day" }] },
      { scope: "project:turn", sessionId: "s", kind: "assistant_message", role: "assistant", parentEventOrdinal: 0, hostCorrelation: "run-1:assistant", parts: [{ type: "text", text: "captured" }] }
    ] };
    const first = journal.captureTurn(input), replay = journal.captureTurn(input);
    assert.equal(first.inserted, true); assert.equal(replay.inserted, false); assert.equal(first.events.length, 2); assert.equal(first.events[1].parentId, first.events[0].id);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_commits WHERE receipt_id=?").get(first.receiptId).n, 1);
    const [task] = journal.claimDerivedTasks({ scope: "project:turn", owner: "worker-a", kinds: ["auto_extract"], leaseMs: 5000, now: 100 });
    assert.equal(task.status, "running"); assert.equal(journal.reclaimStaleDerivedTasks("project:turn", 5101), 1);
    const [reclaimed] = journal.claimDerivedTasks({ scope: "project:turn", owner: "worker-b", kinds: ["auto_extract"], leaseMs: 5000, now: 5102 });
    assert.equal(reclaimed.attempts, 2); assert.equal(journal.finishDerivedTask({ id: reclaimed.id, scope: "project:turn", owner: "worker-b", status: "succeeded", now: 5103 }), true);
  } finally { store.close(); }
});

test("exact-correlation replay flood accounting distinguishes host and internal deliveries", () => {
  const store = new GraphologyStore(":memory:"), journal = new ConversationEventRepository(store.db, { ...policy, replayFloodThresholdExternal: 1, replayFloodThresholdInternal: 2 });
  const turn = (key, origin) => ({ scope: "default", sessionId: "s", hostCorrelation: key, events: [{ scope: "default", sessionId: "s", kind: "user_message", role: "user", identityOrigin: origin, hostCorrelation: `${key}:user`, parts: [{ type: "text", text: key }] }] });
  try {
    const external = turn("host", "host");
    assert.equal(journal.captureTurn(external).inserted, true);
    assert.equal(journal.captureTurn(external).replaySuppressed, undefined);
    assert.equal(journal.captureTurn(external).replaySuppressed, true);
    const internal = turn("internal", "local_receipt");
    journal.captureTurn(internal); journal.captureTurn(internal); journal.captureTurn(internal);
    assert.equal(journal.captureTurn(internal).replaySuppressed, true);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_conversation_events").get().n, 2);
    const guards = store.db.prepare("SELECT origin,delivery_count,suppressed_at FROM mnemora_replay_flood_guards ORDER BY origin").all();
    assert.deepEqual(guards.map(row => ({ ...row, suppressed_at: Number(row.suppressed_at) > 0 })), [{ origin: "external", delivery_count: 2, suppressed_at: true }, { origin: "internal", delivery_count: 3, suppressed_at: true }]);
  } finally { store.close(); }
});

test("v6.11 replay flood guards expire and stay bounded per scope", () => {
  const store = new GraphologyStore(":memory:"), journal = new ConversationEventRepository(store.db, policy), now = 40 * 86_400_000;
  try {
    store.db.exec("BEGIN IMMEDIATE");
    try {
      store.db.prepare("INSERT INTO kg_scopes(id,created_at,updated_at) VALUES(?,?,?)").run("project:replay", now, now);
      const insert = store.db.prepare("INSERT INTO mnemora_replay_flood_guards(scope,session_id,correlation_key,origin,delivery_count,first_seen_at,last_seen_at,suppressed_at) VALUES(?,?,?,?,?,?,?,?)");
      insert.run("project:replay", "s", "expired", "external", 1, 1, 1, null);
      for (let index = 0; index < 10_001; index++) insert.run("project:replay", "s", `current:${index}`, "external", 1, now, now, null);
      store.db.exec("COMMIT");
    } catch (error) { store.db.exec("ROLLBACK"); throw error; }
    journal.captureTurn({ scope: "project:replay", sessionId: "s", hostCorrelation: "cleanup", createdAt: now, events: [{ scope: "project:replay", sessionId: "s", kind: "user_message", role: "user", parts: [{ type: "text", text: "new turn" }] }] });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_replay_flood_guards WHERE scope='project:replay' AND correlation_key='expired'").get().n, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_replay_flood_guards WHERE scope='project:replay'").get().n, 10_000, "cap cleanup removes only the exact overflow after bounded expiry cleanup");
  } finally { store.close(); }
});

test("Journal retires unconsumed legacy summary tasks", () => {
  const store = new GraphologyStore(":memory:"), journal = new ConversationEventRepository(store.db, policy);
  try {
    journal.captureTurn({ scope: "default", sessionId: "s", hostCorrelation: "legacy-summary", derivedTaskKinds: ["summary_l1"], events: [{ scope: "default", sessionId: "s", kind: "user_message", role: "user", parts: [{ type: "text", text: "old work" }] }] });
    assert.equal(journal.cancelUnsupportedDerivedTasks("default", ["summary_l1"]), 1);
    assert.equal(store.db.prepare("SELECT status FROM mnemora_derived_tasks").get().status, "cancelled");
  } finally { store.close(); }
});
