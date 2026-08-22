import assert from "node:assert/strict";
import test from "node:test";
import { GraphologyStore } from "../dist/store.js";

const entity = (name, aliases = []) => ({ name, type: "company", aliases, confidence: .95, evidence_span: name });

test("merge is preview-first and creates an audited redirect only after confirmation", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const ingested = store.ingest([entity("SK Hynix", ["海力士"]), entity("SK海力士", ["Hynix"])], [], "fixture:merge");
    const canonicalId = ingested.entities.find(item => item.node.name === "SK Hynix").node.id;
    const duplicateId = ingested.entities.find(item => item.node.name === "SK海力士").node.id;
    const now = Date.now();
    store.db.prepare(`INSERT INTO kg_duplicate_candidates
      (id,pair_key,entity_a,entity_b,signals,reasons,score,fingerprint_a,fingerprint_b,status,discovered_at,updated_at,reviewed_at)
      VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,NULL)`)
      .run("candidate:merge", [canonicalId, duplicateId].sort().join("\0"), canonicalId, duplicateId, "[]", "[]", .9, "a", "b", now, now);
    assert.equal(store.reviewCandidates({ status: "pending" }).items.length, 1);
    store.putEmbedding(canonicalId, { provider: "ollama", model: "tiny", dimensions: 2 }, "node-v1", [1, 0]);

    const preview = store.merge(canonicalId, duplicateId, false);
    assert.equal(preview.confirmed, false);
    assert.equal(store.getNodeById(duplicateId).deleted_at, null);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM kg_entity_redirects").get().count, 0);

    const merged = store.merge(canonicalId, duplicateId, true, preview.preview_hash);
    assert.equal(merged.confirmed, true);
    assert.equal(store.getNodeById(duplicateId, true).deleted_at != null, true);
    assert.equal(store.resolveEntity(duplicateId).id, canonicalId);
    assert.equal(store.getNodeById(canonicalId).aliases.includes("SK海力士"), true);
    assert.equal(store.getEmbedding(canonicalId), undefined);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM kg_merge_audits").get().count, 1);
    assert.equal(store.reviewCandidates({ status: "pending" }).items.length, 0);
    assert.equal(store.reviewCandidates({ status: "merged" }).items.length, 1);
  } finally {
    store.close();
  }
});

test("merge rewires edges, deduplicates evidence, and removes resulting self-loops", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const ingested = store.ingest(
      [entity("Acme Holdings"), entity("Acme Group"), { name: "CUDA", type: "technology", confidence: .95, evidence_span: "CUDA" }],
      [
        { source: "Acme Holdings", target: "CUDA", type: "uses", confidence: .9, evidence_span: "Holdings uses CUDA" },
        { source: "Acme Group", target: "CUDA", type: "uses", confidence: .8, evidence_span: "Group uses CUDA" },
        { source: "Acme Group", target: "Acme Holdings", type: "competes_with", confidence: .85, evidence_span: "same company duplicate" }
      ],
      "fixture:edges"
    );
    const canonicalId = ingested.entities.find(item => item.node.name === "Acme Holdings").node.id;
    const duplicateId = ingested.entities.find(item => item.node.name === "Acme Group").node.id;
    const preview = store.merge(canonicalId, duplicateId, false);
    const merged = store.merge(canonicalId, duplicateId, true, preview.preview_hash);

    assert.deepEqual(
      { rewired: merged.rewired_edges, deduplicated: merged.deduplicated_edges, selfLoops: merged.removed_self_loops },
      { rewired: 2, deduplicated: 1, selfLoops: 1 }
    );
    const related = store.related(canonicalId, 1, ["uses"]);
    assert.deepEqual(related.edges, []);
    assert.deepEqual(related.semantic_labels.map(item => item.predicate), ["uses"]);
    assert.equal(related.semantic_labels[0].evidence.length, 2);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM kg_edges WHERE deleted_at IS NULL AND source_id=target_id").get().count, 0);
  } finally {
    store.close();
  }
});

