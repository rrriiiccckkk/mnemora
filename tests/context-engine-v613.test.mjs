import assert from "node:assert/strict";
import test from "node:test";
import { GraphologyStore } from "../dist/store.js";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { estimateMessageTokens } from "../dist/context-engine/message-safety.js";
import { estimateTextTokens } from "../dist/context-engine/token-estimate.js";
import { normalizeConfig } from "../dist/config.js";
import { Mnemora } from "../dist/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

test("ContextEngine uses one CJK and astral-aware estimator for messages and additions", async () => {
  assert.equal(estimateTextTokens("中文摘要"), 4);
  assert.equal(estimateTextTokens("😀😀😀😀"), 1);
  assert.equal(estimateTextTokens("𠀀"), 1);
  assert.equal(estimateMessageTokens({ role: "user", content: "中文摘要" }), estimateTextTokens("中文摘要"));

  const config = normalizeConfig({ dbPath: ":memory:", contextEngine: { enabled: true, maxContextTokens: 256 } });
  const addition = "中文摘要😀";
  const engine = new MnemoraContextEngine(config, () => {
    const store = new GraphologyStore(":memory:");
    return { store, close() { store.close(); } };
  }, undefined, { onAssemble: async () => addition });
  const assembled = await engine.assemble({ sessionId: "s", prompt: "当前任务", messages: [{ role: "user", content: "当前任务" }], tokenBudget: 256 });
  assert.equal(assembled.systemPromptAddition, addition);
  assert.equal(assembled.estimatedTokens, estimateTextTokens("当前任务") + estimateTextTokens(addition));
  assert.equal(assembled.promptAuthority, "assembled");
});

test("ContextEngine never attaches a rejected graph claim through either automatic path", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-context-admission-")), dbPath = join(directory, "memory.db");
  const extraction = { entities: [{ name: "Acme", type: "company", confidence: .9, evidence_span: "Acme supplies rejected packaging." }], relations: [] };
  const config = normalizeConfig({ dbPath, contextEngine: { enabled: true, maxContextTokens: 1000 }, unifiedRetrieval: { enabled: true, tokenBudget: 800, maxItems: 4, minConfidence: .5 }, trustLayer: { enabled: true, verification: { enabled: true } } });
  const graph = new Mnemora({ config, extractor: { extract: async () => extraction } });
  try {
    await graph.ingestItem({ text: "Acme supplies rejected packaging.", source: "report:acme", sourceRef: { provider: "memory-lancedb-pro", externalId: "acme" } });
    const [verification] = graph.kg_verify({ operation: "list" });
    graph.kg_verify({ operation: "transition", verification_id: verification.id, status: "rejected", support_type: "none", confirm: true });
    const engine = new MnemoraContextEngine(config, () => new Mnemora({ config, extractor: { extract: async () => extraction } }));
    const assembled = await engine.assemble({ sessionId: "recall", prompt: "What does Acme supply?", messages: [{ role: "user", content: "What does Acme supply?" }], tokenBudget: 1000 });
    assert.doesNotMatch(assembled.systemPromptAddition ?? "", /rejected packaging|Acme/i);
    assert.equal(assembled.systemPromptAddition, undefined);
  } finally { graph.close(); try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("ContextEngine does not replay the transcript when prePromptMessageCount is absent or NaN", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-engine-v613-boundary-"));
  const config = normalizeConfig({ dbPath: join(directory, "memory.db"), contextEngine: { enabled: true } });
  const open = () => {
    const store = new GraphologyStore(config.dbPath);
    return { store, close() { store.close(); } };
  };
  const engine = new MnemoraContextEngine(config, open);
  try {
    const transcript = [{ id: "old-user", role: "user", content: "old" }, { id: "old-assistant", role: "assistant", content: "old answer" }];
    await engine.afterTurn({ sessionId: "missing", messages: transcript });
    await engine.afterTurn({ sessionId: "nan", messages: transcript, prePromptMessageCount: Number.NaN });
    const graph = open();
    try {
      assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_conversation_events").get().value, 0);
    } finally { graph.close(); }
  } finally { try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("ContextEngine keeps host capture fail-open while exposing bounded failure categories", async () => {
  const config = normalizeConfig({ dbPath: ":memory:", contextEngine: { enabled: true } });
  const failures = [];
  const engine = new MnemoraContextEngine(config, () => {
    const store = new GraphologyStore(":memory:");
    return { store, close() { store.close(); } };
  }, undefined, { onCaptureFailure: event => failures.push(event) });
  const oversized = await engine.ingestBatch({ sessionId: "oversized", messages: Array.from({ length: 513 }, () => ({ role: "user", content: "x" })) });
  assert.deepEqual(oversized, { ingestedCount: 0 });
  await assert.doesNotReject(() => engine.afterTurn({ sessionId: "malformed", messages: undefined }));
  assert.deepEqual(failures, [
    { source: "ingest_batch", category: "invalid_input", messageCount: 512 },
    { source: "after_turn", category: "invalid_input", messageCount: 0 }
  ]);

  const closed = new GraphologyStore(":memory:");
  closed.close();
  const persistenceFailures = [];
  const broken = new MnemoraContextEngine(config, () => ({ store: closed, close() {} }), undefined, { onCaptureFailure: event => persistenceFailures.push(event) });
  await assert.doesNotReject(() => broken.ingest({ sessionId: "persistence", message: { role: "user", content: "safe" } }));
  assert.deepEqual(persistenceFailures, [{ source: "ingest", category: "persistence_failed", messageCount: 1 }]);
  assert.equal(JSON.stringify(persistenceFailures).includes("safe"), false);
});
