import assert from "node:assert/strict";
import test from "node:test";
import { Mnemora, createInspectorApplication } from "../dist/index.js";

test("trust dashboard is scope-isolated, aggregate-only, and available in read-only Inspector mode", async () => {
  const now = 1_700_000_000_000;
  const graph = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { enabled: true, recall: { canary: { enabled: true } } } }, now: () => now });
  try {
    await graph.kg_ingest("Acme confirms a bounded trust dashboard.", "manual:SECRET-source", { entities: [{ name: "Acme", type: "company", confidence: .9, evidence_span: "Acme confirms a bounded trust dashboard." }], relations: [] }, "project:alpha");
    const app = createInspectorApplication({ graph, allowOperations: false, artifactDirectory: "./unused" , now: () => now });
    const alpha = app.trust({ scope: "project:alpha" });
    assert.deepEqual({ kind: alpha.kind, scope: alpha.scope, verification: alpha.verification, sources: alpha.sources, recall: alpha.recall }, {
      kind: "trust_dashboard", scope: "project:alpha", verification: { total: 1, by_status: { pending: 1 } }, sources: { total: 1, by_status: { available: 1 } }, recall: { adaptive_configured: true, canary_active: false, recent_canary_runs: 0 }
    });
    assert.deepEqual(alpha.queue, { total: 0, by_status: {}, stale_leases: 0 });
    assert.deepEqual(alpha.governance, { enabled: false, principals: 0, grants: { total: 0, by_status: {} }, approvals: { total: 0, by_status: {} }, decisions: { total: 0, by_outcome: {} } });
    assert.deepEqual(app.trust({ scope: "project:beta" }).verification, { total: 0, by_status: {} });
    assert.doesNotMatch(JSON.stringify(alpha), /SECRET|confirms a bounded/i);
    assert.equal(app.operationPreview, undefined);
  } finally { graph.close(); }
});
