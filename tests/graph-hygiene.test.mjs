import assert from "node:assert/strict";
import test from "node:test";
import { GraphHygieneService } from "../dist/hygiene/service.js";
import { GraphologyStore } from "../dist/store.js";
import { Mnemora } from "../dist/tools.js";

const policy = { intervalHours: 168, maxDuplicateScanNodes: 10, relatedToWarningRatio: .4, relatedToWarningMinimumEdges: 1 };

function node(store, id, name) {
  const now = 1_700_000_000_000;
  store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,0,NULL,?,?)")
    .run(id, "company", name, "", "[]", now, now);
}

function edge(store, id, source, target, scope, type = "related_to") {
  const now = 1_700_000_000_000;
  store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,0,NULL,?,?)")
    .run(id, source, target, type, "{}", now, now);
  store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,scope,quote,confidence,valid_from,valid_to,temporal_confidence,created_at) VALUES(?,?,NULL,?,?,?,?,?,NULL,NULL,NULL,?)")
    .run(`observation:${id}`, id, "{}", "fixture:hygiene", scope, "fixture", .9, now);
}

test("scheduled hygiene is bounded, resumable, and never merges duplicate entities", () => {
  let now = Date.now();
  const store = new GraphologyStore(":memory:"), hygiene = new GraphHygieneService(store, () => now);
  try {
    node(store, "company:sk-hynix", "SK Hynix");
    node(store, "company:sk-hailishi", "SK Hynix");
    const first = hygiene.run({ scope: "research:chips", policy });
    assert.equal(first.status, "completed");
    assert.equal(first.duplicate_scan?.created, 1);
    assert.equal(store.reviewCandidates({ status: "pending" }).items.length, 1);
    assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS count FROM kg_merge_audits").get().count), 0);
    assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS count FROM kg_nodes WHERE deleted_at IS NULL").get().count), 2);

    now += 60_000;
    assert.equal(hygiene.run({ scope: "research:chips", policy }).status, "not_due");
  } finally { store.close(); }
});

test("hygiene reports scope-local related_to overuse and self-links without leaking another scope", () => {
  const store = new GraphologyStore(":memory:"), hygiene = new GraphHygieneService(store, () => 1_700_000_000_000);
  try {
    node(store, "company:a", "Alpha");
    node(store, "company:b", "Beta");
    node(store, "company:c", "Gamma");
    edge(store, "edge:default:related", "company:a", "company:b", "default");
    edge(store, "edge:default:self", "company:a", "company:a", "default");
    edge(store, "edge:private:structural", "company:b", "company:c", "private", "uses");

    const report = hygiene.report("default", policy);
    assert.deepEqual(report.related_to, { edges: 2, ratio: 1, warning: true });
    assert.equal(report.suspicious_self_links, 1);
    assert.equal(report.scoped_edges, 2);
    assert.deepEqual(report.recommendations, ["related_to_overrepresented", "self_links_detected"]);

    const privateReport = hygiene.report("private", policy);
    assert.deepEqual(privateReport.related_to, { edges: 0, ratio: 0, warning: false });
    assert.equal(privateReport.suspicious_self_links, 0);
    assert.equal(privateReport.scoped_edges, 1);
  } finally { store.close(); }
});

test("hygiene evaluates related_to topology without changing the live PPR projection", () => {
  const store = new GraphologyStore(":memory:"), hygiene = new GraphHygieneService(store, () => 1_700_000_000_000);
  try {
    node(store, "company:a", "Alpha"); node(store, "company:b", "Beta"); node(store, "company:c", "Gamma"); node(store, "company:d", "Delta");
    edge(store, "edge:a-b", "company:a", "company:b", "work", "related_to");
    edge(store, "edge:b-c", "company:b", "company:c", "work", "depends_on");
    edge(store, "edge:c-d", "company:c", "company:d", "work", "uses");
    const before = store.qualityGraphSnapshot(["company:a"], { maxNodes: 10, maxArcs: 20 }, 1_700_000_000_000);
    const report = hygiene.report("work", policy).related_to_topology;
    const after = store.qualityGraphSnapshot(["company:a"], { maxNodes: 10, maxArcs: 20 }, 1_700_000_000_000);
    assert.equal(report.status, "ok");
    assert.equal(report.node_count, 4);
    assert.equal(report.structural_edge_count, 2);
    assert.equal(report.related_to_edges, 1);
    assert.equal(report.policies.baseline.weak_components, 2);
    assert.equal(report.policies.baseline.isolated_nodes, 1);
    assert.equal(report.policies.excluded.weak_components, 3);
    assert.equal(report.policies.excluded.isolated_nodes, 2);
    assert.equal(report.top_k_comparison.excludes_seed, true);
    assert.deepEqual(after, before);
  } finally { store.close(); }
});

test("manual hygiene review honors the caller's bounded scan limit", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:", quality: { hygiene: { maxDuplicateScanNodes: 10 } } } });
  try {
    node(graph.store, "company:a", "Alpha");
    node(graph.store, "company:b", "Alpha");
    node(graph.store, "company:c", "Beta");
    const result = graph.kg_review("hygiene", "pending", true, 1);
    assert.equal(result.duplicate_scan.processed, 1);
    assert.equal(result.status, "continued");
  } finally { graph.close(); }
});
