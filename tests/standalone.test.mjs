import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { normalizeConfig } from "../dist/config.js";
import { standaloneGuide, standaloneReadiness } from "../dist/standalone/readiness.js";
import { firstUseVerification } from "../dist/standalone/first-use.js";
import { FirstUseVerificationRepository } from "../dist/standalone/first-use-repository.js";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { Mnemora } from "../dist/tools.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";
import { GraphologyStore } from "../dist/store.js";
import { SUPPORTED_SCHEMA_VERSION } from "../dist/schema.js";

test("standalone is the only lifecycle, blocks incomplete ownership, and reports only declared public topology", () => {
  assert.equal(normalizeConfig({}).mode, "standalone");
  const incompleteConfig = normalizeConfig({ mode: "standalone", standalone: { activePluginIds: ["lossless-claw", "bad value"] } });
  const incomplete = standaloneReadiness(incompleteConfig, incompleteConfig.standalone.activePluginIds);
  assert.equal(incomplete.activation, "blocked");
  assert.deepEqual(incomplete.diagnostics.map(item => item.code).sort(), ["companion_memory_plugin_detected", "context_engine_required", "conversation_journal_required", "episodic_memory_required"]);
  const configured = normalizeConfig({ mode: "standalone", conversationJournal: { enabled: true }, contextEngine: { enabled: true }, episodicMemory: { enabled: true }, recall: { autoRecall: true } });
  const unconfirmed = standaloneReadiness(configured);
  assert.equal(unconfirmed.activation, "blocked");
  assert.equal(unconfirmed.diagnostics.some(item => item.code === "context_engine_slot_unconfirmed"), true);
  assert.equal(unconfirmed.diagnostics.some(item => item.code === "legacy_hook_configuration_ignored"), true);
  const ready = standaloneReadiness(configured, [], true);
  assert.equal(ready.activation, "ready");
  const legacyBlocked = standaloneReadiness(configured, ["lossless-claw"], true);
  assert.equal(legacyBlocked.activation, "blocked");
  assert.deepEqual(standaloneGuide().standalone.unifiedRetrieval, { enabled: true, shadowMode: true });
  assert.deepEqual(standaloneGuide().rollback.host_context_engine, { contextEngine: { enabled: false }, unifiedRetrieval: { enabled: false } });
});

test("first-use verification gives a specific next action without accepting conversation content", () => {
  const inactive = firstUseVerification({
    contextEngineActive: false, unifiedRetrievalEnabled: false, recallTelemetryEnabled: false,
    activity: { events: 0, sessions: 0, lastCommittedAt: null }, recall: { totalRuns: 0, attachedRuns: 0 }
  });
  assert.equal(inactive.passed, 0);
  assert.equal(inactive.checks[0].state, "blocked");
  assert.match(inactive.nextStep, /select mnemora/i);

  const unrelatedHistory = firstUseVerification({
    contextEngineActive: true, unifiedRetrievalEnabled: true, recallTelemetryEnabled: true,
    activity: { events: 200, sessions: 20, lastCommittedAt: 1_700_000_000_000 }, recall: { totalRuns: 50, attachedRuns: 25 },
    acceptance: { state: "not_started" }
  });
  assert.equal(unrelatedHistory.complete, false, "aggregate history cannot prove one cross-session acceptance");
  assert.equal(unrelatedHistory.checks.find(check => check.id === "cross_session")?.state, "pending");
  assert.equal(unrelatedHistory.checks.find(check => check.id === "recall")?.state, "pending");
  assert.match(unrelatedHistory.nextStep, /verify start/i);

  const noTelemetry = firstUseVerification({
    contextEngineActive: true, unifiedRetrievalEnabled: true, recallTelemetryEnabled: false,
    activity: { events: 2, sessions: 2, lastCommittedAt: 1_700_000_000_000 }, recall: { totalRuns: 0, attachedRuns: 0 }, acceptance: { state: "not_started" }
  });
  assert.equal(noTelemetry.passed, 1);
  assert.equal(noTelemetry.checks[3].state, "blocked");
  assert.match(noTelemetry.nextStep, /shadowMode/);
});

