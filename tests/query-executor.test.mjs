import assert from "node:assert/strict";
import test from "node:test";
import { GraphologyStore } from "../dist/store.js";
import { executeQueryPlan } from "../dist/query/executor.js";

const NOW = Date.parse("2026-07-15T00:00:00.000Z");
const JAN_1 = Date.parse("2026-01-01T00:00:00.000Z");
const DEC_31 = Date.parse("2026-12-31T23:59:59.999Z");
const limits = { maxSteps: 8, maxDepth: 4, maxResults: 50, maxNodes: 10000, maxEdges: 50000, timeoutMs: 10000, maxResponseBytes: 1048576 };

function fixture(reverse = false) {
  const nodes = [
    { id: "company:apple", name: "Apple", type: "company", aliases: ["Apple Inc"], createdAt: 1, updatedAt: 4 },
    { id: "company:tsmc", name: "TSMC", type: "company", aliases: [], createdAt: 2, updatedAt: 5 },
    { id: "company:vendor", name: "Vendor", type: "company", aliases: [], createdAt: 3, updatedAt: 3 },
  ];
  const edges = [
  { id: "e:tsmc-apple", source: "company:tsmc", target: "company:apple", type: "supplies", confidence: .9, evidenceCount: 3, sourceCount: 2, firstSeenAt: JAN_1, lastSeenAt: NOW, validFrom: JAN_1, validTo: DEC_31 },
  { id: "e:vendor-tsmc", source: "company:vendor", target: "company:tsmc", type: "supplies", confidence: .6, evidenceCount: 1, sourceCount: 1, firstSeenAt: JAN_1, lastSeenAt: NOW, validFrom: null, validTo: null },
  { id: "e:self", source: "company:apple", target: "company:apple", type: "supplies", confidence: .99, evidenceCount: 1, sourceCount: 1, firstSeenAt: JAN_1, lastSeenAt: NOW, validFrom: null, validTo: null },
  ];
  return { queryGraphProjection: () => ({ graphRevision: 7, nodes: reverse ? nodes.toReversed() : nodes, edges: reverse ? edges.toReversed() : edges, truncated: false }) };
}

const plan = { version: 1, steps: [
  { op: "lookup", query: "Apple", node_types: ["company"], mode: "lexical" },
  { op: "traverse", from: ["$previous"], edge_types: ["supplies"], direction: "in", depth: 2 },
  { op: "filter", confidence_min: .7, valid_from: JAN_1, valid_to: DEC_31 },
], order_by: "confidence", limit: 10 };

test("executor performs lookup, directed traversal, temporal filtering, ordering, and aggregation", () => {
  const result = executeQueryPlan(fixture(), plan, { limits, now: NOW });
  assert.deepEqual(result.entities.map(x => x.id), ["company:tsmc", "company:apple"]);
  assert.ok(result.relationships.every(x => x.confidence >= .7));
  assert.equal(result.interpreted_plan.version, 1);
  assert.deepEqual(executeQueryPlan(fixture(true), plan, { limits, now: NOW }), result);
  assert.equal(result.relationships.some(x => x.id === "e:self"), false);
});

test("aggregate entities counts unique endpoints per relationship type", () => {
  const aggregatePlan = { ...plan, steps: [...plan.steps, { op: "aggregate", by: "relationship_type", metric: "entities" }] };
  const result = executeQueryPlan(fixture(), aggregatePlan, { limits, now: NOW });
  assert.deepEqual(result.aggregates, [{ key: "supplies", count: 2 }]);
});

