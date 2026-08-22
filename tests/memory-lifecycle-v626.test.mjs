import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Mnemora, GraphologyStore, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";
import { SmartEpisodeExtractor } from "../dist/episodes/smart-extraction.js";
import { ConversationJournalService } from "../dist/journal/service.js";

test("v61 lifecycle migration is additive and begins every existing document at working", () => {
  const store = new GraphologyStore(":memory:");
  try {
    assert.equal(SUPPORTED_SCHEMA_VERSION, 61);
    const document = store.upsertMemoryDocument({ title: "Existing", content: "A preserved historical memory" });
    const row = store.db.prepare("SELECT tier,access_count,expires_at FROM mnemora_memory_document_lifecycle WHERE document_id=?").get(document.id);
    assert.deepEqual({ ...row }, { tier: "working", access_count: 0, expires_at: null });
    assert.equal(store.db.prepare("SELECT content FROM kg_memory_documents WHERE id=?").get(document.id).content, "A preserved historical memory");
    assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { store.close(); }
});

test("memory lifecycle stays disabled by default and only manual documents gain access reinforcement", () => {
  const disabled = new Mnemora({ config: { dbPath: ":memory:" } });
  const enabled = new Mnemora({ config: { dbPath: ":memory:", memory: { lifecycle: { enabled: true, corePromotionAccesses: 2 } } } });
  try {
    const legacy = disabled.kg_memory({ operation: "store", title: "Temporary", content: "temporary deployment note" });
    assert.equal(disabled.kg_memory({ operation: "search", query: "temporary deployment" })[0].memory_tier, undefined);
    assert.equal(disabled.store.db.prepare("SELECT access_count FROM mnemora_memory_document_lifecycle WHERE document_id=?").get(legacy.id).access_count, 0);

    const manual = enabled.kg_memory({ operation: "store", title: "Manual", content: "temporary deployment note" });
    const automatic = enabled.kg_memory({ operation: "store", title: "Automatic", content: "temporary deployment note", source: "session:captured" });
    assert.equal(enabled.kg_memory({ operation: "search", query: "temporary deployment", limit: 2 })[0].memory_tier, "working");
    enabled.kg_memory({ operation: "search", query: "temporary deployment", limit: 2 });
    const rows = enabled.store.db.prepare("SELECT d.id,l.tier,l.access_count FROM kg_memory_documents d JOIN mnemora_memory_document_lifecycle l ON l.document_id=d.id ORDER BY d.id").all();
    const byId = new Map(rows.map(row => [row.id, row]));
    assert.equal(byId.get(manual.id).tier, "core");
    assert.equal(byId.get(automatic.id).tier, "working");
    assert.equal(byId.get(automatic.id).access_count, 2);
  } finally { disabled.close(); enabled.close(); }
});

test("local expiry inference is opt-in, non-destructive, and tier changes remain preview-first", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:", memory: { lifecycle: { enabled: true, temporalInference: true } } }, now: () => 1_700_000_000_000 });
  try {
    const document = graph.kg_memory({ operation: "store", title: "Trial", content: "This is a temporary trial deployment note." });
    const review = graph.kg_memory({ operation: "tier_review" });
    assert.equal(review.items[0].expiry_reason, "temporary");
    assert.equal(graph.store.db.prepare("SELECT lifecycle_state FROM kg_memory_documents WHERE id=?").get(document.id).lifecycle_state, "active");
    const preview = graph.kg_memory({ operation: "tier", document_id: document.id, tier: "peripheral" });
    assert.equal(preview.confirmed, false);
    assert.equal(graph.kg_memory({ operation: "tier_review" }).items[0].tier, "working");
    const confirmed = graph.kg_memory({ operation: "tier", document_id: document.id, tier: "peripheral", preview_hash: preview.preview_hash, confirm: true });
    assert.equal(confirmed.confirmed, true);
    assert.equal(graph.kg_memory({ operation: "tier_review" }).items[0].tier, "peripheral");
    const stale = graph.kg_memory({ operation: "tier", document_id: document.id, tier: "core" });
    graph.store.db.prepare("UPDATE mnemora_memory_document_lifecycle SET updated_at=updated_at+1 WHERE document_id=?").run(document.id);
    assert.throws(() => graph.kg_memory({ operation: "tier", document_id: document.id, tier: "core", preview_hash: stale.preview_hash, confirm: true }), /stale_memory_lifecycle_preview/);
  } finally { graph.close(); }
});

test("smart episode extraction is runtime-only, bounded, and produces source-linked projections rather than facts", async () => {
  const config = { enabled: true, maxInputChars: 1000, maxOutputChars: 1000, maxEpisodesPerTurn: 3, timeoutMs: 1000, minImportance: .5 };
  const extractor = new SmartEpisodeExtractor(config);
  const events = [
    { id: "user", role: "user", normalizedText: "We decided to ship the safe migration." },
    { id: "assistant", role: "assistant", normalizedText: "I will prepare the release checklist." }
  ];
  assert.deepEqual(await extractor.extract({ events }), { status: "failed", category: "model_unavailable" });
  const runtime = { async complete(input) {
    assert.match(input.systemPrompt, /non-authoritative/i);
    assert.ok(input.messages[0].content.length <= 1000);
    return { text: JSON.stringify({ episodes: [
      { kind: "decision", summary: "The turn records a decision to ship a safe migration.", importance: .9 },
      { kind: "belief", title: "Bad", summary: "must be rejected", importance: 1 }
    ] }) };
  } };
  const result = await extractor.extract({ events, runtime });
  assert.deepEqual(result, { status: "succeeded", episodes: [{ kind: "decision", title: "The turn records a decision to ship a safe migration.", summary: "The turn records a decision to ship a safe migration.", importance: .9 }] });
  const malformed = await extractor.extract({ events, runtime: { async complete() { return { text: "not json" }; } } });
  assert.deepEqual(malformed, { status: "failed", category: "invalid_model_response" });
});

test("smart episode lifecycle records only a source-linked episode after the public runtime completion", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-v626-smart-")), dbPath = join(directory, "memory.db");
  const config = {
    dbPath,
    scope: { default: "work" },
    conversationJournal: { enabled: true, maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact", retentionDays: 0 },
    episodicMemory: { enabled: true, autoExtract: true, smartExtraction: { enabled: true, maxInputChars: 1000, maxOutputChars: 1000, maxEpisodesPerTurn: 3, timeoutMs: 1000, minImportance: .5 } }
  };
  const journal = new ConversationJournalService(config, () => new Mnemora({ config }));
  try {
    const receipt = journal.captureCompletedTurn({ sessionId: "smart", userText: "We decided to ship the safe migration.", assistantText: "I will prepare the release checklist." });
    assert.ok(receipt?.inserted);
    let calls = 0;
    await journal.processCapturedTurn(receipt, { async complete() { calls++; return { text: JSON.stringify({ episodes: [{ kind: "decision", summary: "A safe migration release was decided.", importance: .9 }] }) }; } });
    const graph = new Mnemora({ config });
    try {
      assert.equal(calls, 1);
      const episode = graph.store.db.prepare("SELECT kind,summary FROM mnemora_episodes WHERE scope=?").get("work");
      assert.deepEqual({ ...episode }, { kind: "decision", summary: "A safe migration release was decided." });
      assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_nodes").get().n, 0);
      assert.equal(graph.store.db.prepare("SELECT status FROM mnemora_derived_tasks WHERE kind='smart_episode'").get().status, "succeeded");
    } finally { graph.close(); }
  } finally { try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows may retain a SQLite handle briefly. */ } }
});