test("first-use verification checkpoints are scoped, short-lived, and never retain their marker or session id", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  let now = 1_700_000_000_000;
  const verification = new FirstUseVerificationRepository(graph.store.db, () => now);
  try {
    const started = verification.start("project-a");
    assert.match(started.marker, /^mnemora-verify-[a-f0-9]{32}$/);
    assert.deepEqual(verification.status("project-a"), { state: "awaiting_capture" });
    verification.recordCapture({ scope: "project-a", sessionId: "session-a", texts: [`Remember this ${started.marker}.`] });
    assert.deepEqual(verification.status("project-a"), { state: "awaiting_cross_session_attachment" });
    verification.recordActualAttachment({ scope: "project-a", sessionId: "session-a", query: started.marker, attachment: started.marker });
    assert.deepEqual(verification.status("project-a"), { state: "awaiting_cross_session_attachment" }, "same-session recall is not cross-session proof");
    verification.recordActualAttachment({ scope: "project-b", sessionId: "session-b", query: started.marker, attachment: started.marker });
    verification.recordActualAttachment({ scope: "project-a", sessionId: "session-b", query: started.marker, attachment: "unrelated attachment" });
    assert.deepEqual(verification.status("project-a"), { state: "awaiting_cross_session_attachment" }, "an unrelated attachment is not proof");
    verification.recordActualAttachment({ scope: "project-a", sessionId: "session-b", query: started.marker, attachment: `Matched ${started.marker}.` });
    assert.deepEqual(verification.status("project-a"), { state: "verified" });
    const stored = graph.store.db.prepare("SELECT marker_hash,source_session_hash,attached_session_hash FROM mnemora_first_use_verifications").get();
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(started.marker, "i"));
    assert.doesNotMatch(JSON.stringify(stored), /session-a|session-b/i);

    const expired = verification.start("project-a"); now += 60 * 60 * 1000 + 1;
    verification.recordCapture({ scope: "project-a", sessionId: "session-c", texts: [expired.marker] });
    assert.deepEqual(verification.status("project-a"), { state: "expired" });
  } finally { graph.close(); }
});

test("v80 first-use acceptance migration is additive and preserves Journal evidence", () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-v80-first-use-")), dbPath = join(directory, "memory.db");
  let store;
  try {
    store = new GraphologyStore(dbPath);
    new ConversationEventRepository(store.db, { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" }).append({ scope: "default", sessionId: "s", kind: "user_message", role: "user", parts: [{ type: "text", text: "existing evidence" }] });
    store.db.exec("DROP TABLE mnemora_first_use_verifications; PRAGMA user_version=79");
    store.close(); store = new GraphologyStore(dbPath);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_first_use_verifications").get().value, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_conversation_events").get().value, 1);
  } finally { try { store?.close(); } catch {} try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("standalone ContextEngine retains committed long-session source events across restart without taking host compaction ownership", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-standalone-")), dbPath = join(directory, "memory.db");
  const config = normalizeConfig({ dbPath, mode: "standalone", conversationJournal: { enabled: true }, contextEngine: { enabled: true, protectedRecentEvents: 4, maxSummaryChars: 2000 }, episodicMemory: { enabled: true } });
  const open = () => new Mnemora({ config });
  try {
    const engine = new MnemoraContextEngine(config, open);
    for (let index = 0; index < 80; index++) await engine.ingest({ sessionId: "long-session", message: { id: `m-${index}`, role: index % 2 ? "assistant" : "user", content: `durable event ${index}` } });
    assert.equal(engine.info.ownsCompaction, false);
    const restarted = new MnemoraContextEngine(config, open);
    const graph = open();
    try {
      const journal = new ConversationEventRepository(graph.store.db, { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" });
      assert.equal(journal.diagnostics(true).events, 80);
      assert.equal((await restarted.bootstrap({ sessionId: "long-session", sessionFile: "session.jsonl" })).reason, "journal_session_reconciled");
      const assembled = await restarted.assemble({ sessionId: "long-session", messages: [{ role: "user", content: "latest" }] });
      assert.equal("systemPromptAddition" in assembled, false);
    } finally { graph.close(); }
  } finally { /* Windows SQLite handles can close asynchronously; .tmp is gitignored and test fixtures are cleaned by the test workspace. */ }
});
