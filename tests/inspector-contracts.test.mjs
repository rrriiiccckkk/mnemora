import assert from "node:assert/strict";
import test from "node:test";
import { INSPECTOR_BIND_HOST, INSPECTOR_DEFAULT_PORT, normalizeInspectorRequest, normalizeInspectorResult, normalizeOperationResult } from "../dist/index.js";

test("inspector requests are closed at every object level", () => {
  assert.deepEqual(normalizeInspectorRequest({ kind: "overview" }), { kind: "overview" });
  assert.deepEqual(normalizeInspectorRequest({
    kind: "graph", cursor: "v1.cursor", limit: 2,
    filters: { node_types: ["company"], sources: ["report:public"], confidence_min: .5 }
  }), {
    kind: "graph", cursor: "v1.cursor", limit: 2,
    filters: { node_types: ["company"], sources: ["report:public"], confidence_min: .5 }
  });
  for (const value of [
    { kind: "overview", extra: true },
    { kind: "graph", filters: { extra: true } },
    { kind: "entity", id: "company:acme", evidence: { raw: true } },
    { kind: "research", section: "history", arbitrary: "audit" }
  ]) assert.throws(() => normalizeInspectorRequest(value), /invalid inspector request/);
});

test("inspector pagination cursors and warnings are opaque closed contracts", () => {
  assert.equal(normalizeInspectorRequest({ kind: "graph", cursor: "v1.opaque.cursor" }).cursor, "v1.opaque.cursor");
  assert.throws(() => normalizeInspectorRequest({ kind: "graph", cursor: 1 }), /invalid inspector request/);
  const graph = normalizeInspectorResult({
    kind: "graph", graph_revision: 1, next_cursor: "v1.next", truncated: true,
    warnings: [{ code: "malformed_row" }], nodes: [], edges: []
  });
  assert.deepEqual(graph.warnings, [{ code: "malformed_row" }]);
});

test("inspector cursors, filters, and graph ceilings are independently bounded", () => {
  const maximum = normalizeInspectorRequest({
    kind: "graph", cursor: "v1.maximum", limit: 5000,
    max_nodes: 5000, max_edges: 20000, max_response_bytes: 4 * 1024 * 1024, deadline_ms: 5000,
    filters: { node_types: Array(9).fill("company"), sources: Array(20).fill("source".repeat(20)), ids: Array(100).fill("company:acme") }
  });
  assert.equal(maximum.max_nodes, 5000);
  assert.equal(maximum.max_edges, 20000);
  assert.equal(maximum.max_response_bytes, 4 * 1024 * 1024);
  assert.equal(maximum.deadline_ms, 5000);
  for (const value of [
    { kind: "graph", cursor: -1 }, { kind: "graph", cursor: "bad cursor" },
    { kind: "graph", max_nodes: 5001 }, { kind: "graph", max_edges: 20001 },
    { kind: "graph", max_response_bytes: 4 * 1024 * 1024 + 1 }, { kind: "graph", deadline_ms: 5001 },
    { kind: "graph", filters: { sources: Array(21).fill("x") } }, { kind: "graph", filters: { sources: ["x".repeat(201)] } },
    { kind: "graph", filters: { ids: Array(101).fill("x") } },
    { kind: "entity", id: "x".repeat(201) }, { kind: "entity", id: "company:x", limit: 101 },
    { kind: "research", limit: 101 }
  ]) assert.throws(() => normalizeInspectorRequest(value), /invalid inspector request/);
});

test("documented source and page-size boundaries accept the maximum and reject maximum plus one", () => {
  assert.equal(normalizeInspectorRequest({ kind: "graph", filters: { sources: ["s".repeat(200)] } }).filters.sources[0].length, 200);
  assert.equal(normalizeInspectorRequest({ kind: "entity", id: "company:acme", limit: 100 }).limit, 100);
  assert.equal(normalizeInspectorRequest({ kind: "research", limit: 100 }).limit, 100);
  for (const value of [
    { kind: "graph", filters: { sources: ["s".repeat(201)] } },
    { kind: "entity", id: "company:acme", limit: 101 },
    { kind: "research", limit: 101 }
  ]) assert.throws(() => normalizeInspectorRequest(value), /invalid inspector request/);
});

