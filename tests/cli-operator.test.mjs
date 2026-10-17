import { createTempDir } from "./helpers/temp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import test from "node:test";
import { GraphologyStore } from "../dist/store.js";

const executeAt = (database, ...args) => {
  const result = spawnSync(process.execPath, ["dist/cli.js", ...args], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, MNEMORA_DB: database } });
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : undefined, error: result.stderr ? JSON.parse(result.stderr) : undefined };
};
const execute = (...args) => executeAt(":memory:", ...args);

test("operator CLI evaluates tool surfaces without opening a graph and returns stable JSON", () => {
  const result = execute("surface", "core");
  assert.equal(result.status, 0);
  assert.deepEqual({ ok: result.json.ok, command: result.json.command, tools: result.json.result.tool_count, baseline: result.json.result.baseline.tool_count }, { ok: true, command: "surface.evaluate", tools: 10, baseline: 32 });
  assert.equal(result.json.result.reduction.schema_percent > 0, true);
});

test("operator recall-quality evaluation stays local, redacts the submitted golden set, and never changes admission", () => {
  const directory = createTempDir("mnemora-evaluation-"), file = join(directory, "reviewed.json");
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

test("operator task-resume comparison reports reviewed injection rates without exposing case records", () => {
  const directory = createTempDir("mnemora-task-comparison-"), file = join(directory, "reviewed.json");
  try {
    const plan = JSON.parse(readFileSync("fixtures/task-resume-comparison-plan-v1.json", "utf8"));
    const results = [...plan.splits.tuningCaseIds, ...plan.splits.testCaseIds].flatMap(caseId => plan.arms.map(arm => ({
      caseId,
      split: caseId.startsWith("tune") ? "tuning" : "test",
      arm,
      continuationCorrect: true,
      staleFactUsed: false,
      repeatedStep: false,
      irrelevantMemoryInjected: caseId === "test:01" && arm === "mnemora",
      tokens: 100,
      latencyMs: 20
    })));
    writeFileSync(file, JSON.stringify({ ...plan, status: "measured", results }));
    const result = execute("evaluate", "task-resume-comparison", file);
    assert.equal(result.status, 0);
    assert.deepEqual(result.json.result.metrics.mnemora.irrelevant_injection, { count: 1, rate: .5 });
    assert.doesNotMatch(JSON.stringify(result.json), /test:01|tune:01|irrelevantMemoryInjected/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("operator CLI reports the scope-local graph review decision gate without adding an agent tool", () => {
  const directory = createTempDir("mnemora-review-gate-"), database = join(directory, "memory.db"); let store;
  try {
    store = new GraphologyStore(database);
    const quote = "Build Tool depends on TypeScript.";
    store.ingest([{ name: "Build Tool", type: "product", confidence: .95, evidence_span: quote }, { name: "TypeScript", type: "technology", confidence: .95, evidence_span: quote }], [{ source: "Build Tool", target: "TypeScript", type: "related_to", confidence: .95, evidence_span: quote }], "fixture:review-gate", 0, undefined, "project:alpha");
    store.close(); store = undefined;
    const report = executeAt(database, "review", "gate", "--scope", "project:alpha");
    assert.deepEqual({ ok: report.json.ok, command: report.json.command, version: report.json.result.version, scope: report.json.result.scope, edges: report.json.result.hygiene.scoped_edges, policy: report.json.result.actions.topology_policy }, { ok: true, command: "review.gate", version: "graph-review-decision-gate-v1", scope: "project:alpha", edges: 1, policy: "not_changed" });
    const invalid = executeAt(database, "review", "gate", "--limit", "1");
    assert.deepEqual(invalid.error, { ok: false, command: "review.gate", error: { code: "invalid_arguments" } });
    assert.doesNotMatch(readFileSync("src/openclaw.ts", "utf8"), /descriptor\("kg_review_gate"/);
  } finally { try { store?.close(); } catch {} try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("operator CLI exposes scope-bound graph-review worklists and preview-confirm anomaly cleanup", () => {
  const directory = createTempDir("mnemora-review-anomalies-"), database = join(directory, "memory.db"); let store;
  try {
    store = new GraphologyStore(database);
    const quote = "NVIDIA has an erroneous self reference.";
    const ingested = store.ingest([{ name: "NVIDIA", type: "company", confidence: .95, evidence_span: quote }], [], "fixture:review-anomalies", 0, undefined, "project:alpha");
    const nodeId = ingested.entities[0].node.id, now = Date.now(), edgeId = "edge:review:self";
    store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,0,NULL,?,?)")
      .run(edgeId, nodeId, nodeId, "competes_with", "{}", now, now);
    store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,scope,quote,confidence,created_at) VALUES(?,?,NULL,?,?,?,?,?,?)")
      .run("obs:review:self", edgeId, "{}", "fixture:review-anomalies", "project:alpha", quote, .9, now);
    store.close(); store = undefined;

    const worklist = executeAt(database, "review", "worklist", "--scope", "project:alpha", "--status", "pending");
    assert.equal(worklist.status, 0);
    assert.deepEqual(worklist.json.result.items.map(item => [item.kind, item.edge_id, item.status]), [["suspicious_self_link", edgeId, "pending"]]);
    const rejected = executeAt(database, "review", "worklist", "--scope", "project:alpha", "--status", "rejected");
    assert.deepEqual(rejected.json.result.items, []);

    const preview = executeAt(database, "review", "anomalies", "preview", edgeId, "--scope", "project:alpha");
    assert.deepEqual({ confirmed: preview.json.result.confirmed, cleaned: preview.json.result.cleaned, edge_ids: preview.json.result.edge_ids }, { confirmed: false, cleaned: 0, edge_ids: [edgeId] });
    const guarded = executeAt(database, "review", "anomalies", "confirm", edgeId, "--scope", "project:alpha");
    assert.deepEqual(guarded.json.result, { status: "confirm_required", operation: "review.anomalies.confirm" });
    const stale = executeAt(database, "review", "anomalies", "confirm", edgeId, "--scope", "project:alpha", "--preview-hash", "stale", "--confirm");
    assert.deepEqual(stale.error, { ok: false, command: "review.anomalies", error: { code: "operation_failed" } });
    const confirmed = executeAt(database, "review", "anomalies", "confirm", edgeId, "--scope", "project:alpha", "--preview-hash", preview.json.result.preview_hash, "--confirm");
    assert.deepEqual({ confirmed: confirmed.json.result.confirmed, cleaned: confirmed.json.result.cleaned, edge_ids: confirmed.json.result.edge_ids, audit: typeof confirmed.json.result.audit_id === "string" }, { confirmed: true, cleaned: 1, edge_ids: [edgeId], audit: true });

    store = new GraphologyStore(database);
    assert.notEqual(store.getEdgeById(edgeId)?.deleted_at, null);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM kg_quality_audits WHERE action='cleanup_relationship_anomalies'").get().value, 1);
  } finally { try { store?.close(); } catch {} try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("operator CLI keeps semantic vocabulary collection and review scope-bound and preview-first", () => {
  const directory = createTempDir("mnemora-review-vocabulary-"), database = join(directory, "memory.db"); let store;
  try {
    store = new GraphologyStore(database);
    for (const [product, runtime, source] of [["Product One", "Runtime One", "fixture:vocabulary:a"], ["Product Two", "Runtime Two", "fixture:vocabulary:b"], ["Product Three", "Runtime Three", "fixture:vocabulary:a"]]) {
      const quote = `${product} is based on ${runtime}.`;
      store.ingest([{ name: product, type: "product", confidence: .95, evidence_span: quote }, { name: runtime, type: "technology", confidence: .95, evidence_span: quote }], [{ source: product, target: runtime, type: "related_to", confidence: .95, evidence_span: quote }], source, 0, undefined, "project:alpha");
    }
    const revision = store.graphRevision();
    store.close(); store = undefined;

    const scan = executeAt(database, "review", "vocabulary", "scan", "--scope", "project:alpha", "--limit", "20");
    assert.equal(scan.status, 0);
    assert.deepEqual({ scanned: scan.json.result.scan.scanned, promoted: scan.json.result.scan.candidates_promoted, items: scan.json.result.items.length }, { scanned: 3, promoted: 1, items: 1 });
    const candidate = scan.json.result.items[0];
    assert.deepEqual({ predicate: candidate.predicate, source: candidate.source_type, target: candidate.target_type, status: candidate.status }, { predicate: "based_on", source: "product", target: "technology", status: "pending" });
    const isolated = executeAt(database, "review", "vocabulary", "list", "--scope", "project:beta", "--status", "pending");
    assert.deepEqual(isolated.json.result.items, []);

    const preview = executeAt(database, "review", "vocabulary", "preview", candidate.id, "accepted", "--scope", "project:alpha");
    assert.deepEqual({ confirmed: preview.json.result.confirmed, eligible: preview.json.result.eligible, decision: preview.json.result.decision }, { confirmed: false, eligible: true, decision: "accepted" });
    const guarded = executeAt(database, "review", "vocabulary", "confirm", candidate.id, "accepted", "--scope", "project:alpha");
    assert.deepEqual(guarded.json.result, { status: "confirm_required", operation: "review.vocabulary.confirm" });
    const confirmed = executeAt(database, "review", "vocabulary", "confirm", candidate.id, "accepted", "--scope", "project:alpha", "--preview-hash", preview.json.result.preview_hash, "--confirm");
    assert.deepEqual({ confirmed: confirmed.json.result.confirmed, candidate: confirmed.json.result.candidate_id, decision: confirmed.json.result.decision, audit: typeof confirmed.json.result.audit_id === "string" }, { confirmed: true, candidate: candidate.id, decision: "accepted", audit: true });

    store = new GraphologyStore(database);
    assert.equal(store.graphRevision(), revision, "vocabulary review cannot mutate graph topology");
    assert.equal(store.db.prepare("SELECT status FROM kg_semantic_vocabulary_candidates WHERE id=?").get(candidate.id).status, "accepted");
  } finally { try { store?.close(); } catch {} try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("operator CLI will not preview anomaly cleanup for an edge evidenced by another scope", () => {
  const directory = createTempDir("mnemora-review-anomaly-scope-"), database = join(directory, "memory.db"); let store;
  try {
    store = new GraphologyStore(database);
    const quote = "NVIDIA has an erroneous self reference.";
    const ingested = store.ingest([{ name: "NVIDIA", type: "company", confidence: .95, evidence_span: quote }], [], "fixture:review-anomalies", 0, undefined, "project:alpha");
    const nodeId = ingested.entities[0].node.id, now = Date.now(), edgeId = "edge:review:shared-self";
    store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,0,NULL,?,?)")
      .run(edgeId, nodeId, nodeId, "competes_with", "{}", now, now);
    for (const scope of ["project:alpha", "project:beta"]) store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,scope,quote,confidence,created_at) VALUES(?,?,NULL,?,?,?,?,?,?)")
      .run(`obs:review:${scope}`, edgeId, "{}", "fixture:review-anomalies", scope, quote, .9, now);
    store.close(); store = undefined;

    const preview = executeAt(database, "review", "anomalies", "preview", edgeId, "--scope", "project:alpha");
    assert.deepEqual(preview.error, { ok: false, command: "review.anomalies", error: { code: "operation_failed" } });
    store = new GraphologyStore(database);
    assert.equal(store.getEdgeById(edgeId)?.deleted_at, null, "a scope cannot delete graph state still evidenced elsewhere");
  } finally { try { store?.close(); } catch {} try { rmSync(directory, { recursive: true, force: true }); } catch {} }
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
