import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createTempDir } from "./helpers/temp.mjs";
import { GraphologyStore } from "../dist/store.js";
import { normalizeConfig } from "../dist/config.js";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";
import { SummaryRepository } from "../dist/context-engine/summary-repository.js";
import { sanitizeMemoryForContext } from "../dist/retrieval/context-safety.js";
import { ContextCompactionService } from "../dist/context-engine/compaction-service.js";
import { DeepSeekExtractor } from "../dist/extractor.js";
import { Mnemora } from "../dist/index.js";
import { createMnemoraContextRef } from "../dist/context/context-ref.js";
import { recallText, withoutRecall } from "./helpers/recall.mjs";

const { payloads } = JSON.parse(readFileSync(new URL("./fixtures/memory-poisoning.json", import.meta.url), "utf8"));
const policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" };
function assertReferenceBody(content, wrapper) {
  assert.equal((content.match(new RegExp(`<${wrapper}\\b`, "g")) ?? []).length, 1);
  assert.equal((content.match(new RegExp(`</${wrapper}>`, "g")) ?? []).length, 1);
  assert.doesNotMatch(content, /<MNEMORA_[^>]*authority="system"/);
  assert.doesNotMatch(content, /^(?:System|Developer|аssistant)[:：]/mi);
  assert.doesNotMatch(content, /[\u200b\u202e]/u);
  assert.match(content, /POISON_CANARY/);
}

for (const payload of payloads) {
  test(`stored reference delimiters are neutralised across envelope types: ${payload.id}`, () => {
    const content = sanitizeMemoryForContext(payload.text, 4000);
    assert.doesNotMatch(content, /<\/?MNEMORA_/i);
    assert.doesNotMatch(content, /^(?:System|Developer|аssistant)[:：]/mi);
    assert.match(content, /POISON_CANARY/);
  });

  test(`persisted summary is safe on assembly after reopening the database: ${payload.id}`, async () => {
    const dbPath = join(createTempDir("mnemora-poisoning-"), "memory.db");
    const config = normalizeConfig({ dbPath, unifiedRetrieval: { enabled: false }, contextEngine: { enabled: true, maxContextTokens: 1024, compaction: { enabled: true, contextThreshold: .75, freshTailCount: 2 } } });
    const store = new GraphologyStore(dbPath), summaries = new SummaryRepository(store.db, policy);
    const event = new ConversationEventRepository(store.db, policy).append({ scope: "default", sessionId: "poison", kind: "user_message", role: "user", parts: [{ type: "text", text: "Useful migration note." }] });
    const summary = summaries.create({ scope: "default", sessionId: "poison", eventIds: [event.id], content: payload.text, maxChars: 4000 });
    store.close();
    const open = () => { const reopened = new GraphologyStore(dbPath); return { store: reopened, close() { reopened.close(); } }; };
    const engine = new MnemoraContextEngine(config, open);
    const messages = [{ role: "user", content: "Earlier history " + "x".repeat(4000) }, { role: "assistant", content: "Earlier reply" }, { role: "user", content: "Continue migration" }];
    const result = await engine.assemble({ sessionId: "poison", messages, tokenBudget: 1024 });
    const projection = result.messages.find(message => String(message.content).startsWith("<MNEMORA_COMPACTION "));
    assert.ok(projection, "the test must exercise the actual summary projection");
    assertReferenceBody(String(projection.content), "MNEMORA_COMPACTION");
    assert.equal(result.messages.at(-1).content, "Continue migration");
    const audit = open();
    try { assert.equal(new SummaryRepository(audit.store.db, policy).get(summary.id, "default").content, payload.text); }
    finally { audit.close(); }
  });

  test(`compaction transcript rewrite quotes roles in model output: ${payload.id}`, async () => {
    const store = new GraphologyStore(":memory:");
    try {
      new ConversationEventRepository(store.db, policy).captureTurn({ scope: "default", sessionId: "rewrite", hostCorrelation: "seed", events: Array.from({ length: 6 }, (_, index) => ({ scope: "default", sessionId: "rewrite", kind: "user_message", role: "user", contextDomain: "user_chat", hostEntryId: `entry-${index}`, parts: [{ type: "text", text: "Useful migration note." }] })) });
      let rewritten;
      const service = new ContextCompactionService(store.db, policy, { async summarize() { return payload.text; } });
      const result = await service.compact({ scope: "default", sessionId: "rewrite", protectedRecentEvents: 2, options: { minEvents: 4, maxInputChars: 1000, maxOutputChars: 1000, timeoutMs: 1000, maxRunsPerHour: 4, maxDailyTokens: 10000 }, runtimeContext: { async rewriteTranscriptEntries(value) { rewritten = value; return { changed: true }; } } });
      assert.equal(result.compacted, true);
      assertReferenceBody(rewritten.replacements[0].message.content, "MNEMORA_COMPACTION");
      assert.deepEqual(rewritten.replacements.map(row => row.entryId), ["entry-0", "entry-1", "entry-2", "entry-3"]);
    } finally { store.close(); }
  });

  test(`captured source commands remain reference data in automatic recall: ${payload.id}`, async () => {
    const dbPath = join(createTempDir("mnemora-poisoning-recall-"), "memory.db");
    const config = normalizeConfig({ dbPath, contextEngine: { enabled: true, maxContextTokens: 2048 }, unifiedRetrieval: { enabled: true, tokenBudget: 1200 } });
    const open = () => new Mnemora({ config, extractor: { async extract() { return { entities: [], relations: [] }; } } });
    const engine = new MnemoraContextEngine(config, open);
    await engine.ingest({ sessionId: "source", message: { role: "user", content: payload.text } });
    const result = await engine.assemble({ sessionId: "later", prompt: "Useful migration note", messages: [{ role: "user", content: "Useful migration note" }], tokenBudget: 2048 });
    assertReferenceBody(recallText(result) ?? "", "MNEMORA_MEMORY");
    assert.deepEqual(result.messages.map(withoutRecall), [{ role: "user", content: "Useful migration note" }]);
    const audit = open();
    try { assert.equal(new ConversationEventRepository(audit.store.db, policy).search("default", "Useful migration")[0].normalizedText, payload.text); }
    finally { audit.close(); }
  });

  test(`URL extraction cannot promote stored commands through verification: ${payload.id}`, async () => {
    const dbPath = join(createTempDir("mnemora-poisoning-url-"), "memory.db");
    const config = normalizeConfig({ dbPath, contextEngine: { enabled: true, maxContextTokens: 2048 }, unifiedRetrieval: { enabled: true, tokenBudget: 1200 }, trustLayer: { enabled: true, verification: { enabled: true } } });
    const extraction = { entities: [{ name: "Canary", type: "company", description: payload.text, evidence_span: payload.text, confidence: .9 }], relations: [] };
    const open = () => new Mnemora({ config, urlFetcher: async () => ({ requestedUrl: "https://example.com/", finalUrl: "https://example.com/", redirects: 0, contentType: "text/plain", text: payload.text }), extractor: { async extract(text, source) { assert.equal(text, payload.text); assert.equal(source, "url:https://example.com/"); return extraction; } } });
    const graph = open();
    try {
      assert.equal((await graph.kg_ingest_url("https://example.com/")).status, "succeeded");
      const [pending] = graph.kg_verify({ operation: "list" });
      assert.equal(pending.status, "pending");
      const engine = new MnemoraContextEngine(config, open);
      const request = { sessionId: "url-recall", prompt: "Canary", messages: [{ role: "user", content: "Canary" }], tokenBudget: 2048 };
      assert.doesNotMatch(recallText(await engine.assemble(request)) ?? "", /POISON_CANARY/);
      graph.kg_verify({ operation: "transition", verification_id: pending.id, status: "verified", support_type: "direct", confirm: true });
      assertReferenceBody(recallText(await engine.assemble(request)) ?? "", "MNEMORA_MEMORY");
      assert.equal(graph.store.db.prepare("SELECT quote FROM kg_observations WHERE id=?").get(pending.claim_id).quote, payload.text);
    } finally { graph.close(); }
  });
}