test("merge rejects a stale preview without writing", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const ingested = store.ingest([entity("Acme Canonical"), entity("Acme Duplicate")], [], "fixture:stale");
    const [canonicalId, duplicateId] = ingested.entities.map(item => item.node.id);
    const preview = store.merge(canonicalId, duplicateId, false);
    store.db.prepare("UPDATE kg_nodes SET description=?,updated_at=? WHERE id=?").run("new evidence", Date.now() + 1, duplicateId);

    assert.throws(() => store.merge(canonicalId, duplicateId, true, preview.preview_hash), /stale merge preview/i);
    assert.equal(store.getNodeById(duplicateId).deleted_at, null);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM kg_merge_audits").get().count, 0);
  } finally {
    store.close();
  }
});

test("merge rolls back every write when observation movement fails", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const ingested = store.ingest([entity("Rollback Canonical"), entity("Rollback Duplicate")], [], "fixture:rollback");
    const [canonicalId, duplicateId] = ingested.entities.map(item => item.node.id);
    const preview = store.merge(canonicalId, duplicateId, false);
    store.db.exec(`CREATE TRIGGER fail_merge BEFORE UPDATE OF source_entity_id ON kg_observations
      WHEN OLD.source_entity_id='${duplicateId}' BEGIN SELECT RAISE(ABORT, 'injected merge failure'); END`);

    assert.throws(() => store.merge(canonicalId, duplicateId, true, preview.preview_hash), /injected merge failure/i);
    assert.equal(store.getNodeById(duplicateId).deleted_at, null);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM kg_merge_audits").get().count, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM kg_entity_redirects").get().count, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM kg_observations WHERE source_entity_id=?").get(duplicateId).count, 1);
  } finally {
    store.close();
  }
});

test("merge undo is preview-first and restores the pre-merge graph atomically", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const ingested = store.ingest([entity("Undo Canonical", ["UC"]), entity("Undo Duplicate", ["UD"])], [], "fixture:undo");
    const [canonicalId, duplicateId] = ingested.entities.map(item => item.node.id);
    const now = Date.now();
    store.db.prepare(`INSERT INTO kg_duplicate_candidates
      (id,pair_key,entity_a,entity_b,signals,reasons,score,fingerprint_a,fingerprint_b,status,discovered_at,updated_at,reviewed_at)
      VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,NULL)`)
      .run("candidate:undo", [canonicalId, duplicateId].sort().join("\0"), canonicalId, duplicateId, "[]", "[]", .9, "a", "b", now, now);
    const mergePreview = store.merge(canonicalId, duplicateId, false);
    const merged = store.merge(canonicalId, duplicateId, true, mergePreview.preview_hash);

    const preview = store.undoMerge(merged.audit_id, false);
    assert.equal(preview.confirmed, false);
    assert.equal(store.resolveEntity(duplicateId).id, canonicalId);

    const undone = store.undoMerge(merged.audit_id, true, preview.preview_hash);
    assert.equal(undone.confirmed, true);
    assert.equal(store.getNodeById(duplicateId).name, "Undo Duplicate");
    assert.deepEqual(store.getNodeById(canonicalId).aliases, ["UC"]);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM kg_entity_redirects").get().count, 0);
    assert.equal(store.db.prepare("SELECT status FROM kg_merge_audits WHERE id=?").get(merged.audit_id).status, "undone");
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM kg_observations WHERE source_entity_id=?").get(duplicateId).count, 1);
    assert.equal(store.reviewCandidates({ status: "pending" }).items.length, 1);
  } finally {
    store.close();
  }
});

