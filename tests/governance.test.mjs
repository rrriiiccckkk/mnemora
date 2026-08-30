import assert from "node:assert/strict";
import test from "node:test";
import { Mnemora, GraphologyStore, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";

const extraction = { entities: [{ name: "Acme", type: "company", confidence: .9, evidence_span: "Acme evidence" }], relations: [] };
const sourceRef = { provider: "memory-lancedb-pro", externalId: "memory:acme" };

function transitionHash(graph, verification) {
  return graph.governance.requestHash({
    action: "verification.transition", scope: verification.scope, resource_id: verification.id,
    details: { status: "verified", support_type: "direct", verification_confidence: .9, source_quality: .8, verifier_kind: null, reason_code: null }
  });
}

test("governance schema is additive and absent from normal default behavior", async () => {
  const store = new GraphologyStore(":memory:");
  try {
    assert.equal(SUPPORTED_SCHEMA_VERSION, 73);
    assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kg_governance_principals'").get().name, "kg_governance_principals");
  } finally { store.close(); }

  const graph = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { enabled: true, verification: { enabled: true } } }, extractor: { extract: async () => extraction } });
  try {
    await graph.ingestItem({ text: "Acme evidence", source: "memory-lancedb-pro:memory:acme", sourceRef });
    const [pending] = graph.kg_verify({ operation: "list" });
    assert.equal(graph.kg_verify({ operation: "transition", verification_id: pending.id, status: "verified", support_type: "direct", confirm: true }).verification.status, "verified");
    assert.equal(graph.governance.active, false);
  } finally { graph.close(); }
});

test("governance controls scoped profile selections and conflict decisions without mutating evidence", () => {
  const graph = new Mnemora({
    config: { dbPath: ":memory:", quality: { singleValuedEdgeTypes: ["works_at"] }, trustLayer: { governance: { enabled: true, requireApprovalFor: [] } } },
    governanceActorId: "agent:research"
  });
  try {
    graph.governanceRepository.registerPrincipal({ id: "human:owner", kind: "human" });
    graph.governanceRepository.registerPrincipal({ id: "agent:research", kind: "agent" });
    graph.store.ingest([
      { name: "Alice", type: "person", confidence: 1, evidence_span: "Alice" },
      { name: "Acme", type: "company", confidence: 1, evidence_span: "Acme" },
      { name: "Beta", type: "company", confidence: 1, evidence_span: "Beta" }
    ], [
      { source: "Alice", target: "Acme", type: "works_at", confidence: .9, evidence_span: "first" },
      { source: "Alice", target: "Beta", type: "works_at", confidence: .8, evidence_span: "second" }
    ], "fixture", 0, undefined, "research");
    const preview = graph.kg_profile_lock({ action: "set", subject: "Alice", field_key: "works_at", target_id: "company:beta", scope: "research" });
    assert.equal(preview.status, "ready");
    assert.throws(() => graph.kg_profile_lock({ action: "set", subject: "Alice", field_key: "works_at", target_id: "company:beta", scope: "research", preview_hash: preview.preview_hash, confirm: true }), /governance_denied/);
    graph.governanceRepository.grant({ principal_id: "agent:research", scope: "research", action: "profile.selection", issued_by: "human:owner" });
    assert.equal(graph.kg_profile_lock({ action: "set", subject: "Alice", field_key: "works_at", target_id: "company:beta", scope: "research", preview_hash: preview.preview_hash, confirm: true }).status, "confirmed");
    const candidate = graph.kg_review("anomalies", "pending", true, 20, undefined, undefined, undefined, "research").items[0];
    assert.throws(() => graph.kg_review("anomalies", "pending", false, 20, undefined, candidate.id, "rejected", "research"), /governance_denied/);
    graph.governanceRepository.grant({ principal_id: "agent:research", scope: "research", action: "conflict.resolve", issued_by: "human:owner" });
    assert.equal(graph.kg_review("anomalies", "pending", false, 20, undefined, candidate.id, "rejected", "research").status, "rejected");
    assert.equal(graph.governanceRepository.events("research", 10).filter(event => event.action !== "verification.transition").length, 4);
  } finally { graph.close(); }
});

