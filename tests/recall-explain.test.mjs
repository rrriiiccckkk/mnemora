import assert from "node:assert/strict";
import test from "node:test";
import { Mnemora } from "../dist/index.js";

const extraction = {
  entities: [{ name: "Acme", type: "company", confidence: .9, evidence_span: "TOP SECRET: Acme supplies advanced packaging." }],
  relations: []
};

test("recall explanation is redacted, claim-level, and has no recall side effects", async () => {
  const graph = new Mnemora({
    config: { dbPath: ":memory:", recall: { autoRecall: true }, trustLayer: { enabled: true, verification: { enabled: true }, recall: { shadowMode: true } } },
    extractor: { extract: async () => extraction }
  });
  try {
    await graph.ingestItem({ text: "TOP SECRET: Acme supplies advanced packaging.", source: "super-secret-source", sourceRef: { provider: "memory-lancedb-pro", externalId: "memory:acme" } });
    const before = {
      claims: graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_claim_recall_metrics").get().n,
      shadow: graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_recall_shadow_runs").get().n,
      canary: graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_recall_canary_runs").get().n
    };
    const pending = await graph.kg_recall_explain({ query: "Acme", mode: "lexical", token_budget: 800 });
    assert.equal(pending.trace_version, "recall-explain-v1");
    assert.equal(pending.policy.allowed, false);
    assert.equal(pending.strict_verification_enabled, true);
    assert.match(pending.query_hash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(pending), /TOP SECRET|super-secret-source|memory:acme|snapshot|quote/i);
    const candidate = pending.candidates.find(item => item.kind === "node");
    assert.ok(candidate);
    assert.equal(candidate.decision, "excluded");
    assert.equal(candidate.reason, "unverified_evidence");
    assert.equal(candidate.claims.length, 1);
    assert.equal(candidate.claims[0].anchors[0].provider, "memory-lancedb-pro");
    assert.equal(candidate.claims[0].anchors[0].verification_status, "pending");
    assert.deepEqual({
      claims: graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_claim_recall_metrics").get().n,
      shadow: graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_recall_shadow_runs").get().n,
      canary: graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_recall_canary_runs").get().n
    }, before);

    const [verification] = graph.kg_verify({ operation: "list" });
    graph.kg_verify({ operation: "transition", verification_id: verification.id, status: "verified", support_type: "direct", confirm: true });
    const verified = await graph.kg_recall_explain({ query: "Acme", mode: "lexical", token_budget: 800 });
    const verifiedCandidate = verified.candidates.find(item => item.kind === "node");
    assert.equal(verified.policy.allowed, true);
    assert.equal(verifiedCandidate.decision, "included");
    assert.equal(verifiedCandidate.reason, "verified_evidence");
    assert.equal(verifiedCandidate.claims[0].eligible, true);
  } finally { graph.close(); }
});

test("disabled strict verification explains legacy inclusion without anchoring a query", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" }, extractor: { extract: async () => extraction } });
  try {
    await graph.ingestItem({ text: "TOP SECRET: Acme supplies advanced packaging.", source: "super-secret-source" });
    const explanation = await graph.kg_recall_explain({ query: "Acme", mode: "lexical" });
    assert.equal(explanation.strict_verification_enabled, false);
    assert.equal(explanation.policy.reason, "disabled");
    assert.equal(explanation.candidates.find(item => item.kind === "node").reason, "verification_disabled");
  } finally { graph.close(); }
});
