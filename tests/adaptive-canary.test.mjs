import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { Mnemora, createOpenClawToolDefinitions, evaluateAdaptiveRecallShadow } from "../dist/index.js";

const candidates = [
  { id: "company:one", score: 1 },
  { id: "company:two", score: .72 },
  { id: "company:three", score: .1 }
];
const shadowConfig = { shadowMode: true, absoluteFloor: 0, relativeCutoffRatio: .8, confidenceGate: .6, minKeep: 1, candidateMultiplier: 5 };

test("adaptive recall stays shadow-only until a scoped, calibrated canary is explicitly enabled and can be rolled back", () => {
  let now = 100;
  const graph = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { recall: { shadowMode: true, absoluteFloor: 0, relativeCutoffRatio: .8, confidenceGate: .6, minKeep: 1, candidateMultiplier: 5, canary: { enabled: true, modelId: "fixture-v1", scopes: ["project:alpha"] } } } }, now: () => ++now });
  try {
    assert.deepEqual(graph.kg_recall_canary({ operation: "status", scope: "project:alpha" }), { scope: "project:alpha", configured: true, active: false, recent_runs: 0 });
    for (let index = 0; index < 3; index++) graph.recallShadowRepository.record("project:alpha", evaluateAdaptiveRecallShadow({ candidates, fixed: candidates.slice(0, 2), limit: 2, config: shadowConfig }), ++now);
    const preview = graph.kg_recall_canary({ operation: "calibrate", scope: "project:alpha", criteria: { minimum_runs: 3, max_empty_rate: 0, min_overlap_rate: 1 } });
    assert.equal(preview.status, "preview");
    const calibration = graph.kg_recall_canary({ operation: "calibrate", scope: "project:alpha", criteria: { minimum_runs: 3, max_empty_rate: 0, min_overlap_rate: 1 }, preview_hash: preview.preview_hash, confirm: true });
    assert.equal(calibration.status, "confirmed");
    assert.equal(calibration.calibration.status, "ready");
    const enablePreview = graph.kg_recall_canary({ operation: "enable", scope: "project:alpha", calibration_id: calibration.calibration.id });
    assert.equal(enablePreview.status, "stale_preview");
    assert.equal(graph.kg_recall_canary({ operation: "enable", scope: "project:alpha", calibration_id: calibration.calibration.id, preview_hash: enablePreview.preview, confirm: true }).status, "confirmed");
    const active = graph.kg_recall_canary({ operation: "status", scope: "project:alpha" });
    assert.equal(active.active, true);
    const applied = graph.recallCanaryRepository.active("project:alpha");
    assert.equal(applied?.model_id, "fixture-v1");
    assert.equal(graph.kg_recall_canary({ operation: "rollback", scope: "project:alpha" }).status, "confirm_required");
    const rolledBack = graph.kg_recall_canary({ operation: "rollback", scope: "project:alpha", confirm: true });
    assert.equal(rolledBack.active, false);
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_recall_canary_runs").get().n, 0);
  } finally { graph.close(); }
});

test("canary configuration and tool schema remain bounded, explicit, and scope-isolated", async () => {
  const disabled = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    assert.equal(disabled.kg_recall_canary({ operation: "status", scope: "project:alpha" }).configured, false);
    assert.equal(disabled.config.trustLayer?.recall?.canary?.enabled, false);
  } finally { disabled.close(); }
  let received;
  const graph = { kg_recall_canary(input) { received = input; return { status: "preview" }; }, close() {} };
  const tool = createOpenClawToolDefinitions(() => graph).find(item => item.name === "kg_recall_canary");
  const valid = { operation: "calibrate", scope: "project:alpha", criteria: { minimum_runs: 25, max_empty_rate: .2, min_overlap_rate: .7 } };
  assert.equal(Check(tool.parameters, valid), true);
  assert.equal(Check(tool.parameters, { operation: "calibrate", criteria: { maximum_runs: 3 } }), false);
  assert.equal(Check(tool.parameters, { operation: "enable", calibration_id: "x", preview_hash: "a".repeat(64), confirm: true }), true);
  assert.equal(Check(tool.parameters, { operation: "rollback", confirm: true, extra: true }), false);
  assert.deepEqual(JSON.parse((await tool.execute("canary", valid)).content[0].text), { status: "preview" });
  assert.deepEqual(received, valid);
});
