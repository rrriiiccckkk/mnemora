import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "./helpers/temp.mjs";
import { recordAssemblyDiagnostic } from "../dist/context-engine/assembly-diagnostics.js";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { normalizeConfig } from "../dist/config.js";
import { GraphologyStore } from "../dist/store.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";
import { SummaryRepository } from "../dist/context-engine/summary-repository.js";
const NOW = 1000;
const ref = (id, scope = "default", kind = "conversation-event") => `mnemora://v1/scope/${scope}/${kind}/${id}`;
function fixture() { const directory = createTempDir("diagnostic-"); chmodSync(directory, 0o700); return { directory, enabled: true, scopes: ["default"], expiresAt: NOW + 1000 }; }
function records(directory) { return readdirSync(directory).filter(name => name.startsWith("assembly-")).map(name => JSON.parse(readFileSync(join(directory, name), "utf8"))); }
const candidate = { kind: "summary", contextRef: ref("s", "default", "summary"), sourceRefs: [ref("e"), "https://private.invalid/path?token=SECRET"], excerpt: "PRIVATE_EXCERPT", projectionEvidence: { claim_verification: "not_verified", source_window: "omitted_budget", truncated: true, sources: [] } };
const input = { scope: "default", sessionId: "PRIVATE_SESSION", estimatedTokens: 20, segments: [{ kind: "unified_retrieval", text: "FINAL_PRIVATE_RENDER", candidates: [candidate] }] };

test("diagnostics are disabled without filesystem writes", () => {
  const options=fixture(); assert.equal(recordAssemblyDiagnostic({ ...options, enabled: false }, input, NOW), "disabled"); assert.deepEqual(readdirSync(options.directory), []);
});
test("metadata covers final selected identities and window omission without text or external URLs", {skip:process.platform === "win32"}, () => {
  const options=fixture(); assert.equal(recordAssemblyDiagnostic(options,input,NOW),"recorded"); const [record]=records(options.directory), rendered=JSON.stringify(record);
  for(const secret of ["PRIVATE_EXCERPT","FINAL_PRIVATE_RENDER","PRIVATE_SESSION","private.invalid","SECRET"]) assert.equal(rendered.includes(secret),false);
  assert.equal(record.hostDelivery,"unknown"); assert.equal(record.stage,"plugin_handoff"); assert.equal(record.hostTurnId,null);
  assert.equal(record.segments[0].renderedBytes,Buffer.byteLength(input.segments[0].text));
  assert.equal(record.segments[0].candidates[0].sourceWindow,"omitted_budget"); assert.equal(record.segments[0].candidates[0].unavailableSources,1);
  assert.deepEqual(record.segments[0].candidates[0].sourceRefs,[ref("e")]);
});
test("expired, overly long, missing-path and wrong-scope windows produce no files", () => {
  for(const change of [{expiresAt:NOW},{expiresAt:NOW+86400001},{scopes:["other"]},{directory:"relative"}]) { const options=fixture(); assert.equal(recordAssemblyDiagnostic({...options,...change},input,NOW),"unavailable"); assert.deepEqual(readdirSync(options.directory),[]); }
});
test("unsafe directory, symlink and unsafe key fail closed without following links", {skip:process.platform === "win32"}, () => {
  const options=fixture(); chmodSync(options.directory,0o755); assert.equal(recordAssemblyDiagnostic(options,input,NOW),"unavailable"); chmodSync(options.directory,0o700);
  const link=join(createTempDir("diagnostic-link-"),"link"); symlinkSync(options.directory,link); assert.equal(recordAssemblyDiagnostic({...options,directory:link},input,NOW),"unavailable");
  const key=join(options.directory,".assembly-diagnostic-key"); symlinkSync(join(options.directory,"absent"),key); assert.equal(recordAssemblyDiagnostic(options,input,NOW),"unavailable"); assert.equal(records(options.directory).length,0);
});
test("capacity stops at twenty records; replay creates independent assembly IDs", {skip:process.platform === "win32"}, () => {
  const options=fixture(); for(let i=0;i<20;i++) assert.equal(recordAssemblyDiagnostic(options,input,NOW),"recorded"); assert.equal(recordAssemblyDiagnostic(options,input,NOW),"unavailable");
  const rows=records(options.directory); assert.equal(rows.length,20); assert.equal(new Set(rows.map(row=>row.id)).size,20); assert.equal(new Set(rows.map(row=>row.sessionFingerprint)).size,1);
});
test("source overflow is explicit and cross-scope candidates cannot create a misleading receipt", {skip:process.platform === "win32"}, () => {
  const options=fixture(); const overflowing={...candidate,sourceRefs:Array.from({length:21},(_,i)=>ref(`e${i}`))}; assert.equal(recordAssemblyDiagnostic(options,{...input,segments:[{...input.segments[0],candidates:[overflowing]}]},NOW),"recorded");
  assert.equal(records(options.directory)[0].segments[0].candidates[0].sourcesTruncated,true); assert.equal(records(options.directory)[0].captureTruncated,true);
  assert.equal(recordAssemblyDiagnostic(options,{...input,scope:"default",segments:[{...input.segments[0],candidates:[{...candidate,contextRef:ref("s","other","summary")}]}]},NOW),"unavailable"); assert.equal(records(options.directory).length,1);
});
test("oversized metadata and concurrent writer locks never produce partial records", () => {
  const options=fixture(); writeFileSync(join(options.directory,".assembly-diagnostic-lock"),"",{mode:0o600}); assert.equal(recordAssemblyDiagnostic(options,input,NOW),"unavailable"); assert.equal(records(options.directory).length,0);
  const other=fixture(); const huge={...candidate,sourceRefs:Array.from({length:20},(_,i)=>ref(`e${i}`+"x".repeat(400)))}; assert.equal(recordAssemblyDiagnostic(other,{...input,segments:[{...input.segments[0],candidates:Array.from({length:20},()=>huge)}]},NOW),"unavailable"); assert.equal(records(other.directory).length,0);
});

