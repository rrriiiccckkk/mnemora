import assert from "node:assert/strict";
import test from "node:test";
import { GraphologyStore, InspectorService } from "../dist/index.js";

const NOW = 1_700_000_000_000;

function fixture() {
  const store = new GraphologyStore(":memory:");
  const node = store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,embedding,importance,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,NULL,?,?)");
  node.run("company:alpha", "company", "Alpha", "C:\\secret\\alpha.md", JSON.stringify(["A", ...Array.from({ length: 80 }, (_, i) => `alias-${i}`)]), Buffer.from("embedding"), 1, NOW, NOW);
  node.run("company:beta", "company", "Beta", "/private/beta.md", "[]", Buffer.from("embedding"), 1, NOW, NOW);
  node.run("company:solo", "company", "Solo", "", "[]", null, 0, NOW, NOW);
  node.run("company:deleted", "company", "Deleted", "", "[]", null, 0, NOW, NOW);
  store.db.prepare("UPDATE kg_nodes SET deleted_at=? WHERE id=?").run(NOW, "company:deleted");
  const edge = store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?)");
  edge.run("edge:alpha-beta", "company:alpha", "company:beta", "supplies", "{\"credential\":\"secret\"}", 1, NOW, NOW);
  const observation = store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  observation.run("obs:secret", "edge:alpha-beta", null, "{\"private\":\"SECRET_PAYLOAD\"}", "https://user:password@example.test/private?token=SECRET", "SECRET_QUOTE", .9, NOW - 1, NOW + 1, .8, NOW);
  observation.run("obs:public", "edge:alpha-beta", null, "{\"private\":\"malformed\"}", "report:public", "private quote", .8, null, null, .8, NOW);
  return store;
}

test("inspector health counts active orphan nodes with independently indexed endpoints",()=>{
  const store=fixture();
  try{assert.equal(store.inspectorHealthProjection().orphans,1);const source=store.db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM kg_edges e WHERE e.deleted_at IS NULL AND e.source_id=? LIMIT 1").all("company:solo").map(row=>String(row.detail)).join(" ");const target=store.db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM kg_edges e WHERE e.deleted_at IS NULL AND e.target_id=? LIMIT 1").all("company:solo").map(row=>String(row.detail)).join(" ");assert.match(source,/idx_kg_edges_source/);assert.match(target,/idx_kg_edges_target/);}
  finally{store.close();}
});

test("inspector graph is coherent, stable, bounded, and excludes private storage", () => {
  const store = fixture();
  try {
    const service = new InspectorService({ store, now: () => NOW });
    const first = service.graph({ kind: "graph", max_nodes: 2, max_edges: 1, max_response_bytes: 4 * 1024 * 1024, deadline_ms: 5000 });
    assert.ok(first.next_cursor);
    assert.equal(first.edges.length, 1);
    assert.equal(first.edges.every(edge => first.nodes.some(node => node.id === edge.source_id) && first.nodes.some(node => node.id === edge.target_id)), true);
    assert.equal(first.nodes.length <= 2 && first.edges.length <= 1, true);
    const json = JSON.stringify(first);
    assert.doesNotMatch(json, /SECRET|password|private quote|C:\\secret|\/private|embedding|credential/i);
    assert.equal(first.edges[0].evidence.some(item => item.source === "https://example.test"), true);
    const isolated = service.graph({ kind: "graph", cursor: first.next_cursor, max_nodes: 2, max_edges: 1, max_response_bytes: 4 * 1024 * 1024, deadline_ms: 5000 });
    assert.deepEqual(isolated.nodes.map(node => node.id), ["company:solo"]);
  } finally { store.close(); }
});

test("inspector canonical entity lookup bounds aliases and evidence", () => {
  const store = fixture();
  try {
    const result = new InspectorService({ store, now: () => NOW }).entity({ kind: "entity", id: "a", limit: 100 });
    assert.equal(result.kind, "entity");
    assert.equal(result.id, "company:alpha");
    assert.equal(result.aliases.length <= 50 && result.evidence.length <= 50, true);
    assert.deepEqual(result.relationships.map(item => item.id), ["edge:alpha-beta"]);
    assert.equal(result.timeline.length > 0, true);
    assert.equal(result.ranking_factors.degree, 1);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|password|private quote|C:\\secret|\/private|embedding|credential/i);
  } finally { store.close(); }
});

