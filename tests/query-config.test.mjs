import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig, normalizeQueryPlan } from "../dist/index.js";

test("query configuration defaults are exact and clamp to public hard maxima", () => {
  assert.deepEqual(normalizeConfig({}).query, {
    maxSteps: 8, maxDepth: 4, maxResults: 50, maxNodes: 10000,
    maxEdges: 50000, timeoutMs: 10000, maxResponseBytes: 1048576,
    auditRetentionDays: 30, maxWatches: 100, maxDigestWatches: 25,
    maxImportBytes: 10485760, maxImportRecords: 1000
  });
  assert.deepEqual(normalizeConfig({ query: Object.fromEntries([
    "maxSteps", "maxDepth", "maxResults", "maxNodes", "maxEdges", "timeoutMs",
    "maxResponseBytes", "auditRetentionDays", "maxWatches", "maxDigestWatches",
    "maxImportBytes", "maxImportRecords"
  ].map(key => [key, Number.MAX_SAFE_INTEGER])) }).query, {
    maxSteps: 8, maxDepth: 4, maxResults: 50, maxNodes: 10000,
    maxEdges: 50000, timeoutMs: 10000, maxResponseBytes: 1048576,
    auditRetentionDays: 3650, maxWatches: 100, maxDigestWatches: 25,
    maxImportBytes: 10485760, maxImportRecords: 1000
  });
});

test("query plans are closed, versioned, and independently hard bounded", () => {
  const plan = normalizeQueryPlan({ version: 1, steps: [{ op: "traverse", from: ["company:apple"], edge_types: ["supplies"], direction: "in", depth: 99 }], limit: 9999 });
  assert.equal(plan.steps[0].depth, 4);
  assert.equal(plan.limit, 50);
  assert.equal(plan.order_by, "relevance");
  assert.throws(() => normalizeQueryPlan({ version: 1, steps: [{ op: "sql", text: "SELECT *" }] }), /invalid query plan/);
  assert.throws(() => normalizeQueryPlan({ version: 1, steps: [], extra: true }), /invalid query plan/);
});

test("query plan members reject unknown keys, invalid enums, and unsafe values", () => {
  const invalid = [
    { version: 2, steps: [{ op: "lookup", query: "apple" }] },
    { version: 1, steps: [{ op: "lookup", query: "" }] },
    { version: 1, steps: [{ op: "lookup", query: "apple", extra: true }] },
    { version: 1, steps: [{ op: "lookup", query: "apple", node_types: ["unknown"] }] },
    { version: 1, steps: [{ op: "traverse", from: [], direction: "out", depth: 1 }] },
    { version: 1, steps: [{ op: "traverse", from: ["x"], edge_types: ["unknown"], direction: "out", depth: 1 }] },
    { version: 1, steps: [{ op: "filter", confidence_min: Number.NaN }] },
    { version: 1, steps: [{ op: "filter", valid_from: 2, valid_to: 1 }] },
    { version: 1, steps: [{ op: "aggregate", by: "source", metric: "sum", arbitrary: "expression" }] },
    { version: 1, steps: Array.from({ length: 9 }, () => ({ op: "lookup", query: "x" })) }
  ];
  for (const value of invalid) assert.throws(() => normalizeQueryPlan(value), /invalid query plan/);
});

test("relationship types reject inherited Object prototype keys", () => {
  for (const edgeType of ["toString", "constructor", "__proto__"])
    assert.throws(() => normalizeQueryPlan({ version: 1, steps: [{ op: "traverse", from: ["x"], edge_types: [edgeType], direction: "out", depth: 1 }] }), /invalid query plan/);
});
