import assert from "node:assert/strict";
import test from "node:test";
import { detectConflictPairs } from "../dist/conflicts.js";
import { GraphologyStore } from "../dist/store.js";
import { Mnemora } from "../dist/tools.js";
import { relationshipDefinitions } from "../dist/relationships.js";

const a = { edge_id: "edge:a", observation_id: "obs:a", source_id: "person:alice", target_id: "company:a", confidence: .9, source_count: 2, valid_from: 10, valid_to: 20, scope: "default" };
const b = { edge_id: "edge:b", observation_id: "obs:b", source_id: "person:alice", target_id: "company:b", confidence: .8, source_count: 1, valid_from: 20, valid_to: 30, scope: "default" };

test("conflicts require explicit single-valued eligibility and overlapping alternatives", () => {
  assert.equal(detectConflictPairs({ relationshipType: "works_at", singleValued: true, facts: [b, a] }).length, 1);
  assert.deepEqual(detectConflictPairs({ relationshipType: "works_at", singleValued: false, facts: [a, b] }), []);
  assert.deepEqual(detectConflictPairs({ relationshipType: "works_at", singleValued: true, facts: [a, { ...b, source_id: "person:bob" }] }), []);
  assert.deepEqual(detectConflictPairs({ relationshipType: "works_at", singleValued: true, facts: [a, { ...b, target_id: a.target_id }] }), []);
  assert.deepEqual(detectConflictPairs({ relationshipType: "works_at", singleValued: true, facts: [a, { ...b, valid_from: 21 }] }), []);
});

test("conflict pairs are canonical, bounded metadata without evidence text", () => {
  const [pair] = detectConflictPairs({ relationshipType: "works_at", singleValued: true, facts: [b, a] });
  assert.equal(pair.pair_key, "default|obs:a|obs:b");
  assert.equal(pair.category, "overlapping_single_valued_facts");
  assert.deepEqual([pair.overlap_from, pair.overlap_to], [20, 20]);
  assert.deepEqual([pair.confidence_a, pair.confidence_b, pair.source_count_a, pair.source_count_b], [.9, .8, 2, 1]);
  assert.match(pair.id, /^conflict:[a-f0-9]{64}$/);
  assert.match(pair.preview_hash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(pair), /quote|payload/i);
});

test("unknown intervals overlap and fingerprints change with fact state", () => {
  const [base] = detectConflictPairs({ relationshipType: "works_at", singleValued: true, facts: [{ ...a, valid_from: null, valid_to: null }, b] });
  const [changed] = detectConflictPairs({ relationshipType: "works_at", singleValued: true, facts: [{ ...a, valid_from: null, valid_to: null, confidence: .7 }, b] });
  assert.deepEqual([base.overlap_from, base.overlap_to], [20, 30]);
  assert.notEqual(base.fingerprint_a, changed.fingerprint_a);
  assert.notEqual(base.preview_hash, changed.preview_hash);
});

test("conflict candidates persist decisions and reopen only when evidence changes", () => {
  const store = new GraphologyStore(":memory:");
  const entities = [
    { name: "Alice", type: "person", confidence: 1, evidence_span: "Alice" },
    { name: "Acme", type: "company", confidence: 1, evidence_span: "Acme" },
    { name: "Beta", type: "company", confidence: 1, evidence_span: "Beta" }
  ];
  const relations = [
    { source: "Alice", target: "Acme", type: "works_at", confidence: .9, evidence_span: "works", valid_from: 10, valid_to: 30 },
    { source: "Alice", target: "Beta", type: "works_at", confidence: .8, evidence_span: "also works", valid_from: 20, valid_to: 40 }
  ];
  try {
    store.ingest(entities, relations, "fixture:one");
    assert.deepEqual(store.scanConflictCandidates(["works_at"]), { scanned: 2, created: 1, updated: 0, invalidated: 0 });
    const first = store.reviewConflictCandidates({ status: "pending" }).items[0];
    assert.equal(first.status, "pending");
    assert.equal(store.decideConflictCandidate(first.id, "ignored").status, "ignored");
    store.scanConflictCandidates(["works_at"]);
    assert.equal(store.reviewConflictCandidates({ status: "ignored" }).items.length, 1);
    store.ingest([], [relations[0]], "fixture:two");
    store.scanConflictCandidates(["works_at"]);
    assert.equal(store.reviewConflictCandidates({ status: "pending" }).items.length, 2);
  } finally { store.close(); }
});