test("inspector canonical entity lookup is case-insensitive", () => {
  const store = fixture();
  try {
    const result = new InspectorService({ store, now: () => NOW }).entity({ kind: "entity", id: "COMPANY:ALPHA" });
    assert.equal(result.id, "company:alpha");
  } finally { store.close(); }
});

test("inspector graph retains an explicitly filtered isolated entity", () => {
  const store = fixture();
  try {
    const result = new InspectorService({ store, now: () => NOW }).graph({ kind: "graph", max_nodes: 2, max_edges: 1, filters: { ids: ["company:solo"] } });
    assert.deepEqual(result.nodes.map(node => node.id), ["company:solo"]);
    assert.deepEqual(result.edges, []);
  } finally { store.close(); }
});

test("display labels are sanitized without dropping valid entities", () => {
  const hostile = "https://user:password@example.test/private?token=SECRET";
  const store = {
    graphRevision: () => 1,
    inspectorGraphProjection: () => ({ graph_revision: 1, next_cursor: null, truncated: false,
      nodes: [{ id: "company:alpha", name: hostile, type: "company" }], edges: [] }),
    inspectorEntityProjection: () => ({ graph_revision: 1, entity: { id: "company:alpha", name: hostile, type: "company", aliases: ["C:\\private\\alias"] }, evidence: [] }),
    inspectorOverviewProjection: () => ({ graph_revision: 1, nodes: 1, edges: 0, observations: 0 }),
    inspectorHealthProjection: () => ({ graph_revision: 1, orphans: 0, conflicts: 0, duplicate_candidates: 0 }),
    inspectorResearchProjection: () => ({ items: [{ id: hostile, status: "ok" }], next_cursor: null })
  };
  const service = new InspectorService({ store, now: () => NOW });
  const entity = service.entity({ kind: "entity", id: "company:alpha" });
  assert.equal(entity.name, "https://example.test/private");
  assert.deepEqual(entity.aliases, ["[redacted]"]);
  assert.deepEqual(service.research({ kind: "research" }).items, []);
});

test("malformed nested inspector rows preserve their valid container with a warning", () => {
  const store = {
    graphRevision: () => 1,
    inspectorEntityProjection: () => ({ graph_revision: 1, entity: { id: "company:alpha", name: "Alpha", type: "company", aliases: ["A", "https://user:secret@example.test"] }, evidence: [{ source: "report:ok", confidence: .8, valid_from: null, valid_to: null, relationship_type: "supplies" }, { source: "report:bad", confidence: 2, valid_from: null, valid_to: null, relationship_type: "supplies" }], relationships: [], timeline: [], ranking_factors: {} }),
    inspectorGraphProjection: () => ({ graph_revision: 1, nodes: [], edges: [], next_id: null, truncated: false }),
    inspectorOverviewProjection: () => ({ graph_revision: 1, nodes: 0, edges: 0, observations: 0 }),
    inspectorHealthProjection: () => ({ graph_revision: 1, orphans: 0, conflicts: 0, duplicate_candidates: 0 }),
    inspectorResearchProjection: () => ({ items: [], next: null, truncated: false })
  };
  const result = new InspectorService({ store, now: () => NOW }).entity({ kind: "entity", id: "company:alpha" });
  assert.deepEqual(result.aliases, ["A", "https://example.test/"]);
  assert.equal(result.evidence.length, 1);
  assert.deepEqual(result.warnings, [{ code: "malformed_row" }]);
  assert.equal(result.truncated, true);
});

