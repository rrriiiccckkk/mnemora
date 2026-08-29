import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GraphologyStore, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";
import { selectGraphInjection, selectInjectionCandidates } from "../dist/retrieval/injection-policy.js";

const candidate = (id, title, excerpt, score) => ({ contextRef: `mnemora://v1/scope/default/memory-document/${id}`, kind: "memory-document", scope: "default", title, excerpt, estimatedTokens: 8, bytes: excerpt.length, score, sourceIds: [], sourceRefs: [], authority: "source_linked", confidence: .8, freshness: Date.now(), selectionReason: "lexical_match" });

test("automatic injection requires a specific query anchor and diversifies bounded local context", () => {
  const generic = selectInjectionCandidates({
    query: "How does the memory system work?",
    candidates: [candidate("micron", "Micron Technology", "A semiconductor memory company", .95)],
    maxItems: 2,
    diversityLambda: .75
  });
  assert.deepEqual(generic, { candidates: [], suppressed: 1, reason: "no_anchor_terms" });

  const selected = selectInjectionCandidates({
    query: "Mnemora architecture",
    candidates: [
      candidate("first", "Mnemora architecture", "Mnemora architecture context compiler pipeline", .95),
      candidate("duplicate", "Mnemora architecture notes", "Mnemora architecture context compiler implementation", .9),
      candidate("different", "Mnemora configuration", "Mnemora configuration retrieval settings", .6)
    ],
    maxItems: 2,
    diversityLambda: .5
  });
  assert.deepEqual(selected.candidates.map(item => item.contextRef.split("/").at(-1)), ["first", "different"]);
  assert.equal(selected.suppressed, 0);
});

test("graph supplement requires an anchor match or a conservative semantic score", () => {
  const graph = { query: "How does the memory system work?", context: "irrelevant", nodes: [{ node: { name: "Micron Technology", description: "A semiconductor memory company", aliases: [] }, evidence: [{ quote: "Micron supplies memory chips" }], score: 1, score_components: { lexical: 1, semantic: 0, confidence: .9, freshness: 1 } }], edges: [], semantic_labels: [], sources: [], truncated: false };
  assert.deepEqual(selectGraphInjection({ query: graph.query, context: graph }), { allowed: false, candidates: 1, reason: "no_anchor_terms" });
  assert.deepEqual(selectGraphInjection({ query: "Mnemora architecture", context: { ...graph, nodes: [{ ...graph.nodes[0], node: { ...graph.nodes[0].node, name: "Mnemora architecture" } }] } }), { allowed: true, candidates: 1 });
  assert.deepEqual(selectGraphInjection({ query: "Semantic retrieval", context: { ...graph, nodes: [{ ...graph.nodes[0], score_components: { ...graph.nodes[0].score_components, semantic: .72 } }] } }), { allowed: true, candidates: 1 });
});

test("v71 migration adds only the bounded redacted unified-recall telemetry table", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-unified-recall-shadow-"));
  const path = join(directory, "memory.db");
  try {
    const initial = new GraphologyStore(path);
    initial.ingest([{ name: "Retained entity", type: "concept", confidence: .9, evidence_span: "The retained entity remains evidence-backed." }], [], "manual:fixture");
    initial.db.exec("DROP TABLE mnemora_unified_recall_shadow_runs; PRAGMA user_version=70");
    initial.close();

    const migrated = new GraphologyStore(path);
    try {
      assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
      assert.equal(migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mnemora_unified_recall_shadow_runs'").get().name, "mnemora_unified_recall_shadow_runs");
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS value FROM kg_nodes WHERE name='Retained entity'").get().value, 1);
    } finally { migrated.close(); }
  } finally { removeTemporaryDirectory(directory); }
});

function removeTemporaryDirectory(directory) {
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  catch (error) {
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
  }
}
