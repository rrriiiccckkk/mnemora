import assert from "node:assert/strict";
import test from "node:test";
import { Mnemora, InspectorService, normalizeConfig } from "../dist/index.js";

const entity = (name, type = "company") => ({ name, type, confidence: .9, evidence_span: `${name} evidence` });
const relation = (source, target, type = "supplies_product") => ({ source, target, type, confidence: .9, evidence_span: `${source} ${type} ${target}` });

test("scopes isolate graph search, traversal, context, and ingestion deduplication", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:", recall: { mode: "lexical" } } });
  try {
    const a = { entities: [entity("Acme"), entity("Alpha", "product")], relations: [relation("Acme", "Alpha", "related_to")] };
    const b = { entities: [entity("Acme"), entity("Beta", "product")], relations: [relation("Acme", "Beta", "related_to")] };
    await graph.kg_ingest("same input", "fixture:shared", a, "project:a");
    await graph.kg_ingest("same input", "fixture:shared", b, "project:b");

    assert.deepEqual((await graph.kg_search("Alpha", undefined, 5, "lexical", undefined, "project:a")).map(item => item.node.name), ["Alpha"]);
    assert.deepEqual(await graph.kg_search("Alpha", undefined, 5, "lexical", undefined, "project:b"), []);
    assert.deepEqual(graph.kg_related("Acme", 1, undefined, undefined, "project:a").edges.map(item => item.target.name), ["Alpha"]);
    assert.deepEqual(graph.kg_related("Acme", 1, undefined, undefined, "project:b").edges.map(item => item.target.name), ["Beta"]);
    assert.throws(() => graph.kg_related("Alpha", 1, undefined, undefined, "project:b"), /Entity not found/);
    const hidden = await graph.kg_context("Alpha", 5, 1, 0, 500, "lexical", undefined, "project:b");
    assert.equal(hidden.nodes.length, 0);
    assert.equal(hidden.edges.length, 0);
  } finally { graph.close(); }
});

test("omitted scope stays isolated while kg_scopes exposes only bounded aggregates", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:", recall: { mode: "lexical" }, scope: { default: "project:alpha" } } });
  try {
    await graph.kg_ingest("alpha", "fixture:alpha", { entities: [entity("Alphascopetoken")], relations: [] }, "project:alpha");
    await graph.kg_ingest("beta", "fixture:beta", { entities: [entity("Betascopetoken")], relations: [] }, "project:beta");

    assert.deepEqual((await graph.kg_search("Alphascopetoken", undefined, 5, "lexical")).map(item => item.node.name), ["Alphascopetoken"]);
    assert.deepEqual(await graph.kg_search("Betascopetoken", undefined, 5, "lexical"), []);
    const hiddenContext = await graph.kg_context("Betascopetoken", 5, 1, 0, 500, "lexical");
    assert.equal(hiddenContext.nodes.length, 0);
    assert.equal(hiddenContext.edges.length, 0);

    const discovery = graph.kg_scopes();
    assert.equal(discovery.default_scope, "project:alpha");
    assert.deepEqual(discovery.scopes.map(item => item.id).sort(), ["default", "project:alpha", "project:beta"]);
    assert.equal(discovery.scopes.some(item => item.id === "project:alpha" && item.observations === 1), true);
    for (const scope of discovery.scopes) assert.deepEqual(Object.keys(scope).sort(), ["id", "memory_documents", "observations", "updated_at"]);
  } finally { graph.close(); }
});

test("memory documents are local, scope-filtered, and can ground memory-only context", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:", recall: { mode: "lexical" }, memory: { maxResults: 2 } } });
  try {
    const stored = graph.kg_memory({ operation: "store", scope: "research:semiconductor", title: "HBM thesis", source: "memory:test", content: "HBM packaging capacity is the current supply-chain constraint." });
    assert.match(stored.id, /^memory:[a-f0-9]{24}$/);
    graph.kg_memory({ operation: "store", scope: "personal", title: "Private", content: "unrelated private note" });

    assert.equal(graph.kg_memory({ operation: "search", scope: "research:semiconductor", query: "packaging capacity" }).length, 1);
    assert.deepEqual(graph.kg_memory({ operation: "search", scope: "personal", query: "packaging capacity" }), []);
    const context = await graph.kg_context("packaging capacity", 5, 1, 0, 500, "lexical", undefined, "research:semiconductor");
    assert.equal(context.nodes.length, 0);
    assert.equal(context.memories?.length, 1);
    assert.match(context.context, /Memory documents:/);
    assert.match(context.context, /HBM packaging capacity/);
    const scopes = graph.kg_memory({ operation: "list_scopes" });
    assert.deepEqual(scopes.map(item => item.id).sort(), ["default", "personal", "research:semiconductor"]);
  } finally { graph.close(); }
});

test("scope configuration canonicalizes defaults and rejects unsafe explicit identifiers", async () => {
  assert.equal(normalizeConfig({ scope: { default: "Project:Alpha" } }).scope?.default, "project:alpha");
  assert.equal(normalizeConfig({ scope: { default: "../../unsafe" } }).scope?.default, "default");
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    assert.throws(() => graph.kg_memory({ operation: "search", query: "x", scope: "../../unsafe" }), /invalid_scope/);
  } finally { graph.close(); }
});

test("scoped graph projection and Inspector stay scope-isolated", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:", recall: { mode: "lexical" } } });
  try {
    await graph.kg_ingest("scope a", "fixture:a", { entities: [entity("Acme"), entity("Alpha", "product")], relations: [relation("Acme", "Alpha")] }, "project:a");
    await graph.kg_ingest("scope b", "fixture:b", { entities: [entity("Acme"), entity("Beta", "product")], relations: [relation("Acme", "Beta")] }, "project:b");
    const aProjection = graph.store.insightGraphProjection({ maxNodes: 20, maxEdges: 20, confidenceFloor: 0, asOf: Date.now(), scope: "project:a" });
    const bProjection = graph.store.insightGraphProjection({ maxNodes: 20, maxEdges: 20, confidenceFloor: 0, asOf: Date.now(), scope: "project:b" });
    assert.deepEqual(aProjection.nodes.map(node => node.name).sort(), ["Acme", "Alpha"]);
    assert.deepEqual(bProjection.nodes.map(node => node.name).sort(), ["Acme", "Beta"]);

    const inspector = new InspectorService({ store: graph.store });
    const page = inspector.graph({ kind: "graph", scope: "project:a" });
    assert.deepEqual(page.nodes.map(node => node.name).sort(), ["Acme", "Alpha"]);
    assert.throws(() => inspector.entity({ kind: "entity", id: "Beta", scope: "project:a" }), /entity not found/);
    const history = await inspector.research({ kind: "research", section: "history", scope: "project:a" });
    assert.deepEqual(history.items, []);
  } finally { graph.close(); }
});