test("graph evidence cap is applied per edge rather than starving later edges", () => {
  const store = fixture();
  try {
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?)").run("company:gamma", "company", "Gamma", "", "[]", 0, NOW, NOW);
    store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?)").run("edge:beta-gamma", "company:beta", "company:gamma", "supplies", "{}", 1, NOW, NOW);
    const insert = store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    for (let index = 0; index < 50; index++) insert.run(`obs:many:${index}`, "edge:alpha-beta", null, "{}", "report:public", "q", .8, null, null, null, NOW + index);
    insert.run("obs:later", "edge:beta-gamma", null, "{}", "report:later", "q", .8, null, null, null, NOW);
    const result = new InspectorService({ store, now: () => NOW }).graph({ kind: "graph", max_nodes: 3, max_edges: 2 });
    assert.equal(result.edges.find(edge => edge.id === "edge:alpha-beta").evidence.length <= 20, true);
    assert.equal(result.edges.find(edge => edge.id === "edge:beta-gamma").evidence.some(item => item.source === "report:later"), true);
  } finally { store.close(); }
});

test("opaque graph cursors are keyset-bound to revision and reach each page once", () => {
  const store = fixture();
  try {
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?)").run("company:gamma", "company", "Gamma", "", "[]", 0, NOW, NOW);
    const edge = store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?)");
    edge.run("edge:alpha-gamma", "company:alpha", "company:gamma", "supplies", "{}", 1, NOW, NOW);
    edge.run("edge:beta-gamma", "company:beta", "company:gamma", "supplies", "{}", 1, NOW, NOW);
    const observation = store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    observation.run("obs:ag", "edge:alpha-gamma", null, "{}", "report:public", "q", .8, null, null, null, NOW);
    observation.run("obs:bg", "edge:beta-gamma", null, "{}", "report:public", "q", .8, null, null, null, NOW);
    const service = new InspectorService({ store, now: () => NOW });
    const first = service.graph({ kind: "graph", max_nodes: 3, max_edges: 1 });
    const second = service.graph({ kind: "graph", cursor: first.next_cursor, max_nodes: 3, max_edges: 1 });
    const third = service.graph({ kind: "graph", cursor: second.next_cursor, max_nodes: 3, max_edges: 1 });
    assert.deepEqual([...first.edges, ...second.edges, ...third.edges].map(edge => edge.id), ["edge:alpha-beta", "edge:alpha-gamma", "edge:beta-gamma"]);
    assert.throws(() => service.graph({ kind: "graph", cursor: `${first.next_cursor}x` }), /invalid inspector cursor/);
  } finally { store.close(); }
});

test("graph node-budget continuation resumes the first omitted valid edge", () => {
  const store = fixture();
  try {
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?)").run("company:gamma", "company", "Gamma", "", "[]", 0, NOW, NOW);
    store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?)").run("edge:alpha-gamma", "company:alpha", "company:gamma", "supplies", "{}", 1, NOW, NOW);
    store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("obs:ag", "edge:alpha-gamma", null, "{}", "report:public", "q", .8, null, null, null, NOW);
    const service = new InspectorService({ store, now: () => NOW });
    const first = service.graph({ kind: "graph", max_nodes: 2, max_edges: 2 });
    assert.deepEqual(first.edges.map(edge => edge.id), ["edge:alpha-beta"]);
    assert.ok(first.next_cursor);
    const second = service.graph({ kind: "graph", cursor: first.next_cursor, max_nodes: 2, max_edges: 2 });
    assert.deepEqual(second.edges.map(edge => edge.id), ["edge:alpha-gamma"]);
  } finally { store.close(); }
});

test("isolated graph nodes use opaque keyset continuation", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const insert = store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?)");
    insert.run("company:one", "company", "One", "", "[]", 0, NOW, NOW);
    insert.run("company:two", "company", "Two", "", "[]", 0, NOW, NOW);
    insert.run("company:three", "company", "Three", "", "[]", 0, NOW, NOW);
    const service = new InspectorService({ store, now: () => NOW });
    const first = service.graph({ kind: "graph", max_nodes: 1, max_edges: 1 });
    const second = service.graph({ kind: "graph", max_nodes: 1, max_edges: 1, cursor: first.next_cursor });
    const third = service.graph({ kind: "graph", max_nodes: 1, max_edges: 1, cursor: second.next_cursor });
    assert.deepEqual([...first.nodes, ...second.nodes, ...third.nodes].map(node => node.id), ["company:one", "company:three", "company:two"]);
    assert.equal(third.next_cursor, null);
  } finally { store.close(); }
});

