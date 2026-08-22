import assert from "node:assert/strict";
import test from "node:test";
import { detectCommunities } from "../dist/insights/community.js";

function projection(nodeIds, edgeSpecs = []) {
  return {
    nodes: nodeIds.map((id) => ({ id, name: id, type: "company" })),
    edges: edgeSpecs.map(([source, target, weight], index) => ({
      id: `edge:${index}`,
      source,
      target,
      type: "supplies",
      weight,
      confidence: weight,
      evidenceCount: 1,
      sourceCount: 1,
      firstSeenAt: 1,
      lastSeenAt: 1
    })),
    truncated: false,
    graphRevision: 1,
    asOf: 1
  };
}

function twoClusterProjection() {
  return projection(["a", "b", "c", "x", "y", "z"], [
    ["a", "b", 1], ["b", "c", 1], ["a", "c", 1],
    ["x", "y", 1], ["y", "z", 1], ["x", "z", 1],
    ["c", "x", .01]
  ]);
}

test("two dense groups joined by one weak bridge form stable communities", () => {
  const graph = twoClusterProjection();
  const first = detectCommunities(graph);
  const second = detectCommunities({ ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() });
  assert.deepEqual(first.membership, second.membership);
  assert.equal(first.membership.a, first.membership.b);
  assert.equal(first.membership.x, first.membership.y);
  assert.notEqual(first.membership.a, first.membership.x);
  assert.deepEqual(first.communities, [...first.communities].sort((a, b) => a.id.localeCompare(b.id)));
  assert.ok(first.communities.every((community) => community.node_ids.every((id, i, ids) => i === 0 || ids[i - 1].localeCompare(id) < 0)));
});

test("empty and one-node projections return valid deterministic partitions", () => {
  assert.deepEqual(detectCommunities(projection([])), {
    membership: {}, communities: [], modularity: 0, passes: 0
  });
  const result = detectCommunities(projection(["only"]));
  assert.equal(result.membership.only.startsWith("community:"), true);
  assert.equal(result.communities.length, 1);
  assert.deepEqual(result.communities[0].node_ids, ["only"]);
  assert.equal(result.modularity, 0);
});

test("community detection invokes a cooperative check without changing its default result", () => {
  let checks = 0;
  assert.throws(() => detectCommunities(twoClusterProjection(), { check: () => { if (++checks === 3) throw new Error("cancelled"); } }), /cancelled/);
  assert.ok(checks >= 3);
});

test("disconnected components stay separate while a connected graph can merge", () => {
  const disconnected = detectCommunities(projection(["a", "b", "x", "y"], [["a", "b", 1], ["x", "y", 1]]));
  assert.equal(disconnected.communities.length, 2);
  const connected = detectCommunities(projection(["a", "b", "c"], [["a", "b", 1], ["b", "c", 1], ["a", "c", 1]]));
  assert.equal(new Set(Object.values(connected.membership)).size, 1);
});

test("equal gains use the lowest stable community identifier", () => {
  const result = detectCommunities(projection(["a", "b", "c"], [["a", "b", 1], ["a", "c", 1]]));
  assert.equal(result.membership.b, result.membership.a);
  assert.equal(result.membership.c, result.membership.a);
});

test("equal-gain moves compare eventual stable community identifiers", () => {
  const result = detectCommunities(projection(["a", "a2", "b", "b2", "x"], [
    ["a", "a2", 1], ["b", "b2", 1], ["x", "a", 1], ["x", "b", 1]
  ]));
  // The digest for [b,b2,x] sorts before the digest for [a,a2,x], even though
  // the raw candidate label b2 sorts after a2.
  assert.equal(result.membership.x, result.membership.b);
  assert.equal(result.membership.x, "community:56bddcc3f5715a17");
  assert.notEqual(result.membership.x, result.membership.a);
});

test("weighted bridges favor dense internal edges and modularity is finite", () => {
  const result = detectCommunities(projection(["a", "b", "x", "y"], [
    ["a", "b", 1], ["x", "y", 1], ["b", "x", .05]
  ]));
  assert.notEqual(result.membership.a, result.membership.x);
  assert.equal(Number.isFinite(result.modularity), true);
  assert.ok(result.communities.every((community) => Number.isFinite(community.internal_weight) && Number.isFinite(community.total_weight)));
});

test("a later node retains its stronger current community over a weaker positive alternative", () => {
  const graph = projection(["a", "b", "c", "d"], [
    ["a", "b", 1], ["b", "c", .8], ["c", "d", 1]
  ]);
  const result = detectCommunities(graph, { maxPasses: 1 });
  assert.equal(result.membership.a, result.membership.b);
  assert.notEqual(result.membership.b, result.membership.c);
  assert.ok(result.modularity >= 0);
});

test("maxPasses bounds local moving", () => {
  const result = detectCommunities(twoClusterProjection(), { maxPasses: 1 });
  assert.ok(result.passes <= 1);
  const none = detectCommunities(twoClusterProjection(), { maxPasses: 0 });
  assert.equal(none.passes, 0);
  assert.equal(new Set(Object.values(none.membership)).size, 6);
  const hardCapped = detectCommunities(twoClusterProjection(), { maxPasses: 10000 });
  assert.ok(hardCapped.passes <= 20);
});
