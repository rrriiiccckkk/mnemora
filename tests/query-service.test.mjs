import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { GraphologyStore, GraphQueryService, normalizeQueryPlan } from "../dist/index.js";

const PLAN = { version: 1, steps: [{ op: "lookup", query: "Apple", mode: "lexical" }], order_by: "name", limit: 10 };
const limits = { maxSteps: 8, maxDepth: 4, maxResults: 50, maxNodes: 100, maxEdges: 100, timeoutMs: 1000, maxResponseBytes: 100000, auditRetentionDays: 30 };

test("service executes a direct plan without planner credentials and records redacted canonical audit", async () => {
  const store = new GraphologyStore(":memory:");
  try {
    const service = new GraphQueryService({ store, config: { query: limits }, now: () => 1000 });
    const result = await service.query({ question: "SECRET QUESTION", plan: PLAN });
    assert.equal(result.plan_source, "provided");
    assert.equal(result.status, "empty");
    const [run] = store.listQueryRuns(10);
    assert.equal(run.status, "succeeded");
    assert.equal(run.plan_hash, createHash("sha256").update(JSON.stringify(PLAN)).digest("hex"));
    const serialized = JSON.stringify(run);
    assert.doesNotMatch(serialized, /SECRET QUESTION|evidence|credential|absolute path/i);
  } finally { store.close(); }
});

test("service plans questions, tags llm source, and audits success", async () => {
  const store = new GraphologyStore(":memory:");
  let received;
  try {
    const planner = { plan: async (question) => { received = question; return PLAN; } };
    const result = await new GraphQueryService({ store, config: { query: limits }, planner, now: () => 2000 }).query({ question: "Who supplies Apple?" });
    assert.equal(received, "Who supplies Apple?");
    assert.equal(result.plan_source, "llm");
    assert.equal(store.listQueryRuns(1)[0].status, "succeeded");
  } finally { store.close(); }
});

test("service bounds public execution errors and audits failures without result bodies", async () => {
  const store = new GraphologyStore(":memory:");
  try {
    const service = new GraphQueryService({ store, config: { query: limits }, now: () => 3000 });
    await assert.rejects(service.query({ plan: { ...PLAN, steps: [{ op: "lookup", query: "x", mode: "hybrid" }] } }), /^Error: invalid_plan$/);
    const [run] = store.listQueryRuns(1);
    assert.equal(run.status, "failed");
    assert.equal(run.error_category, "invalid_plan");
    assert.doesNotMatch(JSON.stringify(run), /evidence|provider body/i);
  } finally { store.close(); }
});

test("query audit listing is bounded and retention maintenance prunes old rows", () => {
  const store = new GraphologyStore(":memory:");
  try {
    for (let i = 0; i < 1100; i++) store.recordQueryRun({ plan: PLAN, status: "succeeded", graph_revision: 0, result_count: 0, duration_ms: 0, created_at: i, retention_days: 1 });
    assert.equal(store.listQueryRuns(5000).length, 1000);
    store.recordQueryRun({ plan: PLAN, status: "succeeded", graph_revision: 0, result_count: 0, duration_ms: 0, created_at: 1000 + 2 * 86400000, retention_days: 1 });
    assert.equal(store.listQueryRuns(1000).some(row => row.created_at === 0), false);
  } finally { store.close(); }
});

test("service exposes only planner unavailable, timeout, and caller-aborted categories", async () => {
  for (const category of ["unavailable", "timeout"]) {
    const store = new GraphologyStore(":memory:");
    try {
      const service = new GraphQueryService({ store, config: { query: limits }, planner: { plan: async () => { throw new Error(category); } } });
      await assert.rejects(service.query({ question: "x" }), new RegExp(`^Error: ${category}$`));
    } finally { store.close(); }
  }
  const store = new GraphologyStore(":memory:");
  const caller = new AbortController(); caller.abort();
  try { await assert.rejects(new GraphQueryService({ store, config: { query: limits } }).query({ plan: PLAN, signal: caller.signal }), /^Error: aborted$/); }
  finally { store.close(); }
});