test("conflict candidates cannot bridge or leak evidence scopes", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const entities = [
      { name: "Alice", type: "person", confidence: 1, evidence_span: "Alice" },
      { name: "Acme", type: "company", confidence: 1, evidence_span: "Acme" },
      { name: "Beta", type: "company", confidence: 1, evidence_span: "Beta" }
    ];
    const relations = [
      { source: "Alice", target: "Acme", type: "works_at", confidence: .9, evidence_span: "first" },
      { source: "Alice", target: "Beta", type: "works_at", confidence: .8, evidence_span: "second" }
    ];
    store.ingest(entities, [relations[0]], "fixture:a", 0, undefined, "project:a");
    store.ingest([], [relations[1]], "fixture:b", 0, undefined, "project:b");
    assert.equal(store.scanConflictCandidates(["works_at"]).created, 0);
    store.ingest([], [relations[1]], "fixture:a", 0, undefined, "project:a");
    assert.equal(store.scanConflictCandidates(["works_at"]).created, 1);
    assert.equal(store.reviewConflictCandidates({ status: "pending", scope: "project:b" }).items.length, 0);
    assert.equal(store.reviewConflictCandidates({ status: "pending", scope: "project:a" }).items.length, 1);
  } finally { store.close(); }
});

test("truncated conflict scans never invalidate candidates outside the scanned window", () => {
  const store = new GraphologyStore(":memory:");
  try {
    store.ingest([
      { name:"Zed",type:"person",confidence:1,evidence_span:"Zed" },
      { name:"Acme",type:"company",confidence:1,evidence_span:"Acme" },
      { name:"Beta",type:"company",confidence:1,evidence_span:"Beta" }
    ],[
      { source:"Zed",target:"Acme",type:"works_at",confidence:.9,evidence_span:"a" },
      { source:"Zed",target:"Beta",type:"works_at",confidence:.8,evidence_span:"b" }
    ],"fixture:conflict");
    store.scanConflictCandidates(["works_at"]);
    const candidate=store.reviewConflictCandidates({status:"pending"}).items[0];
    const now=Date.now();
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("person:aaa","person","AAA","","[]",0,now,now);
    store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("edge:bulk","person:aaa","company:acme","works_at","{}",0,now,now);
    const insert=store.db.prepare("INSERT INTO kg_observations(id,edge_id,payload,source,quote,confidence,created_at) VALUES(?,?,?,?,?,?,?)");
    store.db.exec("BEGIN");
    for(let index=0;index<10001;index++)insert.run(`obs:bulk-${String(index).padStart(5,"0")}`,"edge:bulk","{}","bulk","",.7,now);
    store.db.exec("COMMIT");
    const result=store.scanConflictCandidates(["works_at"]);
    assert.equal(result.truncated,true);
    assert.equal(result.invalidated,0);
    assert.notEqual(store.db.prepare("SELECT status FROM kg_conflict_candidates WHERE id=?").get(candidate.id).status,"invalid");
  } finally { store.close(); }
});

test("relationship metadata can opt a type into conflict scanning", () => {
  const previous = relationshipDefinitions.works_at.singleValued;
  relationshipDefinitions.works_at.singleValued = true;
  const store = new GraphologyStore(":memory:");
  try {
    store.ingest([
      { name: "Alice", type: "person", confidence: 1, evidence_span: "Alice" },
      { name: "Acme", type: "company", confidence: 1, evidence_span: "Acme" },
      { name: "Beta", type: "company", confidence: 1, evidence_span: "Beta" }
    ], [
      { source: "Alice", target: "Acme", type: "works_at", confidence: .9, evidence_span: "works" },
      { source: "Alice", target: "Beta", type: "works_at", confidence: .8, evidence_span: "works" }
    ]);
    assert.equal(store.scanConflictCandidates([]).created, 1);
  } finally { relationshipDefinitions.works_at.singleValued = previous; store.close(); }
});