test("graph serialized envelope including a cursor never exceeds its requested byte cap", () => {
  const store = fixture();
  try {
    const service = new InspectorService({ store, now: () => NOW });
    const result = service.graph({ kind: "graph", max_nodes: 2, max_edges: 1, max_response_bytes: 256 });
    assert.equal(Buffer.byteLength(JSON.stringify(result), "utf8") <= 256, true);
  } finally { store.close(); }
});

test("an individually oversized graph edge is warned and keyset-advanced", () => {
  const calls = [];
  const evidence = Array.from({ length: 20 }, () => ({ source: "report:public", confidence: .8, valid_from: null, valid_to: null, relationship_type: "supplies" }));
  const store = {
    graphRevision: () => 1,
    inspectorGraphProjection: (input) => {
      calls.push(input);
      return input.position?.id === "edge:large" ? { graph_revision: 1, phase: "edge", nodes: [], edges: [], next: null, truncated: false } : {
        graph_revision: 1, phase: "edge", nodes: [{ id: "company:alpha", name: "Alpha", type: "company" }, { id: "company:beta", name: "Beta", type: "company" }],
        edges: [{ id: "edge:large", source_id: "company:alpha", target_id: "company:beta", type: "supplies", confidence: .8, evidence }], next: null, truncated: false
      };
    },
    inspectorEntityProjection: () => ({ graph_revision: 1, evidence: [], relationships: [], timeline: [], ranking_factors: {} }),
    inspectorOverviewProjection: () => ({ graph_revision: 1, nodes: 0, edges: 0, observations: 0 }),
    inspectorHealthProjection: () => ({ graph_revision: 1, orphans: 0, conflicts: 0, duplicate_candidates: 0 }),
    inspectorResearchProjection: () => ({ items: [], next: null })
  };
  const service = new InspectorService({ store, now: () => NOW });
  const first = service.graph({ kind: "graph", max_response_bytes: 512 });
  assert.deepEqual(first.warnings, [{ code: "unrepresentable_item" }]);
  assert.ok(first.next_cursor);
  assert.equal(Buffer.byteLength(JSON.stringify(first), "utf8") <= 512, true);
  service.graph({ kind: "graph", max_response_bytes: 512, cursor: first.next_cursor });
  assert.equal(calls[1].position.id, "edge:large");
});

