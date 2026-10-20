import assert from "node:assert/strict";
import test from "node:test";
import { enterDeterministic, seededUUID } from "../scripts/lib/deterministic.mjs";
import { randomUUID } from "node:crypto";
import { GraphologyStore } from "../dist/store.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" };

function journalIds(seed) {
  const leave = enterDeterministic(seed, Date.UTC(2023, 4, 20));
  const store = new GraphologyStore(":memory:");
  try {
    const events = new ConversationEventRepository(store.db, policy);
    for (const text of ["one", "two", "three"]) events.append({ scope: "s", sessionId: "x", kind: "user_message", role: "user", parts: [{ type: "text", text }], createdAt: Date.now() });
    return store.db.prepare("SELECT id FROM mnemora_conversation_events ORDER BY sequence").all().map(row => row.id);
  } finally { store.close(); leave(); }
}

test("seeded ids are UUID-shaped and repeat per seed", () => {
  assert.match(seededUUID("q1", 0), UUID);
  assert.equal(seededUUID("q1", 3), seededUUID("q1", 3));
  assert.notEqual(seededUUID("q1", 3), seededUUID("q2", 3));
});

test("Mnemora's own named randomUUID import sees the seeded ids", () => {
  const first = journalIds("question-a");
  assert.equal(first.length, 3);
  assert.deepEqual(journalIds("question-a"), first);
  assert.notDeepEqual(journalIds("question-b"), first);
});

test("the clock starts at the given time, advances per call, and is restored", () => {
  const start = Date.UTC(2023, 4, 20, 12);
  const leave = enterDeterministic("clock", start);
  assert.equal(Date.now(), start);
  assert.equal(Date.now(), start + 1);
  leave();
  assert.ok(Math.abs(Date.now() - new Date().getTime()) < 1000);
  assert.notEqual(randomUUID(), randomUUID());
});
