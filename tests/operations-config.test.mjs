import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig, normalizeInspectorRequest, normalizeOperationsConfig } from "../dist/index.js";

test("inspector configuration defaults and lowerable ceilings are exact", () => {
  assert.deepEqual(normalizeConfig({}).inspector, {
    maxGraphNodes: 5000, maxGraphEdges: 20000, maxGraphResponseBytes: 4 * 1024 * 1024, graphDeadlineMs: 5000
  });
  assert.deepEqual(normalizeOperationsConfig({ maxGraphNodes: 25, maxGraphEdges: 50, maxGraphResponseBytes: 1024, graphDeadlineMs: 10 }), {
    maxGraphNodes: 25, maxGraphEdges: 50, maxGraphResponseBytes: 1024, graphDeadlineMs: 10
  });
  assert.deepEqual(normalizeConfig({ inspector: {
    maxGraphNodes: 999999, maxGraphEdges: 999999, maxGraphResponseBytes: Number.MAX_SAFE_INTEGER, graphDeadlineMs: 999999
  } }).inspector, {
    maxGraphNodes: 5000, maxGraphEdges: 20000, maxGraphResponseBytes: 4 * 1024 * 1024, graphDeadlineMs: 5000
  });
});

test("operations configuration rejects bind overrides and unknown properties", () => {
  for (const value of [
    { host: "0.0.0.0" }, { host: "192.168.1.9" }, { bindHost: "127.0.0.1" }, { port: 8080 },
    { maxGraphNodes: 1, extra: true }, { maxGraphNodes: 0 }, { graphDeadlineMs: -1 }
  ]) assert.throws(() => normalizeOperationsConfig(value), /invalid operations config/);
});

test("operations configuration rejects inherited bind overrides and contains hostile proxy inputs", () => {
  for (const value of [
    Object.create({ host: "0.0.0.0" }), Object.create({ bindHost: "192.168.1.9" }), Object.create({ port: 1 }),
    new Proxy({}, { ownKeys() { throw new Error("hostile ownKeys"); } }),
    new Proxy({}, { has() { throw new Error("hostile has"); } })
  ]) assert.throws(() => normalizeOperationsConfig(value), /invalid operations config/);
});

test("top-level configuration rejects all bind override attempts", () => {
  for (const value of [
    { host: "0.0.0.0" }, { host: "192.168.1.9" }, { bindHost: "127.0.0.1" }, { port: 1 }
  ]) assert.throws(() => normalizeConfig(value), /invalid inspector bind config/);
});

test("normalized lowered inspector configuration caps independent request validation", () => {
  const inspector = normalizeConfig({ inspector: { maxGraphNodes: 3, maxGraphEdges: 4, maxGraphResponseBytes: 1000, graphDeadlineMs: 50 } }).inspector;
  assert.deepEqual(normalizeInspectorRequest({ kind: "graph", max_nodes: 3, max_edges: 4, max_response_bytes: 1000, deadline_ms: 50 }, inspector), { kind: "graph", max_nodes: 3, max_edges: 4, max_response_bytes: 1000, deadline_ms: 50 });
  for (const value of [
    { kind: "graph", max_nodes: 4 }, { kind: "graph", max_edges: 5 }, { kind: "graph", max_response_bytes: 1001 }, { kind: "graph", deadline_ms: 51 }
  ]) assert.throws(() => normalizeInspectorRequest(value, inspector), /invalid inspector request/);
});