test("graph community ids and colors are derived by the existing community detector", () => {
  const store = fixture();
  try {
    const service = new InspectorService({ store, now: () => NOW });
    const graph = service.graph({ kind: "graph", max_nodes: 2, max_edges: 1 });
    assert.equal(graph.nodes.every(node => node.community_id !== null && /^#[0-9a-f]{6}$/i.test(node.community_color)), true);
    const filtered = service.graph({ kind: "graph", max_nodes: 2, max_edges: 1, filters: { community_id: graph.nodes[0].community_id } });
    assert.equal(filtered.nodes.every(node => node.community_id === graph.nodes[0].community_id), true);
  } finally { store.close(); }
});

test("community membership is page-bounded and does not issue a second global projection", () => {
  const store = fixture();
  try {
    store.insightGraphProjection = () => { throw new Error("global projection must not run on graph-page reads"); };
    const service = new InspectorService({ store, now: () => NOW });
    const first = service.graph({ kind: "graph", max_nodes: 2, max_edges: 1 });
    const second = service.graph({ kind: "graph", max_nodes: 2, max_edges: 1 });
    assert.deepEqual(second.nodes.map(node => node.community_id), first.nodes.map(node => node.community_id));
  } finally { store.close(); }
});

test("research history uses opaque keyset cursors with exactly-once continuation", () => {
  const store = fixture();
  try {
    const insert = store.db.prepare("INSERT INTO kg_query_runs(id,plan_hash,normalized_plan,status,graph_revision,result_count,duration_ms,error_category,created_at) VALUES(?,?,?,?,?,?,?,?,?)");
    insert.run("query:one", "a".repeat(64), "{\"kind\":\"query_audit_plan\",\"version\":1,\"steps\":[],\"limit\":1}", "succeeded", 1, 1, 2, null, NOW + 1);
    insert.run("query:two", "b".repeat(64), "{\"kind\":\"query_audit_plan\",\"version\":1,\"steps\":[],\"limit\":1}", "succeeded", 1, 1, 2, null, NOW + 2);
    const service = new InspectorService({ store, now: () => NOW });
    const first = service.research({ kind: "research", section: "history", limit: 1 });
    const second = service.research({ kind: "research", section: "history", limit: 1, cursor: first.next_cursor });
    assert.deepEqual([...first.items, ...second.items].map(item => item.id), ["query:two", "query:one"]);
    assert.equal(first.items[0].graph_revision, 1);
    assert.throws(() => service.research({ kind: "research", section: "history", cursor: `${first.next_cursor}x` }), /invalid inspector cursor/);
    insert.run("query:same-time", "c".repeat(64), "{\"kind\":\"query_audit_plan\",\"version\":1,\"steps\":[],\"limit\":1}", "succeeded", 1, 1, 2, null, NOW + 2);
    assert.throws(() => service.research({ kind: "research", section: "history", cursor: first.next_cursor }), /invalid inspector cursor/);
  } finally { store.close(); }
});

test("research cursors reject same-timestamp updates and deletes", () => {
  const store = fixture();
  try {
    const insert = store.db.prepare("INSERT INTO kg_query_runs(id,plan_hash,normalized_plan,status,graph_revision,result_count,duration_ms,error_category,created_at) VALUES(?,?,?,?,?,?,?,?,?)");
    insert.run("query:one", "a".repeat(64), "{\"kind\":\"query_audit_plan\",\"version\":1,\"steps\":[],\"limit\":1}", "succeeded", 1, 1, 2, null, NOW);
    insert.run("query:two", "b".repeat(64), "{\"kind\":\"query_audit_plan\",\"version\":1,\"steps\":[],\"limit\":1}", "succeeded", 1, 1, 2, null, NOW);
    const service = new InspectorService({ store, now: () => NOW });
    const updateCursor = service.research({ kind: "research", section: "history", limit: 1 }).next_cursor;
    store.db.prepare("UPDATE kg_query_runs SET status=? WHERE id=?").run("failed", "query:two");
    assert.throws(() => service.research({ kind: "research", section: "history", cursor: updateCursor }), /invalid inspector cursor/);
    const deleteCursor = service.research({ kind: "research", section: "history", limit: 1 }).next_cursor;
    store.db.prepare("DELETE FROM kg_query_runs WHERE id=?").run("query:one");
    assert.throws(() => service.research({ kind: "research", section: "history", cursor: deleteCursor }), /invalid inspector cursor/);
  } finally { store.close(); }
});

test("research refreshes missing and stale insight snapshots through injected analytics", async () => {
  const store = fixture();
  try {
    const calls = [];
    const analytics = { analyze: async input => {
      calls.push(input);
      return { status: "ok", graph_revision: store.graphRevision(), algorithm_version: "test", cache_hit: false, truncated: false, communities: [], insights: [{ id: "insight:fresh", kind: "knowledge_gap", score: .9, entity_ids: [], relationship_ids: [], community_ids: [], signals: {} }], warnings: [] };
    } };
    const service = new InspectorService({ store, analytics, now: () => NOW });
    const missing = await service.research({ kind: "research", section: "insights" });
    assert.deepEqual(calls, [{ explain: false, scope: "default" }]);
    assert.deepEqual(missing.items.map(item => item.id), ["insight:fresh"]);

    store.bumpGraphRevision();
    store.writeInsightSnapshot("stale", { graphRevision: store.graphRevision() - 1, algorithmVersion: "test", createdAt: NOW, truncated: false, communities: [], insights: [], warnings: [] });
    const stale = await service.research({ kind: "research", section: "insights" });
    assert.deepEqual(stale.items.map(item => item.id), ["insight:fresh"]);
    assert.equal(calls.length, 2);
  } finally { store.close(); }
});

test("analytics-backed insight fallback keeps opaque keyset continuation", async () => {
  const store = fixture();
  try {
    const analytics = { analyze: async () => ({ status: "ok", graph_revision: store.graphRevision(), algorithm_version: "test", cache_hit: false, truncated: false, communities: [], insights: [
      { id: "insight:one", kind: "knowledge_gap", score: .9, entity_ids: [], relationship_ids: [], community_ids: [], signals: {} },
      { id: "insight:two", kind: "knowledge_gap", score: .8, entity_ids: [], relationship_ids: [], community_ids: [], signals: {} }
    ], warnings: [] }) };
    const service = new InspectorService({ store, analytics, now: () => NOW });
    const first = await service.research({ kind: "research", section: "insights", limit: 1 });
    const second = await service.research({ kind: "research", section: "insights", limit: 1, cursor: first.next_cursor });
    assert.ok(first.next_cursor);
    assert.deepEqual([...first.items, ...second.items].map(item => item.id), ["insight:one", "insight:two"]);
  } finally { store.close(); }
});

test("research marks malformed insight snapshots as truncated instead of exposing them", () => {
  const store = fixture();
  try {
    store.db.prepare("INSERT INTO kg_insight_snapshots(cache_key,graph_revision,algorithm_version,snapshot,created_at) VALUES(?,?,?,?,?)").run("bad", store.graphRevision(), "test", "{not-json", NOW);
    const result = new InspectorService({ store, now: () => NOW }).research({ kind: "research", section: "insights" });
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.warnings, [{ code: "malformed_row" }]);
    assert.equal(result.truncated, true);
  } finally { store.close(); }
});

test("research treats oversized current insight snapshots as malformed without materializing them", () => {
  const store = fixture();
  try {
    store.db.prepare("INSERT INTO kg_insight_snapshots(cache_key,graph_revision,algorithm_version,snapshot,created_at) VALUES(?,?,?,?,?)").run("too-large", store.graphRevision(), "test", "x".repeat(1_048_577), NOW);
    const result = new InspectorService({ store, now: () => NOW }).research({ kind: "research", section: "insights" });
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.warnings, [{ code: "malformed_row" }]);
    assert.equal(result.truncated, true);
  } finally { store.close(); }
});

