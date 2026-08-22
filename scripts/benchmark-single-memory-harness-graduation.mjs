import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Mnemora } from "../dist/index.js";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { UnifiedRetrievalService } from "../dist/retrieval/service.js";
import { normalizeConfig } from "../dist/config.js";
import { PluginRuntime } from "../dist/plugin-runtime.js";

const directory = mkdtempSync(join(tmpdir(), "mnemora-graduation-"));
const dbPath = join(directory, "memory.db");
const config = normalizeConfig({
  dbPath,
  mode: "standalone",
  conversationJournal: { enabled: true },
  contextEngine: { enabled: true, maxSummaryChars: 500, protectedRecentEvents: 2 },
  episodicMemory: { enabled: true },
  unifiedRetrieval: { enabled: true, tokenBudget: 240, maxItems: 4, minConfidence: .5 },
  embeddings: { enabled: true, model: "graduation-fixture" }
});
const policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" };
const fixtureEmbedder = {
  async embed(inputs) {
    return { identity: { provider: "ollama", model: "graduation-fixture", dimensions: 2 }, vectors: inputs.map(value => /semiconductor|hbm|packaging/i.test(value) ? [1, 0] : [0, 1]) };
  }
};
const open = () => new Mnemora({ config, embedder: fixtureEmbedder });
const elapsed = async (fn) => { const started = performance.now(); const value = await fn(); return { value, ms: Number((performance.now() - started).toFixed(2)) }; };
const runtime = new PluginRuntime(config, { info() {}, warn() {} });

try {
  const selected = runtime.activateContextEngine({ config: { plugins: { slots: { contextEngine: "mnemora" }, entries: { "lossless-claw": { enabled: false }, "memory-lancedb-pro": { enabled: false }, "mnemora": { enabled: true } } } } });
  assert.equal(selected.info.id, "mnemora");
  assert.equal(runtime.standalone.activation, "ready");
  const lifecycle = await import("openclaw/plugin-sdk/agent-harness-runtime");
  const engine = new MnemoraContextEngine(config, open);
  await lifecycle.bootstrapHarnessContextEngine({ contextEngine: engine, hadSessionFile: false, sessionId: "graduation", sessionFile: "session.jsonl", warn() {} });
  const capture = await elapsed(() => lifecycle.finalizeHarnessContextEngineTurn({
    contextEngine: engine, promptError: false, aborted: false, yieldAborted: false,
    sessionIdUsed: "graduation", sessionFile: "session.jsonl", prePromptMessageCount: 0, warn() {},
    messagesSnapshot: [
      { id: "g-1", role: "user", content: "For coding work, the user prefers TypeScript.", timestamp: 1 },
      { id: "g-2", role: "assistant", content: "I will use TypeScript.", timestamp: 2 }
    ]
  }));
  assert.equal(capture.value.postTurnFinalizationSucceeded, true);
  const assemble = await elapsed(() => lifecycle.assembleHarnessContextEngine({
    contextEngine: engine, sessionId: "graduation", messages: [{ id: "g-3", role: "user", content: "Help me code in TypeScript", timestamp: 3 }],
    prompt: "TypeScript coding", tokenBudget: 512, modelId: "graduation-fixture"
  }));
  assert.match(assemble.value?.systemPromptAddition ?? "", /MNEMORA_MEMORY/);

  const graph = open();
  try {
    graph.kg_memory({ operation: "store", scope: "default", title: "Packaging constraint", content: "HBM packaging capacity is a semiconductor supply-chain bottleneck." });
    graph.kg_memory({ operation: "store", scope: "private", title: "Private unrelated note", content: "HBM only appears in this private note." });
    await graph.kg_memory({ operation: "embed_backfill", scope: "default", limit: 100 });
    await graph.kg_memory({ operation: "embed_backfill", scope: "private", limit: 100 });
    const lexical = await elapsed(() => new UnifiedRetrievalService(graph.store.db, policy).find({ scope: "default", query: "TypeScript", tokenBudget: 240 }));
    const semantic = await elapsed(() => graph.kg_memory({ operation: "search", scope: "default", query: "semiconductor supply chain", mode: "semantic" }));
    const empty = new UnifiedRetrievalService(graph.store.db, policy).find({ scope: "default", query: "unrelated quantum orchard", tokenBudget: 240 });
    const crossScope = await graph.kg_memory({ operation: "search", scope: "default", query: "semiconductor supply chain", mode: "semantic" });
    assert.equal(lexical.value.empty, false);
    assert.equal(semantic.value.length, 1);
    assert.equal(semantic.value[0].title, "Packaging constraint");
    assert.equal(empty.empty, true);
    assert.equal(crossScope.some(item => item.title === "Private unrelated note"), false);
    console.log(JSON.stringify({
      benchmark: "single-memory-harness-graduation-v6",
      host: { openclaw: "2026.6.11", lifecycle: "public-agent-harness-runtime", legacy_plugins: "disabled-in-qualified-topology" },
      gates: { durable_capture: true, one_prompt_producer: true, lexical_recall: true, semantic_recall: true, valid_empty_recall: true, scope_isolation: true },
      metrics: { capture_ms: capture.ms, assemble_ms: assemble.ms, lexical_retrieval_ms: lexical.ms, semantic_retrieval_ms: semantic.ms, selected_lexical_items: lexical.value.candidates.length, selected_semantic_items: semantic.value.length, token_budget: 240 }
    }, null, 2));
  } finally { graph.close(); }
} finally {
  runtime.stop();
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows can retain a bounded transient SQLite handle. */ }
}
