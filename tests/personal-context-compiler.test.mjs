import assert from "node:assert/strict";
import test from "node:test";
import { createMnemoraContextRef } from "../dist/context/context-ref.js";
import { PersonalContextCompiler } from "../dist/cognition/context-compiler.js";
import { DecisionMemoryService } from "../dist/cognition/decisions.js";
import { FormationService } from "../dist/cognition/service.js";
import { GraphologyStore } from "../dist/store.js";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { normalizeConfig } from "../dist/config.js";

test("Personal Context Compiler is scoped, provenance-linked, bounded, and read-only", () => {
  let now = 10_000;
  const store = new GraphologyStore(":memory:");
  try {
    const formation = new FormationService(store.db, () => ++now, { mode: "enforce", beliefs: { enabled: true } });
    const first = formation.observe({ scope: "project:alpha", origin: "memory_store", authority: "user_explicit_preference", kind: "memory_document", source: "user:1", content: "I prefer concise technical explanations." });
    const firstBelief = store.db.prepare("SELECT id,recorded_at FROM mnemora_beliefs WHERE scope=?").get("project:alpha");
    formation.observe({ scope: "project:alpha", origin: "memory_store", authority: "user_correction", kind: "memory_document", source: "user:2", content: "I prefer detailed technical explanations with necessary examples.", priorBeliefId: firstBelief.id });
    const candidateRef = createMnemoraContextRef({ scope: "project:alpha", kind: "memory-candidate", id: first.id });
    const decisions = new DecisionMemoryService(store.db, () => ++now);
    const decision = { scope: "project:alpha", objective: "Choose a local persistence layer", chosenAction: "Use SQLite", decisionMaker: "user", confidence: .9, evidence: [{ sourceRef: candidateRef, relation: "supports" }] };
    decisions.confirm(decision, decisions.preview(decision).preview_hash);
    formation.observe({ scope: "project:beta", origin: "memory_store", authority: "user_explicit_preference", kind: "memory_document", source: "user:3", content: "This must never leak across scopes." });
    const before = store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_cognition_audits").get().n;
    const compiler = new PersonalContextCompiler(store.db);
    const current = compiler.compile({ scope: "project:alpha", tokenBudget: 128, maxItems: 8 });
    assert.equal(current.scope, "project:alpha");
    assert.ok(current.estimatedTokens <= 128);
    assert.ok(current.items.some(item => item.kind === "belief" && /detailed/i.test(item.text)));
    assert.ok(current.items.some(item => item.kind === "decision" && /SQLite/i.test(item.text)));
    assert.ok(current.items.some(item => item.kind === "belief" && item.authority === "user_correction"));
    assert.ok(current.items.some(item => item.kind === "decision" && item.authority === "user_explicit_preference"));
    assert.ok(current.items.every(item => item.refs.every(ref => ref.includes("project%3Aalpha"))));
    assert.equal(JSON.stringify(current).includes("never leak"), false);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_cognition_audits").get().n, before);
    const historic = compiler.compile({ scope: "project:alpha", historicalAt: firstBelief.recorded_at, tokenBudget: 128 });
    assert.ok(historic.items.some(item => /concise/i.test(item.text)));
    assert.equal(historic.items.some(item => /detailed/i.test(item.text)), false);
    const filtered = compiler.compile({ scope: "project:alpha", query: "sqlite", tokenBudget: 128 });
    assert.deepEqual(filtered.items.map(item => item.kind), ["decision"]);
    const controller = new AbortController(); controller.abort(new Error("stop"));
    assert.throws(() => compiler.compile({ scope: "project:alpha", signal: controller.signal }), /stop/);
  } finally { store.close(); }
});

test("ContextEngine preserves the public host result contract and never turns compiled context into a prompt message", async () => {
  const config = normalizeConfig({ dbPath: ":memory:", contextEngine: { enabled: true, maxContextTokens: 512 }, cognition: { contextCompiler: { enabled: true, tokenBudget: 128, maxItems: 4 } } });
  const engine = new MnemoraContextEngine(config, () => {
    const store = new GraphologyStore(":memory:");
    return { store, personalContext: new PersonalContextCompiler(store.db), close() { store.close(); } };
  });
  const current = { role: "user", content: "What did I choose for storage?" };
  const assembled = await engine.assemble({ sessionId: "session", messages: [{ role: "system", content: "host policy" }, current] });
  assert.deepEqual(assembled.messages, [{ role: "system", content: "host policy" }, current]);
  assert.equal("systemPromptAddition" in assembled, false);
  assert.equal("personalContext" in assembled, false);
  assert.equal(JSON.stringify(assembled.messages).includes("Decision:"), false);
});
