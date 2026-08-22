import assert from "node:assert/strict";
import test from "node:test";
import { GraphologyStore } from "../dist/store.js";
import { GraphAnalyticsService } from "../dist/insights/service.js";
import { detectCrossCommunityPaths } from "../dist/insights/detectors.js";

const NOW = Date.parse("2026-07-15T00:00:00.000Z");

function addNodes(store, names) {
  store.ingest(names.map(name => ({ name, type: "company", confidence: .95, evidence_span: `entity ${name}` })), [], "entities");
  return Object.fromEntries(names.map(name => [name, store.resolveEntity(name).id]));
}

function addRawEdge(store, { id, source, target, type = "related_to", confidence = .9, sourceName = "fixture", validFrom = null, validTo = null, quote = "secret observation" }) {
  store.db.prepare(`INSERT INTO kg_edges (id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,NULL,?,?)`).run(id, source, target, type, "{}", 0, NOW, NOW);
  store.db.prepare(`INSERT INTO kg_observations (id,edge_id,source_entity_id,payload,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(`obs:${id}`, id, null, "{\"private\":true}", sourceName, quote, confidence, validFrom, validTo, null, NOW);
}

function graphWithValidExpiredDeletedGenericAndSelfLoopEdges() {
  const store = new GraphologyStore(":memory:");
  const ids = addNodes(store, ["A", "B", "C", "D", "E", "F"]);
  store.db.prepare("UPDATE kg_nodes SET description=? WHERE id=?").run("SECRET_DESCRIPTION", ids.A);
  addRawEdge(store, { id: "valid", source: ids.A, target: ids.B, type: "supplies", confidence: .9, sourceName: "SECRET_SOURCE", quote: "SECRET_URL" });
  store.db.prepare(`INSERT INTO kg_observations (id,edge_id,source_entity_id,payload,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run("obs:valid:two", "valid", null, "{}", "source:two", "another secret observation", .8, null, null, null, NOW + 1);
  addRawEdge(store, { id: "expired", source: ids.B, target: ids.C, type: "supplies", confidence: .99, validTo: NOW - 1 });
  addRawEdge(store, { id: "deleted", source: ids.C, target: ids.D, type: "supplies", confidence: .99 });
  store.db.prepare("UPDATE kg_edges SET deleted_at=? WHERE id=?").run(NOW, "deleted");
  addRawEdge(store, { id: "self-loop", source: ids.D, target: ids.D, type: "related_to", confidence: .99 });
  addRawEdge(store, { id: "generic", source: ids.E, target: ids.F, type: "related_to", confidence: .95 });
  addRawEdge(store, { id: "below-confidence", source: ids.A, target: ids.C, type: "supplies", confidence: .59, sourceName: "SECRET_SOURCE", quote: "SECRET_URL SECRET_DESCRIPTION" });
  return { store, ids };
}

test("insight projection is bounded, current, weighted, and contains no evidence text", () => {
  const { store } = graphWithValidExpiredDeletedGenericAndSelfLoopEdges();
  try {
    const result = store.insightGraphProjection({ maxNodes: 20, maxEdges: 20, confidenceFloor: .6, asOf: NOW });
    assert.equal(result.nodes.length <= 20, true);
    assert.equal(result.edges.length <= 20, true);
    assert.equal(result.edges.every(edge => edge.source !== edge.target), true);
    assert.equal(result.edges.some(edge => edge.id === "expired"), false);
    assert.equal(result.edges.some(edge => edge.id === "below-confidence"), false);
    assert.equal(JSON.stringify(result).includes("secret observation"), false);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_(?:SOURCE|URL|DESCRIPTION)/);
    assert.deepEqual(Object.keys(result.nodes[0]).sort(), ["id", "name", "type"]);
    assert.deepEqual(Object.keys(result.edges.find(edge => edge.id === "valid")).sort(), ["confidence", "evidenceCount", "firstSeenAt", "id", "lastSeenAt", "source", "sourceCount", "target", "type", "weight"]);
    assert.equal(result.edges.find(edge => edge.type === "related_to")?.weight < 1, true);
    assert.equal(result.graphRevision, 1);
  } finally { store.close(); }
});

test("insight projection aggregates evidence and is deterministically ordered", () => {
  const { store } = graphWithValidExpiredDeletedGenericAndSelfLoopEdges();
  try {
    const options = { maxNodes: 20, maxEdges: 20, confidenceFloor: .6, asOf: NOW };
    const first = store.insightGraphProjection(options);
    const second = store.insightGraphProjection(options);
    assert.deepEqual(second, first);
    assert.deepEqual(first.nodes.map(node => node.id), [...first.nodes].map(node => node.id).sort());
    assert.deepEqual(first.edges.map(edge => edge.id), [...first.edges].map(edge => edge.id).sort());
    const valid = first.edges.find(edge => edge.id === "valid");
    assert.ok(valid);
    assert.equal(valid.evidenceCount, 2);
    assert.equal(valid.sourceCount, 2);
    assert.ok(Math.abs(valid.confidence - .85) < 1e-12);
    assert.equal(valid.firstSeenAt, NOW);
    assert.equal(valid.lastSeenAt, NOW + 1);
  } finally { store.close(); }
});

test("insight projection marks truncation for edge and node limits without per-node reads", () => {
  const { store } = graphWithValidExpiredDeletedGenericAndSelfLoopEdges();
  try {
    store.getNodeById = () => { throw new Error("projection must not read nodes one-by-one"); };
    const edgeLimited = store.insightGraphProjection({ maxNodes: 20, maxEdges: 1, confidenceFloor: 0, asOf: NOW });
    assert.equal(edgeLimited.truncated, true);
    const nodeLimited = store.insightGraphProjection({ maxNodes: 2, maxEdges: 20, confidenceFloor: 0, asOf: NOW });
    assert.equal(nodeLimited.truncated, true);
    assert.equal(nodeLimited.nodes.length <= 2, true);
    assert.equal(nodeLimited.edges.every(edge => nodeLimited.nodes.some(node => node.id === edge.source) && nodeLimited.nodes.some(node => node.id === edge.target)), true);
  } finally { store.close(); }
});

test("insight projection excludes legacy-shaped rows while core constraints reject invalid writes", () => {
  const { store, ids } = graphWithValidExpiredDeletedGenericAndSelfLoopEdges();
  try {
    store.db.prepare("UPDATE kg_observations SET valid_to=? WHERE id=?").run("bogus", "obs:generic");
    assert.throws(() => addRawEdge(store, { id: "malformed-type", source: ids.A, target: ids.C, type: "not_a_relationship" }));
    addRawEdge(store, { id: "malformed-endpoint", source: ids.A, target: ids.B, type: "works_at" });
    assert.throws(() => addRawEdge(store, { id: "malformed-confidence", source: ids.B, target: ids.D, type: "supplies", confidence: 1.5 }));
    addRawEdge(store, { id: "malformed-created-at", source: ids.C, target: ids.E, type: "supplies" });
    store.db.prepare("UPDATE kg_observations SET created_at=? WHERE id=?").run("bogus", "obs:malformed-created-at");
    const result = store.insightGraphProjection({ maxNodes: 20, maxEdges: 20, confidenceFloor: 0, asOf: NOW });
    for (const id of ["generic", "malformed-type", "malformed-endpoint", "malformed-confidence", "malformed-created-at"]) {
      assert.equal(result.edges.some(edge => edge.id === id), false, `malformed edge ${id} leaked into projection`);
    }
  } finally { store.close(); }
});

function serviceFixture(overrides = {}) {
  const projection = {
    nodes: [{ id: "a", name: "A", type: "company" }], edges: [], truncated: false,
    graphRevision: 1, asOf: NOW
  };
  const snapshots = new Map();
  const store = {
    graphRevision: () => projection.graphRevision,
    insightGraphProjection: () => ({ ...projection }),
    readInsightSnapshot: key => snapshots.get(key),
    writeInsightSnapshot: (key, value) => snapshots.set(key, value)
  };
  const partition = { membership: { a: "c1" }, communities: [{ id: "c1", node_ids: ["a"], internal_weight: 0, total_weight: 0 }], modularity: 0 };
  const candidate = { id: "gap", kind: "knowledge_gap", score: .8, community_ids: ["c1"], entity_ids: ["a"], relationship_ids: [], reason: "isolated", signals: { density: 0 } };
  const deps = {
    store, config: { insights: { maxNodes: 10, maxEdges: 10, confidenceFloor: .6, maxResults: 20, maxExplanationCandidates: 5 } },
    now: () => NOW, communityDetector: () => partition,
    metrics: () => [{ id: "c1", entity_ids: ["a"], size: 1, internal_edge_count: 0, density: 0, average_confidence: 0, evidence_coverage: 0, source_concentration: 0, recent_growth: 0, bridge_score: 0 }],
    detectors: { knowledge_gap: () => [candidate], emerging_topic: () => [], cross_community_path: () => [] },
    explainer: { available: false, explain: async () => ({}) }, ...overrides
  };
  return { service: new GraphAnalyticsService(deps), store, projection, snapshots, candidate, deps };
}

test("unchanged graph reuses cache, refresh bypasses it, and revision invalidates it", async () => {
  const { service, projection } = serviceFixture();
  assert.equal((await service.analyze({ kind: "all" })).cache_hit, false);
  assert.equal((await service.analyze({ kind: "all" })).cache_hit, true);
  assert.equal((await service.analyze({ kind: "all", refresh: true })).cache_hit, false);
  projection.graphRevision++;
  const changed = await service.analyze({ kind: "all" });
  assert.equal(changed.cache_hit, false);
  assert.equal(changed.graph_revision, 2);
});

test("structurally valid cache entries with stale revision or algorithm are replaced", async () => {
  for (const stale of [
    { graphRevision: 0, algorithmVersion: "insights-v1:louvain-v1" },
    { graphRevision: 1, algorithmVersion: "old-algorithm" }
  ]) {
    let first = true;
    const { service, store } = serviceFixture();
    const originalWrite = store.writeInsightSnapshot;
    store.readInsightSnapshot = () => first ? (first = false, { ...stale, createdAt: NOW, truncated: false, communities: [], insights: [], warnings: [] }) : undefined;
    let writes = 0;
    store.writeInsightSnapshot = (key, value) => { writes++; originalWrite(key, value); };
    const result = await service.analyze();
    assert.equal(result.cache_hit, false);
    assert.equal(result.graph_revision, 1);
    assert.notEqual(result.algorithm_version, "old-algorithm");
    assert.equal(writes, 1);
  }
});

test("cached snapshot skips explanation when safe projection revision races ahead", async () => {
  let calls = 0;
  const { service, store } = serviceFixture({ explainer: { available: true, explain: async () => { calls++; return { gap: "unsafe" }; } } });
  await service.analyze();
  const originalProjection = store.insightGraphProjection;
  store.insightGraphProjection = (...args) => ({ ...originalProjection(...args), graphRevision: 2 });
  const result = await service.analyze({ explain: true });
  assert.equal(calls, 0);
  assert.equal(result.warnings.some(item => item.category === "explanation_stale"), true);
  assert.equal(result.insights[0].explanation, undefined);
});

test("public result limit is hard capped at twenty despite raw programmatic configuration", async () => {
  const candidates = Array.from({ length: 50 }, (_, index) => ({ id: `gap:${index}`, kind: "knowledge_gap", score: 1 - index / 100,
    community_ids: ["c1"], entity_ids: ["a"], relationship_ids: [], reason: "isolated", signals: {} }));
  const { service } = serviceFixture({
    config: { insights: { maxNodes: 10, maxEdges: 10, confidenceFloor: .6, maxResults: 1000, maxExplanationCandidates: 0 } },
    detectors: { knowledge_gap: () => candidates, emerging_topic: () => [], cross_community_path: () => [] }
  });
  assert.equal((await service.analyze({ limit: 1000 })).insights.length, 20);
});

test("filters and limits after caching without persisting explanations", async () => {
  let calls = 0;
  const { service, snapshots } = serviceFixture({ explainer: { available: true, explain: async ({ candidates }) => { calls++; return Object.fromEntries(candidates.map(x => [x.id, "safe"])); } } });
  const result = await service.analyze({ kind: "knowledge_gap", communityId: "c1", limit: 1, explain: true });
  assert.equal(result.insights[0].explanation, "safe");
  assert.equal(calls, 1);
  assert.equal(JSON.stringify([...snapshots.values()]).includes("explanation"), false);
  assert.equal((await service.analyze({ kind: "emerging_topic" })).insights.length, 0);
});

test("detector, cache, and explanation failures preserve deterministic results", async () => {
  const { service } = serviceFixture({
    store: { graphRevision: () => 1, insightGraphProjection: () => ({ nodes: [{ id: "a", name: "A", type: "company" }], edges: [], truncated: false, graphRevision: 1, asOf: NOW }), readInsightSnapshot: () => { throw new Error("read"); }, writeInsightSnapshot: () => { throw new Error("write"); } },
    detectors: { knowledge_gap: () => [{ id: "gap", kind: "knowledge_gap", score: .8, community_ids: ["c1"], entity_ids: ["a"], relationship_ids: [], reason: "isolated", signals: {} }], emerging_topic: () => { throw new Error("detector"); }, cross_community_path: () => [] },
    explainer: { available: true, explain: async () => { throw new Error("explain"); } }
  });
  const result = await service.analyze({ explain: "auto" });
  assert.equal(result.insights.some(x => x.kind === "knowledge_gap"), true);
  assert.equal(result.warnings.some(x => x.category === "detector_failed"), true);
  assert.equal(result.warnings.some(x => x.category === "cache_failed"), true);
  assert.equal(result.warnings.some(x => x.category === "explanation_failed"), true);
});

test("community failure is unavailable and never invokes explanation", async () => {
  let explained = false;
  const { service } = serviceFixture({ communityDetector: () => { throw new Error("louvain"); }, explainer: { available: true, explain: async () => { explained = true; return {}; } } });
  const result = await service.analyze({ explain: true });
  assert.equal(result.status, "unavailable");
  assert.equal(explained, false);
});

test("empty graphs are cached as deterministic snapshots", async () => {
  const projection = { nodes: [], edges: [], truncated: false, graphRevision: 0, asOf: NOW };
  const snapshots = new Map();
  const { service } = serviceFixture({ store: {
    graphRevision: () => 0, insightGraphProjection: () => projection,
    readInsightSnapshot: key => snapshots.get(key), writeInsightSnapshot: (key, value) => snapshots.set(key, value)
  } });
  const first = await service.analyze();
  const second = await service.analyze();
  assert.equal(first.status, "empty");
  assert.equal(first.cache_hit, false);
  assert.equal(second.status, "empty");
  assert.equal(second.cache_hit, true);
});

test("time bucket and relevant configuration participate in cache identity", async () => {
  let now = NOW;
  let reads = 0;
  const { service, store } = serviceFixture({ now: () => now });
  const originalRead = store.readInsightSnapshot;
  store.readInsightSnapshot = key => { reads++; return originalRead(key); };
  await service.analyze();
  assert.equal((await service.analyze()).cache_hit, true);
  now += 86_400_000;
  assert.equal((await service.analyze()).cache_hit, false);
  assert.equal(reads, 3);
});

test("truncation and community scope are applied to the result", async () => {
  const { service, projection } = serviceFixture();
  projection.truncated = true;
  const scoped = await service.analyze({ communityId: "missing" });
  assert.equal(scoped.truncated, true);
  assert.equal(scoped.communities.length, 0);
  assert.equal(scoped.insights.length, 0);
  assert.equal(scoped.warnings.some(item => item.category === "projection_truncated"), true);
});

test("community filtering sees candidates below the global public result limit on fresh and cache hit", async () => {
  const candidates = [
    { id: "global-a", kind: "knowledge_gap", score: .9, community_ids: ["c1"], entity_ids: ["a"], relationship_ids: [], reason: "isolated", signals: {} },
    { id: "scoped-b", kind: "knowledge_gap", score: .7, community_ids: ["c2"], entity_ids: ["b"], relationship_ids: [], reason: "isolated", signals: {} }
  ];
  const { service } = serviceFixture({
    config: { insights: { maxNodes: 10, maxEdges: 10, confidenceFloor: .6, maxResults: 1, maxExplanationCandidates: 0 } },
    metrics: () => [
      { id: "c1", entity_ids: ["a"], size: 1, internal_edge_count: 0, density: 0, average_confidence: 0, evidence_coverage: 0, source_concentration: 0, recent_growth: 0, bridge_score: 0 },
      { id: "c2", entity_ids: ["b"], size: 1, internal_edge_count: 0, density: 0, average_confidence: 0, evidence_coverage: 0, source_concentration: 0, recent_growth: 0, bridge_score: 0 }
    ],
    detectors: { knowledge_gap: (_projection, _partition, config) => candidates.slice(0, config.maxResults), emerging_topic: () => [], cross_community_path: () => [] }
  });
  const fresh = await service.analyze({ communityId: "c2" });
  const cached = await service.analyze({ communityId: "c2" });
  assert.deepEqual(fresh.insights.map(item => item.id), ["scoped-b"]);
  assert.deepEqual(cached.insights.map(item => item.id), ["scoped-b"]);
  assert.equal(cached.cache_hit, true);
});

test("relevant configuration and injected algorithm versions invalidate cache identity", async () => {
  const base = serviceFixture();
  await base.service.analyze();
  const changedConfig = new GraphAnalyticsService({ ...base.deps,
    config: { insights: { ...base.deps.config.insights, confidenceFloor: .7 } } });
  assert.equal((await changedConfig.analyze()).cache_hit, false);
  const changedService = new GraphAnalyticsService({ ...base.deps, algorithmVersion: "insights-test-v2" });
  assert.equal((await changedService.analyze()).cache_hit, false);
  const changedCommunity = new GraphAnalyticsService({ ...base.deps, communityAlgorithmVersion: "community-test-v2" });
  assert.equal((await changedCommunity.analyze()).cache_hit, false);
});

test("empty truncated projections cache their truncation warning", async () => {
  const projection = { nodes: [], edges: [], truncated: true, graphRevision: 0, asOf: NOW };
  const snapshots = new Map();
  const { service } = serviceFixture({ store: {
    graphRevision: () => 0, insightGraphProjection: () => projection,
    readInsightSnapshot: key => snapshots.get(key), writeInsightSnapshot: (key, value) => snapshots.set(key, value)
  } });
  for (const result of [await service.analyze(), await service.analyze()]) {
    assert.equal(result.truncated, true);
    assert.equal(result.warnings.some(item => item.category === "projection_truncated"), true);
  }
});

test("real cross-community detection retains candidates beyond the old three-per-node cache bound", async () => {
  const left = Array.from({ length: 8 }, (_, index) => `a${index}`);
  const right = Array.from({ length: 8 }, (_, index) => `b${index}`);
  const ids = [...left, ...right];
  const nodes = ids.map(id => ({ id, name: id.toUpperCase(), type: "company" }));
  const edges = left.flatMap(source => right.map(target => ({
    id: `${source}:${target}`, source, target, type: "supplies", weight: 1, confidence: .9,
    evidenceCount: 1, sourceCount: 1, firstSeenAt: NOW, lastSeenAt: NOW
  })));
  const projection = { nodes, edges, truncated: false, graphRevision: 1, asOf: NOW };
  const membership = Object.fromEntries(ids.map(id => [id, `c:${id}`]));
  const partition = { membership, communities: ids.map(id => ({ id: `c:${id}`, node_ids: [id], size: 1, internal_weight: 0, total_weight: 8 })), modularity: 0, passes: 1 };
  const config = { maxNodes: 10000, maxEdges: 50000, confidenceFloor: .6, maxPathLength: 4, maxResults: 20, maxExplanationCandidates: 0 };
  const all = detectCrossCommunityPaths(projection, partition, config, 660000);
  const old = detectCrossCommunityPaths(projection, partition, config, nodes.length * 3);
  assert.equal(all.length > nodes.length * 3, true);
  const omitted = all.find(item => !old.some(oldItem => oldItem.id === item.id));
  assert.ok(omitted);

  const snapshots = new Map();
  const store = {
    graphRevision: () => 1, insightGraphProjection: () => projection,
    readInsightSnapshot: key => snapshots.get(key), writeInsightSnapshot: (key, value) => snapshots.set(key, value)
  };
  const service = new GraphAnalyticsService({ store, config: { insights: config }, now: () => NOW,
    communityDetector: () => partition, metrics: () => ids.map(id => ({
      id: `c:${id}`, entity_ids: [id], size: 1, internal_edge_count: 0, density: 0,
      average_confidence: .9, evidence_coverage: 1, source_concentration: .125,
      recent_growth: 0, bridge_score: 0
    })), explainer: { available: false, explain: async () => ({}) } });
  const communityId = omitted.community_ids[0];
  for (const expectedHit of [false, true]) {
    const result = await service.analyze({ communityId });
    assert.equal(result.cache_hit, expectedHit);
    assert.equal(result.insights.some(item => item.id === omitted.id), true);
  }
});