test("research fallback remains cancellable after injected analytics starts", async () => {
  const store = fixture();
  try {
    const controller = new AbortController();
    const service = new InspectorService({ store, now: () => NOW, analytics: { analyze: async () => {
      controller.abort();
      return { status: "ok", graph_revision: 0, algorithm_version: "test", cache_hit: false, truncated: false, communities: [], insights: [], warnings: [] };
    } } });
    const result = await service.research({ kind: "research", section: "insights" }, { signal: controller.signal });
    assert.deepEqual(result.warnings, [{ code: "cancelled" }]);
    assert.equal(result.truncated, true);
  } finally { store.close(); }
});

test("entity relationship pages use opaque revision-bound keyset cursors", () => {
  const store = fixture();
  try {
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?)").run("company:gamma", "company", "Gamma", "", "[]", 0, NOW, NOW);
    store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?)").run("edge:alpha-gamma", "company:alpha", "company:gamma", "supplies", "{}", 1, NOW, NOW);
    store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("obs:ag", "edge:alpha-gamma", null, "{}", "report:public", "q", .8, null, null, null, NOW);
    const service = new InspectorService({ store, now: () => NOW });
    const first = service.entity({ kind: "entity", id: "company:alpha", limit: 1 });
    const second = service.entity({ kind: "entity", id: "company:alpha", limit: 1, cursor: first.next_cursor });
    assert.deepEqual([...first.relationships, ...second.relationships].map(item => item.id), ["edge:alpha-beta", "edge:alpha-gamma"]);
    assert.throws(() => service.entity({ kind: "entity", id: "company:alpha", limit: 1, cursor: `${first.next_cursor}x` }), /invalid inspector cursor/);
    store.bumpGraphRevision();
    assert.throws(() => service.entity({ kind: "entity", id: "company:alpha", limit: 1, cursor: first.next_cursor }), /invalid inspector cursor/);
  } finally { store.close(); }
});

