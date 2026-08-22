import test from "node:test";
import assert from "node:assert/strict";
import { GraphologyStore } from "../dist/index.js";
import { MaintenanceService } from "../dist/operations/maintenance.js";

test("orphan cleanup is preview-first, revision-bound, single-use, and bumps revision once", () => {
  const store = new GraphologyStore(":memory:"), now = 1_700_000_000_000;
  try {
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES('company:orphan','company','Orphan','','[]',0,?,?)").run(now,now);
    const service = new MaintenanceService({ store, now: () => now, randomBytes: () => Buffer.alloc(32,13) });
    const before = store.graphRevision(), preview = service.preview({ operation:"orphan_cleanup",phase:"preview",graph_revision:before,payload:{limit:10} });
    assert.deepEqual(preview.affected,{nodes:1,edges:0,observations:0}); assert.equal(store.getNodeById("company:orphan")?.deleted_at ?? null,null);
    const result = service.confirm({operation:"orphan_cleanup",phase:"confirm",preview_token:preview.preview_token,payload_hash:preview.payload_hash,graph_revision:before,payload:{limit:10}});
    assert.equal(result.confirmed,true); assert.equal(store.graphRevision(),before+1); assert.ok(store.getNodeById("company:orphan",true)?.deleted_at);
    assert.throws(()=>service.confirm({operation:"orphan_cleanup",phase:"confirm",preview_token:preview.preview_token,payload_hash:preview.payload_hash,graph_revision:before,payload:{limit:10}}),/invalid_preview/);
  } finally { store.close(); }
});

test("weight recompute uses deterministic formulas and preserves observation confidence", () => {
  const store=new GraphologyStore(":memory:"),now=1_700_000_000_000;
  try{
    const node=store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");node.run("company:a","company","A","","[]",0,now,now);node.run("product:b","product","B","","[]",0,now,now);
    store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,created_at,updated_at) VALUES('edge:ab','company:a','product:b','uses','{}',0,?,?)").run(now,now);
    store.db.prepare("INSERT INTO kg_observations(id,edge_id,payload,source,quote,confidence,created_at) VALUES('obs:ab','edge:ab','{}','report:public','',.8,?)").run(now);
    const service=new MaintenanceService({store,now:()=>now,randomBytes:()=>Buffer.alloc(32,14)}),before=store.graphRevision();
    const preview=service.preview({operation:"weight_recompute",phase:"preview",graph_revision:before,payload:{limit:10}});assert.equal(preview.affected.edges,1);
    service.confirm({operation:"weight_recompute",phase:"confirm",preview_token:preview.preview_token,payload_hash:preview.payload_hash,graph_revision:before,payload:{limit:10}});
    assert.equal(store.db.prepare("SELECT weight FROM kg_edges WHERE id='edge:ab'").get().weight,.16);assert.equal(store.db.prepare("SELECT confidence FROM kg_observations WHERE id='obs:ab'").get().confidence,.8);assert.equal(store.graphRevision(),before+1);
  }finally{store.close();}
});

test("weight recompute confirmation changes only the exact previewed rows", () => {
  const store=new GraphologyStore(":memory:"),now=1_700_000_000_000;
  try {
    const node=store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
    node.run("company:a","company","A","","[]",0,now,now);
    node.run("company:b","company","B","","[]",0,now,now);
    const observation=store.db.prepare("INSERT INTO kg_observations(id,source_entity_id,payload,source,quote,confidence,created_at) VALUES(?,?,?,?,?,?,?)");
    observation.run("obs:a","company:a","{}","test","",1,now);
    observation.run("obs:b","company:b","{}","test","",1,now);
    const service=new MaintenanceService({store,now:()=>now+100,randomBytes:()=>Buffer.alloc(32,15)});
    const revision=store.graphRevision();
    const preview=service.preview({operation:"weight_recompute",phase:"preview",graph_revision:revision,payload:{limit:1}});
    assert.equal(preview.truncated,true);
    assert.deepEqual(preview.affected,{nodes:1,edges:0,observations:0});
    service.confirm({operation:"weight_recompute",phase:"confirm",preview_token:preview.preview_token,payload_hash:preview.payload_hash,graph_revision:revision,payload:{limit:1}});
    const rows=store.db.prepare("SELECT id,updated_at FROM kg_nodes ORDER BY id").all().map(row=>({...row}));
    assert.deepEqual(rows,[{id:"company:a",updated_at:now+100},{id:"company:b",updated_at:now}]);
  } finally { store.close(); }
});
