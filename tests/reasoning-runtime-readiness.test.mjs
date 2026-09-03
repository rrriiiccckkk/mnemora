import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { GraphologyStore } from "../dist/store.js";
import { SUPPORTED_SCHEMA_VERSION } from "../dist/schema.js";
import { ReasoningRuntimeGovernanceRepository } from "../dist/cognition/reasoning-runtime-governance.js";
import { ReasoningRuntimeTelemetryRepository } from "../dist/cognition/reasoning-runtime-telemetry.js";

const scope = "project:alpha";
const config = {
  tokenBudget: 800, maxItems: 6, minConfidence: .6, highRiskMinConfidence: .8, minEvidenceQuality: .5, highRiskMinEvidenceQuality: .75, maxStalenessDays: 365, excludeConflicted: true, retentionDays: 30,
  readiness: { minimumRuns: 1, maxErrorRate: .05, maxEmptyRate: .8, maxP95Ms: 1000 },
  delivery: { enabled: true, scopes: [scope], adapter: "openclaw", calibrationMaxAgeHours: 24, maxConsecutiveDeliveries: 2, itemRetentionDays: 30 },
  semantic: { enabled: true, timeoutMs: 1500, minScore: .35, maxCandidates: 50 }
};

test("live runtime policy snapshots make exact scope readiness auditable without retaining task content", () => {
  let now = 1_000; const store = new GraphologyStore(":memory:");
  try {
    const telemetry = new ReasoningRuntimeTelemetryRepository(store.db, () => now), governance = new ReasoningRuntimeGovernanceRepository(store.db, () => now);
    telemetry.record({ scope, status: "succeeded", triggered: true, highRisk: false, candidateCount: 4, selectedCount: 1, qualityExcluded: 1, semanticCandidates: 2, unmatched: 3, taskTypeExcluded: 2, empty: false, estimatedTokens: 120, durationMs: 25 });
    const snapshot = governance.observePolicy(scope, config), reloaded = governance.policySnapshot(scope), diagnostics = governance.diagnostics(scope);
    assert.deepEqual({ version: snapshot.version, scope: reloaded?.scope, enabled: reloaded?.config.delivery.enabled, semantic: reloaded?.config.semantic?.enabled, candidates: diagnostics.readiness.metrics.candidates, selected: diagnostics.retrieval.selectedPerTriggeredRun, misses: diagnostics.retrieval.queryMissesPerTriggeredRun, blocker: diagnostics.retrieval.dominantExclusion, configured: diagnostics.delivery.configured, efficacy: diagnostics.efficacy.status }, { version: "reasoning-runtime-policy-snapshot-v1", scope, enabled: true, semantic: true, candidates: 4, selected: 1, misses: 3, blocker: "query", configured: true, efficacy: "not_measured" });
    assert.equal(diagnostics.readiness.ready, true);
    assert.equal(diagnostics.delivery.canary.active, false);
    assert.doesNotMatch(JSON.stringify(diagnostics), /secret task content|strategy|memory_id|source_ref/i);
    const calibration = governance.previewCalibration(scope, reloaded.config);
    assert.equal(calibration.status, "ready");
    now += 1;
    const confirmed = governance.confirmCalibration(scope, reloaded.config, calibration.preview_hash);
    assert.equal(confirmed.status, "confirmed");
  } finally { store.close(); }
});

test("schema v70 adds policy snapshots without rebuilding existing runtime telemetry", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-runtime-policy-")), path = join(directory, "memory.db"); let store;
  try {
    store = new GraphologyStore(path);
    new ReasoningRuntimeTelemetryRepository(store.db).record({ scope, status: "succeeded", triggered: true, highRisk: false, candidateCount: 1, selectedCount: 1, qualityExcluded: 0, empty: false, estimatedTokens: 1, durationMs: 1 });
    store.db.exec("DROP TABLE mnemora_reasoning_runtime_policy_snapshots; PRAGMA user_version=69");
    store.close(); store = new GraphologyStore(path);
    assert.equal(SUPPORTED_SCHEMA_VERSION, 76);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='mnemora_reasoning_runtime_policy_snapshots'").get().value, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_reasoning_runtime_shadow_runs WHERE scope=?").get(scope).value, 1);
  } finally { try { store?.close(); } catch {} try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});