test("service records truncated execution without storing evidence bodies", async () => {
  const store = new GraphologyStore(":memory:");
  try {
    store.ingest([{ name: "Apple", type: "company", confidence: 1, evidence_span: "SECRET EVIDENCE" }, { name: "Apple Supplier", type: "company", confidence: 1, evidence_span: "SECRET EVIDENCE" }], [], "SECRET SOURCE");
    const service = new GraphQueryService({ store, config: { query: { ...limits, maxNodes: 1 } } });
    await service.query({ plan: PLAN });
    const run = store.listQueryRuns(1)[0];
    assert.equal(run.status, "truncated");
    assert.doesNotMatch(JSON.stringify(run), /SECRET EVIDENCE|SECRET SOURCE/);
  } finally { store.close(); }
});

test("audit hashes the full plan but scrubs every plan-controlled text boundary", async () => {
  const store = new GraphologyStore(":memory:");
  const sentinel = "RAW QUESTION API_KEY Bearer secret C:\\Users\\rick\\secret /home/rick/secret EVIDENCE_SENTINEL";
  const raw = { version: 1, steps: [{ op: "lookup", query: sentinel, mode: "lexical" }, { op: "traverse", from: ["$previous", sentinel], direction: "both", depth: 1 }], order_by: "name", limit: 10 };
  try {
    const expectedHash = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
    const service = new GraphQueryService({ store, config: { query: limits }, planner: { plan: async question => ({ ...raw, steps: [{ ...raw.steps[0], query: question }, raw.steps[1]] }) } });
    await service.query({ question: sentinel });
    const run = store.listQueryRuns(1)[0];
    assert.equal(run.plan_hash, expectedHash);
    assert.equal(Object.hasOwn(run, "normalized_plan"), false);
    assert.deepEqual(run.plan_metadata.steps[0], { op: "lookup", query_redacted: true, mode: "lexical" });
    assert.deepEqual(run.plan_metadata.steps[1], { op: "traverse", from_previous: true, explicit_entity_count: 1, direction: "both", depth: 1 });
    assert.throws(() => normalizeQueryPlan(run.plan_metadata), /invalid query plan/);
    const listed = JSON.stringify(run);
    const rawDb = JSON.stringify(store.db.prepare("SELECT * FROM kg_query_runs").all());
    for (const serialized of [listed, rawDb]) assert.doesNotMatch(serialized, /RAW QUESTION|API_KEY|Bearer|C:\\\\Users|\/home\/rick|EVIDENCE_SENTINEL/);
  } finally { store.close(); }
});

test("store itself scrubs direct-plan audit records for every closed status", () => {
  const store = new GraphologyStore(":memory:");
  const sentinel = "DIRECT_SECRET /absolute/path";
  const raw = { version: 1, steps: [{ op: "lookup", query: sentinel }, { op: "traverse", from: [sentinel], direction: "out", depth: 1 }], order_by: "name", limit: 1 };
  try {
    for (const status of ["succeeded", "failed", "truncated"]) store.recordQueryRun({ plan: raw, status, graph_revision: 0, result_count: 0, duration_ms: 0, created_at: Date.now() });
    assert.doesNotMatch(JSON.stringify(store.db.prepare("SELECT normalized_plan FROM kg_query_runs").all()), /DIRECT_SECRET|absolute\/path/);
  } finally { store.close(); }
});

test("service uses the same Unicode code-point question boundary", async () => {
  const store = new GraphologyStore(":memory:");
  let calls = 0;
  try {
    const service = new GraphQueryService({ store, config: { query: limits }, planner: { plan: async () => { calls++; return PLAN; } } });
    await service.query({ question: "😀".repeat(4000) });
    await assert.rejects(service.query({ question: "😀".repeat(4001) }), /^Error: invalid_plan$/);
    assert.equal(calls, 1);
  } finally { store.close(); }
});