test("governance binds authority to the host actor, exact scope, and a human approval", async () => {
  const graph = new Mnemora({
    config: { dbPath: ":memory:", trustLayer: { enabled: true, verification: { enabled: true }, governance: { enabled: true, requireApprovalFor: ["verification.transition"] } } },
    extractor: { extract: async () => extraction },
    governanceActorId: "agent:research"
  });
  try {
    graph.governanceRepository.registerPrincipal({ id: "human:owner", kind: "human" });
    graph.governanceRepository.registerPrincipal({ id: "agent:research", kind: "agent" });
    graph.governanceRepository.grant({ principal_id: "agent:research", scope: "research", action: "verification.transition", issued_by: "human:owner" });
    await graph.ingestItem({ text: "Acme evidence", source: "memory-lancedb-pro:memory:acme", scope: "research", sourceRef });
    const [pending] = graph.kg_verify({ operation: "list", scope: "research" });
    assert.throws(() => graph.kg_verify({ operation: "transition", verification_id: pending.id, status: "verified", support_type: "direct", verification_confidence: .9, source_quality: .8, confirm: true }), /governance_denied/);
    const hash = transitionHash(graph, pending);
    const approval = graph.governance.requestApproval({ actor_id: "agent:research", action: "verification.transition", scope: "research", resource_id: pending.id, request_hash: hash });
    assert.equal(approval.status, "pending");
    assert.throws(() => graph.governance.approve({ approval_id: approval.id, actor_id: "agent:research", approve: true }), /invalid_governance_approval/);
    assert.equal(graph.governance.approve({ approval_id: approval.id, actor_id: "human:owner", approve: true }).status, "approved");
    assert.equal(graph.kg_verify({ operation: "transition", verification_id: pending.id, status: "verified", support_type: "direct", verification_confidence: .9, source_quality: .8, approval_id: approval.id, confirm: true }).verification.status, "verified");
    assert.equal(graph.store.db.prepare("SELECT status FROM kg_governance_approvals WHERE id=?").get(approval.id).status, "consumed");
    // Both transitions can legitimately share a millisecond.  UUID ordering
    // is intentionally opaque, so assert the audit semantics rather than an
    // incidental insertion order.
    const denied = graph.store.db.prepare("SELECT outcome,reason FROM kg_governance_events WHERE outcome='denied' AND reason='approval_required' LIMIT 1").get();
    assert.equal(denied.outcome, "denied");
    assert.equal(denied.reason, "approval_required");
    const outcomes = graph.governanceRepository.events("research", 5).map(event => event.outcome).sort();
    assert.deepEqual(outcomes, ["allowed", "denied"]);
  } finally { graph.close(); }
});

test("a grant in another scope cannot authorize a verification transition", async () => {
  const graph = new Mnemora({
    config: { dbPath: ":memory:", trustLayer: { enabled: true, verification: { enabled: true }, governance: { enabled: true, requireApprovalFor: [] } } },
    extractor: { extract: async () => extraction }, governanceActorId: "agent:research"
  });
  try {
    graph.governanceRepository.registerPrincipal({ id: "human:owner", kind: "human" });
    graph.governanceRepository.registerPrincipal({ id: "agent:research", kind: "agent" });
    graph.governanceRepository.grant({ principal_id: "agent:research", scope: "other", action: "verification.transition", issued_by: "human:owner" });
    await graph.ingestItem({ text: "Acme evidence", source: "memory-lancedb-pro:memory:acme", scope: "research", sourceRef });
    const [pending] = graph.kg_verify({ operation: "list", scope: "research" });
    assert.throws(() => graph.kg_verify({ operation: "transition", verification_id: pending.id, status: "verified", support_type: "direct", confirm: true }), /governance_denied/);
    assert.equal(graph.store.db.prepare("SELECT reason FROM kg_governance_events ORDER BY created_at DESC,id DESC LIMIT 1").get().reason, "missing_grant");
  } finally { graph.close(); }
});
