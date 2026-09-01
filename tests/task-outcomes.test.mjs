import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMnemoraContextRef } from "../dist/context/context-ref.js";
import { TaskOutcomeService } from "../dist/cognition/outcomes.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";
import { EpisodeRepository } from "../dist/episodes/repository.js";
import { GraphologyStore } from "../dist/store.js";
import { SUPPORTED_SCHEMA_VERSION } from "../dist/schema.js";

const policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" };
test("task outcomes are previewed, evidence-linked, immutable, and scope-bound", () => {
  let now = 10_000;
  const store = new GraphologyStore(":memory:");
  try {
    assert.equal(SUPPORTED_SCHEMA_VERSION, 75);
    const event = new ConversationEventRepository(store.db, policy).append({ scope: "project:a", sessionId: "s", kind: "user_message", role: "user", parts: [{ type: "text", text: "run safe migration" }] });
    const task = new EpisodeRepository(store.db).create({ scope: "project:a", kind: "task", summary: "Run safe migration", sourceEventIds: [event.id], importance: .8, confidence: .9 });
    const taskRef = createMnemoraContextRef({ scope: "project:a", kind: "episode", id: task.id });
    const evidenceRef = createMnemoraContextRef({ scope: "project:a", kind: "conversation-event", id: event.id });
    const service = new TaskOutcomeService(store.db, () => ++now);
    const input = { scope: "project:a", taskRef, verdict: "success", impact: "helpful", confidence: .9, summary: "Migration completed after rollback validation.", evidenceRefs: [evidenceRef] };
    const preview = service.preview(input);
    assert.throws(() => service.confirm(input, "wrong"), /invalid_outcome_preview/);
    const first = service.confirm(input, preview.preview_hash);
    assert.equal(first.status, "recorded");
    assert.deepEqual(service.confirm(input, preview.preview_hash), first);
    assert.deepEqual(service.summary("project:a").outcomes, { "success:helpful": 1 });
    const correction = { ...input, verdict: "partial", impact: "neutral", supersedesId: first.id };
    const second = service.confirm(correction, service.preview(correction).preview_hash);
    assert.equal(service.get(first.id, "project:a").status, "superseded");
    assert.equal(second.status, "recorded");
    assert.equal(service.forTask("project:a", taskRef).length, 2);
    assert.throws(() => service.preview({ ...input, scope: "project:b" }), /scope_mismatch/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM mnemora_task_outcome_events").get().count, 3);
  } finally { store.close(); }
});

test("schema v41 adds the outcome ledger without rebuilding v40 data", () => {
  const path = join(tmpdir(), `mnemora-outcomes-${process.pid}-${Date.now()}.db`);
  let legacy;
  try {
    legacy = new GraphologyStore(path);
    legacy.db.exec("DROP TABLE mnemora_task_outcome_events; DROP TABLE mnemora_task_outcomes; PRAGMA user_version=40");
    legacy.close(); legacy = undefined;
    const migrated = new GraphologyStore(path);
    try {
      assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='mnemora_task_outcomes'").get().count, 1);
    } finally { migrated.close(); }
  } finally { try { legacy?.close(); } catch {} try { rmSync(path, { force: true }); } catch {} }
});
