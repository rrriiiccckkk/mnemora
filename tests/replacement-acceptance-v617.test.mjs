import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { MnemoraContextEngine, Mnemora, PROVIDER_ADAPTER_CONTRACT_V1, normalizeConfig } from "../dist/index.js";

const capabilities = { searchSources: false, resolveRawSource: false, resolveSummaryLineage: false, stableExternalIds: true, returnsContentHash: false, returnsScores: false, supportsAbortSignal: true };

test("v6.17 standalone acceptance works without legacy plugins: public migration, capture, compaction, restart, recall, and recovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-v617-")), dbPath = join(directory, "memory.db");
  const config = normalizeConfig({
    dbPath, mode: "standalone", trustLayer: { enabled: true }, conversationJournal: { enabled: true },
    contextEngine: { enabled: true, maxContextTokens: 600, protectedRecentEvents: 2, compaction: { enabled: true, minEvents: 2, maxInputChars: 1024, maxOutputChars: 240, timeoutMs: 1000, maxRunsPerHour: 4, maxDailyTokens: 10000, contextThreshold: .5, freshTailCount: 2, leafChunkTokens: 512, maxChunksPerRun: 4, condensedMinFanout: 2, deadlineMs: 5000 } },
    unifiedRetrieval: { enabled: true, tokenBudget: 128, maxItems: 2, minConfidence: .1 }
  });
  const adapter = {
    id: "memory-lancedb-pro", contractVersion: PROVIDER_ADAPTER_CONTRACT_V1, capabilities,
    async probe() { return { providerId: "memory-lancedb-pro", ...capabilities }; },
    async listSources(scope, limit, offset) {
      assert.equal(scope, "global"); assert.equal(limit, 1); assert.equal(offset, 0);
      return { complete: true, sources: [{ ref: { provider: "memory-lancedb-pro", externalId: "legacy:1" }, content: "Public migrated memory: TypeScript is the preferred project language.", contentHash: "ignored", metadata: { category: "preference", importance: .9 } }] };
    }
  };
  const extractor = { async extract() { return { entities: [{ name: "TypeScript", type: "technology", confidence: .95, evidence_span: "TypeScript is the preferred project language." }], relations: [] }; } };
  const open = () => new Mnemora({ config, extractor, providerAdapters: [{ adapter }] });
  try {
    const graph = open();
    let run;
    try {
      const preview = await graph.kg_integrations({ operation: "migration_preview", provider: "memory-lancedb-pro", scope: "default", provider_scope: "global", limit: 1, offset: 0 });
      assert.deepEqual(preview.migration?.inventory, { offset: 0, complete: true });
      run = preview.migration?.id;
      assert.ok(run);
      const applied = await graph.kg_integrations({ operation: "migration_apply", provider: "memory-lancedb-pro", run_id: run });
      assert.equal(applied.migration?.status, "completed");
      assert.equal(graph.kg_memory({ operation: "search", scope: "default", query: "TypeScript", limit: 2, mode: "lexical" }).length, 1);
      assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_source_anchors WHERE provider='memory-lancedb-pro'").get().n, 1);
    } finally { graph.close(); }

    const engine = new MnemoraContextEngine(config, open);
    const messages = Array.from({ length: 6 }, (_value, index) => ({ id: `turn:${index}`, role: index % 2 ? "assistant" : "user", content: `Conversation ${index}: ${"x".repeat(300)}` }));
    let rewrites = 0;
    await engine.afterTurn({ sessionId: "replacement", prePromptMessageCount: 0, tokenBudget: 600, messages, runtimeContext: { llm: { async complete() { return { text: "A bounded source-linked summary." }; } }, async rewriteTranscriptEntries(value) { rewrites += 1; return { changed: true, rewrittenEntries: value.replacements.length }; } } });
    assert.equal(rewrites, 1);
    const restarted = new MnemoraContextEngine(config, open);
    assert.equal((await restarted.bootstrap({ sessionId: "replacement" })).reason, "journal_session_reconciled");
    const assembled = await restarted.assemble({ sessionId: "replacement", prompt: "Which project language is preferred?", messages, tokenBudget: 600 });
    assert.match(JSON.stringify(assembled.messages), /MNEMORA_COMPACTION/);
    assert.match(assembled.systemPromptAddition ?? "", /TypeScript/);
    const verify = open();
    try {
      assert.equal(verify.store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_compaction_runs WHERE scope='default' AND status='succeeded'").get().n > 0, true);
      assert.equal(verify.store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_conversation_events WHERE session_id='replacement'").get().n, 6);
      const rollback = await verify.kg_integrations({ operation: "migration_rollback", provider: "memory-lancedb-pro", run_id: run });
      assert.equal(rollback.migration?.status, "rollback_requires_restore");
    } finally { verify.close(); }
  } finally { try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});