test("merge undo reports post-merge evidence conflicts and performs no partial restore", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const ingested = store.ingest([entity("Conflict Canonical"), entity("Conflict Duplicate")], [], "fixture:conflict");
    const [canonicalId, duplicateId] = ingested.entities.map(item => item.node.id);
    const mergePreview = store.merge(canonicalId, duplicateId, false);
    const merged = store.merge(canonicalId, duplicateId, true, mergePreview.preview_hash);
    store.ingest([entity("Conflict Canonical")], [], "fixture:new-evidence");

    const undoPreview = store.undoMerge(merged.audit_id, false);
    assert.deepEqual(undoPreview.conflicts.map(item => item.reason), ["new_node_observation"]);
    assert.throws(() => store.undoMerge(merged.audit_id, true, undoPreview.preview_hash), /conflicts/i);
    assert.equal(store.resolveEntity(duplicateId).id, canonicalId);
    assert.equal(store.db.prepare("SELECT status FROM kg_merge_audits WHERE id=?").get(merged.audit_id).status, "merged");
  } finally {
    store.close();
  }
});

test("merge undo restores deduplicated edges and their original observations", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const ingested = store.ingest(
      [entity("Restore Canonical"), entity("Restore Duplicate"), { name: "CUDA", type: "technology", confidence: .95, evidence_span: "CUDA" }],
      [
        { source: "Restore Canonical", target: "CUDA", type: "uses", confidence: .9, evidence_span: "canonical evidence" },
        { source: "Restore Duplicate", target: "CUDA", type: "uses", confidence: .8, evidence_span: "duplicate evidence" },
        { source: "Restore Duplicate", target: "Restore Canonical", type: "competes_with", confidence: .85, evidence_span: "self-loop evidence" }
      ],
      "fixture:restore-edges"
    );
    const [canonicalId, duplicateId] = ingested.entities.slice(0, 2).map(item => item.node.id);
    const mergePreview = store.merge(canonicalId, duplicateId, false);
    const merged = store.merge(canonicalId, duplicateId, true, mergePreview.preview_hash);
    const undoPreview = store.undoMerge(merged.audit_id, false);
    store.undoMerge(merged.audit_id, true, undoPreview.preview_hash);

    assert.equal(store.stats().edges.total, 3);
    assert.equal(store.related(canonicalId, 1, ["uses"]).semantic_labels[0].evidence[0].quote, "canonical evidence");
    assert.equal(store.related(duplicateId, 1, ["uses"]).semantic_labels[0].evidence[0].quote, "duplicate evidence");
    assert.equal(store.related(duplicateId, 1, ["competes_with"]).semantic_labels.some(item => item.predicate === "competes_with"), true);
  } finally {
    store.close();
  }
});

test("merge undo refuses to delete relationships added after the merge", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const ingested = store.ingest([
      entity("Edge Conflict Canonical"), entity("Edge Conflict Duplicate"),
      { name: "CUDA", type: "technology", confidence: .95, evidence_span: "CUDA" }
    ], [], "fixture:edge-conflict");
    const [canonicalId, duplicateId] = ingested.entities.slice(0, 2).map(item => item.node.id);
    const mergePreview = store.merge(canonicalId, duplicateId, false);
    const merged = store.merge(canonicalId, duplicateId, true, mergePreview.preview_hash);
    store.ingest([], [{ source: canonicalId, target: "CUDA", type: "uses", confidence: .95, evidence_span: "new relationship" }], "fixture:new-edge");

    const undoPreview = store.undoMerge(merged.audit_id, false);
    assert.equal(undoPreview.conflicts.some(item => item.reason === "new_edge" || item.reason === "new_edge_observation"), true);
    assert.throws(() => store.undoMerge(merged.audit_id, true, undoPreview.preview_hash), /conflicts/i);
    assert.equal(store.related(canonicalId, 1, ["uses"]).semantic_labels.some(item => item.evidence.some(evidence => evidence.quote === "new relationship")), true);
    assert.equal(store.resolveEntity(duplicateId).id, canonicalId);
  } finally {
    store.close();
  }
});
