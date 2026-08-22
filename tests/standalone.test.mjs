import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { normalizeConfig } from "../dist/config.js";
import { standaloneGuide, standaloneReadiness } from "../dist/standalone/readiness.js";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { Mnemora } from "../dist/tools.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";

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
  assert.deepEqual(standaloneGuide().standalone.unifiedRetrieval, { enabled: true, shadowMode: false });
  assert.deepEqual(standaloneGuide().rollback.host_context_engine, { contextEngine: { enabled: false }, unifiedRetrieval: { enabled: false } });
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
