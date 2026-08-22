import assert from "node:assert/strict";
import test from "node:test";
import { Mnemora } from "../dist/index.js";

const extraction = { entities: [{ name: "Acme", type: "company", confidence: .9, evidence_span: "Acme supplies advanced packaging." }], relations: [] };
const external = { provider: "memory-lancedb-pro", externalId: "memory:acme" };

test("verification transitions are audited, state-machine-bound, and require explicit confirmation", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { enabled: true, verification: { enabled: true } } }, extractor: { extract: async () => extraction } });
  try {
    await graph.ingestItem({ text: "Acme supplies advanced packaging.", source: "memory-lancedb-pro:memory:acme", sourceRef: external });
    const [pending] = graph.kg_verify({ operation: "list", scope: "default" });
    assert.equal(pending.status, "pending");
    assert.throws(() => graph.kg_verify({ operation: "transition", verification_id: pending.id, status: "verified", support_type: "direct" }), /confirmation_required/);
    const transitioned = graph.kg_verify({ operation: "transition", verification_id: pending.id, status: "verified", support_type: "direct", verification_confidence: .9, source_quality: .8, confirm: true });
    assert.equal(transitioned.verification.status, "verified");
    assert.equal(transitioned.verification.extraction_confidence, .9);
    assert.equal(graph.store.db.prepare("SELECT from_status,to_status,reason_code FROM kg_verification_transitions WHERE verification_id=?").get(pending.id).to_status, "verified");
    assert.throws(() => graph.kg_verify({ operation: "transition", verification_id: pending.id, status: "rejected", support_type: "none", confirm: true }), /invalid_verification_transition/);
  } finally { graph.close(); }
});

test("strict automatic recall excludes pending claims while disabled policy preserves legacy behavior", async () => {
  const strict = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { enabled: true, verification: { enabled: true } } }, extractor: { extract: async () => extraction } });
  const legacy = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { enabled: true } }, extractor: { extract: async () => extraction } });
  try {
    await strict.ingestItem({ text: "Acme supplies advanced packaging.", source: "memory-lancedb-pro:memory:acme", sourceRef: external });
    await legacy.ingestItem({ text: "Acme supplies advanced packaging.", source: "memory-lancedb-pro:memory:acme", sourceRef: external });
    assert.equal(strict.gateAutomaticRecall(await strict.kg_context("Acme", 5, 1, 0, 800, "lexical")).allowed, false);
    assert.equal(legacy.gateAutomaticRecall(await legacy.kg_context("Acme", 5, 1, 0, 800, "lexical")).allowed, true);
    const [pending] = strict.kg_verify({ operation: "list" });
    strict.kg_verify({ operation: "transition", verification_id: pending.id, status: "verified", support_type: "direct", confirm: true });
    const decision = strict.gateAutomaticRecall(await strict.kg_context("Acme", 5, 1, 0, 800, "lexical"));
    assert.deepEqual(decision, { allowed: true, evaluated_sources: 1, excluded_sources: 0, reason: "verified" });
  } finally { strict.close(); legacy.close(); }
});

test("a changed external content hash preserves history and marks the prior verification stale with an audit row", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { enabled: true, verification: { enabled: true } } }, extractor: { extract: async () => extraction } });
  try {
    await graph.ingestItem({ text: "Acme supplies advanced packaging.", source: "memory-lancedb-pro:memory:acme", sourceRef: external });
    const [first] = graph.kg_verify({ operation: "list" });
    graph.kg_verify({ operation: "transition", verification_id: first.id, status: "verified", support_type: "direct", confirm: true });
    await graph.ingestItem({ text: "Acme supplies advanced packaging. The current revision is newer.", source: "memory-lancedb-pro:memory:acme", sourceRef: external, force: true });
    assert.equal(graph.store.db.prepare("SELECT status FROM kg_claim_verifications WHERE id=?").get(first.id).status, "stale");
    assert.equal(graph.store.db.prepare("SELECT status FROM kg_source_anchors WHERE id=(SELECT source_anchor_id FROM kg_claim_verifications WHERE id=?)").get(first.id).status, "changed");
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_verification_transitions WHERE verification_id=? AND to_status='stale' AND reason_code='source_changed'").get(first.id).n, 1);
    assert.equal(graph.gateAutomaticRecall(await graph.kg_context("Acme", 5, 1, 0, 800, "lexical")).allowed, false);
  } finally { graph.close(); }
});
