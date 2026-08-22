import assert from "node:assert/strict";
import test from "node:test";
import { closeSync, mkdtempSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "@photostructure/sqlite";
import { Mnemora, GraphologyStore, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";

const extraction = (text) => ({ entities: [{ name: "Acme", type: "company", confidence: .9, evidence_span: text }], relations: [] });

test("strict automatic recall preserves a verified claim when a sibling claim remains pending", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { enabled: true, verification: { enabled: true } } }, extractor: { extract: extraction } });
  try {
    await graph.ingestItem({ text: "pending evidence", source: "report:pending" });
    await graph.ingestItem({ text: "verified evidence", source: "report:verified" });
    const pending = graph.kg_verify({ operation: "list" });
    const verified = pending.find(item => graph.store.db.prepare("SELECT quote FROM kg_observations WHERE id=?").get(item.claim_id).quote === "verified evidence");
    assert.ok(verified);
    graph.kg_verify({ operation: "transition", verification_id: verified.id, status: "verified", support_type: "direct", verification_confidence: .9, source_quality: .8, confirm: true });
    const decision = graph.filterAutomaticRecallContext(await graph.kg_context("Acme", 5, 0, 0, 800, "lexical"));
    assert.equal(decision.allowed, true);
    assert.equal(decision.context.nodes.length, 1);
    assert.deepEqual(decision.context.nodes[0].evidence.map(item => item.quote), ["verified evidence"]);
    assert.equal(decision.context.context.includes("pending evidence"), false);
  } finally { graph.close(); }
});

test("bounded AnchorVerifier queue is opt-in, auditable, and updates only a pending claim", async () => {
  let received = "";
  const graph = new Mnemora({
    config: { dbPath: ":memory:", trustLayer: { enabled: true, verification: { automatic: { enabled: true, maxInputChars: 64, maxOutputBytes: 4096, maxJobsPerRun: 2 } } } },
    extractor: { extract: extraction },
    anchorVerifier: { model: "fixture-model", async verify(input) { received = `${input.quote}\n${input.snapshot}`; assert.equal(input.signal.aborted, false); return { status: "verified", verification_confidence: .95, source_quality: .8 }; } }
  });
  try {
    await graph.ingestItem({ text: "direct support for Acme".repeat(8), source: "report:anchor" });
    assert.equal(graph.kg_verify({ operation: "jobs" }).length, 1);
    assert.deepEqual(await graph.kg_verify({ operation: "run" }), { processed: 1, succeeded: 1, failed: 0 });
    assert.equal(graph.kg_verify({ operation: "list" })[0].status, "verified");
    assert.equal(graph.kg_verify({ operation: "jobs" })[0].status, "succeeded");
    assert.equal(received.length <= 513 && received.length > 1, true);
  } finally { graph.close(); }
});

test("failed verifier jobs retry by idempotency key, and expired leases are safely reclaimed", async () => {
  let now = 10_000, calls = 0;
  const graph = new Mnemora({
    config: { dbPath: ":memory:", trustLayer: { enabled: true, verification: { automatic: { enabled: true, leaseMs: 5000 } } } },
    extractor: { extract: extraction }, now: () => now,
    anchorVerifier: { model: "fixture-model", async verify() { calls++; if (calls === 1) throw new Error("http_503"); return { status: "verified" }; } }
  });
  try {
    await graph.ingestItem({ text: "retryable evidence", source: "report:retry" });
    assert.deepEqual(await graph.kg_verify({ operation: "run" }), { processed: 1, succeeded: 0, failed: 1 });
    const failed = graph.kg_verify({ operation: "jobs" })[0];
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 1);
    assert.equal(graph.kg_verify({ operation: "queue" }).queued, 1);
    const retried = graph.kg_verify({ operation: "jobs" })[0];
    assert.equal(retried.status, "queued");
    assert.equal(retried.last_retry_reason, "http_503");
    assert.deepEqual(await graph.kg_verify({ operation: "run" }), { processed: 1, succeeded: 1, failed: 0 });
    assert.equal(graph.kg_verify({ operation: "jobs" })[0].attempts, 2);

    await graph.ingestItem({ text: "interrupted evidence", source: "report:interrupted" });
    const interrupted = graph.anchorVerificationJobs.claimNext("default", 5000);
    assert.ok(interrupted);
    assert.equal(interrupted.job.status, "running");
    now += 5001;
    const recovered = graph.kg_verify({ operation: "queue" });
    assert.equal(recovered.reclaimed, 1);
    const job = graph.kg_verify({ operation: "jobs" }).find(item => item.id === interrupted.job.id);
    assert.equal(job?.status, "queued");
    assert.equal(job?.error_code, "stale_lease");
  } finally { graph.close(); }
});

test("concurrent verifier workers claim each pending job at most once", async () => {
  const calls = [];
  const graph = new Mnemora({
    config: { dbPath: ":memory:", trustLayer: { enabled: true, verification: { automatic: { enabled: true, maxConcurrent: 2, maxJobsPerRun: 2 } } } },
    extractor: { extract: extraction },
    anchorVerifier: { model: "fixture-model", async verify(input) { calls.push(input.claim_id); await Promise.resolve(); return { status: "verified" }; } }
  });
  try {
    await graph.ingestItem({ text: "first concurrent evidence", source: "report:one" });
    await graph.ingestItem({ text: "second concurrent evidence", source: "report:two" });
    await Promise.all([graph.kg_verify({ operation: "run", limit: 2 }), graph.kg_verify({ operation: "run", limit: 2 })]);
    assert.equal(new Set(calls).size, 2);
    assert.equal(calls.length, 2);
    assert.equal(graph.kg_verify({ operation: "jobs" }).every(item => item.status === "succeeded" && item.attempts === 1), true);
  } finally { graph.close(); }
});