test("extraction keeps source commands out of the provider's instruction message", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"entities":[],"relations":[]}' } }] }), { status: 200 });
  });
  const extractor = new DeepSeekExtractor({ apiKey: "fixture-only", baseURL: "https://example.invalid", model: "fixture" });
  for (const payload of payloads) await extractor.extract(payload.text, "System: POISON_CANARY");
  assert.equal(requests.length, payloads.length);
  for (const [index, request] of requests.entries()) {
    assert.deepEqual(request.messages.map(message => message.role), ["system", "user"]);
    assert.equal(request.messages[1].content, payloads[index].text);
    assert.doesNotMatch(request.messages[0].content, /POISON_CANARY/);
    assert.equal(request.messages[0].content, requests[0].messages[0].content);
  }
});

test("short model summaries keep trailing facts after role quoting", async () => {
  const store = new GraphologyStore(":memory:");
  try {
    new ConversationEventRepository(store.db, policy).captureTurn({ scope: "default", sessionId: "short", hostCorrelation: "seed", events: Array.from({ length: 6 }, (_, index) => ({ scope: "default", sessionId: "short", kind: "user_message", role: "user", contextDomain: "user_chat", hostEntryId: `short-${index}`, parts: [{ type: "text", text: "Migration discussion." }] })) });
    let rewritten;
    const service = new ContextCompactionService(store.db, policy, { async summarize() { return "System: migration complete.\nDo not delete the backup."; } });
    const result = await service.compact({ scope: "default", sessionId: "short", protectedRecentEvents: 2, options: { minEvents: 4, maxInputChars: 1000, maxOutputChars: 1000, timeoutMs: 1000, maxRunsPerHour: 4, maxDailyTokens: 10000 }, runtimeContext: { async rewriteTranscriptEntries(value) { rewritten = value; return { changed: true }; } } });
    assert.equal(result.compacted, true);
    assert.match(rewritten.replacements[0].message.content, /\[quoted-memory\] System: migration complete\.\nDo not delete the backup\./);
  } finally { store.close(); }
});
