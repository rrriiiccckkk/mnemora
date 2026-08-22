import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../dist/config.js";
import { ConversationJournalService } from "../dist/journal/service.js";
import { sessionWriteDisposition } from "../dist/journal/session-policy.js";
import { GraphologyStore } from "../dist/store.js";

test("session write policy applies bounded glob patterns with ignore taking precedence", () => {
  const policy = { ignoreSessionPatterns: ["agent:*:cron:**"], statelessSessionPatterns: ["agent:*:readonly:**"] };
  assert.equal(sessionWriteDisposition("agent:main:cron:daily", policy), "ignored");
  assert.equal(sessionWriteDisposition("agent:main:readonly:preview", policy), "stateless");
  assert.equal(sessionWriteDisposition("agent:main:user:chat", policy), "writable");
  assert.equal(sessionWriteDisposition("agent:main:cron:readonly", { ...policy, ignoreSessionPatterns: ["agent:*:cron:*"] }), "ignored");
});

test("configured and environment session policies prevent Journal and derived-memory writes", () => {
  const priorIgnore = process.env.MNEMORA_IGNORE_SESSION_PATTERNS;
  const priorStateless = process.env.MNEMORA_STATELESS_SESSION_PATTERNS;
  process.env.MNEMORA_IGNORE_SESSION_PATTERNS = "env:*:ignore";
  process.env.MNEMORA_STATELESS_SESSION_PATTERNS = "env:*:readonly";
  const store = new GraphologyStore(":memory:");
  try {
    const config = normalizeConfig({ conversationJournal: { enabled: true, ignoreSessionPatterns: ["config:*:ignore"], statelessSessionPatterns: ["config:*:readonly"] } });
    const journal = new ConversationJournalService(config, () => ({ store, close() {} }));
    for (const sessionId of ["env:one:ignore", "env:one:readonly", "config:one:ignore", "config:one:readonly"]) {
      assert.equal(journal.captureCompletedTurn({ sessionId, userText: "do not store", assistantText: "acknowledged" }), undefined);
    }
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_conversation_events").get().n, 0);
    assert.equal(journal.captureCompletedTurn({ sessionId: "agent:one:user", userText: "store this", assistantText: "acknowledged" }).inserted, true);
  } finally {
    if (priorIgnore === undefined) delete process.env.MNEMORA_IGNORE_SESSION_PATTERNS; else process.env.MNEMORA_IGNORE_SESSION_PATTERNS = priorIgnore;
    if (priorStateless === undefined) delete process.env.MNEMORA_STATELESS_SESSION_PATTERNS; else process.env.MNEMORA_STATELESS_SESSION_PATTERNS = priorStateless;
    store.close();
  }
});
