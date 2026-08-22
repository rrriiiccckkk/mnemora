import assert from "node:assert/strict";
import test from "node:test";
import { Mnemora, GraphologyStore, InspectorService } from "../dist/index.js";
import { normalizeSlug } from "../dist/slug.js";
import { MaintenanceService } from "../dist/operations/maintenance.js";

const NOW = 1_700_000_000_000;

test("Phase 0: generated mixed-script identities never overwrite an occupied canonical id", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const first = "\u817e\u8baf\u4e91 API", second = "\u963f\u91cc\u4e91 API";
    const id = normalizeSlug(first, "company");
    assert.notEqual(id, normalizeSlug(second, "company"));
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, "company", "Occupied", "", "[]", 0, NOW, NOW);
    store.ingest([{ name: first, type: "company", confidence: 1, evidence_span: first }], [], "phase0:identity");
    assert.equal(store.db.prepare("SELECT name FROM kg_nodes WHERE id=?").get(id).name, "Occupied");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM kg_nodes").get().count, 2);
  } finally { store.close(); }
});

test("Phase 0: a truncated conflict scan does not invalidate an unscanned candidate", () => {
  const store = new GraphologyStore(":memory:");
  try {
    store.ingest([
      { name: "Zed", type: "person", confidence: 1, evidence_span: "Zed" },
      { name: "Acme", type: "company", confidence: 1, evidence_span: "Acme" },
      { name: "Beta", type: "company", confidence: 1, evidence_span: "Beta" }
    ], [
      { source: "Zed", target: "Acme", type: "works_at", confidence: .9, evidence_span: "one" },
      { source: "Zed", target: "Beta", type: "works_at", confidence: .8, evidence_span: "two" }
    ], "phase0:conflict");
    store.scanConflictCandidates(["works_at"]);
    const candidate = store.reviewConflictCandidates({ status: "pending" }).items[0];
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("person:bulk", "person", "Bulk", "", "[]", 0, NOW, NOW);
    store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("edge:bulk", "person:bulk", "company:acme", "works_at", "{}", 0, NOW, NOW);
    const observation = store.db.prepare("INSERT INTO kg_observations(id,edge_id,payload,source,quote,confidence,created_at) VALUES(?,?,?,?,?,?,?)");
    store.db.exec("BEGIN");
    for (let index = 0; index < 10_001; index++) observation.run(`obs:bulk:${index}`, "edge:bulk", "{}", "phase0:bulk", "", .7, NOW);
    store.db.exec("COMMIT");
    const result = store.scanConflictCandidates(["works_at"]);
    assert.equal(result.truncated, true);
    assert.equal(result.invalidated, 0);
    assert.notEqual(store.db.prepare("SELECT status FROM kg_conflict_candidates WHERE id=?").get(candidate.id).status, "invalid");
  } finally { store.close(); }
});

test("Phase 0: weight confirmation changes only the previewed bounded rows", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const node = store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
    node.run("company:a", "company", "A", "", "[]", 0, NOW, NOW);
    node.run("company:b", "company", "B", "", "[]", 0, NOW, NOW);
    const observation = store.db.prepare("INSERT INTO kg_observations(id,source_entity_id,payload,source,quote,confidence,created_at) VALUES(?,?,?,?,?,?,?)");
    observation.run("obs:a", "company:a", "{}", "phase0", "", 1, NOW);
    observation.run("obs:b", "company:b", "{}", "phase0", "", 1, NOW);
    const service = new MaintenanceService({ store, now: () => NOW + 1, randomBytes: () => Buffer.alloc(32, 1) });
    const revision = store.graphRevision();
    const preview = service.preview({ operation: "weight_recompute", phase: "preview", graph_revision: revision, payload: { limit: 1 } });
    assert.equal(preview.truncated, true);
    service.confirm({ operation: "weight_recompute", phase: "confirm", preview_token: preview.preview_token, payload_hash: preview.payload_hash, graph_revision: revision, payload: { limit: 1 } });
    assert.deepEqual(
      store.db.prepare("SELECT id,updated_at FROM kg_nodes ORDER BY id").all().map(({ id, updated_at }) => ({ id, updated_at })),
      [{ id: "company:a", updated_at: NOW + 1 }, { id: "company:b", updated_at: NOW }]
    );
  } finally { store.close(); }
});

test("Phase 0: Inspector redacts unsafe display values without dropping the entity", () => {
  const unsafe = "https://user:password@example.test/private?token=secret";
  const service = new InspectorService({ store: {
    graphRevision: () => 1,
    inspectorEntityProjection: () => ({ graph_revision: 1, entity: { id: "company:alpha", name: unsafe, type: "company", aliases: ["C:\\private\\alias"] }, evidence: [], relationships: [], timeline: [], ranking_factors: {} })
  }, now: () => NOW });
  const result = service.entity({ kind: "entity", id: "company:alpha" });
  assert.equal(result.name, "https://example.test/private");
  assert.deepEqual(result.aliases, ["[redacted]"]);
});

test("Phase 0: manual ingestion shares bounded, abortable extraction", async () => {
  let received = "", aborted = false;
  const graph = new Mnemora({
    config: { dbPath: ":memory:", extraction: { maxInputChars: 1000, timeoutMs: 1000 } },
    extractor: { extract(text, _source, options) {
      received = text;
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true }));
    } }
  });
  try {
    graph.config.extraction.timeoutMs = 20;
    const result = await graph.ingestItem({ text: "x".repeat(2000), source: "phase0:manual" });
    assert.equal(received.length, 1000);
    assert.equal(aborted, true);
    assert.deepEqual(result.error, { category: "extraction_failed", summary: "extraction failed" });
  } finally { graph.close(); }
});

test("Phase 0: public graph query propagates a caller abort through its execution budget", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  const controller = new AbortController(); controller.abort();
  try {
    await assert.rejects(graph.kg_query({ plan: { version: 1, steps: [{ op: "lookup", query: "Alpha" }], order_by: "name", limit: 1 }, signal: controller.signal }), /^Error: aborted$/);
  } finally { graph.close(); }
});
