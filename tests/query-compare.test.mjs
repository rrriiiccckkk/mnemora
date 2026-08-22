import test from "node:test";
import assert from "node:assert/strict";
import { GraphologyStore } from "../dist/store.js";
import { Mnemora } from "../dist/tools.js";
import { detectCommunities } from "../dist/insights/community.js";
import { compareSubjects } from "../dist/query/compare.js";
import { resolveCompareSubject } from "../dist/query/subject-resolution.js";
import { ResearchOperationError } from "../dist/query/errors.js";

function fixture(reverse=false) {
  const store = new GraphologyStore(":memory:");
  const nodes = [["company:nvidia","NVIDIA"],["company:amd","AMD"],["company:tsmc","TSMC"],["company:deep","Deep Shared"],["company:left","Left Only"],["company:right","Right Only"]];
  for (const [id,name] of (reverse ? nodes.reverse() : nodes)) store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?)").run(id,"company",name,"","[]",0,1,1);
  const edges = [["e:n:t","company:nvidia","company:tsmc"],["e:a:t","company:amd","company:tsmc"],["e:t:d","company:tsmc","company:deep"],["e:n:l","company:nvidia","company:left"],["e:a:r","company:amd","company:right"]];
  for (const [id,s,t] of (reverse ? edges.reverse() : edges)) {
    store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?)").run(id,s,t,"supplies","{}",1,1,1);
    const observation=store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    observation.run(`o:${id}:1`,id,null,"{\"private\":\"SECRET_PAYLOAD\"}","SECRET_URL","SECRET_QUOTE",.8,10,30,.7,20);
    observation.run(`o:${id}:2`,id,null,"{}","SECRET_URL","q",.8,10,30,.7,21);
  }
  return store;
}

test("comparison separates shared and unique relationships with evidence quality", () => {
  const store = fixture();
  try {
    const result = compareSubjects(store, { left: "NVIDIA", right: "AMD", max_depth: 2, confidence_min: .6, limit: 20, as_of: 20 });
    assert.deepEqual(result.subjects.map(x => x.id), ["company:nvidia", "company:amd"]);
    assert.ok(result.shared.some(x => x.entity_id === "company:tsmc"));
    assert.ok(result.only_left.every(x => Number.isFinite(x.average_confidence)));
    assert.ok(result.shared.some(x => x.evidence_count > x.source_count));
    assert.doesNotMatch(JSON.stringify(result), /SECRET_QUOTE|SECRET_URL|SECRET_PAYLOAD/);
  } finally { store.close(); }
});

test("comparison accepts community subjects and reports projection/result truncation coherently", () => {
  const store=fixture();
  try {
    const p=store.queryGraphProjection({maxNodes:10000,maxEdges:50000,asOf:20});
    const partition=detectCommunities({nodes:p.nodes.map(({id,name,type})=>({id,name,type})),edges:p.edges.map(e=>({...e,weight:e.confidence,evidenceCount:e.evidenceCount})),truncated:p.truncated,graphRevision:p.graphRevision,asOf:20});
    const community=partition.communities.find(c=>c.node_ids.includes("company:nvidia"));
    assert.ok(community);
    const result=compareSubjects(store,{left:community.id,right:"AMD",as_of:20,limit:1});
    assert.equal(result.subjects[0].type,"community");
    assert.equal(result.truncated,true);
    assert.ok(result.shared.length+result.only_left.length+result.only_right.length<=1);
    const ids=new Set(result.subjects.map(s=>s.id));
    assert.equal(ids.size,2);
  } finally { store.close(); }
});

test("depth, confidence and temporal filters include only qualifying neighborhoods", () => {
  const store=fixture();
  try {
    store.db.prepare("UPDATE kg_observations SET confidence=.4 WHERE edge_id='e:n:l'").run();
    store.db.prepare("UPDATE kg_observations SET valid_from=40,valid_to=50 WHERE edge_id='e:a:r'").run();
    const shallow=compareSubjects(store,{left:"NVIDIA",right:"AMD",max_depth:1,confidence_min:.6,valid_from:20,valid_to:20,as_of:20});
    assert.equal(shallow.only_left.some(x=>x.entity_id==="company:left"),false);
    assert.equal(shallow.only_right.some(x=>x.entity_id==="company:right"),false);
    assert.equal(shallow.shared.some(x=>x.entity_id==="company:deep"),false);
    const deep=compareSubjects(store,{left:"NVIDIA",right:"AMD",max_depth:2,confidence_min:.6,valid_from:20,valid_to:20,as_of:20});
    assert.ok(deep.shared.some(x=>x.entity_id==="company:tsmc"));
    assert.ok(deep.shared.some(x=>x.entity_id==="company:deep"));
  } finally { store.close(); }
});