test("ingestion automatically discovers configured conflicts without an explicit review scan", async () => {
  const extraction = { entities: [
    { name: "Alice", type: "person", confidence: 1, evidence_span: "Alice" },
    { name: "Acme", type: "company", confidence: 1, evidence_span: "Acme" },
    { name: "Beta", type: "company", confidence: 1, evidence_span: "Beta" }
  ], relations: [
    { source: "Alice", target: "Acme", type: "works_at", confidence: .9, evidence_span: "works" },
    { source: "Alice", target: "Beta", type: "works_at", confidence: .8, evidence_span: "works" }
  ] };
  const graph = new Mnemora({ config: { dbPath: ":memory:", quality: { singleValuedEdgeTypes: ["works_at"] } }, extractor: { async extract() { return extraction; } } });
  try {
    await graph.kg_ingest("fixture", "fixture", extraction);
    assert.equal(graph.kg_review("anomalies", "pending", false).items.length, 1);
  } finally { graph.close(); }
});

test("conflict discovery failures are bounded ingestion warnings", async () => {
  const extraction = { entities: [{ name: "Acme", type: "company", confidence: 1, evidence_span: "Acme" }], relations: [] };
  const graph = new Mnemora({ config: { dbPath: ":memory:", quality: { singleValuedEdgeTypes: ["works_at"] } }, extractor: { async extract() { return extraction; } } });
  try {
    graph.store.scanConflictCandidates = () => { throw new Error("private graph evidence"); };
    const outcome = await graph.ingestItem({ text: "private input", source: "fixture" }, extraction);
    assert.deepEqual(outcome.warnings.at(-1), { category: "conflict_discovery_failed" });
    assert.doesNotMatch(JSON.stringify(outcome), /private graph evidence/);
  } finally { graph.close(); }
});

test("conflict scan is disabled when no relationship types are explicitly configured", () => {
  const store = new GraphologyStore(":memory:");
  try {
    assert.deepEqual(store.scanConflictCandidates([]), { scanned: 0, created: 0, updated: 0, invalidated: 0 });
  } finally { store.close(); }
});

test("kg_review reuses anomaly review for scan and explicit conflict decisions", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:", quality: { singleValuedEdgeTypes: ["works_at"] } } });
  try {
    graph.store.ingest([
      { name: "Alice", type: "person", confidence: 1, evidence_span: "Alice" },
      { name: "Acme", type: "company", confidence: 1, evidence_span: "Acme" },
      { name: "Beta", type: "company", confidence: 1, evidence_span: "Beta" }
    ], [
      { source: "Alice", target: "Acme", type: "works_at", confidence: .9, evidence_span: "works" },
      { source: "Alice", target: "Beta", type: "works_at", confidence: .8, evidence_span: "works" }
    ]);
    const review = graph.kg_review("anomalies", "pending", true);
    assert.equal(review.items.length, 1);
    assert.equal(graph.kg_review("anomalies", "pending", false, 20, undefined, review.items[0].id, "rejected").status, "rejected");
    assert.throws(() => graph.kg_review("anomalies", "pending", false, 20, undefined, review.items[0].id), /provided together/);
    assert.throws(() => graph.kg_review("duplicates", "pending", false, 20, undefined, review.items[0].id, "ignored"), /kind anomalies/);
  } finally { graph.close(); }
});

test("forget immediately invalidates conflict candidates that reference retired graph state", () => {
  const store = new GraphologyStore(":memory:");
  try {
    store.ingest([
      { name: "Alice", type: "person", confidence: 1, evidence_span: "Alice" },
      { name: "Acme", type: "company", confidence: 1, evidence_span: "Acme" },
      { name: "Beta", type: "company", confidence: 1, evidence_span: "Beta" }
    ], [
      { source: "Alice", target: "Acme", type: "works_at", confidence: .9, evidence_span: "works" },
      { source: "Alice", target: "Beta", type: "works_at", confidence: .8, evidence_span: "works" }
    ]);
    store.scanConflictCandidates(["works_at"]);
    store.forget("company:beta");
    assert.equal(store.reviewConflictCandidates({ status: "invalid" }).items.length, 1);
  } finally { store.close(); }
});