test("inspector read results are closed, discriminated, bounded, and redacted", () => {
  const graph = normalizeInspectorResult({
    kind: "graph", graph_revision: 4, next_cursor: null, truncated: false, warnings: [],
    nodes: [{ id: "company:acme", name: "Acme", type: "company", community_id: null, community_color: null }],
    edges: [{ id: "edge:1", source_id: "company:acme", target_id: "company:beta", type: "supplies", confidence: .8,
      evidence: [{ source: "report:public", confidence: .8, valid_from: null, valid_to: null, summary: "bounded summary" }] }]
  });
  assert.equal(graph.kind, "graph");
  assert.throws(() => normalizeInspectorResult({ kind: "overview", graph_revision: 1, nodes: 1, edges: 1, observations: 1, error: { message: "private" } }), /invalid inspector result/);
  for (const value of [
    { kind: "graph", graph_revision: 1, next_cursor: null, truncated: false, warnings: [], nodes: [], edges: [], audit: { all: true } },
    { kind: "graph", graph_revision: 1, next_cursor: null, truncated: false, warnings: [], nodes: [{ id: "x", name: "x", type: "company", community_id: null, embedding: [1] }], edges: [] },
    { kind: "graph", graph_revision: 1, next_cursor: null, truncated: false, warnings: [], nodes: [], edges: [{ id: "e", source_id: "a", target_id: "b", type: "uses", confidence: .5, evidence: [{ source: "s", confidence: .5, valid_from: null, valid_to: null, summary: "x", quote: "full evidence" }] }] },
    { kind: "entity", id: "company:acme", name: "Acme", type: "company", aliases: [], evidence: [], graph_revision: 1, path: "C:/secret.db" },
    { kind: "research", section: "history", items: [{ id: "h", status: "ok", provider_body: "secret" }], next_cursor: null },
    { kind: "health", graph_revision: 1, status: "healthy", counts: { orphans: 0, conflicts: 0, duplicate_candidates: 0, credentials: "secret" } }
  ]) assert.throws(() => normalizeInspectorResult(value), /invalid inspector result/);
  assert.throws(() => normalizeInspectorResult({ kind: "graph", graph_revision: 1, next_cursor: null, truncated: false, warnings: [], nodes: Array(5001).fill({ id: "x", name: "x", type: "company", community_id: null }), edges: [] }), /invalid inspector result/);
});

test("graph result ceilings accept exact edges and response bytes, then reject plus one", () => {
  const edge = { id: "e", source_id: "a", target_id: "b", type: "uses", confidence: .5, evidence: [] };
  const base = { kind: "graph", graph_revision: 1, next_cursor: null, truncated: false, warnings: [], nodes: [], edges: Array(20000).fill(edge) };
  assert.equal(normalizeInspectorResult(base).edges.length, 20000);
  assert.throws(() => normalizeInspectorResult({ ...base, edges: Array(20001).fill(edge) }), /invalid inspector result/);
  const byteLimit = 4 * 1024 * 1024;
  const evidence = () => ({ source: "s", confidence: .5, valid_from: null, valid_to: null, summary: "x" });
  const exact = { kind: "graph", graph_revision: 1, next_cursor: null, truncated: false, warnings: [], nodes: [], edges: Array.from({ length: 1000 }, (_, index) => ({ id: `e${index}`, source_id: "a", target_id: "b", type: "uses", confidence: .5, evidence: Array.from({ length: 20 }, evidence) })) };
  let remaining = byteLimit - Buffer.byteLength(JSON.stringify(exact));
  for (const graphEdge of exact.edges) for (const item of graphEdge.evidence) {
    const fill = Math.min(500 - item.summary.length, remaining);
    item.summary += "x".repeat(fill);
    remaining -= fill;
  }
  assert.equal(remaining, 0);
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), byteLimit);
  assert.deepEqual(normalizeInspectorResult(exact), exact);
  const plusOne = structuredClone(exact);
  const summary = plusOne.edges.flatMap(graphEdge => graphEdge.evidence).find(item => item.summary.length < 500);
  assert.ok(summary);
  summary.summary += "x";
  assert.equal(Buffer.byteLength(JSON.stringify(plusOne)), byteLimit + 1);
  assert.throws(() => normalizeInspectorResult(plusOne), /invalid inspector result/);
});