test("result and byte truncation preserve a coherent subgraph and aggregates", () => {
  const aggregatePlan = { ...plan, steps: [...plan.steps, { op: "aggregate", by: "relationship_type", metric: "relationships" }], limit: 1 };
  const limited = executeQueryPlan(fixture(), aggregatePlan, { limits, now: NOW });
  const limitedIds = new Set(limited.entities.map(entity => entity.id));
  assert.ok(limited.relationships.every(edge => limitedIds.has(edge.source_id) && limitedIds.has(edge.target_id)));
  const byteLimited = executeQueryPlan(fixture(), { ...aggregatePlan, limit: 10 }, { limits: { ...limits, maxResponseBytes: 700 }, now: NOW });
  const byteIds = new Set(byteLimited.entities.map(entity => entity.id));
  assert.ok(byteLimited.relationships.every(edge => byteIds.has(edge.source_id) && byteIds.has(edge.target_id)));
  assert.deepEqual(byteLimited.aggregates, byteLimited.relationships.length ? [{ key: "supplies", count: byteLimited.relationships.length }] : []);
});

test("executor independently filters, sorts, caps, and coheres oversized projections", () => {
  const nodes = Array.from({ length: 10002 }, (_, i) => ({ id: `n:${String(10001 - i).padStart(5, "0")}`, name: "Hit", type: "company", aliases: [], createdAt: i, updatedAt: i }));
  nodes.push({ id: 7, name: "bad", type: "company", aliases: [], createdAt: 0, updatedAt: 0 });
  nodes.push({ id: "n:-invalid", name: "Hit", type: "invalid_type", aliases: [], createdAt: 0, updatedAt: 0 });
  const edges = Array.from({ length: 50002 }, (_, i) => ({ id: `e:${String(50001 - i).padStart(5, "0")}`, source: "n:00000", target: "n:00001", type: "supplies", confidence: .8, evidenceCount: 1, sourceCount: 1, firstSeenAt: 1, lastSeenAt: 2, validFrom: null, validTo: null }));
  const store = { queryGraphProjection: () => ({ graphRevision: 1, nodes, edges, truncated: false }) };
  const result = executeQueryPlan(store, { version: 1, steps: [{ op: "lookup", query: "Hit" }, { op: "traverse", from: ["$previous"], direction: "both", depth: 1 }], order_by: "name", limit: 50 }, { limits, now: NOW });
  assert.equal(result.truncated, true);
  assert.ok(result.entities.every(entity => entity.type === "company"));
  assert.ok(result.entities.every(entity => entity.id < "n:10000"));
  assert.ok(result.relationships.every(edge => result.entities.some(entity => entity.id === edge.source_id) && result.entities.some(entity => entity.id === edge.target_id)));
});

test("executor enforces lower normalized projection caps when a custom store ignores them", () => {
  const nodes = Array.from({ length: 5 }, (_, i) => ({ id: `n:${4 - i}`, name: "Hit", type: "company", aliases: [], createdAt: i, updatedAt: i }));
  const edges = Array.from({ length: 3 }, (_, i) => ({ id: `e:${2 - i}`, source: "n:0", target: "n:1", type: "supplies", confidence: .8, evidenceCount: 1, sourceCount: 1, firstSeenAt: 1, lastSeenAt: 2, validFrom: null, validTo: null }));
  const result = executeQueryPlan({ queryGraphProjection: () => ({ graphRevision: 1, nodes, edges, truncated: false }) }, { version: 1, steps: [{ op: "lookup", query: "Hit" }, { op: "traverse", from: ["$previous"], direction: "both", depth: 1 }], order_by: "name", limit: 50 }, { limits: { ...limits, maxNodes: 2, maxEdges: 1 }, now: NOW });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.entities.map(entity => entity.id), ["n:0", "n:1"]);
  assert.deepEqual(result.relationships.map(edge => edge.id), ["e:0"]);
});

test("explicit semantic and hybrid lookup modes are rejected", () => {
  for (const mode of ["semantic", "hybrid"]) assert.throws(() => executeQueryPlan(fixture(), { version: 1, steps: [{ op: "lookup", query: "Apple", mode }], order_by: "name", limit: 1 }, { limits, now: NOW }), /unsupported lookup mode/);
});