test("entity detail sections paginate independently and reject cross-section cursors", () => {
  const store = fixture();
  try {
    const insert = store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    insert.run("obs:one", "edge:alpha-beta", null, "{}", "report:one", "q", .8, null, null, null, NOW + 1);
    insert.run("obs:two", "edge:alpha-beta", null, "{}", "report:two", "q", .8, null, null, null, NOW + 2);
    const service = new InspectorService({ store, now: () => NOW });
    const aliases = service.entity({ kind: "entity", id: "company:alpha", section: "aliases", limit: 1 });
    assert.equal(aliases.aliases.length, 1);
    assert.deepEqual(aliases.evidence, []);
    assert.ok(aliases.next_cursor);
    const aliasesNext = service.entity({ kind: "entity", id: "company:alpha", section: "aliases", limit: 1, cursor: aliases.next_cursor });
    assert.equal(aliasesNext.aliases.length, 1);
    assert.notEqual(aliases.aliases[0], aliasesNext.aliases[0]);
    assert.throws(() => service.entity({ kind: "entity", id: "company:alpha", section: "evidence", limit: 1, cursor: aliases.next_cursor }), /invalid inspector cursor/);

    const evidence = service.entity({ kind: "entity", id: "company:alpha", section: "evidence", limit: 1 });
    assert.equal(evidence.evidence.length, 1);
    assert.ok(evidence.next_cursor);
    const evidenceNext = service.entity({ kind: "entity", id: "company:alpha", section: "evidence", limit: 1, cursor: evidence.next_cursor });
    assert.equal(evidenceNext.evidence.length, 1);
    assert.notEqual(evidence.evidence[0].source, evidenceNext.evidence[0].source);
  } finally { store.close(); }
});

test("entity timeline cursors are entity- and revision-bound", () => {
  const store = fixture();
  try {
    const insert = store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    insert.run("obs:timeline:one", "edge:alpha-beta", null, "{}", "report:one", "q", .8, null, null, null, NOW + 10);
    insert.run("obs:timeline:two", "edge:alpha-beta", null, "{}", "report:two", "q", .8, null, null, null, NOW + 20);
    const service = new InspectorService({ store, now: () => NOW });
    const first = service.entity({ kind: "entity", id: "company:alpha", section: "timeline", limit: 1 });
    assert.equal(first.timeline.length, 1);
    assert.ok(first.next_cursor);
    const second = service.entity({ kind: "entity", id: "company:alpha", section: "timeline", limit: 1, cursor: first.next_cursor });
    assert.equal(second.timeline.length, 1);
    store.bumpGraphRevision();
    assert.throws(() => service.entity({ kind: "entity", id: "company:alpha", section: "timeline", limit: 1, cursor: first.next_cursor }), /invalid inspector cursor/);
  } finally { store.close(); }
});

test("inspector execution options stop every read surface with bounded categories", () => {
  const store = fixture();
  try {
    const service = new InspectorService({ store, now: () => NOW });
    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(service.graph({ kind: "graph" }, { signal: aborted.signal }).warnings, [{ code: "cancelled" }]);
    assert.deepEqual(service.overview({ signal: aborted.signal }).warnings, [{ code: "cancelled" }]);
    assert.deepEqual(service.research({ kind: "research" }, { signal: aborted.signal }).warnings, [{ code: "cancelled" }]);
    assert.equal(service.healthSummary({ signal: aborted.signal }).status, "unavailable");
    assert.throws(() => service.entity({ kind: "entity", id: "company:alpha" }, { signal: aborted.signal }), /inspector cancelled/);
    const mid = new AbortController();
    let checks = 0;
    const result = service.graph({ kind: "graph" }, { signal: mid.signal, check: () => { if (++checks === 3) mid.abort(); } });
    assert.deepEqual(result.warnings, [{ code: "cancelled" }]);
    assert.equal(result.truncated, true);
    assert.deepEqual(service.research({ kind: "research" }, { deadlineAt: NOW - 1 }).warnings, [{ code: "deadline" }]);
  } finally { store.close(); }
});

test("inspector returns only normalized aggregate and research contracts", () => {
  const store = fixture();
  try {
    const service = new InspectorService({ store, now: () => NOW });
    assert.deepEqual(Object.keys(service.overview()).sort(), ["edges", "graph_revision", "health", "kind", "nodes", "observations", "warnings"]);
    assert.deepEqual(Object.keys(service.healthSummary()).sort(), ["counts", "graph_revision", "kind", "recovery", "status"]);
    const history = service.research({ kind: "research", section: "history", limit: 100 });
    assert.equal(history.kind, "research");
    assert.equal(history.items.length <= 100, true);
  } finally { store.close(); }
});
