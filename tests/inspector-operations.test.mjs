import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mnemora } from "../dist/index.js";
import { createInspectorApplication } from "../dist/inspector/application.js";

test("operation application is absent in read-only mode and dispatches normalized preview/confirm when enabled", async () => {
  const directory=mkdtempSync(join(tmpdir(),"mnemora-ops-")),graph=new Mnemora({config:{dbPath:":memory:"}});
  try{
    const readOnly=createInspectorApplication({graph,allowOperations:false,artifactDirectory:directory});assert.equal(readOnly.operationPreview,undefined);assert.equal(readOnly.operationConfirm,undefined);assert.deepEqual(readOnly.healthSummary().recovery.artifacts,{backups:0,recovery_points:0,available:0,missing:0});
    const enabled=createInspectorApplication({graph,allowOperations:true,artifactDirectory:directory,randomBytes:()=>Buffer.alloc(32,15)});
    const preview=await enabled.operationPreview({operation:"backup",phase:"preview",graph_revision:graph.store.graphRevision(),payload:{}});assert.equal(preview.operation,"backup");
    const result=await enabled.operationConfirm({operation:"backup",phase:"confirm",graph_revision:preview.graph_revision,preview_token:preview.preview_token,payload_hash:preview.payload_hash,payload:{}});assert.equal(result.confirmed,true);
    const health=enabled.healthSummary();assert.equal(health.recovery.status,"healthy");assert.deepEqual(health.recovery.artifacts,{backups:1,recovery_points:0,available:1,missing:0});assert.equal(typeof health.recovery.latest_created_at,"number");assert.equal(JSON.stringify(health).includes(directory),false);
    await assert.rejects(()=>enabled.operationPreview({operation:"restore",phase:"preview",graph_revision:0,payload:{artifact_id:"C:/secret.db"}}),/invalid inspector request/);
  }finally{graph.close();try{rmSync(directory,{recursive:true,force:true});}catch{}}
});

test("Inspector exposes a bounded artifact-manifest load failure instead of reporting an empty healthy registry", () => {
  const directory=mkdtempSync(join(tmpdir(),"mnemora-ops-invalid-")),graph=new Mnemora({config:{dbPath:":memory:"}});
  try{
    writeFileSync(join(directory,".mnemora-artifacts.json"),"not json");
    const application=createInspectorApplication({graph,allowOperations:false,artifactDirectory:directory}),health=application.healthSummary();
    assert.deepEqual(health.recovery,{status:"degraded",artifacts:{backups:0,recovery_points:0,available:0,missing:0},latest_created_at:null,load_error:"manifest_invalid"});
  }finally{graph.close();try{rmSync(directory,{recursive:true,force:true});}catch{}}
});