test("deadline is checked periodically during projection work", () => {
  const realNow = Date.now;
  let calls = 0;
  Date.now = () => ++calls < 20 ? 0 : 2;
  const nodes = Array.from({ length: 2000 }, (_, i) => ({ id: `n:${i}`, name: "Hit", type: "company", aliases: [], createdAt: i, updatedAt: i }));
  try {
    assert.throws(() => executeQueryPlan({ queryGraphProjection: () => ({ graphRevision: 1, nodes, edges: [], truncated: false }) }, { version: 1, steps: [{ op: "lookup", query: "Hit" }], order_by: "name", limit: 50 }, { limits: { ...limits, timeoutMs: 1 }, now: NOW }), /timeout/);
  } finally { Date.now = realNow; }
});

test("deadline is checked periodically during filter-stage linear scans", () => {
  const realNow = Date.now;
  let calls = 0;
  Date.now = () => ++calls < 410 ? 0 : 2;
  const nodes = Array.from({ length: 300 }, (_, i) => ({ id: `n:${i}`, name: "Hit", type: "company", aliases: [], createdAt: i, updatedAt: i }));
  const edges = Array.from({ length: 50000 }, (_, i) => ({ id: `e:${i}`, source: `n:${i % 299}`, target: `n:${(i % 299) + 1}`, type: "supplies", confidence: .8, evidenceCount: 1, sourceCount: 1, firstSeenAt: 1, lastSeenAt: 2, validFrom: null, validTo: null }));
  try {
    assert.throws(() => executeQueryPlan({ queryGraphProjection: () => ({ graphRevision: 1, nodes, edges, truncated: false }) }, { version: 1, steps: [{ op: "lookup", query: "Hit" }, { op: "traverse", from: ["$previous"], direction: "both", depth: 1 }, { op: "filter", confidence_min: .7 }], order_by: "name", limit: 50 }, { limits: { ...limits, timeoutMs: 1 }, now: NOW }), /timeout/);
  } finally { Date.now = realNow; }
});

test("executor rejects unsupported previous placement and reapplies public ceilings", () => {
  assert.throws(() => executeQueryPlan(fixture(), { ...plan, steps: [{ op: "traverse", from: ["$previous"], direction: "both", depth: 99 }], limit: 999 }, { limits: { ...limits, maxDepth: 999, maxResults: 999 }, now: NOW }), /previous/);
  const many = Array.from({ length: 80 }, (_, i) => ({ id: `n:${String(i).padStart(3, "0")}`, name: "Hit", type: "company", aliases: [], createdAt: i, updatedAt: i }));
  const store = { queryGraphProjection: options => { assert.equal(options.maxNodes, 10000); assert.equal(options.maxEdges, 50000); return { graphRevision: 1, nodes: many, edges: [], truncated: false }; } };
  const result = executeQueryPlan(store, { version: 1, steps: [{ op: "lookup", query: "Hit" }], order_by: "name", limit: 999 }, { limits: { ...limits, maxNodes: 999999, maxEdges: 999999, maxResults: 999 }, now: NOW });
  assert.equal(result.entities.length, 50);
});

test("executor deduplicates paths, rejects malformed projection rows, trims bytes, and cancels", () => {
  const duplicate = fixture();
  const original = duplicate.queryGraphProjection();
  duplicate.queryGraphProjection = () => ({ ...original, edges: [...original.edges, original.edges[0], { ...original.edges[0], id: 42 }] });
  const result = executeQueryPlan(duplicate, plan, { limits: { ...limits, maxResponseBytes: 650 }, now: NOW });
  assert.equal(new Set(result.relationships.map(x => x.id)).size, result.relationships.length);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 650);
  assert.equal(result.truncated, true);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => executeQueryPlan(fixture(), plan, { limits, now: NOW, signal: controller.signal }), /cancel|abort|timeout/i);
  assert.throws(() => executeQueryPlan(fixture(), plan, { limits: { ...limits, timeoutMs: 0 }, now: NOW }), /timeout/i);
});