const policy={maxInlineChars:16000,maxEventBytes:262144,sensitiveContentPolicy:"redact"};
function engineFixture(extra={}) {
  const directory=createTempDir("diagnostic-engine-"),output=join(directory,"output"); mkdirSync(output,{mode:0o700});
  const config=normalizeConfig({dbPath:join(directory,"fixture.db"),mode:"standalone",conversationJournal:{enabled:true},contextEngine:{enabled:true,maxContextTokens:1600,assemblyDiagnostics:{enabled:true,directory:output,scopes:["default"],expiresAt:Date.now()+600000}},unifiedRetrieval:{enabled:true,tokenBudget:800,minConfidence:.5},...extra});
  const open=()=>{ const store=new GraphologyStore(config.dbPath); return {store,close(){store.close();}}; };
  const graph=open(); try { const journal=new ConversationEventRepository(graph.store.db,policy); const source=journal.append({scope:"default",sessionId:"source",kind:"user_message",role:"user",parts:[{type:"text",text:"PRIVATE_SOURCE describes the preferred coding language"}]}); new SummaryRepository(graph.store.db,policy).create({scope:"default",sessionId:"source",eventIds:[source.id],content:"TypeScript PRIVATE_PARAPHRASE",maxChars:1000}); } finally{graph.close();}
  const params={sessionId:"target",prompt:"TypeScript",messages:[{role:"user",content:"TypeScript PRIVATE_QUERY"}],tokenBudget:1600};
  return {output,config,open,params,engine:new MnemoraContextEngine(config,open)};
}
test("real assemble writes only packed candidates and preserves the returned context byte for byte", {skip:process.platform === "win32"},async()=>{
  const f=engineFixture(),result=await f.engine.assemble(f.params); const [record]=records(f.output); assert.ok(record); assert.equal(record.segments[0].renderedBytes,Buffer.byteLength(result.systemPromptAddition));
  assert.ok(record.segments[0].candidates.some(item=>item.kind==="summary")); assert.equal(JSON.stringify(record).includes("PRIVATE_"),false);
  const disabled=new MnemoraContextEngine({...f.config,contextEngine:{...f.config.contextEngine,assemblyDiagnostics:{enabled:false}}},f.open); assert.deepEqual(await disabled.assemble(f.params),result);
  const failed=new MnemoraContextEngine({...f.config,contextEngine:{...f.config.contextEngine,assemblyDiagnostics:{...f.config.contextEngine.assemblyDiagnostics,directory:"relative"}}},f.open); assert.deepEqual(await failed.assemble(f.params),result);
});
test("stateless and excluded agents never write diagnostic metadata",async()=>{
  const stateless=engineFixture({conversationJournal:{enabled:true,statelessSessionPatterns:["target"]}}); await stateless.engine.assemble(stateless.params); assert.deepEqual(readdirSync(stateless.output),[]);
  const excluded=engineFixture({recall:{excludedAgentIds:["worker"]}}); await excluded.engine.assemble({...excluded.params,messages:[{role:"user",agentId:"worker",content:"TypeScript"}]}); assert.deepEqual(readdirSync(excluded.output),[]);
});
test("host compaction envelopes are explicitly distinguished from plugin projections", {skip:process.platform === "win32"},async()=>{
  const f=engineFixture(); const text='<MNEMORA_COMPACTION summary_id="old" source_linked="true">PRIVATE_COMPACTION</MNEMORA_COMPACTION>';
  const result=await f.engine.assemble({...f.params,prompt:"",messages:[{role:"system",content:text},{role:"user",content:"continue"}]});
  const record=records(f.output)[0],segment=record.segments.find(s=>s.kind==="compaction"); assert.equal(segment.origin,"host_message"); assert.equal(segment.summaryRef,ref("old","default","summary")); assert.equal(JSON.stringify(record).includes("PRIVATE_COMPACTION"),false); assert.ok(result.messages);
});

