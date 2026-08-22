import test from "node:test";
import assert from "node:assert/strict";
import { SourceTrustService } from "../dist/operations/source-trust.js";
import { GraphologyStore } from "../dist/index.js";

function fixture(now = 1_000) {
  const state = { graph: 7, config: 3, weight: 1, audits: [], invalidations: 0, confidence: .8 };
  const store = {
    graphRevision: () => state.graph, sourceTrustRevision: () => state.config,
    previewSourceTrust: (source, weight, limit) => ({ affected: { nodes: 1, edges: 1, observations: 2 }, rank_deltas: [{ id: "company:alpha", delta: (weight - state.weight) * .1 }].slice(0, limit), truncated: false }),
    confirmSourceTrust(input) {
      if (input.graph_revision !== state.graph || input.config_revision !== state.config) throw new Error("stale_preview");
      state.weight = input.weight; state.config += 1; state.invalidations += 1; state.audits.push({ id: input.audit_id, source_hash: input.source_hash });
      return { graph_revision: state.graph, config_revision: state.config, affected: { nodes: 1, edges: 1, observations: 2 } };
    }
  };
  return { state, service: new SourceTrustService({ store, now: () => now, randomBytes: () => Buffer.alloc(32, 7) }) };
}

test("source trust preview normalizes identity, bounds weight, and leaves fact confidence unchanged", () => {
  const { state, service } = fixture();
  const before = state.confidence;
  const preview = service.preview({ operation: "source_trust", phase: "preview", graph_revision: 7, config_revision: 3, payload: { source: " HTTPS://Example.COM:443/report ", weight: 1.5 } });
  assert.equal(preview.operation, "source_trust"); assert.equal(preview.config_revision, 3);
  assert.equal(preview.rank_deltas.length, 1); assert.equal(state.confidence, before); assert.equal(state.weight, 1);
  assert.match(preview.payload_hash, /^[a-f0-9]{64}$/); assert.ok(preview.preview_token.length >= 32);
});

test("confirm is single-use, revision-bound, expiring, audited without raw source, and invalidates caches once", () => {
  const { state, service } = fixture();
  const payload = { source: "https://user:secret@example.com/report", weight: .5 };
  const preview = service.preview({ operation: "source_trust", phase: "preview", graph_revision: 7, config_revision: 3, payload });
  const request = { operation: "source_trust", phase: "confirm", preview_token: preview.preview_token, payload_hash: preview.payload_hash, graph_revision: 7, config_revision: 3, payload };
  const result = service.confirm(request);
  assert.equal(result.confirmed, true); assert.equal(state.invalidations, 1); assert.equal(state.confidence, .8);
  assert.equal(JSON.stringify(state.audits).includes("secret"), false);
  assert.throws(() => service.confirm(request), /invalid_preview/);
});

test("GraphologyStore persists trust atomically, bumps only config revision, and clears insight cache", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const now = 1_700_000_000_000;
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES('company:a','company','A','','[]',0,?,?)").run(now, now);
    store.db.prepare("INSERT INTO kg_observations(id,source_entity_id,payload,source,quote,confidence,created_at) VALUES('obs:a','company:a','{}','report:public','',.8,?)").run(now);
    store.db.prepare("INSERT INTO kg_insight_snapshots(cache_key,graph_revision,algorithm_version,snapshot,created_at) VALUES('x',0,'v','{}',?)").run(now);
    const graphBefore = store.graphRevision();
    const service = new SourceTrustService({ store, now: () => now, randomBytes: () => Buffer.alloc(32, 8) });
    const payload = { source: "report:public", weight: 1.25 };
    const preview = service.preview({ operation: "source_trust", phase: "preview", graph_revision: graphBefore, config_revision: store.sourceTrustRevision(), payload });
    assert.deepEqual(preview.affected, { nodes: 1, edges: 0, observations: 1 });
    service.confirm({ operation: "source_trust", phase: "confirm", preview_token: preview.preview_token, payload_hash: preview.payload_hash, graph_revision: graphBefore, config_revision: preview.config_revision, payload });
    assert.equal(store.graphRevision(), graphBefore); assert.equal(store.sourceTrustRevision(), preview.config_revision + 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM kg_insight_snapshots").get().n, 0);
    const audit = store.db.prepare("SELECT source_hash FROM kg_source_trust_audits").get();
    assert.match(audit.source_hash, /^[a-f0-9]{64}$/); assert.equal(JSON.stringify(audit).includes("report:public"), false);
  } finally { store.close(); }
});

test("trust changes only derived insight confidence, never stored fact confidence", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const now = 1_700_000_000_000;
    const node = store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
    node.run("company:a", "company", "A", "", "[]", 0, now, now); node.run("company:b", "product", "B", "", "[]", 0, now, now);
    store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,created_at,updated_at) VALUES('edge:ab','company:a','company:b','uses','{}',0,?,?)").run(now, now);
    store.db.prepare("INSERT INTO kg_observations(id,edge_id,payload,source,quote,confidence,created_at) VALUES('obs:ab','edge:ab','{}','report:public','',.8,?)").run(now);
    const before = store.insightGraphProjection({ maxNodes: 10, maxEdges: 10, confidenceFloor: 0, asOf: now }).edges[0].confidence;
    store.confirmSourceTrust({ source: "report:public", source_hash: "a".repeat(64), weight: .5, graph_revision: store.graphRevision(), config_revision: store.sourceTrustRevision(), audit_id: "audit:test" });
    const after = store.insightGraphProjection({ maxNodes: 10, maxEdges: 10, confidenceFloor: 0, asOf: now }).edges[0].confidence;
    assert.equal(before, .8); assert.equal(after, .4);
    assert.equal(store.db.prepare("SELECT confidence FROM kg_observations WHERE id='obs:ab'").get().confidence, .8);
  } finally { store.close(); }
});

test("high source trust cannot promote evidence below the raw confidence floor", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const now = 1_700_000_000_000, node = store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
    node.run("company:a", "company", "A", "", "[]", 0, now, now); node.run("product:b", "product", "B", "", "[]", 0, now, now);
    store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,created_at,updated_at) VALUES('edge:ab','company:a','product:b','uses','{}',0,?,?)").run(now, now);
    store.db.prepare("INSERT INTO kg_observations(id,edge_id,payload,source,quote,confidence,created_at) VALUES('obs:ab','edge:ab','{}','trusted:weak','',.4,?)").run(now);
    store.confirmSourceTrust({ source: "trusted:weak", source_hash: "b".repeat(64), weight: 2, graph_revision: store.graphRevision(), config_revision: store.sourceTrustRevision(), audit_id: "audit:weak" });
    const projection = store.insightGraphProjection({ maxNodes: 10, maxEdges: 10, confidenceFloor: .6, asOf: now });
    assert.equal(projection.edges.length, 0);
  } finally { store.close(); }
});