test("query projection is bounded, current, aggregate-only, and excludes malformed rows", () => {
  const store = new GraphologyStore(":memory:");
  try {
    store.ingest([{ name: "Visible", type: "company", confidence: .9, evidence_span: "SECRET_QUOTE" }, { name: "Other", type: "company", confidence: .9, evidence_span: "x" }], [], "SECRET_URL");
    const a = store.resolveEntity("Visible");
    const b = store.resolveEntity("Other");
    store.db.prepare("UPDATE kg_nodes SET description=?, embedding=? WHERE id=?").run("SECRET_DESCRIPTION", new Uint8Array([1, 2]), a.id);
    store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?)").run("safe", a.id, b.id, "supplies", "{}", .8, NOW, NOW);
    store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("o:safe", "safe", null, "{\"private\":\"SECRET_PAYLOAD\"}", "SECRET_SOURCE", "SECRET_QUOTE", .8, JAN_1, DEC_31, null, NOW);
    const projection = store.queryGraphProjection({ maxNodes: 999999, maxEdges: 999999, asOf: NOW });
    assert.ok(projection.nodes.length <= 10000 && projection.edges.length <= 50000);
    assert.deepEqual(Object.keys(projection.nodes[0]).sort(), ["aliases", "createdAt", "id", "name", "type", "updatedAt"]);
    assert.deepEqual(Object.keys(projection.edges[0]).sort(), ["confidence", "evidenceCount", "firstSeenAt", "id", "lastSeenAt", "source", "sourceCount", "target", "type", "validFrom", "validTo"]);
    assert.equal(projection.edges[0].evidenceCount, 1);
    assert.doesNotMatch(JSON.stringify(projection), /SECRET_/);
    assert.throws(() => store.db.prepare("UPDATE kg_observations SET confidence=? WHERE id=?").run("bogus", "o:safe"));
    assert.equal(store.queryGraphProjection({ maxNodes: 10, maxEdges: 10, asOf: NOW }).edges.length, 1);
  } finally { store.close(); }
});

test("query projection excludes deleted, non-current, reversed-temporal, and malformed rows before limits", () => {
  const store = new GraphologyStore(":memory:");
  const addNode = (id, type = "company", deleted = null) => store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, type, id, "", "[]", 0, deleted, NOW, NOW);
  const addEdge = (id, source, target, deleted = null) => store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, source, target, "supplies", "{}", .8, deleted, NOW, NOW);
  const addObservation = (id, edge, from, to) => store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id, edge, null, "{}", "s", "q", .8, from, to, null, NOW);
  try {
    assert.throws(() => addNode("00:malformed", "invalid_type")); addNode("10:a"); addNode("11:b"); addNode("12:deleted", "company", NOW);
    let index = 20;
    for (const [id, deleted, from, to] of [["safe", null, JAN_1, DEC_31], ["deleted-edge", NOW, JAN_1, DEC_31], ["expired", null, JAN_1, NOW - 1], ["future", null, NOW + 1, DEC_31]]) {
      const source = `${index++}:source`; const target = `${index++}:target`; addNode(source); addNode(target);
      addEdge(id, source, target, deleted); addObservation(`o:${id}`, id, from, to);
    }
    assert.throws(() => addObservation("o:reversed", "safe", DEC_31, JAN_1));
    addEdge("deleted-node-edge", "10:a", "12:deleted"); addObservation("o:deleted-node", "deleted-node-edge", JAN_1, DEC_31);
    const nodeProjection = store.queryGraphProjection({ maxNodes: 2, maxEdges: 0, asOf: NOW });
    assert.deepEqual(nodeProjection.nodes.map(node => node.id), ["10:a", "11:b"]);
    const edgeProjection = store.queryGraphProjection({ maxNodes: 20, maxEdges: 1, asOf: NOW });
    assert.deepEqual(edgeProjection.edges.map(edge => edge.id), ["safe"]);
  } finally { store.close(); }
});
