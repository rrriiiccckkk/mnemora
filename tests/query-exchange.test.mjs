import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphologyStore } from "../dist/store.js";
import { Mnemora } from "../dist/tools.js";
import { exportGraph, previewJsonlImport, confirmJsonlImport } from "../dist/query/exchange.js";
import { isCanonicalId } from "../dist/query/canonical-id.js";
import { normalizeSlug } from "../dist/slug.js";

function fixture() {
  const store = new GraphologyStore(":memory:");
  const insertNode = store.db.prepare(`INSERT INTO kg_nodes(id,type,name,description,aliases,importance,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`);
  insertNode.run('company:a','company','A','alpha',JSON.stringify(['Alpha, Inc.','A "quoted"']),.5,null,1,2);
  insertNode.run('person:b','person','B','beta','[]',.2,9,3,4);
  store.db.prepare(`INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run('edge:1','person:b','company:a','works_at',JSON.stringify({role:'R&D <lead>'}),.8,null,5,6);
  store.db.prepare(`INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run('obs:1','edge:1',null,JSON.stringify({fact:'x'}),'https://example.test','line 1\nline 2',.9,10,20,.7,7);
  store.db.prepare(`INSERT INTO kg_merge_audits(id,canonical_id,duplicate_id,status,snapshot_version,snapshot,preview_hash,created_at)
    VALUES('audit:1','company:a','company:old','merged',1,'{}','x',8)`).run();
  store.db.prepare(`INSERT INTO kg_entity_redirects(retired_id,canonical_id,audit_id,created_at) VALUES('company:old','company:a','audit:1',8)`).run();
  store.bumpGraphRevision();
  return store;
}

test("JSONL is canonical, lossless, private, and round-trips", () => {
  const source = fixture(); const target = new GraphologyStore(":memory:");
  try {
    source.db.prepare("UPDATE kg_nodes SET embedding=?,embedding_provider=?,embedding_model=? WHERE id='company:a'").run(new Uint8Array([1,2]), "secret-key", "provider-response");
    source.db.prepare("UPDATE kg_observations SET scope='research:semiconductor' WHERE id='obs:1'").run();
    const out = exportGraph(source, { format: "jsonl" });
    assert.equal(out.format, "jsonl"); assert.equal(out.truncated, false);
    for (const secret of ["secret-key", "provider-response", "embedding", "C:\\\\Users\\\\rick", "query_prompt", "automatic-run prompt"]) assert.equal(out.data.includes(secret), false);
    const exportedObservation = out.data.trim().split("\n").map(JSON.parse).find(record => record.kind === "observation");
    assert.equal(exportedObservation.format_version, 2);
    assert.equal(exportedObservation.observation.scope, "research:semiconductor");
    const preview = previewJsonlImport(target, out.data);
    assert.equal(preview.errors.length, 0); assert.equal(preview.counts.total, 5);
    const result = confirmJsonlImport(target, { input: out.data, previewHash: preview.preview_hash, confirm: true });
    assert.equal(result.imported.total, 5); assert.equal(target.graphRevision(), 1);
    assert.equal(target.db.prepare("SELECT scope FROM kg_observations WHERE id='obs:1'").get().scope, "research:semiconductor");
    assert.equal(exportGraph(target, { format: "jsonl" }).data, out.data);
  } finally { source.close(); target.close(); }
});

test("version 1 observations import into the default scope while version 2 validates scope", () => {
  const store = new GraphologyStore(":memory:"), invalidStore = new GraphologyStore(":memory:");
  try {
    const node = { format_version: 1, kind: "node", node: { id: "company:a", type: "company", name: "A", description: "", aliases: [], importance: 0, deleted_at: null, created_at: 1, updated_at: 1 } };
    const observation = { format_version: 1, kind: "observation", observation: { id: "obs:legacy", edge_id: null, source_entity_id: "company:a", payload: {}, source: "fixture", quote: "legacy", confidence: .8, valid_from: null, valid_to: null, temporal_confidence: null, created_at: 2 } };
    const data = [node, observation].map(JSON.stringify).join("\n");
    const preview = previewJsonlImport(store, data);
    assert.equal(preview.errors.length, 0);
    confirmJsonlImport(store, { input: data, previewHash: preview.preview_hash, confirm: true });
    assert.equal(store.db.prepare("SELECT scope FROM kg_observations WHERE id='obs:legacy'").get().scope, "default");

    const invalidV2 = JSON.stringify({ ...observation, format_version: 2, observation: { ...observation.observation, id: "obs:unsafe", scope: "../../unsafe" } });
    assert.deepEqual(previewJsonlImport(invalidStore, invalidV2).errors, [{ line: 1, category: "invalid_record", message: "observation requires exactly one valid subject" }]);
  } finally { store.close(); invalidStore.close(); }
});

test("preview isolates invalid records and enforces closed schemas and hard bounds", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const valid = JSON.stringify({format_version:1,kind:"node",node:{id:"concept:x",type:"concept",name:"X",description:"",aliases:[],importance:0,deleted_at:null,created_at:1,updated_at:1}});
    const bad = JSON.stringify({format_version:1,kind:"node",node:{id:"concept:y",type:"concept",name:"Y",description:"",aliases:[],importance:0,deleted_at:null,created_at:1,updated_at:1},extra:true});
    const p = previewJsonlImport(store, `${valid}\nnot-json\n${bad}\n${valid}\n`);
    assert.equal(p.counts.valid, 1); assert.equal(p.duplicates.length, 1); assert.equal(p.errors.length, 2);
    assert.throws(() => previewJsonlImport(store, Buffer.from([0xff])), /UTF-8/);
    assert.throws(() => previewJsonlImport(store, "{}\n".repeat(1001)), /1,000/);
    assert.throws(() => previewJsonlImport(store, "x".repeat(10 * 1024 * 1024 + 1)), /10 MiB/);
    assert.throws(() => previewJsonlImport(store, "{}\n".repeat(1001), {maxRecords:Number.MAX_SAFE_INTEGER}), /1,000/);
    assert.throws(() => previewJsonlImport(store, "x".repeat(10 * 1024 * 1024 + 1), {maxBytes:Number.MAX_SAFE_INTEGER}), /10 MiB/);
  } finally { store.close(); }
});

