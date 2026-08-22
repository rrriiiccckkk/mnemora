import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Mnemora } from "../dist/index.js";

const oneDay = 86_400_000;
const entityExtraction = { entities: [{ name: "Acme", type: "company", confidence: .9, evidence_span: "Acme is current." }], relations: [] };

test("source lifecycle is redacted and distinguishes freshness from source-change revalidation", async () => {
  let now = oneDay * 100;
  const graph = new Mnemora({
    config: { dbPath: ":memory:", trustLayer: { enabled: true, verification: { enabled: true } } },
    extractor: { extract: async () => entityExtraction }, now: () => now
  });
  try {
    await graph.ingestItem({ text: "Acme is current.", source: "secret-source-label", sourceRef: { provider: "memory-lancedb-pro", externalId: "memory:secret" } });
    let report = graph.kg_verify({ operation: "sources", freshness_after_days: 30 });
    assert.equal(report.summary.fresh, 1);
    assert.equal(report.items[0].source_status, "available");
    assert.doesNotMatch(JSON.stringify(report), /secret-source-label|memory:secret|Acme is current/i);

    const [verification] = graph.kg_verify({ operation: "list" });
    graph.kg_verify({ operation: "transition", verification_id: verification.id, status: "verified", support_type: "direct", confirm: true });
    now += oneDay * 31;
    report = graph.kg_verify({ operation: "sources", freshness_after_days: 30 });
    assert.equal(report.items[0].freshness, "overdue");

    graph.verificationRepository.markSourceChanged({ scope: "default", provider: "memory-lancedb-pro", external_id: "memory:secret", content_hash: createHash("sha256").update("changed content").digest("hex") });
    report = graph.kg_verify({ operation: "sources", freshness_after_days: 30 });
    assert.equal(report.items[0].source_status, "changed");
    assert.equal(report.items[0].freshness, "unavailable");
    assert.equal(report.items[0].revalidation_required, true);
  } finally { graph.close(); }
});

test("a material conflict schedules bounded local retrospective review only when opt-in audit is enabled", async () => {
  const extraction = {
    entities: [
      { name: "Alice", type: "person", confidence: .9, evidence_span: "Alice works at Acme and Beta." },
      { name: "Acme", type: "company", confidence: .9, evidence_span: "Alice works at Acme." },
      { name: "Beta", type: "company", confidence: .9, evidence_span: "Alice works at Beta." }
    ],
    relations: [
      { source: "Alice", target: "Acme", type: "works_at", confidence: .9, evidence_span: "Alice works at Acme." },
      { source: "Alice", target: "Beta", type: "works_at", confidence: .8, evidence_span: "Alice works at Beta." }
    ]
  };
  const graph = new Mnemora({
    config: { dbPath: ":memory:", quality: { singleValuedEdgeTypes: ["works_at"] }, trustLayer: { enabled: true, verification: { enabled: true, retrospectiveAudit: { enabled: true } } } },
    extractor: { extract: async () => extraction }
  });
  try {
    await graph.kg_ingest("Alice works at Acme and Beta.", "conflict-fixture");
    for (const verification of graph.kg_verify({ operation: "list" })) graph.kg_verify({ operation: "transition", verification_id: verification.id, status: "verified", support_type: "direct", confirm: true });
    const scheduled = graph.kg_verify({ operation: "audits" });
    assert.equal(scheduled.length > 0, true);
    assert.deepEqual(scheduled[0].risk_signals, ["contradiction_evidence"]);
    // Re-scanning remains idempotent after a conflict-triggered audit exists.
    const review = graph.kg_review("anomalies", "pending", true);
    assert.equal(review.scan.created + review.scan.updated > 0, true);
    assert.equal(review.revalidation_schedule[0].scope, "default");
    assert.equal(review.revalidation_schedule[0].scheduled, 0);
    const audits = graph.kg_verify({ operation: "audits" });
    assert.equal(audits.length > 0, true);
    assert.deepEqual(audits[0].risk_signals, ["contradiction_evidence"]);
  } finally { graph.close(); }
});