test("retrospective audit scheduling is opt-in and never mutates a verified claim", async () => {
  let now = 1;
  const graph = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { enabled: true, verification: { retrospectiveAudit: { enabled: true, minimumAgeDays: 1, minimumRecallCount: 1 } } } }, extractor: { extract: extraction }, now: () => now });
  try {
    await graph.ingestItem({ text: "verified later", source: "report:external", sourceRef: { provider: "lossless-claw", externalId: "message:1" } });
    const [verification] = graph.kg_verify({ operation: "list" });
    graph.kg_verify({ operation: "transition", verification_id: verification.id, status: "verified", support_type: "direct", confirm: true });
    now += 2 * 86_400_000;
    const scheduled = graph.kg_verify({ operation: "audit_schedule" });
    assert.equal(scheduled.scheduled, 1);
    assert.equal(graph.kg_verify({ operation: "audits" })[0].risk_signals.includes("aged_source"), true);
    assert.deepEqual(graph.kg_verify({ operation: "audit_run" }), { processed: 1, review_required: 1, reviewed: 0 });
    const audit = graph.kg_verify({ operation: "audits" })[0];
    assert.equal(audit.status, "review_required");
    assert.equal(audit.attempts, 1);
    assert.equal(graph.kg_verify({ operation: "audit_review", audit_id: audit.id }), true);
    assert.equal(graph.kg_verify({ operation: "audits" })[0].status, "reviewed");
    assert.equal(graph.kg_verify({ operation: "audit_requeue", audit_id: audit.id }), true);
    assert.equal(graph.kg_verify({ operation: "audit_cancel", audit_id: audit.id }), true);
    assert.equal(graph.kg_verify({ operation: "audit_schedule" }).scheduled, 0);
    assert.equal(graph.kg_verify({ operation: "audit_requeue", audit_id: audit.id }), true);
    assert.equal(graph.kg_verify({ operation: "list" })[0].status, "verified");
  } finally { graph.close(); }
});

test("v21 core migration quarantines invalid legacy facts and preserves valid data", () => {
  const dir = mkdtempSync(join(process.cwd(), ".tmp", "v21-")); const file = join(dir, "legacy.db"); closeSync(openSync(file, "w"));
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE kg_nodes(id TEXT PRIMARY KEY,type TEXT,name TEXT,description TEXT,aliases TEXT,importance REAL,deleted_at INTEGER DEFAULT NULL,created_at INTEGER,updated_at INTEGER);
      CREATE TABLE kg_edges(id TEXT PRIMARY KEY,source_id TEXT,target_id TEXT,type TEXT,edge_props TEXT,weight REAL,deleted_at INTEGER DEFAULT NULL,created_at INTEGER,updated_at INTEGER);
      CREATE TABLE kg_observations(id TEXT PRIMARY KEY,edge_id TEXT,source_entity_id TEXT,payload TEXT,source TEXT,scope TEXT,quote TEXT,confidence REAL,valid_from INTEGER,valid_to INTEGER,temporal_confidence REAL,created_at INTEGER);
      PRAGMA user_version=20;`);
    db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("company:good", "company", "Good", "", "[]", .2, 1, 1);
    db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("company:bad", "not-a-type", "Bad", "", "{bad", .2, 1, 1);
    db.prepare("INSERT INTO kg_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("obs:good", null, "company:good", "{}", "legacy", "default", "good", .9, null, null, null, 1);
    db.prepare("INSERT INTO kg_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("obs:bad", null, null, "{}", "legacy", "default", "bad", 2, 5, 1, null, 1);
  } finally { db.close(); }
  const store = new GraphologyStore(file);
  try {
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM kg_nodes WHERE id='company:good'").get().n, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM kg_nodes WHERE id='company:bad'").get().n, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM kg_observations WHERE id='obs:good'").get().n, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM kg_schema_quarantine WHERE schema_version=21").get().n, 2);
    assert.throws(() => store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,scope,quote,confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run("obs:new", null, null, "{}", "x", "default", "x", .5, 2));
  } finally { store.close(); }
});

test("v24 trust migration adds lease state and widens retrospective audit lifecycle", () => {
  const dir = mkdtempSync(join(process.cwd(), ".tmp", "v24-")); const file = join(dir, "legacy.db");
  const initial = new GraphologyStore(file); initial.close();
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA foreign_keys=OFF;
      DROP TABLE kg_retrospective_audits;
      CREATE TABLE kg_retrospective_audits (
        id TEXT PRIMARY KEY,verification_id TEXT NOT NULL,scope TEXT NOT NULL,policy_version TEXT NOT NULL,
        risk_score REAL NOT NULL,risk_signals TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('scheduled','reviewed','canceled')),
        scheduled_at INTEGER NOT NULL,reviewed_at INTEGER,UNIQUE(verification_id,policy_version)
      ); PRAGMA user_version=23;`);
  } finally { db.close(); }
  const migrated = new GraphologyStore(file);
  try {
    assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
    const jobColumns = new Set(migrated.db.prepare("PRAGMA table_info(kg_anchor_verification_jobs)").all().map(row => row.name));
    for (const name of ["lease_expires_at", "last_heartbeat_at", "retry_not_before", "last_retry_reason"]) assert.equal(jobColumns.has(name), true);
    const auditSql = migrated.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='kg_retrospective_audits'").get().sql;
    assert.match(auditSql, /review_required/);
    assert.match(auditSql, /attempts INTEGER NOT NULL DEFAULT 0/);
  } finally { migrated.close(); }
});