test("confirmation binds payload and revision, requires true, and rolls back", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const source = fixture(); const data = exportGraph(source, { format: "jsonl" }).data; source.close();
    const p = previewJsonlImport(store, data);
    assert.throws(() => confirmJsonlImport(store, {input:data,previewHash:p.preview_hash,confirm:false}), /confirm/);
    assert.throws(() => confirmJsonlImport(store, {input:data+"\n",previewHash:p.preview_hash,confirm:true}), /hash|preview/);
    store.bumpGraphRevision();
    assert.throws(() => confirmJsonlImport(store, {input:data,previewHash:p.preview_hash,confirm:true}), /stale/);
    const p2 = previewJsonlImport(store, data);
    store.db.prepare("CREATE TRIGGER fail_obs BEFORE INSERT ON kg_observations BEGIN SELECT RAISE(ABORT,'injected'); END").run();
    assert.throws(() => confirmJsonlImport(store, {input:data,previewHash:p2.preview_hash,confirm:true}), /injected/);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM kg_nodes").get().count, 0);
    assert.equal(store.graphRevision(), 1);
  } finally { store.close(); }
});

test("CSV and GraphML escape stably and report omissions; import is JSONL only", () => {
  const store = fixture();
  try {
    const csv = exportGraph(store, {format:"csv"});
    assert.match(csv.data, /""Alpha, Inc\.""/); assert.match(csv.data, /"R&D <lead>"/);
    const xml = exportGraph(store, {format:"graphml"}); assert.match(xml.data, /R&amp;D &lt;lead&gt;/);
    for (const result of [csv, xml]) assert.deepEqual(result.omissions, ["digest_audit_state","embeddings","local_source_paths","observation_payload_bodies","observation_quote_bodies","query_audit_state"]);
    assert.throws(() => previewJsonlImport(store, csv.data), /JSONL|record/);
    assert.throws(() => exportGraph(store, {format:"csv",maxRecords:1}), /bound|limit|truncat/i);
  } finally { store.close(); }
});

test("preview reports identities that conflict with the current graph", () => {
  const store = fixture();
  try {
    const exported = exportGraph(store, {format:"jsonl"}).data;
    const preview = previewJsonlImport(store, exported);
    assert.equal(preview.conflicts.length, 6);
    assert.throws(() => confirmJsonlImport(store, {input:exported,previewHash:preview.preview_hash,confirm:true}), /validation/);
  } finally { store.close(); }
});