test("packing omissions never become attached candidate entries", {skip:process.platform === "win32"}, async () => {
  const f=engineFixture();
  const constrained=new MnemoraContextEngine({...f.config,unifiedRetrieval:{...f.config.unifiedRetrieval,tokenBudget:128,maxItems:1}},f.open);
  const result=await constrained.assemble(f.params),record=records(f.output)[0];
  if(result.systemPromptAddition) for(const item of record.segments.find(s=>s.kind==="unified_retrieval").candidates) assert.ok(result.systemPromptAddition.includes(item.contextRef));
  assert.equal(record.segments.filter(s=>s.kind==="unified_retrieval").flatMap(s=>s.candidates).length<=1,true);
  const empty=await constrained.assemble({...f.params,prompt:"completely-unrelated-query"});
  const emptyRecord=records(f.output).find(r=>r.id!==record.id);
  assert.equal(empty.systemPromptAddition,undefined); assert.deepEqual(emptyRecord.segments,[]);
});
test("plugin compaction projection records its final returned envelope", {skip:process.platform === "win32"},async()=>{
  const f=engineFixture({contextEngine:{enabled:true,maxContextTokens:800,maxSummaryChars:300,protectedRecentEvents:2,compaction:{enabled:true,freshTailCount:2}}});
  const graph=f.open(); try {
    const journal=new ConversationEventRepository(graph.store.db,policy); const source=journal.append({scope:"default",sessionId:"target",kind:"user_message",role:"user",parts:[{type:"text",text:"PRIVATE_OLD_EVENT"}]});
    new SummaryRepository(graph.store.db,policy).create({scope:"default",sessionId:"target",eventIds:[source.id],content:"PRIVATE_PROJECTED_SUMMARY",maxChars:300});
  } finally{graph.close();}
  const config={...f.config,contextEngine:{...f.config.contextEngine,assemblyDiagnostics:{enabled:true,directory:f.output,scopes:["default"],expiresAt:Date.now()+600000}}};
  const engine=new MnemoraContextEngine(config,f.open),result=await engine.assemble({sessionId:"target",messages:[{role:"user",content:"old ".repeat(1000)},{role:"assistant",content:"old response"},{role:"user",content:"new message"},{role:"assistant",content:"new response"}],tokenBudget:800});
  const segment=records(f.output)[0].segments.find(s=>s.kind==="compaction"); assert.ok(segment); assert.equal(segment.origin,"plugin_projection"); assert.ok(segment.sourceRefs.length); assert.equal(segment.contentTruncated,false);
  const summary=result.messages.find(m=>typeof m.content==="string"&&m.content.includes("MNEMORA_COMPACTION")); assert.equal(segment.renderedBytes,Buffer.byteLength(summary.content));
});
test("both configuration schemas expose diagnostics without enabling a default capture",async()=>{
  const {default:plugin}=await import("../dist/plugin.js");
  // Public JSON schema and normalization must carry the same explicit opt-in.
  const manifest=JSON.parse(readFileSync("openclaw.plugin.json","utf8"));
  assert.equal(manifest.configSchema.properties.contextEngine.properties.assemblyDiagnostics.properties.enabled.default,false);
  assert.equal(normalizeConfig({}).contextEngine.assemblyDiagnostics,undefined);
  const options=fixture(),value=normalizeConfig({contextEngine:{assemblyDiagnostics:options}}).contextEngine.assemblyDiagnostics;
  assert.equal(value.enabled,true); assert.equal(value.directory,options.directory); assert.deepEqual(value.scopes,["default"]);
  assert.equal(plugin.configSchema.safeParse({contextEngine:{assemblyDiagnostics:options}}).success,true);
  assert.equal(plugin.configSchema.safeParse({contextEngine:{assemblyDiagnostics:{enabled:true,privateText:"forbidden"}}}).success,false);
});

test("Windows refuses enabled diagnostics without a verified private ACL", {skip:process.platform !== "win32"}, () => {
  const options=fixture(); assert.equal(recordAssemblyDiagnostic(options,input,NOW),"unavailable"); assert.deepEqual(readdirSync(options.directory),[]);
});