test("comparison propagates projection truncation warnings", () => {
  const store=fixture();
  try {
    const original=store.queryGraphProjection.bind(store);
    store.queryGraphProjection=options=>({...original(options),truncated:true});
    const result=compareSubjects(store,{left:"NVIDIA",right:"AMD",as_of:20});
    assert.equal(result.truncated,true);
    assert.deepEqual(result.warnings,[{category:"projection_truncated"}]);
  } finally { store.close(); }
});

test("public comparison requires canonical retry for semantic and prefix candidates", async () => {
  const graph=new Mnemora({config:{dbPath:":memory:"}});
  try {
    // Use the graph's own store so lexical fallback remains production behavior.
    const source=fixture();
    for(const n of source.db.prepare("SELECT * FROM kg_nodes").all()) graph.store.db.prepare("INSERT OR IGNORE INTO kg_nodes(id,type,name,description,aliases,importance,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(n.id,n.type,n.name,n.description,n.aliases,n.importance,n.deleted_at,n.created_at,n.updated_at);
    for(const e of source.db.prepare("SELECT * FROM kg_edges").all()) graph.store.db.prepare("INSERT OR IGNORE INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(e.id,e.source_id,e.target_id,e.type,e.edge_props,e.weight,e.deleted_at,e.created_at,e.updated_at);
    for(const o of source.db.prepare("SELECT * FROM kg_observations").all()) graph.store.db.prepare("INSERT OR IGNORE INTO kg_observations(id,edge_id,source_entity_id,payload,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(o.id,o.edge_id,o.source_entity_id,o.payload,o.source,o.quote,o.confidence,o.valid_from,o.valid_to,o.temporal_confidence,o.created_at);
    source.close();
    graph.kg_search=async q=>q==="GPU maker"?[{node:graph.store.getNodeById("company:nvidia"),score:1}]:[];
    await assert.rejects(graph.kg_compare({left:"GPU maker",right:"AMD",as_of:20}), error => errorPublic(error).details.candidates[0]?.id === "company:nvidia");
    graph.kg_search=async()=>[];
    await assert.rejects(graph.kg_compare({left:"NVID",right:"AMD",as_of:20}), error => errorPublic(error).details.candidates[0]?.id === "company:nvidia");
    graph.kg_search=async()=>{throw new Error("offline")};
    await assert.rejects(graph.kg_compare({left:"NVID",right:"AMD",as_of:20}), error => errorPublic(error).details.candidates[0]?.id === "company:nvidia");
    graph.kg_search=async()=>[{node:graph.store.getNodeById("company:nvidia"),score:1},{node:graph.store.getNodeById("company:amd"),score:.9}];
    await assert.rejects(graph.kg_compare({left:"GPU maker",right:"TSMC",as_of:20}), error => errorPublic(error).error_code === "COMPARE_SUBJECT_AMBIGUOUS");
  } finally { graph.close(); }
});

test("comparison rejects ambiguity, absence and same subject", () => {
  const store = fixture();
  try {
    store.db.prepare("UPDATE kg_nodes SET aliases='[\"GPU\"]' WHERE id IN ('company:nvidia','company:amd')").run();
    assert.throws(() => compareSubjects(store,{left:"GPU",right:"TSMC"}), error => errorPublic(error).error_code === "COMPARE_SUBJECT_AMBIGUOUS");
    assert.throws(() => compareSubjects(store,{left:"missing",right:"TSMC"}), error => errorPublic(error).error_code === "COMPARE_SUBJECT_NOT_FOUND");
    assert.throws(() => compareSubjects(store,{left:"NVIDIA",right:"company:nvidia"}), error => errorPublic(error).error_code === "COMPARE_SAME_SUBJECT");
  } finally { store.close(); }
});

test("comparison is stable across storage order and honors temporal, confidence and byte bounds", () => {
  const a=fixture(), b=fixture(true);
  try {
    const base={left:"NVIDIA",right:"AMD",confidence_min:.79,valid_from:20,valid_to:20,limit:50,as_of:20};
    const unlimited=compareSubjects(a,base);
    const unlimitedCount=unlimited.shared.length+unlimited.only_left.length+unlimited.only_right.length;
    assert.ok(unlimitedCount>1);
    const max_response_bytes=700;
    const result=compareSubjects(a,{...base,max_response_bytes});
    assert.deepEqual(result,compareSubjects(b,{...base,max_response_bytes}));
    assert.equal(result.truncated,true);
    assert.ok(Buffer.byteLength(JSON.stringify(result))<=max_response_bytes);
    const retained=[...result.shared,...result.only_left,...result.only_right];
    assert.ok(retained.length<unlimitedCount);
    for(const item of retained){
      assert.ok(a.getNodeById(item.entity_id));
      for(const relationshipId of item.relationship_ids){
        const edge=a.getEdgeById(relationshipId);
        assert.ok(edge);
        assert.ok(edge.source_id===item.entity_id||edge.target_id===item.entity_id||result.subjects.some(subject=>subject.id===edge.source_id||subject.id===edge.target_id));
      }
    }
  } finally { a.close(); b.close(); }
});

function resolutionFixture(reverse = false) {
  const store = new GraphologyStore(":memory:");
  const nodes = [
    ["company:acme-alpha", "Acme", ["A", "Acme Alpha"]],
    ["company:acme-beta", "Acme", ["A", "Acme Beta"]],
    ["company:prefix", "Acme Holdings", ["Holdings"]],
    ["company:lexical", "Holding Company", ["Lexical"]],
    ["company:semantic", "Semantic Systems", ["Meaning"]],
    ["company:unsafe", "SELECT Record", ["/private/secret"]],
    ["company:extra-1", "Acme Extra 1", []],
    ["company:extra-2", "Acme Extra 2", []],
    ["company:extra-3", "Acme Extra 3", []],
    ["company:extra-4", "Acme Extra 4", []],
    ["company:extra-5", "Acme Extra 5", []]
  ];
  for (const [id, name, aliases] of (reverse ? [...nodes].reverse() : nodes)) {
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?)").run(id, "company", name, "PRIVATE_DESCRIPTION", JSON.stringify(aliases), 0, 1, 1);
  }
  return store;
}

function errorPublic(error) {
  assert.ok(error instanceof ResearchOperationError);
  return error.public;
}

test("comparison subject candidates are deterministic, bounded, sanitized, and never auto-selected", async () => {
  const first = resolutionFixture(), second = resolutionFixture(true);
  const semanticSearch = async () => [
    { node: first.getNodeById("company:semantic"), score: .9, evidence: [], score_components: { semantic: 1, lexical: 0, confidence: 0, freshness: 0 } },
    { node: first.getNodeById("company:lexical"), score: .8, evidence: [], score_components: { semantic: 0, lexical: .6, confidence: 0, freshness: 0 } },
    { node: first.getNodeById("company:acme-alpha"), score: .7, evidence: [], score_components: { semantic: .5, lexical: .5, confidence: 0, freshness: 0 } }
  ];
  try {
    await assert.rejects(
      resolveCompareSubject(first, semanticSearch, "Acme", "left", 20),
      error => {
        const result = errorPublic(error);
        assert.deepEqual(result, {
          error: "ambiguous_subject", error_code: "COMPARE_SUBJECT_AMBIGUOUS", stage: "subject_resolution", retryable: true,
          summary: "Multiple graph subjects matched.",
          details: {
            side: "left", truncated: false,
            candidates: [
              { id: "company:acme-alpha", name: "Acme", type: "company", aliases: ["A", "Acme Alpha"], match_reason: "name_exact" },
              { id: "company:acme-beta", name: "Acme", type: "company", aliases: ["A", "Acme Beta"], match_reason: "name_exact" }
            ]
          }
        });
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE|score|description|secret|path|evidence|semantic/i);
        return true;
      }
    );
    await assert.rejects(resolveCompareSubject(second, async () => [], "Acme", "left", 20), error => {
      assert.deepEqual(errorPublic(error).details.candidates.map(candidate => candidate.id), ["company:acme-alpha", "company:acme-beta"]);
      return true;
    });
    const canonical = await resolveCompareSubject(first, semanticSearch, "company:acme-alpha", "right", 20);
    assert.deepEqual(canonical, { id: "company:acme-alpha", name: "Acme", type: "company", members: ["company:acme-alpha"] });
  } finally { first.close(); second.close(); }
});

test("comparison subject resolver ranks aliases, prefix, lexical, and semantic matches with bounded fallback", async () => {
  const store = resolutionFixture();
  try {
    const search = async () => [
      { node: store.getNodeById("company:semantic"), score: .9, evidence: [], score_components: { semantic: 1, lexical: 0, confidence: 0, freshness: 0 } },
      { node: store.getNodeById("company:lexical"), score: .8, evidence: [], score_components: { semantic: 0, lexical: .6, confidence: 0, freshness: 0 } }
    ];
    await assert.rejects(resolveCompareSubject(store, search, "A", "right", 20), error => {
      assert.deepEqual(errorPublic(error).details.candidates.slice(0, 2).map(candidate => [candidate.id, candidate.match_reason]), [["company:acme-alpha", "alias_exact"], ["company:acme-beta", "alias_exact"]]);
      return true;
    });
    await assert.rejects(resolveCompareSubject(store, search, "Acme H", "right", 20), error => {
      assert.deepEqual(errorPublic(error).details.candidates.map(candidate => [candidate.id, candidate.match_reason]), [["company:prefix", "prefix"], ["company:lexical", "lexical"], ["company:semantic", "semantic"]]);
      return true;
    });
    await assert.rejects(resolveCompareSubject(store, search, "unmatched", "right", 20), error => {
      assert.deepEqual(errorPublic(error).details.candidates.map(candidate => [candidate.id, candidate.match_reason]), [["company:lexical", "lexical"], ["company:semantic", "semantic"]]);
      return true;
    });
    await assert.rejects(resolveCompareSubject(store, async () => { throw new Error("offline") }, "missing", "right", 20), error => {
      assert.deepEqual(errorPublic(error), { error: "subject_not_found", error_code: "COMPARE_SUBJECT_NOT_FOUND", stage: "subject_resolution", retryable: true, summary: "No graph subject matched.", details: { side: "right", candidates: [], truncated: false } });
      return true;
    });
    await assert.rejects(resolveCompareSubject(store, search, "community:not-real", "right", 20), error => errorPublic(error).error_code === "COMPARE_SUBJECT_NOT_FOUND");
  } finally { store.close(); }
});

test("unique exact names and aliases resolve before lower-priority suggestions", async () => {
  const store = resolutionFixture();
  let searches = 0;
  const suggestions = async () => {
    searches += 1;
    return [
      { node: store.getNodeById("company:semantic"), score: .9, evidence: [], score_components: { semantic: 1, lexical: 0, confidence: 0, freshness: 0 } },
      { node: store.getNodeById("company:lexical"), score: .8, evidence: [], score_components: { semantic: 0, lexical: .6, confidence: 0, freshness: 0 } }
    ];
  };
  try {
    store.db.prepare("UPDATE kg_nodes SET aliases=? WHERE id='company:acme-beta'").run(JSON.stringify(["company:acme-alpha"]));
    assert.equal((await resolveCompareSubject(store, suggestions, "company:acme-alpha", "left", 20)).id, "company:acme-alpha");
    assert.equal((await resolveCompareSubject(store, suggestions, "Holding Company", "left", 20)).id, "company:lexical");
    assert.equal((await resolveCompareSubject(store, suggestions, "Holdings", "right", 20)).id, "company:prefix");
    assert.equal(searches, 0);
  } finally { store.close(); }
});

test("singleton prefix, lexical, and semantic matches remain retryable candidates", async () => {
  const store = resolutionFixture();
  const cases = [
    ["Semantic Sys", async () => [], "company:semantic", "prefix"],
    ["lexical-only", async () => [{ node: store.getNodeById("company:lexical"), score: .8, evidence: [], score_components: { semantic: 0, lexical: .6, confidence: 0, freshness: 0 } }], "company:lexical", "lexical"],
    ["semantic-only", async () => [{ node: store.getNodeById("company:semantic"), score: .9, evidence: [], score_components: { semantic: 1, lexical: 0, confidence: 0, freshness: 0 } }], "company:semantic", "semantic"]
  ];
  try {
    for (const [input, search, id, match_reason] of cases) {
      await assert.rejects(resolveCompareSubject(store, search, input, "left", 20), error => {
        assert.deepEqual(errorPublic(error).details, {
          side: "left",
          candidates: [{ id, name: store.getNodeById(id).name, type: "company", aliases: store.getNodeById(id).aliases, match_reason }],
          truncated: false
        });
        return true;
      });
    }
  } finally { store.close(); }
});

test("public comparison resolves both sides through safe candidates and closed errors", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  const source = resolutionFixture();
  try {
    for (const node of source.db.prepare("SELECT * FROM kg_nodes").all()) graph.store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(node.id, node.type, node.name, node.description, node.aliases, node.importance, node.deleted_at, node.created_at, node.updated_at);
    graph.kg_search = async () => [];
    await assert.rejects(graph.kg_compare({ left: "Acme", right: "company:prefix", as_of: 20 }), error => errorPublic(error).details.side === "left");
    await assert.rejects(graph.kg_compare({ left: "company:prefix", right: "Acme", as_of: 20 }), error => errorPublic(error).details.side === "right");
    await assert.rejects(graph.kg_compare({ left: "company:prefix", right: "company:prefix", as_of: 20 }), error => errorPublic(error).error_code === "COMPARE_SAME_SUBJECT");
  } finally { source.close(); graph.close(); }
});
