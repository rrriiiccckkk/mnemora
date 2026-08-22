import assert from "node:assert/strict";
import test from "node:test";
import { Mnemora, FormationService, GraphologyStore, isLowInformationAutomaticInput } from "../dist/index.js";

test("pre-admission keeps only hashed, scope-bound source diversity and drops an exact same-source repeat", () => {
  let now = 1;
  const store = new GraphologyStore(":memory:");
  try {
    const service = new FormationService(store.db, () => ++now, { preAdmissionMode: "enforce" });
    const input = { scope: "personal", origin: "automatic_extract", authority: "user_self_report", kind: "graph_extraction", entities: 1, relations: 0, content: "I prefer concise technical explanations." };
    const first = service.observe({ ...input, source: "session:one:turn:a" });
    assert.deepEqual(first.preAdmission, { decision: "accept", reason: "new_evidence", sourceCount: 1, sessionCount: 1, confidenceMultiplier: 1 });
    const sameSource = service.observe({ ...input, source: "session:one:turn:a" });
    assert.equal(sameSource.created, false);
    assert.equal(sameSource.preAdmission.reason, "same_source_duplicate");
    const sameSession = service.observe({ ...input, source: "session:one:turn:b" });
    assert.deepEqual(sameSession.preAdmission, { decision: "accept", reason: "same_session_repeat", sourceCount: 2, sessionCount: 2, confidenceMultiplier: .5 });
    const independent = service.observe({ ...input, source: "session:two:turn:a" });
    assert.deepEqual(independent.preAdmission, { decision: "accept", reason: "multi_source_support", sourceCount: 3, sessionCount: 1, confidenceMultiplier: 1.16 });
    const otherScope = service.observe({ ...input, scope: "work", source: "session:one:turn:c" });
    assert.deepEqual(otherScope.preAdmission, { decision: "accept", reason: "new_evidence", sourceCount: 1, sessionCount: 1, confidenceMultiplier: 1 });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_cognition_pre_admissions WHERE scope='personal'").get().value, 3);
    const persisted = JSON.stringify(store.db.prepare("SELECT * FROM mnemora_cognition_pre_admissions").all());
    assert.doesNotMatch(persisted, /concise technical|session:one/);
  } finally { store.close(); }
});

test("pre-admission is off by default and exact low-information detection is deliberately narrow", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const result = new FormationService(store.db, () => 1).observe({ scope: "personal", origin: "automatic_extract", authority: "user_self_report", kind: "graph_extraction", source: "session:one:turn:a", entities: 1, content: "好的" });
    assert.equal(result.preAdmission, undefined);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_cognition_pre_admissions").get().value, 0);
    assert.equal(isLowInformationAutomaticInput("  谢谢！ "), true);
    assert.equal(isLowInformationAutomaticInput("okay"), true);
    assert.equal(isLowInformationAutomaticInput("Yes, please explain the migration plan."), false);
    assert.equal(isLowInformationAutomaticInput("确认"), false);
    assert.equal(isLowInformationAutomaticInput("是"), false);
    assert.equal(isLowInformationAutomaticInput("否"), false);
    assert.equal(isLowInformationAutomaticInput("yes"), false);
    assert.equal(isLowInformationAutomaticInput("no"), false);
  } finally { store.close(); }
});

test("enforced automatic formation drops low-information evidence and discounts repeated same-session confidence", async () => {
  const extraction = { entities: [{ name: "Acme", type: "company", confidence: .8, evidence_span: "Acme" }], relations: [] };
  const graph = new Mnemora({
    config: { dbPath: ":memory:", cognition: { formationShadow: true, admission: { mode: "enforce", preAdmission: { mode: "enforce" } } } }
  });
  try {
    const dropped = await graph.ingestAutomaticExtraction({ text: "好的", source: "session:low:turn:a", extraction });
    assert.deepEqual(dropped, { status: "succeeded", source: "session:low:turn:a", fingerprint: dropped.fingerprint, counts: { entities: 0, relations: 0, observations: 0 }, warnings: [{ category: "pre_admission_dropped" }] });
    assert.equal(graph.store.stats().nodes.total, 0);
    await graph.ingestAutomaticExtraction({ text: "Acme is part of the plan.", source: "session:repeat:turn:a", extraction });
    await graph.ingestAutomaticExtraction({ text: "Acme is part of the plan.", source: "session:repeat:turn:b", extraction });
    const rows = graph.store.db.prepare("SELECT source,confidence FROM kg_observations ORDER BY source").all().map(row => ({ source: row.source, confidence: row.confidence }));
    assert.deepEqual(rows, [{ source: "session:repeat:turn:a", confidence: .8 }, { source: "session:repeat:turn:b", confidence: .4 }]);
  } finally { graph.close(); }
});
