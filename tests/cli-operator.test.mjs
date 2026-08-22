import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const execute = (...args) => {
  const result = spawnSync(process.execPath, ["dist/cli.js", ...args], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, MNEMORA_DB: ":memory:" } });
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : undefined, error: result.stderr ? JSON.parse(result.stderr) : undefined };
};

test("operator CLI evaluates tool surfaces without opening a graph and returns stable JSON", () => {
  const result = execute("surface", "core");
  assert.equal(result.status, 0);
  assert.deepEqual({ ok: result.json.ok, command: result.json.command, tools: result.json.result.tool_count, baseline: result.json.result.baseline.tool_count }, { ok: true, command: "surface.evaluate", tools: 10, baseline: 32 });
  assert.equal(result.json.result.reduction.schema_percent > 0, true);
});

test("operator recall-quality evaluation stays local, redacts the submitted golden set, and never changes admission", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-evaluation-")), file = join(directory, "reviewed.json");
  try {
    writeFileSync(file, JSON.stringify({ version: 1, id: "operator.deidentified.v1", cases: [{ id: "empty-1", kind: "empty_recall", scope: "project:alpha", query: "operator-private-query", expectedRefs: [], topK: 10 }] }));
    const result = execute("evaluate", "recall-quality", file);
    assert.equal(result.status, 0);
    assert.deepEqual({ command: result.json.command, version: result.json.result.version, evidence: result.json.result.evidence_kind, admission: result.json.result.automated_admission_decision, cases: result.json.result.report.metrics.cases }, { command: "evaluate.recall-quality", version: "recall-quality-operator-v1", evidence: "operator_asserted_deidentified", admission: "not_performed", cases: 1 });
    assert.doesNotMatch(JSON.stringify(result.json), /operator-private-query|project:alpha/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("operator CLI keeps trust reads structured and guards mutations behind explicit confirmation", () => {
  const status = execute("trust", "status", "--scope", "project:alpha");
  assert.equal(status.status, 0);
  assert.deepEqual({ ok: status.json.ok, command: status.json.command, scope: status.json.result.scope, verifications: status.json.result.verifications }, { ok: true, command: "trust.status", scope: "project:alpha", verifications: [] });
  const guarded = execute("trust", "queue", "--scope", "project:alpha");
  assert.equal(guarded.status, 0);
  assert.deepEqual(guarded.json, { ok: true, command: "trust.queue", result: { status: "confirm_required", operation: "trust.queue" } });
});

test("operator CLI provides profile and recall read paths plus bounded public errors", () => {
  const profile = execute("profile", "show", "unknown", "--scope", "project:alpha");
  assert.equal(profile.status, 0);
  assert.deepEqual({ ok: profile.json.ok, command: profile.json.command, status: profile.json.result.status, scope: profile.json.result.scope }, { ok: true, command: "profile.show", status: "not_found", scope: "project:alpha" });
  const recall = execute("recall", "status", "--scope", "project:alpha");
  assert.equal(recall.status, 0);
  assert.equal(recall.json.result.scope, "project:alpha");
  const sources = execute("trust", "sources", "--scope", "project:alpha");
  assert.deepEqual({ ok: sources.json.ok, command: sources.json.command, lifecycle: sources.json.result.lifecycle_version }, { ok: true, command: "trust.sources", lifecycle: "source-lifecycle-v1" });
  const history = execute("profile", "history", "unknown", "--scope", "project:alpha");
  assert.deepEqual({ ok: history.json.ok, command: history.json.command, status: history.json.result.status }, { ok: true, command: "profile.history", status: "not_found" });
  const explain = execute("recall", "explain", "unknown", "--scope", "project:alpha");
  assert.deepEqual({ ok: explain.json.ok, command: explain.json.command, trace: explain.json.result.trace_version }, { ok: true, command: "recall.explain", trace: "recall-explain-v1" });
  const invalid = execute("trust", "jobs", "--limit", "101");
  assert.equal(invalid.status, 1);
  assert.deepEqual(invalid.error, { ok: false, command: "trust.jobs", error: { code: "invalid_arguments" } });
});

test("operator CLI exposes local governance administration without adding an agent tool", () => {
  const status = execute("governance", "status", "--scope", "project:alpha");
  assert.equal(status.status, 0);
  assert.deepEqual({ ok: status.json.ok, command: status.json.command, enabled: status.json.result.enabled, scope: status.json.result.scope, events: status.json.result.events }, { ok: true, command: "governance.status", enabled: false, scope: "project:alpha", events: [] });
  const guarded = execute("governance", "principal-register", "human:owner", "human");
  assert.equal(guarded.status, 0);
  assert.deepEqual(guarded.json, { ok: true, command: "governance.principal-register", result: { status: "confirm_required", operation: "governance.principal-register" } });
});

test("standalone CLI is read-only and returns activation guide, readiness, and rollback guidance", () => {
  const guide = execute("standalone", "guide");
  assert.deepEqual({ ok: guide.json.ok, command: guide.json.command, mode: guide.json.result.standalone.mode }, { ok: true, command: "standalone.guide", mode: "standalone" });
  const status = execute("standalone", "status");
  assert.deepEqual({ ok: status.json.ok, command: status.json.command, activation: status.json.result.activation }, { ok: true, command: "standalone.status", activation: "blocked" });
  const rollback = execute("standalone", "rollback");
  assert.deepEqual(rollback.json.result.host_context_engine, { contextEngine: { enabled: false }, unifiedRetrieval: { enabled: false } });
});

test("operator CLI exposes read-only Journal diagnostics", () => {
  const status = execute("journal", "status");
  assert.equal(status.status, 0);
  assert.deepEqual(status.json, { ok: true, command: "journal.status", result: { enabled: false, events: 0, sessions: 0, pendingTasks: 0 } });
});

test("operator CLI exposes only the read-only recall-decay review", () => {
  const review = execute("memory", "decay-review", "--scope", "project:alpha", "--min-age-days", "90");
  assert.deepEqual({ ok: review.json.ok, command: review.json.command, version: review.json.result.version, mutation: review.json.result.mutation, candidates: review.json.result.candidates }, { ok: true, command: "memory.decay-review", version: "recall-decay-review-v1", mutation: "none", candidates: [] });
});

test("operator CLI exposes prepared compaction runs and requires explicit reconciliation confirmation", () => {
  const prepared = execute("journal", "compaction", "prepared", "--scope", "project:alpha");
  assert.deepEqual(prepared.json, { ok: true, command: "journal.compaction", result: { scope: "project:alpha", runs: [] } });
  const guarded = execute("journal", "compaction", "reconcile", "unknown", "rewrite_not_applied", "--scope", "project:alpha");
  assert.deepEqual(guarded.json.result, { status: "confirm_required", operation: "journal.compaction.reconcile" });
});

test("operator CLI keeps Decision Memory preview-first and outside the agent tool surface", () => {
  const preview = execute("cognition", "decision", "create", "Choose SQLite");
  assert.equal(preview.status, 0);
  assert.equal(preview.json.result.status, "preview");
  const guarded = execute("cognition", "decision", "create", "Choose SQLite", "--confirm");
  assert.deepEqual(guarded.json.result, { status: "preview_confirmation_required", preview_hash: preview.json.result.preview_hash });
  const confirmed = execute("cognition", "decision", "create", "Choose SQLite", "--preview-hash", preview.json.result.preview_hash, "--confirm");
  assert.deepEqual({ status: confirmed.json.result.status, objective: confirmed.json.result.objective, maker: confirmed.json.result.decisionMaker }, { status: "active", objective: "Choose SQLite", maker: "user" });
  const definitions = readFileSync("src/openclaw.ts", "utf8");
  assert.doesNotMatch(definitions, /descriptor\("kg_decision"/);
});

test("operator CLI keeps Outcome Ledger operator-only and confirmation-gated", () => {
  const summary = execute("cognition", "outcome", "summary", "--scope", "project:alpha");
  assert.deepEqual(summary.json, { ok: true, command: "cognition.outcome", result: { scope: "project:alpha", outcomes: {} } });
  const definitions = readFileSync("src/openclaw.ts", "utf8");
  assert.doesNotMatch(definitions, /descriptor\("kg_outcome"/);
});

test("operator CLI keeps ReasoningMemory local, read-gated, and outside the agent tool surface", () => {
  const summary = execute("cognition", "reasoning", "summary", "--scope", "project:alpha");
  assert.deepEqual(summary.json, { ok: true, command: "cognition.reasoning", result: { scope: "project:alpha", memories: {} } });
  const conflicts = execute("cognition", "reasoning", "conflicts", "--scope", "project:alpha");
  assert.deepEqual(conflicts.json, { ok: true, command: "cognition.reasoning", result: [] });
  const retrieve = execute("cognition", "reasoning", "retrieve", "rollback", "--scope", "project:alpha");
  assert.deepEqual({ ok: retrieve.json.ok, command: retrieve.json.command, version: retrieve.json.result.version, empty: retrieve.json.result.empty }, { ok: true, command: "cognition.reasoning", version: "reasoning-retrieval-v1", empty: true });
  const reflection = execute("cognition", "reasoning", "reflection", "preview", "--scope", "project:alpha");
  assert.deepEqual({ ok: reflection.json.ok, command: reflection.json.command, proposals: reflection.json.result.proposals }, { ok: true, command: "cognition.reasoning", proposals: [] });
  const compiled = execute("cognition", "reasoning", "compile", "rollback", "--scope", "project:alpha", "--adapter", "codex");
  assert.deepEqual({ ok: compiled.json.ok, command: compiled.json.command, adapter: compiled.json.result.adapterId, channel: compiled.json.result.channel }, { ok: true, command: "cognition.reasoning", adapter: "codex", channel: "sidecar" });
  const runtime = execute("cognition", "reasoning", "runtime", "deploy production migration", "--scope", "project:alpha");
  assert.deepEqual({ ok: runtime.json.ok, command: runtime.json.command, mode: runtime.json.result.decision.mode, retrieve: runtime.json.result.decision.shouldRetrieve }, { ok: true, command: "cognition.reasoning", mode: "shadow", retrieve: true });
  const metrics = execute("cognition", "reasoning", "runtime-metrics", "--scope", "project:alpha");
  assert.deepEqual({ version: metrics.json.result.version, runs: metrics.json.result.runs }, { version: "reasoning-shadow-metrics-v1", runs: 0 });
  const readiness = execute("cognition", "reasoning", "runtime-readiness", "--scope", "project:alpha");
  assert.deepEqual({ version: readiness.json.result.version, ready: readiness.json.result.ready, delivery: readiness.json.result.deliveryEnabled }, { version: "reasoning-runtime-readiness-v1", ready: false, delivery: false });
  const calibration = execute("cognition", "reasoning", "runtime-calibrate", "--scope", "project:alpha");
  assert.deepEqual({ version: calibration.json.result.version, status: calibration.json.result.status }, { version: "reasoning-runtime-calibration-preview-v1", status: "rejected" });
  const canary = execute("cognition", "reasoning", "runtime-canary-status", "--scope", "project:alpha");
  assert.deepEqual({ version: canary.json.result.version, configured: canary.json.result.configured, active: canary.json.result.active }, { version: "reasoning-runtime-canary-v1", configured: false, active: false });
  const deliveries = execute("cognition", "reasoning", "runtime-deliveries", "--scope", "project:alpha"); assert.deepEqual(deliveries.json.result, []);
  const rollback = execute("cognition", "reasoning", "runtime-rollback", "--scope", "project:alpha"); assert.equal(rollback.json.result.status, "confirm_required");
  const definitions = readFileSync("src/openclaw.ts", "utf8");
  assert.doesNotMatch(definitions, /descriptor\("kg_reasoning"/);
});

test("operator CLI exposes the Personal Context Compiler as a bounded read-only command", () => {
  const compiled = execute("cognition", "context", "compile", "storage", "--scope", "project:alpha", "--token-budget", "64", "--max-items", "1");
  assert.equal(compiled.status, 0);
  assert.deepEqual({ ok: compiled.json.ok, command: compiled.json.command, scope: compiled.json.result.scope, tokenBudget: compiled.json.result.tokenBudget, items: compiled.json.result.items }, { ok: true, command: "cognition.context", scope: "project:alpha", tokenBudget: 64, items: [] });
  const invalid = execute("cognition", "context", "compile", "storage", "--token-budget", "63");
  assert.equal(invalid.status, 1);
  assert.deepEqual(invalid.error, { ok: false, command: "cognition.context", error: { code: "invalid_arguments" } });
});

test("operator CLI keeps reflection preview-first and feedback confirmation-gated", () => {
  const preview = execute("cognition", "reflection", "preview", "--scope", "project:alpha");
  assert.equal(preview.status, 0);
  assert.equal(typeof preview.json.result.preview_hash, "string");
  const guarded = execute("cognition", "reflection", "run", "--scope", "project:alpha");
  assert.deepEqual(guarded.json.result.status, "confirm_required");
  const feedback = execute("cognition", "feedback", "list", "--scope", "project:alpha");
  assert.deepEqual({ ok: feedback.json.ok, command: feedback.json.command, result: feedback.json.result }, { ok: true, command: "cognition.feedback", result: [] });
});

test("operator CLI exposes C8 graduation evidence as a read-only status", () => {
  const status = execute("cognition", "graduation", "status", "--scope", "project:alpha");
  assert.equal(status.status, 0);
  assert.deepEqual({ ok: status.json.ok, command: status.json.command, scope: status.json.result.scope, checked: status.json.result.audit.checked, ready: status.json.result.ready }, { ok: true, command: "cognition.graduation", scope: "project:alpha", checked: 0, ready: false });
});