test("source export preserves logical sources and sanitizes URL credentials and paths", () => {
  const store = fixture();
  try {
    const add = store.db.prepare(`INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    add.run("obs:logical",null,"company:a","{}","manual:research","q",1,null,null,null,10);
    add.run("obs:url",null,"company:a","{}","https://user:pw@example.test/p?z=2&API_KEY=nope&a=1&token=gone#frag","q",1,null,null,null,11);
    add.run("obs:win",null,"company:a","{}","C:\\Users\\rick\\secret.txt","q",1,null,null,null,12);
    add.run("obs:unc",null,"company:a","{}","\\\\server\\share\\secret.txt","q",1,null,null,null,13);
    add.run("obs:posix",null,"company:a","{}","/home/rick/secret.txt","q",1,null,null,null,14);
    const out = exportGraph(store,{format:"jsonl"});
    assert.match(out.data,/manual:research/); assert.match(out.data,/https:\/\/example\.test\/p\?a=1&z=2/);
    for (const secret of ["user:pw","API_KEY","nope","token","gone","#frag","C:\\\\Users","server\\\\share","/home/rick"]) assert.equal(out.data.includes(secret),false);
    assert.deepEqual(out.omissions,["credentials","embeddings","local_source_paths","provider_state","query_audit_state","digest_audit_state","source_url_fragment","source_url_sensitive_query","source_url_userinfo"]);
    const target=new GraphologyStore(":memory:"); try { const p=previewJsonlImport(target,out.data); confirmJsonlImport(target,{input:out.data,previewHash:p.preview_hash,confirm:true}); const sources=target.db.prepare("SELECT source FROM kg_observations ORDER BY id").all().map(x=>x.source); assert.ok(sources.includes("manual:research")); assert.ok(sources.includes("https://example.test/p?a=1&z=2")); } finally { target.close(); }
  } finally { store.close(); }
});

test("confirmation reauthorizes preview and revision under the write lock", () => {
  const path=join(mkdtempSync(join(tmpdir(),"mnemora-exchange-")),"graph.db"); const a=new GraphologyStore(path); const b=new GraphologyStore(path); const source=fixture();
  try {
    const data=exportGraph(source,{format:"jsonl"}).data; const preview=previewJsonlImport(a,data); const original=a.runGraphImportTransaction.bind(a);
    a.runGraphImportTransaction=(operation)=>{ b.bumpGraphRevision(); return original(operation); };
    assert.throws(()=>confirmJsonlImport(a,{input:data,previewHash:preview.preview_hash,confirm:true}),/stale/);
    assert.equal(a.db.prepare("SELECT COUNT(*) count FROM kg_nodes").get().count,0); assert.equal(a.graphRevision(),1);
  } finally { source.close(); a.close(); b.close(); }
});

test("preview covers database uniqueness and redirect/audit constraints with exact safe lines", () => {
  const store=fixture();
  try {
    const node=id=>({format_version:1,kind:"node",node:{id,type:"concept",name:id,description:"",aliases:[],importance:0,deleted_at:null,created_at:1,updated_at:1}});
    const edge={format_version:1,kind:"edge",edge:{id:"edge:new",source_id:"person:b",target_id:"company:a",type:"works_at",edge_props:{},weight:0,deleted_at:null,created_at:1,updated_at:1}};
    const redirect=(retired_id,canonical_id)=>({format_version:1,kind:"redirect",redirect:{retired_id,canonical_id,created_at:1}});
    const auditId=`import:${createHash("sha256").update("company:fresh").digest("hex").slice(0,24)}`;
    store.db.prepare("INSERT INTO kg_merge_audits(id,canonical_id,duplicate_id,status,snapshot_version,snapshot,preview_hash,created_at) VALUES(?,?,?,'merged',1,'{}','x',1)").run(auditId,"company:a","company:fresh");
    const data=[node("company:fresh"),edge,redirect("company:a","company:fresh"),redirect("company:self","company:self"),redirect("company:fresh","company:a")].map(JSON.stringify).join("\n");
    const p=previewJsonlImport(store,data);
    assert.deepEqual(p.conflicts.map(x=>x.line),[2,3,4,5,5]); assert.ok(p.conflicts.every(x=>!JSON.stringify(x).includes("fresh")));
  } finally { store.close(); }
});

test("external ids use bounded canonical grammar and diagnostics never echo them", () => {
  const store=new GraphologyStore(":memory:");
  try {
    const ids=["UPPER:x","concept:has space",`concept:${"x".repeat(129)}`,"concept:evil\nSECRET"];
    const data=ids.map(id=>JSON.stringify({format_version:1,kind:"node",node:{id,type:"concept",name:"X",description:"",aliases:[],importance:0,deleted_at:null,created_at:1,updated_at:1}})).join("\n");
    const p=previewJsonlImport(store,data); assert.deepEqual(p.errors.map(x=>x.line),[1,2,3,4]); assert.ok(p.errors.every(x=>x.category==="invalid_id")); assert.equal(JSON.stringify(p).includes("SECRET"),false);
    const ref=JSON.stringify({format_version:1,kind:"edge",edge:{id:"edge:ok",source_id:"concept:missing",target_id:"concept:other",type:"related_to",edge_props:{},weight:0,deleted_at:null,created_at:1,updated_at:1}});
    assert.deepEqual(previewJsonlImport(store,ref).errors,[{line:1,category:"referential_integrity",message:"record has missing reference"}]);
  } finally { store.close(); }
});

test("canonical id grammar accepts slug-leading hyphens while rejecting hostile boundaries", () => {
  const generated = [normalizeSlug("-Alpha Company", "company"), normalizeSlug("---Alpha Company", "company")];
  assert.deepEqual(generated, ["company:-alpha-company", "company:---alpha-company"]);
  for (const id of [...generated, "company:-", "company:---", "company:alpha~legacy", `company:${"-".repeat(128)}`]) {
    assert.equal(isCanonicalId(id), true, id);
  }
  for (const id of [
    "Company:alpha", "1company:alpha", "company/:alpha", "company\\:alpha", "company name:alpha",
    "company:", "company:.alpha", "company:_alpha", "company:~alpha", "company:- alpha", "company:-\nalpha",
    "company:-\u0000alpha", "company:-/etc/passwd", "company:-\\private\\graph.db",
    "company:user:password@example.test", "company:C:\\private\\graph.db", `company:${"-".repeat(129)}`
  ]) assert.equal(isCanonicalId(id), false, JSON.stringify(id));

  const store = new GraphologyStore(":memory:");
  try {
    const data = ["concept:-", "concept:---", "concept:-alpha", "concept:alpha~legacy"].map((id, index) => JSON.stringify({
      format_version: 1, kind: "node", node: { id, type: "concept", name: `Valid ${index}`, description: "", aliases: [], importance: 0, deleted_at: null, created_at: 1, updated_at: 1 }
    })).join("\n");
    assert.equal(previewJsonlImport(store, data).errors.length, 0);
  } finally { store.close(); }
});

test("imported canonical ids containing tildes remain safe compare candidates and support retry", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  const node = (id, name) => ({ format_version: 1, kind: "node", node: { id, type: "company", name, description: "", aliases: [], importance: 0, deleted_at: null, created_at: 1, updated_at: 1 } });
  const data = [
    node("company:acme~east", "Acme"),
    node("company:acme~west", "Acme"),
    node("company:tsmc~fab", "TSMC")
  ].map(JSON.stringify).join("\n");
  try {
    const preview = graph.kg_import({ format: "jsonl", data });
    assert.equal(preview.errors.length, 0);
    graph.kg_import({ format: "jsonl", data, preview_hash: preview.preview_hash, confirm: true });
    graph.kg_search = async () => [];

    let candidates;
    await assert.rejects(graph.kg_compare({ left: "Acme", right: "company:tsmc~fab", as_of: 20 }), error => {
      candidates = error.public?.details?.candidates;
      assert.deepEqual(candidates?.map(candidate => candidate.id), ["company:acme~east", "company:acme~west"]);
      return true;
    });
    const retried = await graph.kg_compare({ left: candidates[0].id, right: "company:tsmc~fab", as_of: 20 });
    assert.deepEqual(retried.subjects.map(subject => subject.id), ["company:acme~east", "company:tsmc~fab"]);
  } finally { graph.close(); }
});

test("GraphML declares every referenced key and lossy bounds count only nodes and edges", () => {
  const store=fixture();
  try {
    const xml=exportGraph(store,{format:"graphml",maxRecords:3}); const csv=exportGraph(store,{format:"csv",maxRecords:3});
    assert.equal(xml.record_count,3); assert.equal(csv.record_count,3);
    const declared=new Set([...xml.data.matchAll(/<key id="([^"]+)"/g)].map(x=>x[1])); const used=[...xml.data.matchAll(/<data key="([^"]+)"/g)].map(x=>x[1]);
    assert.ok(used.length>0); assert.ok(used.every(key=>declared.has(key))); assert.match(xml.data,/<key id="name" for="node" attr\.name="name" attr\.type="string"\/>/);
    assert.throws(()=>exportGraph(store,{format:"csv",maxRecords:2}),/bound/);
  } finally { store.close(); }
});

test("preview rejects a redirect retiring an active node from the same payload", () => {
  const store=new GraphologyStore(":memory:");
  try {
    const node=id=>({format_version:1,kind:"node",node:{id,type:"company",name:"X",description:"",aliases:[],importance:0,deleted_at:null,created_at:1,updated_at:1}});
    const data=[node("company:a"),node("company:x"),{format_version:1,kind:"redirect",redirect:{retired_id:"company:x",canonical_id:"company:a",created_at:1}}].map(JSON.stringify).join("\n");
    const p=previewJsonlImport(store,data); assert.deepEqual(p.conflicts,[{kind:"redirect",category:"retired_id_is_active",line:3}]);
    assert.throws(()=>confirmJsonlImport(store,{input:data,previewHash:p.preview_hash,confirm:true}),/validation/);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM kg_nodes").get().count,0); assert.equal(store.graphRevision(),0);
  } finally { store.close(); }
});

test("source policy covers file URIs, wrapped paths, normalized credential keys, and exact safe URLs", () => {
  const store=fixture();
  try {
    const add=store.db.prepare(`INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    const sources=[
      ["obs:file","file:///C:/Users/rick/secret.txt"], ["obs:wrapped-win","manual:C:\\Users\\rick\\secret.txt"],
      ["obs:wrapped-posix","source:/home/rick/secret.txt"], ["obs:wrapped-unc","manual:\\\\server\\share\\secret.txt"],
      ["obs:tokens","https://example.test/p?X-API-KEY=a&access_token=b&Authorization=c&passwd=d&sig=e&safe=ok"],
      ["obs:safe-url","https://example.test:443/p?z=2&a=1"], ["obs:logical-safe","manual:research/topic"]
    ];
    for(let i=0;i<sources.length;i++) add.run(sources[i][0],null,"company:a","{}",sources[i][1],"q",1,null,null,null,20+i);
    const out=exportGraph(store,{format:"jsonl"}); const rows=out.data.trim().split("\n").map(JSON.parse).filter(x=>x.kind==="observation"); const byId=Object.fromEntries(rows.map(x=>[x.observation.id,x.observation.source]));
    for(const id of ["obs:file","obs:wrapped-win","obs:wrapped-posix","obs:wrapped-unc"]) assert.equal(byId[id],"local:omitted");
    assert.equal(byId["obs:tokens"],"https://example.test/p?safe=ok");
    assert.equal(byId["obs:safe-url"],"https://example.test:443/p?z=2&a=1"); assert.equal(byId["obs:logical-safe"],"manual:research/topic");
    for(const secret of ["X-API-KEY=a","access_token=b","Authorization=c","passwd=d","sig=e","file:///","manual:C:","source:/home","server\\\\share"]) assert.equal(out.data.includes(secret),false);
    assert.ok(out.omissions.includes("local_source_paths")); assert.ok(out.omissions.includes("source_url_sensitive_query"));
    assert.equal(out.omissions.includes("source_normalized"),false);
  } finally { store.close(); }
});

test("public kg_import enforces configured byte and record limits in preview and confirm", () => {
  const graph=new Mnemora({config:{dbPath:":memory:",query:{maxImportBytes:1000,maxImportRecords:2}}});
  try {
    const node=(id,description="")=>JSON.stringify({format_version:1,kind:"node",node:{id,type:"concept",name:"X",description,aliases:[],importance:0,deleted_at:null,created_at:1,updated_at:1}});
    const records=[node("concept:a"),node("concept:b"),node("concept:c")].join("\n"); const bytes=node("concept:large","x".repeat(1500));
    assert.throws(()=>graph.kg_import({format:"jsonl",data:records}),/record limit/);
    assert.throws(()=>graph.kg_import({format:"jsonl",data:bytes}),/byte limit/);
    const recordPreview=previewJsonlImport(graph.store,records,{maxBytes:10485760,maxRecords:1000});
    assert.throws(()=>graph.kg_import({format:"jsonl",data:records,preview_hash:recordPreview.preview_hash,confirm:true}),/record limit/);
    const bytePreview=previewJsonlImport(graph.store,bytes,{maxBytes:10485760,maxRecords:1000});
    assert.throws(()=>graph.kg_import({format:"jsonl",data:bytes,preview_hash:bytePreview.preview_hash,confirm:true}),/byte limit/);
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) count FROM kg_nodes").get().count,0); assert.equal(graph.store.graphRevision(),0);
  } finally { graph.close(); }
});
