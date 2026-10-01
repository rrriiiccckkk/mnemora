import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createTempDir } from "./helpers/temp.mjs";
import { Mnemora, normalizeConfig, createMnemoraContextRef, RecallAttachmentEvidenceService } from "../dist/index.js";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { RecallUsageRepository } from "../dist/recall-lifecycle/repository.js";
import { FirstUseVerificationRepository } from "../dist/standalone/first-use-repository.js";

for (const [mode, embeddings] of [["lexical", false], ["hybrid", false], ["hybrid", true], ["semantic", true]]) {
  test(`kg_context recordAccess=false preserves ${mode} recall (embeddings=${embeddings}) without reinforcement`, async () => {
    const config = normalizeConfig({ dbPath: ":memory:", memory: { lifecycle: { enabled: true, accessReinforcement: true } }, embeddings: { enabled: embeddings, model: "fixture-write-policy" } });
    const embedder = embeddings ? { async embed(inputs) { return { identity: { provider: "ollama", model: "fixture-write-policy", dimensions: 2 }, vectors: inputs.map(() => [1, 0]) }; } } : undefined;
    const graph = new Mnemora({ config, embedder, now: () => 1_700_000_000_000 });
    try {
      graph.kg_memory({ operation: "store", title: "Production release checklist", content: "Production release requires signed approval." });
      if (embeddings) await graph.kg_memory({ operation: "embed_backfill", scope: "default", limit: 10 });
      const baseline = graph.memoryLifecycle.review("default").items;
      const recall = options => graph.kg_context("Production release", 1, 1, .5, 600, mode, undefined, "default", options);
      const readOnly = await recall({ recordMetrics: false, recordAccess: false });
      assert.match(readOnly.context, /Production release checklist/);
      assert.deepEqual(graph.memoryLifecycle.review("default").items, baseline, "recordAccess=false must reach every memory-search ranking path");
      const writable = await recall({ recordMetrics: false });
      assert.deepEqual(readOnly, writable, "write disposition must not change recall content or ranking");
      assert.equal(graph.memoryLifecycle.review("default").items[0].access_count, baseline[0].access_count + 1, "omitting recordAccess preserves default reinforcement");
    } finally { graph.close(); }
  });
}

for (const sessionId of ["writable", "stateless", "ignored", "", "   "]) {
  test(`ContextEngine recall honors session write policy while preserving read access for ${JSON.stringify(sessionId)}`, async () => {
    const config = normalizeConfig({
      dbPath: join(createTempDir("assembly-write-policy-"), "memory.db"),
      contextEngine: { enabled: true, maxContextTokens: 1200 },
      conversationJournal: { statelessSessionPatterns: ["stateless"], ignoreSessionPatterns: ["ignored"] },
      memory: { lifecycle: { enabled: true, accessReinforcement: true } },
      unifiedRetrieval: { enabled: true, shadowMode: true, attachmentEvidence: { enabled: true }, tokenBudget: 600, minConfidence: .5 }
    });
    const open = () => new Mnemora({ config });
    let marker, document, baseline;
    const read = graph => ({
      usage: new RecallUsageRepository(graph.store.db).summary("default"),
      lifecycle: graph.memoryLifecycle.review("default").items,
      shadow: graph.kg_recall_metrics().unified,
      acceptance: new FirstUseVerificationRepository(graph.store.db).status("default"),
      receipts: new RecallAttachmentEvidenceService(graph.store.db).review({ scope: "default", targetRef: createMnemoraContextRef({ scope: "default", kind: "memory-document", id: document.id }) }).receipts
    });
    const graph = open();
    try {
      const firstUse = new FirstUseVerificationRepository(graph.store.db);
      ({ marker } = firstUse.start("default"));
      document = graph.kg_memory({ operation: "store", title: "Production release checklist", content: `Production release requires a reviewed preview. Acceptance marker: ${marker}` });
      firstUse.recordCapture({ scope: "default", sessionId: "source", texts: [marker] });
      baseline = read(graph);
      assert.equal(baseline.acceptance.state, "awaiting_cross_session_attachment");
    } finally { graph.close(); }
    const result = await new MnemoraContextEngine(config, open).assemble({ sessionId, prompt: `Production release ${marker}`, messages: [{ role: "user", content: "Prepare production release" }], tokenBudget: 1200 });
    assert.match(result.systemPromptAddition ?? "", /Production release requires a reviewed preview/);
    assert.match(result.systemPromptAddition, new RegExp(marker));
    const verify = open();
    try {
      const after = read(verify);
      if (sessionId === "writable") {
        assert.deepEqual(after.usage, { trackedTargets: 1, trackedRecalls: 1 });
        assert.equal(after.lifecycle[0].access_count, 2, "writable sessions retain existing graph-search and attachment reinforcement");
        assert.equal(after.shadow.summary.total_runs, 1);
        assert.equal(after.acceptance.state, "verified");
        assert.equal(after.receipts.length, 1);
      } else assert.deepEqual(after, baseline, "read-only session must not leave recall telemetry or alter lifecycle/acceptance state");
    } finally { verify.close(); }
  });
}

for (const sessionId of ["stateless", "ignored"]) {
  test(`ContextEngine retains graph evidence expansion in read-only ${sessionId} sessions`, async () => {
    const config = normalizeConfig({
      dbPath: join(createTempDir("assembly-graph-read-policy-"), "memory.db"),
      contextEngine: { enabled: true, maxContextTokens: 1200 },
      conversationJournal: { statelessSessionPatterns: ["stateless"], ignoreSessionPatterns: ["ignored"] },
      unifiedRetrieval: { enabled: true, shadowMode: true, tokenBudget: 800, minConfidence: .5 }
    });
    const open = () => new Mnemora({ config });
    const graph = open();
    try {
      graph.store.ingest([{ name: "Production release", type: "concept", confidence: .9, evidence_span: "Production release requires signed approval." }], [], "manual:fixture");
    } finally { graph.close(); }
    const result = await new MnemoraContextEngine(config, open).assemble({ sessionId, prompt: "Production release", messages: [{ role: "user", content: "Prepare production release" }], tokenBudget: 1200 });
    assert.match(result.systemPromptAddition ?? "", /Graph evidence expansion/);
    assert.match(result.systemPromptAddition, /Production release/);
    const verify = open();
    try {
      assert.equal(verify.kg_recall_metrics().unified.summary.total_runs, 0);
      assert.deepEqual(new RecallUsageRepository(verify.store.db).summary("default"), { trackedTargets: 0, trackedRecalls: 0 });
    } finally { verify.close(); }
  });
}
