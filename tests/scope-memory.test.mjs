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

test("scoped analysis, audits, watches, and Inspector all use the same graph projection", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:", recall: { mode: "lexical" } } });
  try {
    await graph.kg_ingest("scope a", "fixture:a", { entities: [entity("Acme"), entity("Alpha", "product")], relations: [relation("Acme", "Alpha")] }, "project:a");
    await graph.kg_ingest("scope b", "fixture:b", { entities: [entity("Acme"), entity("Beta", "product")], relations: [relation("Acme", "Beta")] }, "project:b");
    const plan = { version: 1, steps: [{ op: "lookup", query: "Alpha", mode: "lexical" }], order_by: "name", limit: 10 };
    const alpha = await graph.kg_query({ plan, scope: "project:a" });
    const beta = await graph.kg_query({ plan, scope: "project:b" });
    assert.deepEqual(alpha.entities.map(item => item.name), ["Alpha"]);
    assert.deepEqual(beta.entities, []);
    assert.equal(graph.kg_query_history({ scope: "project:a" }).every(item => item.scope === "project:a"), true);
    assert.equal(graph.kg_query_history({ scope: "project:b" }).every(item => item.scope === "project:b"), true);

    const aProjection = graph.store.queryGraphProjection({ maxNodes: 20, maxEdges: 20, asOf: Date.now(), scope: "project:a" });
    const bProjection = graph.store.insightGraphProjection({ maxNodes: 20, maxEdges: 20, confidenceFloor: 0, asOf: Date.now(), scope: "project:b" });
    assert.deepEqual(aProjection.nodes.map(node => node.name).sort(), ["Acme", "Alpha"]);
    assert.deepEqual(bProjection.nodes.map(node => node.name).sort(), ["Acme", "Beta"]);
    assert.deepEqual(aProjection.edges.map(edge => edge.target).sort(), [graph.store.resolveEntity("Alpha")?.id]);
    assert.throws(() => graph.kg_timeline({ subject: "Alpha", scope: "project:b" }), /subject not found/);
    await assert.rejects(graph.kg_compare({ left: "Acme", right: "Alpha", scope: "project:b" }));

    graph.kg_watch({ operation: "create", id: "watch:a", name: "A", plan: { version: 1, steps: [{ op: "lookup", query: "Acme", mode: "lexical" }], order_by: "name", limit: 10 }, schedule_hint: "manual", scope: "project:a" });
    graph.kg_watch({ operation: "create", id: "watch:b", name: "B", plan: { version: 1, steps: [{ op: "lookup", query: "Acme", mode: "lexical" }], order_by: "name", limit: 10 }, schedule_hint: "manual", scope: "project:b" });
    assert.deepEqual(graph.kg_watch({ operation: "list", scope: "project:a" }).map(item => item.id), ["watch:a"]);
    const digest = await graph.kg_digest({ idempotency_key: "scope-a", scope: "project:a" });
    assert.deepEqual(digest.watches.map(item => item.watch_id), ["watch:a"]);

    const inspector = new InspectorService({ store: graph.store, analytics: graph.insights });
    const page = inspector.graph({ kind: "graph", scope: "project:a" });
    assert.deepEqual(page.nodes.map(node => node.name).sort(), ["Acme", "Alpha"]);
    assert.throws(() => inspector.entity({ kind: "entity", id: "Beta", scope: "project:a" }), /entity not found/);
    const history = inspector.research({ kind: "research", section: "history", scope: "project:a" });
    assert.equal((await history).items.every(item => item.id.startsWith("query:")), true);
  } finally { graph.close(); }
});