test("operation results are specialized, closed, revision-aware, and private", () => {
  assert.deepEqual(normalizeOperationResult({
    operation: "source_trust", phase: "preview", preview_token: "token", payload_hash: "a".repeat(64), graph_revision: 4, config_revision: 3,
    affected: { nodes: 1, edges: 2, observations: 3 }, rank_deltas: [{ id: "company:acme", delta: .1 }], truncated: false
  }), {
    operation: "source_trust", phase: "preview", preview_token: "token", payload_hash: "a".repeat(64), graph_revision: 4, config_revision: 3,
    affected: { nodes: 1, edges: 2, observations: 3 }, rank_deltas: [{ id: "company:acme", delta: .1 }], truncated: false
  });
  assert.deepEqual(normalizeOperationResult({ operation: "backup", phase: "confirm", confirmed: true, graph_revision: 5, audit_id: "audit:1", artifact: { artifact_id: "artifact:backup-1" } }), { operation: "backup", phase: "confirm", confirmed: true, graph_revision: 5, audit_id: "audit:1", artifact: { artifact_id: "artifact:backup-1" } });
  for (const value of [
    { operation: "source_trust", phase: "preview", preview_token: "token", payload_hash: "a".repeat(64), graph_revision: 4, affected: { nodes: 1, edges: 2, observations: 3 }, rank_deltas: [], truncated: false },
    { operation: "backup", phase: "confirm", confirmed: true, graph_revision: 4, audit_id: "audit:1", artifact: { artifact_id: "artifact:x", path: "C:/secret.db" } },
    { operation: "restore", phase: "confirm", confirmed: true, graph_revision: 4, audit_id: "audit:1", recovery_point: { artifact_id: "artifact:x" }, provider_body: "secret" },
    { operation: "orphan_cleanup", phase: "confirm", confirmed: true, graph_revision: 4, audit_id: "audit:1", affected: { nodes: 1, edges: 2, observations: 3 }, exception: { stack: "secret" } },
    { operation: "weight_recompute", phase: "preview", preview_token: "token", payload_hash: "a".repeat(64), graph_revision: 4, affected: { nodes: 1, edges: 2, observations: 3 }, truncated: false, embedding: [1] }
  ]) assert.throws(() => normalizeOperationResult(value), /invalid operation result/);
  for (const value of [
    { operation: "backup", phase: "preview", preview_token: "token", payload_hash: "a".repeat(64), graph_revision: 4, affected: { nodes: 1, edges: 2, observations: 3 }, truncated: false },
    { operation: "restore", phase: "preview", preview_token: "token", payload_hash: "a".repeat(64), graph_revision: 4, affected: { nodes: 1, edges: 2, observations: 3 }, truncated: false },
    { operation: "orphan_cleanup", phase: "preview", preview_token: "token", payload_hash: "a".repeat(64), graph_revision: 4, affected: { nodes: 1, edges: 2, observations: 3 }, truncated: false },
    { operation: "weight_recompute", phase: "confirm", confirmed: true, graph_revision: 4, audit_id: "audit:1", affected: { nodes: 1, edges: 2, observations: 3 } }
  ]) assert.equal(normalizeOperationResult(value).operation, value.operation);
});

test("operation previews and confirmations bind closed, revision-aware payloads", () => {
  assert.deepEqual(normalizeInspectorRequest({
    operation: "source_trust", phase: "preview", graph_revision: 4, config_revision: 3,
    payload: { source: "report:public", weight: .75 }
  }), {
    operation: "source_trust", phase: "preview", graph_revision: 4, config_revision: 3,
    payload: { source: "report:public", weight: .75 }
  });
  assert.deepEqual(normalizeInspectorRequest({
    operation: "orphan_cleanup", phase: "confirm", preview_token: "token", payload_hash: "a".repeat(64), graph_revision: 4,
    payload: { limit: 10 }
  }), {
    operation: "orphan_cleanup", phase: "confirm", preview_token: "token", payload_hash: "a".repeat(64), graph_revision: 4,
    payload: { limit: 10 }
  });
  for (const value of [
    { phase: "confirm", preview_token: "token", payload_hash: "a".repeat(64), graph_revision: 4, payload: {} },
    { operation: "backup", phase: "confirm", payload_hash: "a".repeat(64), graph_revision: 4, payload: {} },
    { operation: "restore", phase: "confirm", preview_token: "token", payload_hash: "bad", graph_revision: 4, payload: { artifact_id: "artifact:1" } },
    { operation: "source_trust", phase: "confirm", preview_token: "token", payload_hash: "a".repeat(64), graph_revision: 4, payload: { source: "report:public", weight: .75 } },
    { operation: "weight_recompute", phase: "preview", graph_revision: -1, payload: { limit: 1 } },
    { operation: "orphan_cleanup", phase: "confirm", preview_token: "token", payload_hash: "a".repeat(64), graph_revision: 4, payload: { limit: 1, arbitrary: true } }
  ]) assert.throws(() => normalizeInspectorRequest(value), /invalid inspector request/);
});

test("Inspector source trust accepts the documented multiplier range",()=>{
  assert.doesNotThrow(()=>normalizeInspectorRequest({operation:"source_trust",phase:"preview",graph_revision:1,config_revision:1,payload:{source:"report:public",weight:2}}));
  assert.throws(()=>normalizeInspectorRequest({operation:"source_trust",phase:"preview",graph_revision:1,config_revision:1,payload:{source:"report:public",weight:2.01}}),/invalid inspector request/);
});

test("inspector bind contract is permanently loopback and port zero", () => {
  assert.equal(INSPECTOR_BIND_HOST, "127.0.0.1");
  assert.equal(INSPECTOR_DEFAULT_PORT, 0);
});
