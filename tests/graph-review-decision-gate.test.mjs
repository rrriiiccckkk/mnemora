import assert from "node:assert/strict";
import test from "node:test";
import { Mnemora } from "../dist/index.js";
import { GraphReviewDecisionGate } from "../dist/graph-review/decision-gate.js";

const entity = (name, type, quote) => ({ name, type, confidence: .95, evidence_span: quote });
const fallback = (source, target, quote) => [{ source, target, type: "related_to", confidence: .95, evidence_span: quote }];

function ingest(graph, source, sourceType, target, targetType, quote, evidenceSource = "fixture:decision-gate") {
  return graph.store.ingest([entity(source, sourceType, quote), entity(target, targetType, quote)], fallback(source, target, quote), evidenceSource, 0, undefined, "work");
}

function confirm(graph, kind, candidate, decision) {
  const preview = graph.kg_review(kind, "pending", false, 20, undefined, candidate.id, decision, "work");
  assert.equal(preview.eligible, true);
  assert.equal(graph.kg_review(kind, "pending", false, 20, undefined, candidate.id, decision, "work", undefined, undefined, preview.preview_hash, true).confirmed, true);
}

test("graph review decision gate aggregates scope-local durable outcomes without changing policy or review state", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    ingest(graph, "Build Tool", "product", "TypeScript", "technology", "Build Tool depends on TypeScript.");
    ingest(graph, "Acme", "company", "Widget", "product", "Acme develops Widget.");
    const stale = ingest(graph, "Legacy App", "product", "Runtime", "technology", "Legacy App uses Runtime.");
    for (const [name, runtime, source] of [["System One", "Runtime One", "fixture:vocabulary:a"], ["System Two", "Runtime Two", "fixture:vocabulary:b"], ["System Three", "Runtime Three", "fixture:vocabulary:a"]]) {
      ingest(graph, name, "product", runtime, "technology", `${name} is based on ${runtime}.`, source);
    }

    const refinement = graph.kg_review("related_edge_refinements", "pending", true, 20, undefined, undefined, undefined, "work").items[0];
    confirm(graph, "related_edge_refinements", refinement, "accepted");
    const vocabulary = graph.kg_review("semantic_vocabulary", "pending", true, 20, undefined, undefined, undefined, "work").items[0];
    confirm(graph, "semantic_vocabulary", vocabulary, "accepted");
    const semantic = graph.kg_review("related_edge_semantics", "pending", true, 20, undefined, undefined, undefined, "work").items;
    confirm(graph, "related_edge_semantics", semantic.find(item => item.source.name === "Acme"), "rejected");
    const staleCandidate = semantic.find(item => item.legacy_edge_id === stale.relations[0].edge.id);
    graph.store.forget(staleCandidate.source.id, false, false);
    graph.kg_review("worklist", "invalidated", false, 20, undefined, undefined, undefined, "work");
    graph.store.ingest([entity("Widget", "product", "Widget works at Fabric."), entity("Fabric", "technology", "Widget works at Fabric.")], [{ source: "Widget", target: "Fabric", type: "works_at", confidence: .9, evidence_span: "Widget works at Fabric." }], "fixture:schema-drift", 0, undefined, "work");
    const drift = graph.store.reviewSchemaDrift("work").items[0];
    const driftPreview = graph.kg_review("schema_drift", "pending", false, 20, undefined, drift.id, "rejected", "work");
    graph.kg_review("schema_drift", "pending", false, 20, undefined, drift.id, "rejected", "work", undefined, undefined, driftPreview.preview_hash, true);

    const gate = new GraphReviewDecisionGate(graph.store, { relatedToWarningRatio: .4, relatedToWarningMinimumEdges: 1 });
    const revision = graph.store.graphRevision(), report = gate.report("work");
    assert.deepEqual({ version: report.version, scope: report.scope, relatedTo: report.hygiene.related_to.edges, actions: report.actions }, {
      version: "graph-review-decision-gate-v1", scope: "work", relatedTo: 4,
      actions: { topology_policy: "not_changed", reasoning_delivery: "not_changed", automatic_review_decision: "not_performed" }
    });
    assert.deepEqual(report.reviews.related_edge_refinement, { total: 1, pending: 0, accepted: 1, rejected: 0, invalidated: 0, reviewed: 1, acceptance_rate: 1 });
    assert.deepEqual(report.reviews.related_edge_semantic, { total: 5, pending: 3, accepted: 0, rejected: 1, invalidated: 1, reviewed: 1, acceptance_rate: 0 });
    assert.deepEqual(report.reviews.schema_drift, { total: 1, pending: 0, accepted: 0, rejected: 1, invalidated: 0, reviewed: 1, acceptance_rate: 0 });
    assert.deepEqual(report.reviews.semantic_vocabulary, { total: 1, collecting: 0, pending: 0, accepted: 1, rejected: 0, reviewed: 1, acceptance_rate: 1 });
    assert.equal(graph.store.graphRevision(), revision, "decision-gate reads never change graph data");

    const isolated = gate.report("default");
    assert.deepEqual(isolated.reviews.related_edge_refinement, { total: 0, pending: 0, accepted: 0, rejected: 0, invalidated: 0, reviewed: 0, acceptance_rate: null });
    assert.deepEqual(isolated.reviews.schema_drift, { total: 0, pending: 0, accepted: 0, rejected: 0, invalidated: 0, reviewed: 0, acceptance_rate: null });
    assert.deepEqual(isolated.reviews.semantic_vocabulary, { total: 0, collecting: 0, pending: 0, accepted: 0, rejected: 0, reviewed: 0, acceptance_rate: null });
  } finally { graph.close(); }
});
